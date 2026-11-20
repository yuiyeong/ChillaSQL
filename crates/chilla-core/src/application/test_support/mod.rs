//! `application`의 단위 test가 쓰는 가짜 port 구현.

mod connection;
mod tunnel;

use std::collections::HashMap;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::time::timeout;

pub(crate) use connection::{FakeCatalog, FakeConnection, FakeFeed, FakeLink, server_error};
pub(crate) use tunnel::{FakeRun, FakeRunner, events_sink};

use super::{
    AppStore, ConnectError, Connector, FileError, HistoryEntry, NewHistoryEntry, PasswordKey,
    PasswordStore, PasswordStoreError, ProjectError, ProjectStore, QueryError, QuerySink,
    RecentProject, SplitError, SqlFileStore, StatementInspector, StatementSplitter, StoreError,
};
use crate::domain::{
    Catalog, ConnectionColor, ConnectionProfile, Danger, FileStamp, ParameterSpan, Password,
    Project, QueryEvent, RelationDdl, Row, SqlFile, SqlPath, StatementSpan, TableDetails, TypeInfo,
    WriteMode,
};

pub(crate) fn profile(name: &str) -> ConnectionProfile {
    ConnectionProfile::fixture(name)
}

/// 등록한 디렉토리만 프로젝트로 읽힌다.
#[derive(Default)]
pub(crate) struct FakeProjects {
    projects: Mutex<HashMap<PathBuf, Project>>,
    saved: Mutex<Vec<(PathBuf, ConnectionProfile)>>,
    gate: Arc<tokio::sync::RwLock<()>>,
}

impl FakeProjects {
    pub(crate) fn add(&self, dir: &str, connections: &[&str]) {
        let connections = connections.iter().map(|name| profile(name)).collect();
        let project = fake_project(Path::new(dir), connections);
        self.projects.lock().unwrap().insert(dir.into(), project);
    }

    /// `dir` 프로젝트의 접속 `name`에 터널 명령을 단다.
    pub(crate) fn set_tunnel(&self, dir: &str, name: &str, command: &str) {
        let mut projects = self.projects.lock().unwrap();
        let project = projects.get_mut(Path::new(dir)).expect("등록한 프로젝트");
        let connection = project
            .connections
            .iter_mut()
            .find(|c| c.name == name)
            .expect("등록한 접속");
        connection.tunnel = Some(command.to_string());
    }

    /// 받은 저장 요청. 받은 순서다.
    pub(crate) fn saved(&self) -> Vec<(PathBuf, ConnectionProfile)> {
        self.saved.lock().unwrap().clone()
    }

    /// 돌려준 guard를 drop할 때까지 `save_connection`이 끝나지 않게 한다. 요청은 받은 즉시
    /// 기록된다.
    pub(crate) async fn block(&self) -> tokio::sync::OwnedRwLockWriteGuard<()> {
        self.gate.clone().write_owned().await
    }
}

/// 이름은 `dir`에서 앞의 `/`를 뗀 것이다(`/p` → `p`).
fn fake_project(dir: &Path, connections: Vec<ConnectionProfile>) -> Project {
    let dir = dir.to_path_buf();
    let name = dir.to_string_lossy().trim_start_matches('/').into();
    Project {
        dir,
        name,
        connections,
    }
}

fn file_in(dir: &Path) -> PathBuf {
    dir.join("chilla.toml")
}

impl ProjectStore for FakeProjects {
    fn load(&self, dir: &Path) -> Result<Project, ProjectError> {
        let projects = self.projects.lock().unwrap();
        let project = projects.get(dir).cloned();
        project.ok_or_else(|| ProjectError::NotFound { path: file_in(dir) })
    }

    fn create(&self, dir: &Path) -> Result<Project, ProjectError> {
        let mut projects = self.projects.lock().unwrap();
        if projects.contains_key(dir) {
            return Err(ProjectError::AlreadyExists { path: file_in(dir) });
        }
        let project = fake_project(dir, Vec::new());
        projects.insert(dir.to_path_buf(), project.clone());
        Ok(project)
    }

