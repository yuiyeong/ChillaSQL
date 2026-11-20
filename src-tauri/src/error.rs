use std::collections::BTreeMap;
use std::path::Path;

use chilla_core::application::{
    AppError, CancelError, ConnectError, FileError, PasswordStoreError, ProjectError, SplitError,
    StoreError,
};
use chilla_core::domain::TunnelFailure;
use serde::Serialize;

/// 화면으로 가는 오류. `kind`로 화면이 다음 행동을 고르고 `params`로 문구를 번역한다.
/// 번역이 없으면 `message`를 그대로 보여 준다.
#[derive(Debug, Serialize)]
pub struct CommandError {
    pub kind: &'static str,
    pub message: String,
    /// `message`의 변하는 부분. 이름은 영어 message의 빈칸 이름이고, kind별 이름은
    /// `src/shared/i18n/errorKinds.json`에 있다. 비면 보내지 않는다.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<&'static str, String>,
    /// 터널 명령의 stderr. 명령이 실행된 터널 오류에만 있다.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

type Params = BTreeMap<&'static str, String>;

fn params<const N: usize>(pairs: [(&'static str, String); N]) -> Params {
    BTreeMap::from(pairs)
}

fn message_param(message: &str) -> Params {
    params([("message", message.to_string())])
}

fn path_param(path: &Path) -> (&'static str, String) {
    ("path", path.display().to_string())
}

impl From<AppError> for CommandError {
    fn from(error: AppError) -> Self {
        let message = error.to_string();
        // 한 kind가 message가 다른 variant를 묶으면 화면이 고를 수 없으므로 message 전체를 넘긴다.
        let whole = || message_param(&message);
        let (kind, params): (&'static str, Params) = match &error {
            AppError::NoProject => ("no_project", Params::new()),
            AppError::ProjectChanged => ("project_changed", Params::new()),
            AppError::UnknownConnection { name } => {
                ("unknown_connection", params([("name", name.clone())]))
            }
            AppError::UnknownSession { id } => {
                ("unknown_session", params([("id", id.0.to_string())]))
            }
            AppError::Project(ProjectError::NotFound { path }) => {
                ("project_not_found", params([path_param(path)]))
            }
            AppError::Project(ProjectError::PasswordInConfig { connection }) => (
                "password_in_config",
                params([("connection", connection.clone())]),
            ),
            AppError::Project(ProjectError::AlreadyExists { path }) => {
                ("project_exists", params([path_param(path)]))
            }
            AppError::Project(ProjectError::Write { path, message }) => (
                "project_write_failed",
                params([path_param(path), ("message", message.clone())]),
            ),
            AppError::Project(_) => ("project_invalid", whole()),
            AppError::InvalidProfile(_) => ("invalid_connection", whole()),
            AppError::PasswordStore(PasswordStoreError { message }) => {
                ("password_store", message_param(message))
            }
            AppError::Split(SplitError { message }) => ("split_failed", message_param(message)),
            AppError::EmptyStatement => ("empty_statement", Params::new()),
            AppError::MultipleStatements { count } => (
                "multiple_statements",
                params([("count", count.to_string())]),
            ),
            AppError::QueryNotActive { query } => {
                ("query_not_active", params([("query", query.0.to_string())]))
            }
            AppError::Cancel(CancelError { message }) => ("cancel_failed", message_param(message)),
            AppError::InvalidPath(_) => ("invalid_path", whole()),
            AppError::Catalog(query) => ("catalog_failed", message_param(&query.to_string())),
            AppError::Store(StoreError { message }) => ("store_failed", message_param(message)),
            AppError::StoreUnavailable => ("store_unavailable", Params::new()),
            AppError::RelationGone => ("relation_gone", Params::new()),
            AppError::File(file) => match file {
                FileError::NotFound { path } => {
                    ("file_not_found", params([("path", path.clone())]))
                }
                FileError::Exists { path } => ("file_exists", params([("path", path.clone())])),
                FileError::Changed { path } => ("file_changed", params([("path", path.clone())])),
                FileError::TooLarge { path, bytes } => (
                    "file_too_large",
                    params([("path", path.clone()), ("bytes", bytes.to_string())]),
                ),
                FileError::NotUtf8 { path } => ("file_not_utf8", params([("path", path.clone())])),
                FileError::Io { path, message } => (
                    "file_io",
                    params([("path", path.clone()), ("message", message.clone())]),
                ),
                FileError::OutsideProject { .. } => ("invalid_path", whole()),
            },
            AppError::Tunnel(tunnel) => match &tunnel.failure {
                TunnelFailure::Spawn { message } => ("tunnel_spawn", message_param(message)),
                TunnelFailure::Exited { .. } => ("tunnel_exited", whole()),
                TunnelFailure::Timeout { secs, .. } => (
                    "tunnel_timeout",
                    params([
                        ("host", tunnel.host.clone()),
                        ("port", tunnel.port.to_string()),
                        ("secs", secs.to_string()),
                    ]),
                ),
                TunnelFailure::Cancelled => ("tunnel_cancelled", Params::new()),
            },
            AppError::Connect(connect) => match connect {
                ConnectError::Unreachable { message } => ("unreachable", message_param(message)),
                ConnectError::Timeout => ("timeout", Params::new()),
                ConnectError::TlsNotSupported => ("tls_not_supported", Params::new()),
                ConnectError::Certificate { message } => ("certificate", message_param(message)),
                ConnectError::PasswordRequired => ("password_required", Params::new()),
                ConnectError::AuthFailed { message } => ("auth_failed", message_param(message)),
                ConnectError::Database { code, message } => (
                    "database",
                    params([("code", code.clone()), ("message", message.clone())]),
                ),
                ConnectError::Other { message } => ("other", message_param(message)),
            },
        };
        let output = match &error {
            AppError::Tunnel(tunnel) => tunnel.failure.output().map(str::to_string),
            _ => None,
        };
        Self {
            kind,
            message,
            params,
            output,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::path::PathBuf;

    use chilla_core::application::{
        CancelError, ConnectError, FileError, PasswordStoreError, ProjectError, QueryError,
        SplitError, StoreError, TunnelError,
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
                AppError::Catalog(QueryError::ConnectionLost {
                    message: message.clone(),
                }),
                "catalog_failed",
            ),
            (
                AppError::UnknownConnection { name: "x".into() },
                "unknown_connection",
            ),
            (
                AppError::UnknownSession { id: SessionId(1) },
                "unknown_session",
            ),
            (
                StoreError {
                    message: message.clone(),
                }
                .into(),
                "store_failed",
            ),
            (AppError::StoreUnavailable, "store_unavailable"),
            (AppError::RelationGone, "relation_gone"),
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
                ProfileError::StatementTimeoutRange { secs: 0 },
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

    /// `errorKinds.json`은 화면이 `error.<kind>` 문구에 쓸 param 이름을 kind별로 적은 파일이다.
    /// 같은 kind의 variant마다 param이 다르면 합집합이다.
    #[test]
    fn kinds_and_params_match_the_screen() {
        let mut actual: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for (error, _) in all_errors() {
            let error = CommandError::from(error);
            actual
                .entry(error.kind.to_string())
                .or_default()
                .extend(error.params.keys().map(|key| key.to_string()));
        }
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/shared/i18n/errorKinds.json"
        );
        let json = std::fs::read_to_string(path).unwrap();
        let expected: BTreeMap<String, BTreeSet<String>> = serde_json::from_str(&json).unwrap();
        assert_eq!(actual, expected);
    }

    #[test]
    fn params_hold_the_variable_parts() {
        let not_found = CommandError::from(AppError::from(ProjectError::NotFound {
            path: PathBuf::from("/p/chilla.toml"),
        }));
        assert_eq!(
            not_found.params,
            BTreeMap::from([("path", "/p/chilla.toml".to_string())])
        );

        let database = CommandError::from(AppError::from(ConnectError::Database {
            code: "3D000".into(),
            message: "database \"x\" does not exist".into(),
        }));
        assert_eq!(
            database.params,
            BTreeMap::from([
                ("code", "3D000".to_string()),
                ("message", "database \"x\" does not exist".to_string()),
            ])
        );
        let json = serde_json::to_value(&database).unwrap();
        assert_eq!(json["params"]["code"], "3D000");
    }

    #[test]
    fn bundled_kinds_pass_the_whole_message() {
        let error = AppError::from(ProjectError::Parse {
            message: "bad".into(),
        });
        let command = CommandError::from(error);
        assert_eq!(command.kind, "project_invalid");
        assert_eq!(command.params["message"], command.message);
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
