//! integration test가 함께 쓰는 것. test DB는 `scripts/test-db.sh up`으로 띄운다.
#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chilla_core::application::{
    App, ConnectError, Connector, QueryError, QuerySink, RowItem, RowSource,
};
use chilla_core::domain::{
    ConnectionProfile, Password, QueryEvent, QueryOutcome, SslMode, TunnelEvent,
};
use chilla_core::infrastructure::{
    FsSqlFileStore, MemoryPasswordStore, PgConnection, PgConnector, PgQueryInspector,
    PgQuerySplitter, ShellTunnelRunner, TomlProjectStore,
};
use tempfile::TempDir;
use tokio::sync::mpsc::{self, UnboundedReceiver};
use tokio::time::timeout;

pub const TEST_DB_PORT: u16 = 54318;
/// SSL을 켠 test DB. 서버 인증서의 SAN은 `DNS:localhost`뿐이다.
pub const TLS_DB_PORT: u16 = 54319;
// compose.yaml의 POSTGRES_* 값. 두 test DB가 같이 쓴다.
pub const USER: &str = "chilla";
pub const PASSWORD: &str = "chilla";
pub const DATABASE: &str = "chilla_test";

pub fn local_profile() -> ConnectionProfile {
    ConnectionProfile {
        name: "local".into(),
        host: "127.0.0.1".into(),
        port: TEST_DB_PORT,
        database: DATABASE.into(),
        user: USER.into(),
        sslmode: SslMode::Disable,
        sslrootcert: None,
        tunnel: None,
        tunnel_timeout: None,
        color: None,
    }
}

/// TLS test DB의 profile. `sslrootcert`는 `db/tls/` 아래의 파일 이름이다.
pub fn tls_profile(host: &str, sslmode: SslMode, sslrootcert: Option<&str>) -> ConnectionProfile {
    ConnectionProfile {
        name: "tls".into(),
        host: host.into(),
        port: TLS_DB_PORT,
        sslmode,
        sslrootcert: sslrootcert.map(tls_file),
        ..local_profile()
    }
}

/// `scripts/test-db.sh`가 만든 `db/tls/<name>`의 절대 경로.
pub fn tls_file(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../db/tls")
        .join(name)
}

pub fn password() -> Password {
    Password::new(PASSWORD.into())
}

/// 검사하려는 코드로 test DB에 연결한다.
pub async fn connect() -> PgConnection {
    PgConnector::new()
        .connect(&local_profile(), Some(&password()))
        .await
        .expect("scripts/test-db.sh up 을 먼저 실행하세요")
}

/// 결과를 `None`까지 모두 읽는다.
pub async fn collect<R: RowSource>(rows: &mut R) -> Vec<Result<RowItem, QueryError>> {
    let mut items = Vec::new();
    while let Some(item) = rows.next().await {
        items.push(item);
    }
    items
}

/// 확인용 직접 연결. 검사하려는 코드를 거치지 않는다.
pub async fn admin() -> tokio_postgres::Client {
    admin_on(TEST_DB_PORT).await
}

pub async fn tls_admin() -> tokio_postgres::Client {
    admin_on(TLS_DB_PORT).await
}

pub async fn admin_on(port: u16) -> tokio_postgres::Client {
    let config =
        format!("host=127.0.0.1 port={port} user={USER} password={PASSWORD} dbname={DATABASE}");
    let (client, connection) = tokio_postgres::connect(&config, tokio_postgres::NoTls)
        .await
        .unwrap_or_else(|e| {
            panic!(
                "test DB({port})에 접속하지 못했다. scripts/test-db.sh up 을 먼저 실행하세요: {e}"
            )
        });
    tokio::spawn(connection);
    client
}

pub async fn terminate_backend(admin: &tokio_postgres::Client, pid: i32) {
    admin
        .execute("SELECT pg_terminate_backend($1)", &[&pid])
        .await
        .unwrap();
}

/// 연결이 실패해야 하는 경우의 오류.
pub async fn connect_error(
    profile: &ConnectionProfile,
    password: Option<Password>,
) -> ConnectError {
    match PgConnector::new().connect(profile, password.as_ref()).await {
        Ok(_) => panic!("연결되면 안 된다"),
        Err(e) => e,
    }
}

