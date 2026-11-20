//! `application`이 바깥에 요구하는 것. 구현은 `infrastructure`에 있다.

use std::future::Future;
use std::path::{Path, PathBuf};

use crate::domain::{
    Catalog, Column, ConnectionProfile, Danger, EndOutcome, FileStamp, ParameterSpan, Password,
    ProfileError, Project, QueryOutcome, Row, ServerError, SqlFile, SqlPath, StatementSpan,
    TableDetails, TxStatus, TypeInfo, WriteMode,
};

/// 프로젝트 디렉토리의 `chilla.toml`을 읽고 쓴다.
pub trait ProjectStore: Send + Sync {
    fn load(&self, dir: &Path) -> Result<Project, ProjectError>;
    /// `chilla.toml`이 없는 디렉토리에 파일을 만들고 그 프로젝트를 돌려준다.
    fn create(&self, dir: &Path) -> Result<Project, ProjectError>;
    /// 접속 하나를 쓰고 쓴 뒤의 프로젝트를 돌려준다. 같은 이름이 있으면 바꾸고 없으면 끝에 더한다.
    fn save_connection(
        &self,
        dir: &Path,
        profile: &ConnectionProfile,
    ) -> Result<Project, ProjectError>;
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProjectError {
    #[error("{} was not found", path.display())]
    NotFound { path: PathBuf },
    #[error("{} already exists", path.display())]
    AlreadyExists { path: PathBuf },
    #[error("Could not read {}: {message}", path.display())]
    Read { path: PathBuf, message: String },
    #[error("Could not write {}: {message}", path.display())]
    Write { path: PathBuf, message: String },
    #[error("chilla.toml is malformed: {message}")]
    Parse { message: String },
    #[error(
        "Connection '{connection}' has a password entry. Passwords are stored in the keychain, not in the config file"
    )]
    PasswordInConfig { connection: String },
    #[error("Connection '{connection}' is invalid: {source}")]
    InvalidConnection {
        connection: String,
        source: ProfileError,
    },
}

/// 프로젝트 디렉토리 아래의 `.sql` 파일. `path`는 모두 프로젝트 디렉토리 기준이다.
pub trait SqlFileStore: Send + Sync {
    /// 프로젝트 디렉토리 아래의 `.sql` 파일. 경로 오름차순이다.
    fn list(&self, project_dir: &Path) -> Result<Vec<SqlPath>, FileError>;
    fn read(&self, project_dir: &Path, path: &SqlPath) -> Result<SqlFile, FileError>;
    /// `mode`가 허락할 때만 쓰고, 쓴 뒤의 stamp를 돌려준다.
    fn write(
        &self,
        project_dir: &Path,
        path: &SqlPath,
        text: &str,
        mode: &WriteMode,
    ) -> Result<FileStamp, FileError>;
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FileError {
    #[error("{path} was not found")]
    NotFound { path: String },
    #[error("{path} already exists")]
    Exists { path: String },
    #[error("{path} was changed on disk after it was opened")]
    Changed { path: String },
    #[error("{path} is too large ({bytes} bytes). Files up to 16 MiB can be opened")]
    TooLarge { path: String, bytes: u64 },
    #[error("{path} is not UTF-8")]
    NotUtf8 { path: String },
    #[error("{path} points outside the project directory")]
    OutsideProject { path: String },
    #[error("Could not access {path}: {message}")]
    Io { path: String, message: String },
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
#[error("Could not access the keychain: {message}")]
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
/// `Sync`인 것은 catalog 읽기가 연결을 빌린 채 `async move` 안에서 기다리기 때문이다.
pub trait DbConnection: Send + Sync + 'static {
    type Rows: RowSource;
    type Cancel: QueryCancel;

    fn backend_pid(&self) -> i32;
    /// 연결할 때 받은 `server_version`의 첫 단어("18.6").
    fn server_version(&self) -> &str;
    /// 서버가 마지막으로 알려 준 트랜잭션 상태. 오류 직후에는 서버가 상태를 알려 줄 때까지 기다린다.
    fn tx_status(&self) -> impl Future<Output = TxStatus> + Send;
    /// 연결이 밖에서 끊겼으면 true다 (서버 재시작, `pg_terminate_backend` 등).
    fn is_closed(&self) -> bool;
    /// 문장을 보낸다. 서버의 응답은 기다리지 않는다. 연결이 끊겨 있으면 `ConnectionLost`, 보낼 수
    /// 없는 text(NUL이 든 text 등)면 `Client`다.
    fn start_query(&self, sql: &str)
    -> impl Future<Output = Result<Self::Rows, QueryError>> + Send;
    /// 결과 행이 없는 문장(`BEGIN`, `COMMIT`, `ROLLBACK`)을 simple query로 보내고 서버가 끝낼 때까지
    /// 기다린다. 서버가 거절하면 `Server`다. 연결이 끊겨 있으면 `ConnectionLost`다.
    fn simple_execute(&self, sql: &str) -> impl Future<Output = Result<(), QueryError>> + Send;
    /// 스키마 트리와 자동완성의 catalog. 연결이 끊겨 있으면 `ConnectionLost`다.
    fn read_catalog(&self) -> impl Future<Output = Result<Catalog, QueryError>> + Send;
    /// 그 relation의 인덱스와 제약조건, 각각 이름 오름차순. 없는 OID면 둘 다 비어 있다.
    fn read_table_details(
        &self,
        relation: u32,
    ) -> impl Future<Output = Result<TableDetails, QueryError>> + Send;
    /// 결과 컬럼의 `(type OID, typmod)`마다 이름과 category. 모르는 OID(0 포함)는 결과에 없다.
    /// 연결이 끊겨 있으면 `ConnectionLost`다.
    fn describe_types(
        &self,
        types: &[(u32, i32)],
    ) -> impl Future<Output = Result<Vec<TypeInfo>, QueryError>> + Send;
    /// 이 연결에서 실행 중인 쿼리를 멈추는 요청. 연결과 따로 살아서 다른 task에서 쓸 수 있다.
    fn cancel_handle(&self) -> Self::Cancel;
    /// 서버가 세션을 끝낼 때까지 기다린다. 실행 중인 쿼리가 있으면 끝날 때까지 기다리지 않는다.
    fn close(self) -> impl Future<Output = ()> + Send;
}

/// 쿼리 하나의 결과. 읽지 않으면 서버가 기다린다(backpressure).
pub trait RowSource: Send + 'static {
    /// 다음 항목. 결과가 끝나면 `None`이다. cancel-safe여야 한다(`select!`에서 쓴다).
    ///
    /// `Err(Server)`와 `Err(Client)` 뒤에도 `None`까지 읽어야 연결이 다음 쿼리를 받는다.
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
    #[error("Connection lost: {message}")]
    ConnectionLost { message: String },
    /// 서버의 오류도 아니고 연결이 끊긴 것도 아니다(UTF-8이 아닌 값, 보낼 수 없는 text 등).
    /// 연결은 계속 쓸 수 있다.
    #[error("Could not process the query: {message}")]
    Client { message: String },
}

