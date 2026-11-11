//! `application`의 단위 test가 쓰는 가짜 port 구현.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use super::{
    ConnectError, Connector, DbConnection, PasswordKey, PasswordStore, PasswordStoreError,
    ProjectError, ProjectStore,
};
use crate::domain::{ConnectionProfile, Password, Project, TxStatus};

pub(crate) fn profile(name: &str) -> ConnectionProfile {
    ConnectionProfile::fixture(name)
}

/// 등록한 디렉토리만 프로젝트로 읽힌다.
#[derive(Default)]
pub(crate) struct FakeProjects(Mutex<HashMap<PathBuf, Project>>);

impl FakeProjects {
    pub(crate) fn add(&self, dir: &str, connections: &[&str]) {
        let project = Project {
            dir: dir.into(),
            name: dir.trim_start_matches('/').into(),
            connections: connections.iter().map(|name| profile(name)).collect(),
        };
        self.0.lock().unwrap().insert(dir.into(), project);
    }
}

impl ProjectStore for FakeProjects {
    fn load(&self, dir: &Path) -> Result<Project, ProjectError> {
        self.0
            .lock()
            .unwrap()
            .get(dir)
            .cloned()
            .ok_or_else(|| ProjectError::NotFound {
                path: dir.join("chilla.toml"),
            })
    }
}

#[derive(Default)]
pub(crate) struct FakePasswords(Mutex<HashMap<PasswordKey, String>>);

impl PasswordStore for FakePasswords {
    fn get(&self, key: &PasswordKey) -> Result<Option<Password>, PasswordStoreError> {
        Ok(self.0.lock().unwrap().get(key).cloned().map(Password::new))
    }

    fn set(&self, key: &PasswordKey, password: &Password) -> Result<(), PasswordStoreError> {
        let mut entries = self.0.lock().unwrap();
        entries.insert(key.clone(), password.expose().to_string());
        Ok(())
    }

    fn delete(&self, key: &PasswordKey) -> Result<(), PasswordStoreError> {
        self.0.lock().unwrap().remove(key);
        Ok(())
    }
}

/// 가짜 연결 하나를 test가 밖에서 보고 조작하는 손잡이.
#[derive(Clone, Default)]
pub(crate) struct FakeLink {
    closed: Arc<AtomicBool>,
    lost: Arc<AtomicBool>,
}

impl FakeLink {
    /// `DbConnection::close`가 불렸는가.
    pub(crate) fn closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// 연결이 밖에서 끊긴 것처럼 만든다.
    pub(crate) fn lose(&self) {
        self.lost.store(true, Ordering::SeqCst);
    }
}

pub(crate) struct FakeConnection {
    pub(crate) pid: i32,
    pub(crate) link: FakeLink,
}

impl DbConnection for FakeConnection {
    fn backend_pid(&self) -> i32 {
        self.pid
    }

    async fn tx_status(&self) -> TxStatus {
        TxStatus::Idle
    }

    fn is_closed(&self) -> bool {
        self.link.lost.load(Ordering::SeqCst)
    }

    async fn close(self) {
        self.link.closed.store(true, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct ConnectLog {
    /// 연결 요청마다 받은 (접속 이름, 비밀번호).
    requests: Vec<(String, Option<String>)>,
    links: Vec<FakeLink>,
}

/// 항상 연결에 성공하고, 받은 요청과 만든 연결을 기록한다.
#[derive(Clone, Default)]
pub(crate) struct FakeConnector(Arc<Mutex<ConnectLog>>);

impl FakeConnector {
    pub(crate) fn requests(&self) -> Vec<(String, Option<String>)> {
        self.0.lock().unwrap().requests.clone()
    }

    /// 만든 순서대로의 연결.
    pub(crate) fn links(&self) -> Vec<FakeLink> {
        self.0.lock().unwrap().links.clone()
    }
}

impl Connector for FakeConnector {
    type Connection = FakeConnection;

    async fn connect(
        &self,
        profile: &ConnectionProfile,
        password: Option<&Password>,
    ) -> Result<FakeConnection, ConnectError> {
        let mut log = self.0.lock().unwrap();
        let password = password.map(|p| p.expose().to_string());
        log.requests.push((profile.name.clone(), password));
        let link = FakeLink::default();
        log.links.push(link.clone());
        Ok(FakeConnection {
            pid: 1000 + log.links.len() as i32,
            link,
        })
    }
}
