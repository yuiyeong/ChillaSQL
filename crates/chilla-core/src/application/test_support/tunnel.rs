//! 가짜 [`TunnelRunner`]. 명령마다 실행할 때의 동작을 정해 둔다. 시간은 tokio의 시계를 따르므로
//! `start_paused` test에서 바로 흐른다.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep};

use crate::application::{SpawnError, TunnelProcess, TunnelRunner, TunnelSink};
use crate::domain::TunnelEvent;

/// 실행 한 번의 동작.
#[derive(Debug, Clone)]
pub(crate) enum FakeRun {
    /// 그만큼 뒤에 포트를 연다.
    OpensAfter(Duration),
    /// 그만큼 뒤에 stderr를 남기고 끝난다.
    ExitsAfter(Duration, Option<i32>, &'static str),
    /// stderr를 남기고 포트를 열지도 끝나지도 않는다.
    Hangs(&'static str),
    SpawnFails(&'static str),
}

const DEFAULT_ADDR: (&str, u16) = ("localhost", 25432);

#[derive(Default)]
struct State {
    open: HashMap<(String, u16), bool>,
    scripts: HashMap<String, VecDeque<FakeRun>>,
    addrs: HashMap<String, (String, u16)>,
    spawned: Vec<(String, Instant)>,
    live: Vec<Arc<Shared>>,
    stop_delay: Duration,
    log: Option<Arc<Mutex<Vec<&'static str>>>>,
}

#[derive(Clone, Default)]
pub(crate) struct FakeRunner {
    state: Arc<Mutex<State>>,
}

struct Shared {
    command: String,
    addr: (String, u16),
    exit: watch::Sender<Option<Option<i32>>>,
    output: Mutex<String>,
}

impl FakeRunner {
    pub(crate) fn set_open(&self, host: &str, port: u16, open: bool) {
        self.state
            .lock()
            .unwrap()
            .open
            .insert((host.to_string(), port), open);
    }

    /// `command`를 실행할 때마다 앞에서부터 하나씩 쓴다. 다 쓰면 바로 포트를 연다.
    /// 포트는 `localhost:25432`다.
    pub(crate) fn script(&self, command: &str, runs: Vec<FakeRun>) {
        self.script_at(command, DEFAULT_ADDR.0, DEFAULT_ADDR.1, runs);
    }

    pub(crate) fn script_at(&self, command: &str, host: &str, port: u16, runs: Vec<FakeRun>) {
        let mut state = self.state.lock().unwrap();
        state.scripts.insert(command.to_string(), runs.into());
        state
            .addrs
            .insert(command.to_string(), (host.to_string(), port));
    }

    /// `stop`이 끝나기까지 걸리는 시간. 그동안 포트는 열려 있다.
    pub(crate) fn set_stop_delay(&self, delay: Duration) {
        self.state.lock().unwrap().stop_delay = delay;
    }

    pub(crate) fn spawned(&self) -> Vec<String> {
        let state = self.state.lock().unwrap();
        state.spawned.iter().map(|(c, _)| c.clone()).collect()
    }

    pub(crate) fn spawn_times(&self) -> Vec<Instant> {
        let state = self.state.lock().unwrap();
        state.spawned.iter().map(|(_, at)| *at).collect()
    }

    /// 실행했지만 `stop`하지 않은 프로세스 수.
    pub(crate) fn running(&self) -> usize {
        self.state.lock().unwrap().live.len()
    }

    /// 터널이 끊긴 것처럼 `command`의 프로세스를 끝내고 포트를 닫는다.
    pub(crate) fn kill(&self, command: &str) {
        let live: Vec<_> = {
            let state = self.state.lock().unwrap();
            state
                .live
                .iter()
                .filter(|p| p.command == command)
                .cloned()
                .collect()
        };
        for process in live {
            self.set_open(&process.addr.0, process.addr.1, false);
            process.exit.send_replace(Some(None));
        }
    }
}

/// event를 모으는 sink.
pub(crate) fn events_sink() -> (TunnelSink, Arc<Mutex<Vec<TunnelEvent>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink: TunnelSink = {
        let events = events.clone();
        Arc::new(move |event| events.lock().unwrap().push(event))
    };
    (sink, events)
}

impl TunnelRunner for FakeRunner {
    type Process = FakeProcess;

    async fn is_open(&self, host: &str, port: u16) -> bool {
        let state = self.state.lock().unwrap();
        state
            .open
            .get(&(host.to_string(), port))
            .copied()
            .unwrap_or(false)
    }

    fn spawn(&self, command: &str, _dir: &Path) -> Result<FakeProcess, SpawnError> {
        let mut state = self.state.lock().unwrap();
        let run = state
            .scripts
            .get_mut(command)
            .and_then(VecDeque::pop_front)
            .unwrap_or(FakeRun::OpensAfter(Duration::ZERO));
        if let FakeRun::SpawnFails(message) = run {
            return Err(SpawnError {
                message: message.into(),
            });
        }
        let addr = state
            .addrs
            .get(command)
            .cloned()
            .unwrap_or((DEFAULT_ADDR.0.to_string(), DEFAULT_ADDR.1));
        let shared = Arc::new(Shared {
            command: command.to_string(),
            addr,
            exit: watch::channel(None).0,
            output: Mutex::new(String::new()),
        });
        state.spawned.push((command.to_string(), Instant::now()));
        state.live.push(shared.clone());
        drop(state);

        let task = tokio::spawn({
            let runner = self.clone();
            let shared = shared.clone();
            async move {
                match run {
                    FakeRun::OpensAfter(delay) => {
                        sleep(delay).await;
                        runner.set_open(&shared.addr.0, shared.addr.1, true);
                    }
                    FakeRun::ExitsAfter(delay, code, stderr) => {
                        shared.output.lock().unwrap().push_str(stderr);
                        sleep(delay).await;
                        shared.exit.send_replace(Some(code));
                    }
                    FakeRun::Hangs(stderr) => shared.output.lock().unwrap().push_str(stderr),
                    FakeRun::SpawnFails(_) => unreachable!(),
                }
            }
        });
        Ok(FakeProcess {
            runner: self.clone(),
            shared,
            task,
        })
    }
}

pub(crate) struct FakeProcess {
    runner: FakeRunner,
    shared: Arc<Shared>,
    task: JoinHandle<()>,
}

impl TunnelProcess for FakeProcess {
    fn mark_ready(&mut self) {}

    async fn wait(&mut self) -> Option<i32> {
        let mut exit = self.shared.exit.subscribe();
        match exit.wait_for(Option::is_some).await {
            Ok(code) => code.flatten(),
            Err(_) => None,
        }
    }

    fn output(&self) -> String {
        self.shared.output.lock().unwrap().clone()
    }

    async fn stop(self) {
        let (delay, log) = {
            let state = self.runner.state.lock().unwrap();
            (state.stop_delay, state.log.clone())
        };
        sleep(delay).await;
        self.task.abort();
        let (host, port) = &self.shared.addr;
        self.runner.set_open(host, *port, false);
        self.shared.exit.send_replace(Some(None));
        self.runner
            .state
            .lock()
            .unwrap()
            .live
            .retain(|p| !Arc::ptr_eq(p, &self.shared));
        if let Some(log) = log {
            log.lock().unwrap().push("tunnel stop");
        }
    }
}
