//! Tauri command. 화면에서 받은 값을 바꿔 `App`의 use case를 한 번 부르고 결과를 돌려준다.
//! 판단은 여기 두지 않는다.
//!
//! 비밀번호는 화면에서 Rust로만 간다. 돌려주는 type에는 비밀번호 항목이 없고,
//! `Password`는 `Serialize`가 아니라서 실수로 넣어도 compile되지 않는다.

use std::path::{Path, PathBuf};
use std::time::Duration;

use chilla_core::application::{App, AppError};
use chilla_core::domain::{
    Column, ConnectionProfile, Password, ProfileError, Project, QueryEvent, QueryId, QueryOutcome,
    RowBatch, ServerError, SessionId, SessionInfo, SessionState, StatementSpan, TxStatus,
};
use chilla_core::infrastructure::PgConnector;
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

use crate::error::CommandError;

pub type CoreApp = App<PgConnector>;

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
            color: profile.color.clone(),
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
            color: dto.color,
        })
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
                tx: Some(match tx {
                    TxStatus::Idle => "idle",
                    TxStatus::InTransaction => "in_transaction",
                    TxStatus::Failed => "failed",
                }),
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
/// span은 start 오름차순에 서로 겹치지 않는다고 가정한다(scanner가 그렇게 돌려준다).
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
    pub position: Option<u32>,
}

/// `finished` 이벤트에서 `type` 옆에 펼쳐지는 부분. `outcome`이 구분자다.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum OutcomeDto {
    Completed { rows: u64 },
    Failed { error: ServerErrorDto },
    Cancelled,
    Discarded,
    ConnectionLost { message: String },
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

impl From<ServerError> for ServerErrorDto {
    fn from(error: ServerError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            detail: error.detail,
            hint: error.hint,
            position: error.position,
        }
    }
}

impl From<QueryOutcome> for OutcomeDto {
    fn from(outcome: QueryOutcome) -> Self {
        match outcome {
            QueryOutcome::Completed { rows } => Self::Completed { rows },
            QueryOutcome::Failed(error) => Self::Failed {
                error: error.into(),
            },
            QueryOutcome::Cancelled => Self::Cancelled,
            QueryOutcome::Discarded => Self::Discarded,
            QueryOutcome::ConnectionLost { message } => Self::ConnectionLost { message },
        }
    }
}

impl From<QueryEvent> for QueryEventDto {
    fn from(event: QueryEvent) -> Self {
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
            QueryEvent::Finished { outcome, elapsed } => Self::Finished {
                outcome: outcome.into(),
                elapsed_micros: micros(elapsed),
            },
        }
    }
}

#[tauri::command]
pub async fn open_project(app: State<'_, CoreApp>, path: String) -> CommandResult<ProjectDto> {
    let project = app.open_project(Path::new(&path)).await?;
    Ok(ProjectDto::from(&project))
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

#[tauri::command]
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
    on_event: Channel<QueryEventDto>,
) -> CommandResult<u64> {
    // 화면이 사라져 send가 실패해도 무시한다. 그 쿼리는 다음 execute나 close_session에서 정리된다.
    // sink는 session의 task 안에서 돈다. panic하면 session이 죽으므로 오류를 내지 않는다.
    let sink = Box::new(move |event| {
        let _ = on_event.send(QueryEventDto::from(event));
    });
    let query = app.execute(SessionId(session_id), sql, sink).await?;
    Ok(query.0)
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
    use std::path::PathBuf;

    use std::time::Duration;

    use chilla_core::domain::{
        Column, Project, QueryOutcome, RowBatch, ServerError, SessionId, SslMode, TxStatus,
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
            tunnel: Some("railway connect".into()),
            color: Some("red".into()),
        }
    }

    #[test]
    fn connection_dto_has_no_password_key() {
        let json =
            serde_json::to_value(ConnectionDto::from(&profile(SslMode::VerifyFull))).unwrap();
        let keys: BTreeSet<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            BTreeSet::from([
                "name",
                "host",
                "port",
                "database",
                "user",
                "sslmode",
                "sslrootcert",
                "tunnel",
                "color"
            ])
        );
        assert_eq!(json["sslmode"], "verify-full");
        assert_eq!(json["sslrootcert"], "/p/certs/ca.pem");
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

    fn event_json(event: QueryEvent) -> serde_json::Value {
        serde_json::to_value(QueryEventDto::from(event)).unwrap()
    }

    fn keys(json: &serde_json::Value) -> BTreeSet<&str> {
        json.as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect()
    }

    fn finished(outcome: QueryOutcome, micros: u64) -> serde_json::Value {
        event_json(QueryEvent::Finished {
            outcome,
            elapsed: Duration::from_micros(micros),
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
            json!({ "type": "finished", "outcome": "completed", "rows": 3, "elapsedMicros": 120 })
        );
        assert_eq!(
            keys(&completed),
            BTreeSet::from(["type", "outcome", "rows", "elapsedMicros"])
        );

        let failed = finished(
            QueryOutcome::Failed(ServerError {
                code: "42P01".into(),
                message: "m".into(),
                detail: None,
                hint: Some("h".into()),
                position: Some(15),
            }),
            90,
        );
        assert_eq!(
            failed,
            json!({
                "type": "finished", "outcome": "failed", "elapsedMicros": 90,
                "error": {
                    "code": "42P01", "message": "m", "detail": null, "hint": "h", "position": 15
                }
            })
        );
        assert_eq!(
            keys(&failed),
            BTreeSet::from(["type", "outcome", "elapsedMicros", "error"])
        );
        assert_eq!(
            keys(&failed["error"]),
            BTreeSet::from(["code", "message", "detail", "hint", "position"])
        );

        for (outcome, name) in [
            (QueryOutcome::Cancelled, "cancelled"),
            (QueryOutcome::Discarded, "discarded"),
        ] {
            let json = finished(outcome, 5300);
            assert_eq!(
                json,
                json!({ "type": "finished", "outcome": name, "elapsedMicros": 5300 })
            );
            assert_eq!(
                keys(&json),
                BTreeSet::from(["type", "outcome", "elapsedMicros"])
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
                "elapsedMicros": 10
            })
        );
        assert_eq!(
            keys(&lost),
            BTreeSet::from(["type", "outcome", "message", "elapsedMicros"])
        );
    }
}
