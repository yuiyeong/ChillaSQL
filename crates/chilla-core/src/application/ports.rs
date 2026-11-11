//! `application`이 바깥에 요구하는 것. 구현은 `infrastructure`에 있다.

use std::path::{Path, PathBuf};

use crate::domain::{ProfileError, Project};

/// 프로젝트 디렉토리의 `chilla.toml`을 읽는다.
pub trait ProjectStore: Send + Sync {
    fn load(&self, dir: &Path) -> Result<Project, ProjectError>;
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProjectError {
    #[error("{} 파일이 없습니다", path.display())]
    NotFound { path: PathBuf },
    #[error("{} 파일을 읽지 못했습니다: {message}", path.display())]
    Read { path: PathBuf, message: String },
    #[error("chilla.toml의 형식이 잘못됐습니다: {message}")]
    Parse { message: String },
    #[error(
        "접속 '{connection}'에 password 항목이 있습니다. 비밀번호는 설정 파일에 쓰지 않고 키체인에 저장합니다"
    )]
    PasswordInConfig { connection: String },
    #[error(
        "접속 '{connection}'의 sslmode '{value}'는 쓸 수 없습니다. disable, require, verify-full 중 하나여야 합니다"
    )]
    UnknownSslMode { connection: String, value: String },
    #[error("접속 '{connection}'의 설정이 잘못됐습니다: {source}")]
    InvalidConnection {
        connection: String,
        source: ProfileError,
    },
}