    fn save_connection(
        &self,
        dir: &Path,
        profile: &ConnectionProfile,
    ) -> Result<Project, ProjectError> {
        let request = (dir.to_path_buf(), profile.clone());
        self.saved.lock().unwrap().push(request);
        // `spawn_blocking`의 thread에서 불린다.
        let _open = self.gate.blocking_read();
        let mut projects = self.projects.lock().unwrap();
        let project = projects
            .get_mut(dir)
            .ok_or_else(|| ProjectError::NotFound { path: file_in(dir) })?;
        let same_name = project
            .connections
            .iter_mut()
            .find(|c| c.name == profile.name);
        match same_name {
            Some(saved) => *saved = profile.clone(),
            None => project.connections.push(profile.clone()),
        }
        Ok(project.clone())
    }
}

#[derive(Default)]
pub(crate) struct FakePasswords {
    entries: Mutex<HashMap<PasswordKey, String>>,
    fail_sets: AtomicBool,
    fail_deletes: AtomicBool,
}

impl FakePasswords {
    pub(crate) fn is_empty(&self) -> bool {
        self.entries.lock().unwrap().is_empty()
    }

    /// 이 뒤의 `set`이 실패한다. `false`를 주면 다시 성공한다.
    pub(crate) fn fail_sets(&self, fail: bool) {
        self.fail_sets.store(fail, Ordering::SeqCst);
    }

    /// 이 뒤의 `delete`가 실패한다. `false`를 주면 다시 성공한다.
    pub(crate) fn fail_deletes(&self, fail: bool) {
        self.fail_deletes.store(fail, Ordering::SeqCst);
    }
}

fn denied() -> PasswordStoreError {
    PasswordStoreError {
        message: "거부했다".into(),
    }
}

impl PasswordStore for FakePasswords {
    fn get(&self, key: &PasswordKey) -> Result<Option<Password>, PasswordStoreError> {
        let entries = self.entries.lock().unwrap();
        Ok(entries.get(key).cloned().map(Password::new))
    }

    fn set(&self, key: &PasswordKey, password: &Password) -> Result<(), PasswordStoreError> {
        if self.fail_sets.load(Ordering::SeqCst) {
            return Err(denied());
        }
        let mut entries = self.entries.lock().unwrap();
        entries.insert(key.clone(), password.expose().to_string());
        Ok(())
    }

    fn delete(&self, key: &PasswordKey) -> Result<(), PasswordStoreError> {
        if self.fail_deletes.load(Ordering::SeqCst) {
            return Err(denied());
        }
        self.entries.lock().unwrap().remove(key);
        Ok(())
    }
}

/// 항상 성공하고(빈 목록, 빈 파일, stamp `s`), `read`와 `write`가 받은 요청을 기록한다.
#[derive(Default)]
pub(crate) struct FakeFiles(Mutex<Vec<(PathBuf, String)>>);

impl FakeFiles {
    /// `read`와 `write`가 받은 (프로젝트 디렉토리, 경로). 받은 순서다.
    pub(crate) fn calls(&self) -> Vec<(PathBuf, String)> {
        self.0.lock().unwrap().clone()
    }

    fn record(&self, project_dir: &Path, path: &SqlPath) {
        let call = (project_dir.to_path_buf(), path.as_str().to_string());
        self.0.lock().unwrap().push(call);
    }
}

impl SqlFileStore for FakeFiles {
    fn list(&self, _project_dir: &Path) -> Result<Vec<SqlPath>, FileError> {
        Ok(Vec::new())
    }

    fn read(&self, project_dir: &Path, path: &SqlPath) -> Result<SqlFile, FileError> {
        self.record(project_dir, path);
        Ok(SqlFile {
            text: String::new(),
            stamp: FileStamp("s".into()),
        })
    }

    fn write(
        &self,
        project_dir: &Path,
        path: &SqlPath,
        _text: &str,
        _mode: &WriteMode,
    ) -> Result<FileStamp, FileError> {
        self.record(project_dir, path);
        Ok(FileStamp("s".into()))
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

    /// `::`가 아닌 `:` 바로 뒤의 영문자·밑줄·숫자를 이름으로 본다. 따옴표 검사는 `split`과 같다.
    fn parameters(&self, sql: &str) -> Result<Vec<ParameterSpan>, SplitError> {
        if sql.matches('\'').count() % 2 == 1 {
            return Err(SplitError {
                message: "따옴표가 닫히지 않았다".into(),
            });
        }
        let bytes = sql.as_bytes();
        let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
        let mut params = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            if bytes[at] != b':' {
                at += 1;
                continue;
            }
            let start = at;
            at += 1;
            if bytes.get(at) == Some(&b':') {
                at += 1;
                continue;
            }
            let name_start = at;
            while at < bytes.len() && is_word(bytes[at]) {
                at += 1;
            }
            if at > name_start {
                params.push(ParameterSpan {
                    name: sql[name_start..at].to_string(),
                    start,
                    end: at,
                });
            }
        }
        Ok(params)
    }
}

