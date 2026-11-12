//! 프로젝트 하나와 그 세션들을 다루는 use case. Tauri command가 이것만 부른다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio::task::JoinSet;

use super::session_actor::{self, QuerySink, SessionHandle};
use super::{
    CancelError, ConnectError, Connector, DbConnection, FileError, PasswordKey, PasswordStore,
    PasswordStoreError, ProjectError, ProjectStore, SplitError, SqlFileStore, StatementSplitter,
};
use crate::domain::{
    ConnectionProfile, FileStamp, Password, ProfileError, Project, QueryId, QueryLimits, SessionId,
    SessionInfo, SessionState, SqlFile, SqlPath, SqlPathError, StatementSpan, WriteMode,
};

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum AppError {
    #[error("프로젝트를 먼저 열어야 합니다")]
    NoProject,
    #[error("그동안 프로젝트가 다시 열렸습니다. 다시 시도하세요")]
    ProjectChanged,
    #[error("접속 '{name}'이 프로젝트에 없습니다")]
    UnknownConnection { name: String },
    #[error("세션 {}이 없습니다", id.0)]
    UnknownSession { id: SessionId },
    #[error(transparent)]
    Project(#[from] ProjectError),
    #[error("접속 정보가 잘못됐습니다: {0}")]
    InvalidProfile(#[from] ProfileError),
    #[error(transparent)]
    PasswordStore(#[from] PasswordStoreError),
    #[error(transparent)]
    Connect(#[from] ConnectError),
    #[error(transparent)]
    Split(#[from] SplitError),
    #[error("실행할 문장이 없습니다")]
    EmptyStatement,
    #[error("문장이 {count}개입니다. 한 번에 문장 하나만 실행할 수 있습니다")]
    MultipleStatements { count: usize },
    #[error("쿼리 {}은 더 가져올 결과가 없습니다", query.0)]
    QueryNotActive { query: QueryId },
    #[error(transparent)]
    Cancel(#[from] CancelError),
    #[error(transparent)]
    File(#[from] FileError),
    #[error("파일 경로가 잘못됐습니다: {0}")]
    InvalidPath(#[from] SqlPathError),
}

pub struct App<C: Connector> {
    projects: Arc<dyn ProjectStore>,
    passwords: Arc<dyn PasswordStore>,
    splitter: Arc<dyn StatementSplitter>,
    files: Arc<dyn SqlFileStore>,
    connector: C,
    state: Mutex<State>,
    /// `save_connection`을 하나씩 돌린다. 한 번의 저장이 키체인과 파일에 걸쳐 있어서다.
    save_lock: Mutex<()>,
}

#[derive(Default)]
struct State {
    project: Option<Project>,
    sessions: HashMap<SessionId, SessionHandle>,
    last_session_id: u64,
    /// 프로젝트를 새로 열 때마다(`open_project`, `create_project`) 오른다. 같은 디렉토리를 다시 연 것도 구분한다.
    project_generation: u64,
}

impl<C: Connector> App<C> {
    pub fn new(
        projects: Arc<dyn ProjectStore>,
        passwords: Arc<dyn PasswordStore>,
        splitter: Arc<dyn StatementSplitter>,
        files: Arc<dyn SqlFileStore>,
        connector: C,
    ) -> Self {
        Self {
            projects,
            passwords,
            splitter,
            files,
            connector,
            state: Mutex::new(State::default()),
            save_lock: Mutex::new(()),
        }
    }

    /// 프로젝트를 연다. 열려 있던 프로젝트의 세션은 모두 닫는다. 읽기에 실패하면 지금
    /// 프로젝트와 세션은 그대로다.
    pub async fn open_project(&self, dir: &Path) -> Result<Project, AppError> {
        let projects = self.projects.clone();
        let dir = dir.to_path_buf();
        let project = blocking(move || projects.load(&dir)).await?;
        self.switch_project(project.clone()).await;
        Ok(project)
    }

    /// `chilla.toml`을 만들고 그 프로젝트를 연다. 여는 것은 `open_project`와 같다. 만들지
    /// 못하면 지금 프로젝트와 세션은 그대로다.
    pub async fn create_project(&self, dir: &Path) -> Result<Project, AppError> {
        let projects = self.projects.clone();
        let dir = dir.to_path_buf();
        let project = blocking(move || projects.create(&dir)).await?;
        self.switch_project(project.clone()).await;
        Ok(project)
    }

    /// 열려 있던 프로젝트의 세션을 모두 닫고 `project`로 바꾼다.
    async fn switch_project(&self, project: Project) {
        let previous = {
            let mut state = self.state.lock().await;
            state.project = Some(project);
            state.project_generation += 1;
            std::mem::take(&mut state.sessions)
        };
        close_all(previous).await;
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
    ) -> Result<(), AppError> {
        let (profile, stored_key) = {
            let state = self.state.lock().await;
            let project = state.project.as_ref().ok_or(AppError::NoProject)?;
            let profile = profile.resolved_under(&project.dir);
            let stored_key = project
                .connection(&profile.name)
                .filter(|saved| saved.same_target(&profile))
                .map(|saved| password_key(project, &saved.name));
            (profile, stored_key)
        };
        profile.validate()?;
        let password = match (password, stored_key) {
            (Some(password), _) => Some(password),
            (None, Some(key)) => self.stored_password(key).await?,
            (None, None) => None,
        };
        let connection = self.connector.connect(&profile, password.as_ref()).await?;
        connection.close().await;
        Ok(())
    }

    pub async fn open_session(&self, connection: &str) -> Result<SessionInfo, AppError> {
        let (profile, key, generation) = {
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
            )
        };
        let password = self.stored_password(key).await?;

        // 연결은 오래 걸릴 수 있다. 그동안 lock을 잡지 않는다.
        let db = self.connector.connect(&profile, password.as_ref()).await?;

        let mut state = self.state.lock().await;
        if state.project_generation != generation {
            // 연결하는 사이에 프로젝트가 다시 열렸다. 그때 세션을 모두 닫았으므로, 그 전의
            // 접속 정보로 붙은 이 연결을 세션으로 남기지 않는다.
            drop(state);
            db.close().await;
            return Err(AppError::ProjectChanged);
        }
        state.last_session_id += 1;
        let info = SessionInfo {
            id: SessionId(state.last_session_id),
            connection: profile.name,
            backend_pid: db.backend_pid(),
        };
        state
            .sessions
            .insert(info.id, session_actor::spawn(db, QueryLimits::default()));
        Ok(info)
    }

    pub async fn session_state(&self, id: SessionId) -> Result<SessionState, AppError> {
        Ok(self.session_handle(id).await?.state().await)
    }

    /// SQL text를 문장 단위로 나눈다. 프로젝트나 세션이 없어도 된다.
    pub fn split_statements(&self, sql: &str) -> Result<Vec<StatementSpan>, AppError> {
        Ok(self.splitter.split(sql)?)
    }

    /// 문장 하나를 세션에 맡기고 바로 돌아온다. 결과는 `sink`로 간다.
    ///
    /// 문장이 하나로 나뉘거나 나눌 수 없을 때(따옴표가 닫히지 않은 경우 등) 받은 `sql`을
    /// 그대로 보낸다. 나눌 수 없는 text의 오류는 서버가 위치와 함께 알려 준다.
    pub async fn execute(
        &self,
        session: SessionId,
        sql: String,
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
            .execute(sql, sink)
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
            .cloned()
            .ok_or(AppError::UnknownSession { id })
    }

    /// 연결이 이미 끊긴(`Lost`) 세션도 정상으로 닫힌다.
    pub async fn close_session(&self, id: SessionId) -> Result<(), AppError> {
        let handle = self.state.lock().await.sessions.remove(&id);
        handle.ok_or(AppError::UnknownSession { id })?.close().await;
        Ok(())
    }

    pub async fn close_all_sessions(&self) {
        let sessions = std::mem::take(&mut self.state.lock().await.sessions);
        close_all(sessions).await;
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

fn password_key(project: &Project, connection: &str) -> PasswordKey {
    PasswordKey {
        project_dir: project.dir.clone(),
        connection: connection.to_string(),
    }
}

/// 세션들을 한꺼번에 닫는다. 하나가 오래 걸려도 나머지가 기다리지 않는다.
async fn close_all(sessions: HashMap<SessionId, SessionHandle>) {
    let mut closing: JoinSet<()> = sessions.into_values().map(SessionHandle::close).collect();
    while closing.join_next().await.is_some() {}
}

/// 파일과 키체인 호출은 blocking이다 (키체인은 확인 창이 떠 있는 동안 돌아오지 않는다).
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

    use tokio::sync::mpsc::UnboundedReceiver;

    use super::*;
    use crate::application::test_support::{
        FakeConnector, FakeFiles, FakePasswords, FakeProjects, FakeSplitter, next, profile, sink,
    };
    use crate::application::{CancelError, PasswordKey, PasswordStore, ProjectError, SplitError};
    use crate::domain::{
        FileStamp, ProfileError, QueryEvent, QueryOutcome, SessionState, SslMode, StatementSpan,
        TxStatus, WriteMode,
    };

    struct Fixture {
        app: App<FakeConnector>,
        connector: FakeConnector,
        projects: Arc<FakeProjects>,
        passwords: Arc<FakePasswords>,
        files: Arc<FakeFiles>,
    }

    /// `/p`(접속 local, staging)와 `/q`(접속 local)가 프로젝트다.
    fn fixture() -> Fixture {
        let projects = Arc::new(FakeProjects::default());
        projects.add("/p", &["local", "staging"]);
        projects.add("/q", &["local"]);
        let passwords = Arc::new(FakePasswords::default());
        let files = Arc::new(FakeFiles::default());
        let connector = FakeConnector::default();
        Fixture {
            app: App::new(
                projects.clone(),
                passwords.clone(),
                Arc::new(FakeSplitter),
                files.clone(),
                connector.clone(),
            ),
            connector,
            projects,
            passwords,
            files,
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
            Ok(())
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
        draft.color = Some("red".into());

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
            f.app.execute(session, "  ".into(), sink().0).await,
            Err(AppError::EmptyStatement)
        );
        assert_eq!(
            f.app
                .execute(session, "SELECT 1; SELECT 2".into(), sink().0)
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

        let id = f.app.execute(session, " SELECT 1 ;\n".into(), sink).await;

        assert_eq!(id, Ok(QueryId(1)));
        finished(&mut events).await;
        assert_eq!(f.connector.links()[0].sent(), [" SELECT 1 ;\n"]);
    }

    #[tokio::test]
    async fn execute_sends_text_that_cannot_be_split() {
        let f = opened().await;
        let session = session_of(&f).await;
        let (sink, mut events) = sink();

        let id = f.app.execute(session, "SELECT 'open".into(), sink).await;

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
            f.app.execute(unknown, "SELECT 1".into(), sink().0).await,
            Err(error())
        );
        assert_eq!(f.app.fetch_more(unknown, QueryId(1)).await, Err(error()));
        assert_eq!(f.app.cancel_query(unknown, QueryId(1)).await, Err(error()));
    }

    #[tokio::test]
    async fn fetch_more_is_refused_only_for_an_unknown_query() {
        let f = opened().await;
        let session = session_of(&f).await;
        let (sink, mut events) = sink();
        let query = f
            .app
            .execute(session, "SELECT 1".into(), sink)
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
            .execute(session, "SELECT pg_sleep(10)".into(), sink().0)
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
        recolored.color = Some("red".into());
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
            "그동안 프로젝트가 다시 열렸습니다. 다시 시도하세요"
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
}
