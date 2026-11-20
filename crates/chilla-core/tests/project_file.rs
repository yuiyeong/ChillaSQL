use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use chilla_core::application::{ProjectError, ProjectStore};
use chilla_core::domain::{ConnectionColor, ConnectionProfile, ProfileError, Project, SslMode};
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
database = "app"
user = "postgres"
tunnel = "ssh -N -L 25432:db.internal:5432 bastion"
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
    assert_eq!(production.color, Some(ConnectionColor::Red));
    assert_eq!(production.tunnel, None);

    let staging = project.connection("staging").unwrap();
    assert_eq!(staging.port, 25432);
    assert_eq!(
        staging.tunnel.as_deref(),
        Some("ssh -N -L 25432:db.internal:5432 bastion")
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
    assert!(message.contains("keychain"), "{message}");
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
fn unknown_color_is_rejected() {
    assert_eq!(
        load_local("color = \"orange\""),
        Err(ProjectError::InvalidConnection {
            connection: "local".into(),
            source: ProfileError::UnknownColor {
                value: "orange".into()
            }
        })
    );
}

#[test]
fn color_round_trips() {
    let (_dir, result) = load(SPEC_EXAMPLE);
    let project = result.unwrap();
    let production = project.connection("production").unwrap().clone();
    assert_eq!(production.color, Some(ConnectionColor::Red));

    let colorless = ConnectionProfile {
        color: None,
        ..production
    };
    let (_dir, result, text) = saved(SPEC_EXAMPLE, colorless);
    result.unwrap();
    assert!(!text.contains("color = \"red\""), "{text}");
    assert_eq!(text, SPEC_EXAMPLE.replace("color = \"red\"\n", ""));
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
fn tunnel_timeout_round_trips() {
    let toml = "[connections.local]\nhost = \"localhost\"\ndatabase = \"app\"\nuser = \"postgres\"\ntunnel = \"ssh -N -L 25432:db.internal:5432 bastion\"\ntunnel_timeout = 30\n";
    let (dir, result) = load(toml);
    let local = result.unwrap().connection("local").unwrap().clone();
    assert_eq!(local.tunnel_timeout, Some(Duration::from_secs(30)));

    let cleared = ConnectionProfile {
        tunnel_timeout: None,
        ..local.clone()
    };
    TomlProjectStore
        .save_connection(dir.path(), &cleared)
        .unwrap();
    let text = fs::read_to_string(dir.path().join("chilla.toml")).unwrap();
    assert!(!text.contains("tunnel_timeout"), "{text}");

    let set = ConnectionProfile {
        tunnel_timeout: Some(Duration::from_secs(45)),
        ..local
    };
    let project = TomlProjectStore.save_connection(dir.path(), &set).unwrap();
    let text = fs::read_to_string(dir.path().join("chilla.toml")).unwrap();
    assert!(text.contains("tunnel_timeout = 45\n"), "{text}");
    assert_eq!(
        project.connection("local").unwrap().tunnel_timeout,
        Some(Duration::from_secs(45))
    );
}

#[test]
fn tunnel_timeout_must_be_whole_seconds_in_range() {
    let message = parse_message(load_local("tunnel = \"ssh\"\ntunnel_timeout = \"20s\""));
    assert!(message.contains("tunnel_timeout"), "{message}");
    let message = parse_message(load_local("tunnel = \"ssh\"\ntunnel_timeout = -5"));
    assert!(message.contains("tunnel_timeout"), "{message}");
    assert_eq!(
        load_local("tunnel = \"ssh\"\ntunnel_timeout = 0"),
        Err(ProjectError::InvalidConnection {
            connection: "local".into(),
            source: ProfileError::TunnelTimeoutRange { secs: 0 }
        })
    );
}

#[test]
fn tunnel_timeout_without_tunnel_is_rejected() {
    assert_eq!(
        load_local("tunnel_timeout = 30"),
        Err(ProjectError::InvalidConnection {
            connection: "local".into(),
            source: ProfileError::TunnelTimeoutWithoutTunnel
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

/// `SPEC_EXAMPLE`의 `production`과 같은 접속.
fn production() -> ConnectionProfile {
    ConnectionProfile {
        name: "production".into(),
        host: "203.0.113.10".into(),
        port: 5432,
        database: "app".into(),
        user: "app_user".into(),
        sslmode: SslMode::Require,
        sslrootcert: None,
        tunnel: None,
        tunnel_timeout: None,
        color: Some(ConnectionColor::Red),
        read_only: false,
        statement_timeout: None,
    }
}

fn analytics() -> ConnectionProfile {
    ConnectionProfile {
        name: "analytics".into(),
        host: "10.0.0.5".into(),
        port: 6432,
        database: "events".into(),
        user: "reader".into(),
        sslmode: SslMode::Require,
        sslrootcert: None,
        tunnel: None,
        tunnel_timeout: None,
        color: None,
        read_only: false,
        statement_timeout: None,
    }
}

/// `toml`을 쓴 디렉토리에 `profile`을 저장하고, 그 결과와 저장 뒤 디스크의 text를 돌려준다.
fn saved(
    toml: &str,
    profile: ConnectionProfile,
) -> (TempDir, Result<Project, ProjectError>, String) {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("chilla.toml"), toml).unwrap();
    let result = TomlProjectStore.save_connection(dir.path(), &profile);
    let text = fs::read_to_string(dir.path().join("chilla.toml")).unwrap();
    (dir, result, text)
}

fn names(project: &Project) -> Vec<&str> {
    project
        .connections
        .iter()
        .map(|c| c.name.as_str())
        .collect()
}

#[test]
fn create_writes_a_minimal_file_that_loads() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let name = root.file_name().unwrap().to_str().unwrap().to_string();

    assert_eq!(
        TomlProjectStore.create(dir.path()),
        Ok(Project {
            dir: root.clone(),
            name: name.clone(),
            connections: Vec::new(),
        })
    );
    let path = dir.path().join("chilla.toml");
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        format!("[project]\nname = \"{name}\"\n")
    );

    assert_eq!(
        TomlProjectStore.create(dir.path()),
        Err(ProjectError::AlreadyExists { path })
    );
    let missing = TomlProjectStore.create(&dir.path().join("missing"));
    assert!(
        matches!(missing, Err(ProjectError::Read { .. })),
        "{missing:?}"
    );
}

/// Review Focus 5
#[test]
fn save_connection_changes_only_that_connection() {
    let blue = ConnectionProfile {
        color: Some(ConnectionColor::Blue),
        ..production()
    };
    let (_dir, result, text) = saved(SPEC_EXAMPLE, blue.clone());
    assert_eq!(
        text,
        SPEC_EXAMPLE.replace("color = \"red\"", "color = \"blue\"")
    );
    let project = result.unwrap();
    assert_eq!(project.connection("production"), Some(&blue));
    assert_eq!(names(&project), ["production", "staging", "local"]);

    let (_dir, result, text) = saved(SPEC_EXAMPLE, production());
    assert_eq!(text, SPEC_EXAMPLE);
    assert_eq!(
        result.unwrap().connection("production"),
        Some(&production())
    );
}

#[test]
fn save_connection_appends_a_new_connection_at_the_end() {
    let (dir, result, text) = saved(SPEC_EXAMPLE, analytics());
    assert!(text.starts_with(SPEC_EXAMPLE), "{text}");
    let added = &text[SPEC_EXAMPLE.len()..];
    assert_eq!(
        added,
        "\n[connections.analytics]\nhost = \"10.0.0.5\"\nport = 6432\ndatabase = \"events\"\nuser = \"reader\"\nsslmode = \"require\"\n"
    );
    assert!(
        !added.contains("color") && !added.contains("tunnel"),
        "{added}"
    );

    let loaded = TomlProjectStore.load(dir.path()).unwrap();
    assert_eq!(
        names(&loaded),
        ["production", "staging", "local", "analytics"]
    );
    assert_eq!(loaded.connection("analytics"), Some(&analytics()));
    assert_eq!(result, Ok(loaded));

    let plain = ConnectionProfile {
        sslmode: SslMode::Disable,
        ..analytics()
    };
    let (dir, _result, text) = saved(SPEC_EXAMPLE, plain.clone());
    assert!(!text[SPEC_EXAMPLE.len()..].contains("sslmode"), "{text}");
    let loaded = TomlProjectStore.load(dir.path()).unwrap();
    assert_eq!(loaded.connection("analytics"), Some(&plain));
}

#[test]
fn save_connection_appends_after_comments_at_the_end_of_the_file() {
    let toml = format!("{SPEC_EXAMPLE}# sslmode = \"require\"\n");
    let (_dir, result, text) = saved(&toml, analytics());
    result.unwrap();
    assert!(text.starts_with(&toml), "{text}");

    let (_dir, result, text) = saved("", analytics());
    result.unwrap();
    assert!(text.starts_with("[connections.analytics]\n"), "{text}");
}

#[test]
fn save_connection_removes_optional_keys_that_are_unset() {
    let staging = ConnectionProfile {
        name: "staging".into(),
        host: "localhost".into(),
        port: 25432,
        database: "app".into(),
        user: "postgres".into(),
        sslmode: SslMode::Disable,
        sslrootcert: None,
        tunnel: None,
        tunnel_timeout: None,
        color: None,
        read_only: false,
        statement_timeout: None,
    };
    let (dir, _result, text) = saved(SPEC_EXAMPLE, staging);
    assert!(
        !text.contains("tunnel") && !text.contains("yellow"),
        "{text}"
    );
    let loaded = TomlProjectStore.load(dir.path()).unwrap();
    let staging = loaded.connection("staging").unwrap();
    assert_eq!(staging.tunnel, None);
    assert_eq!(staging.color, None);

    let disabled = ConnectionProfile {
        sslmode: SslMode::Disable,
        ..production()
    };
    let (dir, _result, text) = saved(SPEC_EXAMPLE, disabled);
    assert!(
        text.contains(
            "sslmode = \"disable\"        # 서버 인증서까지 확인하려면 \"verify-full\"\n"
        ),
        "{text}"
    );
    let loaded = TomlProjectStore.load(dir.path()).unwrap();
    assert_eq!(
        loaded.connection("production").unwrap().sslmode,
        SslMode::Disable
    );
}

#[test]
fn save_connection_keeps_comments_above_removed_keys() {
    // `# sslrootcert` 줄은 `color` 위에 있다. `color`를 지워도 그 줄은 남는다.
    let colorless = ConnectionProfile {
        color: None,
        ..production()
    };
    let (_dir, result, text) = saved(SPEC_EXAMPLE, colorless);
    result.unwrap();
    assert_eq!(text, SPEC_EXAMPLE.replace("color = \"red\"\n", ""));

    let toml = "[connections.local]\nhost = \"localhost\"\nport = 5432\ndatabase = \"app\"\nuser = \"postgres\"\n\
                # 터널 없이 바로 붙는다\ntunnel = \"ssh\"\ncolor = \"green\"\n";
    let local = ConnectionProfile {
        name: "local".into(),
        host: "localhost".into(),
        port: 5432,
        database: "app".into(),
        user: "postgres".into(),
        sslmode: SslMode::Disable,
        sslrootcert: None,
        tunnel: None,
        tunnel_timeout: None,
        color: Some(ConnectionColor::Green),
        read_only: false,
        statement_timeout: None,
    };
    let (_dir, result, text) = saved(toml, local);
    result.unwrap();
    assert_eq!(text, toml.replace("tunnel = \"ssh\"\n", ""));
}

#[test]
fn save_connection_writes_sslrootcert_relative_to_the_project_dir() {
    let dir = tempfile::tempdir().unwrap();
    let root = fs::canonicalize(dir.path()).unwrap();
    let path = dir.path().join("chilla.toml");
    let with_cert = |cert: PathBuf| ConnectionProfile {
        sslmode: SslMode::VerifyFull,
        sslrootcert: Some(cert),
        ..production()
    };
    // `dir.path()`가 symlink를 거쳐도(macOS의 `/var` 등) 프로젝트 디렉토리 아래로 본다.
    for cert in [root.join("certs/ca.pem"), dir.path().join("certs/ca.pem")] {
        fs::write(&path, SPEC_EXAMPLE).unwrap();
        let project = TomlProjectStore
            .save_connection(dir.path(), &with_cert(cert))
            .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("sslrootcert = \"certs/ca.pem\""), "{text}");
        assert_eq!(
            project.connection("production").unwrap().sslrootcert,
            Some(root.join("certs/ca.pem"))
        );
    }

    let (dir, _result, text) = saved(SPEC_EXAMPLE, with_cert("/etc/ssl/ca.pem".into()));
    assert!(text.contains("sslrootcert = \"/etc/ssl/ca.pem\""), "{text}");
    let loaded = TomlProjectStore.load(dir.path()).unwrap();
    assert_eq!(
        loaded.connection("production").unwrap().sslrootcert,
        Some(PathBuf::from("/etc/ssl/ca.pem"))
    );
}

#[test]
fn save_connection_refuses_a_file_it_cannot_load() {
    let toml = format!("{SPEC_EXAMPLE}password = \"x\"\n");
    let (_dir, result, text) = saved(&toml, production());
    assert_eq!(
        result,
        Err(ProjectError::PasswordInConfig {
            connection: "local".into()
        })
    );
    assert_eq!(text, toml);

    let (_dir, result, text) = saved(
        SPEC_EXAMPLE,
        ConnectionProfile {
            port: 0,
            ..production()
        },
    );
    assert_eq!(
        result,
        Err(ProjectError::InvalidConnection {
            connection: "production".into(),
            source: ProfileError::ZeroPort
        })
    );
    assert_eq!(text, SPEC_EXAMPLE);

    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        TomlProjectStore.save_connection(dir.path(), &production()),
        Err(ProjectError::NotFound {
            path: dir.path().join("chilla.toml")
        })
    );
}

#[test]
fn save_connection_reports_a_write_failure() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("chilla.toml");
    fs::write(&path, SPEC_EXAMPLE).unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o555)).unwrap();
    let result = TomlProjectStore.save_connection(dir.path(), &analytics());
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();

    assert!(
        matches!(&result, Err(ProjectError::Write { path: p, .. }) if *p == path),
        "{result:?}"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), SPEC_EXAMPLE);
}