pub async fn backend_exists(admin: &tokio_postgres::Client, pid: i32) -> bool {
    admin
        .query_one(
            "SELECT count(*) FROM pg_stat_activity WHERE pid = $1",
            &[&pid],
        )
        .await
        .unwrap()
        .get::<_, i64>(0)
        == 1
}

/// backend `pid`가 쿼리를 실행하기 시작할 때까지 기다린다. 서버는 쿼리를 읽기 전에 닿은
/// cancel을 무시하므로, cancel이 반드시 닿아야 하는 test는 이것을 먼저 부른다.
pub async fn wait_until_running(admin: &tokio_postgres::Client, pid: i32) {
    let running = eventually(async || {
        let state = admin
            .query_one("SELECT state FROM pg_stat_activity WHERE pid = $1", &[&pid])
            .await
            .unwrap();
        state.get::<_, Option<String>>(0).as_deref() == Some("active")
    })
    .await;
    assert!(running, "쿼리가 실행되지 않는다");
}

/// backend `pid`의 `pg_stat_activity` (state, wait_event).
pub async fn activity(
    admin: &tokio_postgres::Client,
    pid: i32,
) -> (Option<String>, Option<String>) {
    let row = admin
        .query_one(
            "SELECT state, wait_event FROM pg_stat_activity WHERE pid = $1",
            &[&pid],
        )
        .await
        .unwrap();
    (row.get(0), row.get(1))
}

/// `check`가 true가 될 때까지 50ms 간격으로 최대 2초 기다린다.
pub async fn eventually(mut check: impl AsyncFnMut() -> bool) -> bool {
    for _ in 0..40 {
        if check().await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    check().await
}

/// test에 쓰는 실제 구성의 App.
pub type TestApp = App<PgConnector, ShellTunnelRunner>;

/// 받은 터널 event.
pub type TunnelEvents = Arc<std::sync::Mutex<Vec<TunnelEvent>>>;

/// 실제 구성에서 키체인만 메모리로 바꾼 App과, test DB를 가리키는 접속 `local`이 있는 프로젝트.
pub async fn app_with_project() -> (TestApp, TempDir) {
    let toml = format!(
        "[connections.local]\nhost = \"127.0.0.1\"\nport = {TEST_DB_PORT}\ndatabase = \"{DATABASE}\"\nuser = \"{USER}\"\n"
    );
    let (app, dir, _events) = app_with_toml(&toml).await;
    (app, dir)
}

/// `toml`을 `chilla.toml`로 쓴 프로젝트를 연 App과 그 터널 event.
pub async fn app_with_toml(toml: &str) -> (TestApp, TempDir, TunnelEvents) {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("chilla.toml"), toml).unwrap();
    let events: TunnelEvents = Arc::default();
    let app = App::new(
        Arc::new(TomlProjectStore),
        Arc::new(MemoryPasswordStore::default()),
        Arc::new(PgQuerySplitter),
        Arc::new(PgQueryInspector),
        Arc::new(FsSqlFileStore),
        PgConnector::new(),
        ShellTunnelRunner::new(),
        Arc::new({
            let events = events.clone();
            move |event| events.lock().unwrap().push(event)
        }),
    );
    app.open_project(dir.path()).await.unwrap();
    (app, dir, events)
}

pub async fn store_password(app: &TestApp) {
    app.set_password("local", password()).await.unwrap();
}

/// 쿼리의 이벤트를 받는 sink와 그 수신 쪽. 수신 쪽이 drop돼도 sink는 panic하지 않는다.
pub fn sink() -> (QuerySink, UnboundedReceiver<QueryEvent>) {
    let (sender, events) = mpsc::unbounded_channel();
    let sink: QuerySink = Box::new(move |event| {
        let _ = sender.send(event);
    });
    (sink, events)
}

/// 2초 안에 온 이벤트. 없으면 panic한다.
pub async fn next(events: &mut UnboundedReceiver<QueryEvent>) -> QueryEvent {
    timeout(Duration::from_secs(2), events.recv())
        .await
        .expect("2초 안에 이벤트가 오지 않았다")
        .expect("sink가 이벤트 없이 drop됐다")
}

/// `Finished`가 올 때까지 읽고 그 `QueryOutcome`을 돌려준다.
pub async fn finished(events: &mut UnboundedReceiver<QueryEvent>) -> QueryOutcome {
    loop {
        if let QueryEvent::Finished { outcome, .. } = next(events).await {
            return outcome;
        }
    }
}
