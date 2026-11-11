//! 세션 하나. DB 연결 하나를 혼자 갖는 task다 (탭 = 세션).
//!
//! 연결을 task 하나가 가지므로 한 세션의 명령은 순서대로 처리된다. 쿼리는 한 번에 하나이고,
//! 받다 만 결과도 이 task가 갖는다. 결과는 batch 하나를 보낸 뒤 `fetch_more`가 올 때까지
//! 읽지 않는다(backpressure).

mod query;

use std::future::pending;
use std::ops::ControlFlow;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until, timeout};

use self::query::{DrainReason, Pending, Query};
use super::{CancelError, DbConnection, QueryCancel, QueryError, RowItem, RowSource};
use crate::domain::{QueryEvent, QueryId, QueryLimits, QueryOutcome, SessionState, TxStatus};

const COMMAND_BUFFER: usize = 8;

/// cancel이 끝난 뒤 이만큼 지나도 결과가 끝나지 않으면 cancel을 다시 보낸다.
const CANCEL_RESEND: Duration = Duration::from_secs(1);

/// 세션을 닫을 때 쿼리의 결과가 끝나기를 기다리는 최대 시간.
const CLOSE_WAIT: Duration = Duration::from_secs(1);

/// 쿼리의 이벤트를 받는 쪽. session actor의 task 안에서 불린다. 오래 막으면 그 세션이 멈춘다.
pub type QuerySink = Box<dyn FnMut(QueryEvent) + Send + 'static>;

enum SessionCommand {
    State(oneshot::Sender<SessionState>),
    Execute {
        sql: String,
        sink: QuerySink,
        reply: oneshot::Sender<QueryId>,
    },
    FetchMore {
        query: QueryId,
        reply: oneshot::Sender<bool>,
    },
    Cancel {
        query: QueryId,
        reply: oneshot::Sender<Result<(), CancelError>>,
    },
    Close(oneshot::Sender<()>),
}

/// 세션 task에 명령을 보내는 손잡이. 모두 drop되면 task가 연결을 닫고 끝난다.
#[derive(Clone)]
pub(crate) struct SessionHandle {
    commands: mpsc::Sender<SessionCommand>,
}

pub(crate) fn spawn<D: DbConnection>(connection: D, limits: QueryLimits) -> SessionHandle {
    let (commands, receiver) = mpsc::channel(COMMAND_BUFFER);
    let actor = Actor {
        connection,
        limits,
        last_id: 0,
        tx: TxStatus::Idle,
        query: None,
        pending: None,
        cancel: None,
        resend_at: None,
    };
    tokio::spawn(actor.run(receiver));
    SessionHandle { commands }
}

/// loop가 기다리는 것 가운데 먼저 온 것.
enum Event {
    /// 명령. `None`이면 handle이 모두 drop됐다.
    Command(Option<SessionCommand>),
    /// 쿼리의 결과에서 읽은 항목.
    Item(Option<Result<RowItem, QueryError>>),
    /// spawn한 cancel이 끝났다.
    CancelDone,
    /// cancel을 다시 보낼 때가 됐다.
    Resend,
}

struct Actor<D: DbConnection> {
    connection: D,
    limits: QueryLimits,
    last_id: u64,
    /// 쿼리가 없을 때 마지막으로 읽은 트랜잭션 상태. 쿼리가 있는 동안 `State`는 이 값을 답한다.
    tx: TxStatus,
    query: Option<Query<D::Rows>>,
    /// 지금 쿼리를 버리는 동안 기다리는 다음 쿼리. `query`가 `Draining`일 때만 있다.
    pending: Option<Pending>,
    /// spawn한 cancel. 한 번에 하나만 있다.
    cancel: Option<JoinHandle<()>>,
    /// cancel을 다시 보낼 시각. `Draining`에서 cancel이 끝나고 결과는 끝나지 않았을 때만 있다.
    resend_at: Option<Instant>,
}

