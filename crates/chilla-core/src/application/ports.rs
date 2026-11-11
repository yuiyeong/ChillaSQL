//! `application`이 바깥에 요구하는 것. 구현은 `infrastructure`에 있다.

use std::future::Future;
use std::path::{Path, PathBuf};

use crate::domain::{
    Column, ConnectionProfile, Password, ProfileError, Project, Row, ServerError, StatementSpan,
    TxStatus,
};

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
    #[error("접속 '{connection}'의 설정이 잘못됐습니다: {source}")]
    InvalidConnection {
        connection: String,
        source: ProfileError,
    },
}

/// 키체인 항목 하나를 가리킨다. 프로젝트 디렉토리를 옮기면 다른 항목이 된다.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PasswordKey {
    pub project_dir: PathBuf,
    pub connection: String,
}

/// 접속 비밀번호 저장소. 호출이 blocking일 수 있다 (키체인 확인 창).
pub trait PasswordStore: Send + Sync {
    fn get(&self, key: &PasswordKey) -> Result<Option<Password>, PasswordStoreError>;
    fn set(&self, key: &PasswordKey, password: &Password) -> Result<(), PasswordStoreError>;
    /// 없는 항목을 지워도 `Ok`다.
    fn delete(&self, key: &PasswordKey) -> Result<(), PasswordStoreError>;
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("키체인에 접근하지 못했습니다: {message}")]
pub struct PasswordStoreError {
    pub message: String,
}

/// DB 연결을 연다. 세션 하나가 연결 하나를 혼자 쓴다 (pool 없음).
pub trait Connector: Send + Sync + 'static {
    type Connection: DbConnection;

    fn connect(
        &self,
        profile: &ConnectionProfile,
        password: Option<&Password>,
    ) -> impl Future<Output = Result<Self::Connection, ConnectError>> + Send;
}

/// 열려 있는 DB 연결 하나.
pub trait DbConnection: Send + 'static {
    type Rows: RowSource;
    type Cancel: QueryCancel;

    fn backend_pid(&self) -> i32;
    /// 서버가 마지막으로 알려 준 트랜잭션 상태. 오류 직후에는 서버가 상태를 알려 줄 때까지 기다린다.
    fn tx_status(&self) -> impl Future<Output = TxStatus> + Send;
    /// 연결이 밖에서 끊겼으면 true다 (서버 재시작, `pg_terminate_backend` 등).
    fn is_closed(&self) -> bool;
    /// 문장을 보낸다. 서버의 응답은 기다리지 않는다. 연결이 끊겨 있으면 `ConnectionLost`다.
    fn start_query(&self, sql: &str)
    -> impl Future<Output = Result<Self::Rows, QueryError>> + Send;
    /// 이 연결에서 실행 중인 쿼리를 멈추는 요청. 연결과 따로 살아서 다른 task에서 쓸 수 있다.
    fn cancel_handle(&self) -> Self::Cancel;
    /// 서버가 세션을 끝낼 때까지 기다린다. 실행 중인 쿼리가 있으면 끝날 때까지 기다리지 않는다.
    fn close(self) -> impl Future<Output = ()> + Send;
}

/// 쿼리 하나의 결과. 읽지 않으면 서버가 기다린다(backpressure).
pub trait RowSource: Send + 'static {
    /// 다음 항목. 결과가 끝나면 `None`이다. cancel-safe여야 한다(`select!`에서 쓴다).
    ///
    /// `Err(Server)` 뒤에도 `None`까지 읽어야 연결이 다음 쿼리를 받는다.
    /// `Err(ConnectionLost)`는 마지막 항목이고 그 뒤에는 `None`이다.
    fn next(&mut self) -> impl Future<Output = Option<Result<RowItem, QueryError>>> + Send;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowItem {
    Columns(Vec<Column>),
    Row(Row),
    /// 문장이 끝났다. `rows`는 서버가 알려 준 행 수다(영향받은 행 또는 돌려준 행).
    Complete {
        rows: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum QueryError {
    #[error("{}", .0.message)]
    Server(ServerError),
    #[error("연결이 끊겼습니다: {message}")]
    ConnectionLost { message: String },
}

pub trait QueryCancel: Send + 'static {
    /// cancel 요청을 보내고 서버가 처리할 때까지 기다린다. 실행 중인 쿼리가 없으면 서버가 무시한다.
    ///
    /// 쿼리가 서버에서 실행을 시작하기 전에 닿은 cancel도 무시된다. 쿼리가 cancel 뒤에도 끝나지
    /// 않으면 부르는 쪽이 다시 보내야 한다.
    fn cancel(self) -> impl Future<Output = Result<(), CancelError>> + Send;
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("취소 요청을 보내지 못했습니다: {message}")]
pub struct CancelError {
    pub message: String,
}

/// 연결 실패. 화면이 다음 행동을 고를 수 있게 나눈다. 어느 variant에도 비밀번호는 들어가지 않는다.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConnectError {
    #[error("서버에 연결하지 못했습니다: {message}")]
    Unreachable { message: String },
    #[error("서버가 제한 시간 안에 응답하지 않았습니다")]
    Timeout,
    #[error("서버가 SSL을 지원하지 않습니다")]
    TlsNotSupported,
    #[error("서버 인증서를 확인하지 못했습니다: {message}")]
    Certificate { message: String },
    #[error("비밀번호가 필요합니다")]
    PasswordRequired,
    #[error("인증에 실패했습니다: {message}")]
    AuthFailed { message: String },
    #[error("서버가 연결을 거부했습니다 ({code}): {message}")]
    Database { code: String, message: String },
    #[error("연결에 실패했습니다: {message}")]
    Other { message: String },
}

/// SQL text를 문장 단위로 나눈다. 문장이 문법에 맞는지는 보지 않는다.
pub trait StatementSplitter: Send + Sync {
    /// 문장마다 span을 돌려준다. 빈 문장은 만들지 않는다.
    fn split(&self, sql: &str) -> Result<Vec<StatementSpan>, SplitError>;
}

/// 따옴표, `$$`, 주석이 닫히지 않아 문장 경계를 알 수 없다.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("문장을 나누지 못했습니다: {message}")]
pub struct SplitError {
    pub message: String,
}
