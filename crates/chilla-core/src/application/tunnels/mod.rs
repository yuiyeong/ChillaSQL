//! 접속마다 터널 하나를 띄우고, 세션들이 나눠 쓰게 하고, 끊기면 다시 띄운다.
//!
//! 터널 하나는 supervisor task 하나다. task가 명령을 실행하고 포트가 열리기를 기다리고, 프로세스가
//! 끝나면 다시 실행한다. 상태는 `watch` channel로 내보내고 바뀔 때마다 [`TunnelSink`]로 알린다.
//! 세션은 [`TunnelLease`]를 갖고, 마지막 lease가 풀리면 터널을 끈다.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{mpsc, watch};
use tokio::time::{Instant, sleep, sleep_until};

use super::{TunnelProcess, TunnelRunner};
use crate::domain::{TunnelEvent, TunnelFailure, TunnelState, TunnelTarget};

/// 터널 상태가 바뀌면 불린다. supervisor task 안에서 불리므로 오래 막지 않는다.
pub type TunnelSink = Arc<dyn Fn(TunnelEvent) + Send + Sync>;

/// 명령을 실행한 뒤 포트를 확인하는 간격.
const PORT_POLL: Duration = Duration::from_millis(200);
/// 끊긴 터널을 다시 실행하기 전에 쉬는 시간.
const RESTART_DELAY: Duration = Duration::from_secs(1);
/// 연속으로 다시 실행해 볼 횟수.
const MAX_RESTARTS: u8 = 3;

/// 터널을 열지 못했다. `Display`는 화면에 그대로 보이는 영어 문장이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelError {
    pub host: String,
    pub port: u16,
    pub failure: TunnelFailure,
}

impl fmt::Display for TunnelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let TunnelError {
            host,
            port,
            failure,
        } = self;
        match failure {
            TunnelFailure::Spawn { message } => {
                write!(f, "Could not run the tunnel command: {message}")
            }
            TunnelFailure::Exited {
                code: Some(code), ..
            } => write!(
                f,
                "The tunnel command exited with code {code} before {host}:{port} opened"
            ),
            TunnelFailure::Exited { code: None, .. } => write!(
                f,
                "The tunnel command was stopped by a signal before {host}:{port} opened"
            ),
            TunnelFailure::Timeout { secs, .. } => {
                write!(f, "{host}:{port} didn't open within {secs} seconds")
            }
            TunnelFailure::Cancelled => write!(f, "The tunnel start was cancelled"),
        }
    }
}

impl std::error::Error for TunnelError {}

/// 세션이 터널을 쓰는 동안 갖는다. [`Tunnels::release`]로 돌려준다.
#[must_use]
#[derive(Debug)]
pub(crate) struct TunnelLease {
    connection: String,
    entry: u64,
}

/// 접속 테스트가 띄운 터널. 공유하지 않는다.
#[must_use]
pub(crate) struct PrivateTunnel {
    handle: Option<Handle>,
}

impl PrivateTunnel {
    /// 터널을 끄고 꺼질 때까지 기다린다. 앱이 띄우지 않은 터널이면 아무것도 하지 않는다.
    pub(crate) async fn stop(self) {
        if let Some(handle) = self.handle {
            handle.stop().await;
        }
    }
}

enum Command {
    /// 멈춘(Failed, External) 터널을 처음부터 다시 시작한다.
    Start,
    /// 시작 중이면 멈춘다.
    Cancel,
    /// 끄고 task를 끝낸다.
    Stop,
}

/// supervisor task에 닿는 손잡이.
#[derive(Clone)]
struct Handle {
    state: watch::Receiver<TunnelState>,
    commands: mpsc::UnboundedSender<Command>,
    /// task가 끝나면 true가 된다.
    done: watch::Receiver<bool>,
}