impl From<QueryError> for QueryOutcome {
    fn from(error: QueryError) -> Self {
        match error {
            QueryError::Server(error) => QueryOutcome::Failed(error),
            QueryError::ConnectionLost { message } => QueryOutcome::ConnectionLost { message },
            QueryError::Client { message } => QueryOutcome::ClientError { message },
        }
    }
}

impl From<QueryError> for EndOutcome {
    fn from(error: QueryError) -> Self {
        match error {
            QueryError::Server(error) => EndOutcome::Server(error),
            QueryError::ConnectionLost { message } => EndOutcome::ConnectionLost { message },
            QueryError::Client { message } => EndOutcome::Client { message },
        }
    }
}

pub trait QueryCancel: Send + 'static {
    /// cancel 요청을 보내고 서버가 처리할 때까지 기다린다. 실행 중인 쿼리가 없으면 서버가 무시한다.
    ///
    /// 쿼리가 서버에서 실행을 시작하기 전에 닿은 cancel도 무시된다. 쿼리가 cancel 뒤에도 끝나지
    /// 않으면 부르는 쪽이 다시 보내야 한다.
    fn cancel(self) -> impl Future<Output = Result<(), CancelError>> + Send;
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Could not send the cancel request: {message}")]
pub struct CancelError {
    pub message: String,
}

/// 연결 실패. 화면이 다음 행동을 고를 수 있게 나눈다. 어느 variant에도 비밀번호는 들어가지 않는다.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConnectError {
    #[error("Could not reach the server: {message}")]
    Unreachable { message: String },
    #[error("The server did not respond in time")]
    Timeout,
    #[error("The server does not support SSL")]
    TlsNotSupported,
    #[error("Could not verify the server certificate: {message}")]
    Certificate { message: String },
    #[error("A password is required")]
    PasswordRequired,
    #[error("Authentication failed: {message}")]
    AuthFailed { message: String },
    #[error("The server refused the connection ({code}): {message}")]
    Database { code: String, message: String },
    #[error("Connection failed: {message}")]
    Other { message: String },
}

/// 터널 명령을 실행하고 포트를 확인한다.
pub trait TunnelRunner: Send + Sync + 'static {
    type Process: TunnelProcess;

    /// host:port에 TCP로 붙으면 true. 붙은 연결은 바로 닫는다. 500ms 안에 답이 없으면 false.
    fn is_open(&self, host: &str, port: u16) -> impl Future<Output = bool> + Send;
    /// 명령을 `dir`에서 사용자 login shell로 새 process group에서 실행한다.
    fn spawn(&self, command: &str, dir: &Path) -> Result<Self::Process, SpawnError>;
}

