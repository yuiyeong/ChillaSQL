use std::fs;
use std::path::PathBuf;

use chilla_core::application::{ProjectError, ProjectStore};
use chilla_core::domain::{ProfileError, Project, SslMode};
use chilla_core::infrastructure::TomlProjectStore;
use tempfile::TempDir;

/// 기획서 5장의 예시.
const SPEC_EXAMPLE: &str = r#"
[project]
name = "my-service"

# 운영: public IP로 바로 접속 (터널 없음)
[connections.production]
host = "203.0.113.10"
port = 5432
database = "app"
user = "app_user"
sslmode = "require"        # 서버 인증서까지 확인하려면 "verify-full"
# sslrootcert = "certs/ca.pem"   # verify-full에서 이 CA만 신뢰
color = "red"

# 스테이징: 터널 명령을 먼저 실행한 뒤 접속
[connections.staging]
host = "localhost"
port = 25432
database = "railway"
user = "postgres"
tunnel = "railway connect Postgres18 -e staging --tunnel-only -P 25432"
color = "yellow"

[connections.local]
host = "localhost"
port = 5432
database = "app"
user = "postgres"
color = "green"
"#;

fn load(toml: &str) -> (TempDir, Result<Project, ProjectError>) {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("chilla.toml"), toml).unwrap();
    let result = TomlProjectStore.load(dir.path());
    (dir, result)
}

/// `[connections.local]`에 줄을 더한 파일을 읽는다.
fn load_local(extra: &str) -> Result<Project, ProjectError> {
    let toml = format!(
        "[connections.local]\nhost = \"localhost\"\ndatabase = \"app\"\nuser = \"postgres\"\n{extra}\n"
    );
    load(&toml).1
}

fn parse_message(result: Result<Project, ProjectError>) -> String {
    match result {
        Err(ProjectError::Parse { message }) => message,
        other => panic!("Parse 오류가 아니다: {other:?}"),
    }
}

#[test]
fn loads_the_spec_example() {
    let (dir, result) = load(SPEC_EXAMPLE);
    let project = result.unwrap();

    assert_eq!(project.name, "my-service");
    assert_eq!(project.dir, fs::canonicalize(dir.path()).unwrap());
    let names: Vec<&str> = project
        .connections
        .iter()
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(names, ["production", "staging", "local"]);

    let production = project.connection("production").unwrap();
    assert_eq!(production.host, "203.0.113.10");
    assert_eq!(production.port, 5432);
    assert_eq!(production.database, "app");
    assert_eq!(production.user, "app_user");
    assert_eq!(production.sslmode, SslMode::Require);
    assert_eq!(production.sslrootcert, None);
    assert_eq!(production.color.as_deref(), Some("red"));
    assert_eq!(production.tunnel, None);

    let staging = project.connection("staging").unwrap();
    assert_eq!(staging.port, 25432);
    assert_eq!(
        staging.tunnel.as_deref(),
        Some("railway connect Postgres18 -e staging --tunnel-only -P 25432")
    );

    assert_eq!(
        project.connection("local").unwrap().sslmode,
        SslMode::Disable
    );
}

#[test]
fn rejects_a_password_entry() {
    for key in ["password", "Password", "PASSWORD"] {
        assert_eq!(
            load_local(&format!("{key} = \"x\"")),
            Err(ProjectError::PasswordInConfig {
                connection: "local".into()
            }),
            "{key}"
        );
    }
}

#[test]
fn password_error_tells_where_passwords_go() {
    let message = load_local("password = \"x\"").unwrap_err().to_string();
    assert!(message.contains("local"), "{message}");
    assert!(message.contains("키체인"), "{message}");
}

#[test]
fn missing_file_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        TomlProjectStore.load(dir.path()),
        Err(ProjectError::NotFound {
            path: dir.path().join("chilla.toml")
        })
    );
}

#[test]
fn rejects_unknown_entries() {
    assert!(parse_message(load_local("sslmod = \"require\"")).contains("sslmod"));
    let (_dir, result) = load("[project]\nnmae = \"x\"\n");
    assert!(parse_message(result).contains("nmae"));
    let (_dir, result) = load("[conections.local]\nhost = \"h\"\n");
    assert!(parse_message(result).contains("conections"));
}

#[test]
fn rejects_malformed_entries() {
    parse_message(load_local("port = \"5432\""));
    parse_message(load_local("port = 70000"));
    parse_message(load("this is not toml").1);
    let (_dir, result) = load("[connections.local]\ndatabase = \"app\"\nuser = \"postgres\"\n");
    assert!(parse_message(result).contains("host"));
}

#[test]
fn rejects_an_unknown_sslmode() {
    assert_eq!(
        load_local("sslmode = \"prefer\""),
        Err(ProjectError::InvalidConnection {
            connection: "local".into(),
            source: ProfileError::UnknownSslMode {
                value: "prefer".into()
            }
        })
    );
}

#[test]
fn rejects_invalid_connections() {
    assert_eq!(
        load_local("port = 0"),
        Err(ProjectError::InvalidConnection {
            connection: "local".into(),
            source: ProfileError::ZeroPort
        })
    );
    assert_eq!(
        load_local("sslmode = \"require\"\nsslrootcert = \"ca.pem\""),
        Err(ProjectError::InvalidConnection {
            connection: "local".into(),
            source: ProfileError::RootCertWithoutVerifyFull
        })
    );
    let (_dir, result) =
        load("[connections.local]\nhost = \" \"\ndatabase = \"app\"\nuser = \"postgres\"\n");
    assert_eq!(
        result,
        Err(ProjectError::InvalidConnection {
            connection: "local".into(),
            source: ProfileError::EmptyField { field: "host" }
        })
    );
}

#[test]
fn resolves_sslrootcert_against_the_project_dir() {
    let (dir, result) = load(
        "[connections.a]\nhost = \"h\"\ndatabase = \"d\"\nuser = \"u\"\nsslmode = \"verify-full\"\nsslrootcert = \"certs/ca.pem\"\n\
         [connections.b]\nhost = \"h\"\ndatabase = \"d\"\nuser = \"u\"\nsslmode = \"verify-full\"\nsslrootcert = \"/etc/ca.pem\"\n",
    );
    let project = result.unwrap();
    assert_eq!(
        project.connection("a").unwrap().sslrootcert,
        Some(fs::canonicalize(dir.path()).unwrap().join("certs/ca.pem"))
    );
    assert_eq!(
        project.connection("b").unwrap().sslrootcert,
        Some(PathBuf::from("/etc/ca.pem"))
    );
}

#[test]
fn defaults() {
    let (dir, result) = load("");
    let project = result.unwrap();
    let dir_name = fs::canonicalize(dir.path()).unwrap();
    assert_eq!(
        project.name,
        dir_name.file_name().unwrap().to_str().unwrap()
    );
    assert!(project.connections.is_empty());

    let project = load_local("").unwrap();
    let local = project.connection("local").unwrap();
    assert_eq!(local.port, 5432);
    assert_eq!(local.sslmode, SslMode::Disable);
    assert_eq!(local.tunnel, None);
    assert_eq!(local.color, None);
}
