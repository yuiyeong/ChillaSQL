use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use toml_edit::{DocumentMut, Item, Table, TableLike, Value};

use super::atomic_write::{Missing, create_new_file, write_atomically};
use crate::application::{ProjectError, ProjectStore};
use crate::domain::{ConnectionProfile, Project, SslMode};

const FILE_NAME: &str = "chilla.toml";

/// 프로젝트 디렉토리의 `chilla.toml`을 읽고 쓰는 [`ProjectStore`].
pub struct TomlProjectStore;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawFile {
    project: Option<RawProject>,
    // 접속 하나의 오류에 접속 이름을 붙이려고 table로 받아 하나씩 읽는다.
    #[serde(default)]
    connections: toml::Table,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawProject {
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConnection {
    host: String,
    port: Option<u16>,
    database: String,
    user: String,
    sslmode: Option<String>,
    sslrootcert: Option<PathBuf>,
    tunnel: Option<String>,
    color: Option<String>,
}

impl ProjectStore for TomlProjectStore {
    fn load(&self, dir: &Path) -> Result<Project, ProjectError> {
        let text = read(&dir.join(FILE_NAME))?;
        parse(&canonical(dir)?, &text)
    }

    fn create(&self, dir: &Path) -> Result<Project, ProjectError> {
        let path = dir.join(FILE_NAME);
        let name = dir_name(&canonical(dir)?);
        let text = format!("[project]\nname = {}\n", Value::from(name));
        create_new_file(&path, &text).map_err(|e| match e.kind() {
            io::ErrorKind::AlreadyExists => ProjectError::AlreadyExists { path: path.clone() },
            _ => write_error(&path, e),
        })?;
        self.load(dir)
    }

    fn save_connection(
        &self,
        dir: &Path,
        profile: &ConnectionProfile,
    ) -> Result<Project, ProjectError> {
        let path = dir.join(FILE_NAME);
        let text = read(&path)?;
        let root = canonical(dir)?;
        // 읽지 못하는 파일(password 항목이 있는 파일 등)은 고치지 않는다.
        parse(&root, &text)?;
        profile
            .validate()
            .map_err(|source| ProjectError::InvalidConnection {
                connection: profile.name.clone(),
                source,
            })?;

        let sslrootcert = profile.sslrootcert.as_ref().map(|cert| {
            let cert = root.join(cert);
            // `dir`가 symlink를 거친 경로여도 그 아래의 파일이면 상대 경로로 쓴다.
            let relative = cert.strip_prefix(&root).or_else(|_| cert.strip_prefix(dir));
            relative.unwrap_or(&cert).to_string_lossy().into_owned()
        });
        let edited = with_connection(&text, profile, sslrootcert)?;
        let project = parse(&root, &edited).map_err(|e| write_error(&path, e))?;
        // 위에서 읽은 파일이다. 그 사이에 지워졌으면 다시 만들지 않는다.
        write_atomically(&path, &edited, Missing::Error).map_err(|e| write_error(&path, e))?;
        Ok(project)
    }
}

fn read(path: &Path) -> Result<String, ProjectError> {
    fs::read_to_string(path).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => ProjectError::NotFound {
            path: path.to_path_buf(),
        },
        _ => ProjectError::Read {
            path: path.to_path_buf(),
            message: e.to_string(),
        },
    })
}

fn canonical(dir: &Path) -> Result<PathBuf, ProjectError> {
    fs::canonicalize(dir).map_err(|e| ProjectError::Read {
        path: dir.to_path_buf(),
        message: e.to_string(),
    })
}

fn write_error(path: &Path, error: impl ToString) -> ProjectError {
    ProjectError::Write {
        path: path.to_path_buf(),
        message: error.to_string(),
    }
}

