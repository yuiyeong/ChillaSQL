//! 프로젝트 하나와 그 세션들을 다루는 use case. Tauri command가 이것만 부른다.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio::task::JoinSet;

use super::session_actor::{self, QuerySink, SessionHandle};
use super::tunnels::{TunnelError, TunnelLease, TunnelSink, Tunnels};
use super::{
    AppStore, CancelError, ConnectError, Connector, DbConnection, FileError, HistoryEntry,
    NewHistoryEntry, PasswordKey, PasswordStore, PasswordStoreError, ProjectError, ProjectStore,
    QueryError, RecentProject, SplitError, SqlFileStore, StatementInspector, StatementSplitter,
    StoreError, TunnelRunner,
};
use crate::domain::{
    Catalog, ConnectionProfile, Danger, EndResult, FileStamp, ParameterSpan, Password,
    ProfileError, Project, QueryId, QueryLimits, SessionId, SessionInfo, SessionState, SqlFile,
    SqlPath, SqlPathError, StatementSpan, TableDetails, TxEnd, TxMode, TypeInfo, WriteMode,
    render_ddl,
};

/// 쿼리 기록 검색이 돌려주는 최대 개수.
const HISTORY_SEARCH_LIMIT: usize = 200;

/// `test_connection`이 연결해서 알아낸 서버의 정보.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerInfo {
    /// `server_version`의 첫 단어("18.6").
    pub version: String,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum AppError {
    #[error("Open a project first")]
    NoProject,
    #[error("The project was reopened in the meantime. Try again")]
    ProjectChanged,
    #[error("Connection '{name}' is not in the project")]
    UnknownConnection { name: String },
    #[error("Session {} does not exist", id.0)]
    UnknownSession { id: SessionId },
    #[error(transparent)]
    Project(#[from] ProjectError),
    #[error("Connection settings are invalid: {0}")]
    InvalidProfile(#[from] ProfileError),
    #[error(transparent)]
    PasswordStore(#[from] PasswordStoreError),
    #[error(transparent)]
    Connect(#[from] ConnectError),
    #[error(transparent)]
    Tunnel(#[from] TunnelError),
    #[error(transparent)]
    Split(#[from] SplitError),
    #[error("There is no statement to run")]
    EmptyStatement,
    #[error("Only one statement can run at a time. This text has {count}")]
    MultipleStatements { count: usize },
    #[error("Query {} has no more results to fetch", query.0)]
    QueryNotActive { query: QueryId },
    #[error(transparent)]
    Cancel(#[from] CancelError),
    #[error(transparent)]
    File(#[from] FileError),
    #[error("File path is invalid: {0}")]
    InvalidPath(#[from] SqlPathError),
    #[error("Could not read the schema: {0}")]
    Catalog(QueryError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("The app database could not be opened, so recent projects and tabs are not kept")]
    StoreUnavailable,
    #[error("The table or view no longer exists. Refresh the schema")]
    RelationGone,
}

pub struct App<C: Connector, T: TunnelRunner> {
    projects: Arc<dyn ProjectStore>,
    passwords: Arc<dyn PasswordStore>,
    splitter: Arc<dyn StatementSplitter>,
    inspector: Arc<dyn StatementInspector>,
    files: Arc<dyn SqlFileStore>,
    connector: C,
    tunnels: Tunnels<T>,
    state: Mutex<State>,
    /// 접속 이름별 catalog connection. 슬롯 하나가 그 접속의 catalog 읽기를 차례로 한다.
    catalogs: Mutex<HashMap<String, CatalogSlot<C::Connection>>>,
    /// `save_connection`을 하나씩 돌린다. 한 번의 저장이 키체인과 파일에 걸쳐 있어서다.
    save_lock: Mutex<()>,
    /// 세션이 결과를 나눠 보내고 닫는 한도. 설정 파일에서 온다.
    limits: QueryLimits,
    /// 최근 프로젝트와 탭 snapshot. 저장소 파일을 열지 못했으면 `None`이다.
    store: Option<Arc<dyn AppStore>>,
}

/// 스키마 트리와 자동완성의 catalog를 읽는 연결. 탭 세션과 따로 열고, 같은 접속의 터널을 함께 쓴다.
struct CatalogConnection<D> {
    db: D,
    tunnel: Option<TunnelLease>,
}

/// 접속 하나의 catalog connection 자리. 비어 있으면 다음 읽기가 연다.
type CatalogSlot<D> = Arc<Mutex<Option<CatalogConnection<D>>>>;

/// 연결 하나에서 catalog를 읽는 future. `read_catalog`와 `read_table_details`를 같은 길로 부른다.
type CatalogRead<'a, R> = Pin<Box<dyn Future<Output = Result<R, QueryError>> + Send + 'a>>;

/// 열린 세션 하나. 터널을 쓰는 접속이면 그 lease를 함께 갖는다.
struct SessionEntry {
    handle: SessionHandle,
    tunnel: Option<TunnelLease>,
}

#[derive(Default)]
struct State {
    project: Option<Project>,
    sessions: HashMap<SessionId, SessionEntry>,
    last_session_id: u64,
    /// 프로젝트를 새로 열 때마다(`open_project`, `create_project`) 오른다. 같은 디렉토리를 다시 연 것도 구분한다.
    project_generation: u64,
}

impl<C: Connector, T: TunnelRunner> App<C, T> {
    // 구현 선택(port)을 setup 한 곳에서 모두 받는 생성자라 인자가 많다.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        projects: Arc<dyn ProjectStore>,
        passwords: Arc<dyn PasswordStore>,
        splitter: Arc<dyn StatementSplitter>,
        inspector: Arc<dyn StatementInspector>,
        files: Arc<dyn SqlFileStore>,
        connector: C,
        runner: T,
        on_tunnel: TunnelSink,
        limits: QueryLimits,
        store: Option<Arc<dyn AppStore>>,
    ) -> Self {
        Self {
            projects,
            passwords,
            splitter,
            inspector,
            files,
            connector,
            tunnels: Tunnels::new(runner, on_tunnel),
            state: Mutex::new(State::default()),
            catalogs: Mutex::new(HashMap::new()),
            save_lock: Mutex::new(()),
            limits,
            store,
        }
    }

    /// 프로젝트를 연다. 열려 있던 프로젝트의 세션은 모두 닫는다. 읽기에 실패하면 지금
    /// 프로젝트와 세션은 그대로다.
    pub async fn open_project(&self, dir: &Path) -> Result<Project, AppError> {
        let projects = self.projects.clone();
        let dir = dir.to_path_buf();
        let project = blocking(move || projects.load(&dir)).await?;
        self.switch_project(project.clone()).await;
        self.record_recent(&project).await;
        Ok(project)
    }

    /// `chilla.toml`을 만들고 그 프로젝트를 연다. 여는 것은 `open_project`와 같다. 만들지
    /// 못하면 지금 프로젝트와 세션은 그대로다.
    pub async fn create_project(&self, dir: &Path) -> Result<Project, AppError> {
        let projects = self.projects.clone();
        let dir = dir.to_path_buf();
        let project = blocking(move || projects.create(&dir)).await?;
        self.switch_project(project.clone()).await;
        self.record_recent(&project).await;
        Ok(project)
    }

    /// 연 프로젝트를 최근 목록에 올린다. 기록하지 못해도 프로젝트는 열린 채로 둔다.
    async fn record_recent(&self, project: &Project) {
        let Some(store) = self.store.clone() else {
            return;
        };
        let recent = RecentProject {
            dir: project.dir.clone(),
            name: project.name.clone(),
            opened_at: unix_now(),
        };
        if let Err(error) = blocking(move || store.record_project(&recent)).await {
            eprintln!("최근 프로젝트를 기록하지 못했다: {error}");
        }
    }

    /// 최근에 연 프로젝트. 최근 것부터 최대 10개다.
    pub async fn recent_projects(&self) -> Result<Vec<RecentProject>, AppError> {
        let store = self.store()?;
        Ok(blocking(move || store.recent_projects()).await?)
    }

    /// `dir` 프로젝트의 탭 snapshot. 저장한 적이 없으면 `None`이다. `dir`은 열린 프로젝트의
    /// 디렉토리여야 한다(`Project::dir`과 같은 값). 아니면 저장소를 읽지 않고 `ProjectChanged`다.
    pub async fn load_workspace(&self, dir: &Path) -> Result<Option<String>, AppError> {
        let store = self.store()?;
        let dir = self.open_project_dir(dir).await?;
        Ok(blocking(move || store.load_workspace(&dir)).await?)
    }

    /// `dir` 프로젝트의 탭 snapshot을 덮어쓴다. 내용은 화면이 정하고 여기서는 열어 보지 않는다.
    /// `dir`이 열린 프로젝트가 아니면(저장을 시작한 뒤 프로젝트가 바뀐 것이다) 저장소를 쓰지
    /// 않고 `ProjectChanged`를 돌려준다.
    pub async fn save_workspace(&self, dir: &Path, snapshot: String) -> Result<(), AppError> {
        let store = self.store()?;
        let dir = self.open_project_dir(dir).await?;
        let saved_at = unix_now();
        Ok(blocking(move || store.save_workspace(&dir, &snapshot, saved_at)).await?)
    }

    /// `dir` 프로젝트의 쿼리 기록에 더한다. `dir`이 열린 프로젝트가 아니면 저장소를 쓰지 않고
    /// `ProjectChanged`다(`save_workspace`와 같다).
    pub async fn record_query(&self, dir: &Path, entry: NewHistoryEntry) -> Result<(), AppError> {
        let store = self.store()?;
        let dir = self.open_project_dir(dir).await?;
        Ok(blocking(move || store.record_query(&dir, &entry)).await?)
    }

    /// `query`를 공백으로 나눈 단어가 모두 SQL에 든 기록을 최근 것부터 200개. `query`가 비면
    /// 최근 기록이다. `dir`이 열린 프로젝트가 아니면 `ProjectChanged`다.
    pub async fn search_history(
        &self,
        dir: &Path,
        query: &str,
    ) -> Result<Vec<HistoryEntry>, AppError> {
        let store = self.store()?;
        let dir = self.open_project_dir(dir).await?;
        let words: Vec<String> = query.split_whitespace().map(str::to_string).collect();
        Ok(blocking(move || store.search_history(&dir, &words, HISTORY_SEARCH_LIMIT)).await?)
    }

    /// `dir`이 지금 열린 프로젝트의 디렉토리면 그것을 돌려준다.
    async fn open_project_dir(&self, dir: &Path) -> Result<PathBuf, AppError> {
        let open = self.project_dir().await?;
        if open == dir {
            Ok(open)
        } else {
            Err(AppError::ProjectChanged)
        }
    }

    fn store(&self) -> Result<Arc<dyn AppStore>, AppError> {
        self.store.clone().ok_or(AppError::StoreUnavailable)
    }

    /// 열려 있던 프로젝트의 세션을 모두 닫고 `project`로 바꾼다. 세션이 생기기 전이라 lease를 쥔
    /// 쪽이 없는 시작 중 터널과 접속 테스트의 터널도 끈다.
    async fn switch_project(&self, project: Project) {
        let previous = {
            let mut state = self.state.lock().await;
            state.project = Some(project);
            state.project_generation += 1;
            std::mem::take(&mut state.sessions)
        };
        self.close_all(previous).await;
        self.close_all_catalogs().await;
        self.tunnels.stop_all().await;
    }

    /// 접속을 `chilla.toml`에 쓰고 열려 있는 프로젝트에 반영한다. 세션은 그대로 둔다(열려
    /// 있는 세션은 저장 전의 접속 정보로 붙어 있다). 겹친 저장은 차례로 처리한다.
    ///
    /// 같은 이름의 접속이 없었거나 연결 대상이 바뀌면 저장된 비밀번호를 파일을 쓰기 *전에*
    /// 지운다(`test_connection`과 같은 규칙). 새 대상이 파일에 적힌 채 옛 비밀번호가 키체인에
    /// 남으면 다음에 프로젝트를 열 때 옛 비밀번호가 새 대상으로 가기 때문이다. 지우지 못하면
    /// 파일을 쓰지 않는다. `password`가 있으면 파일을 쓴 뒤에 저장한다. 대상이 같고
    /// `password`가 없을 때만 키체인을 건드리지 않는다.
    ///
    /// 쓰는 동안 프로젝트가 다시 열렸으면 열린 프로젝트는 바꾸지 않고 `ProjectChanged`를
    /// 돌려준다. 이미 쓴 파일에 맞춰 `password`는 그 파일의 디렉토리 기준으로 저장한다.
    pub async fn save_connection(
        &self,
        profile: ConnectionProfile,
        password: Option<Password>,
    ) -> Result<Project, AppError> {
        let _saving = self.save_lock.lock().await;
        let (dir, key, profile, target_changed, generation) = {
            let state = self.state.lock().await;
            let project = state.project.as_ref().ok_or(AppError::NoProject)?;
            let profile = profile.resolved_under(&project.dir);
            profile.validate()?;
            // 같은 이름의 접속이 없었어도 키체인에는 그 이름의 비밀번호가 남아 있을 수 있다
            // (`chilla.toml`에서 접속을 손으로 지운 경우).
            let target_changed = project
                .connection(&profile.name)
                .is_none_or(|previous| !previous.same_target(&profile));
            (
                project.dir.clone(),
                password_key(project, &profile.name),
                profile,
                target_changed,
                state.project_generation,
            )
        };

        if target_changed {
            let passwords = self.passwords.clone();
            let key = key.clone();
            blocking(move || passwords.delete(&key)).await?;
        }

        let projects = self.projects.clone();
        let project = blocking(move || projects.save_connection(&dir, &profile)).await?;

        let reloaded = {
            let mut state = self.state.lock().await;
            let reloaded = state.project_generation != generation;
            if !reloaded {
                state.project = Some(project.clone());
            }
            reloaded
        };

        if let Some(password) = password {
            let passwords = self.passwords.clone();
            blocking(move || passwords.set(&key, &password)).await?;
        }
        if reloaded {
            return Err(AppError::ProjectChanged);
        }
        Ok(project)
    }

    /// 프로젝트 디렉토리 아래의 `.sql` 파일. 경로 오름차순이다.
    pub async fn list_sql_files(&self) -> Result<Vec<SqlPath>, AppError> {
        let dir = self.project_dir().await?;
        let files = self.files.clone();
        Ok(blocking(move || files.list(&dir)).await?)
    }

    /// `path`는 프로젝트 디렉토리 기준의 상대 경로다.
    pub async fn read_sql_file(&self, path: &str) -> Result<SqlFile, AppError> {
        let dir = self.project_dir().await?;
        let path = SqlPath::parse(path)?;
        let files = self.files.clone();
        Ok(blocking(move || files.read(&dir, &path)).await?)
    }

    pub async fn write_sql_file(
        &self,
        path: &str,
        text: String,
        mode: WriteMode,
    ) -> Result<FileStamp, AppError> {
        let dir = self.project_dir().await?;
        let path = SqlPath::parse(path)?;
        let files = self.files.clone();
        Ok(blocking(move || files.write(&dir, &path, &text, &mode)).await?)
    }

    async fn project_dir(&self) -> Result<PathBuf, AppError> {
        let state = self.state.lock().await;
        let project = state.project.as_ref().ok_or(AppError::NoProject)?;
        Ok(project.dir.clone())
    }

    pub async fn set_password(&self, connection: &str, password: Password) -> Result<(), AppError> {
        let key = self.saved_connection_key(connection).await?;
        let passwords = self.passwords.clone();
        Ok(blocking(move || passwords.set(&key, &password)).await?)
    }

    pub async fn has_password(&self, connection: &str) -> Result<bool, AppError> {
        let key = self.saved_connection_key(connection).await?;
        Ok(self.stored_password(key).await?.is_some())
    }

    /// 프로젝트에서 이미 빠진 접속의 항목도 지울 수 있다.
    pub async fn delete_password(&self, connection: &str) -> Result<(), AppError> {
        let key = {
            let state = self.state.lock().await;
            let project = state.project.as_ref().ok_or(AppError::NoProject)?;
            password_key(project, connection)
        };
        let passwords = self.passwords.clone();
        Ok(blocking(move || passwords.delete(&key)).await?)
    }

    /// 연결되는지만 확인하고 바로 닫는다. 아직 저장하지 않은 접속도 받는다.
    ///
    /// `password`가 없으면 키체인의 비밀번호를 쓰는데, `profile`이 프로젝트에 저장된 같은
    /// 이름의 접속과 연결 대상이 같을 때만이다. 화면이 보낸 host로 저장된 비밀번호가 나가지
    /// 않게 하려는 것이다. 대상을 바꿔 test하려면 비밀번호를 다시 입력해야 한다.
    pub async fn test_connection(
        &self,
        profile: ConnectionProfile,
        password: Option<Password>,
    ) -> Result<ServerInfo, AppError> {
        let (profile, stored_key, dir) = {
            let state = self.state.lock().await;
            let project = state.project.as_ref().ok_or(AppError::NoProject)?;
            let profile = profile.resolved_under(&project.dir);
            let stored_key = project
                .connection(&profile.name)
                .filter(|saved| saved.same_target(&profile))
                .map(|saved| password_key(project, &saved.name));
            (profile, stored_key, project.dir.clone())
        };
        profile.validate()?;
        let password = match (password, stored_key) {
            (Some(password), _) => Some(password),
            (None, Some(key)) => self.stored_password(key).await?,
            (None, None) => None,
        };
        let tunnel = match profile.tunnel_target(&dir) {
            Some(target) => Some(self.tunnels.start_private(&target).await?),
            None => None,
        };
        let connected = self.connector.connect(&profile, password.as_ref()).await;
        let result = match connected {
            Ok(connection) => {
                let info = ServerInfo {
                    version: connection.server_version().to_string(),
                };
                connection.close().await;
                Ok(info)
            }
            Err(error) => Err(error.into()),
        };
        if let Some(tunnel) = tunnel {
            tunnel.stop().await;
        }
        result
    }

    pub async fn open_session(&self, connection: &str) -> Result<SessionInfo, AppError> {
        let (profile, db, tunnel, generation) = self.connect(connection, false).await?;
        let mut state = self.state.lock().await;
        if state.project_generation != generation {
            // 연결하는 사이에 프로젝트가 다시 열렸다. 그때 세션을 모두 닫았으므로, 그 전의
            // 접속 정보로 붙은 이 연결을 세션으로 남기지 않는다.
            drop(state);
            db.close().await;
            self.release(tunnel).await;
            return Err(AppError::ProjectChanged);
        }
        state.last_session_id += 1;
        let info = SessionInfo {
            id: SessionId(state.last_session_id),
            connection: profile.name,
            backend_pid: db.backend_pid(),
        };
        let handle = session_actor::spawn(db, self.limits);
        state
            .sessions
            .insert(info.id, SessionEntry { handle, tunnel });
        Ok(info)
    }

    /// 저장된 접속으로 DB에 연결한다. 터널을 쓰는 접속이면 터널 lease를 먼저 얻는다. 연결을
    /// 시작할 때의 `project_generation`을 함께 돌려준다. `for_catalog`이면 `statement_timeout`을
    /// 걸지 않는다(사용자가 치는 쿼리를 위한 설정이다. `read_only`는 그대로 건다).
    async fn connect(
        &self,
        connection: &str,
        for_catalog: bool,
    ) -> Result<(ConnectionProfile, C::Connection, Option<TunnelLease>, u64), AppError> {
        let (mut profile, key, generation, target) = {
            let state = self.state.lock().await;
            let project = state.project.as_ref().ok_or(AppError::NoProject)?;
            let profile =
                project
                    .connection(connection)
                    .ok_or_else(|| AppError::UnknownConnection {
                        name: connection.to_string(),
                    })?;
            (
                profile.clone(),
                password_key(project, &profile.name),
                state.project_generation,
                profile.tunnel_target(&project.dir),
            )
        };
        if for_catalog {
            profile.statement_timeout = None;
        }
        let password = self.stored_password(key).await?;

        // 터널과 연결은 오래 걸릴 수 있다. 그동안 lock을 잡지 않는다.
        let tunnel = match target {
            Some(target) => Some(self.tunnels.acquire(&profile.name, &target).await?),
            None => None,
        };
        match self.connector.connect(&profile, password.as_ref()).await {
            Ok(db) => Ok((profile, db, tunnel, generation)),
            Err(error) => {
                self.release(tunnel).await;
                Err(error.into())
            }
        }
    }

    /// 그 접속의 catalog connection(없으면 연다)으로 catalog를 읽는다.
    pub async fn load_catalog(&self, connection: &str) -> Result<Catalog, AppError> {
        self.read_catalog_with(connection, |db| Box::pin(db.read_catalog()))
            .await
    }

    /// 그 접속의 catalog connection으로 relation 하나의 인덱스와 제약조건을 읽는다.
    pub async fn load_table_details(
        &self,
        connection: &str,
        relation: u32,
    ) -> Result<TableDetails, AppError> {
        self.read_catalog_with(connection, |db| Box::pin(db.read_table_details(relation)))
            .await
    }

    /// 그 접속의 catalog connection으로 relation 하나의 생성문을 읽어 조립한다. 지워졌거나 DDL을
    /// 보이지 않는 종류의 relation이면 `RelationGone`이다.
    pub async fn load_ddl(&self, connection: &str, relation: u32) -> Result<String, AppError> {
        let ddl = self
            .read_catalog_with(connection, |db| Box::pin(db.read_ddl(relation)))
            .await?;
        ddl.map(|ddl| render_ddl(&ddl))
            .ok_or(AppError::RelationGone)
    }

    /// 그 접속의 catalog connection으로 결과 컬럼의 type 이름과 category를 읽는다.
    /// 모르는 OID는 결과에 없다.
    pub async fn describe_types(
        &self,
        connection: &str,
        types: Vec<(u32, i32)>,
    ) -> Result<Vec<TypeInfo>, AppError> {
        self.read_catalog_with(connection, |db| {
            // future가 types를 빌리면 `read`가 돌려주는 future의 lifetime이 `db`와 달라진다.
            let types = types.clone();
            Box::pin(async move { db.describe_types(&types).await })
        })
        .await
    }

    /// catalog connection을 닫고 터널 lease를 놓는다. 없으면 아무것도 하지 않는다.
    pub async fn close_catalog(&self, connection: &str) -> Result<(), AppError> {
        let slot = self.catalogs.lock().await.remove(connection);
        if let Some(slot) = slot {
            close_catalog_slot(slot, self.tunnels.clone()).await;
        }
        Ok(())
    }

    /// catalog connection으로 `read`를 부른다. 연결이 끊겨 있었으면 한 번 새로 연결해 다시 부른다.
    /// 서버 오류는 다시 부르지 않는다.
    async fn read_catalog_with<R>(
        &self,
        connection: &str,
        read: impl Fn(&C::Connection) -> CatalogRead<'_, R>,
    ) -> Result<R, AppError> {
        let mut retried = false;
        loop {
            let mut guard = self.catalog_guard(connection).await?;
            let result = match guard.as_ref() {
                Some(open) => read(&open.db).await,
                None => unreachable!("catalog_guard가 연결을 연다"),
            };
            match result {
                Err(QueryError::ConnectionLost { .. }) if !retried => {
                    retried = true;
                    discard_catalog(&mut guard, &self.tunnels).await;
                }
                result => return result.map_err(AppError::Catalog),
            }
        }
    }

    /// 그 접속의 catalog connection 자리를 잡는다. 비어 있으면 연결을 연다.
    async fn catalog_guard(
        &self,
        connection: &str,
    ) -> Result<OwnedMutexGuard<Option<CatalogConnection<C::Connection>>>, AppError> {
        let mut guard = loop {
            let slot = self
                .catalogs
                .lock()
                .await
                .entry(connection.to_string())
                .or_default()
                .clone();
            if let Some(guard) = self.lock_current_slot(connection, slot).await {
                break guard;
            }
        };
        if guard.is_some() {
            return Ok(guard);
        }
        let (_, db, tunnel, generation) = self.connect(connection, true).await?;
        // 연결하는 사이에 프로젝트가 다시 열렸으면 그 전의 접속 정보로 붙은 연결이다.
        // (`close_catalog`가 이 자리를 지웠으면 그 닫기가 이 guard를 기다렸다가 닫는다.)
        if self.state.lock().await.project_generation != generation {
            db.close().await;
            self.release(tunnel).await;
            return Err(AppError::ProjectChanged);
        }
        *guard = Some(CatalogConnection { db, tunnel });
        Ok(guard)
    }

    /// 자리를 잡는다. 기다리는 사이 `close_catalog`가 그 자리를 map에서 뺐으면 None이다. 그 자리에
    /// 연결하면 map에도 닫는 쪽에도 없어 닫히지 않으므로, 부르는 쪽이 map의 새 자리로 다시 잡는다.
    async fn lock_current_slot(
        &self,
        connection: &str,
        slot: CatalogSlot<C::Connection>,
    ) -> Option<OwnedMutexGuard<Option<CatalogConnection<C::Connection>>>> {
        let guard = slot.clone().lock_owned().await;
        let catalogs = self.catalogs.lock().await;
        let current = catalogs
            .get(connection)
            .is_some_and(|current| Arc::ptr_eq(current, &slot));
        current.then_some(guard)
    }

    async fn close_all_catalogs(&self) {
        let slots = std::mem::take(&mut *self.catalogs.lock().await);
        for slot in slots.into_values() {
            close_catalog_slot(slot, self.tunnels.clone()).await;
        }
    }

    async fn release(&self, tunnel: Option<TunnelLease>) {
        if let Some(lease) = tunnel {
            self.tunnels.release(lease).await;
        }
    }

    /// 그 접속의 터널이 시작 중이면 멈춘다. 기다리던 세션 열기는 `Tunnel(Cancelled)`로 끝난다.
    pub async fn cancel_tunnel(&self, connection: &str) -> Result<(), AppError> {
        self.project_dir().await?;
        self.tunnels.cancel(connection);
        Ok(())
    }

    /// 다시 실행하다 멈춘 그 접속의 터널을 처음부터 다시 시작한다.
    pub async fn restart_tunnel(&self, connection: &str) -> Result<(), AppError> {
        self.project_dir().await?;
        self.tunnels.restart(connection);
        Ok(())
    }

    /// 앱을 끝낼 때. 세션을 모두 닫고 앱이 띄운 터널을 모두 끈다.
    pub async fn shutdown(&self) {
        self.close_all_sessions().await;
        self.close_all_catalogs().await;
        self.tunnels.stop_all().await;
    }

    pub async fn session_state(&self, id: SessionId) -> Result<SessionState, AppError> {
        Ok(self.session_handle(id).await?.state().await)
    }

    /// SQL text를 문장 단위로 나눈다. 프로젝트나 세션이 없어도 된다.
    pub fn split_statements(&self, sql: &str) -> Result<Vec<StatementSpan>, AppError> {
        Ok(self.splitter.split(sql)?)
    }

    /// 문장 안의 `:name` 파라미터 위치. 프로젝트나 세션이 없어도 된다.
    pub fn find_parameters(&self, sql: &str) -> Result<Vec<ParameterSpan>, AppError> {
        Ok(self.splitter.parameters(sql)?)
    }

    /// 문장 하나가 위험한지 본다. 첫 위험 하나를 돌려준다. 프로젝트나 세션이 없어도 된다.
    pub fn inspect_statement(&self, sql: &str) -> Option<Danger> {
        self.inspector.danger(sql)
    }

    /// 문장 하나를 세션에 맡기고 바로 돌아온다. 결과는 `sink`로 간다.
    ///
    /// 문장이 하나로 나뉘거나 나눌 수 없을 때(따옴표가 닫히지 않은 경우 등) 받은 `sql`을
    /// 그대로 보낸다. 나눌 수 없는 text의 오류는 서버가 위치와 함께 알려 준다.
    /// `Manual`이고 트랜잭션 밖이면 세션이 그 문장 전에 `BEGIN`을 보낸다.
    ///
    /// `drain`이면 `Columns`와 첫 batch만 보내고 나머지 행은 서버가 끝낸 행 수까지 읽어서 버린다.
    /// 버리려고 cancel하면 문장이 되돌아가므로(`UPDATE … RETURNING` 등) 스스로 cancel하지 않고,
    /// 받다 만 결과를 닫는 시간 제한도 걸지 않는다. `fetch_more`는 아무것도 하지 않는다.
    pub async fn execute(
        &self,
        session: SessionId,
        sql: String,
        mode: TxMode,
        drain: bool,
        sink: QuerySink,
    ) -> Result<QueryId, AppError> {
        let handle = self.session_handle(session).await?;
        if let Ok(spans) = self.splitter.split(&sql) {
            match spans.len() {
                0 => return Err(AppError::EmptyStatement),
                1 => {}
                count => return Err(AppError::MultipleStatements { count }),
            }
        }
        handle
            .execute(sql, mode, drain, sink)
            .await
            .ok_or(AppError::UnknownSession { id: session })
    }

    /// 트랜잭션을 Commit하거나 Rollback한다. 실행 중인 쿼리가 있으면 버린 뒤에 끝낸다.
    pub async fn end_transaction(
        &self,
        session: SessionId,
        end: TxEnd,
    ) -> Result<EndResult, AppError> {
        let handle = self.session_handle(session).await?;
        handle
            .end_transaction(end)
            .await
            .ok_or(AppError::UnknownSession { id: session })
    }

    /// 받다 만 결과의 다음 batch를 읽게 한다. 이미 끝났거나 버려진 쿼리면 아무것도 하지 않는다.
    /// 그 세션이 만든 적 없는 쿼리면 `QueryNotActive`다.
    pub async fn fetch_more(&self, session: SessionId, query: QueryId) -> Result<(), AppError> {
        let handle = self.session_handle(session).await?;
        match handle.fetch_more(query).await {
            Some(true) => Ok(()),
            Some(false) => Err(AppError::QueryNotActive { query }),
            None => Err(AppError::UnknownSession { id: session }),
        }
    }

    /// 쿼리를 멈춘다. cancel 요청이 서버에 닿은 뒤 돌아온다.
    pub async fn cancel_query(&self, session: SessionId, query: QueryId) -> Result<(), AppError> {
        let handle = self.session_handle(session).await?;
        match handle.cancel(query).await {
            Some(result) => Ok(result?),
            None => Err(AppError::UnknownSession { id: session }),
        }
    }

    /// 세션이 답하는 동안 다른 세션을 막지 않도록 handle을 복사해 lock 밖에서 쓰게 한다.
    async fn session_handle(&self, id: SessionId) -> Result<SessionHandle, AppError> {
        let state = self.state.lock().await;
        state
            .sessions
            .get(&id)
            .map(|entry| entry.handle.clone())
            .ok_or(AppError::UnknownSession { id })
    }

    /// 연결이 이미 끊긴(`Lost`) 세션도 정상으로 닫힌다. DB 연결을 닫은 뒤 터널을 놓는다.
    pub async fn close_session(&self, id: SessionId) -> Result<(), AppError> {
        let entry = self.state.lock().await.sessions.remove(&id);
        let entry = entry.ok_or(AppError::UnknownSession { id })?;
        close_entry(entry, self.tunnels.clone()).await;
        Ok(())
    }

    pub async fn close_all_sessions(&self) {
        let sessions = std::mem::take(&mut self.state.lock().await.sessions);
        self.close_all(sessions).await;
    }

    /// 세션들을 한꺼번에 닫는다. 하나가 오래 걸려도 나머지가 기다리지 않는다.
    async fn close_all(&self, sessions: HashMap<SessionId, SessionEntry>) {
        let mut closing: JoinSet<()> = sessions
            .into_values()
            .map(|entry| close_entry(entry, self.tunnels.clone()))
            .collect();
        while closing.join_next().await.is_some() {}
    }

    /// 프로젝트에 있는 접속의 키체인 항목. 없는 이름으로는 항목을 만들지 않는다.
    async fn saved_connection_key(&self, connection: &str) -> Result<PasswordKey, AppError> {
        let state = self.state.lock().await;
        let project = state.project.as_ref().ok_or(AppError::NoProject)?;
        let saved = project
            .connection(connection)
            .ok_or_else(|| AppError::UnknownConnection {
                name: connection.to_string(),
            })?;
        Ok(password_key(project, &saved.name))
    }

    async fn stored_password(
        &self,
        key: PasswordKey,
    ) -> Result<Option<Password>, PasswordStoreError> {
        let passwords = self.passwords.clone();
        blocking(move || passwords.get(&key)).await
    }
}

/// catalog connection 자리를 닫는다. 읽거나 여는 중이면 기다리지 않고 그것이 끝난 뒤 뒤에서 닫는다.
/// 여는 중에는 터널을 20초까지 기다릴 수 있어서, 프로젝트 바꾸기와 종료가 그것을 기다리지 않게 한다.
async fn close_catalog_slot<D: DbConnection, T: TunnelRunner>(
    slot: CatalogSlot<D>,
    tunnels: Tunnels<T>,
) {
    match slot.clone().try_lock_owned() {
        Ok(mut guard) => discard_catalog(&mut guard, &tunnels).await,
        Err(_) => {
            tokio::spawn(async move {
                let mut guard = slot.lock_owned().await;
                discard_catalog(&mut guard, &tunnels).await;
            });
        }
    }
}

/// 자리의 연결을 닫고 터널 lease를 놓는다(DB 연결이 먼저, 기획서 4.2의 순서).
async fn discard_catalog<D: DbConnection, T: TunnelRunner>(
    slot: &mut Option<CatalogConnection<D>>,
    tunnels: &Tunnels<T>,
) {
    if let Some(open) = slot.take() {
        open.db.close().await;
        if let Some(lease) = open.tunnel {
            tunnels.release(lease).await;
        }
    }
}

/// DB 연결을 닫은 뒤 터널을 놓는다(기획서 4.2의 순서).
async fn close_entry<T: TunnelRunner>(entry: SessionEntry, tunnels: Tunnels<T>) {
    entry.handle.close().await;
    if let Some(lease) = entry.tunnel {
        tunnels.release(lease).await;
    }
}

fn password_key(project: &Project, connection: &str) -> PasswordKey {
    PasswordKey {
        project_dir: project.dir.clone(),
        connection: connection.to_string(),
    }
}

/// 지금 시각(Unix 초). 시계가 1970년 앞이면 0이다.
fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64)
}

/// 파일과 키체인과 SQLite 호출은 blocking이다 (키체인은 확인 창이 떠 있는 동안 돌아오지 않는다).
async fn blocking<T, E, F>(call: F) -> Result<T, E>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: Send + 'static,
{
    match tokio::task::spawn_blocking(call).await {
        Ok(result) => result,
        // port 구현이 panic했다. 그대로 올려 보낸다.
        Err(join_error) => std::panic::resume_unwind(join_error.into_panic()),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::sync::mpsc::UnboundedReceiver;

    use super::*;
    use crate::application::test_support::{
        FakeConnector, FakeFiles, FakeInspector, FakePasswords, FakeProjects, FakeRun, FakeRunner,
        FakeSplitter, FakeStore, events_sink, next, profile, sink,
    };
    use crate::application::{
        CancelError, PasswordKey, PasswordStore, ProjectError, QueryError, SplitError, TunnelError,
    };
    use crate::domain::{
        Catalog, ConnectionColor, EndOutcome, EndResult, FileStamp, ProfileError, QueryEvent,
        QueryOutcome, RelationDdl, RelationKind, SessionState, SslMode, StatementSpan,
        TableDetails, TxEnd, TxStatus, TypeInfo, WriteMode,
    };
    use crate::domain::{TunnelEvent, TunnelFailure};

    struct Fixture {
        app: App<FakeConnector, FakeRunner>,
        connector: FakeConnector,
        projects: Arc<FakeProjects>,
        passwords: Arc<FakePasswords>,
        files: Arc<FakeFiles>,
        store: Arc<FakeStore>,
        runner: FakeRunner,
        tunnel_events: Arc<std::sync::Mutex<Vec<TunnelEvent>>>,
    }

    /// `/p`(접속 local, staging)와 `/q`(접속 local)가 프로젝트다.
    fn fixture() -> Fixture {
        fixture_with(QueryLimits::default())
    }

    fn fixture_with(limits: QueryLimits) -> Fixture {
        let projects = Arc::new(FakeProjects::default());
        projects.add("/p", &["local", "staging"]);
        projects.add("/q", &["local"]);
        let passwords = Arc::new(FakePasswords::default());
        let files = Arc::new(FakeFiles::default());
        let store = Arc::new(FakeStore::default());
        let connector = FakeConnector::default();
        let runner = FakeRunner::default();
        let (tunnel_sink, tunnel_events) = events_sink();
        Fixture {
            app: App::new(
                projects.clone(),
                passwords.clone(),
                Arc::new(FakeSplitter),
                Arc::new(FakeInspector),
                files.clone(),
                connector.clone(),
                runner.clone(),
                tunnel_sink,
                limits,
                Some(store.clone()),
            ),
            connector,
            projects,
            passwords,
            files,
            store,
            runner,
            tunnel_events,
        }
    }

    /// `/p`의 `staging`에 터널 명령 `tunnel`(포트 5432)을 단 뒤 연다.
    async fn tunneled() -> Fixture {
        let f = fixture();
        f.projects.set_tunnel("/p", "staging", "tunnel");
        f.app.open_project(Path::new("/p")).await.unwrap();
        f
    }

    fn tunnel_failure(result: Result<SessionInfo, AppError>) -> TunnelFailure {
        match result {
            Err(AppError::Tunnel(TunnelError { failure, .. })) => failure,
            other => panic!("터널 오류가 아니다: {other:?}"),
        }
    }

    async fn opened() -> Fixture {
        let f = fixture();
        f.app.open_project(Path::new("/p")).await.unwrap();
        f
    }

    fn pw(value: &str) -> Password {
        Password::new(value.into())
    }

    fn p() -> &'static Path {
        Path::new("/p")
    }

    const OPEN: SessionState = SessionState::Open { tx: TxStatus::Idle };

    /// `Finished`가 올 때까지 읽고 그 `QueryOutcome`을 돌려준다.
    async fn finished(events: &mut UnboundedReceiver<QueryEvent>) -> QueryOutcome {
        loop {
            if let QueryEvent::Finished { outcome, .. } = next(events).await {
                return outcome;
            }
        }
    }

    async fn session_of(f: &Fixture) -> SessionId {
        f.app.open_session("local").await.unwrap().id
    }

    #[tokio::test]
    async fn open_project_returns_the_project() {
        let f = fixture();
        let project = f.app.open_project(Path::new("/p")).await.unwrap();
        assert_eq!(project.name, "p");
        assert_eq!(project.connections.len(), 2);
    }

    #[tokio::test]
    async fn commands_before_open_project_are_no_project() {
        let f = fixture();
        assert_eq!(f.app.open_session("local").await, Err(AppError::NoProject));
        assert_eq!(
            f.app.set_password("local", pw("x")).await,
            Err(AppError::NoProject)
        );
        assert_eq!(f.app.has_password("local").await, Err(AppError::NoProject));
        assert_eq!(
            f.app.delete_password("local").await,
            Err(AppError::NoProject)
        );
        assert_eq!(
            f.app.test_connection(profile("local"), Some(pw("x"))).await,
            Err(AppError::NoProject)
        );
        assert!(f.connector.requests().is_empty());
    }

    /// 연결하는 동안 같은 디렉토리를 다시 열어도(reload) 그 전의 접속 정보로 붙은 세션은
    /// 등록되지 않는다.
    #[tokio::test]
    async fn session_connected_across_a_project_reload_is_not_registered() {
        let f = Arc::new(opened().await);
        let blocked = f.connector.block().await;
        let opening = tokio::spawn({
            let f = f.clone();
            async move { f.app.open_session("local").await }
        });
        while f.connector.requests().is_empty() {
            tokio::task::yield_now().await;
        }

        f.app.open_project(Path::new("/p")).await.unwrap();
        drop(blocked);

        assert_eq!(opening.await.unwrap(), Err(AppError::ProjectChanged));
        assert!(f.connector.links()[0].closed());
        assert!(f.app.state.lock().await.sessions.is_empty());
    }

    #[tokio::test]
    async fn passwords_belong_to_connections_of_the_project() {
        let f = opened().await;
        let unknown = || AppError::UnknownConnection {
            name: "stagng".into(),
        };
        assert_eq!(f.app.set_password("stagng", pw("x")).await, Err(unknown()));
        assert_eq!(f.app.has_password("stagng").await, Err(unknown()));
        assert!(f.passwords.is_empty());
        // 지우기는 프로젝트에서 빠진 접속의 항목도 치울 수 있어야 한다.
        assert_eq!(f.app.delete_password("stagng").await, Ok(()));
    }

    /// 화면은 chilla.toml에 쓸 값 그대로 보낸다. 파일에서 읽을 때와 같은 경로가 돼야 한다.
    #[tokio::test]
    async fn test_connection_resolves_sslrootcert_against_the_project_dir() {
        let f = opened().await;
        let mut draft = profile("draft");
        draft.sslmode = SslMode::VerifyFull;
        draft.sslrootcert = Some("certs/ca.pem".into());

        f.app.test_connection(draft, Some(pw("x"))).await.unwrap();

        assert_eq!(
            f.connector.profiles()[0].sslrootcert,
            Some("/p/certs/ca.pem".into())
        );
    }

    #[tokio::test]
    async fn open_session_unknown_connection() {
        let f = opened().await;
        assert_eq!(
            f.app.open_session("nope").await,
            Err(AppError::UnknownConnection {
                name: "nope".into()
            })
        );
    }

    #[tokio::test]
    async fn open_session_passes_the_stored_password() {
        let f = opened().await;
        f.app.set_password("local", pw("pw")).await.unwrap();
        assert_eq!(f.app.has_password("local").await, Ok(true));
        assert_eq!(f.app.has_password("staging").await, Ok(false));

        let session = f.app.open_session("local").await.unwrap();
        assert_eq!(session.connection, "local");
        assert_eq!(session.backend_pid, 1001);

        f.app.delete_password("local").await.unwrap();
        assert_eq!(f.app.has_password("local").await, Ok(false));
        f.app.open_session("local").await.unwrap();

        assert_eq!(
            f.connector.requests(),
            [
                ("local".to_string(), Some("pw".to_string())),
                ("local".to_string(), None)
            ]
        );
    }

    #[tokio::test]
    async fn passwords_are_stored_under_the_project_dir_and_connection() {
        let f = opened().await;
        f.app.set_password("local", pw("pw")).await.unwrap();
        let key = PasswordKey {
            project_dir: "/p".into(),
            connection: "local".into(),
        };
        assert_eq!(f.passwords.get(&key).unwrap().unwrap().expose(), "pw");
    }

    #[tokio::test]
    async fn sessions_get_distinct_ids() {
        let f = opened().await;
        let a = f.app.open_session("local").await.unwrap();
        let b = f.app.open_session("local").await.unwrap();
        assert_ne!(a.id, b.id);
        assert_eq!(f.app.session_state(a.id).await, Ok(OPEN));
        assert_eq!(f.app.session_state(b.id).await, Ok(OPEN));
    }

    #[tokio::test]
    async fn close_session_closes_only_that_session() {
        let f = opened().await;
        let a = f.app.open_session("local").await.unwrap();
        let b = f.app.open_session("local").await.unwrap();

        f.app.close_session(a.id).await.unwrap();

        let links = f.connector.links();
        assert!(links[0].closed());
        assert!(!links[1].closed());
        assert_eq!(
            f.app.session_state(a.id).await,
            Err(AppError::UnknownSession { id: a.id })
        );
        assert_eq!(
            f.app.close_session(a.id).await,
            Err(AppError::UnknownSession { id: a.id })
        );
        assert_eq!(f.app.session_state(b.id).await, Ok(OPEN));
    }

    #[tokio::test]
    async fn lost_session_reports_lost_and_still_closes() {
        let f = opened().await;
        let session = f.app.open_session("local").await.unwrap();
        f.connector.links()[0].lose();

        assert_eq!(
            f.app.session_state(session.id).await,
            Ok(SessionState::Lost)
        );
        assert_eq!(f.app.close_session(session.id).await, Ok(()));
        assert_eq!(
            f.app.session_state(session.id).await,
            Err(AppError::UnknownSession { id: session.id })
        );
    }

    #[tokio::test]
    async fn opening_another_project_closes_sessions() {
        let f = opened().await;
        let a = f.app.open_session("local").await.unwrap();
        f.app.open_session("staging").await.unwrap();

        // 읽지 못한 프로젝트는 지금 프로젝트와 세션을 건드리지 않는다.
        let error = f.app.open_project(Path::new("/nowhere")).await.unwrap_err();
        assert!(matches!(
            error,
            AppError::Project(ProjectError::NotFound { .. })
        ));
        assert_eq!(f.app.session_state(a.id).await, Ok(OPEN));

        f.app.open_project(Path::new("/q")).await.unwrap();
        assert!(f.connector.links().iter().all(|link| link.closed()));
        assert_eq!(
            f.app.session_state(a.id).await,
            Err(AppError::UnknownSession { id: a.id })
        );
        // /q 에는 staging이 없다.
        assert_eq!(
            f.app.open_session("staging").await,
            Err(AppError::UnknownConnection {
                name: "staging".into()
            })
        );
    }

    #[tokio::test]
    async fn close_all_sessions_closes_everything() {
        let f = opened().await;
        let a = f.app.open_session("local").await.unwrap();
        f.app.open_session("staging").await.unwrap();

        f.app.close_all_sessions().await;

        assert!(f.connector.links().iter().all(|link| link.closed()));
        assert_eq!(
            f.app.session_state(a.id).await,
            Err(AppError::UnknownSession { id: a.id })
        );
    }

    #[tokio::test]
    async fn test_connection_does_not_register_a_session() {
        let f = opened().await;
        // 아직 저장하지 않은 접속도 test할 수 있다.
        let draft = profile("draft");

        assert_eq!(
            f.app.test_connection(draft, Some(pw("typed"))).await,
            Ok(ServerInfo {
                version: "18.6".into()
            })
        );

        assert_eq!(
            f.connector.requests(),
            [("draft".to_string(), Some("typed".to_string()))]
        );
        assert!(f.connector.links()[0].closed());
        assert!(f.app.state.lock().await.sessions.is_empty());
    }

    #[tokio::test]
    async fn test_connection_rejects_an_invalid_profile_without_connecting() {
        let f = opened().await;
        let mut invalid = profile("local");
        invalid.port = 0;
        assert_eq!(
            f.app.test_connection(invalid, Some(pw("x"))).await,
            Err(AppError::InvalidProfile(ProfileError::ZeroPort))
        );
        assert!(f.connector.requests().is_empty());
    }

    /// 화면이 저장된 접속의 이름에 다른 host를 붙여 보내도 키체인의 비밀번호가 그 host로
    /// 가면 안 된다.
    #[tokio::test]
    async fn test_connection_keeps_the_stored_password_from_a_different_target() {
        let f = opened().await;
        f.app.set_password("local", pw("stored")).await.unwrap();

        let changes: [fn(&mut ConnectionProfile); 6] = [
            |p| p.host = "evil.example".into(),
            |p| p.port = 6543,
            |p| p.database = "other".into(),
            |p| p.user = "other".into(),
            |p| p.sslmode = SslMode::Require,
            |p| p.tunnel = Some("ssh -L 5432:evil.example:5432 jump".into()),
        ];
        for change in changes {
            let mut draft = profile("local");
            change(&mut draft);
            f.app.test_connection(draft, None).await.unwrap();
        }
        let mut with_root_cert = profile("local");
        with_root_cert.sslmode = SslMode::VerifyFull;
        with_root_cert.sslrootcert = Some("/tmp/ca.pem".into());
        f.app.test_connection(with_root_cert, None).await.unwrap();

        let sent: Vec<Option<String>> = f
            .connector
            .requests()
            .into_iter()
            .map(|(_, password)| password)
            .collect();
        assert_eq!(sent, vec![None; 7]);
    }

    #[tokio::test]
    async fn test_connection_uses_the_stored_password_when_only_the_color_differs() {
        let f = opened().await;
        f.app.set_password("local", pw("stored")).await.unwrap();
        let mut draft = profile("local");
        draft.color = Some(ConnectionColor::Red);

        f.app.test_connection(draft, None).await.unwrap();

        assert_eq!(
            f.connector.requests(),
            [("local".to_string(), Some("stored".to_string()))]
        );
    }

    #[tokio::test]
    async fn test_connection_uses_the_stored_password_when_only_session_settings_differ() {
        let f = opened().await;
        f.app.set_password("local", pw("stored")).await.unwrap();
        let mut draft = profile("local");
        draft.read_only = true;
        draft.statement_timeout = Some(Duration::from_secs(30));

        f.app.test_connection(draft, None).await.unwrap();

        assert_eq!(
            f.connector.requests(),
            [("local".to_string(), Some("stored".to_string()))]
        );
    }

    #[tokio::test]
    async fn test_connection_falls_back_to_the_stored_password() {
        let f = opened().await;
        f.app.set_password("local", pw("stored")).await.unwrap();

        f.app.test_connection(profile("local"), None).await.unwrap();
        f.app
            .test_connection(profile("staging"), None)
            .await
            .unwrap();

        assert_eq!(
            f.connector.requests(),
            [
                ("local".to_string(), Some("stored".to_string())),
                ("staging".to_string(), None)
            ]
        );
    }

    #[tokio::test]
    async fn execute_refuses_empty_and_multiple_statements() {
        let f = opened().await;
        let session = session_of(&f).await;

        assert_eq!(
            f.app
                .execute(session, "  ".into(), TxMode::Auto, false, sink().0)
                .await,
            Err(AppError::EmptyStatement)
        );
        assert_eq!(
            f.app
                .execute(
                    session,
                    "SELECT 1; SELECT 2".into(),
                    TxMode::Auto,
                    false,
                    sink().0
                )
                .await,
            Err(AppError::MultipleStatements { count: 2 })
        );
        assert!(f.connector.links()[0].sent().is_empty());
    }

    #[tokio::test]
    async fn execute_sends_the_text_as_given() {
        let f = opened().await;
        let session = session_of(&f).await;
        let (sink, mut events) = sink();

        let id = f
            .app
            .execute(session, " SELECT 1 ;\n".into(), TxMode::Auto, false, sink)
            .await;

        assert_eq!(id, Ok(QueryId(1)));
        finished(&mut events).await;
        assert_eq!(f.connector.links()[0].sent(), [" SELECT 1 ;\n"]);
    }

    #[tokio::test]
    async fn execute_sends_text_that_cannot_be_split() {
        let f = opened().await;
        let session = session_of(&f).await;
        let (sink, mut events) = sink();

        let id = f
            .app
            .execute(session, "SELECT 'open".into(), TxMode::Auto, false, sink)
            .await;

        assert!(id.is_ok());
        finished(&mut events).await;
        assert_eq!(f.connector.links()[0].sent(), ["SELECT 'open"]);
    }

    #[tokio::test]
    async fn query_use_cases_on_an_unknown_session() {
        let f = opened().await;
        let unknown = SessionId(99);
        let error = || AppError::UnknownSession { id: unknown };

        assert_eq!(
            f.app
                .execute(unknown, "SELECT 1".into(), TxMode::Auto, false, sink().0)
                .await,
            Err(error())
        );
        assert_eq!(f.app.fetch_more(unknown, QueryId(1)).await, Err(error()));
        assert_eq!(f.app.cancel_query(unknown, QueryId(1)).await, Err(error()));
        assert_eq!(
            f.app.end_transaction(unknown, TxEnd::Rollback).await,
            Err(error())
        );
    }

    #[tokio::test]
    async fn manual_execute_and_end_transaction_reach_the_session() {
        let f = opened().await;
        let session = session_of(&f).await;
        let (sink, mut events) = sink();

        f.app
            .execute(session, "SELECT 1".into(), TxMode::Manual, false, sink)
            .await
            .unwrap();
        finished(&mut events).await;
        let ended = f.app.end_transaction(session, TxEnd::Commit).await;

        assert_eq!(
            ended,
            Ok(EndResult {
                outcome: EndOutcome::Ended,
                tx: Some(TxStatus::Idle),
            })
        );
        assert_eq!(
            f.connector.links()[0].sent(),
            ["BEGIN; SAVEPOINT chilla_statement", "SELECT 1", "COMMIT"]
        );
    }

    #[tokio::test]
    async fn sessions_use_the_given_limits() {
        let f = fixture_with(QueryLimits {
            retained_rows: 1000,
            ..QueryLimits::default()
        });
        f.app.open_project(Path::new("/p")).await.unwrap();
        let session = session_of(&f).await;
        let feed = f.connector.links()[0].expect_query();
        feed.rows(0..1500);
        feed.complete(1500);
        let (sink, mut events) = sink();
        let query = f
            .app
            .execute(session, "SELECT n".into(), TxMode::Auto, false, sink)
            .await
            .unwrap();

        let mut retained_from = Vec::new();
        loop {
            match next(&mut events).await {
                QueryEvent::Rows(rows) => {
                    retained_from.push(rows.retained_from);
                    f.app.fetch_more(session, query).await.unwrap();
                }
                QueryEvent::Finished { .. } => break,
                _ => {}
            }
        }
        assert_eq!(retained_from, [0, 0, 500]);
    }

    #[tokio::test]
    async fn fetch_more_is_refused_only_for_an_unknown_query() {
        let f = opened().await;
        let session = session_of(&f).await;
        let (sink, mut events) = sink();
        let query = f
            .app
            .execute(session, "SELECT 1".into(), TxMode::Auto, false, sink)
            .await
            .unwrap();
        finished(&mut events).await;

        assert_eq!(f.app.fetch_more(session, query).await, Ok(()));
        assert_eq!(
            f.app.fetch_more(session, QueryId(99)).await,
            Err(AppError::QueryNotActive { query: QueryId(99) })
        );
    }

    #[tokio::test]
    async fn cancel_failure_is_reported() {
        let f = opened().await;
        let session = session_of(&f).await;
        let link = &f.connector.links()[0];
        link.fail_cancels();
        link.expect_query();
        let query = f
            .app
            .execute(
                session,
                "SELECT pg_sleep(10)".into(),
                TxMode::Auto,
                false,
                sink().0,
            )
            .await
            .unwrap();

        assert!(matches!(
            f.app.cancel_query(session, query).await,
            Err(AppError::Cancel(CancelError { .. }))
        ));
    }

    #[tokio::test]
    async fn split_statements_needs_no_project() {
        let f = fixture();

        assert_eq!(
            f.app.split_statements("a; b"),
            Ok(vec![
                StatementSpan { start: 0, end: 1 },
                StatementSpan { start: 2, end: 4 }
            ])
        );
        assert!(matches!(
            f.app.split_statements("a 'b"),
            Err(AppError::Split(SplitError { .. }))
        ));
    }

    #[tokio::test]
    async fn find_parameters_needs_no_project() {
        let f = fixture();

        assert_eq!(
            f.app.find_parameters("a = :id"),
            Ok(vec![ParameterSpan {
                name: "id".into(),
                start: 4,
                end: 7
            }])
        );
        assert!(matches!(
            f.app.find_parameters("a 'b"),
            Err(AppError::Split(SplitError { .. }))
        ));
    }

    #[tokio::test]
    async fn inspect_statement_works_without_a_project() {
        let f = fixture();

        assert_eq!(
            f.app.inspect_statement("DROP users"),
            Some(Danger::Drop {
                kind: "TABLE".into(),
                names: vec!["users".into()]
            })
        );
        assert_eq!(
            f.app.inspect_statement("TRUNCATE users"),
            Some(Danger::Truncate {
                tables: vec!["users".into()]
            })
        );
        assert_eq!(f.app.inspect_statement("SELECT 1"), None);
    }

    #[tokio::test]
    async fn create_project_opens_it_and_closes_sessions() {
        let f = opened().await;
        session_of(&f).await;

        let created = f.app.create_project(Path::new("/new")).await.unwrap();

        assert_eq!(created.name, "new");
        assert!(f.connector.links()[0].closed());
        // /new에는 접속이 없다.
        assert_eq!(
            f.app.open_session("local").await,
            Err(AppError::UnknownConnection {
                name: "local".into()
            })
        );
        // 이미 chilla.toml이 있는 디렉토리는 만들지 못하고, 지금 프로젝트는 그대로다.
        assert_eq!(
            f.app.create_project(Path::new("/p")).await,
            Err(AppError::Project(ProjectError::AlreadyExists {
                path: "/p/chilla.toml".into()
            }))
        );
        let state = f.app.state.lock().await;
        assert_eq!(state.project.as_ref().unwrap().name, "new");
    }

    #[tokio::test]
    async fn save_connection_updates_the_project_and_keeps_sessions() {
        let f = opened().await;
        let session = session_of(&f).await;
        let mut moved = profile("local");
        moved.host = "db.internal".into();

        let project = f.app.save_connection(moved, None).await.unwrap();

        assert_eq!(project.connection("local").unwrap().host, "db.internal");
        assert_eq!(f.app.session_state(session).await, Ok(OPEN));
        f.app.open_session("local").await.unwrap();
        assert_eq!(f.connector.profiles()[1].host, "db.internal");

        f.app
            .save_connection(profile("analytics"), None)
            .await
            .unwrap();
        assert!(f.app.open_session("analytics").await.is_ok());
    }

    #[tokio::test]
    async fn save_connection_stores_the_typed_password() {
        let f = opened().await;

        f.app
            .save_connection(profile("local"), Some(pw("typed")))
            .await
            .unwrap();

        f.app.open_session("local").await.unwrap();
        assert_eq!(
            f.connector.requests(),
            [("local".to_string(), Some("typed".to_string()))]
        );
    }

    /// 저장된 비밀번호가 바뀐 대상으로 가면 안 된다.
    #[tokio::test]
    async fn save_connection_forgets_the_password_when_the_target_changes() {
        let changes: [fn(&mut ConnectionProfile); 6] = [
            |p| p.host = "evil.example".into(),
            |p| p.port = 6543,
            |p| p.database = "other".into(),
            |p| p.user = "other".into(),
            |p| p.sslmode = SslMode::Require,
            |p| p.tunnel = Some("ssh -L 5432:evil.example:5432 jump".into()),
        ];
        for change in changes {
            let f = opened().await;
            f.app.set_password("local", pw("stored")).await.unwrap();
            let mut moved = profile("local");
            change(&mut moved);

            f.app.save_connection(moved, None).await.unwrap();

            assert_eq!(f.app.has_password("local").await, Ok(false));
        }

        let f = opened().await;
        f.app.set_password("local", pw("stored")).await.unwrap();
        let mut recolored = profile("local");
        recolored.color = Some(ConnectionColor::Red);
        f.app.save_connection(recolored, None).await.unwrap();
        assert_eq!(f.app.has_password("local").await, Ok(true));

        let mut moved = profile("local");
        moved.host = "db.internal".into();
        f.app.save_connection(moved, Some(pw("new"))).await.unwrap();
        let key = PasswordKey {
            project_dir: "/p".into(),
            connection: "local".into(),
        };
        assert_eq!(f.passwords.get(&key).unwrap().unwrap().expose(), "new");
    }

    /// 비밀번호를 지우지 못했는데 새 대상을 파일에 쓰면, 다음에 프로젝트를 열 때 옛 비밀번호가
    /// 새 대상으로 간다.
    #[tokio::test]
    async fn save_connection_does_not_write_when_the_stored_password_cannot_be_forgotten() {
        let f = opened().await;
        f.app.set_password("local", pw("stored")).await.unwrap();
        f.passwords.fail_deletes(true);
        let mut moved = profile("local");
        moved.host = "db.internal".into();

        let result = f.app.save_connection(moved, None).await;

        assert!(matches!(result, Err(AppError::PasswordStore(_))));
        assert!(f.projects.saved().is_empty());
    }

    #[tokio::test]
    async fn save_connection_forgets_the_old_password_even_when_storing_the_new_one_fails() {
        let f = opened().await;
        f.app.set_password("local", pw("stored")).await.unwrap();
        f.passwords.fail_sets(true);
        let mut moved = profile("local");
        moved.host = "db.internal".into();

        let result = f.app.save_connection(moved, Some(pw("new"))).await;

        assert!(matches!(result, Err(AppError::PasswordStore(_))));
        assert_eq!(f.projects.saved().len(), 1);
        f.passwords.fail_sets(false);
        assert_eq!(f.app.has_password("local").await, Ok(false));
    }

    /// 쓰는 동안 프로젝트가 다시 열려도 그 프로젝트를 덮지 않는다. 입력한 비밀번호는 쓴
    /// 파일의 디렉토리 기준으로 저장한다.
    #[tokio::test]
    async fn save_connection_across_a_project_reload_keeps_the_new_project() {
        let f = Arc::new(opened().await);
        let blocked = f.projects.block().await;
        let saving = tokio::spawn({
            let f = f.clone();
            async move {
                f.app
                    .save_connection(profile("local"), Some(pw("typed")))
                    .await
            }
        });
        while f.projects.saved().is_empty() {
            tokio::task::yield_now().await;
        }

        f.app.open_project(Path::new("/q")).await.unwrap();
        drop(blocked);

        let error = saving.await.unwrap().unwrap_err();
        assert_eq!(error, AppError::ProjectChanged);
        // 연결이 아니라 저장 중에도 나는 오류다.
        assert_eq!(
            error.to_string(),
            "The project was reopened in the meantime. Try again"
        );
        let opened_dir = f
            .app
            .state
            .lock()
            .await
            .project
            .as_ref()
            .unwrap()
            .dir
            .clone();
        assert_eq!(opened_dir, Path::new("/q"));
        let key = PasswordKey {
            project_dir: "/p".into(),
            connection: "local".into(),
        };
        assert_eq!(f.passwords.get(&key).unwrap().unwrap().expose(), "typed");
    }

    #[tokio::test]
    async fn concurrent_saves_run_one_at_a_time() {
        let f = Arc::new(opened().await);
        let blocked = f.projects.block().await;
        let save = |name: &'static str| {
            let f = f.clone();
            tokio::spawn(async move { f.app.save_connection(profile(name), None).await })
        };
        let first = save("analytics");
        while f.projects.saved().is_empty() {
            tokio::task::yield_now().await;
        }

        let second = save("reporting");
        // 두 번째 save가 store까지 갈 시간을 준다.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(f.projects.saved().len(), 1);
        drop(blocked);

        assert!(first.await.unwrap().is_ok());
        assert!(second.await.unwrap().is_ok());
        let names: Vec<_> = f
            .projects
            .saved()
            .into_iter()
            .map(|(_, p)| p.name)
            .collect();
        assert_eq!(names, ["analytics", "reporting"]);
    }

    /// 남아 있던 비밀번호가 없으면 저장 뒤에도 키체인은 비어 있다.
    #[tokio::test]
    async fn save_connection_of_a_new_connection_leaves_no_password() {
        let f = opened().await;

        f.app
            .save_connection(profile("analytics"), None)
            .await
            .unwrap();

        assert!(f.passwords.is_empty());
    }

    /// `chilla.toml`에서 접속을 손으로 지운 뒤 같은 이름으로 다시 추가하면, 키체인에 남아
    /// 있던 옛 비밀번호가 새 대상으로 가면 안 된다.
    #[tokio::test]
    async fn save_connection_of_a_new_name_forgets_a_leftover_password() {
        let key = PasswordKey {
            project_dir: "/p".into(),
            connection: "analytics".into(),
        };

        let f = opened().await;
        f.passwords.set(&key, &pw("leftover")).unwrap();
        f.app
            .save_connection(profile("analytics"), None)
            .await
            .unwrap();
        assert!(f.passwords.get(&key).unwrap().is_none());

        let f = opened().await;
        f.passwords.set(&key, &pw("leftover")).unwrap();
        f.app
            .save_connection(profile("analytics"), Some(pw("new")))
            .await
            .unwrap();
        assert_eq!(f.passwords.get(&key).unwrap().unwrap().expose(), "new");
    }

    #[tokio::test]
    async fn save_connection_rejects_an_invalid_profile_without_writing() {
        let f = fixture();
        assert_eq!(
            f.app.save_connection(profile("local"), None).await,
            Err(AppError::NoProject)
        );

        f.app.open_project(Path::new("/p")).await.unwrap();
        let mut invalid = profile("local");
        invalid.port = 0;
        assert_eq!(
            f.app.save_connection(invalid, Some(pw("x"))).await,
            Err(AppError::InvalidProfile(ProfileError::ZeroPort))
        );
        assert!(f.projects.saved().is_empty());
        assert!(f.passwords.is_empty());
    }

    #[tokio::test]
    async fn file_use_cases_need_a_project_and_a_valid_path() {
        let f = fixture();
        assert_eq!(f.app.list_sql_files().await, Err(AppError::NoProject));
        assert_eq!(f.app.read_sql_file("a.sql").await, Err(AppError::NoProject));
        assert_eq!(
            f.app
                .write_sql_file("a.sql", "x".into(), WriteMode::Create)
                .await,
            Err(AppError::NoProject)
        );

        f.app.open_project(Path::new("/p")).await.unwrap();
        assert!(matches!(
            f.app.read_sql_file("../a.sql").await,
            Err(AppError::InvalidPath(_))
        ));
        assert!(matches!(
            f.app
                .write_sql_file("/etc/a.sql", "x".into(), WriteMode::Overwrite)
                .await,
            Err(AppError::InvalidPath(_))
        ));
        assert!(f.files.calls().is_empty());
    }

    #[tokio::test]
    async fn file_use_cases_pass_the_project_dir() {
        let f = opened().await;

        let file = f.app.read_sql_file("queries/a.sql").await.unwrap();
        let stamp = f
            .app
            .write_sql_file("b.sql", "SELECT 1".into(), WriteMode::Create)
            .await
            .unwrap();

        assert_eq!(file.stamp, FileStamp("s".into()));
        assert_eq!(stamp, FileStamp("s".into()));
        assert_eq!(f.app.list_sql_files().await, Ok(vec![]));
        assert_eq!(
            f.files.calls(),
            [
                ("/p".into(), "queries/a.sql".to_string()),
                ("/p".into(), "b.sql".to_string())
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn open_session_starts_the_tunnel_first() {
        let f = tunneled().await;
        f.runner.script_at(
            "tunnel",
            "localhost",
            5432,
            vec![FakeRun::OpensAfter(Duration::from_secs(1))],
        );

        f.app.open_session("staging").await.unwrap();
        assert_eq!(f.runner.spawned(), ["tunnel"]);
        assert_eq!(f.connector.requests().len(), 1);

        f.app.open_session("local").await.unwrap();
        assert_eq!(f.runner.spawned(), ["tunnel"]);
    }

    #[tokio::test(start_paused = true)]
    async fn close_session_closes_the_database_before_the_tunnel() {
        let f = tunneled().await;
        let log = Arc::new(std::sync::Mutex::new(Vec::new()));
        f.connector.log_to(log.clone());
        f.runner.log_to(log.clone());
        let session = f.app.open_session("staging").await.unwrap();

        f.app.close_session(session.id).await.unwrap();

        assert_eq!(*log.lock().unwrap(), ["db close", "tunnel stop"]);
    }

    #[tokio::test(start_paused = true)]
    async fn sessions_of_one_connection_share_the_tunnel() {
        let f = tunneled().await;
        let a = f.app.open_session("staging").await.unwrap();
        let b = f.app.open_session("staging").await.unwrap();
        assert_eq!(f.runner.spawned().len(), 1);

        f.app.close_session(a.id).await.unwrap();
        assert_eq!(f.runner.running(), 1);
        f.app.close_session(b.id).await.unwrap();
        assert_eq!(f.runner.running(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn tunnel_failure_is_an_app_error_and_opens_no_connection() {
        let f = tunneled().await;
        f.runner.script_at(
            "tunnel",
            "localhost",
            5432,
            vec![FakeRun::ExitsAfter(Duration::ZERO, Some(1), "nope")],
        );

        let failure = tunnel_failure(f.app.open_session("staging").await);

        assert_eq!(
            failure,
            TunnelFailure::Exited {
                code: Some(1),
                output: "nope".into()
            }
        );
        assert!(f.connector.requests().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn connect_failure_releases_the_tunnel() {
        let f = tunneled().await;
        f.connector.fail_next(ConnectError::AuthFailed {
            message: "no".into(),
        });

        let result = f.app.open_session("staging").await;

        assert!(
            matches!(
                result,
                Err(AppError::Connect(ConnectError::AuthFailed { .. }))
            ),
            "{result:?}"
        );
        assert_eq!(f.runner.running(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn switching_project_while_the_tunnel_starts_stops_it() {
        let f = Arc::new(tunneled().await);
        f.runner
            .script_at("tunnel", "localhost", 5432, vec![FakeRun::Hangs("")]);
        let opening = {
            let f = f.clone();
            tokio::spawn(async move { f.app.open_session("staging").await })
        };
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(f.runner.running(), 1);

        f.app.open_project(Path::new("/q")).await.unwrap();

        let result = opening.await.unwrap();
        assert!(
            matches!(result, Err(AppError::ProjectChanged | AppError::Tunnel(_))),
            "{result:?}"
        );
        assert_eq!(f.runner.running(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn test_connection_runs_a_private_tunnel_and_stops_it() {
        let f = opened().await;
        let unsaved = ConnectionProfile {
            tunnel: Some("tunnel-test".into()),
            ..profile("new")
        };

        f.app.test_connection(unsaved.clone(), None).await.unwrap();
        assert_eq!(f.runner.spawned(), ["tunnel-test"]);
        assert_eq!(f.runner.running(), 0);
        assert!(f.tunnel_events.lock().unwrap().is_empty());

        f.connector.fail_next(ConnectError::Timeout);
        let result = f.app.test_connection(unsaved, None).await;
        assert_eq!(result, Err(AppError::Connect(ConnectError::Timeout)));
        assert_eq!(f.runner.running(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn test_connection_reports_a_tunnel_failure() {
        let f = opened().await;
        f.runner.script_at(
            "tunnel-test",
            "localhost",
            5432,
            vec![FakeRun::Hangs("Unauthorized")],
        );
        let unsaved = ConnectionProfile {
            tunnel: Some("tunnel-test".into()),
            tunnel_timeout: Some(Duration::from_secs(5)),
            ..profile("new")
        };

        let result = f.app.test_connection(unsaved, None).await;

        assert!(
            matches!(
                &result,
                Err(AppError::Tunnel(TunnelError {
                    failure: TunnelFailure::Timeout { secs: 5, .. },
                    ..
                }))
            ),
            "{result:?}"
        );
        assert!(f.connector.requests().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_tunnel_stops_a_starting_tunnel() {
        let f = Arc::new(tunneled().await);
        f.runner
            .script_at("tunnel", "localhost", 5432, vec![FakeRun::Hangs("")]);
        let opening = {
            let f = f.clone();
            tokio::spawn(async move { f.app.open_session("staging").await })
        };
        tokio::time::sleep(Duration::from_secs(1)).await;

        f.app.cancel_tunnel("staging").await.unwrap();

        assert_eq!(
            tunnel_failure(opening.await.unwrap()),
            TunnelFailure::Cancelled
        );
        assert_eq!(f.runner.running(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn restart_tunnel_without_a_project_is_no_project() {
        let f = fixture();
        assert_eq!(
            f.app.restart_tunnel("staging").await,
            Err(AppError::NoProject)
        );
        assert_eq!(
            f.app.cancel_tunnel("staging").await,
            Err(AppError::NoProject)
        );
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_closes_sessions_and_tunnels() {
        let f = Arc::new(tunneled().await);
        f.projects.set_tunnel("/p", "local", "hang");
        f.app.open_project(Path::new("/p")).await.unwrap();
        f.runner
            .script_at("hang", "localhost", 5432, vec![FakeRun::Hangs("")]);
        f.runner.script_at("tunnel", "localhost", 5432, vec![]);
        let session = f.app.open_session("staging").await.unwrap();
        // staging 터널이 5432를 열었으므로 local은 그 포트를 쓰는 External이 된다. 시작 중인 터널을
        // 만들려고 포트를 닫는다.
        f.runner.set_open("localhost", 5432, false);
        let hanging = {
            let f = f.clone();
            tokio::spawn(async move { f.app.open_session("local").await })
        };
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert_eq!(f.runner.running(), 2);

        f.app.shutdown().await;

        assert_eq!(f.runner.running(), 0);
        assert!(hanging.await.unwrap().is_err());
        assert_eq!(
            f.app.session_state(session.id).await,
            Err(AppError::UnknownSession { id: session.id })
        );
    }

    // --- catalog connection (M7) ---

    fn sample_catalog() -> Catalog {
        Catalog {
            search_path: vec!["public".into()],
            schemas: vec!["public".into()],
            ..Catalog::default()
        }
    }

    fn lost() -> QueryError {
        QueryError::ConnectionLost {
            message: "끊겼다".into(),
        }
    }

    #[tokio::test]
    async fn load_catalog_opens_one_connection_and_reuses_it() {
        let f = opened().await;
        f.connector.set_catalog(sample_catalog());
        let details = TableDetails {
            indexes: vec![],
            constraints: vec![],
        };
        f.connector.set_details(7, details.clone());

        assert_eq!(f.app.load_catalog("local").await, Ok(sample_catalog()));
        assert_eq!(f.app.load_catalog("local").await, Ok(sample_catalog()));
        assert_eq!(f.app.load_table_details("local", 7).await, Ok(details));

        assert_eq!(f.connector.requests().len(), 1);
        assert_eq!(f.connector.catalog_reads(), 2);
    }

    /// statement_timeout은 사용자가 치는 쿼리를 위한 것이다. catalog 읽기에는 read_only만 건다.
    #[tokio::test]
    async fn catalog_connection_has_no_statement_timeout() {
        let f = opened().await;
        let mut draft = profile("local");
        draft.read_only = true;
        draft.statement_timeout = Some(Duration::from_secs(30));
        f.app.save_connection(draft, None).await.unwrap();

        f.app.open_session("local").await.unwrap();
        f.app.load_catalog("local").await.unwrap();

        let profiles = f.connector.profiles();
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].statement_timeout, Some(Duration::from_secs(30)));
        assert_eq!(profiles[1].statement_timeout, None);
        assert!(profiles[1].read_only);
    }

    #[tokio::test]
    async fn describe_types_uses_the_catalog_connection() {
        let f = opened().await;
        f.connector.set_catalog(sample_catalog());
        let integer = TypeInfo {
            oid: 23,
            modifier: -1,
            name: "integer".into(),
            category: 'N',
        };
        f.connector.set_types(vec![integer.clone()]);

        f.app.load_catalog("local").await.unwrap();
        let types = f.app.describe_types("local", vec![(23, -1), (0, -1)]).await;

        assert_eq!(types, Ok(vec![integer]));
        assert_eq!(f.connector.requests().len(), 1);
    }

    fn users_ddl() -> RelationDdl {
        RelationDdl {
            name: "public.users".into(),
            kind: RelationKind::Table,
            unlogged: false,
            columns: vec![],
            constraints: vec![],
            inherits: vec![],
            partition_of: None,
            partition_by: None,
            options: vec![],
            view_definition: None,
            indexes: vec![],
            triggers: vec![],
            comment: Some("'people'".into()),
            column_comments: vec![],
        }
    }

    #[tokio::test]
    async fn load_ddl_renders_what_the_catalog_connection_read() {
        let f = opened().await;
        f.connector.set_ddl(7, users_ddl());

        f.app.load_catalog("local").await.unwrap();
        let ddl = f.app.load_ddl("local", 7).await;

        assert_eq!(
            ddl,
            Ok("CREATE TABLE public.users ();
COMMENT ON TABLE public.users IS 'people';"
                .into())
        );
        assert_eq!(f.connector.requests().len(), 1);
    }

    #[tokio::test]
    async fn load_ddl_of_a_missing_relation_is_relation_gone() {
        let f = opened().await;
        assert_eq!(
            f.app.load_ddl("local", 7).await,
            Err(AppError::RelationGone)
        );
    }

    #[tokio::test]
    async fn load_ddl_reconnects_once_when_the_catalog_connection_was_lost() {
        let f = opened().await;
        f.connector.set_ddl(7, users_ddl());
        f.connector.fail_next_catalog(lost());

        assert!(f.app.load_ddl("local", 7).await.is_ok());
        assert_eq!(f.connector.requests().len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn catalog_connection_shares_the_tunnel_with_sessions() {
        let f = tunneled().await;
        let session = f.app.open_session("staging").await.unwrap();
        f.app.load_catalog("staging").await.unwrap();
        assert_eq!(f.runner.spawned().len(), 1);

        f.app.close_session(session.id).await.unwrap();
        assert_eq!(f.runner.running(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn closing_the_catalog_releases_the_tunnel() {
        let f = tunneled().await;
        let session = f.app.open_session("staging").await.unwrap();
        f.app.load_catalog("staging").await.unwrap();
        f.app.close_session(session.id).await.unwrap();

        f.app.close_catalog("staging").await.unwrap();

        assert_eq!(f.runner.running(), 0);
        assert!(f.connector.links()[1].closed());
    }

    #[tokio::test]
    async fn reconnects_once_when_the_catalog_connection_was_lost() {
        let f = opened().await;
        f.connector.set_catalog(sample_catalog());
        f.app.load_catalog("local").await.unwrap();
        f.connector.links()[0].lose();

        assert_eq!(f.app.load_catalog("local").await, Ok(sample_catalog()));
        assert_eq!(f.connector.requests().len(), 2);
        assert!(f.connector.links()[0].closed());
    }

    #[tokio::test]
    async fn a_second_loss_is_reported() {
        let f = opened().await;
        f.connector.fail_next_catalog(lost());
        f.connector.fail_next_catalog(lost());

        assert!(matches!(
            f.app.load_catalog("local").await,
            Err(AppError::Catalog(QueryError::ConnectionLost { .. }))
        ));
    }

    #[tokio::test]
    async fn server_errors_are_not_retried() {
        let f = opened().await;
        let error = QueryError::Server(crate::application::test_support::server_error("42501"));
        f.connector.fail_next_catalog(error.clone());

        assert_eq!(
            f.app.load_catalog("local").await,
            Err(AppError::Catalog(error))
        );
        assert_eq!(f.connector.requests().len(), 1);
    }

    #[tokio::test]
    async fn switching_projects_closes_catalog_connections() {
        let f = opened().await;
        f.app.load_catalog("local").await.unwrap();

        f.app.open_project(Path::new("/q")).await.unwrap();

        assert!(f.connector.links()[0].closed());
    }

    #[tokio::test]
    async fn shutdown_closes_catalog_connections() {
        let f = opened().await;
        f.app.load_catalog("local").await.unwrap();

        f.app.shutdown().await;

        assert!(f.connector.links()[0].closed());
    }

    #[tokio::test]
    async fn catalog_connected_across_a_project_reload_is_closed() {
        let f = Arc::new(opened().await);
        let blocked = f.connector.block().await;
        let loading = tokio::spawn({
            let f = f.clone();
            async move { f.app.load_catalog("local").await }
        });
        while f.connector.requests().is_empty() {
            tokio::task::yield_now().await;
        }

        f.app.open_project(Path::new("/p")).await.unwrap();
        drop(blocked);

        assert_eq!(loading.await.unwrap(), Err(AppError::ProjectChanged));
        assert!(f.connector.links()[0].closed());
    }

    /// `close_catalog`가 map에서 뺀 자리를 잡았으면 그 자리에 연결하지 않는다. 연결하면 map에도 닫는
    /// 쪽에도 없는 연결과 터널 lease가 남는다.
    #[tokio::test]
    async fn a_slot_removed_by_close_is_not_reused() {
        let f = opened().await;
        f.app.load_catalog("local").await.unwrap();
        let removed = f.app.catalogs.lock().await.get("local").unwrap().clone();
        f.app.close_catalog("local").await.unwrap();

        let guard = f.app.lock_current_slot("local", removed).await;

        assert!(guard.is_none());
        assert_eq!(f.connector.requests().len(), 1);
    }

    #[tokio::test]
    async fn close_catalog_without_a_connection_is_ok() {
        let f = opened().await;
        assert_eq!(f.app.close_catalog("local").await, Ok(()));
    }

    #[tokio::test]
    async fn load_catalog_of_an_unknown_connection_fails() {
        let f = opened().await;
        assert_eq!(
            f.app.load_catalog("nope").await,
            Err(AppError::UnknownConnection {
                name: "nope".into()
            })
        );
    }

    #[tokio::test]
    async fn opening_a_project_records_it() {
        let f = fixture();
        f.app.open_project(Path::new("/p")).await.unwrap();
        f.app.create_project(Path::new("/new")).await.unwrap();

        let recent = f.app.recent_projects().await.unwrap();

        let dirs: Vec<_> = recent.iter().map(|r| r.dir.to_str().unwrap()).collect();
        assert_eq!(dirs, ["/new", "/p"]);
        assert_eq!(recent[0].name, "new");
        assert!(recent[0].opened_at > 1_700_000_000, "Unix 초다");
    }

    #[tokio::test]
    async fn a_failed_open_does_not_record_it() {
        let f = fixture();

        assert!(f.app.open_project(Path::new("/nope")).await.is_err());
        assert!(f.app.create_project(Path::new("/p")).await.is_err());

        assert_eq!(f.app.recent_projects().await, Ok(Vec::new()));
    }

    #[tokio::test]
    async fn a_failed_record_does_not_fail_the_open() {
        let f = fixture();
        f.store.fail(true);

        let project = f.app.open_project(Path::new("/p")).await.unwrap();
        let created = f.app.create_project(Path::new("/new")).await.unwrap();

        assert_eq!((project.name.as_str(), created.name.as_str()), ("p", "new"));
        f.store.fail(false);
        assert_eq!(f.app.recent_projects().await, Ok(Vec::new()));
    }

    #[tokio::test]
    async fn workspace_is_saved_and_loaded_for_the_open_project() {
        let f = opened().await;
        assert_eq!(f.app.load_workspace(p()).await, Ok(None));

        f.app
            .save_workspace(p(), "{\"tabs\":[]}".into())
            .await
            .unwrap();

        assert_eq!(
            f.app.load_workspace(p()).await,
            Ok(Some("{\"tabs\":[]}".into()))
        );
        let (snapshot, saved_at) = f.store.workspace("/p").unwrap();
        assert_eq!(snapshot, "{\"tabs\":[]}");
        assert!(saved_at > 1_700_000_000, "Unix 초다");
        f.app.open_project(Path::new("/q")).await.unwrap();
        assert_eq!(f.app.load_workspace(Path::new("/q")).await, Ok(None));
    }

    #[tokio::test]
    async fn a_save_for_another_project_is_rejected() {
        let f = opened().await;
        f.app.open_project(Path::new("/q")).await.unwrap();
        let q = Path::new("/q");
        f.app.save_workspace(q, "{\"q\":1}".into()).await.unwrap();

        // 프로젝트 p를 닫기 전에 시작된 저장이 q가 열린 뒤에 도착했다.
        assert_eq!(
            f.app.save_workspace(p(), "{\"p\":1}".into()).await,
            Err(AppError::ProjectChanged)
        );

        assert_eq!(f.store.workspace("/p"), None);
        assert_eq!(f.store.workspace("/q").unwrap().0, "{\"q\":1}");
    }

    #[tokio::test]
    async fn a_load_for_another_project_is_rejected() {
        let f = opened().await;
        f.app.save_workspace(p(), "{}".into()).await.unwrap();
        f.app.open_project(Path::new("/q")).await.unwrap();

        assert_eq!(
            f.app.load_workspace(p()).await,
            Err(AppError::ProjectChanged)
        );
    }

    #[tokio::test]
    async fn save_workspace_needs_a_project() {
        let f = fixture();
        assert_eq!(
            f.app.save_workspace(p(), "{}".into()).await,
            Err(AppError::NoProject)
        );
        assert_eq!(f.app.load_workspace(p()).await, Err(AppError::NoProject));
        assert!(f.store.workspace("/p").is_none());
    }

    fn new_entry(sql: &str) -> NewHistoryEntry {
        NewHistoryEntry {
            connection: "local".into(),
            sql: sql.into(),
            executed_at: 1_700_000_000_000,
            elapsed_micros: 42,
        }
    }

    #[tokio::test]
    async fn history_needs_the_open_project() {
        let f = opened().await;
        f.app
            .record_query(p(), new_entry("select 1"))
            .await
            .unwrap();
        assert_eq!(f.app.search_history(p(), "select").await.unwrap().len(), 1);

        // 다른 dir이면 저장소를 읽거나 쓰지 않고 ProjectChanged다.
        let q = Path::new("/q");
        assert_eq!(
            f.app.record_query(q, new_entry("select 2")).await,
            Err(AppError::ProjectChanged)
        );
        assert_eq!(
            f.app.search_history(q, "").await,
            Err(AppError::ProjectChanged)
        );
        assert_eq!(f.store.history_len("/q"), 0);
    }

    #[tokio::test]
    async fn history_search_splits_the_query_into_words() {
        let f = opened().await;
        for sql in ["select email from users", "select name from users"] {
            f.app.record_query(p(), new_entry(sql)).await.unwrap();
        }

        let found = f.app.search_history(p(), "  users   email ").await.unwrap();

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].sql, "select email from users");
        assert_eq!(f.app.search_history(p(), "   ").await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn search_history_limits_to_200() {
        let f = opened().await;
        for i in 0..201 {
            f.app
                .record_query(p(), new_entry(&format!("select {i}")))
                .await
                .unwrap();
        }

        let found = f.app.search_history(p(), "").await.unwrap();

        assert_eq!(found.len(), 200);
        assert_eq!(found[0].sql, "select 200");
    }

    #[tokio::test]
    async fn history_fails_without_a_project_or_when_the_store_breaks() {
        let f = fixture();
        assert_eq!(
            f.app.record_query(p(), new_entry("select 1")).await,
            Err(AppError::NoProject)
        );
        let f = opened().await;
        f.store.fail(true);
        assert!(matches!(
            f.app.search_history(p(), "").await,
            Err(AppError::Store(_))
        ));
    }

    #[tokio::test]
    async fn store_failures_reach_the_caller() {
        let f = opened().await;
        f.store.fail(true);

        assert!(matches!(
            f.app.recent_projects().await,
            Err(AppError::Store(_))
        ));
        assert!(matches!(
            f.app.load_workspace(p()).await,
            Err(AppError::Store(_))
        ));
        assert!(matches!(
            f.app.save_workspace(p(), "{}".into()).await,
            Err(AppError::Store(_))
        ));
    }

    #[tokio::test]
    async fn without_a_store_the_store_calls_fail_but_projects_open() {
        let projects = Arc::new(FakeProjects::default());
        projects.add("/p", &["local"]);
        let (tunnel_sink, _events) = events_sink();
        let app = App::new(
            projects,
            Arc::new(FakePasswords::default()),
            Arc::new(FakeSplitter),
            Arc::new(FakeInspector),
            Arc::new(FakeFiles::default()),
            FakeConnector::default(),
            FakeRunner::default(),
            tunnel_sink,
            QueryLimits::default(),
            None,
        );

        app.open_project(Path::new("/p")).await.unwrap();

        assert_eq!(app.recent_projects().await, Err(AppError::StoreUnavailable));
        assert_eq!(
            app.load_workspace(p()).await,
            Err(AppError::StoreUnavailable)
        );
        assert_eq!(
            app.save_workspace(p(), "{}".into()).await,
            Err(AppError::StoreUnavailable)
        );
    }
}
