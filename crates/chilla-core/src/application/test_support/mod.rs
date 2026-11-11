//! `application`의 단위 test가 쓰는 가짜 port 구현.

mod connection;

use std::collections::HashMap;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::time::timeout;

pub(crate) use connection::{FakeConnection, FakeLink, server_error};

use super::{
    ConnectError, Connector, PasswordKey, PasswordStore, PasswordStoreError, ProjectError,
    ProjectStore, QuerySink, SplitError, StatementSplitter,
};
use crate::domain::{ConnectionProfile, Password, Project, QueryEvent, Row, StatementSpan};

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

/// text를 `;`로 잘라 비어 있지 않은 조각마다 span을 만든다. `'`가 홀수 개면 나눌 수 없다.
pub(crate) struct FakeSplitter;

impl StatementSplitter for FakeSplitter {
    fn split(&self, sql: &str) -> Result<Vec<StatementSpan>, SplitError> {
        if sql.matches('\'').count() % 2 == 1 {
            return Err(SplitError {
                message: "따옴표가 닫히지 않았다".into(),
            });
        }
        let mut spans = Vec::new();
        let mut start = 0;
        for piece in sql.split(';') {
            let end = start + piece.len();
            if !piece.trim().is_empty() {
                spans.push(StatementSpan { start, end });
            }
            start = end + 1;
        }
        Ok(spans)
    }
}

/// 이벤트를 channel로 넘기는 sink와 그 수신 쪽. 수신 쪽이 drop돼도 sink는 panic하지 않는다.
pub(crate) fn sink() -> (QuerySink, UnboundedReceiver<QueryEvent>) {
    let (sender, events) = mpsc::unbounded_channel();
    let sink: QuerySink = Box::new(move |event| {
        let _ = sender.send(event);
    });
    (sink, events)
}

/// 1초 안에 온 이벤트. 없으면 panic한다.
pub(crate) async fn next(events: &mut UnboundedReceiver<QueryEvent>) -> QueryEvent {
    timeout(Duration::from_secs(1), events.recv())
        .await
        .expect("1초 안에 이벤트가 오지 않았다")
        .expect("sink가 이벤트 없이 drop됐다")
}

/// 행 `i`는 `vec![Some(i.to_string())]`이다. `FakeFeed::rows`가 넣는 행이다.
pub(crate) fn numbered(range: Range<u64>) -> Vec<Row> {
    range.map(|i| vec![Some(i.to_string())]).collect()
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
