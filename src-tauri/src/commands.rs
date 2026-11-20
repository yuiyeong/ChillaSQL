//! Tauri command. 화면에서 받은 값을 바꿔 `App`의 use case를 한 번 부르고 결과를 돌려준다.
//! 판단은 여기 두지 않는다.
//!
//! 비밀번호는 화면에서 Rust로만 간다. 돌려주는 type에는 비밀번호 항목이 없고,
//! `Password`는 `Serialize`가 아니라서 실수로 넣어도 compile되지 않는다.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chilla_core::application::{
    App, AppError, HistoryEntry, NewHistoryEntry, RecentProject, ServerInfo,
};
use chilla_core::domain::{
    ApplyOutcome, ApplyResult, Catalog, CatalogColumn, Column, ConnectionProfile, ConstraintInfo,
    ConstraintKind, Danger, EditTable, EndOutcome, EndResult, FileStamp, FunctionName, IndexInfo,
    ParameterSpan, Password, ProfileError, Project, QueryEvent, QueryId, QueryOutcome, Relation,
    RelationKind, RowBatch, ServerError, SessionId, SessionInfo, SessionState, Settings,
    SettingsError, SqlFile, StatementSpan, TableDetails, TunnelEvent, TunnelFailure, TunnelState,
    TxEnd, TxMode, TxStatus, TypeInfo, WriteMode,
};
use chilla_core::infrastructure::{PgConnector, ShellTunnelRunner};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

use crate::error::CommandError;

pub type CoreApp = App<PgConnector, ShellTunnelRunner>;

type CommandResult<T> = Result<T, CommandError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDto {
    pub name: String,
    pub dir: String,
    pub connections: Vec<ConnectionDto>,
}