/// `DROP`으로 시작하면 `Drop`, `TRUNCATE`로 시작하면 `Truncate`, 그 밖에는 위험 없음이다.
pub(crate) struct FakeInspector;

impl StatementInspector for FakeInspector {
    fn danger(&self, sql: &str) -> Option<Danger> {
        let name = sql.split_whitespace().nth(1)?.to_string();
        match sql.split_whitespace().next()? {
            "DROP" => Some(Danger::Drop {
                kind: "TABLE".into(),
                names: vec![name],
            }),
            "TRUNCATE" => Some(Danger::Truncate { tables: vec![name] }),
            _ => None,
        }
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
    /// 다음 연결 요청이 돌려줄 오류.
    fail_next: Option<ConnectError>,
    /// 연결이 닫힐 때 `"db close"`를 남길 곳.
    close_log: Option<Arc<Mutex<Vec<&'static str>>>>,
}

/// 항상 연결에 성공하고, 받은 요청과 만든 연결을 기록한다.
#[derive(Clone, Default)]
pub(crate) struct FakeConnector {
    log: Arc<Mutex<ConnectLog>>,
    catalog: Arc<Mutex<FakeCatalog>>,
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

    /// 다음 연결 요청 하나가 `error`로 실패한다.
    pub(crate) fn fail_next(&self, error: ConnectError) {
        self.log.lock().unwrap().fail_next = Some(error);
    }

    /// 만든 연결들의 `read_catalog`가 돌려줄 catalog. 처음에는 빈 catalog다.
    pub(crate) fn set_catalog(&self, catalog: Catalog) {
        self.catalog.lock().unwrap().catalog = catalog;
    }

    /// 만든 연결들의 `read_table_details(relation)`이 돌려줄 값. 없으면 빈 값이다.
    pub(crate) fn set_details(&self, relation: u32, details: TableDetails) {
        self.catalog
            .lock()
            .unwrap()
            .details
            .insert(relation, details);
    }

    /// 만든 연결들의 `read_ddl(relation)`이 돌려줄 값. 없으면 `None`이다.
    pub(crate) fn set_ddl(&self, relation: u32, ddl: RelationDdl) {
        self.catalog.lock().unwrap().ddls.insert(relation, ddl);
    }

    /// 만든 연결들의 `describe_types`가 아는 type.
    pub(crate) fn set_types(&self, types: Vec<TypeInfo>) {
        self.catalog.lock().unwrap().types = types;
    }

    /// 다음 catalog 읽기 한 번이 `error`로 실패한다. 여러 번 부르면 차례로 쓴다.
    pub(crate) fn fail_next_catalog(&self, error: QueryError) {
        self.catalog.lock().unwrap().failures.push_back(error);
    }

    /// 만든 연결 전체의 `read_catalog` 호출 수.
    pub(crate) fn catalog_reads(&self) -> usize {
        self.catalog.lock().unwrap().reads
    }

    /// 만든 연결이 닫힐 때 `"db close"`를 `log`에 남긴다.
    pub(crate) fn log_to(&self, log: Arc<Mutex<Vec<&'static str>>>) {
        self.log.lock().unwrap().close_log = Some(log);
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
        if let Some(error) = log.fail_next.take() {
            return Err(error);
        }
        let link = FakeLink::default();
        log.links.push(link.clone());
        Ok(FakeConnection {
            pid: 1000 + log.links.len() as i32,
            link,
            log: log.close_log.clone(),
            catalog: self.catalog.clone(),
        })
    }
}

mod tests {
    use super::*;