impl Handle {
    fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }

    async fn stop(&self) {
        self.send(Command::Stop);
        self.finished().await;
    }

    async fn finished(&self) {
        let mut done = self.done.clone();
        let _ = done.wait_for(|done| *done).await;
    }
}

struct Entry {
    id: u64,
    target: TunnelTarget,
    leases: usize,
    stopping: bool,
    handle: Handle,
}

#[derive(Default)]
struct Table {
    entries: HashMap<String, Entry>,
    privates: HashMap<u64, Handle>,
    last_id: u64,
}

pub(crate) struct Tunnels<R: TunnelRunner> {
    runner: Arc<R>,
    sink: TunnelSink,
    table: Arc<Mutex<Table>>,
}

/// 기다림을 끝내도 되는 상태인가.
fn settled(state: &TunnelState) -> bool {
    matches!(
        state,
        TunnelState::Ready | TunnelState::External | TunnelState::Failed(_)
    )
}

impl<R: TunnelRunner> Tunnels<R> {
    pub(crate) fn new(runner: R, sink: TunnelSink) -> Self {
        Self {
            runner: Arc::new(runner),
            sink,
            table: Arc::default(),
        }
    }

    /// 그 접속의 터널이 열릴 때까지(Ready나 External) 기다리고 lease를 준다.
    ///
    /// 같은 이름의 터널이 다른 대상이거나 끄는 중이면 그 터널이 꺼질 때까지 기다린 뒤 새로 시작한다.
    /// 멈춘 터널은 처음부터 다시 시작한다.
    pub(crate) async fn acquire(
        &self,
        connection: &str,
        target: &TunnelTarget,
    ) -> Result<TunnelLease, TunnelError> {
        let (lease, mut state, handle) = loop {
            let joined = {
                let mut table = self.table.lock().unwrap();
                match table.entries.get_mut(connection) {
                    Some(entry) if entry.stopping || entry.target != *target => {
                        Err(entry.handle.clone())
                    }
                    Some(entry) => {
                        entry.leases += 1;
                        Ok((entry.id, entry.handle.clone()))
                    }
                    None => {
                        table.last_id += 1;
                        let id = table.last_id;
                        let handle = self.spawn(Some((connection, id)), target);
                        table.entries.insert(
                            connection.to_string(),
                            Entry {
                                id,
                                target: target.clone(),
                                leases: 1,
                                stopping: false,
                                handle: handle.clone(),
                            },
                        );
                        Ok((id, handle))
                    }
                }
            };
            match joined {
                Ok((id, handle)) => {
                    let lease = TunnelLease {
                        connection: connection.to_string(),
                        entry: id,
                    };
                    break (lease, handle.state.clone(), handle);
                }
                // 옛 터널이 꺼질 때까지 기다린 뒤 다시 본다.
                Err(old) => old.finished().await,
            }
        };

        // 멈춘 터널이면 다시 시작하고, 그 뒤의 새 결과를 기다린다.
        let current = state.borrow_and_update().clone();
        let restart = match current {
            TunnelState::Failed(_) => true,
            TunnelState::External => !self.runner.is_open(&target.host, target.port).await,
            _ => false,
        };
        if restart {
            handle.send(Command::Start);
        }
        let outcome = wait_settled(&mut state, restart).await;
        match outcome {
            TunnelState::Ready | TunnelState::External => Ok(lease),
            TunnelState::Failed(failure) => {
                self.release(lease).await;
                Err(tunnel_error(target, failure))
            }
            _ => unreachable!("wait_settled는 settled 상태만 돌려준다"),
        }
    }

    /// lease를 돌려준다. 마지막 lease면 터널을 끄고(앱이 띄우지 않은 터널은 잊기만 한다) 꺼질 때까지
    /// 기다린다.
    pub(crate) async fn release(&self, lease: TunnelLease) {
        let stopping = {
            let mut table = self.table.lock().unwrap();
            let Some(entry) = table
                .entries
                .get_mut(&lease.connection)
                .filter(|entry| entry.id == lease.entry)
            else {
                return;
            };
            entry.leases -= 1;
            if entry.leases > 0 || entry.stopping {
                None
            } else {
                entry.stopping = true;
                Some(entry.handle.clone())
            }
        };
        if let Some(handle) = stopping {
            handle.stop().await;
        }
    }

