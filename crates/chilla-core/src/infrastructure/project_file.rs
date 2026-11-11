use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::application::{ProjectError, ProjectStore};
use crate::domain::{ConnectionProfile, Project, SslMode};

const FILE_NAME: &str = "chilla.toml";

/// 프로젝트 디렉토리의 `chilla.toml`을 읽는 [`ProjectStore`].
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
        let path = dir.join(FILE_NAME);
        let text = fs::read_to_string(&path).map_err(|e| match e.kind() {
            io::ErrorKind::NotFound => ProjectError::NotFound { path: path.clone() },
            _ => ProjectError::Read {
                path: path.clone(),
                message: e.to_string(),
            },
        })?;
        let dir = fs::canonicalize(dir).map_err(|e| ProjectError::Read {
            path: dir.to_path_buf(),
            message: e.to_string(),
        })?;

        // 파일 전체의 오류는 줄 번호가 들어간 toml의 설명을 그대로 보여 준다.
        let file: RawFile = toml::from_str(&text).map_err(|e| ProjectError::Parse {
            message: e.to_string().trim_end().to_string(),
        })?;
        // 모르는 항목 검사보다 먼저 봐야 password가 일반 오타 오류에 묻히지 않는다.
        reject_passwords(&file.connections)?;

        let connections = file
            .connections
            .into_iter()
            .map(|(name, value)| connection(&dir, name, value))
            .collect::<Result<Vec<_>, _>>()?;
        let name = file
            .project
            .and_then(|p| p.name)
            .unwrap_or_else(|| dir_name(&dir));

        Ok(Project {
            dir,
            name,
            connections,
        })
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
