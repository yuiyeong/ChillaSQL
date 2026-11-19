use std::path::PathBuf;
use std::time::Duration;

use tokio::time::{Instant, sleep};

use super::*;
use crate::application::test_support::{FakeRun, FakeRunner, events_sink};
use crate::domain::{TunnelEvent, TunnelFailure, TunnelState};

const NAME: &str = "staging";
const TIMEOUT: Duration = Duration::from_secs(20);

fn target(command: &str) -> TunnelTarget {
    TunnelTarget {
        command: command.into(),
        dir: PathBuf::from("/p"),
        host: "localhost".into(),
        port: 25432,
        timeout: TIMEOUT,
    }
}

struct Fixture {
    tunnels: Arc<Tunnels<FakeRunner>>,
    runner: FakeRunner,
    events: Arc<std::sync::Mutex<Vec<TunnelEvent>>>,
}

fn fixture() -> Fixture {
    let runner = FakeRunner::default();
    let (sink, events) = events_sink();
    Fixture {
        tunnels: Arc::new(Tunnels::new(runner.clone(), sink)),
        runner,
        events,
    }
}

impl Fixture {
    fn states(&self) -> Vec<TunnelState> {
        let events = self.events.lock().unwrap();
        events
            .iter()
            .filter(|e| e.connection == NAME)
            .map(|e| e.state.clone())
            .collect()
    }

    /// 기다리는 acquire를 다른 task에서 돌린다.
    fn acquire_later(
        &self,
        command: &str,
    ) -> tokio::task::JoinHandle<Result<TunnelLease, TunnelError>> {
        let tunnels = self.tunnels.clone();
        let target = target(command);
        tokio::spawn(async move { tunnels.acquire(NAME, &target).await })
    }
}

fn starting(attempt: u8) -> TunnelState {
    TunnelState::Starting {
        attempt,
        timeout: TIMEOUT,
    }
}

fn failure(result: Result<TunnelLease, TunnelError>) -> TunnelFailure {
    match result {
        Err(error) => error.failure,
        Ok(_) => panic!("터널이 열리면 안 된다"),
    }
}

#[tokio::test(start_paused = true)]
async fn acquire_runs_the_command_and_waits_for_the_port() {
    let f = fixture();
    f.runner
        .script("tunnel", vec![FakeRun::OpensAfter(Duration::from_secs(3))]);

    let lease = f.tunnels.acquire(NAME, &target("tunnel")).await.unwrap();

    assert_eq!(f.runner.spawned(), ["tunnel"]);
    assert_eq!(f.states(), [starting(0), TunnelState::Ready]);
    f.tunnels.release(lease).await;
}

#[tokio::test(start_paused = true)]
async fn acquire_with_an_open_port_is_external_and_runs_nothing() {
    let f = fixture();
    f.runner.set_open("localhost", 25432, true);

    let lease = f.tunnels.acquire(NAME, &target("tunnel")).await.unwrap();
    assert!(f.runner.spawned().is_empty());
    assert_eq!(f.states(), [starting(0), TunnelState::External]);

    f.tunnels.release(lease).await;
    assert_eq!(f.runner.running(), 0);
    assert_eq!(f.states().last(), Some(&TunnelState::Stopped));
}

#[tokio::test(start_paused = true)]
async fn an_external_tunnel_that_closed_is_started_by_the_next_acquire() {
    let f = fixture();
    f.runner.set_open("localhost", 25432, true);
    let first = f.tunnels.acquire(NAME, &target("tunnel")).await.unwrap();
    f.runner.set_open("localhost", 25432, false);

    let second = f.tunnels.acquire(NAME, &target("tunnel")).await.unwrap();

    assert_eq!(f.runner.spawned(), ["tunnel"]);
    assert_eq!(f.states().last(), Some(&TunnelState::Ready));
    f.tunnels.release(first).await;
    f.tunnels.release(second).await;
    assert_eq!(f.runner.running(), 0);
}

#[tokio::test(start_paused = true)]
async fn two_acquires_share_one_process() {
    let f = fixture();
    f.runner
        .script("tunnel", vec![FakeRun::OpensAfter(Duration::from_secs(2))]);

    let shared = target("tunnel");
    let (a, b) = tokio::join!(
        f.tunnels.acquire(NAME, &shared),
        f.tunnels.acquire(NAME, &shared)
    );

    assert_eq!(f.runner.spawned().len(), 1);
    f.tunnels.release(a.unwrap()).await;
    assert_eq!(f.runner.running(), 1);
    f.tunnels.release(b.unwrap()).await;
    assert_eq!(f.runner.running(), 0);
}

