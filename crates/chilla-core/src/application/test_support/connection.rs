//! 가짜 DB 연결: 결과 stream, cancel, 트랜잭션 상태를 test가 밖에서 조작한다.

use std::collections::{HashMap, VecDeque};
use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::{OwnedRwLockWriteGuard, RwLock, watch};

use super::numbered;
use crate::application::{CancelError, DbConnection, QueryCancel, QueryError, RowItem, RowSource};
use crate::domain::{
    Catalog, Column, EditTable, RelationDdl, Row, ServerError, TableDetails, TxStatus, TypeInfo,
};

/// 가짜 연결 하나를 test가 밖에서 보고 조작하는 손잡이.
#[derive(Clone, Default)]
pub(crate) struct FakeLink {
    closed: Arc<AtomicBool>,
    lost: Arc<AtomicBool>,
    lost_during_tx_status: Arc<AtomicBool>,
    queries: Arc<Mutex<FakeQueries>>,
    /// write guard를 누가 갖고 있으면 cancel이 끝나지 않는다.
    cancel_gate: Arc<RwLock<()>>,
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
    /// 다음 `start_query`가 돌려줄 오류.
    start_error: Option<QueryError>,
    /// 다음 `simple_execute`가 돌려줄 서버 오류의 code.
    simple_error: Option<String>,
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
            start_error: None,
            simple_error: None,
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

    /// `start_query`와 `simple_execute`가 받은 SQL, 받은 순서대로.
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

    /// 돌려준 guard를 drop할 때까지 cancel이 끝나지 않게 한다(답이 늦은 cancel 요청).
    /// 서버 쪽 효과(끝나지 않은 결과를 57014로 끝내기)는 cancel을 부르는 즉시 일어난다.
    pub(crate) async fn hold_cancels(&self) -> OwnedRwLockWriteGuard<()> {
        self.cancel_gate.clone().write_owned().await
    }

    /// 다음 `start_query` 한 번이 `error`로 실패하게 한다.
    pub(crate) fn fail_next_start(&self, error: QueryError) {
        self.queries().start_error = Some(error);
    }

    /// 다음 `simple_execute` 한 번이 `code`의 서버 오류로 실패하게 한다. 트랜잭션 상태는 바꾸지 않는다.
    pub(crate) fn fail_next_simple(&self, code: &str) {
        self.queries().simple_error = Some(code.into());
    }

    /// `tx_status`가 돌려줄 값. 처음에는 `Idle`이다.
    pub(crate) fn set_tx(&self, tx: TxStatus) {
        self.queries().tx = tx;
    }
}

/// 가짜 연결들이 함께 보는 catalog. `FakeConnector`가 갖고 연결마다 나눠 준다.
#[derive(Default)]
pub(crate) struct FakeCatalog {
    pub(crate) catalog: Catalog,
    pub(crate) details: HashMap<u32, TableDetails>,
    /// `read_ddl`이 아는 relation. 없는 OID는 `None`이다.
    pub(crate) ddls: HashMap<u32, RelationDdl>,
    /// `describe_types`가 아는 type.
    pub(crate) types: Vec<TypeInfo>,
    /// `describe_tables`가 아는 table.
    pub(crate) tables: Vec<EditTable>,
    /// 다음 읽기(`read_catalog`, `read_table_details`, `read_ddl`, `describe_types`,
    /// `describe_tables`)들이 차례로
    /// 돌려줄 오류.
    pub(crate) failures: VecDeque<QueryError>,
    /// `read_catalog`가 불린 횟수.
    pub(crate) reads: usize,
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

