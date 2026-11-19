use chilla_core::application::{AppError, ConnectError, FileError, ProjectError};
use chilla_core::domain::TunnelFailure;
use serde::Serialize;

/// 화면으로 가는 오류. `kind`로 화면이 다음 행동을 고르고 `message`를 그대로 보여 준다.
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub kind: &'static str,
    pub message: String,
    /// 터널 명령의 stderr. 명령이 실행된 터널 오류에만 있다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

impl From<AppError> for CommandError {
    fn from(error: AppError) -> Self {
        let kind = match &error {
            AppError::NoProject => "no_project",
            AppError::ProjectChanged => "project_changed",
            AppError::UnknownConnection { .. } => "unknown_connection",
            AppError::UnknownSession { .. } => "unknown_session",
            AppError::Project(ProjectError::NotFound { .. }) => "project_not_found",
            AppError::Project(ProjectError::PasswordInConfig { .. }) => "password_in_config",
            AppError::Project(ProjectError::AlreadyExists { .. }) => "project_exists",
            AppError::Project(ProjectError::Write { .. }) => "project_write_failed",
            AppError::Project(_) => "project_invalid",
            AppError::InvalidProfile(_) => "invalid_connection",
            AppError::PasswordStore(_) => "password_store",
            AppError::Split(_) => "split_failed",
            AppError::EmptyStatement => "empty_statement",
            AppError::MultipleStatements { .. } => "multiple_statements",
            AppError::QueryNotActive { .. } => "query_not_active",
            AppError::Cancel(_) => "cancel_failed",
            AppError::InvalidPath(_) => "invalid_path",
            AppError::Catalog(_) => "catalog_failed",
            AppError::File(file) => match file {
                FileError::NotFound { .. } => "file_not_found",
                FileError::Exists { .. } => "file_exists",
                FileError::Changed { .. } => "file_changed",
                FileError::TooLarge { .. } => "file_too_large",
                FileError::NotUtf8 { .. } => "file_not_utf8",
                FileError::Io { .. } => "file_io",
                FileError::OutsideProject { .. } => "invalid_path",
            },
            AppError::Tunnel(tunnel) => match tunnel.failure {
                TunnelFailure::Spawn { .. } => "tunnel_spawn",
                TunnelFailure::Exited { .. } => "tunnel_exited",
                TunnelFailure::Timeout { .. } => "tunnel_timeout",
                TunnelFailure::Cancelled => "tunnel_cancelled",
            },
            AppError::Connect(connect) => match connect {
                ConnectError::Unreachable { .. } => "unreachable",
                ConnectError::Timeout => "timeout",
                ConnectError::TlsNotSupported => "tls_not_supported",
                ConnectError::Certificate { .. } => "certificate",
                ConnectError::PasswordRequired => "password_required",
                ConnectError::AuthFailed { .. } => "auth_failed",
                ConnectError::Database { .. } => "database",
                ConnectError::Other { .. } => "other",
            },
        };
        let output = match &error {
            AppError::Tunnel(tunnel) => tunnel.failure.output().map(str::to_string),
            _ => None,
        };
        Self {
            kind,
            message: error.to_string(),
            output,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    use chilla_core::application::{
        CancelError, ConnectError, FileError, PasswordStoreError, ProjectError, SplitError,
        TunnelError,
    };
    use chilla_core::domain::{ProfileError, QueryId, SessionId, SqlPathError, TunnelFailure};

    use super::*;

    fn kind(error: impl Into<AppError>) -> &'static str {
        CommandError::from(error.into()).kind
    }

    /// 모든 `AppError` variant와 안쪽 error의 모든 variant를 기대하는 `kind`와 함께 만든다.
    /// 안에 든 server message나 io message는 test 값이다.
    fn all_errors() -> Vec<(AppError, &'static str)> {
        let path = PathBuf::from("/p/chilla.toml");
        let message = String::from("m");
        let mut errors: Vec<(AppError, &'static str)> = vec![
            (AppError::NoProject, "no_project"),
            (AppError::ProjectChanged, "project_changed"),
            (
                AppError::UnknownConnection { name: "x".into() },
                "unknown_connection",
            ),
            (
                AppError::UnknownSession { id: SessionId(1) },
                "unknown_session",
            ),
            (
                SplitError {
                    message: message.clone(),
                }
                .into(),
                "split_failed",
            ),
            (AppError::EmptyStatement, "empty_statement"),
            (
                AppError::MultipleStatements { count: 2 },
                "multiple_statements",
            ),
            (
                AppError::QueryNotActive { query: QueryId(1) },
                "query_not_active",
            ),
            (
                CancelError {
                    message: message.clone(),
                }
                .into(),
                "cancel_failed",
            ),
            (
                ProjectError::NotFound { path: path.clone() }.into(),
                "project_not_found",
            ),
            (
                ProjectError::PasswordInConfig {
                    connection: "local".into(),
                }
                .into(),
                "password_in_config",
            ),
            (
                ProjectError::AlreadyExists { path: path.clone() }.into(),
                "project_exists",
            ),
            (
                ProjectError::Write {
                    path: path.clone(),
                    message: message.clone(),
                }
                .into(),
                "project_write_failed",
            ),
            (
                ProjectError::Read {
                    path,
                    message: message.clone(),
                }
                .into(),
                "project_invalid",
            ),
            (
                ProjectError::Parse {
                    message: message.clone(),
                }
                .into(),
                "project_invalid",
            ),
            (
                ProjectError::InvalidConnection {
                    connection: "local".into(),
                    source: ProfileError::ZeroPort,
                }
                .into(),
                "project_invalid",
            ),
            (
                FileError::NotFound {
                    path: "a.sql".into(),
                }
                .into(),
                "file_not_found",
            ),
            (
                FileError::Exists {
                    path: "a.sql".into(),
                }
                .into(),
                "file_exists",
            ),
            (
                FileError::Changed {
                    path: "a.sql".into(),
                }
                .into(),
                "file_changed",
            ),
            (
                FileError::TooLarge {
                    path: "a.sql".into(),
                    bytes: 1,
                }
                .into(),
                "file_too_large",
            ),
            (
                FileError::NotUtf8 {
                    path: "a.sql".into(),
                }
                .into(),
                "file_not_utf8",
            ),
            (
                FileError::OutsideProject {
                    path: "a.sql".into(),
                }
                .into(),
                "invalid_path",
            ),
            (
                FileError::Io {
                    path: "a.sql".into(),
                    message: message.clone(),
                }
                .into(),
                "file_io",
            ),
            (SqlPathError::Empty.into(), "invalid_path"),
            (ProfileError::ZeroPort.into(), "invalid_connection"),
            (
                PasswordStoreError {
                    message: message.clone(),
                }
                .into(),
                "password_store",
            ),
            (
                ConnectError::Unreachable {
                    message: message.clone(),
                }
                .into(),
                "unreachable",
            ),
            (ConnectError::Timeout.into(), "timeout"),
            (ConnectError::TlsNotSupported.into(), "tls_not_supported"),
            (
                ConnectError::Certificate {
                    message: message.clone(),
                }
                .into(),
                "certificate",
            ),
            (ConnectError::PasswordRequired.into(), "password_required"),
            (
                ConnectError::AuthFailed {
                    message: message.clone(),
                }
                .into(),
                "auth_failed",
            ),
            (
                ConnectError::Database {
                    code: "3D000".into(),
                    message: message.clone(),
                }
                .into(),
                "database",
            ),
            (ConnectError::Other { message }.into(), "other"),
        ];
        // 위에서 하나씩만 든 ProfileError와 SqlPathError의 나머지 variant.
        errors.extend(
            [
                ProfileError::EmptyField { field: "host" },
                ProfileError::RootCertWithoutVerifyFull,
                ProfileError::UnknownSslMode { value: "x".into() },
                ProfileError::UnknownColor { value: "x".into() },
                ProfileError::TunnelTimeoutWithoutTunnel,
                ProfileError::TunnelTimeoutRange { secs: 0 },
            ]
            .map(|e| (AppError::from(e), "invalid_connection")),
        );
        let tunnel = |failure| {
            AppError::from(TunnelError {
                host: "localhost".into(),
                port: 25432,
                failure,
            })
        };
        errors.extend([
            (
                tunnel(TunnelFailure::Spawn {
                    message: "m".into(),
                }),
                "tunnel_spawn",
            ),
            (
                tunnel(TunnelFailure::Exited {
                    code: Some(1),
                    output: "e".into(),
                }),
                "tunnel_exited",
            ),
            (
                tunnel(TunnelFailure::Timeout {
                    secs: 20,
                    output: "e".into(),
                }),
                "tunnel_timeout",
            ),
            (tunnel(TunnelFailure::Cancelled), "tunnel_cancelled"),
        ]);
        errors.extend(
            [
                SqlPathError::Absolute,
                SqlPathError::Component {
                    component: "..".into(),
                },
                SqlPathError::NotSql,
            ]
            .map(|e| (AppError::from(e), "invalid_path")),
        );
        errors
    }

    #[test]
    fn tunnel_errors_carry_the_output() {
        let timeout = CommandError::from(AppError::from(TunnelError {
            host: "localhost".into(),
            port: 25432,
            failure: TunnelFailure::Timeout {
                secs: 20,
                output: "Unauthorized".into(),
            },
        }));
        assert_eq!(timeout.output.as_deref(), Some("Unauthorized"));
        assert_eq!(
            timeout.message,
            "localhost:25432 didn't open within 20 seconds"
        );

        let cancelled = CommandError::from(AppError::from(TunnelError {
            host: "localhost".into(),
            port: 25432,
            failure: TunnelFailure::Cancelled,
        }));
        let json = serde_json::to_value(&cancelled).unwrap();
        assert!(json.get("output").is_none(), "{json}");
        assert_eq!(json["kind"], "tunnel_cancelled");
    }

    #[test]
    fn command_error_kinds() {
        for (error, expected) in all_errors() {
            let shown = format!("{error:?}");
            assert_eq!(kind(error), expected, "{shown}");
        }
    }

    #[test]
    fn command_error_messages_are_english() {
        for (error, _) in all_errors() {
            let shown = format!("{error:?}");
            let message = CommandError::from(error).message;
            assert!(
                !message
                    .chars()
                    .any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c)),
                "{shown}: {message}"
            );
        }
    }

    #[test]
    fn command_error_serializes_kind_and_message() {
        let error = CommandError::from(AppError::NoProject);
        let json = serde_json::to_value(&error).unwrap();
        let keys: BTreeSet<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, BTreeSet::from(["kind", "message"]));
        assert_eq!(json["kind"], "no_project");
        assert_eq!(json["message"], AppError::NoProject.to_string());
    }
}
