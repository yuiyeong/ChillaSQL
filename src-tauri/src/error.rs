use chilla_core::application::{AppError, ConnectError, FileError, ProjectError};
use serde::Serialize;

/// 화면으로 가는 오류. `kind`로 화면이 다음 행동을 고르고 `message`를 그대로 보여 준다.
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub kind: &'static str,
    pub message: String,
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
            AppError::InvalidPath(_) | AppError::File(FileError::OutsideProject { .. }) => {
                "invalid_path"
            }
            AppError::File(file) => match file {
                FileError::NotFound { .. } => "file_not_found",
                FileError::Exists { .. } => "file_exists",
                FileError::Changed { .. } => "file_changed",
                FileError::TooLarge { .. } => "file_too_large",
                FileError::NotUtf8 { .. } => "file_not_utf8",
                FileError::Io { .. } => "file_io",
                FileError::OutsideProject { .. } => "invalid_path",
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
        Self {
            kind,
            message: error.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    use chilla_core::application::{
        CancelError, ConnectError, FileError, PasswordStoreError, ProjectError, SplitError,
    };
    use chilla_core::domain::{ProfileError, QueryId, SessionId, SqlPathError};

    use super::*;

    fn kind(error: impl Into<AppError>) -> &'static str {
        CommandError::from(error.into()).kind
    }

    #[test]
    fn command_error_kinds() {
        assert_eq!(kind(AppError::NoProject), "no_project");
        assert_eq!(kind(AppError::ProjectChanged), "project_changed");
        assert_eq!(
            kind(AppError::UnknownConnection { name: "x".into() }),
            "unknown_connection"
        );
        assert_eq!(
            kind(AppError::UnknownSession { id: SessionId(1) }),
            "unknown_session"
        );

        assert_eq!(
            kind(SplitError {
                message: "m".into()
            }),
            "split_failed"
        );
        assert_eq!(kind(AppError::EmptyStatement), "empty_statement");
        assert_eq!(
            kind(AppError::MultipleStatements { count: 2 }),
            "multiple_statements"
        );
        assert_eq!(
            kind(AppError::QueryNotActive { query: QueryId(1) }),
            "query_not_active"
        );
        assert_eq!(
            kind(CancelError {
                message: "m".into()
            }),
            "cancel_failed"
        );

        let path = PathBuf::from("/p/chilla.toml");
        assert_eq!(
            kind(ProjectError::NotFound { path: path.clone() }),
            "project_not_found"
        );
        assert_eq!(
            kind(ProjectError::PasswordInConfig {
                connection: "local".into()
            }),
            "password_in_config"
        );
        assert_eq!(
            kind(ProjectError::AlreadyExists { path: path.clone() }),
            "project_exists"
        );
        let message = String::from("m");
        assert_eq!(
            kind(ProjectError::Write {
                path: path.clone(),
                message: message.clone()
            }),
            "project_write_failed"
        );
        let invalid_projects = [
            ProjectError::Read {
                path,
                message: message.clone(),
            },
            ProjectError::Parse {
                message: message.clone(),
            },
            ProjectError::InvalidConnection {
                connection: "local".into(),
                source: ProfileError::ZeroPort,
            },
        ];
        for error in invalid_projects {
            assert_eq!(kind(error), "project_invalid");
        }

        let file = |name: &str| name.to_string();
        let file_errors = [
            (
                FileError::NotFound {
                    path: file("a.sql"),
                },
                "file_not_found",
            ),
            (
                FileError::Exists {
                    path: file("a.sql"),
                },
                "file_exists",
            ),
            (
                FileError::Changed {
                    path: file("a.sql"),
                },
                "file_changed",
            ),
            (
                FileError::TooLarge {
                    path: file("a.sql"),
                    bytes: 1,
                },
                "file_too_large",
            ),
            (
                FileError::NotUtf8 {
                    path: file("a.sql"),
                },
                "file_not_utf8",
            ),
            (
                FileError::OutsideProject {
                    path: file("a.sql"),
                },
                "invalid_path",
            ),
            (
                FileError::Io {
                    path: file("a.sql"),
                    message: message.clone(),
                },
                "file_io",
            ),
        ];
        for (error, expected) in file_errors {
            assert_eq!(kind(error), expected);
        }
        assert_eq!(kind(SqlPathError::Empty), "invalid_path");

        assert_eq!(kind(ProfileError::ZeroPort), "invalid_connection");
        assert_eq!(
            kind(PasswordStoreError {
                message: message.clone()
            }),
            "password_store"
        );

        let connect_errors = [
            (
                ConnectError::Unreachable {
                    message: message.clone(),
                },
                "unreachable",
            ),
            (ConnectError::Timeout, "timeout"),
            (ConnectError::TlsNotSupported, "tls_not_supported"),
            (
                ConnectError::Certificate {
                    message: message.clone(),
                },
                "certificate",
            ),
            (ConnectError::PasswordRequired, "password_required"),
            (
                ConnectError::AuthFailed {
                    message: message.clone(),
                },
                "auth_failed",
            ),
            (
                ConnectError::Database {
                    code: "3D000".into(),
                    message: message.clone(),
                },
                "database",
            ),
            (ConnectError::Other { message }, "other"),
        ];
        for (error, expected) in connect_errors {
            assert_eq!(kind(error), expected);
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
