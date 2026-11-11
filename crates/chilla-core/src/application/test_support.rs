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

impl FakePasswords {
    pub(crate) fn is_empty(&self) -> bool {
        self.0.lock().unwrap().is_empty()
    }
}

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
    lost_during_tx_status: Arc<AtomicBool>,
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

    /// 트랜잭션 상태를 기다리는 동안 연결이 끊기게 한다.
    pub(crate) fn lose_during_tx_status(&self) {
        self.lost_during_tx_status.store(true, Ordering::SeqCst);
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
        if self.link.lost_during_tx_status.load(Ordering::SeqCst) {
            self.link.lose();
        }
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
    /// 연결 요청마다 받은 (접속 정보, 비밀번호).
    requests: Vec<(ConnectionProfile, Option<String>)>,
    links: Vec<FakeLink>,
}

/// 항상 연결에 성공하고, 받은 요청과 만든 연결을 기록한다.
#[derive(Clone, Default)]
pub(crate) struct FakeConnector {
    log: Arc<Mutex<ConnectLog>>,
    gate: Arc<tokio::sync::RwLock<()>>,
}

impl FakeConnector {
    /// 연결 요청마다 받은 (접속 이름, 비밀번호).
    pub(crate) fn requests(&self) -> Vec<(String, Option<String>)> {
        let log = self.log.lock().unwrap();
        let named = log.requests.iter();
        named.map(|(p, pw)| (p.name.clone(), pw.clone())).collect()
    }

    /// 연결 요청마다 받은 접속 정보.
    pub(crate) fn profiles(&self) -> Vec<ConnectionProfile> {
        let log = self.log.lock().unwrap();
        log.requests.iter().map(|(p, _)| p.clone()).collect()
    }

    /// 만든 순서대로의 연결.
    pub(crate) fn links(&self) -> Vec<FakeLink> {
        self.log.lock().unwrap().links.clone()
    }

    /// 돌려준 guard를 drop할 때까지 연결이 끝나지 않게 한다. 요청은 받은 즉시 기록된다.
    pub(crate) async fn block(&self) -> tokio::sync::OwnedRwLockWriteGuard<()> {
        self.gate.clone().write_owned().await
    }
}

impl Connector for FakeConnector {
    type Connection = FakeConnection;

    async fn connect(
        &self,
        profile: &ConnectionProfile,
        password: Option<&Password>,
    ) -> Result<FakeConnection, ConnectError> {
        let password = password.map(|p| p.expose().to_string());
        self.log
            .lock()
            .unwrap()
            .requests
            .push((profile.clone(), password));
        let _open = self.gate.read().await;

        let mut log = self.log.lock().unwrap();
        let link = FakeLink::default();
        log.links.push(link.clone());
        Ok(FakeConnection {
            pid: 1000 + log.links.len() as i32,
            link,
        })
    }
}