    #[test]
    fn fake_projects_create_and_save_connection() {
        let projects = FakeProjects::default();
        let created = projects.create(Path::new("/new")).unwrap();
        assert_eq!(created.name, "new");
        assert!(created.connections.is_empty());
        assert_eq!(
            projects.create(Path::new("/new")),
            Err(ProjectError::AlreadyExists {
                path: "/new/chilla.toml".into()
            })
        );

        let red = ConnectionProfile {
            color: Some(ConnectionColor::Red),
            ..profile("a")
        };
        projects
            .save_connection(Path::new("/new"), &profile("a"))
            .unwrap();
        projects
            .save_connection(Path::new("/new"), &profile("b"))
            .unwrap();
        let project = projects.save_connection(Path::new("/new"), &red).unwrap();
        assert_eq!(project.connections, [red.clone(), profile("b")]);
        assert_eq!(projects.load(Path::new("/new")), Ok(project));
        assert_eq!(
            projects.save_connection(Path::new("/none"), &profile("a")),
            Err(ProjectError::NotFound {
                path: "/none/chilla.toml".into()
            })
        );

        let saved: Vec<_> = projects
            .saved()
            .into_iter()
            .map(|(dir, p)| (dir, p.name))
            .collect();
        let expected = [("/new", "a"), ("/new", "b"), ("/new", "a"), ("/none", "a")];
        let expected = expected.map(|(dir, name)| (PathBuf::from(dir), name.to_string()));
        assert_eq!(saved, expected);
    }
}

/// 메모리에 두는 [`AppStore`]. 최근 프로젝트는 넣은 순서대로 쌓고 `recent_projects`는 그 역순이다.
#[derive(Default)]
pub(crate) struct FakeStore {
    recent: Mutex<Vec<RecentProject>>,
    workspaces: Mutex<HashMap<PathBuf, (String, i64)>>,
    history: Mutex<Vec<(PathBuf, HistoryEntry)>>,
    fail: AtomicBool,
}

impl FakeStore {
    /// 이 뒤의 모든 호출이 실패한다. `false`를 주면 다시 성공한다.
    pub(crate) fn fail(&self, fail: bool) {
        self.fail.store(fail, Ordering::SeqCst);
    }

    /// 저장한 snapshot과 `saved_at`.
    pub(crate) fn workspace(&self, dir: &str) -> Option<(String, i64)> {
        self.workspaces.lock().unwrap().get(Path::new(dir)).cloned()
    }

    /// 그 프로젝트의 쿼리 기록 수.
    pub(crate) fn history_len(&self, dir: &str) -> usize {
        let history = self.history.lock().unwrap();
        history.iter().filter(|(d, _)| d == Path::new(dir)).count()
    }

    fn check(&self) -> Result<(), StoreError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(StoreError {
                message: "깨졌다".into(),
            });
        }
        Ok(())
    }
}

impl AppStore for FakeStore {
    fn recent_projects(&self) -> Result<Vec<RecentProject>, StoreError> {
        self.check()?;
        Ok(self.recent.lock().unwrap().iter().rev().cloned().collect())
    }

    fn record_project(&self, project: &RecentProject) -> Result<(), StoreError> {
        self.check()?;
        let mut recent = self.recent.lock().unwrap();
        recent.retain(|p| p.dir != project.dir);
        recent.push(project.clone());
        Ok(())
    }

    fn load_workspace(&self, dir: &Path) -> Result<Option<String>, StoreError> {
        self.check()?;
        let workspaces = self.workspaces.lock().unwrap();
        Ok(workspaces.get(dir).map(|(snapshot, _)| snapshot.clone()))
    }

    fn save_workspace(&self, dir: &Path, snapshot: &str, saved_at: i64) -> Result<(), StoreError> {
        self.check()?;
        let entry = (snapshot.to_string(), saved_at);
        self.workspaces
            .lock()
            .unwrap()
            .insert(dir.to_path_buf(), entry);
        Ok(())
    }

    fn record_query(&self, dir: &Path, entry: &NewHistoryEntry) -> Result<(), StoreError> {
        self.check()?;
        let mut history = self.history.lock().unwrap();
        let id = history.len() as i64 + 1;
        let entry = HistoryEntry {
            id,
            connection: entry.connection.clone(),
            sql: entry.sql.clone(),
            executed_at: entry.executed_at,
            elapsed_micros: entry.elapsed_micros,
        };
        history.push((dir.to_path_buf(), entry));
        Ok(())
    }

    fn search_history(
        &self,
        dir: &Path,
        words: &[String],
        limit: usize,
    ) -> Result<Vec<HistoryEntry>, StoreError> {
        self.check()?;
        let history = self.history.lock().unwrap();
        let found = history
            .iter()
            .rev()
            .filter(|(d, e)| d == dir && words.iter().all(|w| e.sql.contains(w.as_str())))
            .take(limit)
            .map(|(_, e)| e.clone())
            .collect();
        Ok(found)
    }
}