/// `chilla.toml`의 text를 프로젝트로 읽는다. `dir`는 canonical 경로다.
fn parse(dir: &Path, text: &str) -> Result<Project, ProjectError> {
    // 파일 전체의 오류는 줄 번호가 들어간 toml의 설명을 그대로 보여 준다.
    let file: RawFile = toml::from_str(text).map_err(|e| ProjectError::Parse {
        message: e.to_string().trim_end().to_string(),
    })?;
    // 모르는 항목 검사보다 먼저 봐야 password가 일반 오타 오류에 묻히지 않는다.
    reject_passwords(&file.connections)?;

    let connections = file
        .connections
        .into_iter()
        .map(|(name, value)| connection(dir, name, value))
        .collect::<Result<Vec<_>, _>>()?;
    let name = file
        .project
        .and_then(|p| p.name)
        .unwrap_or_else(|| dir_name(dir));

    Ok(Project {
        dir: dir.to_path_buf(),
        name,
        connections,
    })
}

/// `text`에서 `[connections.<name>]`만 `profile`로 고친 text. 다른 줄과 주석은 그대로 둔다.
/// `sslrootcert`는 파일에 쓸 값이다.
fn with_connection(
    text: &str,
    profile: &ConnectionProfile,
    sslrootcert: Option<String>,
) -> Result<String, ProjectError> {
    let mut doc: DocumentMut =
        text.parse()
            .map_err(|e: toml_edit::TomlError| ProjectError::Parse {
                message: e.to_string().trim_end().to_string(),
            })?;
    let existing = doc
        .get_mut("connections")
        .and_then(Item::as_table_like_mut)
        .and_then(|connections| connections.get_mut(&profile.name))
        .and_then(Item::as_table_like_mut);
    match existing {
        Some(table) => write_fields(table, profile, sslrootcert),
        None => {
            let mut table = Table::new();
            write_fields(&mut table, profile, sslrootcert);
            append(&mut doc, &profile.name, table, text.trim().is_empty());
        }
    }
    Ok(doc.to_string())
}

/// 접속 table의 key를 `profile`대로 쓴다. 없는 key는 이 순서로 끝에 더한다.
fn write_fields(
    table: &mut dyn TableLike,
    profile: &ConnectionProfile,
    sslrootcert: Option<String>,
) {
    // 기본값인 `disable`은 이미 쓰여 있을 때만 쓴다.
    let write_sslmode = profile.sslmode != SslMode::Disable || table.contains_key("sslmode");
    let fields = [
        ("host", Some(Value::from(profile.host.as_str()))),
        ("port", Some(Value::from(i64::from(profile.port)))),
        ("database", Some(Value::from(profile.database.as_str()))),
        ("user", Some(Value::from(profile.user.as_str()))),
        (
            "sslmode",
            write_sslmode.then(|| Value::from(profile.sslmode.as_str())),
        ),
        ("sslrootcert", sslrootcert.map(Value::from)),
        ("tunnel", profile.tunnel.as_deref().map(Value::from)),
        ("color", profile.color.as_deref().map(Value::from)),
    ];
    for (key, value) in fields {
        match value {
            Some(value) => set(table, key, value),
            None => remove(table, key),
        }
    }
}

/// 새 접속 table을 파일 끝에 빈 줄 하나를 두고 더한다. `blank_file`이면 빈 줄을 두지 않는다.
fn append(doc: &mut DocumentMut, name: &str, mut table: Table, blank_file: bool) {
    // 파일 끝의 주석은 앞 접속에 딸린 것이라 새 table 위에 남긴다.
    let trailing = doc.trailing().as_str().unwrap_or_default().trim_end();
    let mut prefix = String::new();
    if !trailing.is_empty() {
        prefix.push_str(trailing);
        prefix.push('\n');
    }
    if !blank_file {
        prefix.push('\n');
    }
    table.decor_mut().set_prefix(prefix);
    doc.set_trailing("");
    // table은 position 순서로 쓰인다. 어느 table보다 뒤에 오게 한다.
    table.set_position(Some(isize::MAX));

    let connections = doc.entry("connections").or_insert_with(|| {
        let mut connections = Table::new();
        connections.set_implicit(true);
        Item::Table(connections)
    });
    connections
        .as_table_like_mut()
        .expect("parse가 connections가 table인지 확인했다")
        .insert(name, Item::Table(table));
}

