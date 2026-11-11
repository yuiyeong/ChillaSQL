//! 가짜 DB 연결: 결과 stream, cancel, 트랜잭션 상태를 test가 밖에서 조작한다.

use std::collections::VecDeque;
use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::watch;

use super::numbered;
use crate::application::{CancelError, DbConnection, QueryCancel, QueryError, RowItem, RowSource};
use crate::domain::{Column, Row, ServerError, TxStatus};

/// 가짜 연결 하나를 test가 밖에서 보고 조작하는 손잡이.
#[derive(Clone, Default)]
pub(crate) struct FakeLink {
    closed: Arc<AtomicBool>,
    lost: Arc<AtomicBool>,
    lost_during_tx_status: Arc<AtomicBool>,
    queries: Arc<Mutex<FakeQueries>>,
}

/// 가짜 연결이 받은 쿼리와 cancel.
struct FakeQueries {
    expected: VecDeque<FakeFeed>,
    sent: Vec<String>,
    /// `start_query`가 돌려준 결과 가운데 `None`까지 읽히지 않은 것. cancel과 `tx_status`가 본다.
    started: Vec<FakeFeed>,
    cancels: usize,
    fail_cancels: bool,
    ignore_cancels: usize,
    tx: TxStatus,
}

impl Default for FakeQueries {
    fn default() -> Self {
        Self {
            expected: VecDeque::new(),
            sent: Vec::new(),
            started: Vec::new(),
            cancels: 0,
            fail_cancels: false,
            ignore_cancels: 0,
            tx: TxStatus::Idle,
        }
    }
}

impl FakeLink {
    /// `DbConnection::close`가 불렸는가.
    pub(crate) fn closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// 연결이 밖에서 끊긴 것처럼 만든다.
    pub(crate) fn lose(&self) {
        self.lost.store(true, Ordering::SeqCst);
        // 결과를 기다리는 `tx_status`가 끊긴 것을 보게 깨운다.
        for feed in &self.queries().started {
            feed.state.send_modify(|_| {});
        }
    }

    /// 트랜잭션 상태를 기다리는 동안 연결이 끊기게 한다.
    pub(crate) fn lose_during_tx_status(&self) {
        self.lost_during_tx_status.store(true, Ordering::SeqCst);
    }

    fn queries(&self) -> std::sync::MutexGuard<'_, FakeQueries> {
        self.queries.lock().unwrap()
    }

    /// 다음 `start_query`가 돌려줄 결과를 예약한다(FIFO). 예약이 없으면 `Complete { rows: 0 }`만 있는 결과다.
    pub(crate) fn expect_query(&self) -> FakeFeed {
        let feed = FakeFeed::new(self.lost.clone());
        self.queries().expected.push_back(feed.clone());
        feed
    }

    /// `start_query`가 받은 SQL, 받은 순서대로.
    pub(crate) fn sent(&self) -> Vec<String> {
        self.queries().sent.clone()
    }

    /// `QueryCancel::cancel`이 불린 횟수.
    pub(crate) fn cancels(&self) -> usize {
        self.queries().cancels
    }

    /// 이후의 cancel이 `Err(CancelError)`를 돌려주고 아무것도 하지 않게 한다.
    pub(crate) fn fail_cancels(&self) {
        self.queries().fail_cancels = true;
    }

    /// 다음 `count`번의 cancel이 `Ok(())`를 돌려주되 결과를 끝내지 않게 한다(쿼리보다 먼저 닿은 cancel).
    pub(crate) fn ignore_cancels(&self, count: usize) {
        self.queries().ignore_cancels = count;
    }

    /// `tx_status`가 돌려줄 값. 처음에는 `Idle`이다.
    pub(crate) fn set_tx(&self, tx: TxStatus) {
        self.queries().tx = tx;
    }
}

/// `code`만 채운 서버 오류. `message`는 `code`와 같다.
pub(crate) fn server_error(code: &str) -> ServerError {
    ServerError {
        code: code.into(),
        message: code.into(),
        detail: None,
        hint: None,
        position: None,
    }
}

/// 가짜 결과 하나의 항목.
#[derive(Default)]
struct FeedState {
    items: VecDeque<Result<RowItem, QueryError>>,
    /// 마지막 항목을 넣었다. 남은 항목을 다 읽으면 `next`가 `None`이다.
    ended: bool,
    /// `next`가 `None`을 돌려줬다. 실제 연결에서 ReadyForQuery가 지나간 때다.
    finished: bool,
}

/// 가짜 결과 하나에 항목을 넣는 손잡이. Clone이다.
#[derive(Clone)]
pub(crate) struct FakeFeed {
    state: Arc<watch::Sender<FeedState>>,
    /// 결과를 만든 연결의 `lost`. `lose`가 연결도 끊는다.
    link_lost: Arc<AtomicBool>,
}

impl FakeFeed {
    fn new(link_lost: Arc<AtomicBool>) -> Self {
        Self {
            state: Arc::new(watch::Sender::new(FeedState::default())),
            link_lost,
        }
    }

    /// 항목을 넣는다. 끝난 결과에는 넣지 않는다(서버도 끝낸 결과에 더 보내지 않는다).
    fn put(&self, item: Result<RowItem, QueryError>, end: bool) {
        self.state.send_if_modified(|state| {
            if state.ended {
                return false;
            }
            state.items.push_back(item);
            state.ended = end;
            true
        });
    }

    fn is_finished(&self) -> bool {
        self.state.borrow().finished
    }

    /// `None`까지 읽히거나 연결이 끊길 때까지 기다린다.
    async fn finished(&self) {
        let mut state = self.state.subscribe();
        // sender는 `self`가 갖고 있어 닫히지 않는다.
        let _ = state
            .wait_for(|state| state.finished || self.link_lost.load(Ordering::SeqCst))
            .await;
    }

