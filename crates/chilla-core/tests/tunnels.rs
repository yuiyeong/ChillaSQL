//! test DB 앞에 forwarder(`support/forward.py`)를 터널로 두고 App 전체를 확인한다.
//! `scripts/test-db.sh up`이 먼저 돌아 있어야 한다.

mod support;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chilla_core::application::{AppError, TunnelError};
use chilla_core::domain::{
    QueryOutcome, SessionId, SessionState, TunnelFailure, TunnelState, TxMode,
};
use support::{
    DATABASE, TEST_DB_PORT, TestApp, TunnelEvents, USER, app_with_toml, eventually, finished,
    password, sink,
};
use tempfile::TempDir;
use tokio::net::{TcpListener, TcpStream};

const NAME: &str = "tunneled";

fn forwarder() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/forward.py")
}

async fn free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    listener.local_addr().unwrap().port()
}

/// forwarder를 터널 명령으로 쓰는 접속 `tunneled`가 있는 프로젝트. 돌려주는 경로에 forwarder가 pid를 쓴다.
async fn tunneled_project(port: u16) -> (TestApp, TempDir, TunnelEvents, PathBuf) {
    let pid_dir = tempfile::tempdir().unwrap();
    let pid_file = pid_dir.path().join("forward.pid");
    let command = format!(
        "exec python3 {} {port} {TEST_DB_PORT} {}",
        forwarder().display(),
        pid_file.display()
    );
    project_with_command(port, &command, pid_dir, pid_file).await
}

async fn project_with_command(
    port: u16,
    command: &str,
    pid_dir: TempDir,
    pid_file: PathBuf,
) -> (TestApp, TempDir, TunnelEvents, PathBuf) {
    let toml = format!(
        "[connections.{NAME}]\nhost = \"127.0.0.1\"\nport = {port}\ndatabase = \"{DATABASE}\"\nuser = \"{USER}\"\ntunnel = {}\n",
        toml_string(command)
    );
    let (app, dir, events) = app_with_toml(&toml).await;
    app.set_password(NAME, password()).await.unwrap();
    // pid_dir는 project 디렉토리와 같이 살아 있어야 한다.
    std::mem::forget(pid_dir);
    (app, dir, events, pid_file)
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn read_pid(file: &Path) -> i32 {
    std::fs::read_to_string(file)
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn port_open(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).await.is_ok()
}

async fn select_one(app: &TestApp, session: SessionId) -> QueryOutcome {
    let (sink, mut events) = sink();
    app.execute(session, "SELECT 1".into(), TxMode::Auto, sink)
        .await
        .unwrap();
    finished(&mut events).await
}

fn states(events: &TunnelEvents) -> Vec<TunnelState> {
    let events = events.lock().unwrap();
    events.iter().map(|e| e.state.clone()).collect()
}

#[tokio::test]
async fn a_session_runs_through_the_tunnel() {
    let port = free_port().await;
    let (app, _dir, events, pid_file) = tunneled_project(port).await;

    let session = app.open_session(NAME).await.unwrap();
    assert_eq!(
        select_one(&app, session.id).await,
        QueryOutcome::Completed { rows: 1 }
    );
    let pid = read_pid(&pid_file);
    assert!(alive(pid));

    app.close_session(session.id).await.unwrap();
    assert!(!port_open(port).await);
    assert!(!alive(pid));
    assert_eq!(states(&events).last(), Some(&TunnelState::Stopped));
}

#[tokio::test]
async fn a_killed_tunnel_is_run_again_and_a_new_session_works() {
    let port = free_port().await;
    let (app, _dir, events, pid_file) = tunneled_project(port).await;
    let first = app.open_session(NAME).await.unwrap();
    let pid = read_pid(&pid_file);

    unsafe { libc::kill(pid, libc::SIGKILL) };

    assert!(eventually(async || app.session_state(first.id).await == Ok(SessionState::Lost)).await);
    let restarted = || {
        let states = states(&events);
        let at = states
            .iter()
            .position(|s| matches!(s, TunnelState::Starting { attempt: 1, .. }));
        at.is_some_and(|at| states[at..].contains(&TunnelState::Ready))
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !restarted() {
        assert!(Instant::now() < deadline, "{:?}", states(&events));
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_ne!(read_pid(&pid_file), pid);

    let second = app.open_session(NAME).await.unwrap();
    assert_eq!(
        select_one(&app, second.id).await,
        QueryOutcome::Completed { rows: 1 }
    );
    app.shutdown().await;
}

#[tokio::test]
async fn a_failing_command_reports_its_stderr() {
    let port = free_port().await;
    let pid_dir = tempfile::tempdir().unwrap();
    let pid_file = pid_dir.path().join("unused");
    let (app, _dir, _events, _) = project_with_command(
        port,
        "echo 'Unauthorized. Please login' >&2; exit 1",
        pid_dir,
        pid_file,
    )
    .await;
    let started = Instant::now();

    let result = app.open_session(NAME).await;

    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
    match result {
        Err(AppError::Tunnel(TunnelError { failure, .. })) => assert_eq!(
            failure,
            TunnelFailure::Exited {
                code: Some(1),
                output: "Unauthorized. Please login\n".into()
            }
        ),
        other => panic!("터널 오류가 아니다: {other:?}"),
    }
}

#[tokio::test]
async fn an_already_open_port_is_used_as_is() {
    let port = free_port().await;
    let pid_dir = tempfile::tempdir().unwrap();
    let outside_pid = pid_dir.path().join("outside.pid");
    let mut outside = std::process::Command::new("python3")
        .arg(forwarder())
        .args([port.to_string(), TEST_DB_PORT.to_string()])
        .arg(&outside_pid)
        .spawn()
        .unwrap();
    assert!(eventually(async || port_open(port).await).await);
    let (app, _dir, events, pid_file) = tunneled_project(port).await;

    let session = app.open_session(NAME).await.unwrap();
    assert_eq!(
        select_one(&app, session.id).await,
        QueryOutcome::Completed { rows: 1 }
    );
    assert!(states(&events).contains(&TunnelState::External));
    assert!(!pid_file.exists());

    app.close_session(session.id).await.unwrap();
    app.shutdown().await;
    assert!(outside.try_wait().unwrap().is_none());
    outside.kill().unwrap();
    outside.wait().unwrap();
}

#[tokio::test]
async fn shutdown_leaves_no_tunnel_process() {
    let port = free_port().await;
    let (app, _dir, _events, pid_file) = tunneled_project(port).await;
    app.open_session(NAME).await.unwrap();
    app.open_session(NAME).await.unwrap();
    let pid = read_pid(&pid_file);

    app.shutdown().await;

    assert!(!alive(pid));
    assert!(!port_open(port).await);
}