#[tokio::test(start_paused = true)]
async fn timeout_stops_the_process_and_reports_output() {
    let f = fixture();
    f.runner
        .script("tunnel", vec![FakeRun::Hangs("Unauthorized")]);
    let started = Instant::now();

    let error = f
        .tunnels
        .acquire(NAME, &target("tunnel"))
        .await
        .err()
        .unwrap();

    assert!(started.elapsed() >= TIMEOUT);
    assert_eq!(
        error.failure,
        TunnelFailure::Timeout {
            secs: 20,
            output: "Unauthorized".into()
        }
    );
    assert_eq!(
        error.to_string(),
        "localhost:25432 didn't open within 20 seconds"
    );
    assert_eq!(f.runner.running(), 0);
}

#[tokio::test(start_paused = true)]
async fn early_exit_fails_without_waiting_for_the_timeout() {
    let f = fixture();
    f.runner.script(
        "tunnel",
        vec![FakeRun::ExitsAfter(
            Duration::from_secs(1),
            Some(1),
            "Error: failed to open tunnel",
        )],
    );
    let started = Instant::now();

    let error = f
        .tunnels
        .acquire(NAME, &target("tunnel"))
        .await
        .err()
        .unwrap();

    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(
        error.failure,
        TunnelFailure::Exited {
            code: Some(1),
            output: "Error: failed to open tunnel".into()
        }
    );
    assert_eq!(
        error.to_string(),
        "The tunnel command exited with code 1 before localhost:25432 opened"
    );
    assert_eq!(f.runner.running(), 0);
}

#[tokio::test(start_paused = true)]
async fn spawn_failure_is_reported() {
    let f = fixture();
    f.runner
        .script("tunnel", vec![FakeRun::SpawnFails("No such file")]);

    let failure = failure(f.tunnels.acquire(NAME, &target("tunnel")).await);

    assert_eq!(
        failure,
        TunnelFailure::Spawn {
            message: "No such file".into()
        }
    );
}

#[tokio::test(start_paused = true)]
async fn exited_tunnel_is_run_again() {
    let f = fixture();
    let lease = f.tunnels.acquire(NAME, &target("tunnel")).await.unwrap();

    f.runner.kill("tunnel");
    sleep(Duration::from_secs(3)).await;

    assert_eq!(f.runner.spawned().len(), 2);
    assert_eq!(f.runner.running(), 1);
    assert_eq!(
        f.states(),
        [
            starting(0),
            TunnelState::Ready,
            starting(1),
            TunnelState::Ready
        ]
    );

    // 포트가 열렸으므로 횟수는 처음으로 돌아간다.
    f.runner.kill("tunnel");
    sleep(Duration::from_secs(3)).await;
    assert_eq!(f.states()[4], starting(1));
    f.tunnels.release(lease).await;
}

#[tokio::test(start_paused = true)]
async fn three_failed_runs_stop_with_the_last_output() {
    let f = fixture();
    f.runner.script(
        "tunnel",
        vec![
            FakeRun::OpensAfter(Duration::ZERO),
            FakeRun::ExitsAfter(Duration::ZERO, Some(1), "e1"),
            FakeRun::ExitsAfter(Duration::ZERO, Some(1), "e2"),
            FakeRun::ExitsAfter(Duration::ZERO, Some(1), "e3"),
        ],
    );
    let lease = f.tunnels.acquire(NAME, &target("tunnel")).await.unwrap();

    f.runner.kill("tunnel");
    sleep(Duration::from_secs(10)).await;

    assert_eq!(
        f.states(),
        [
            starting(0),
            TunnelState::Ready,
            starting(1),
            starting(2),
            starting(3),
            TunnelState::Failed(TunnelFailure::Exited {
                code: Some(1),
                output: "e3".into()
            }),
        ]
    );
    let times = f.runner.spawn_times();
    for pair in times[1..].windows(2) {
        assert!(pair[1] - pair[0] >= Duration::from_secs(1));
    }
    assert_eq!(f.runner.running(), 0);
    f.tunnels.release(lease).await;
}

/// 위와 같이 재실행이 멈춘 터널.
async fn gave_up(f: &Fixture) -> TunnelLease {
    f.runner.script(
        "tunnel",
        vec![
            FakeRun::OpensAfter(Duration::ZERO),
            FakeRun::ExitsAfter(Duration::ZERO, Some(1), "e1"),
            FakeRun::ExitsAfter(Duration::ZERO, Some(1), "e2"),
            FakeRun::ExitsAfter(Duration::ZERO, Some(1), "e3"),
        ],
    );
    let lease = f.tunnels.acquire(NAME, &target("tunnel")).await.unwrap();
    f.runner.kill("tunnel");
    sleep(Duration::from_secs(10)).await;
    assert!(matches!(f.states().last(), Some(TunnelState::Failed(_))));
    lease
}

#[tokio::test(start_paused = true)]
async fn acquire_after_failure_starts_again_from_zero() {
    let f = fixture();
    let first = gave_up(&f).await;
    let before = f.states().len();

    let second = f.tunnels.acquire(NAME, &target("tunnel")).await.unwrap();

    assert_eq!(f.states()[before..], [starting(0), TunnelState::Ready]);
    f.tunnels.release(first).await;
    f.tunnels.release(second).await;
    assert_eq!(f.runner.running(), 0);
}