#[test]
fn save_connection_quotes_names_that_need_it() {
    let quoted = ConnectionProfile {
        name: "my db.prod".into(),
        ..analytics()
    };
    let (dir, result, text) = saved(SPEC_EXAMPLE, quoted.clone());
    assert_eq!(result.unwrap().connection("my db.prod"), Some(&quoted));
    assert!(!text.to_lowercase().contains("password"), "{text}");

    let recolored = ConnectionProfile {
        color: Some(ConnectionColor::Blue),
        ..quoted
    };
    let project = TomlProjectStore
        .save_connection(dir.path(), &recolored)
        .unwrap();
    let same_name = project
        .connections
        .iter()
        .filter(|c| c.name == "my db.prod");
    assert_eq!(same_name.collect::<Vec<_>>(), [&recolored]);
}

#[test]
fn save_connection_leaves_no_temporary_file() {
    let (dir, result, _text) = saved(SPEC_EXAMPLE, analytics());
    result.unwrap();
    let entries: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(entries, ["chilla.toml"]);
}

#[test]
fn save_connection_does_not_follow_a_planted_temporary_symlink() {
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("victim.txt");
    fs::write(&target, "untouched\n").unwrap();
    let (dir, _, _) = saved(SPEC_EXAMPLE, production());
    std::os::unix::fs::symlink(&target, dir.path().join(".chilla.toml.chilla-tmp")).unwrap();

    let result = TomlProjectStore.save_connection(dir.path(), &analytics());

    assert_eq!(result.unwrap().connection("analytics"), Some(&analytics()));
    assert_eq!(fs::read_to_string(&target).unwrap(), "untouched\n");
    let path = dir.path().join("chilla.toml");
    assert!(fs::symlink_metadata(&path).unwrap().file_type().is_file());
    let loaded = TomlProjectStore.load(dir.path()).unwrap();
    assert_eq!(loaded.connection("analytics"), Some(&analytics()));
    let entries: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(entries, ["chilla.toml"]);
}

