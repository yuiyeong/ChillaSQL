//! 세션 하나. DB 연결 하나를 혼자 갖는 task다 (탭 = 세션).
//!
//! 연결을 task 하나가 가지므로 한 세션의 명령은 순서대로 처리된다. 쿼리는 한 번에 하나이고,
//! 받다 만 결과도 이 task가 갖는다. 결과는 batch 하나를 보낸 뒤 `fetch_more`가 올 때까지
//! 읽지 않는다(backpressure). `fetch_more`가 `idle_result_timeout` 동안 오지 않으면 결과를 닫는다.
//!
//! 결과를 버릴 때는 cancel한다. cancel이 닿은 문장은 실패하므로 트랜잭션 안이면 트랜잭션이 failed가
//! 된다. 그래서 트랜잭션 안의 문장 앞에는 savepoint를 두고, 버리거나 취소한 문장은 cancel이 끝난 뒤
//! 그 savepoint로 되돌려 트랜잭션을 열린 채로 둔다([`savepoint`]).

mod edit;
mod query;
mod savepoint;

use std::collections::VecDeque;
use std::future::pending;
use std::ops::ControlFlow;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until, timeout};

use self::query::{DrainReason, Pending, Query};
use super::{CancelError, DbConnection, QueryCancel, QueryError, RowItem, RowSource};
use crate::domain::{
    ApplyResult, EndOutcome, EndResult, QueryEvent, QueryId, QueryLimits, QueryOutcome,
    SessionState, TxEnd, TxMode, TxStatus,
};

const COMMAND_BUFFER: usize = 8;

/// cancel이 끝난 뒤 이만큼 지나도 결과가 끝나지 않으면 cancel을 다시 보낸다.
const CANCEL_RESEND: Duration = Duration::from_secs(1);

/// 세션을 닫을 때 쿼리의 결과가 끝나기를 기다리는 최대 시간.
const CLOSE_WAIT: Duration = Duration::from_secs(1);

/// 사용자의 취소에 cancel 결과를 답하는 곳.
type CancelReply = oneshot::Sender<Result<(), CancelError>>;

/// 쿼리의 이벤트를 받는 쪽. session actor의 task 안에서 불린다. 오래 막으면 그 세션이 멈춘다.
pub type QuerySink = Box<dyn FnMut(QueryEvent) + Send + 'static>;