    /// 시작 중이면 멈추고 기다리던 acquire를 모두 Cancelled로 끝낸다.
    pub(crate) async fn cancel(&self, connection: &str) {
        if let Some(handle) =
            self.handle_in(connection, |s| matches!(s, TunnelState::Starting { .. }))
        {
            handle.send(Command::Cancel);
        }
    }

    /// 멈춘(Failed) 터널을 처음부터 다시 시작한다. lease가 없거나 멈추지 않았으면 아무것도 하지 않는다.
    pub(crate) async fn restart(&self, connection: &str) {
        if let Some(handle) = self.handle_in(connection, |s| matches!(s, TunnelState::Failed(_))) {
            handle.send(Command::Start);
        }
    }

    fn handle_in(&self, connection: &str, wanted: impl Fn(&TunnelState) -> bool) -> Option<Handle> {
        let table = self.table.lock().unwrap();
        let entry = table.entries.get(connection)?;
        (!entry.stopping && entry.leases > 0 && wanted(&entry.handle.state.borrow()))
            .then(|| entry.handle.clone())
    }

    /// 공유하지 않는 터널을 띄운다(접속 테스트). 포트가 이미 열려 있으면 아무것도 띄우지 않는다.
    pub(crate) async fn start_private(
        &self,
        target: &TunnelTarget,
    ) -> Result<PrivateTunnel, TunnelError> {
        let (id, handle) = {
            let mut table = self.table.lock().unwrap();
            table.last_id += 1;
            let id = table.last_id;
            let handle = self.spawn(None, target);
            table.privates.insert(id, handle.clone());
            (id, handle)
        };
        let mut state = handle.state.clone();
        let outcome = wait_settled(&mut state, false).await;
        match outcome {
            TunnelState::Ready | TunnelState::External => Ok(PrivateTunnel {
                handle: Some(handle),
            }),
            TunnelState::Failed(failure) => {
                handle.stop().await;
                self.table.lock().unwrap().privates.remove(&id);
                Err(tunnel_error(target, failure))
            }
            _ => unreachable!("wait_settled는 settled 상태만 돌려준다"),
        }
    }

    /// 모든 터널(시작 중, 재실행 중, 접속 테스트의 터널 포함)을 끄고 꺼질 때까지 기다린다. 기다리던
    /// acquire는 Cancelled로 끝난다. 그 뒤의 acquire는 평소처럼 새로 시작한다.
    pub(crate) async fn stop_all(&self) {
        let handles: Vec<Handle> = {
            let mut table = self.table.lock().unwrap();
            let mut handles: Vec<Handle> = table.privates.drain().map(|(_, h)| h).collect();
            for entry in table.entries.values_mut() {
                entry.stopping = true;
                handles.push(entry.handle.clone());
            }
            handles
        };
        for handle in &handles {
            handle.send(Command::Stop);
        }
        for handle in &handles {
            handle.finished().await;
        }
    }

    /// supervisor task를 띄운다. `shared`가 없으면 접속 테스트의 터널이다(event 없음, 재실행 없음).
    fn spawn(&self, shared: Option<(&str, u64)>, target: &TunnelTarget) -> Handle {
        let (state_tx, state) = watch::channel(TunnelState::Starting {
            attempt: 0,
            timeout: target.timeout,
        });
        let (commands, receiver) = mpsc::unbounded_channel();
        let (done_tx, done) = watch::channel(false);
        let supervisor = Supervisor {
            runner: self.runner.clone(),
            target: target.clone(),
            shared: shared.map(|(name, id)| Shared {
                connection: name.to_string(),
                entry: id,
                sink: self.sink.clone(),
                table: self.table.clone(),
            }),
            state: state_tx,
            commands: receiver,
            last_published: None,
        };
        tokio::spawn(async move {
            supervisor.run().await;
            let _ = done_tx.send(true);
        });
        Handle {
            state,
            commands,
            done,
        }
    }
}