impl From<&Project> for ProjectDto {
    fn from(project: &Project) -> Self {
        Self {
            name: project.name.clone(),
            dir: project.dir.display().to_string(),
            connections: project.connections.iter().map(Into::into).collect(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionDto {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub sslmode: String,
    #[serde(default)]
    pub sslrootcert: Option<String>,
    #[serde(default)]
    pub tunnel: Option<String>,
    /// 초 단위.
    #[serde(default)]
    pub tunnel_timeout: Option<u64>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    /// 초 단위.
    #[serde(default)]
    pub statement_timeout: Option<u64>,
}

impl From<&ConnectionProfile> for ConnectionDto {
    fn from(profile: &ConnectionProfile) -> Self {
        Self {
            name: profile.name.clone(),
            host: profile.host.clone(),
            port: profile.port,
            database: profile.database.clone(),
            user: profile.user.clone(),
            sslmode: profile.sslmode.as_str().to_string(),
            sslrootcert: profile
                .sslrootcert
                .as_ref()
                .map(|path| path.display().to_string()),
            tunnel: profile.tunnel.clone(),
            tunnel_timeout: profile.tunnel_timeout.map(|timeout| timeout.as_secs()),
            color: profile.color.map(|color| color.as_str().to_string()),
            read_only: profile.read_only,
            statement_timeout: profile.statement_timeout.map(|timeout| timeout.as_secs()),
        }
    }
}

impl TryFrom<ConnectionDto> for ConnectionProfile {
    type Error = ProfileError;

    fn try_from(dto: ConnectionDto) -> Result<Self, Self::Error> {
        Ok(Self {
            name: dto.name,
            host: dto.host,
            port: dto.port,
            database: dto.database,
            user: dto.user,
            sslmode: dto.sslmode.parse()?,
            sslrootcert: dto.sslrootcert.map(PathBuf::from),
            tunnel: dto.tunnel,
            tunnel_timeout: dto.tunnel_timeout.map(Duration::from_secs),
            color: dto.color.as_deref().map(str::parse).transpose()?,
            read_only: dto.read_only,
            statement_timeout: dto.statement_timeout.map(Duration::from_secs),
        })
    }
}

/// 접속 test가 알아낸 서버의 정보.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfoDto {
    pub version: String,
}

impl From<ServerInfo> for ServerInfoDto {
    fn from(info: ServerInfo) -> Self {
        Self {
            version: info.version,
        }
    }
}

/// 연 파일의 내용. `stamp`는 화면이 뜻을 모르고 저장할 때 그대로 돌려준다.
#[derive(Debug, Serialize)]
pub struct SqlFileDto {
    pub text: String,
    pub stamp: String,
}

impl From<SqlFile> for SqlFileDto {
    fn from(file: SqlFile) -> Self {
        Self {
            text: file.text,
            stamp: file.stamp.0,
        }
    }
}

/// 저장 방식. `mode`가 구분자다.
///
/// `Create {}`와 `Overwrite {}`를 unit variant로 쓰지 않는 이유: serde는 internally tagged enum의
/// unit variant에서 `deny_unknown_fields`를 적용하지 않아 `{"mode":"create","stamp":"s"}`가
/// 통과한다. 빈 struct variant는 막는다.
#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum WriteModeDto {
    Create {},
    Replace { stamp: String },
    Overwrite {},
}

impl From<WriteModeDto> for WriteMode {
    fn from(mode: WriteModeDto) -> Self {
        match mode {
            WriteModeDto::Create {} => Self::Create,
            WriteModeDto::Replace { stamp } => Self::Replace {
                expected: FileStamp(stamp),
            },
            WriteModeDto::Overwrite {} => Self::Overwrite,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDto {
    pub id: u64,
    pub connection: String,
    pub backend_pid: i32,
}

impl From<SessionInfo> for SessionDto {
    fn from(info: SessionInfo) -> Self {
        Self {
            id: info.id.0,
            connection: info.connection,
            backend_pid: info.backend_pid,
        }
    }
}

/// 화면이 보는 트랜잭션 상태의 이름.
fn tx_name(tx: TxStatus) -> &'static str {
    match tx {
        TxStatus::Idle => "idle",
        TxStatus::InTransaction => "in_transaction",
        TxStatus::Failed => "failed",
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStateDto {
    /// `"open"` 또는 `"lost"`.
    pub status: &'static str,
    /// `"idle"`, `"in_transaction"`, `"failed"`. `lost`면 없다.
    pub tx: Option<&'static str>,
}

impl From<SessionState> for SessionStateDto {
    fn from(state: SessionState) -> Self {
        match state {
            SessionState::Open { tx } => Self {
                status: "open",
                tx: Some(tx_name(tx)),
            },
            SessionState::Lost => Self {
                status: "lost",
                tx: None,
            },
        }
    }
}

/// 문장의 위치. `start`와 `end`는 화면 문자열(JS)의 UTF-16 code unit offset이다.
#[derive(Debug, Clone, Serialize)]
pub struct StatementSpanDto {
    pub start: usize,
    pub end: usize,
}

/// byte offset의 `(start, end)`를 UTF-16 code unit offset으로 바꾼다. text를 한 번만 훑는다.
///
/// 범위는 start 오름차순에 서로 겹치지 않는다고 가정한다(`StatementSplitter`의 약속).
fn utf16_ranges(
    sql: &str,
    ranges: impl IntoIterator<Item = (usize, usize)>,
) -> Vec<(usize, usize)> {
    let mut chars = sql.char_indices().peekable();
    let mut units = 0;
    // `byte` 앞의 글자를 모두 지나며 UTF-16 code unit을 센다. offset은 앞으로만 간다.
    let mut advance_to = |byte: usize| {
        while let Some(&(at, ch)) = chars.peek() {
            if at >= byte {
                break;
            }
            units += ch.len_utf16();
            chars.next();
        }
        units
    };
    ranges
        .into_iter()
        .map(|(start, end)| (advance_to(start), advance_to(end)))
        .collect()
}

fn utf16_spans(sql: &str, spans: &[StatementSpan]) -> Vec<StatementSpanDto> {
    utf16_ranges(sql, spans.iter().map(|s| (s.start, s.end)))
        .into_iter()
        .map(|(start, end)| StatementSpanDto { start, end })
        .collect()
}

/// `:name` 파라미터의 위치. `start`는 `:`, `end`는 이름 끝이고 UTF-16 code unit offset이다.
#[derive(Debug, Clone, Serialize)]
pub struct ParameterSpanDto {
    pub name: String,
    pub start: usize,
    pub end: usize,
}

fn utf16_parameters(sql: &str, params: &[ParameterSpan]) -> Vec<ParameterSpanDto> {
    let ranges = utf16_ranges(sql, params.iter().map(|p| (p.start, p.end)));
    params
        .iter()
        .zip(ranges)
        .map(|(param, (start, end))| ParameterSpanDto {
            name: param.name.clone(),
            start,
            end,
        })
        .collect()
}

/// 스키마 트리와 자동완성의 catalog.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDto {
    pub search_path: Vec<String>,
    pub schemas: Vec<String>,
    pub relations: Vec<RelationDto>,
    pub functions: Vec<FunctionNameDto>,
    pub reserved_words: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct RelationDto {
    pub oid: u32,
    pub schema: String,
    pub name: String,
    pub kind: RelationKindDto,
    pub columns: Vec<CatalogColumnDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationKindDto {
    Table,
    PartitionedTable,
    ForeignTable,
    View,
    MaterializedView,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogColumnDto {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub primary_key: bool,
}

#[derive(Debug, Serialize)]
pub struct FunctionNameDto {
    pub schema: String,
    pub name: String,
}

impl From<Catalog> for CatalogDto {
    fn from(catalog: Catalog) -> Self {
        Self {
            search_path: catalog.search_path,
            schemas: catalog.schemas,
            relations: catalog
                .relations
                .into_iter()
                .map(RelationDto::from)
                .collect(),
            functions: catalog
                .functions
                .into_iter()
                .map(|FunctionName { schema, name }| FunctionNameDto { schema, name })
                .collect(),
            reserved_words: catalog.reserved_words,
        }
    }
}

impl From<RelationKind> for RelationKindDto {
    fn from(kind: RelationKind) -> Self {
        match kind {
            RelationKind::Table => Self::Table,
            RelationKind::PartitionedTable => Self::PartitionedTable,
            RelationKind::ForeignTable => Self::ForeignTable,
            RelationKind::View => Self::View,
            RelationKind::MaterializedView => Self::MaterializedView,
        }
    }
}

impl From<Relation> for RelationDto {
    fn from(relation: Relation) -> Self {
        Self {
            oid: relation.oid,
            schema: relation.schema,
            name: relation.name,
            kind: relation.kind.into(),
            columns: relation
                .columns
                .into_iter()
                .map(|column: CatalogColumn| CatalogColumnDto {
                    name: column.name,
                    type_name: column.type_name,
                    primary_key: column.primary_key,
                })
                .collect(),
        }
    }
}

/// 테이블 하나의 인덱스와 제약조건.
#[derive(Debug, Serialize)]
pub struct TableDetailsDto {
    pub indexes: Vec<IndexDto>,
    pub constraints: Vec<ConstraintDto>,
}

#[derive(Debug, Serialize)]
pub struct IndexDto {
    pub name: String,
    pub definition: String,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Debug, Serialize)]
pub struct ConstraintDto {
    pub name: String,
    pub kind: ConstraintKindDto,
    pub definition: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintKindDto {
    PrimaryKey,
    ForeignKey,
    Unique,
    Check,
    Exclusion,
}

impl From<TableDetails> for TableDetailsDto {
    fn from(details: TableDetails) -> Self {
        Self {
            indexes: details
                .indexes
                .into_iter()
                .map(|index: IndexInfo| IndexDto {
                    name: index.name,
                    definition: index.definition,
                    unique: index.unique,
                    primary: index.primary,
                })
                .collect(),
            constraints: details
                .constraints
                .into_iter()
                .map(|constraint: ConstraintInfo| ConstraintDto {
                    name: constraint.name,
                    kind: match constraint.kind {
                        ConstraintKind::PrimaryKey => ConstraintKindDto::PrimaryKey,
                        ConstraintKind::ForeignKey => ConstraintKindDto::ForeignKey,
                        ConstraintKind::Unique => ConstraintKindDto::Unique,
                        ConstraintKind::Check => ConstraintKindDto::Check,
                        ConstraintKind::Exclusion => ConstraintKindDto::Exclusion,
                    },
                    definition: constraint.definition,
                })
                .collect(),
        }
    }
}

/// 실행 전에 확인할 위험. `kind`로 구분한다. `Drop`의 `object`는 SQL keyword("TABLE" 등)다.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DangerDto {
    UpdateWithoutWhere { table: String },
    DeleteWithoutWhere { table: String },
    Drop { object: String, names: Vec<String> },
    Truncate { tables: Vec<String> },
}

impl From<Danger> for DangerDto {
    fn from(danger: Danger) -> Self {
        match danger {
            Danger::UpdateWithoutWhere { table } => Self::UpdateWithoutWhere { table },
            Danger::DeleteWithoutWhere { table } => Self::DeleteWithoutWhere { table },
            Danger::Drop { kind, names } => Self::Drop {
                object: kind,
                names,
            },
            Danger::Truncate { tables } => Self::Truncate { tables },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDto {
    pub name: String,
    pub type_oid: u32,
    pub type_modifier: i32,
    pub table_oid: u32,
    pub column_number: i16,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerErrorDto {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// 오류 위치. 서버에 보낸 text에서의 UTF-16 code unit offset(0부터)이다. 화면 editor의 offset과
    /// 같다. 서버가 위치를 주지 않았거나 text 밖이면 `null`이다.
    pub position: Option<u32>,
}

/// 서버가 준 오류 위치(1부터 세는 글자 번호)를 `sql`의 UTF-16 code unit offset(0부터)으로 바꾼다.
/// 0이거나 text 끝을 넘으면 `None`이다. text 끝(글자 수 + 1)은 "end of input" 오류가 가리키는
/// 곳이라 받는다.
fn utf16_position(sql: &str, position: u32) -> Option<u32> {
    let before = position.checked_sub(1)?;
    let mut chars = sql.chars();
    let mut units = 0u32;
    for _ in 0..before {
        units += u32::try_from(chars.next()?.len_utf16()).ok()?;
    }
    Some(units)
}

/// `finished` 이벤트에서 `type` 옆에 펼쳐지는 부분. `outcome`이 구분자다.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum OutcomeDto {
    Completed { rows: u64 },
    Failed { error: ServerErrorDto },
    Cancelled,
    Discarded,
    Expired,
    ConnectionLost { message: String },
    ClientError { message: String },
}

/// 쿼리 하나의 결과 이벤트. 화면이 `type`으로 구분한다.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum QueryEventDto {
    Columns {
        columns: Vec<ColumnDto>,
    },
    Rows {
        first_row: u64,
        /// cell은 `null`(NULL) 또는 서버가 만든 text다.
        rows: Vec<Vec<Option<String>>>,
        retained_from: u64,
        elapsed_micros: u64,
    },
    Finished {
        #[serde(flatten)]
        outcome: OutcomeDto,
        elapsed_micros: u64,
        /// `"idle"`, `"in_transaction"`, `"failed"`. 연결이 끊겼거나 세션을 닫는 중이면 `null`이다.
        /// 서버에 보내지 않고 끝난 쿼리(기다리다 밀리거나 취소된 쿼리)도 상태를 모르므로 `null`이다.
        tx: Option<&'static str>,
    },
}

fn micros(elapsed: Duration) -> u64 {
    u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX)
}

impl From<Column> for ColumnDto {
    fn from(column: Column) -> Self {
        Self {
            name: column.name,
            type_oid: column.type_oid,
            type_modifier: column.type_modifier,
            table_oid: column.table_oid,
            column_number: column.column_number,
        }
    }
}

impl ServerErrorDto {
    /// `sql`은 그 오류를 낸, 서버에 보낸 text다.
    fn new(error: ServerError, sql: &str) -> Self {
        Self {
            code: error.code,
            message: error.message,
            detail: error.detail,
            hint: error.hint,
            position: error
                .position
                .and_then(|position| utf16_position(sql, position)),
        }
    }
}

impl OutcomeDto {
    fn new(outcome: QueryOutcome, sql: &str) -> Self {
        match outcome {
            QueryOutcome::Completed { rows } => Self::Completed { rows },
            QueryOutcome::Failed(error) => Self::Failed {
                error: ServerErrorDto::new(error, sql),
            },
            QueryOutcome::Cancelled => Self::Cancelled,
            QueryOutcome::Discarded => Self::Discarded,
            QueryOutcome::Expired => Self::Expired,
            QueryOutcome::ConnectionLost { message } => Self::ConnectionLost { message },
            QueryOutcome::ClientError { message } => Self::ClientError { message },
        }
    }
}

impl QueryEventDto {
    /// `sql`은 그 쿼리로 서버에 보낸 text다.
    fn new(event: QueryEvent, sql: &str) -> Self {
        match event {
            QueryEvent::Columns(columns) => Self::Columns {
                columns: columns.into_iter().map(Into::into).collect(),
            },
            QueryEvent::Rows(RowBatch {
                first_row,
                rows,
                retained_from,
                elapsed,
            }) => Self::Rows {
                first_row,
                rows,
                retained_from,
                elapsed_micros: micros(elapsed),
            },
            QueryEvent::Finished {
                outcome,
                elapsed,
                tx,
            } => Self::Finished {
                outcome: OutcomeDto::new(outcome, sql),
                elapsed_micros: micros(elapsed),
                tx: tx.map(tx_name),
            },
        }
    }
}

/// 실행의 트랜잭션 모드. 화면은 `"auto"` 또는 `"manual"`을 보낸다.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxModeDto {
    Auto,
    Manual,
}

impl From<TxModeDto> for TxMode {
    fn from(mode: TxModeDto) -> Self {
        match mode {
            TxModeDto::Auto => Self::Auto,
            TxModeDto::Manual => Self::Manual,
        }
    }
}

/// 트랜잭션을 끝내는 방법. 화면은 `"commit"` 또는 `"rollback"`을 보낸다.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxEndDto {
    Commit,
    Rollback,
}

impl From<TxEndDto> for TxEnd {
    fn from(end: TxEndDto) -> Self {
        match end {
            TxEndDto::Commit => Self::Commit,
            TxEndDto::Rollback => Self::Rollback,
        }
    }
}

/// `end_transaction`의 결과에서 `tx` 옆에 펼쳐지는 부분. `outcome`이 구분자다.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum EndOutcomeDto {
    Ended,
    TransactionFailed,
    ServerError { error: ServerErrorDto },
    ConnectionLost { message: String },
    ClientError { message: String },
}

#[derive(Debug, Clone, Serialize)]
pub struct EndResultDto {
    #[serde(flatten)]
    pub outcome: EndOutcomeDto,
    /// 끝낸 뒤의 `"idle"`, `"in_transaction"`, `"failed"`. 연결이 끊겼으면 `null`이다.
    pub tx: Option<&'static str>,
}

impl From<EndResult> for EndResultDto {
    fn from(result: EndResult) -> Self {
        let outcome = match result.outcome {
            EndOutcome::Ended => EndOutcomeDto::Ended,
            EndOutcome::TransactionFailed => EndOutcomeDto::TransactionFailed,
            // COMMIT, ROLLBACK의 오류에는 화면 editor의 위치가 없다.
            EndOutcome::Server(error) => EndOutcomeDto::ServerError {
                error: ServerErrorDto {
                    position: None,
                    ..ServerErrorDto::new(error, "")
                },
            },
            EndOutcome::ConnectionLost { message } => EndOutcomeDto::ConnectionLost { message },
            EndOutcome::Client { message } => EndOutcomeDto::ClientError { message },
        };
        Self {
            outcome,
            tx: result.tx.map(tx_name),
        }
    }
}

/// `apply_edits`의 결과에서 `tx` 옆에 펼쳐지는 부분. `outcome`이 구분자다.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ApplyOutcomeDto {
    Applied {
        rows: Vec<Vec<Option<String>>>,
    },
    WrongRowCount {
        index: usize,
        rows: u64,
    },
    /// `index`가 null이면 문장이 아니라 앞뒤의 `BEGIN`, `SAVEPOINT`, `COMMIT`이 실패했다.
    Failed {
        index: Option<usize>,
        error: ServerErrorDto,
    },
    TransactionFailed,
    Busy,
    ConnectionLost {
        message: String,
    },
    ClientError {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ApplyResultDto {
    #[serde(flatten)]
    pub outcome: ApplyOutcomeDto,
    /// 끝난 뒤의 `"idle"`, `"in_transaction"`, `"failed"`. 연결이 끊겼거나 보내지 않았으면 `null`이다.
    pub tx: Option<&'static str>,
}

impl From<ApplyResult> for ApplyResultDto {
    fn from(result: ApplyResult) -> Self {
        let outcome = match result.outcome {
            ApplyOutcome::Applied { rows } => ApplyOutcomeDto::Applied { rows },
            ApplyOutcome::WrongRowCount { index, rows } => {
                ApplyOutcomeDto::WrongRowCount { index, rows }
            }
            // 보낸 SQL은 화면이 만든 것이고 editor에 없으므로 오류 위치를 싣지 않는다.
            ApplyOutcome::Failed { index, error } => ApplyOutcomeDto::Failed {
                index,
                error: ServerErrorDto {
                    position: None,
                    ..ServerErrorDto::new(error, "")
                },
            },
            ApplyOutcome::TransactionFailed => ApplyOutcomeDto::TransactionFailed,
            ApplyOutcome::Busy => ApplyOutcomeDto::Busy,
            ApplyOutcome::ConnectionLost { message } => ApplyOutcomeDto::ConnectionLost { message },
            ApplyOutcome::Client { message } => ApplyOutcomeDto::ClientError { message },
        };
        Self {
            outcome,
            tx: result.tx.map(tx_name),
        }
    }
}

/// 터널이 실패한 이유. `reason`이 구분자다.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum TunnelFailureDto {
    Spawn { message: String },
    Exited { code: Option<i32>, output: String },
    Timeout { secs: u64, output: String },
    Cancelled,
}

/// 터널 상태. `status`가 구분자다.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum TunnelStateDto {
    Starting {
        attempt: u8,
        timeout_secs: u64,
    },
    Ready,
    External,
    Failed {
        #[serde(flatten)]
        failure: TunnelFailureDto,
    },
    Stopped,
}

/// 화면으로 가는 event `tunnel`.
#[derive(Debug, Clone, Serialize)]
pub struct TunnelEventDto {
    pub connection: String,
    pub state: TunnelStateDto,
}

impl From<TunnelFailure> for TunnelFailureDto {
    fn from(failure: TunnelFailure) -> Self {
        match failure {
            TunnelFailure::Spawn { message } => Self::Spawn { message },
            TunnelFailure::Exited { code, output } => Self::Exited { code, output },
            TunnelFailure::Timeout { secs, output } => Self::Timeout { secs, output },
            TunnelFailure::Cancelled => Self::Cancelled,
        }
    }
}

impl From<TunnelState> for TunnelStateDto {
    fn from(state: TunnelState) -> Self {
        match state {
            TunnelState::Starting { attempt, timeout } => Self::Starting {
                attempt,
                timeout_secs: timeout.as_secs(),
            },
            TunnelState::Ready => Self::Ready,
            TunnelState::External => Self::External,
            TunnelState::Failed(failure) => Self::Failed {
                failure: failure.into(),
            },
            TunnelState::Stopped => Self::Stopped,
        }
    }
}

impl From<TunnelEvent> for TunnelEventDto {
    fn from(event: TunnelEvent) -> Self {
        Self {
            connection: event.connection,
            state: event.state.into(),
        }
    }
}

#[tauri::command]
pub async fn open_project(app: State<'_, CoreApp>, path: String) -> CommandResult<ProjectDto> {
    let project = app.open_project(Path::new(&path)).await?;
    Ok(ProjectDto::from(&project))
}

#[tauri::command]
pub async fn create_project(app: State<'_, CoreApp>, path: String) -> CommandResult<ProjectDto> {
    let project = app.create_project(Path::new(&path)).await?;
    Ok(ProjectDto::from(&project))
}

#[tauri::command]
pub async fn save_connection(
    app: State<'_, CoreApp>,
    connection: ConnectionDto,
    password: Option<String>,
) -> CommandResult<ProjectDto> {
    let password = password.map(Password::new);
    let profile = ConnectionProfile::try_from(connection).map_err(AppError::from)?;
    let project = app.save_connection(profile, password).await?;
    Ok(ProjectDto::from(&project))
}

#[tauri::command]
pub async fn list_sql_files(app: State<'_, CoreApp>) -> CommandResult<Vec<String>> {
    let files = app.list_sql_files().await?;
    Ok(files
        .into_iter()
        .map(|path| path.as_str().to_string())
        .collect())
}

#[tauri::command]
pub async fn read_sql_file(app: State<'_, CoreApp>, path: String) -> CommandResult<SqlFileDto> {
    Ok(app.read_sql_file(&path).await?.into())
}

/// 쓴 뒤의 stamp를 돌려준다.
#[tauri::command]
pub async fn write_sql_file(
    app: State<'_, CoreApp>,
    path: String,
    text: String,
    mode: WriteModeDto,
) -> CommandResult<String> {
    Ok(app.write_sql_file(&path, text, mode.into()).await?.0)
}

#[tauri::command]
pub async fn set_password(
    app: State<'_, CoreApp>,
    connection: String,
    password: String,
) -> CommandResult<()> {
    let password = Password::new(password);
    Ok(app.set_password(&connection, password).await?)
}

#[tauri::command]
pub async fn has_password(app: State<'_, CoreApp>, connection: String) -> CommandResult<bool> {
    Ok(app.has_password(&connection).await?)
}

#[tauri::command]
pub async fn delete_password(app: State<'_, CoreApp>, connection: String) -> CommandResult<()> {
    Ok(app.delete_password(&connection).await?)
}

#[tauri::command]
pub async fn test_connection(
    app: State<'_, CoreApp>,
    connection: ConnectionDto,
    password: Option<String>,
) -> CommandResult<ServerInfoDto> {
    let password = password.map(Password::new);
    let profile = ConnectionProfile::try_from(connection).map_err(AppError::from)?;
    Ok(app.test_connection(profile, password).await?.into())
}

#[tauri::command]
pub async fn open_session(
    app: State<'_, CoreApp>,
    connection: String,
) -> CommandResult<SessionDto> {
    Ok(app.open_session(&connection).await?.into())
}

#[tauri::command]
pub async fn load_catalog(
    app: State<'_, CoreApp>,
    connection: String,
) -> CommandResult<CatalogDto> {
    Ok(app.load_catalog(&connection).await?.into())
}

#[tauri::command]
pub async fn load_table_details(
    app: State<'_, CoreApp>,
    connection: String,
    relation: u32,
) -> CommandResult<TableDetailsDto> {
    Ok(app.load_table_details(&connection, relation).await?.into())
}

/// 그 접속의 catalog connection으로 테이블이나 view 하나의 생성문을 읽어 조립한 text.
#[tauri::command]
pub async fn load_ddl(
    app: State<'_, CoreApp>,
    connection: String,
    relation: u32,
) -> CommandResult<String> {
    Ok(app.load_ddl(&connection, relation).await?)
}

/// 결과 컬럼의 type. RowDescription이 알려 준 OID와 typmod다.
#[derive(Debug, Deserialize)]
pub struct TypeKeyDto {
    pub oid: u32,
    pub modifier: i32,
}

#[derive(Debug, Serialize)]
pub struct TypeInfoDto {
    pub oid: u32,
    pub modifier: i32,
    pub name: String,
    /// `pg_type.typcategory`, 한 글자다.
    pub category: char,
}

impl From<TypeInfo> for TypeInfoDto {
    fn from(info: TypeInfo) -> Self {
        Self {
            oid: info.oid,
            modifier: info.modifier,
            name: info.name,
            category: info.category,
        }
    }
}

/// 그 접속의 catalog connection이 결과 컬럼의 type 이름과 category를 답한다. 모르는 OID는 없다.
#[tauri::command]
pub async fn describe_types(
    app: State<'_, CoreApp>,
    connection: String,
    types: Vec<TypeKeyDto>,
) -> CommandResult<Vec<TypeInfoDto>> {
    let types = types.into_iter().map(|t| (t.oid, t.modifier)).collect();
    let infos = app.describe_types(&connection, types).await?;
    Ok(infos.into_iter().map(Into::into).collect())
}

/// 셀 편집 대상이 될 수 있는 relation 하나.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTableDto {
    pub oid: u32,
    pub qualified_name: String,
    pub name: String,
    pub kind: RelationKindDto,
    pub columns: Vec<EditColumnDto>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditColumnDto {
    pub number: i16,
    pub name: String,
    pub quoted_name: String,
    pub primary_key: bool,
    pub updatable: bool,
}

impl From<EditTable> for EditTableDto {
    fn from(table: EditTable) -> Self {
        Self {
            oid: table.oid,
            qualified_name: table.qualified_name,
            name: table.name,
            kind: table.kind.into(),
            columns: table
                .columns
                .into_iter()
                .map(|column| EditColumnDto {
                    number: column.number,
                    name: column.name,
                    quoted_name: column.quoted_name,
                    primary_key: column.primary_key,
                    updatable: column.updatable,
                })
                .collect(),
        }
    }
}

/// 그 접속의 catalog connection이 결과 열의 table OID마다 이름, PK, 고칠 수 있는 컬럼을 답한다.
/// 없는 OID와 table이 아닌 relation은 답에 없다.
#[tauri::command]
pub async fn describe_tables(
    app: State<'_, CoreApp>,
    connection: String,
    oids: Vec<u32>,
) -> CommandResult<Vec<EditTableDto>> {
    let tables = app.describe_tables(&connection, oids).await?;
    Ok(tables.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn close_catalog(app: State<'_, CoreApp>, connection: String) -> CommandResult<()> {
    Ok(app.close_catalog(&connection).await?)
}

#[tauri::command]
pub async fn session_state(
    app: State<'_, CoreApp>,
    session_id: u64,
) -> CommandResult<SessionStateDto> {
    Ok(app.session_state(SessionId(session_id)).await?.into())
}

#[tauri::command]
pub async fn close_session(app: State<'_, CoreApp>, session_id: u64) -> CommandResult<()> {
    Ok(app.close_session(SessionId(session_id)).await?)
}

/// `pg_query::scan`은 text 길이만큼 걸리므로 main thread를 막지 않게 async runtime에서 돈다.
#[tauri::command(async)]
pub fn split_statements(
    app: State<'_, CoreApp>,
    sql: String,
) -> CommandResult<Vec<StatementSpanDto>> {
    let spans = app.split_statements(&sql)?;
    Ok(utf16_spans(&sql, &spans))
}

/// 문장 안의 `:name` 파라미터 위치. `pg_query::scan`을 쓰므로 async runtime에서 돈다.
#[tauri::command(async)]
pub fn find_parameters(
    app: State<'_, CoreApp>,
    sql: String,
) -> CommandResult<Vec<ParameterSpanDto>> {
    let params = app.find_parameters(&sql)?;
    Ok(utf16_parameters(&sql, &params))
}

/// 문장 하나의 첫 위험을 돌려준다. `pg_query::parse`는 text 길이만큼 걸리므로 async runtime에서 돈다.
#[tauri::command(async)]
pub fn inspect_statement(app: State<'_, CoreApp>, sql: String) -> Option<DangerDto> {
    app.inspect_statement(&sql).map(DangerDto::from)
}

/// query id를 돌려주고 바로 끝난다. 결과는 `on_event`로 간다. `drain`이면 첫 batch만 보내고 나머지 행은
/// 끝까지 읽어서 버린다(여러 문장 중 마지막이 아닌 문장).
#[tauri::command]
pub async fn execute_query(
    app: State<'_, CoreApp>,
    session_id: u64,
    sql: String,
    mode: TxModeDto,
    drain: bool,
    on_event: Channel<QueryEventDto>,
) -> CommandResult<u64> {
    // 화면이 사라져 send가 실패해도 무시한다. 그 쿼리는 다음 execute나 close_session에서 정리된다.
    // sink는 session의 task 안에서 돈다. panic하면 session이 죽으므로 오류를 내지 않는다.
    // 오류 위치를 화면의 offset으로 바꾸려고 보낸 text를 sink가 갖는다.
    let sent = sql.clone();
    let sink = Box::new(move |event| {
        let _ = on_event.send(QueryEventDto::new(event, &sent));
    });
    let query = app
        .execute(SessionId(session_id), sql, mode.into(), drain, sink)
        .await?;
    Ok(query.0)
}

/// 트랜잭션을 Commit하거나 Rollback한다. 실행 중인 쿼리가 있으면 버린 뒤에 끝낸다.
#[tauri::command]
pub async fn end_transaction(
    app: State<'_, CoreApp>,
    session_id: u64,
    end: TxEndDto,
) -> CommandResult<EndResultDto> {
    Ok(app
        .end_transaction(SessionId(session_id), end.into())
        .await?
        .into())
}

/// 셀 편집의 UPDATE를 한 단위로 보낸다. 문장마다 바뀐 행이 정확히 하나여야 하고 아니면 모두 되돌린다.
/// 그 세션에 열린 쿼리가 있거나 트랜잭션이 실패했으면 보내지 않는다.
#[tauri::command]
pub async fn apply_edits(
    app: State<'_, CoreApp>,
    session_id: u64,
    statements: Vec<String>,
    mode: TxModeDto,
) -> CommandResult<ApplyResultDto> {
    Ok(app
        .apply_edits(SessionId(session_id), statements, mode.into())
        .await?
        .into())
}

#[tauri::command]
pub async fn fetch_more(
    app: State<'_, CoreApp>,
    session_id: u64,
    query_id: u64,
) -> CommandResult<()> {
    Ok(app
        .fetch_more(SessionId(session_id), QueryId(query_id))
        .await?)
}

/// 그 접속의 터널이 시작 중이면 멈춘다.
#[tauri::command]
pub async fn cancel_tunnel(app: State<'_, CoreApp>, connection: String) -> CommandResult<()> {
    Ok(app.cancel_tunnel(&connection).await?)
}

/// 다시 실행하다 멈춘 그 접속의 터널을 처음부터 다시 시작한다.
#[tauri::command]
pub async fn restart_tunnel(app: State<'_, CoreApp>, connection: String) -> CommandResult<()> {
    Ok(app.restart_tunnel(&connection).await?)
}

#[tauri::command]
pub async fn cancel_query(
    app: State<'_, CoreApp>,
    session_id: u64,
    query_id: u64,
) -> CommandResult<()> {
    Ok(app
        .cancel_query(SessionId(session_id), QueryId(query_id))
        .await?)
}

/// 시작할 때 읽은 전역 설정과, 읽지 못했으면 그 이유. setup이 한 번 만들어 state로 둔다.
pub struct LoadedSettings {
    pub settings: Settings,
    pub error: Option<SettingsError>,
    /// 앱 내부 저장소(`chilla.sqlite3`)를 열지 못한 이유. 열었으면 `None`이다.
    pub store_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDto {
    pub language: &'static str,
    pub editor: EditorSettingsDto,
    pub idle_timeout_secs: u64,
    pub error: Option<String>,
    pub store_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSettingsDto {
    pub font: String,
    pub font_size: u16,
}

impl From<&LoadedSettings> for SettingsDto {
    fn from(loaded: &LoadedSettings) -> Self {
        let settings = &loaded.settings;
        Self {
            language: settings.language.as_str(),
            editor: EditorSettingsDto {
                font: settings.editor.font.clone(),
                font_size: settings.editor.font_size,
            },
            idle_timeout_secs: settings.limits.idle_result_timeout.as_secs(),
            error: loaded.error.as_ref().map(ToString::to_string),
            store_error: loaded.store_error.clone(),
        }
    }
}

/// 시작할 때 읽은 전역 설정. 파일을 고쳐도 앱을 다시 시작해야 바뀐다.
#[tauri::command]
pub fn load_settings(settings: State<'_, LoadedSettings>) -> SettingsDto {
    SettingsDto::from(&*settings)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProjectDto {
    pub dir: String,
    pub name: String,
    /// Unix 초
    pub opened_at: i64,
}

impl From<RecentProject> for RecentProjectDto {
    fn from(project: RecentProject) -> Self {
        Self {
            dir: project.dir.display().to_string(),
            name: project.name,
            opened_at: project.opened_at,
        }
    }
}

/// 최근에 연 프로젝트. 최근 것부터 최대 10개다.
#[tauri::command]
pub async fn recent_projects(app: State<'_, CoreApp>) -> CommandResult<Vec<RecentProjectDto>> {
    let projects = app.recent_projects().await?;
    Ok(projects.into_iter().map(Into::into).collect())
}

/// `dir` 프로젝트의 탭 snapshot(화면이 만든 JSON text). 저장한 적이 없으면 `None`이다.
/// `dir`은 열린 프로젝트의 `dir`이어야 한다. 아니면 `project_changed`다.
#[tauri::command]
pub async fn load_workspace(app: State<'_, CoreApp>, dir: String) -> CommandResult<Option<String>> {
    Ok(app.load_workspace(Path::new(&dir)).await?)
}

/// `dir`이 열린 프로젝트가 아니면 저장하지 않고 `project_changed`를 돌려준다.
#[tauri::command]
pub async fn save_workspace(
    app: State<'_, CoreApp>,
    dir: String,
    snapshot: String,
) -> CommandResult<()> {
    Ok(app.save_workspace(Path::new(&dir), snapshot).await?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewHistoryEntryDto {
    pub connection: String,
    pub sql: String,
    /// Unix ms. 실행을 시작한 때
    pub executed_at: i64,
    pub elapsed_micros: i64,
}

impl From<NewHistoryEntryDto> for NewHistoryEntry {
    fn from(entry: NewHistoryEntryDto) -> Self {
        Self {
            connection: entry.connection,
            sql: entry.sql,
            executed_at: entry.executed_at,
            elapsed_micros: entry.elapsed_micros,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntryDto {
    pub id: i64,
    pub connection: String,
    pub sql: String,
    /// Unix ms. 실행을 시작한 때
    pub executed_at: i64,
    pub elapsed_micros: i64,
}

impl From<HistoryEntry> for HistoryEntryDto {
    fn from(entry: HistoryEntry) -> Self {
        Self {
            id: entry.id,
            connection: entry.connection,
            sql: entry.sql,
            executed_at: entry.executed_at,
            elapsed_micros: entry.elapsed_micros,
        }
    }
}

/// `dir` 프로젝트의 쿼리 기록에 더한다. `dir`이 열린 프로젝트가 아니면 `project_changed`다.
#[tauri::command]
pub async fn record_query(
    app: State<'_, CoreApp>,
    dir: String,
    entry: NewHistoryEntryDto,
) -> CommandResult<()> {
    Ok(app.record_query(Path::new(&dir), entry.into()).await?)
}

/// 검색어를 공백으로 나눈 단어가 모두 SQL에 든 기록을 최근 것부터 200개. 검색어가 비면 최근
/// 기록이다. `dir`이 열린 프로젝트가 아니면 `project_changed`다.
#[tauri::command]
pub async fn search_history(
    app: State<'_, CoreApp>,
    dir: String,
    query: String,
) -> CommandResult<Vec<HistoryEntryDto>> {
    let entries = app.search_history(Path::new(&dir), &query).await?;
    Ok(entries.into_iter().map(Into::into).collect())
}

/// 화면이 확인을 마친 뒤 앱을 끝낸다. `RunEvent::Exit`의 `shutdown`이 세션을 닫고,
/// 열린 트랜잭션은 서버가 되돌린다. `app.exit(0)`의 `ExitRequested`는 code가 있으므로 막지 않는다.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use chilla_core::domain::{
        ConnectionColor, EditColumn, Language, SslMode, TunnelEvent, TunnelFailure, TunnelState,
    };
    use serde_json::json;

    use super::*;

    fn profile(sslmode: SslMode) -> ConnectionProfile {
        ConnectionProfile {
            name: "production".into(),
            host: "203.0.113.10".into(),
            port: 5432,
            database: "app".into(),
            user: "app_user".into(),
            sslmode,
            sslrootcert: Some(PathBuf::from("/p/certs/ca.pem")),
            tunnel: Some("ssh -N -L 25432:db.internal:5432 bastion".into()),
            tunnel_timeout: Some(Duration::from_secs(30)),
            color: Some(ConnectionColor::Red),
            read_only: true,
            statement_timeout: Some(Duration::from_secs(45)),
        }
    }

    #[test]
    fn history_dtos_use_camel_case() {
        let new: NewHistoryEntryDto = serde_json::from_value(json!({
            "connection": "local", "sql": "select 1",
            "executedAt": 1700000000000_i64, "elapsedMicros": 42,
        }))
        .unwrap();
        let new = NewHistoryEntry::from(new);
        assert_eq!((new.executed_at, new.elapsed_micros), (1700000000000, 42));

        let entry = HistoryEntryDto::from(HistoryEntry {
            id: 7,
            connection: "local".into(),
            sql: "select 1".into(),
            executed_at: 1700000000000,
            elapsed_micros: 42,
        });
        assert_eq!(
            serde_json::to_value(entry).unwrap(),
            json!({
                "id": 7, "connection": "local", "sql": "select 1",
                "executedAt": 1700000000000_i64, "elapsedMicros": 42,
            })
        );
    }

    #[test]
    fn catalog_dto_uses_camel_case_and_snake_case_kinds() {
        let catalog = Catalog {
            search_path: vec!["public".into()],
            schemas: vec!["public".into()],
            relations: vec![Relation {
                oid: 16385,
                schema: "public".into(),
                name: "users".into(),
                kind: RelationKind::MaterializedView,
                columns: vec![CatalogColumn {
                    name: "id".into(),
                    type_name: "bigint".into(),
                    primary_key: true,
                }],
            }],
            functions: vec![FunctionName {
                schema: "pg_catalog".into(),
                name: "now".into(),
            }],
            reserved_words: vec!["select".into()],
        };
        assert_eq!(
            serde_json::to_value(CatalogDto::from(catalog)).unwrap(),
            serde_json::json!({
                "searchPath": ["public"],
                "schemas": ["public"],
                "relations": [{
                    "oid": 16385,
                    "schema": "public",
                    "name": "users",
                    "kind": "materialized_view",
                    "columns": [{ "name": "id", "type": "bigint", "primaryKey": true }],
                }],
                "functions": [{ "schema": "pg_catalog", "name": "now" }],
                "reservedWords": ["select"],
            })
        );
    }

    #[test]
    fn settings_dto_uses_the_documented_shape() {
        let loaded = LoadedSettings {
            settings: Settings {
                language: Language::Ko,
                ..Settings::default()
            },
            error: Some(SettingsError {
                path: "/h/config.toml".into(),
                message: "unknown field `fontsize`".into(),
            }),
            store_error: Some("file is not a database".into()),
        };
        assert_eq!(
            serde_json::to_value(SettingsDto::from(&loaded)).unwrap(),
            serde_json::json!({
                "language": "ko",
                "editor": { "font": "D2Coding", "fontSize": 15 },
                "idleTimeoutSecs": 600,
                "error": "/h/config.toml: unknown field `fontsize`",
                "storeError": "file is not a database",
            })
        );
    }

    #[test]
    fn edit_table_dto_uses_the_documented_shape() {
        let table = EditTable {
            oid: 16385,
            qualified_name: "public.\"Order Items\"".into(),
            name: "Order Items".into(),
            kind: RelationKind::PartitionedTable,
            columns: vec![EditColumn {
                number: 4,
                name: "Note".into(),
                quoted_name: "\"Note\"".into(),
                primary_key: false,
                updatable: true,
            }],
        };
        assert_eq!(
            serde_json::to_value(EditTableDto::from(table)).unwrap(),
            serde_json::json!({
                "oid": 16385,
                "qualifiedName": "public.\"Order Items\"",
                "name": "Order Items",
                "kind": "partitioned_table",
                "columns": [{
                    "number": 4,
                    "name": "Note",
                    "quotedName": "\"Note\"",
                    "primaryKey": false,
                    "updatable": true,
                }],
            })
        );
    }

    #[test]
    fn type_dtos_use_the_documented_shape() {
        let key: TypeKeyDto = serde_json::from_value(serde_json::json!({
            "oid": 1043,
            "modifier": 259,
        }))
        .unwrap();
        assert_eq!((key.oid, key.modifier), (1043, 259));

        let info = TypeInfo {
            oid: 1043,
            modifier: 259,
            name: "character varying(255)".into(),
            category: 'S',
        };
        assert_eq!(
            serde_json::to_value(TypeInfoDto::from(info)).unwrap(),
            serde_json::json!({
                "oid": 1043,
                "modifier": 259,
                "name": "character varying(255)",
                "category": "S",
            })
        );
    }

    #[test]
    fn table_details_dto_kinds() {
        let details = TableDetails {
            indexes: vec![IndexInfo {
                name: "users_pkey".into(),
                definition: "CREATE UNIQUE INDEX …".into(),
                unique: true,
                primary: true,
            }],
            constraints: [
                ConstraintKind::PrimaryKey,
                ConstraintKind::ForeignKey,
                ConstraintKind::Unique,
                ConstraintKind::Check,
                ConstraintKind::Exclusion,
            ]
            .into_iter()
            .map(|kind| ConstraintInfo {
                name: "c".into(),
                kind,
                definition: "d".into(),
            })
            .collect(),
        };
        let json = serde_json::to_value(TableDetailsDto::from(details)).unwrap();
        assert_eq!(
            json["indexes"][0],
            serde_json::json!({
                "name": "users_pkey",
                "definition": "CREATE UNIQUE INDEX …",
                "unique": true,
                "primary": true,
            })
        );
        let kinds: Vec<&str> = json["constraints"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["kind"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            ["primary_key", "foreign_key", "unique", "check", "exclusion"]
        );
        assert_eq!(json["constraints"][0]["definition"], "d");
    }

    #[test]
    fn danger_dto_shapes() {
        let dto = |danger| serde_json::to_value(DangerDto::from(danger)).unwrap();
        assert_eq!(
            dto(Danger::UpdateWithoutWhere {
                table: "public.users".into()
            }),
            json!({ "kind": "update_without_where", "table": "public.users" })
        );
        assert_eq!(
            dto(Danger::DeleteWithoutWhere {
                table: "sessions".into()
            }),
            json!({ "kind": "delete_without_where", "table": "sessions" })
        );
        assert_eq!(
            dto(Danger::Drop {
                kind: "MATERIALIZED VIEW".into(),
                names: vec!["a".into(), "b".into()]
            }),
            json!({ "kind": "drop", "object": "MATERIALIZED VIEW", "names": ["a", "b"] })
        );
        assert_eq!(
            dto(Danger::Truncate {
                tables: vec!["a".into()]
            }),
            json!({ "kind": "truncate", "tables": ["a"] })
        );
    }

    #[test]
    fn tunnel_event_dto_shapes() {
        let dto = |state| {
            serde_json::to_value(TunnelEventDto::from(TunnelEvent {
                connection: "staging".into(),
                state,
            }))
            .unwrap()
        };
        assert_eq!(
            dto(TunnelState::Starting {
                attempt: 2,
                timeout: Duration::from_secs(20)
            }),
            json!({ "connection": "staging", "state": { "status": "starting", "attempt": 2, "timeoutSecs": 20 } })
        );
        assert_eq!(
            dto(TunnelState::Ready)["state"],
            json!({ "status": "ready" })
        );
        assert_eq!(
            dto(TunnelState::External)["state"],
            json!({ "status": "external" })
        );
        assert_eq!(
            dto(TunnelState::Stopped)["state"],
            json!({ "status": "stopped" })
        );
        let failed = |failure| dto(TunnelState::Failed(failure))["state"].clone();
        assert_eq!(
            failed(TunnelFailure::Spawn {
                message: "m".into()
            }),
            json!({ "status": "failed", "reason": "spawn", "message": "m" })
        );
        assert_eq!(
            failed(TunnelFailure::Exited {
                code: Some(1),
                output: "e".into()
            }),
            json!({ "status": "failed", "reason": "exited", "code": 1, "output": "e" })
        );
        assert_eq!(
            failed(TunnelFailure::Exited {
                code: None,
                output: "e".into()
            }),
            json!({ "status": "failed", "reason": "exited", "code": null, "output": "e" })
        );
        assert_eq!(
            failed(TunnelFailure::Timeout {
                secs: 20,
                output: "e".into()
            }),
            json!({ "status": "failed", "reason": "timeout", "secs": 20, "output": "e" })
        );
        assert_eq!(
            failed(TunnelFailure::Cancelled),
            json!({ "status": "failed", "reason": "cancelled" })
        );
    }

    #[test]
    fn connection_dto_has_no_password_key() {
        let json =
            serde_json::to_value(ConnectionDto::from(&profile(SslMode::VerifyFull))).unwrap();
        assert_eq!(
            keys(&json),
            BTreeSet::from([
                "name",
                "host",
                "port",
                "database",
                "user",
                "sslmode",
                "sslrootcert",
                "tunnel",
                "tunnelTimeout",
                "color",
                "readOnly",
                "statementTimeout"
            ])
        );
        assert_eq!(json["sslmode"], "verify-full");
        assert_eq!(json["sslrootcert"], "/p/certs/ca.pem");
        assert_eq!(json["tunnelTimeout"], 30);
        assert_eq!(json["readOnly"], true);
        assert_eq!(json["statementTimeout"], 45);
    }

    #[test]
    fn server_info_dto_uses_camel_case() {
        let dto = ServerInfoDto::from(ServerInfo {
            version: "18.6".into(),
        });
        assert_eq!(
            serde_json::to_value(dto).unwrap(),
            json!({"version": "18.6"})
        );
    }

    #[test]
    fn connection_dto_rejects_a_password_from_the_screen() {
        let mut json =
            serde_json::to_value(ConnectionDto::from(&profile(SslMode::Disable))).unwrap();
        assert!(serde_json::from_value::<ConnectionDto>(json.clone()).is_ok());
        json["password"] = json!("x");
        assert!(serde_json::from_value::<ConnectionDto>(json).is_err());
    }

    #[test]
    fn connection_dto_round_trips() {
        for sslmode in [SslMode::Disable, SslMode::Require, SslMode::VerifyFull] {
            let original = profile(sslmode);
            let back = ConnectionProfile::try_from(ConnectionDto::from(&original)).unwrap();
            assert_eq!(back, original);
        }
    }

    #[test]
    fn connection_dto_rejects_an_unknown_color() {
        let mut dto = ConnectionDto::from(&profile(SslMode::Disable));
        dto.color = Some("orange".into());
        assert_eq!(
            ConnectionProfile::try_from(dto).unwrap_err(),
            ProfileError::UnknownColor {
                value: "orange".into()
            }
        );
    }

    #[test]
    fn connection_dto_with_an_unknown_sslmode_is_invalid_connection() {
        let mut dto = ConnectionDto::from(&profile(SslMode::Disable));
        dto.sslmode = "prefer".into();
        let error = ConnectionProfile::try_from(dto).unwrap_err();
        let error = CommandError::from(AppError::from(error));
        assert_eq!(error.kind, "invalid_connection");
        assert!(error.message.contains("prefer"), "{}", error.message);
    }

    #[test]
    fn optional_connection_fields_may_be_omitted_by_the_screen() {
        let dto: ConnectionDto = serde_json::from_value(json!({
            "name": "local", "host": "localhost", "port": 5432,
            "database": "app", "user": "postgres", "sslmode": "disable"
        }))
        .unwrap();
        let profile = ConnectionProfile::try_from(dto).unwrap();
        assert_eq!(profile.sslrootcert, None);
        assert_eq!(profile.tunnel, None);
        assert_eq!(profile.tunnel_timeout, None);
        assert_eq!(profile.color, None);
        assert!(!profile.read_only);
        assert_eq!(profile.statement_timeout, None);
    }

    #[test]
    fn project_dto_shape() {
        let project = Project {
            dir: "/p".into(),
            name: "my-service".into(),
            connections: vec![profile(SslMode::Require)],
        };
        let json = serde_json::to_value(ProjectDto::from(&project)).unwrap();
        assert_eq!(json["name"], "my-service");
        assert_eq!(json["dir"], "/p");
        assert_eq!(json["connections"][0]["name"], "production");
    }

    fn write_mode(json: serde_json::Value) -> Result<WriteMode, serde_json::Error> {
        serde_json::from_value::<WriteModeDto>(json).map(WriteMode::from)
    }

    #[test]
    fn write_mode_dto_shapes() {
        assert_eq!(
            write_mode(json!({ "mode": "create" })).unwrap(),
            WriteMode::Create
        );
        assert_eq!(
            write_mode(json!({ "mode": "replace", "stamp": "s" })).unwrap(),
            WriteMode::Replace {
                expected: FileStamp("s".into())
            }
        );
        assert_eq!(
            write_mode(json!({ "mode": "overwrite" })).unwrap(),
            WriteMode::Overwrite
        );

        for invalid in [
            json!({ "mode": "replace" }),
            json!({ "mode": "append" }),
            json!({ "mode": "create", "stamp": "s" }),
            json!({}),
        ] {
            assert!(write_mode(invalid.clone()).is_err(), "{invalid}");
        }
    }

    #[test]
    fn sql_file_dto_shape() {
        let file = SqlFile {
            text: "SELECT 1".into(),
            stamp: FileStamp("9-8".into()),
        };
        let json = serde_json::to_value(SqlFileDto::from(file)).unwrap();
        assert_eq!(json, json!({ "text": "SELECT 1", "stamp": "9-8" }));
        assert_eq!(keys(&json), BTreeSet::from(["text", "stamp"]));
    }

    #[test]
    fn session_dto_shape() {
        let info = SessionInfo {
            id: SessionId(3),
            connection: "local".into(),
            backend_pid: 77,
        };
        assert_eq!(
            serde_json::to_value(SessionDto::from(info)).unwrap(),
            json!({ "id": 3, "connection": "local", "backendPid": 77 })
        );
    }

    #[test]
    fn session_state_dto_shapes() {
        let shape = |state| serde_json::to_value(SessionStateDto::from(state)).unwrap();
        assert_eq!(
            shape(SessionState::Open { tx: TxStatus::Idle }),
            json!({ "status": "open", "tx": "idle" })
        );
        assert_eq!(
            shape(SessionState::Open {
                tx: TxStatus::InTransaction
            }),
            json!({ "status": "open", "tx": "in_transaction" })
        );
        assert_eq!(
            shape(SessionState::Open {
                tx: TxStatus::Failed
            }),
            json!({ "status": "open", "tx": "failed" })
        );
        assert_eq!(
            shape(SessionState::Lost),
            json!({ "status": "lost", "tx": null })
        );
    }

    #[test]
    fn statement_spans_are_utf16_offsets() {
        let sql = "SELECT '한글'; SELECT '😀'; SELECT 2";
        let spans = [
            StatementSpan { start: 0, end: 15 },
            StatementSpan { start: 17, end: 30 },
            StatementSpan { start: 32, end: 40 },
        ];
        let offsets: Vec<(usize, usize)> = utf16_spans(sql, &spans)
            .iter()
            .map(|span| (span.start, span.end))
            .collect();
        assert_eq!(offsets, [(0, 11), (13, 24), (26, 34)]);
        assert!(utf16_spans(sql, &[]).is_empty());
    }

    #[test]
    fn parameter_spans_are_utf16() {
        let sql = "SELECT '한글', :id";
        let spans = [ParameterSpan {
            name: "id".into(),
            start: sql.find(':').unwrap(),
            end: sql.len(),
        }];
        let params = utf16_parameters(sql, &spans);
        assert_eq!(params.len(), 1);
        assert_eq!(
            (params[0].name.as_str(), params[0].start, params[0].end),
            ("id", 13, 16)
        );
    }

    /// 이벤트를 낸 쿼리의 text. 오류 위치 16(1부터 센 글자 번호)은 offset 15다.
    const SENT: &str = "SELECT * FROM t WHERE nope";

    fn error_position(sql: &str, position: Option<u32>) -> Option<u32> {
        let error = ServerError {
            code: "42P01".into(),
            message: "m".into(),
            detail: None,
            hint: None,
            position,
        };
        ServerErrorDto::new(error, sql).position
    }

    /// 서버는 1부터 세는 글자 번호를 주고, 화면 editor는 0부터 세는 UTF-16 offset을 쓴다.
    #[test]
    fn error_position_is_a_utf16_offset_into_the_sent_text() {
        assert_eq!(error_position("SELECT *\nFROM nope", Some(15)), Some(14));
        // 😀 하나가 UTF-16 code unit 2개다.
        assert_eq!(error_position("SELECT '😀' FROM nope", Some(17)), Some(17));
        // "syntax error at end of input"은 text 끝을 가리킨다.
        assert_eq!(error_position("SELECT 1 +", Some(11)), Some(10));
        assert_eq!(error_position("SELECT 1 +", Some(12)), None);
        assert_eq!(error_position("SELECT 1 +", Some(0)), None);
        assert_eq!(error_position("SELECT 1 +", None), None);
    }

    fn event_json(event: QueryEvent) -> serde_json::Value {
        serde_json::to_value(QueryEventDto::new(event, SENT)).unwrap()
    }

    fn keys(json: &serde_json::Value) -> BTreeSet<&str> {
        json.as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect()
    }

    fn finished(outcome: QueryOutcome, micros: u64) -> serde_json::Value {
        finished_with(outcome, micros, Some(TxStatus::Idle))
    }

    fn finished_with(
        outcome: QueryOutcome,
        micros: u64,
        tx: Option<TxStatus>,
    ) -> serde_json::Value {
        event_json(QueryEvent::Finished {
            outcome,
            elapsed: Duration::from_micros(micros),
            tx,
        })
    }

    #[test]
    fn query_event_dto_shapes() {
        let columns = event_json(QueryEvent::Columns(vec![Column {
            name: "id".into(),
            type_oid: 1043,
            type_modifier: 14,
            table_oid: 16385,
            column_number: 2,
        }]));
        assert_eq!(
            columns,
            json!({
                "type": "columns",
                "columns": [{
                    "name": "id",
                    "typeOid": 1043,
                    "typeModifier": 14,
                    "tableOid": 16385,
                    "columnNumber": 2,
                }],
            })
        );
        assert_eq!(keys(&columns), BTreeSet::from(["type", "columns"]));

        let rows = event_json(QueryEvent::Rows(RowBatch {
            first_row: 500,
            rows: vec![vec![Some("1".into()), None, Some(String::new())]],
            retained_from: 2,
            elapsed: Duration::from_micros(4246),
        }));
        assert_eq!(
            rows,
            json!({
                "type": "rows", "firstRow": 500, "rows": [["1", null, ""]],
                "retainedFrom": 2, "elapsedMicros": 4246
            })
        );
        assert_eq!(
            keys(&rows),
            BTreeSet::from(["type", "firstRow", "rows", "retainedFrom", "elapsedMicros"])
        );

        let completed = finished(QueryOutcome::Completed { rows: 3 }, 120);
        assert_eq!(
            completed,
            json!({ "type": "finished", "outcome": "completed", "rows": 3, "elapsedMicros": 120, "tx": "idle" })
        );
        assert_eq!(
            keys(&completed),
            BTreeSet::from(["type", "outcome", "rows", "elapsedMicros", "tx"])
        );

        let failed = finished(
            QueryOutcome::Failed(ServerError {
                code: "42P01".into(),
                message: "m".into(),
                detail: None,
                hint: Some("h".into()),
                position: Some(16),
            }),
            90,
        );
        assert_eq!(
            failed,
            json!({
                "type": "finished", "outcome": "failed", "elapsedMicros": 90, "tx": "idle",
                "error": {
                    "code": "42P01", "message": "m", "detail": null, "hint": "h", "position": 15
                }
            })
        );
        assert_eq!(
            keys(&failed),
            BTreeSet::from(["type", "outcome", "elapsedMicros", "tx", "error"])
        );
        assert_eq!(
            keys(&failed["error"]),
            BTreeSet::from(["code", "message", "detail", "hint", "position"])
        );

        for (outcome, name) in [
            (QueryOutcome::Cancelled, "cancelled"),
            (QueryOutcome::Discarded, "discarded"),
            (QueryOutcome::Expired, "expired"),
        ] {
            let json = finished(outcome, 5300);
            assert_eq!(
                json,
                json!({ "type": "finished", "outcome": name, "elapsedMicros": 5300, "tx": "idle"
                })
            );
            assert_eq!(
                keys(&json),
                BTreeSet::from(["type", "outcome", "elapsedMicros", "tx"])
            );
        }

        let lost = finished(
            QueryOutcome::ConnectionLost {
                message: "x".into(),
            },
            10,
        );
        assert_eq!(
            lost,
            json!({
                "type": "finished", "outcome": "connection_lost", "message": "x",
                "elapsedMicros": 10, "tx": "idle"
            })
        );
        assert_eq!(
            keys(&lost),
            BTreeSet::from(["type", "outcome", "message", "elapsedMicros", "tx"])
        );

        let client = finished(
            QueryOutcome::ClientError {
                message: "y".into(),
            },
            11,
        );
        assert_eq!(
            client,
            json!({
                "type": "finished", "outcome": "client_error", "message": "y",
                "elapsedMicros": 11, "tx": "idle"
            })
        );
        assert_eq!(
            keys(&client),
            BTreeSet::from(["type", "outcome", "message", "elapsedMicros", "tx"])
        );
    }

    #[test]
    fn finished_tx_is_the_status_name_or_null() {
        let completed = QueryOutcome::Completed { rows: 0 };
        for (tx, name) in [
            (TxStatus::Idle, "idle"),
            (TxStatus::InTransaction, "in_transaction"),
            (TxStatus::Failed, "failed"),
        ] {
            let json = finished_with(completed.clone(), 1, Some(tx));
            assert_eq!(json["tx"], json!(name));
        }
        // 연결이 끊겼거나 세션을 닫는 중이면 상태를 모른다. key는 남기고 null이다.
        let unknown = finished_with(completed, 1, None);
        assert_eq!(unknown["tx"], serde_json::Value::Null);
        assert!(keys(&unknown).contains("tx"));
    }

    #[test]
    fn mode_and_end_take_the_screen_names() {
        let mode = |value| serde_json::from_value::<TxModeDto>(json!(value)).map(TxMode::from);
        assert_eq!(mode("auto").unwrap(), TxMode::Auto);
        assert_eq!(mode("manual").unwrap(), TxMode::Manual);
        assert!(mode("Manual").is_err());

        let end = |value| serde_json::from_value::<TxEndDto>(json!(value)).map(TxEnd::from);
        assert_eq!(end("commit").unwrap(), TxEnd::Commit);
        assert_eq!(end("rollback").unwrap(), TxEnd::Rollback);
        assert!(end("abort").is_err());
    }

    #[test]
    fn apply_result_dto_shapes() {
        let shape = |outcome, tx| {
            serde_json::to_value(ApplyResultDto::from(ApplyResult { outcome, tx })).unwrap()
        };
        assert_eq!(
            shape(
                ApplyOutcome::Applied {
                    rows: vec![vec![Some("1".into()), None]]
                },
                Some(TxStatus::Idle)
            ),
            json!({ "outcome": "applied", "rows": [["1", null]], "tx": "idle" })
        );
        assert_eq!(
            shape(
                ApplyOutcome::WrongRowCount { index: 1, rows: 0 },
                Some(TxStatus::Idle)
            ),
            json!({ "outcome": "wrong_row_count", "index": 1, "rows": 0, "tx": "idle" })
        );
        let error = ServerError {
            code: "23503".into(),
            message: "m".into(),
            detail: None,
            hint: None,
            position: Some(3),
        };
        let failed = |index| ApplyOutcome::Failed {
            index,
            error: error.clone(),
        };
        // 보낸 SQL은 화면의 editor에 없으므로 오류 위치는 늘 null이다.
        let error_json = json!({
            "code": "23503", "message": "m", "detail": null, "hint": null, "position": null
        });
        assert_eq!(
            shape(failed(Some(0)), Some(TxStatus::InTransaction)),
            json!({
                "outcome": "failed", "index": 0, "error": error_json, "tx": "in_transaction"
            })
        );
        assert_eq!(
            shape(failed(None), Some(TxStatus::Idle)),
            json!({ "outcome": "failed", "index": null, "error": error_json, "tx": "idle" })
        );
        assert_eq!(
            shape(ApplyOutcome::TransactionFailed, Some(TxStatus::Failed)),
            json!({ "outcome": "transaction_failed", "tx": "failed" })
        );
        assert_eq!(
            shape(ApplyOutcome::Busy, None),
            json!({ "outcome": "busy", "tx": null })
        );
        assert_eq!(
            shape(
                ApplyOutcome::ConnectionLost {
                    message: "x".into()
                },
                None
            ),
            json!({ "outcome": "connection_lost", "message": "x", "tx": null })
        );
        assert_eq!(
            shape(
                ApplyOutcome::Client {
                    message: "y".into()
                },
                Some(TxStatus::Idle)
            ),
            json!({ "outcome": "client_error", "message": "y", "tx": "idle" })
        );
    }

    #[test]
    fn end_result_dto_shapes() {
        let shape = |outcome, tx| {
            serde_json::to_value(EndResultDto::from(EndResult { outcome, tx })).unwrap()
        };
        assert_eq!(
            shape(EndOutcome::Ended, Some(TxStatus::Idle)),
            json!({ "outcome": "ended", "tx": "idle" })
        );
        assert_eq!(
            shape(EndOutcome::TransactionFailed, Some(TxStatus::Failed)),
            json!({ "outcome": "transaction_failed", "tx": "failed" })
        );
        let error = ServerError {
            code: "23503".into(),
            message: "m".into(),
            detail: Some("d".into()),
            hint: None,
            position: None,
        };
        assert_eq!(
            shape(EndOutcome::Server(error), Some(TxStatus::Idle)),
            json!({
                "outcome": "server_error",
                "error": {
                    "code": "23503", "message": "m", "detail": "d", "hint": null,
                    "position": null
                },
                "tx": "idle"
            })
        );
        assert_eq!(
            shape(
                EndOutcome::ConnectionLost {
                    message: "x".into()
                },
                None
            ),
            json!({ "outcome": "connection_lost", "message": "x", "tx": null })
        );
        assert_eq!(
            shape(
                EndOutcome::Client {
                    message: "y".into()
                },
                Some(TxStatus::InTransaction)
            ),
            json!({ "outcome": "client_error", "message": "y", "tx": "in_transaction" })
        );
    }
}