impl<D: DbConnection> Actor<D> {
    async fn run(mut self, mut commands: mpsc::Receiver<SessionCommand>) {
        loop {
            match self.next_event(&mut commands).await {
                Event::Command(Some(command)) => {
                    if let ControlFlow::Break(reply) = self.handle(command).await {
                        self.close().await;
                        let _ = reply.send(());
                        return;
                    }
                }
                Event::Command(None) => return self.close().await,
                Event::Item(item) => {
                    if let Some(query) = &mut self.query {
                        query.receive(item);
                    }
                    self.settle().await;
                }
                Event::CancelDone => {
                    self.cancel = None;
                    if self.query.as_ref().is_some_and(|query| !query.is_over()) {
                        self.resend_at = Some(Instant::now() + CANCEL_RESEND);
                    }
                    self.settle().await;
                }
                Event::Resend => {
                    self.resend_at = None;
                    self.send_cancel(None);
                }
            }
        }
    }

    /// 명령, cancel, 다시 보낼 시각, 결과의 다음 항목 가운데 먼저 온 것을 기다린다.
    ///
    /// 각 future는 기다리기만 하고 상태를 바꾸지 않으므로 다른 쪽이 먼저 와서 drop돼도 된다.
    async fn next_event(&mut self, commands: &mut mpsc::Receiver<SessionCommand>) -> Event {
        let rows = self.query.as_mut().and_then(Query::rows_to_read);
        tokio::select! {
            biased;
            command = commands.recv() => Event::Command(command),
            () = finished(&mut self.cancel) => Event::CancelDone,
            () = at(self.resend_at) => Event::Resend,
            item = next_item(rows) => Event::Item(item),
        }
    }

    /// 명령 하나를 처리한다. `Close`는 세션을 끝내야 하므로 처리하지 않고 그 답장을 `Break`로 돌려준다.
    async fn handle(&mut self, command: SessionCommand) -> ControlFlow<oneshot::Sender<()>> {
        match command {
            SessionCommand::State(reply) => {
                let state = self.state().await;
                let _ = reply.send(state);
            }
            SessionCommand::Execute { sql, sink, reply } => {
                self.last_id += 1;
                let id = QueryId(self.last_id);
                let _ = reply.send(id);
                self.execute(Pending { id, sql, sink }).await;
            }
            SessionCommand::FetchMore { query, reply } => {
                let current = self.query.as_mut().filter(|q| q.id == query);
                let _ = reply.send(current.is_some_and(Query::fetch_more));
            }
            SessionCommand::Cancel { query, reply } => {
                let current = self.query.as_mut().filter(|q| q.id == query);
                if current.is_some_and(|q| q.drain(DrainReason::Cancelled)) {
                    self.send_cancel(Some(reply));
                } else {
                    let _ = reply.send(Ok(()));
                }
            }
            SessionCommand::Close(reply) => return ControlFlow::Break(reply),
        }
        ControlFlow::Continue(())
    }

    async fn state(&mut self) -> SessionState {
        // 결과를 다 읽기 전에는 서버가 트랜잭션 상태를 알려 주지 않는다. 쿼리가 있으면 기다리지 않고
        // 마지막으로 읽은 값을 답한다.
        if self.query.is_none() && !self.connection.is_closed() {
            self.tx = self.connection.tx_status().await;
        }
        // 상태를 기다리는 사이에 연결이 끊길 수 있으므로 받은 뒤에 끊겼는지 본다.
        if self.connection.is_closed() {
            SessionState::Lost
        } else {
            SessionState::Open { tx: self.tx }
        }
    }

    async fn execute(&mut self, next: Pending) {
        let Some(query) = &mut self.query else {
            return self.start(next).await;
        };
        if query.drain(DrainReason::Discarded) {
            self.send_cancel(None);
        }
        if let Some(replaced) = self.pending.replace(next) {
            replaced.discard();
        }
    }

    /// 쿼리가 없을 때 다음 쿼리를 시작한다.
    async fn start(&mut self, mut next: Pending) {
        let started = Instant::now();
        match self.connection.start_query(&next.sql).await {
            Ok(rows) => self.query = Some(Query::new(next, rows, started, self.limits)),
            Err(error) => {
                let outcome = match error {
                    QueryError::ConnectionLost { message } => {
                        QueryOutcome::ConnectionLost { message }
                    }
                    QueryError::Server(error) => QueryOutcome::Failed(error),
                };
                let elapsed = started.elapsed();
                (next.sink)(QueryEvent::Finished { outcome, elapsed });
            }
        }
    }