    /// 항목을 넣는다. 끝난 결과에는 넣지 않는다(서버도 끝낸 결과에 더 보내지 않는다). 넣었으면 true다.
    fn put(&self, item: Result<RowItem, QueryError>, end: bool) -> bool {
        self.state.send_if_modified(|state| {
            if state.ended {
                return false;
            }
            state.items.push_back(item);
            state.ended = end;
            true
        })
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

    /// `(이름, type OID, typmod)`를 그대로 넘긴다.
    pub(crate) fn columns(&self, columns: &[(&str, u32, i32)]) {
        let columns = columns
            .iter()
            .map(|&(name, type_oid, type_modifier)| Column {
                name: name.to_string(),
                type_oid,
                type_modifier,
                table_oid: 0,
                column_number: 0,
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

    /// 끝나지 않은 결과면 "57014"(query_canceled)를 넣고 끝낸다. 문장이 돌던 중이었으면 true다.
    fn interrupt(&self) -> bool {
        self.put(Err(QueryError::Server(server_error("57014"))), true)
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

/// 서버처럼 끝나지 않은 결과에 "57014"(query_canceled)를 넣고 끝낸다. 트랜잭션 안에서 문장을
/// 멈추면 서버처럼 트랜잭션을 failed로 만든다.
pub(crate) struct FakeCancel(FakeLink);

impl QueryCancel for FakeCancel {
    async fn cancel(self) -> Result<(), CancelError> {
        let result = self.send();
        let _held = self.0.cancel_gate.read().await;
        result
    }
}

impl FakeCancel {
    /// 서버 쪽 효과. `FakeLink::hold_cancels`와 관계없이 바로 일어난다.
    fn send(&self) -> Result<(), CancelError> {
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
        let mut interrupted = false;
        for feed in &queries.started {
            interrupted |= feed.interrupt();
        }
        if interrupted && queries.tx == TxStatus::InTransaction {
            queries.tx = TxStatus::Failed;
        }
        Ok(())
    }
}

/// `FakeConnection::server_version`이 돌려주는 값.
pub(crate) const FAKE_SERVER_VERSION: &str = "18.6";

pub(crate) struct FakeConnection {
    pub(crate) pid: i32,
    pub(crate) link: FakeLink,
    /// 닫힐 때 `"db close"`를 남길 곳.
    pub(crate) log: Option<Arc<Mutex<Vec<&'static str>>>>,
    pub(crate) catalog: Arc<Mutex<FakeCatalog>>,
}

impl FakeConnection {
    /// 끊긴 연결이면 `ConnectionLost`, 아니면 예약한 오류.
    fn catalog_failure(&self, catalog: &mut FakeCatalog) -> Option<QueryError> {
        if self.is_closed() {
            return Some(QueryError::ConnectionLost {
                message: "가짜 연결이 끊겼다".into(),
            });
        }
        catalog.failures.pop_front()
    }
}

impl DbConnection for FakeConnection {
    type Rows = FakeRows;
    type Cancel = FakeCancel;

    fn backend_pid(&self) -> i32 {
        self.pid
    }

    fn server_version(&self) -> &str {
        FAKE_SERVER_VERSION
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
        if let Some(error) = queries.start_error.take() {
            return Err(error);
        }
        // 실제 연결처럼 NUL이 든 text는 보내지 못한다. 연결은 그대로다.
        if sql.contains('\0') {
            return Err(QueryError::Client {
                message: "가짜: text에 NUL이 있다".into(),
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

    /// 성공하면 서버처럼 트랜잭션 상태를 바꾼다: `BEGIN`(뒤에 `SAVEPOINT`가 붙어도)과
    /// `ROLLBACK TO SAVEPOINT` 뒤에는 `InTransaction`, `COMMIT`과 `ROLLBACK` 뒤에는 `Idle`이다.
    async fn simple_execute(&self, sql: &str) -> Result<(), QueryError> {
        let mut queries = self.link.queries();
        queries.sent.push(sql.to_string());
        if self.is_closed() {
            return Err(QueryError::ConnectionLost {
                message: "가짜 연결이 끊겼다".into(),
            });
        }
        if let Some(code) = queries.simple_error.take() {
            return Err(QueryError::Server(server_error(&code)));
        }
        if sql.starts_with("BEGIN") || sql.starts_with("ROLLBACK TO SAVEPOINT") {
            queries.tx = TxStatus::InTransaction;
        } else if sql == "COMMIT" || sql == "ROLLBACK" {
            queries.tx = TxStatus::Idle;
        }
        Ok(())
    }

    async fn read_catalog(&self) -> Result<Catalog, QueryError> {
        let mut catalog = self.catalog.lock().unwrap();
        catalog.reads += 1;
        match self.catalog_failure(&mut catalog) {
            Some(error) => Err(error),
            None => Ok(catalog.catalog.clone()),
        }
    }

    async fn read_table_details(&self, relation: u32) -> Result<TableDetails, QueryError> {
        let mut catalog = self.catalog.lock().unwrap();
        match self.catalog_failure(&mut catalog) {
            Some(error) => Err(error),
            None => Ok(catalog.details.get(&relation).cloned().unwrap_or_default()),
        }
    }

    async fn read_ddl(&self, relation: u32) -> Result<Option<RelationDdl>, QueryError> {
        let mut catalog = self.catalog.lock().unwrap();
        match self.catalog_failure(&mut catalog) {
            Some(error) => Err(error),
            None => Ok(catalog.ddls.get(&relation).cloned()),
        }
    }

    async fn describe_types(&self, types: &[(u32, i32)]) -> Result<Vec<TypeInfo>, QueryError> {
        let mut catalog = self.catalog.lock().unwrap();
        match self.catalog_failure(&mut catalog) {
            Some(error) => Err(error),
            None => Ok(types
                .iter()
                .filter_map(|&(oid, modifier)| {
                    catalog
                        .types
                        .iter()
                        .find(|info| info.oid == oid && info.modifier == modifier)
                        .cloned()
                })
                .collect()),
        }
    }

    async fn describe_tables(&self, oids: &[u32]) -> Result<Vec<EditTable>, QueryError> {
        let mut catalog = self.catalog.lock().unwrap();
        match self.catalog_failure(&mut catalog) {
            Some(error) => Err(error),
            None => Ok(catalog
                .tables
                .iter()
                .filter(|table| oids.contains(&table.oid))
                .cloned()
                .collect()),
        }
    }

    fn cancel_handle(&self) -> FakeCancel {
        FakeCancel(self.link.clone())
    }

    async fn close(self) {
        self.link.closed.store(true, Ordering::SeqCst);
        if let Some(log) = &self.log {
            log.lock().unwrap().push("db close");
        }
    }
}
