//! 프로젝트 하나와 그 세션들을 다루는 use case. Tauri command가 이것만 부른다.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::Mutex;

use super::session_actor::{self, SessionHandle};
use super::{
    ConnectError, Connector, DbConnection, PasswordKey, PasswordStore, PasswordStoreError,
    ProjectError, ProjectStore,
};
use crate::domain::{
    ConnectionProfile, Password, ProfileError, Project, SessionId, SessionInfo, SessionState,
};

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum AppError {
    #[error("프로젝트를 먼저 열어야 합니다")]
    NoProject,
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
}

pub struct App<C: Connector> {
    projects: Arc<dyn ProjectStore>,
    passwords: Arc<dyn PasswordStore>,
    connector: C,
    state: Mutex<State>,
    next_session_id: AtomicU64,
}

#[derive(Default)]
struct State {
    project: Option<Project>,
    sessions: HashMap<SessionId, SessionHandle>,
}

impl<C: Connector> App<C> {
    pub fn new(
        projects: Arc<dyn ProjectStore>,
        passwords: Arc<dyn PasswordStore>,
        connector: C,
    ) -> Self {
        Self {
            projects,
            passwords,
            connector,
            state: Mutex::new(State::default()),
            next_session_id: AtomicU64::new(1),
        }
    }

    /// 프로젝트를 연다. 열려 있던 프로젝트의 세션은 모두 닫는다. 읽기에 실패하면 지금
    /// 프로젝트와 세션은 그대로다.
    pub async fn open_project(&self, dir: &Path) -> Result<Project, AppError> {
        let projects = self.projects.clone();
        let dir = dir.to_path_buf();
        let project = blocking(move || projects.load(&dir)).await?;

        let previous = {
            let mut state = self.state.lock().await;
            state.project = Some(project.clone());
            std::mem::take(&mut state.sessions)
        };
        close_all(previous).await;
        Ok(project)
    }

    pub async fn set_password(&self, connection: &str, password: Password) -> Result<(), AppError> {
        let key = self.password_key(connection).await?;
        let passwords = self.passwords.clone();
        Ok(blocking(move || passwords.set(&key, &password)).await?)
    }

    pub async fn has_password(&self, connection: &str) -> Result<bool, AppError> {
        let key = self.password_key(connection).await?;
        Ok(self.stored_password(key).await?.is_some())
    }

    pub async fn delete_password(&self, connection: &str) -> Result<(), AppError> {
        let key = self.password_key(connection).await?;
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
        let stored_key = {
            let state = self.state.lock().await;
            let project = state.project.as_ref().ok_or(AppError::NoProject)?;
            project
                .connection(&profile.name)
                .filter(|saved| saved.same_target(&profile))
                .map(|saved| PasswordKey {
                    project_dir: project.dir.clone(),
                    connection: saved.name.clone(),
                })
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
        let (profile, project_dir) = {
            let state = self.state.lock().await;
            let project = state.project.as_ref().ok_or(AppError::NoProject)?;
            let profile =
                project
                    .connection(connection)
                    .ok_or_else(|| AppError::UnknownConnection {
                        name: connection.to_string(),
                    })?;
            (profile.clone(), project.dir.clone())
        };
        let key = PasswordKey {
            project_dir: project_dir.clone(),
            connection: profile.name.clone(),
        };
        let password = self.stored_password(key).await?;

        // 연결은 오래 걸릴 수 있다. 그동안 lock을 잡지 않는다.
        let db = self.connector.connect(&profile, password.as_ref()).await?;

        let mut state = self.state.lock().await;
        if state.project.as_ref().map(|p| &p.dir) != Some(&project_dir) {
            // 연결하는 사이에 다른 프로젝트가 열렸다.
            drop(state);
            db.close().await;
            return Err(AppError::NoProject);
        }
        let info = SessionInfo {
            id: SessionId(self.next_session_id.fetch_add(1, Ordering::Relaxed)),
            connection: profile.name,
            backend_pid: db.backend_pid(),
        };
        state.sessions.insert(info.id, session_actor::spawn(db));
        Ok(info)
    }

    pub async fn session_state(&self, id: SessionId) -> Result<SessionState, AppError> {
        // 세션이 답하는 동안 다른 세션을 막지 않도록 handle을 복사해 lock 밖에서 묻는다.
        let handle = {
            let state = self.state.lock().await;
            state.sessions.get(&id).cloned()
        };
        match handle {
            Some(handle) => Ok(handle.state().await),
            None => Err(AppError::UnknownSession { id }),
        }
    }

    /// 연결이 이미 끊긴(`Lost`) 세션도 정상으로 닫힌다.
    pub async fn close_session(&self, id: SessionId) -> Result<(), AppError> {
        let handle = self.state.lock().await.sessions.remove(&id);
        match handle {
            Some(handle) => {
                handle.close().await;
                Ok(())
            }
            None => Err(AppError::UnknownSession { id }),
        }
    }

    pub async fn close_all_sessions(&self) {
        let sessions = std::mem::take(&mut self.state.lock().await.sessions);
        close_all(sessions).await;
    }

    async fn password_key(&self, connection: &str) -> Result<PasswordKey, AppError> {
        let state = self.state.lock().await;
        let project = state.project.as_ref().ok_or(AppError::NoProject)?;
        Ok(PasswordKey {
            project_dir: project.dir.clone(),
            connection: connection.to_string(),
        })
    }

    async fn stored_password(
        &self,
        key: PasswordKey,
    ) -> Result<Option<Password>, PasswordStoreError> {
        let passwords = self.passwords.clone();
        blocking(move || passwords.get(&key)).await
    }
}

async fn close_all(sessions: HashMap<SessionId, SessionHandle>) {
    for handle in sessions.into_values() {
        handle.close().await;
    }
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

    use super::*;
    use crate::application::test_support::{FakeConnector, FakePasswords, FakeProjects, profile};
    use crate::application::{PasswordKey, PasswordStore, ProjectError};
    use crate::domain::{ProfileError, SessionState, SslMode, TxStatus};

    struct Fixture {
        app: App<FakeConnector>,
        connector: FakeConnector,
        passwords: Arc<FakePasswords>,
    }

    /// `/p`(접속 local, staging)와 `/q`(접속 local)가 프로젝트다.
    fn fixture() -> Fixture {
        let projects = Arc::new(FakeProjects::default());
        projects.add("/p", &["local", "staging"]);
        projects.add("/q", &["local"]);
        let passwords = Arc::new(FakePasswords::default());
        let connector = FakeConnector::default();
        Fixture {
            app: App::new(projects, passwords.clone(), connector.clone()),
            connector,
            passwords,
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
}