    /// 결과가 끝났고 cancel도 끝났으면 쿼리를 마치고 기다리던 쿼리를 시작한다.
    ///
    /// cancel이 끝나기 전에 다음 쿼리를 보내면 늦게 닿은 cancel이 다음 쿼리를 멈출 수 있다.
    async fn settle(&mut self) {
        if self.cancel.is_some() {
            return;
        }
        let Some(query) = self.query.take_if(|query| query.is_over()) else {
            return;
        };
        self.resend_at = None;
        let lost = query.finish();
        if !lost {
            self.tx = self.connection.tx_status().await;
        }
        if let Some(next) = self.pending.take() {
            self.start(next).await;
        }
    }

    /// cancel을 spawn한다. `reply`가 있으면 그 결과를 답한다.
    fn send_cancel(&mut self, reply: Option<oneshot::Sender<Result<(), CancelError>>>) {
        debug_assert!(self.cancel.is_none(), "cancel은 한 번에 하나다");
        let cancel = self.connection.cancel_handle();
        self.resend_at = None;
        self.cancel = Some(tokio::spawn(async move {
            let result = cancel.cancel().await;
            if let Some(reply) = reply {
                let _ = reply.send(result);
            }
        }));
    }

    /// 쿼리를 멈추고 결과가 끝나기를 잠깐 기다린 뒤 연결을 닫는다.
    async fn close(mut self) {
        if let Some(mut query) = self.query.take() {
            if query.drain(DrainReason::Discarded) {
                self.send_cancel(None);
            }
            // cancel이 듣지 않으면 결과를 버려 둔 채 닫는다. 그 뒤로 이 연결에 `tx_status`를 부르지 않는다.
            let _ = timeout(CLOSE_WAIT, query.drain_to_end()).await;
            query.finish_closed();
        }
        if let Some(pending) = self.pending.take() {
            pending.discard();
        }
        self.connection.close().await;
    }
}

/// spawn한 cancel이 끝날 때까지 기다린다. 없으면 끝나지 않는다.
async fn finished(task: &mut Option<JoinHandle<()>>) {
    match task {
        Some(task) => {
            let _ = task.await;
        }
        None => pending().await,
    }
}

/// `deadline`까지 기다린다. 없으면 끝나지 않는다.
async fn at(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => sleep_until(deadline).await,
        None => pending().await,
    }
}

/// 결과의 다음 항목. 읽을 결과가 없으면 끝나지 않는다.
async fn next_item<R: RowSource>(rows: Option<&mut R>) -> Option<Result<RowItem, QueryError>> {
    match rows {
        Some(rows) => rows.next().await,
        None => pending().await,
    }
}

impl SessionHandle {
    /// task가 이미 끝났으면 `Lost`다.
    pub(crate) async fn state(&self) -> SessionState {
        self.request(SessionCommand::State)
            .await
            .unwrap_or(SessionState::Lost)
    }

    /// 연결이 닫힐 때까지 기다린다. task가 이미 끝났으면 바로 돌아온다.
    pub(crate) async fn close(self) {
        self.request(SessionCommand::Close).await;
    }

    /// 명령을 보내고 답을 기다린다. task가 끝났으면 `None`이다.
    async fn request<T>(
        &self,
        command: impl FnOnce(oneshot::Sender<T>) -> SessionCommand,
    ) -> Option<T> {
        let (reply, response) = oneshot::channel();
        self.commands.send(command(reply)).await.ok()?;
        response.await.ok()
    }

    /// 쿼리를 맡기고 바로 돌아온다. 결과는 `sink`로 간다. task가 끝났으면 `None`이다.
    pub(crate) async fn execute(&self, sql: String, sink: QuerySink) -> Option<QueryId> {
        self.request(|reply| SessionCommand::Execute { sql, sink, reply })
            .await
    }

    /// 받다 만 결과의 다음 batch를 읽게 한다. 그 쿼리가 지금 쿼리가 아니거나 버리는 중이면 `Some(false)`다.
    pub(crate) async fn fetch_more(&self, query: QueryId) -> Option<bool> {
        self.request(|reply| SessionCommand::FetchMore { query, reply })
            .await
    }

    /// 쿼리를 멈추고 남은 결과를 버린다. cancel 요청이 서버에 닿은 뒤 돌아온다.
    /// 그 쿼리가 지금 쿼리가 아니면 아무것도 하지 않고 `Some(Ok(()))`다.
    pub(crate) async fn cancel(&self, query: QueryId) -> Option<Result<(), CancelError>> {
        self.request(|reply| SessionCommand::Cancel { query, reply })
            .await
    }
}

#[cfg(test)]
mod tests;