fn tunnel_error(target: &TunnelTarget, failure: TunnelFailure) -> TunnelError {
    TunnelError {
        host: target.host.clone(),
        port: target.port,
        failure,
    }
}

/// settled 상태를 기다린다. `fresh`면 지금 값은 보지 않고 바뀐 뒤의 값만 본다.
/// supervisor가 끝나 버렸으면 Cancelled다.
async fn wait_settled(state: &mut watch::Receiver<TunnelState>, fresh: bool) -> TunnelState {
    if !fresh && settled(&state.borrow_and_update()) {
        return state.borrow().clone();
    }
    loop {
        if state.changed().await.is_err() {
            let last = state.borrow().clone();
            return if settled(&last) {
                last
            } else {
                TunnelState::Failed(TunnelFailure::Cancelled)
            };
        }
        let current = state.borrow_and_update().clone();
        if settled(&current) {
            return current;
        }
    }
}

/// 공유하는 터널만 갖는 것.
struct Shared {
    connection: String,
    entry: u64,
    sink: TunnelSink,
    table: Arc<Mutex<Table>>,
}

struct Supervisor<R: TunnelRunner> {
    runner: Arc<R>,
    target: TunnelTarget,
    shared: Option<Shared>,
    state: watch::Sender<TunnelState>,
    commands: mpsc::UnboundedReceiver<Command>,
    /// 마지막으로 sink에 보낸 상태.
    last_published: Option<TunnelState>,
}

/// 시작 한 번의 결과.
enum Started<P> {
    Ready(P),
    External,
    Failed(TunnelFailure),
    /// Stop을 받았다.
    Stopped,
}

/// 멈춘 동안 받은 명령.
enum Idle {
    Start,
    Stop,
}

impl<R: TunnelRunner> Supervisor<R> {
    async fn run(mut self) {
        let mut attempt = 0;
        loop {
            match self.start(attempt).await {
                Started::Ready(mut process) => {
                    process.mark_ready();
                    self.publish(TunnelState::Ready);
                    if !self.watch(&mut process).await {
                        process.stop().await;
                        return self.finish();
                    }
                    // 끊겼다. 남은 자손을 정리하고 다시 실행한다.
                    process.stop().await;
                    if self.shared.is_none() {
                        self.publish(TunnelState::Failed(TunnelFailure::Exited {
                            code: None,
                            output: String::new(),
                        }));
                        return self.wait_stop().await;
                    }
                    attempt = 1;
                }
                Started::External => {
                    self.publish(TunnelState::External);
                    match self.idle().await {
                        Idle::Start => attempt = 0,
                        Idle::Stop => return self.finish(),
                    }
                }
                Started::Failed(failure) => {
                    let restarting =
                        (1..MAX_RESTARTS).contains(&attempt) && failure != TunnelFailure::Cancelled;
                    if restarting {
                        attempt += 1;
                        continue;
                    }
                    self.publish(TunnelState::Failed(failure));
                    match self.idle().await {
                        Idle::Start => attempt = 0,
                        Idle::Stop => return self.finish(),
                    }
                }
                Started::Stopped => return self.finish(),
            }
        }
    }

