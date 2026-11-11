//! Tauri command. 화면에서 받은 값을 바꿔 `App`의 use case를 한 번 부르고 결과를 돌려준다.
//! 판단은 여기 두지 않는다.
//!
//! 비밀번호는 화면에서 Rust로만 간다. 돌려주는 type에는 비밀번호 항목이 없고,
//! `Password`는 `Serialize`가 아니라서 실수로 넣어도 compile되지 않는다.

use std::path::{Path, PathBuf};

use chilla_core::application::{App, AppError};
use chilla_core::domain::{
    ConnectionProfile, Password, ProfileError, Project, SessionId, SessionInfo, SessionState,
    TxStatus,
};
use chilla_core::infrastructure::PgConnector;
use serde::{Deserialize, Serialize};
use tauri::State;

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

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    use chilla_core::domain::{Project, SessionId, SslMode, TxStatus};
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
}