/// 값만 바꾼다. 자리와 그 줄의 주석(값의 decor)은 그대로 두고, 같은 값이면 건드리지 않는다.
fn set(table: &mut dyn TableLike, key: &str, value: Value) {
    let Some(old) = table.get_mut(key).and_then(Item::as_value_mut) else {
        table.insert(key, Item::Value(value));
        return;
    };
    let same = match (&*old, &value) {
        (Value::String(a), Value::String(b)) => a.value() == b.value(),
        (Value::Integer(a), Value::Integer(b)) => a.value() == b.value(),
        _ => false,
    };
    if !same {
        let decor = old.decor().clone();
        *old = value;
        *old.decor_mut() = decor;
    }
}

/// key를 지운다. 그 key 위의 주석 줄은 지우지 않고 다음 key 위로 옮긴다. 마지막 key면 앞 key의
/// 줄 뒤에 둔다.
fn remove(table: &mut dyn TableLike, key: &str) {
    let comments = table
        .key(key)
        .and_then(|k| k.leaf_decor().prefix()?.as_str())
        // 마지막 줄바꿈 뒤는 지우는 key의 들여쓰기다.
        .and_then(|prefix| prefix.get(..=prefix.rfind('\n')?))
        .filter(|lines| lines.contains('#'))
        .map(str::to_string);
    let keys: Vec<String> = table.iter().map(|(k, _)| k.to_string()).collect();
    if table.remove(key).is_none() {
        return;
    }
    let Some(comments) = comments else { return };
    let at = keys
        .iter()
        .position(|k| k == key)
        .expect("지운 key는 목록에 있다");

    if let Some(mut next) = keys.get(at + 1).and_then(|next| table.key_mut(next)) {
        let decor = next.leaf_decor_mut();
        let indent = decor.prefix().and_then(|p| p.as_str()).unwrap_or_default();
        let prefix = format!("{comments}{indent}");
        decor.set_prefix(prefix);
    } else if let Some(previous) = at
        .checked_sub(1)
        .and_then(|i| table.get_mut(&keys[i]))
        .and_then(Item::as_value_mut)
    {
        let decor = previous.decor_mut();
        let suffix = decor.suffix().and_then(|s| s.as_str()).unwrap_or_default();
        let suffix = format!("{suffix}\n{}", comments.trim_end_matches('\n'));
        decor.set_suffix(suffix);
    }
}

fn reject_passwords(connections: &toml::Table) -> Result<(), ProjectError> {
    for (name, value) in connections {
        let has_password = value
            .as_table()
            .is_some_and(|t| t.keys().any(|key| key.eq_ignore_ascii_case("password")));
        if has_password {
            return Err(ProjectError::PasswordInConfig {
                connection: name.clone(),
            });
        }
    }
    Ok(())
}

fn connection(
    dir: &Path,
    name: String,
    value: toml::Value,
) -> Result<ConnectionProfile, ProjectError> {
    let raw: RawConnection =
        value
            .try_into()
            .map_err(|e: toml::de::Error| ProjectError::Parse {
                message: format!("접속 '{name}': {}", e.message()),
            })?;
    let invalid = |source| ProjectError::InvalidConnection {
        connection: name.clone(),
        source,
    };
    let sslmode = match &raw.sslmode {
        None => SslMode::default(),
        Some(value) => value.parse().map_err(invalid)?,
    };
    let profile = ConnectionProfile {
        name: name.clone(),
        host: raw.host,
        port: raw.port.unwrap_or(ConnectionProfile::DEFAULT_PORT),
        database: raw.database,
        user: raw.user,
        sslmode,
        sslrootcert: raw.sslrootcert,
        tunnel: raw.tunnel,
        color: raw.color,
    }
    .resolved_under(dir);
    profile.validate().map_err(invalid)?;
    Ok(profile)
}

fn dir_name(dir: &Path) -> String {
    dir.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.display().to_string())
}