    /// 명령을 실행하고 포트가 열리기를 기다린다. 다시 실행이면(`attempt` ≥ 1) 먼저 조금 쉰다.
    async fn start(&mut self, attempt: u8) -> Started<R::Process> {
        self.publish(TunnelState::Starting {
            attempt,
            timeout: self.target.timeout,
        });
        if attempt > 0 {
            let until = Instant::now() + RESTART_DELAY;
            loop {
                tokio::select! {
                    () = sleep_until(until) => break,
                    command = self.commands.recv() => match command {
                        Some(Command::Stop) | None => return Started::Stopped,
                        Some(Command::Cancel) => return Started::Failed(TunnelFailure::Cancelled),
                        Some(Command::Start) => {}
                    },
                }
            }
        }
        let TunnelTarget {
            command,
            dir,
            host,
            port,
            timeout,
        } = &self.target;
        if self.runner.is_open(host, *port).await {
            return Started::External;
        }
        let mut process = match self.runner.spawn(command, dir) {
            Ok(process) => process,
            Err(error) => {
                return Started::Failed(TunnelFailure::Spawn {
                    message: error.message,
                });
            }
        };
        let deadline = Instant::now() + *timeout;
        loop {
            tokio::select! {
                biased;
                command = self.commands.recv() => match command {
                    Some(Command::Stop) | None => {
                        process.stop().await;
                        return Started::Stopped;
                    }
                    Some(Command::Cancel) => {
                        process.stop().await;
                        return Started::Failed(TunnelFailure::Cancelled);
                    }
                    Some(Command::Start) => {}
                },
                code = process.wait() => {
                    let output = process.output();
                    process.stop().await;
                    return Started::Failed(TunnelFailure::Exited { code, output });
                }
                () = sleep_until(deadline) => {
                    let output = process.output();
                    process.stop().await;
                    return Started::Failed(TunnelFailure::Timeout {
                        secs: timeout.as_secs(),
                        output,
                    });
                }
                () = sleep(PORT_POLL) => {
                    if self.runner.is_open(host, *port).await {
                        return Started::Ready(process);
                    }
                }
            }
        }
    }

    /// 열린 터널을 지켜본다. 끊기면 true, Stop을 받으면 false.
    async fn watch(&mut self, process: &mut R::Process) -> bool {
        loop {
            tokio::select! {
                _ = process.wait() => return true,
                command = self.commands.recv() => match command {
                    Some(Command::Stop) | None => return false,
                    Some(Command::Cancel | Command::Start) => {}
                },
            }
        }
    }

    async fn idle(&mut self) -> Idle {
        loop {
            match self.commands.recv().await {
                Some(Command::Start) => return Idle::Start,
                Some(Command::Stop) | None => return Idle::Stop,
                Some(Command::Cancel) => {}
            }
        }
    }

    async fn wait_stop(mut self) {
        while let Some(command) = self.commands.recv().await {
            if matches!(command, Command::Stop) {
                break;
            }
        }
        self.finish();
    }

    fn publish(&mut self, state: TunnelState) {
        self.state.send_replace(state.clone());
        if let Some(shared) = &self.shared {
            (shared.sink)(TunnelEvent {
                connection: shared.connection.clone(),
                state: state.clone(),
            });
        }
        self.last_published = Some(state);
    }

    /// 프로세스를 다 정리한 뒤 부른다. 표에서 이 터널을 지우고 Stopped를 알린다. 실패로 멈춘
    /// 터널이면 그 실패를 화면에 남기려고 Stopped를 보내지 않는다.
    fn finish(mut self) {
        if !settled(&self.state.borrow()) {
            self.state
                .send_replace(TunnelState::Failed(TunnelFailure::Cancelled));
        }
        let failed = matches!(
            &self.last_published,
            Some(TunnelState::Failed(failure)) if *failure != TunnelFailure::Cancelled
        );
        if let Some(shared) = self.shared.take() {
            {
                let mut table = shared.table.lock().unwrap();
                if table
                    .entries
                    .get(&shared.connection)
                    .is_some_and(|entry| entry.id == shared.entry)
                {
                    table.entries.remove(&shared.connection);
                }
            }
            if !failed {
                (shared.sink)(TunnelEvent {
                    connection: shared.connection,
                    state: TunnelState::Stopped,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests;