#[test]
fn save_connection_keeps_the_file_mode() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("chilla.toml");
    fs::write(&path, SPEC_EXAMPLE).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();

    TomlProjectStore
        .save_connection(dir.path(), &analytics())
        .unwrap();

    let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "{mode:o}");
}

#[test]
fn reads_read_only_and_statement_timeout() {
    let project = load_local("read_only = true\nstatement_timeout = 30").unwrap();
    let local = project.connection("local").unwrap();
    assert!(local.read_only);
    assert_eq!(local.statement_timeout, Some(Duration::from_secs(30)));

    let project = load_local("").unwrap();
    let local = project.connection("local").unwrap();
    assert!(!local.read_only);
    assert_eq!(local.statement_timeout, None);

    assert_eq!(
        load_local("statement_timeout = 0"),
        Err(ProjectError::InvalidConnection {
            connection: "local".into(),
            source: ProfileError::StatementTimeoutRange { secs: 0 }
        })
    );
    assert_eq!(
        load_local("statement_timeout = 86401"),
        Err(ProjectError::InvalidConnection {
            connection: "local".into(),
            source: ProfileError::StatementTimeoutRange { secs: 86_401 }
        })
    );
}

#[test]
fn writes_them_only_when_set() {
    let toml =
        "[connections.local]\nhost = \"localhost\"\ndatabase = \"app\"\nuser = \"postgres\"\n";
    let (dir, result) = load(toml);
    let local = result.unwrap().connection("local").unwrap().clone();

    // false와 없음은 key를 쓰지 않는다.
    TomlProjectStore
        .save_connection(dir.path(), &local)
        .unwrap();
    let text = fs::read_to_string(dir.path().join("chilla.toml")).unwrap();
    assert!(!text.contains("read_only"), "{text}");
    assert!(!text.contains("statement_timeout"), "{text}");

    let set = ConnectionProfile {
        read_only: true,
        statement_timeout: Some(Duration::from_secs(45)),
        ..local.clone()
    };
    let project = TomlProjectStore.save_connection(dir.path(), &set).unwrap();
    let text = fs::read_to_string(dir.path().join("chilla.toml")).unwrap();
    assert!(text.contains("read_only = true\n"), "{text}");
    assert!(text.contains("statement_timeout = 45\n"), "{text}");
    let saved = project.connection("local").unwrap();
    assert!(saved.read_only);
    assert_eq!(saved.statement_timeout, Some(Duration::from_secs(45)));

    // 다시 끄면 key가 지워진다.
    TomlProjectStore
        .save_connection(dir.path(), &local)
        .unwrap();
    let text = fs::read_to_string(dir.path().join("chilla.toml")).unwrap();
    assert!(!text.contains("read_only"), "{text}");
    assert!(!text.contains("statement_timeout"), "{text}");
}

#[test]
fn rejects_a_string_statement_timeout() {
    let message = parse_message(load_local("statement_timeout = \"30s\""));
    assert!(message.contains("statement_timeout"), "{message}");
    let message = parse_message(load_local("statement_timeout = -5"));
    assert!(message.contains("statement_timeout"), "{message}");
}