/// 실행한 터널 명령 하나.
pub trait TunnelProcess: Send + 'static {
    /// 지금의 자손 프로세스를 기억한다. 포트가 열렸을 때 부른다. 그 뒤 `wait`는 기억한 자손이
    /// 끝나는 것도 끝으로 본다(ssh를 띄우고 ssh가 죽어도 살아 남는 터널 CLI가 있다).
    fn mark_ready(&mut self);
    /// 실행한 프로세스나 `mark_ready`가 기억한 자손 가운데 하나가 끝날 때까지 기다린다. 실행한
    /// 프로세스의 exit code를 돌려준다(아직 살아 있거나 signal로 끝났으면 `None`). cancel-safe다.
    /// 이미 끝났으면 바로 같은 값을 돌려준다.
    fn wait(&mut self) -> impl Future<Output = Option<i32>> + Send;
    /// 지금까지 받은 stderr의 끝 16 KiB.
    fn output(&self) -> String;
    /// process group, 지금의 자손 tree, 기억한 자손에 SIGTERM을 보내고 2초 뒤에도 남아 있으면
    /// SIGKILL을 보낸다. 모두 끝날 때까지 기다린다.
    fn stop(self) -> impl Future<Output = ()> + Send;
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Could not run the tunnel command: {message}")]
pub struct SpawnError {
    pub message: String,
}

/// SQL text를 문장 단위로 나눈다. 문장이 문법에 맞는지는 보지 않는다.
pub trait StatementSplitter: Send + Sync {
    /// 문장마다 span을 돌려준다. 빈 문장은 만들지 않는다. span은 start 오름차순이고 서로 겹치지 않는다.
    fn split(&self, sql: &str) -> Result<Vec<StatementSpan>, SplitError>;

    /// 문장 안의 `:name`, start 오름차순. 나눌 수 없는 text면 `SplitError`다.
    fn parameters(&self, sql: &str) -> Result<Vec<ParameterSpan>, SplitError>;
}

/// 실행할 문장 하나가 위험한지 본다.
pub trait StatementInspector: Send + Sync {
    /// 첫 위험 하나. 문장을 읽을 수 없으면 `None`이다(서버가 오류를 낸다).
    fn danger(&self, sql: &str) -> Option<Danger>;
}

/// 따옴표, `$$`, 주석이 닫히지 않아 문장 경계를 알 수 없다.
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("Could not split the statements: {message}")]
pub struct SplitError {
    pub message: String,
}

/// 최근에 연 프로젝트 하나.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentProject {
    pub dir: PathBuf,
    pub name: String,
    /// Unix 초
    pub opened_at: i64,
}

/// 쿼리 기록에 새로 더할 항목.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewHistoryEntry {
    /// 접속 이름
    pub connection: String,
    pub sql: String,
    /// Unix ms. 실행을 시작한 때
    pub executed_at: i64,
    pub elapsed_micros: i64,
}

/// 저장된 쿼리 기록 하나.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEntry {
    pub id: i64,
    pub connection: String,
    pub sql: String,
    /// Unix ms. 실행을 시작한 때
    pub executed_at: i64,
    pub elapsed_micros: i64,
}

/// 앱 내부 저장소. 최근 프로젝트, 프로젝트별 탭 snapshot, 프로젝트별 쿼리 기록을 둔다. 프로젝트 디렉토리 밖의,
/// 사용자가 읽지 않는 상태다.
pub trait AppStore: Send + Sync {
    /// 최근 것부터 최대 10개.
    fn recent_projects(&self) -> Result<Vec<RecentProject>, StoreError>;
    /// 있으면 시각을 바꾸고, 10개를 넘으면 오래된 것을 지운다.
    fn record_project(&self, project: &RecentProject) -> Result<(), StoreError>;
    /// `dir` 프로젝트의 탭 snapshot. 화면이 만든 JSON text이고 여기서는 열어 보지 않는다.
    fn load_workspace(&self, dir: &Path) -> Result<Option<String>, StoreError>;
    fn save_workspace(&self, dir: &Path, snapshot: &str, saved_at: i64) -> Result<(), StoreError>;
    /// `dir` 프로젝트의 기록에 더한다. 그 프로젝트의 기록이 10,000개를 넘으면 오래된 것부터 지운다.
    fn record_query(&self, dir: &Path, entry: &NewHistoryEntry) -> Result<(), StoreError>;
    /// `words`가 모두 SQL에 든 기록을 최근 것(id 큰 것)부터 `limit`개. `words`가 비면 전부다.
    /// 영문 대소문자는 구분하지 않고 `%`, `_`, `\`는 글자 그대로 찾는다.
    fn search_history(
        &self,
        dir: &Path,
        words: &[String],
        limit: usize,
    ) -> Result<Vec<HistoryEntry>, StoreError>;
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Could not use the app database: {message}")]
pub struct StoreError {
    pub message: String,
}