enum SessionCommand {
    State(oneshot::Sender<SessionState>),
    Execute {
        sql: String,
        mode: TxMode,
        first_batch_only: bool,
        sink: QuerySink,
        reply: oneshot::Sender<QueryId>,
    },
    End {
        end: TxEnd,
        reply: oneshot::Sender<EndResult>,
    },
    Apply {
        statements: Vec<String>,
        mode: TxMode,
        reply: oneshot::Sender<ApplyResult>,
    },
    FetchMore {
        query: QueryId,
        reply: oneshot::Sender<bool>,
    },
    Cancel {
        query: QueryId,
        reply: CancelReply,
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
        savepoint_on_top: false,
        query: None,
        pending: None,
        ends: VecDeque::new(),
        cancel: None,
        cancel_at: None,
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
    /// cancel을 보낼 때가 됐다.
    CancelDue,
    /// 받다 만 결과를 닫을 때가 됐다.
    Expired,
}

struct Actor<D: DbConnection> {
    connection: D,
    limits: QueryLimits,
    last_id: u64,
    /// 쿼리가 없을 때 마지막으로 읽은 트랜잭션 상태. 쿼리가 있는 동안 `State`는 이 값을 답한다.
    /// 쿼리 앞에 `BEGIN`이나 savepoint를 두었으면 그 쿼리가 도는 동안은 `InTransaction`이다.
    tx: TxStatus,
    /// 세션이 둔 savepoint가 맨 위에 남아 있다. 다음 문장 앞에서 풀고 새로 둔다. 모르면 false이고,
    /// 그때는 풀지 않고 새로 둔다(없는 savepoint를 풀면 트랜잭션이 failed가 된다).
    savepoint_on_top: bool,
    query: Option<Query<D::Rows>>,
    /// 지금 쿼리를 버리는 동안 기다리는 다음 쿼리. `query`가 `Draining`일 때만 있다.
    pending: Option<Pending>,
    /// 지금 쿼리를 버리는 동안 기다리는 끝내기. 온 순서대로 `pending`보다 먼저 실행한다.
    /// `query`가 `Draining`일 때만 있다.
    ends: VecDeque<(TxEnd, oneshot::Sender<EndResult>)>,
    /// spawn한 cancel. 한 번에 하나만 있다.
    cancel: Option<JoinHandle<()>>,
    /// cancel을 다시 보낼 시각. `Draining`이고 cancel이 끝났는데 결과는 끝나지 않았을 때만 있다.
    cancel_at: Option<Instant>,
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
                        self.cancel_at = Some(Instant::now() + CANCEL_RESEND);
                    }
                    self.settle().await;
                }
                Event::CancelDue => self.send_cancel(None),
                Event::Expired => self.discard(DrainReason::Expired, false, None),
            }
        }
    }

    /// 명령, cancel, cancel을 보낼 시각, 결과를 닫을 시각, 결과의 다음 항목 가운데 먼저 온 것을 기다린다.
    ///
    /// 각 future는 기다리기만 하고 상태를 바꾸지 않으므로 다른 쪽이 먼저 와서 drop돼도 된다.
    async fn next_event(&mut self, commands: &mut mpsc::Receiver<SessionCommand>) -> Event {
        let expires_at = self.query.as_ref().and_then(Query::expires_at);
        let rows = self.query.as_mut().and_then(Query::rows_to_read);
        tokio::select! {
            biased;
            command = commands.recv() => Event::Command(command),
            () = finished(&mut self.cancel) => Event::CancelDone,
            () = at(self.cancel_at) => Event::CancelDue,
            () = at(expires_at) => Event::Expired,
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
            SessionCommand::Execute {
                sql,
                mode,
                first_batch_only,
                sink,
                reply,
            } => {
                self.last_id += 1;
                let id = QueryId(self.last_id);
                let _ = reply.send(id);
                self.execute(Pending {
                    id,
                    sql,
                    mode,
                    first_batch_only,
                    sink,
                })
                .await;
            }
            SessionCommand::End { end, reply } => {
                if self.query.is_none() {
                    let result = self.end_transaction(end).await;
                    let _ = reply.send(result);
                } else {
                    self.discard(DrainReason::Discarded, false, None);
                    self.ends.push_back((end, reply));
                }
            }
            SessionCommand::Apply {
                statements,
                mode,
                reply,
            } => {
                let result = self.apply(&statements, mode).await;
                let _ = reply.send(result);
            }
            SessionCommand::FetchMore { query, reply } => {
                if let Some(current) = self.query.as_mut().filter(|q| q.id == query) {
                    current.fetch_more();
                }
                // look-ahead 때문에 화면은 이미 끝난 쿼리에 fetch_more를 보낼 수 있다. 이 세션이
                // 만든 쿼리면 무엇이든 받아들인다.
                let _ = reply.send((1..=self.last_id).contains(&query.0));
            }
            SessionCommand::Cancel { query, reply } => {
                if let Some(waiting) = self.pending.take_if(|p| p.id == query) {
                    // 아직 서버에 보내지 않았으므로 cancel 요청 없이 빼기만 한다.
                    waiting.finish(QueryOutcome::Cancelled);
                    let _ = reply.send(Ok(()));
                } else if self.query.as_ref().is_some_and(|q| q.id == query) {
                    // 이미 버리던 중이어도 cancel이 가고 있지 않으면 다시 보낸다.
                    self.discard(DrainReason::Cancelled, true, Some(reply));
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
        if self.query.is_none() {
            return self.start(next).await;
        }
        self.discard(DrainReason::Discarded, false, None);
        if let Some(replaced) = self.pending.replace(next) {
            replaced.finish(QueryOutcome::Discarded);
        }
    }

    /// 쿼리가 없을 때 다음 쿼리를 시작한다. Manual이고 트랜잭션 밖이면 먼저 `BEGIN`을 보낸다.
    /// 트랜잭션 안이 되는 문장 앞에는 savepoint를 함께 둔다. 실패한 트랜잭션의 문장은 바로 `25P02`로
    /// 끝나므로 두지 않는다. `BEGIN`이나 savepoint가 실패하면 쿼리를 보내지 않고 그 오류로 마친다.
    async fn start(&mut self, mut next: Pending) {
        let started = Instant::now();
        let plain = savepoint::runs_without_savepoint(&next.sql);
        let (prepare, savepoint) = match self.tx {
            TxStatus::Idle if next.mode == TxMode::Manual && plain => (Some("BEGIN"), false),
            TxStatus::Idle if next.mode == TxMode::Manual => (Some(savepoint::BEGIN_AND_SET), true),
            TxStatus::InTransaction if !plain && self.savepoint_on_top => {
                (Some(savepoint::RENEW), true)
            }
            TxStatus::InTransaction if !plain => (Some(savepoint::SET), true),
            _ => (None, false),
        };
        // 새로 두기 전까지는 맨 위가 세션의 savepoint인지 모른다. 사용자의 문장은 그 위에 savepoint를
        // 두거나 그것을 풀 수 있다.
        self.savepoint_on_top = false;
        let prepared = match prepare {
            Some(sql) => self.connection.simple_execute(sql).await,
            None => Ok(()),
        };
        if prepared.is_ok() && prepare.is_some() {
            self.tx = TxStatus::InTransaction;
            self.savepoint_on_top = savepoint;
        }
        let rows = match prepared {
            Ok(()) => self.connection.start_query(&next.sql).await,
            Err(error) => Err(error),
        };
        match rows {
            Ok(rows) => {
                let query = Query::new(next, rows, started, self.limits, savepoint);
                self.query = Some(query);
            }
            Err(error) => {
                let outcome = QueryOutcome::from(error);
                let elapsed = started.elapsed();
                let lost = matches!(outcome, QueryOutcome::ConnectionLost { .. });
                let tx = self.read_tx(lost).await;
                (next.sink)(QueryEvent::Finished {
                    outcome,
                    elapsed,
                    tx,
                });
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
        let Some(mut query) = self.query.take_if(|query| query.is_over()) else {
            return;
        };
        self.cancel_at = None;
        if query.needs_undo() {
            // 버린 문장은 어떻게 끝났든(cancel이 늦어 끝까지 돌았어도) 되돌린다. 실패하면(사용자가
            // savepoint를 풀었거나 그 앞으로 되돌린 경우) 서버가 알려 주는 상태를 그대로 둔다.
            let undone = self.connection.simple_execute(savepoint::UNDO).await;
            self.savepoint_on_top &= undone.is_ok();
            query.undone(undone);
        }
        // `Finished`에 싣기 전에 읽는다. 결과를 다 읽은 뒤라 서버의 ReadyForQuery가 온다.
        let tx = self.read_tx(query.is_lost()).await;
        query.finish(tx);
        while let Some((end, reply)) = self.ends.pop_front() {
            let result = self.end_transaction(end).await;
            let _ = reply.send(result);
        }
        if let Some(next) = self.pending.take() {
            self.start(next).await;
        }
    }

    /// 쿼리가 없을 때 트랜잭션을 끝낸다. 실패한 트랜잭션의 Commit은 보내지 않는다. 서버는 그
    /// `COMMIT`을 `ROLLBACK`으로 처리하므로 보내면 Commit이 된 것처럼 보인다.
    ///
    /// 끊긴 연결이면 마지막으로 읽은 상태는 죽은 연결의 것이므로 보지 않는다. 연결이 그 문장을
    /// 보내지 못하고 `ConnectionLost`로 답한다.
    async fn end_transaction(&mut self, end: TxEnd) -> EndResult {
        self.savepoint_on_top = false;
        if end == TxEnd::Commit && self.tx == TxStatus::Failed && !self.connection.is_closed() {
            return EndResult {
                outcome: EndOutcome::TransactionFailed,
                tx: Some(self.tx),
            };
        }
        let outcome = match self.connection.simple_execute(end.sql()).await {
            Ok(()) => EndOutcome::Ended,
            Err(error) => error.into(),
        };
        let lost = matches!(outcome, EndOutcome::ConnectionLost { .. });
        let tx = self.read_tx(lost).await;
        EndResult { outcome, tx }
    }

    /// 서버가 알려 주는 트랜잭션 상태를 읽고 `self.tx`에 남긴다. 쿼리가 없을 때만 부른다.
    /// 방금 끝난 일이 연결이 끊겨서 끝났으면(`lost`) 죽은 연결에 묻지 않고 `None`이다. 읽는 사이에
    /// 연결이 끊겼어도 그 값은 죽은 연결의 것이므로 `None`이다.
    async fn read_tx(&mut self, lost: bool) -> Option<TxStatus> {
        if lost {
            return None;
        }
        let tx = self.connection.tx_status().await;
        if self.connection.is_closed() {
            return None;
        }
        self.tx = tx;
        Some(tx)
    }

    /// 지금 쿼리를 버리기 시작하고 cancel한다. 트랜잭션 안의 문장은 결과가 끝난 뒤 `settle`이
    /// savepoint로 되돌린다.
    ///
    /// 이미 버리는 중이면 `force_cancel`일 때만 cancel을 다시 보낸다. 다만 cancel이 이미 가고 있거나
    /// 결과가 끝났으면 보내지 않는다. cancel하면 `reply`에 그 결과를, 하지 않으면 바로 `Ok`를 답한다.
    fn discard(&mut self, reason: DrainReason, force_cancel: bool, reply: Option<CancelReply>) {
        let Some(query) = &mut self.query else {
            return answer(reply);
        };
        let resend = force_cancel && self.cancel.is_none() && !query.is_over();
        if query.drain(reason) || resend {
            self.send_cancel(reply);
        } else {
            answer(reply);
        }
    }

    /// cancel을 spawn한다. `reply`가 있으면 그 결과를 답한다.
    fn send_cancel(&mut self, reply: Option<CancelReply>) {
        debug_assert!(self.cancel.is_none(), "cancel은 한 번에 하나다");
        let cancel = self.connection.cancel_handle();
        self.cancel_at = None;
        self.cancel = Some(tokio::spawn(async move {
            let result = cancel.cancel().await;
            if let Some(reply) = reply {
                let _ = reply.send(result);
            }
        }));
    }

    /// 쿼리를 멈추고 결과가 끝나기를 잠깐 기다린 뒤 연결을 닫는다. 연결을 닫으면 트랜잭션은
    /// 어차피 되돌아가므로 savepoint로 되돌리지 않는다.
    async fn close(mut self) {
        self.discard(DrainReason::Discarded, true, None);
        if let Some(mut query) = self.query.take() {
            // cancel이 듣지 않으면 결과를 버려 둔 채 닫는다. 그 뒤로 이 연결에 `tx_status`를 부르지 않는다.
            let _ = timeout(CLOSE_WAIT, query.drain_to_end()).await;
            query.finish_closed();
        }
        if let Some(pending) = self.pending.take() {
            pending.finish(QueryOutcome::Discarded);
        }
        self.connection.close().await;
    }
}

/// cancel 없이 끝난 취소에 바로 `Ok`를 답한다.
fn answer(reply: Option<CancelReply>) {
    if let Some(reply) = reply {
        let _ = reply.send(Ok(()));
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
    /// `first_batch_only`이면 `Columns`와 첫 batch만 보내고 나머지 행은 끝까지 읽어서 버린다.
    pub(crate) async fn execute(
        &self,
        sql: String,
        mode: TxMode,
        first_batch_only: bool,
        sink: QuerySink,
    ) -> Option<QueryId> {
        self.request(|reply| SessionCommand::Execute {
            sql,
            mode,
            first_batch_only,
            sink,
            reply,
        })
        .await
    }

    /// 트랜잭션을 끝내고 그 결과를 돌려준다. 지금 쿼리가 있으면 버리고 그 쿼리가 끝난 뒤, 기다리던
    /// 다음 쿼리보다 먼저 실행한다. task가 끝났으면(세션을 닫는 중 포함) `None`이다.
    pub(crate) async fn end_transaction(&self, end: TxEnd) -> Option<EndResult> {
        self.request(|reply| SessionCommand::End { end, reply })
            .await
    }

    /// 셀 편집의 UPDATE를 한 단위로 보내고 결과를 돌려준다. 열린 쿼리가 있으면 보내지 않고 `Busy`다.
    /// task가 끝났으면 `None`이다.
    pub(crate) async fn apply_edits(
        &self,
        statements: Vec<String>,
        mode: TxMode,
    ) -> Option<ApplyResult> {
        self.request(|reply| SessionCommand::Apply {
            statements,
            mode,
            reply,
        })
        .await
    }

    /// 받다 만 결과의 다음 batch를 읽게 한다. 이 세션이 만든 쿼리면 `Some(true)`다. 지금 쿼리가
    /// `Paused`일 때만 읽기를 이어 가고, 버리는 중이거나 기다리거나 이미 끝난 쿼리면 아무것도 하지
    /// 않는다. 이 세션이 만든 적 없는 쿼리면 `Some(false)`다.
    pub(crate) async fn fetch_more(&self, query: QueryId) -> Option<bool> {
        self.request(|reply| SessionCommand::FetchMore { query, reply })
            .await
    }

    /// 쿼리를 멈추고 남은 결과를 버린다. cancel 요청이 서버에 닿은 뒤 돌아온다.
    /// 앞 쿼리를 버리는 동안 기다리는 쿼리면 보내지 않고 `Cancelled`로 마친다(cancel 요청은 없다).
    /// 그 밖의 쿼리(끝났거나 모르는 쿼리)면 아무것도 하지 않고 `Some(Ok(()))`다.
    pub(crate) async fn cancel(&self, query: QueryId) -> Option<Result<(), CancelError>> {
        self.request(|reply| SessionCommand::Cancel { query, reply })
            .await
    }
}

#[cfg(test)]
mod tests;
