//! Tauri command. 화면에서 받은 값을 바꿔 `App`의 use case를 한 번 부르고 결과를 돌려준다.
//! 판단은 여기 두지 않는다.
//!
//! 비밀번호는 화면에서 Rust로만 간다. 돌려주는 type에는 비밀번호 항목이 없고,
//! `Password`는 `Serialize`가 아니라서 실수로 넣어도 compile되지 않는다.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chilla_core::application::{App, AppError};
use chilla_core::domain::{
    Column, ConnectionColor, ConnectionProfile, EndOutcome, EndResult, FileStamp, Password,
    ProfileError, Project, QueryEvent, QueryId, QueryOutcome, RowBatch, ServerError, SessionId,
    SessionInfo, SessionState, SqlFile, StatementSpan, TunnelEvent, TunnelFailure, TunnelState,
    TxEnd, TxMode, TxStatus, WriteMode,
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
            color: dto
                .color
                .map(|name| {
                    ConnectionColor::parse(&name).ok_or(ProfileError::UnknownColor { value: name })
                })
                .transpose()?,
        })
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

/// byte offset의 span을 UTF-16 code unit offset으로 바꾼다. text를 한 번만 훑는다.
///
/// span은 start 오름차순에 서로 겹치지 않는다고 가정한다(`StatementSplitter::split`의 약속).
fn utf16_spans(sql: &str, spans: &[StatementSpan]) -> Vec<StatementSpanDto> {
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
    spans
        .iter()
        .map(|span| StatementSpanDto {
            start: advance_to(span.start),
            end: advance_to(span.end),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnDto {
    pub name: String,
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
        tx: Option<&'static str>,
    },
}

fn micros(elapsed: Duration) -> u64 {
    u64::try_from(elapsed.as_micros()).unwrap_or(u64::MAX)
}

impl From<Column> for ColumnDto {
    fn from(column: Column) -> Self {
        Self { name: column.name }
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
) -> CommandResult<()> {
    let password = password.map(Password::new);
    let profile = ConnectionProfile::try_from(connection).map_err(AppError::from)?;
    Ok(app.test_connection(profile, password).await?)
}

#[tauri::command]
pub async fn open_session(
    app: State<'_, CoreApp>,
    connection: String,
) -> CommandResult<SessionDto> {
    Ok(app.open_session(&connection).await?.into())
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

/// query id를 돌려주고 바로 끝난다. 결과는 `on_event`로 간다.
#[tauri::command]
pub async fn execute_query(
    app: State<'_, CoreApp>,
    session_id: u64,
    sql: String,
    mode: TxModeDto,
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
        .execute(SessionId(session_id), sql, mode.into(), sink)
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use chilla_core::domain::{SslMode, TunnelEvent, TunnelFailure, TunnelState};
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
        }
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
                "color"
            ])
        );
        assert_eq!(json["sslmode"], "verify-full");
        assert_eq!(json["sslrootcert"], "/p/certs/ca.pem");
        assert_eq!(json["tunnelTimeout"], 30);
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
        let columns = event_json(QueryEvent::Columns(vec![Column { name: "id".into() }]));
        assert_eq!(
            columns,
            json!({ "type": "columns", "columns": [{ "name": "id" }] })
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