    /// 다음 항목. 끝나지 않은 결과에서는 항목이 올 때까지 기다린다.
    async fn take(&self) -> Option<Result<RowItem, QueryError>> {
        let mut state = self.state.subscribe();
        let _ = state
            .wait_for(|state| !state.items.is_empty() || state.ended)
            .await;
        let mut item = None;
        self.state.send_if_modified(|state| {
            item = state.items.pop_front();
            // 끝난 결과의 마지막 `None`. `tx_status`를 기다리는 쪽을 깨운다.
            let finishing = item.is_none() && !state.finished;
            state.finished |= item.is_none();
            finishing
        });
        item
    }

    pub(crate) fn columns(&self, names: &[&str]) {
        let columns = names.iter().map(|name| Column {
            name: name.to_string(),
        });
        self.push(Ok(RowItem::Columns(columns.collect())));
    }

    /// [`numbered`]의 행을 넣는다.
    pub(crate) fn rows(&self, range: Range<u64>) {
        for row in numbered(range) {
            self.row(row);
        }
    }

    pub(crate) fn row(&self, row: Row) {
        self.push(Ok(RowItem::Row(row)));
    }

    /// `Complete { rows }`를 넣고 결과를 끝낸다.
    pub(crate) fn complete(&self, rows: u64) {
        self.put(Ok(RowItem::Complete { rows }), true);
    }

    /// 항목 하나를 그대로 넣는다. 결과를 끝내지 않는다.
    pub(crate) fn push(&self, item: Result<RowItem, QueryError>) {
        self.put(item, false);
    }

    /// `Err(Server(server_error(code)))`를 넣고 결과를 끝낸다.
    pub(crate) fn fail(&self, code: &str) {
        self.put(Err(QueryError::Server(server_error(code))), true);
    }

    /// `Err(ConnectionLost)`를 넣고 결과를 끝낸다. 연결도 끊긴 것으로 만든다(`is_closed` == true).
    pub(crate) fn lose(&self) {
        // `put`이 깨운 `tx_status`가 끊긴 것을 보도록 먼저 끊는다.
        self.link_lost.store(true, Ordering::SeqCst);
        let message = "가짜 연결이 끊겼다".to_string();
        self.put(Err(QueryError::ConnectionLost { message }), true);
    }

    /// 넣었지만 아직 읽히지 않은 항목 수.
    pub(crate) fn unread(&self) -> usize {
        self.state.borrow().items.len()
    }
}

pub(crate) struct FakeRows(FakeFeed);

impl RowSource for FakeRows {
    async fn next(&mut self) -> Option<Result<RowItem, QueryError>> {
        self.0.take().await
    }
}

/// 서버처럼 끝나지 않은 결과에 "57014"(query_canceled)를 넣고 끝낸다.
pub(crate) struct FakeCancel(FakeLink);

impl QueryCancel for FakeCancel {
    async fn cancel(self) -> Result<(), CancelError> {
        let mut queries = self.0.queries();
        queries.cancels += 1;
        if queries.fail_cancels {
            return Err(CancelError {
                message: "가짜 cancel 실패".into(),
            });
        }
        if queries.ignore_cancels > 0 {
            queries.ignore_cancels -= 1;
            return Ok(());
        }
        for feed in &queries.started {
            feed.fail("57014");
        }
        Ok(())
    }
}

pub(crate) struct FakeConnection {
    pub(crate) pid: i32,
    pub(crate) link: FakeLink,
}

impl DbConnection for FakeConnection {
    type Rows = FakeRows;
    type Cancel = FakeCancel;

    fn backend_pid(&self) -> i32 {
        self.pid
    }

    /// `None`까지 읽히지 않은 결과가 있으면 다 읽힐 때까지 기다린다. 끊긴 연결에서는 바로
    /// 돌아온다(실제 연결도 tap이 drop되면 기다리지 않는다).
    ///
    /// 실제 연결보다 엄격하다. 실제 연결은 ErrorResponse 뒤에만 ReadyForQuery를 기다리고, 그
    /// 밖에는 마지막으로 본 상태를 바로 돌려준다. 이 가짜는 결과를 다 읽기 전에 부른 `tx_status`를
    /// 언제나 기다리게 해서, session actor가 결과를 다 읽기 전에 `tx_status`를 부르는 실수를 test가
    /// 잡게 한다.
    async fn tx_status(&self) -> TxStatus {
        if self.link.lost_during_tx_status.load(Ordering::SeqCst) {
            self.link.lose();
        }
        let started = self.link.queries().started.clone();
        for feed in started {
            feed.finished().await;
        }
        self.link.queries().tx
    }

    fn is_closed(&self) -> bool {
        self.link.lost.load(Ordering::SeqCst)
    }

    async fn start_query(&self, sql: &str) -> Result<FakeRows, QueryError> {
        let mut queries = self.link.queries();
        queries.sent.push(sql.to_string());
        if self.is_closed() {
            return Err(QueryError::ConnectionLost {
                message: "가짜 연결이 끊겼다".into(),
            });
        }
        let feed = queries.expected.pop_front().unwrap_or_else(|| {
            let feed = FakeFeed::new(self.link.lost.clone());
            feed.complete(0);
            feed
        });
        // 다 읽힌 결과는 cancel과 `tx_status`가 볼 일이 없다.
        queries.started.retain(|feed| !feed.is_finished());
        queries.started.push(feed.clone());
        Ok(FakeRows(feed))
    }

    fn cancel_handle(&self) -> FakeCancel {
        FakeCancel(self.link.clone())
    }

    async fn close(self) {
        self.link.closed.store(true, Ordering::SeqCst);
    }
}