#[tokio::test(start_paused = true)]
async fn restart_starts_a_failed_tunnel_again() {
    let f = fixture();
    let lease = gave_up(&f).await;
    let before = f.states().len();

    f.tunnels.restart(NAME).await;
    sleep(Duration::from_secs(1)).await;
    assert_eq!(f.states()[before..], [starting(0), TunnelState::Ready]);

    // 열려 있는 터널은 다시 시작하지 않는다.
    f.tunnels.restart(NAME).await;
    sleep(Duration::from_secs(1)).await;
    assert_eq!(f.states().len(), before + 2);
    f.tunnels.release(lease).await;
}

#[tokio::test(start_paused = true)]
async fn cancel_fails_waiters_with_cancelled() {
    let f = fixture();
    f.runner.script("tunnel", vec![FakeRun::Hangs("")]);
    let a = f.acquire_later("tunnel");
    let b = f.acquire_later("tunnel");
    sleep(Duration::from_secs(1)).await;

    f.tunnels.cancel(NAME).await;

    assert_eq!(failure(a.await.unwrap()), TunnelFailure::Cancelled);
    assert_eq!(failure(b.await.unwrap()), TunnelFailure::Cancelled);
    assert_eq!(f.runner.running(), 0);
    assert_eq!(f.states().last(), Some(&TunnelState::Stopped));
}

#[tokio::test(start_paused = true)]
async fn acquire_waits_until_the_old_tunnel_of_the_name_is_gone() {
    let f = fixture();
    f.runner.set_stop_delay(Duration::from_millis(500));
    let old = f.tunnels.acquire(NAME, &target("tunnel")).await.unwrap();

    let new = f.acquire_later("tunnel2");
    sleep(Duration::from_millis(100)).await;
    assert_eq!(f.runner.spawned(), ["tunnel"]);
    let before = f.states().len();
    f.tunnels.release(old).await;

    let new = new.await.unwrap().unwrap();
    assert_eq!(f.runner.spawned(), ["tunnel", "tunnel2"]);
    assert_eq!(
        f.states()[before..],
        [TunnelState::Stopped, starting(0), TunnelState::Ready]
    );
    f.tunnels.release(new).await;
}

#[tokio::test(start_paused = true)]
async fn stop_all_stops_starting_restarting_and_private_tunnels() {
    let f = fixture();
    // 시작 중: 다른 이름, 다른 포트.
    f.runner
        .script_at("hang", "localhost", 26000, vec![FakeRun::Hangs("")]);
    let hanging = {
        let tunnels = f.tunnels.clone();
        let target = TunnelTarget {
            port: 26000,
            ..target("hang")
        };
        tokio::spawn(async move { tunnels.acquire("other", &target).await })
    };
    // 재실행 대기 중.
    let lease = f.tunnels.acquire(NAME, &target("tunnel")).await.unwrap();
    f.runner.kill("tunnel");
    // 접속 테스트의 터널.
    f.runner.script_at("test", "localhost", 27000, vec![]);
    let private = f
        .tunnels
        .start_private(&TunnelTarget {
            port: 27000,
            ..target("test")
        })
        .await
        .unwrap();
    sleep(Duration::from_millis(100)).await;

    f.tunnels.stop_all().await;

    assert_eq!(f.runner.running(), 0);
    assert_eq!(failure(hanging.await.unwrap()), TunnelFailure::Cancelled);
    private.stop().await;
    f.tunnels.release(lease).await;

    // 그 뒤에도 터널을 새로 띄울 수 있다.
    let again = f.tunnels.acquire(NAME, &target("tunnel")).await.unwrap();
    assert_eq!(f.runner.running(), 1);
    f.tunnels.release(again).await;
}

#[tokio::test(start_paused = true)]
async fn private_tunnel_is_not_shared() {
    let f = fixture();
    let first = f.tunnels.start_private(&target("tunnel")).await.unwrap();
    first.stop().await;
    let second = f.tunnels.start_private(&target("tunnel")).await.unwrap();
    second.stop().await;
    assert_eq!(f.runner.spawned().len(), 2);
    assert_eq!(f.runner.running(), 0);

    f.runner.set_open("localhost", 25432, true);
    let external = f.tunnels.start_private(&target("tunnel")).await.unwrap();
    external.stop().await;
    assert_eq!(f.runner.spawned().len(), 2);
    assert!(f.events.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn private_tunnel_failure_is_an_error() {
    let f = fixture();
    f.runner.script(
        "tunnel",
        vec![FakeRun::ExitsAfter(Duration::ZERO, Some(2), "nope")],
    );

    let error = f
        .tunnels
        .start_private(&target("tunnel"))
        .await
        .err()
        .unwrap();

    assert_eq!(
        error.failure,
        TunnelFailure::Exited {
            code: Some(2),
            output: "nope".into()
        }
    );
    assert_eq!(f.runner.running(), 0);
}
