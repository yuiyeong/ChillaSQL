use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::{Instant, timeout};

use super::*;
use crate::application::test_support::{
    FakeConnection, FakeFeed, FakeLink, next, numbered, server_error, sink,
};
use crate::domain::{
    Column, EndOutcome, EndResult, QueryEvent, QueryId, QueryLimits, QueryOutcome, RowBatch, TxEnd,
    TxMode, TxStatus,
};

fn session() -> (SessionHandle, FakeLink) {
    session_with(QueryLimits::default())
}

fn session_with(limits: QueryLimits) -> (SessionHandle, FakeLink) {
    let link = FakeLink::default();
    let connection = FakeConnection {
        pid: 42,
        link: link.clone(),
        log: None,
    };
    (spawn(connection, limits), link)
}

/// 50ms 동안 이벤트가 없음을 확인한다.
async fn quiet(events: &mut UnboundedReceiver<QueryEvent>) {
    if let Ok(event) = timeout(Duration::from_millis(50), events.recv()).await {
        panic!("이벤트가 없어야 하는데 왔다: {event:?}");
    }
}

fn batch(event: QueryEvent) -> RowBatch {
    match event {
        QueryEvent::Rows(batch) => batch,
        other => panic!("Rows가 아니다: {other:?}"),
    }
}

fn outcome(event: QueryEvent) -> QueryOutcome {
    match event {
        QueryEvent::Finished { outcome, .. } => outcome,
        other => panic!("Finished가 아니다: {other:?}"),
    }
}

fn finished_tx(event: QueryEvent) -> Option<TxStatus> {
    match event {
        QueryEvent::Finished { tx, .. } => tx,
        other => panic!("Finished가 아니다: {other:?}"),
    }
}

async fn eventually(check: impl Fn() -> bool) -> bool {
    for _ in 0..100 {
        if check() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    check()
}

#[tokio::test]
async fn reports_open_then_lost() {
    let (handle, link) = session();
    assert_eq!(
        handle.state().await,
        SessionState::Open { tx: TxStatus::Idle }
    );
    link.lose();
    assert_eq!(handle.state().await, SessionState::Lost);
}

/// 상태를 기다리는 사이에 연결이 끊겼으면 기다린 끝에 받은 상태는 죽은 연결의 것이다.
#[tokio::test]
async fn connection_lost_while_reading_status_is_lost() {
    let (handle, link) = session();
    link.lose_during_tx_status();
    assert_eq!(handle.state().await, SessionState::Lost);
}

#[tokio::test]
async fn close_closes_the_connection_before_returning() {
    let (handle, link) = session();
    let other = handle.clone();
    handle.close().await;
    assert!(link.closed());
    // 이미 끝난 세션의 handle은 멈추지 않고 Lost를 돌려주고, close는 그냥 끝난다.
    assert_eq!(other.state().await, SessionState::Lost);
    other.close().await;
}

#[tokio::test]
async fn dropping_every_handle_closes_the_connection() {
    let (handle, link) = session();
    drop(handle);
    assert!(eventually(|| link.closed()).await);
}

#[tokio::test]
async fn small_result_arrives_as_one_batch_then_finishes() {
    let (handle, link) = session();
    let feed = link.expect_query();
    feed.columns(&["id"]);
    feed.rows(0..3);
    feed.complete(3);
    let (sink, mut events) = sink();
    let query = handle.execute("SELECT 1".into(), TxMode::Auto, sink).await;
    assert_eq!(query, Some(QueryId(1)));

    let id = Column { name: "id".into() };
    assert_eq!(next(&mut events).await, QueryEvent::Columns(vec![id]));
    assert_eq!(link.sent(), ["SELECT 1"]);
    let rows = batch(next(&mut events).await);
    assert_eq!(
        (rows.first_row, rows.rows, rows.retained_from),
        (0, numbered(0..3), 0)
    );
    let finished = outcome(next(&mut events).await);
    assert_eq!(finished, QueryOutcome::Completed { rows: 3 });

    let (sink, _events) = self::sink();
    let query = handle.execute("SELECT 2".into(), TxMode::Auto, sink).await;
    assert_eq!(query, Some(QueryId(2)));
}

#[tokio::test]
async fn statement_without_rows_finishes_with_the_count() {
    let (handle, link) = session();
    link.expect_query().complete(3);
    let (sink, mut events) = sink();
    handle
        .execute("DELETE FROM t".into(), TxMode::Auto, sink)
        .await;
    let finished = outcome(next(&mut events).await);
    assert_eq!(finished, QueryOutcome::Completed { rows: 3 });
    // 끝난 쿼리의 sink는 drop된다. 그 사이 다른 이벤트는 없다.
    let rest = timeout(Duration::from_secs(1), events.recv()).await;
    assert_eq!(rest.expect("sink가 drop되지 않았다"), None);
}

#[tokio::test]
async fn rows_arrive_500_at_a_time_and_wait_for_fetch_more() {
    let (handle, link) = session();
    let feed = link.expect_query();
    feed.columns(&["n"]);
    feed.rows(0..1200);
    feed.complete(1200);
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT n".into(), TxMode::Auto, sink)
        .await
        .unwrap();

    assert!(matches!(next(&mut events).await, QueryEvent::Columns(_)));
    let rows = batch(next(&mut events).await);
    assert_eq!((rows.first_row, rows.rows.len()), (0, 500));
    quiet(&mut events).await;
    // look-ahead로 501개째 행까지 읽었다. 남은 것은 699행과 Complete다.
    assert_eq!(feed.unread(), 700);

    assert_eq!(handle.fetch_more(query).await, Some(true));
    let rows = batch(next(&mut events).await);
    assert_eq!((rows.first_row, rows.rows.len()), (500, 500));
    assert_eq!(rows.rows, numbered(500..1000));
    quiet(&mut events).await;

    assert_eq!(handle.fetch_more(query).await, Some(true));
    let rows = batch(next(&mut events).await);
    assert_eq!((rows.first_row, rows.rows.len()), (1000, 200));
    let finished = outcome(next(&mut events).await);
    assert_eq!(finished, QueryOutcome::Completed { rows: 1200 });
}

#[tokio::test]
async fn result_of_exactly_500_rows_finishes_without_fetch_more() {
    let (handle, link) = session();
    let feed = link.expect_query();
    feed.rows(0..500);
    feed.complete(500);
    let (sink, mut events) = sink();
    handle.execute("SELECT n".into(), TxMode::Auto, sink).await;

    let rows = batch(next(&mut events).await);
    assert_eq!((rows.first_row, rows.rows.len()), (0, 500));
    let finished = outcome(next(&mut events).await);
    assert_eq!(finished, QueryOutcome::Completed { rows: 500 });
}

/// look-ahead 행을 기다리는 동안 온 `fetch_more`는 잃지 않는다. 화면은 batch를 받은 뒤
/// 세션이 `Paused`가 됐는지 알 수 없다.
#[tokio::test]
async fn fetch_more_during_the_look_ahead_is_not_lost() {
    let (handle, link) = session();
    let feed = link.expect_query();
    feed.rows(0..500);
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT n".into(), TxMode::Auto, sink)
        .await
        .unwrap();

    assert_eq!(batch(next(&mut events).await).rows.len(), 500);
    // 501개째 항목이 아직 없어 look-ahead가 끝나지 않았다.
    assert_eq!(handle.fetch_more(query).await, Some(true));
    feed.rows(500..1000);
    feed.rows(1000..1001);
    let rows = batch(next(&mut events).await);
    assert_eq!((rows.first_row, rows.rows.len()), (500, 500));
    quiet(&mut events).await;
}

/// Review Focus 1
#[tokio::test]
async fn wide_rows_end_a_batch_early() {
    let limits = QueryLimits {
        batch_rows: 500,
        batch_bytes: 1000,
        ..QueryLimits::default()
    };
    let (handle, link) = session_with(limits);
    let feed = link.expect_query();
    for _ in 0..5 {
        feed.row(vec![Some("x".repeat(400))]);
    }
    feed.complete(5);
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT wide".into(), TxMode::Auto, sink)
        .await
        .unwrap();

    let rows = batch(next(&mut events).await);
    assert_eq!((rows.first_row, rows.rows.len()), (0, 3));
    quiet(&mut events).await;
    assert_eq!(handle.fetch_more(query).await, Some(true));
    let rows = batch(next(&mut events).await);
    assert_eq!((rows.first_row, rows.rows.len()), (3, 2));
    let finished = outcome(next(&mut events).await);
    assert_eq!(finished, QueryOutcome::Completed { rows: 5 });
}

#[tokio::test]
async fn retained_from_moves_once_the_cap_is_passed() {
    let limits = QueryLimits {
        batch_rows: 2,
        retained_rows: 4,
        ..QueryLimits::default()
    };
    let (handle, link) = session_with(limits);
    let feed = link.expect_query();
    feed.rows(0..7);
    feed.complete(7);
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT n".into(), TxMode::Auto, sink)
        .await
        .unwrap();

    let mut seen = Vec::new();
    let finished = loop {
        match next(&mut events).await {
            QueryEvent::Rows(rows) => {
                seen.push((rows.first_row, rows.retained_from));
                handle.fetch_more(query).await;
            }
            QueryEvent::Finished { outcome, .. } => break outcome,
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(seen, [(0, 0), (2, 0), (4, 2), (6, 3)]);
    assert_eq!(finished, QueryOutcome::Completed { rows: 7 });
}

#[tokio::test]
async fn fetch_more_for_another_query_is_refused() {
    let (handle, link) = session();
    let feed = link.expect_query();
    feed.rows(0..600);
    feed.complete(600);
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT n".into(), TxMode::Auto, sink)
        .await
        .unwrap();

    batch(next(&mut events).await);
    assert_eq!(handle.fetch_more(QueryId(99)).await, Some(false));
    assert_eq!(handle.fetch_more(query).await, Some(true));
    batch(next(&mut events).await);
    outcome(next(&mut events).await);
    // 화면은 look-ahead 때문에 끝난 쿼리에 fetch_more를 보낼 수 있다. 오류가 아니다.
    assert_eq!(handle.fetch_more(query).await, Some(true));
    assert_eq!(handle.fetch_more(QueryId(99)).await, Some(false));
}

#[tokio::test]
async fn fetch_more_is_accepted_for_every_query_this_session_issued() {
    let (handle, link) = session();
    link.fail_cancels();
    link.expect_query();
    let (sink_a, _events_a) = sink();
    let (sink_b, _events_b) = sink();
    let a = handle
        .execute("A".into(), TxMode::Auto, sink_a)
        .await
        .unwrap();
    let b = handle
        .execute("B".into(), TxMode::Auto, sink_b)
        .await
        .unwrap();

    // A는 버리는 중이고 B는 기다린다.
    assert_eq!(handle.fetch_more(a).await, Some(true));
    assert_eq!(handle.fetch_more(b).await, Some(true));
    assert_eq!(handle.fetch_more(QueryId(0)).await, Some(false));
    assert_eq!(handle.fetch_more(QueryId(3)).await, Some(false));
}

#[tokio::test]
async fn server_error_keeps_the_rows_received_before_it() {
    let (handle, link) = session();
    let feed = link.expect_query();
    feed.columns(&["n"]);
    feed.rows(0..3);
    feed.fail("22012");
    let (sink, mut events) = sink();
    handle
        .execute("SELECT 1/(n-3)".into(), TxMode::Auto, sink)
        .await;

    assert!(matches!(next(&mut events).await, QueryEvent::Columns(_)));
    assert_eq!(batch(next(&mut events).await).rows, numbered(0..3));
    let finished = outcome(next(&mut events).await);
    assert_eq!(finished, QueryOutcome::Failed(server_error("22012")));
}

/// client 오류(UTF-8이 아닌 값 등)는 서버 오류처럼 다룬다. 결과를 끝까지 읽고 연결은 계속 쓴다.
#[tokio::test]
async fn client_error_keeps_the_rows_received_before_it() {
    let (handle, link) = session();
    let feed = link.expect_query();
    feed.columns(&["n"]);
    feed.rows(0..3);
    feed.push(Err(QueryError::Client {
        message: "m".into(),
    }));
    feed.complete(4);
    let (sink, mut events) = sink();
    handle.execute("SELECT n".into(), TxMode::Auto, sink).await;

    assert!(matches!(next(&mut events).await, QueryEvent::Columns(_)));
    assert_eq!(batch(next(&mut events).await).rows, numbered(0..3));
    let finished = outcome(next(&mut events).await);
    assert_eq!(
        finished,
        QueryOutcome::ClientError {
            message: "m".into()
        }
    );
    assert_eq!(feed.unread(), 0);
    assert_eq!(
        handle.state().await,
        SessionState::Open { tx: TxStatus::Idle }
    );
}

#[tokio::test]
async fn client_error_from_start_query_finishes_the_query() {
    let (handle, link) = session();
    let (sink, mut events) = sink();
    handle
        .execute("SELECT 1\0".into(), TxMode::Auto, sink)
        .await;

    let finished = outcome(next(&mut events).await);
    assert!(
        matches!(finished, QueryOutcome::ClientError { .. }),
        "{finished:?}"
    );
    assert_eq!(
        handle.state().await,
        SessionState::Open { tx: TxStatus::Idle }
    );
    let (sink, mut events) = self::sink();
    handle.execute("SELECT 1".into(), TxMode::Auto, sink).await;
    assert_eq!(
        outcome(next(&mut events).await),
        QueryOutcome::Completed { rows: 0 }
    );
    assert_eq!(link.sent(), ["SELECT 1\0", "SELECT 1"]);
}

#[tokio::test]
async fn next_execute_discards_the_previous_result() {
    let (handle, link) = session();
    link.expect_query().rows(0..1200);
    let feed_b = link.expect_query();
    feed_b.rows(0..1);
    feed_b.complete(1);
    let (sink_a, mut events_a) = sink();
    let (sink_b, mut events_b) = sink();

    handle.execute("A".into(), TxMode::Auto, sink_a).await;
    assert_eq!(batch(next(&mut events_a).await).rows.len(), 500);
    assert_eq!(
        handle.execute("B".into(), TxMode::Auto, sink_b).await,
        Some(QueryId(2))
    );

    assert_eq!(outcome(next(&mut events_a).await), QueryOutcome::Discarded);
    assert_eq!(link.cancels(), 1);
    assert_eq!(batch(next(&mut events_b).await).rows.len(), 1);
    let finished = outcome(next(&mut events_b).await);
    assert_eq!(finished, QueryOutcome::Completed { rows: 1 });
    assert_eq!(link.sent(), ["A", "B"]);
}

/// cancel이 끝나기 전에 다음 쿼리를 보내면 늦게 닿은 cancel이 다음 쿼리를 멈출 수 있다.
#[tokio::test]
async fn next_query_waits_for_the_cancel_in_flight() {
    let (handle, link) = session();
    let feed_a = link.expect_query();
    let (sink_a, mut events_a) = sink();
    let (sink_b, mut events_b) = sink();
    handle.execute("A".into(), TxMode::Auto, sink_a).await;
    let gate = link.hold_cancels().await;

    handle.execute("B".into(), TxMode::Auto, sink_b).await;
    // A의 결과는 57014로 끝났지만 cancel은 아직 끝나지 않았다.
    assert!(eventually(|| link.cancels() == 1).await);
    quiet(&mut events_a).await;
    assert_eq!(feed_a.unread(), 0);
    assert_eq!(link.sent(), ["A"]);

    drop(gate);
    assert_eq!(outcome(next(&mut events_a).await), QueryOutcome::Discarded);
    outcome(next(&mut events_b).await);
    assert_eq!(link.sent(), ["A", "B"]);
}

#[tokio::test]
async fn execute_while_draining_replaces_the_waiting_query() {
    let (handle, link) = session();
    link.fail_cancels();
    let feed_a = link.expect_query();
    let (sink_a, mut events_a) = sink();
    let (sink_b, mut events_b) = sink();
    let (sink_c, mut events_c) = sink();

    handle.execute("A".into(), TxMode::Auto, sink_a).await;
    handle.execute("B".into(), TxMode::Auto, sink_b).await;
    handle.execute("C".into(), TxMode::Auto, sink_c).await;
    assert_eq!(outcome(next(&mut events_b).await), QueryOutcome::Discarded);
    assert_eq!(link.sent(), ["A"]);
    // C는 이미 버리는 중인 A에 cancel을 더 보내지 않는다.
    quiet(&mut events_a).await;
    assert_eq!(link.cancels(), 1);

    // cancel이 실패해 A는 끝까지 돌았다. 버린 행이 없으므로 끝난 그대로 알린다.
    feed_a.complete(0);
    assert_eq!(
        outcome(next(&mut events_a).await),
        QueryOutcome::Completed { rows: 0 }
    );
    assert_eq!(
        outcome(next(&mut events_c).await),
        QueryOutcome::Completed { rows: 0 }
    );
    assert_eq!(link.sent(), ["A", "C"]);
}

#[tokio::test]
async fn cancel_ends_a_running_query_as_cancelled() {
    let (handle, link) = session();
    link.expect_query();
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT pg_sleep(10)".into(), TxMode::Auto, sink)
        .await
        .unwrap();
    quiet(&mut events).await;

    assert_eq!(handle.cancel(query).await, Some(Ok(())));
    assert_eq!(link.cancels(), 1);
    assert_eq!(outcome(next(&mut events).await), QueryOutcome::Cancelled);
}

#[tokio::test]
async fn cancel_of_a_half_read_result_drops_the_rest() {
    let (handle, link) = session();
    link.expect_query().rows(0..1200);
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT n".into(), TxMode::Auto, sink)
        .await
        .unwrap();

    assert_eq!(batch(next(&mut events).await).rows.len(), 500);
    assert_eq!(handle.cancel(query).await, Some(Ok(())));
    assert_eq!(outcome(next(&mut events).await), QueryOutcome::Cancelled);
}

/// 앞 쿼리를 버리는 동안 기다리는 쿼리를 취소하면 그 쿼리는 서버에 가지 않는다.
#[tokio::test]
async fn cancel_of_a_waiting_query_removes_it() {
    let (handle, link) = session();
    link.fail_cancels();
    let feed_a = link.expect_query();
    let (sink_a, mut events_a) = sink();
    let (sink_b, mut events_b) = sink();
    handle.execute("A".into(), TxMode::Auto, sink_a).await;
    let b = handle
        .execute("B".into(), TxMode::Auto, sink_b)
        .await
        .unwrap();

    assert_eq!(handle.cancel(b).await, Some(Ok(())));
    // 서버에 보내지 않았으므로 트랜잭션 상태를 모른다.
    assert_eq!(
        next(&mut events_b).await,
        QueryEvent::Finished {
            outcome: QueryOutcome::Cancelled,
            elapsed: Duration::ZERO,
            tx: None,
        }
    );
    assert_eq!(events_b.recv().await, None);

    feed_a.complete(0);
    outcome(next(&mut events_a).await);
    // 명령 하나가 지나가면 A를 마친 처리도 끝났다.
    handle.state().await;
    assert_eq!(link.sent(), ["A"]);
    assert_eq!(link.cancels(), 1);
}

#[tokio::test]
async fn cancel_of_a_finished_or_unknown_query_does_nothing() {
    let (handle, link) = session();
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT 1".into(), TxMode::Auto, sink)
        .await
        .unwrap();
    outcome(next(&mut events).await);

    assert_eq!(handle.cancel(query).await, Some(Ok(())));
    assert_eq!(handle.cancel(QueryId(99)).await, Some(Ok(())));
    assert_eq!(link.cancels(), 0);
}

#[tokio::test]
async fn failed_cancel_reports_the_error() {
    let (handle, link) = session();
    link.fail_cancels();
    let feed = link.expect_query();
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT pg_sleep(10)".into(), TxMode::Auto, sink)
        .await
        .unwrap();

    assert!(matches!(
        handle.cancel(query).await,
        Some(Err(CancelError { .. }))
    ));
    // cancel이 닿지 않아 문장이 끝까지 돌았다. 버린 행이 없으므로 끝난 그대로 알린다.
    feed.complete(0);
    assert_eq!(
        outcome(next(&mut events).await),
        QueryOutcome::Completed { rows: 0 }
    );
}

/// cancel보다 문장이 먼저 끝났으면(commit된 DELETE 등) 취소된 것이 아니다.
#[tokio::test]
async fn statement_that_completed_despite_cancel_is_completed() {
    let (handle, link) = session();
    link.ignore_cancels(1);
    let feed = link.expect_query();
    let (sink, mut events) = sink();
    let query = handle
        .execute("DELETE FROM t".into(), TxMode::Auto, sink)
        .await
        .unwrap();

    assert_eq!(handle.cancel(query).await, Some(Ok(())));
    feed.complete(3);
    assert_eq!(
        outcome(next(&mut events).await),
        QueryOutcome::Completed { rows: 3 }
    );
}

/// 서버가 결과를 끝냈어도 화면에 보내지 않고 버린 행이 있으면 취소된 것이다.
#[tokio::test]
async fn cancelled_select_with_dropped_rows_stays_cancelled() {
    let (handle, link) = session();
    let feed = link.expect_query();
    feed.rows(0..1200);
    feed.complete(1200);
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT n".into(), TxMode::Auto, sink)
        .await
        .unwrap();

    assert_eq!(batch(next(&mut events).await).rows.len(), 500);
    assert_eq!(handle.cancel(query).await, Some(Ok(())));
    assert_eq!(outcome(next(&mut events).await), QueryOutcome::Cancelled);
}

/// 버리는 중에 도착한 행도 버린 행이다. 버리기 시작할 때 batch는 비어 있었다.
#[tokio::test]
async fn rows_that_arrive_after_cancel_keep_the_query_cancelled() {
    let (handle, link) = session();
    link.ignore_cancels(1);
    let feed = link.expect_query();
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT n".into(), TxMode::Auto, sink)
        .await
        .unwrap();

    assert_eq!(handle.cancel(query).await, Some(Ok(())));
    feed.rows(0..3);
    feed.complete(3);
    assert_eq!(outcome(next(&mut events).await), QueryOutcome::Cancelled);
    assert_eq!(events.recv().await, None);
}

/// 버리기 시작할 때 보내지 않은 batch에 남은 look-ahead 행도 버린 행이다. 버리는 중에는 행이 오지 않는다.
#[tokio::test]
async fn look_ahead_row_dropped_by_cancel_keeps_the_query_cancelled() {
    let (handle, link) = session();
    link.ignore_cancels(1);
    let feed = link.expect_query();
    feed.rows(0..501);
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT n".into(), TxMode::Auto, sink)
        .await
        .unwrap();

    assert_eq!(batch(next(&mut events).await).rows.len(), 500);
    // 501번째 행(look-ahead)을 읽고 Paused가 됐다.
    quiet(&mut events).await;
    assert_eq!(feed.unread(), 0);

    assert_eq!(handle.cancel(query).await, Some(Ok(())));
    feed.complete(501);
    assert_eq!(outcome(next(&mut events).await), QueryOutcome::Cancelled);
    assert_eq!(events.recv().await, None);
}

/// cancel이 아닌 서버 오류(57014가 아닌 것)는 버리는 중에 와도 결과다.
#[tokio::test]
async fn real_error_during_drain_is_reported() {
    let (handle, link) = session();
    link.ignore_cancels(1);
    let feed = link.expect_query();
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT 1/0".into(), TxMode::Auto, sink)
        .await
        .unwrap();

    assert_eq!(handle.cancel(query).await, Some(Ok(())));
    feed.fail("22012");
    assert_eq!(
        outcome(next(&mut events).await),
        QueryOutcome::Failed(server_error("22012"))
    );
}

#[tokio::test(start_paused = true)]
async fn cancel_is_sent_again_when_the_query_outlives_it() {
    let (handle, link) = session();
    link.ignore_cancels(1);
    link.expect_query();
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT pg_sleep(10)".into(), TxMode::Auto, sink)
        .await
        .unwrap();

    assert_eq!(handle.cancel(query).await, Some(Ok(())));
    assert_eq!(link.cancels(), 1);
    quiet(&mut events).await;
    assert_eq!(link.cancels(), 1);

    // cancel이 끝나고 950ms(quiet 50ms 두 번 포함). 아직 다시 보내지 않는다.
    tokio::time::advance(Duration::from_millis(850)).await;
    quiet(&mut events).await;
    assert_eq!(link.cancels(), 1);

    // 1초를 넘었다.
    tokio::time::advance(Duration::from_millis(100)).await;
    assert_eq!(outcome(next(&mut events).await), QueryOutcome::Cancelled);
    assert_eq!(link.cancels(), 2);
}

#[tokio::test]
async fn state_answers_while_a_query_is_running() {
    let (handle, link) = session();
    link.set_tx(TxStatus::InTransaction);
    let (sink, mut events) = sink();
    handle.execute("BEGIN".into(), TxMode::Auto, sink).await;
    outcome(next(&mut events).await);
    let in_transaction = SessionState::Open {
        tx: TxStatus::InTransaction,
    };
    assert_eq!(handle.state().await, in_transaction);

    // 가짜의 tx_status는 끝나지 않은 결과가 있으면 영영 끝나지 않는다. actor가 기다리면 timeout난다.
    link.expect_query();
    let (sink, _events) = self::sink();
    handle
        .execute("SELECT pg_sleep(10)".into(), TxMode::Auto, sink)
        .await;
    let state = timeout(Duration::from_secs(1), handle.state()).await;
    assert_eq!(state.expect("state가 쿼리를 기다렸다"), in_transaction);
}

#[tokio::test]
async fn start_query_on_a_lost_connection_finishes_the_query() {
    let (handle, link) = session();
    link.lose();
    let (sink, mut events) = sink();
    assert_eq!(
        handle.execute("SELECT 1".into(), TxMode::Auto, sink).await,
        Some(QueryId(1))
    );
    let finished = outcome(next(&mut events).await);
    assert!(matches!(finished, QueryOutcome::ConnectionLost { .. }));
}

/// Review Focus 3
#[tokio::test]
async fn connection_lost_mid_query_finishes_and_reports_lost() {
    let (handle, link) = session();
    let feed = link.expect_query();
    feed.rows(0..3);
    let (sink, mut events) = sink();
    handle.execute("SELECT n".into(), TxMode::Auto, sink).await;
    // 연결은 쿼리를 보낸 뒤에 끊는다. 먼저 끊으면 `start_query`가 실패한다.
    assert!(eventually(|| link.sent().len() == 1).await);
    feed.lose();

    assert_eq!(batch(next(&mut events).await).rows.len(), 3);
    let finished = outcome(next(&mut events).await);
    assert!(matches!(finished, QueryOutcome::ConnectionLost { .. }));
    assert_eq!(handle.state().await, SessionState::Lost);
}

#[tokio::test]
async fn server_error_before_the_connection_dies_is_the_outcome() {
    let (handle, link) = session();
    let feed = link.expect_query();
    feed.push(Err(QueryError::Server(server_error("57P01"))));
    let (sink, mut events) = sink();
    handle.execute("SELECT n".into(), TxMode::Auto, sink).await;
    // 연결은 쿼리를 보낸 뒤에 끊는다. 먼저 끊으면 `start_query`가 실패한다.
    assert!(eventually(|| link.sent().len() == 1).await);
    feed.lose();

    let finished = outcome(next(&mut events).await);
    assert_eq!(finished, QueryOutcome::Failed(server_error("57P01")));
    assert_eq!(handle.state().await, SessionState::Lost);
}

#[tokio::test]
async fn close_with_a_running_query_cancels_it_first() {
    let (handle, link) = session();
    link.expect_query();
    let (sink, mut events) = sink();
    handle
        .execute("SELECT pg_sleep(10)".into(), TxMode::Auto, sink)
        .await;

    handle.close().await;
    assert_eq!(link.cancels(), 1);
    assert!(link.closed());
    assert_eq!(outcome(next(&mut events).await), QueryOutcome::Discarded);
}

/// Review Focus 5
#[tokio::test(start_paused = true)]
async fn close_does_not_wait_for_a_query_that_cannot_be_cancelled() {
    let (handle, link) = session();
    link.fail_cancels();
    link.expect_query();
    let (sink, mut events) = sink();
    handle
        .execute("SELECT pg_sleep(10)".into(), TxMode::Auto, sink)
        .await;

    let start = Instant::now();
    timeout(Duration::from_secs(2), handle.close())
        .await
        .expect("close가 2초 안에 돌아오지 않았다");
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(link.closed());
    assert_eq!(outcome(next(&mut events).await), QueryOutcome::Discarded);
}

#[tokio::test(start_paused = true)]
async fn elapsed_does_not_count_the_time_spent_paused() {
    let (handle, link) = session();
    let feed = link.expect_query();
    feed.rows(0..1200);
    feed.complete(1200);
    let (sink, mut events) = sink();
    let query = handle
        .execute("SELECT n".into(), TxMode::Auto, sink)
        .await
        .unwrap();

    batch(next(&mut events).await);
    // actor가 look-ahead를 마치고 Paused가 되게 한다.
    quiet(&mut events).await;
    tokio::time::advance(Duration::from_secs(60)).await;
    assert_eq!(handle.fetch_more(query).await, Some(true));
    let rows = batch(next(&mut events).await);
    assert!(rows.elapsed < Duration::from_secs(1), "{:?}", rows.elapsed);
}

#[tokio::test]
async fn finished_carries_the_tx_status_read_after_the_query() {
    let (handle, link) = session();
    link.set_tx(TxStatus::InTransaction);
    link.expect_query().complete(0);
    let (sink, mut events) = sink();
    handle.execute("BEGIN".into(), TxMode::Auto, sink).await;
    assert_eq!(
        finished_tx(next(&mut events).await),
        Some(TxStatus::InTransaction)
    );
}

#[tokio::test]
async fn a_query_failing_at_start_reads_the_tx_status() {
    let (handle, link) = session();
    link.set_tx(TxStatus::Failed);
    link.fail_next_start(QueryError::Server(server_error("25P02")));
    let (sink, mut events) = sink();
    handle.execute("SELECT 1".into(), TxMode::Auto, sink).await;
    let event = next(&mut events).await;
    assert!(matches!(
        &event,
        QueryEvent::Finished {
            outcome: QueryOutcome::Failed(error),
            tx: Some(TxStatus::Failed),
            ..
        } if *error == server_error("25P02")
    ));
}

#[tokio::test]
async fn a_lost_connection_has_no_tx_status() {
    let (handle, link) = session();
    // 쿼리를 시작하지 못한 경우.
    link.lose();
    let (sink, mut events) = self::sink();
    handle.execute("SELECT 1".into(), TxMode::Auto, sink).await;
    assert_eq!(finished_tx(next(&mut events).await), None);

    // 결과 도중에 끊긴 경우.
    let (handle, link) = session();
    link.set_tx(TxStatus::InTransaction);
    let feed = link.expect_query();
    feed.rows(0..3);
    let (sink, mut events) = self::sink();
    handle.execute("SELECT n".into(), TxMode::Auto, sink).await;
    assert!(eventually(|| link.sent().len() == 1).await);
    feed.lose();
    assert_eq!(batch(next(&mut events).await).rows.len(), 3);
    assert_eq!(finished_tx(next(&mut events).await), None);
}

#[tokio::test]
async fn closing_the_session_reports_no_tx_status() {
    let (handle, link) = session();
    link.set_tx(TxStatus::InTransaction);
    link.expect_query();
    let (sink, mut events) = sink();
    handle
        .execute("SELECT pg_sleep(10)".into(), TxMode::Auto, sink)
        .await;
    handle.close().await;
    assert_eq!(finished_tx(next(&mut events).await), None);
}

/// 시작하지 않고 끝난 쿼리는 서버에 묻지 않았으므로 트랜잭션 상태를 싣지 않는다. actor가 마지막으로
/// 읽은 값은 낡았을 수 있다.
#[tokio::test]
async fn a_discarded_pending_query_has_no_tx_status() {
    let (handle, link) = session();
    link.set_tx(TxStatus::InTransaction);
    let (sink, mut events) = sink();
    handle.execute("BEGIN".into(), TxMode::Auto, sink).await;
    assert_eq!(
        finished_tx(next(&mut events).await),
        Some(TxStatus::InTransaction)
    );

    link.fail_cancels();
    let feed_a = link.expect_query();
    let (sink_a, mut events_a) = self::sink();
    let (sink_b, mut events_b) = self::sink();
    let (sink_c, _events_c) = self::sink();
    handle.execute("A".into(), TxMode::Auto, sink_a).await;
    handle.execute("B".into(), TxMode::Auto, sink_b).await;
    handle.execute("C".into(), TxMode::Auto, sink_c).await;
    let discarded = next(&mut events_b).await;
    assert_eq!(
        discarded,
        QueryEvent::Finished {
            outcome: QueryOutcome::Discarded,
            elapsed: Duration::ZERO,
            tx: None,
        }
    );
    // cancel이 실패해 A는 끝까지 돌았지만 버린 문장이므로 되돌린다.
    feed_a.complete(0);
    let finished_a = next(&mut events_a).await;
    assert!(
        matches!(
            finished_a,
            QueryEvent::Finished {
                outcome: QueryOutcome::Discarded,
                tx: Some(TxStatus::InTransaction),
                ..
            }
        ),
        "{finished_a:?}"
    );
}

/// fake의 트랜잭션 상태를 바꾸고 actor가 읽게 한다. 실제 서버의 상태는 actor가 보낸 문장으로만
/// 바뀌므로 actor는 쿼리가 끝날 때와 `State`에서만 읽는다.
async fn set_tx(handle: &SessionHandle, link: &FakeLink, tx: TxStatus) {
    link.set_tx(tx);
    assert_eq!(handle.state().await, SessionState::Open { tx });
}

/// actor가 트랜잭션 안의 문장 앞에 두는 savepoint와 버린 문장을 되돌리는 SQL.
const SET_SAVEPOINT: &str = "SAVEPOINT chilla_statement";
const RENEW_SAVEPOINT: &str = "RELEASE SAVEPOINT chilla_statement; SAVEPOINT chilla_statement";
const BEGIN_WITH_SAVEPOINT: &str = "BEGIN; SAVEPOINT chilla_statement";
const UNDO_STATEMENT: &str = "ROLLBACK TO SAVEPOINT chilla_statement";

/// 이벤트마다 그때까지 연결이 받은 SQL을 함께 남기는 sink.
fn logging_sink(link: &FakeLink) -> (QuerySink, UnboundedReceiver<(QueryEvent, Vec<String>)>) {
    let (sender, events) = tokio::sync::mpsc::unbounded_channel();
    let link = link.clone();
    let sink: QuerySink = Box::new(move |event| {
        let _ = sender.send((event, link.sent()));
    });
    (sink, events)
}

fn ended(tx: TxStatus) -> Option<EndResult> {
    Some(EndResult {
        outcome: EndOutcome::Ended,
        tx: Some(tx),
    })
}

/// 끝내기의 답. 2초 안에 오지 않으면 panic한다.
async fn answer<F: Future<Output = Option<EndResult>>>(ending: F) -> Option<EndResult> {
    timeout(Duration::from_secs(2), ending)
        .await
        .expect("2초 안에 끝내기가 답하지 않았다")
}

/// `Finished`까지 읽고 그 이벤트를 돌려준다.
async fn finished_event(events: &mut UnboundedReceiver<QueryEvent>) -> QueryEvent {
    loop {
        let event = next(events).await;
        if matches!(event, QueryEvent::Finished { .. }) {
            return event;
        }
    }
}

#[tokio::test]
async fn manual_execute_outside_a_transaction_sends_begin_first() {
    let (handle, link) = session();
    let (sink, mut events) = sink();
    handle
        .execute("UPDATE t SET a = 1".into(), TxMode::Manual, sink)
        .await;
    let event = next(&mut events).await;
    assert!(matches!(
        event,
        QueryEvent::Finished {
            outcome: QueryOutcome::Completed { rows: 0 },
            tx: Some(TxStatus::InTransaction),
            ..
        }
    ));
    assert_eq!(link.sent(), [BEGIN_WITH_SAVEPOINT, "UPDATE t SET a = 1"]);
}

#[tokio::test]
async fn manual_execute_inside_a_transaction_does_not_begin_again() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    let (sink, mut events) = sink();
    handle
        .execute("UPDATE t SET a = 1".into(), TxMode::Manual, sink)
        .await;
    assert_eq!(
        outcome(next(&mut events).await),
        QueryOutcome::Completed { rows: 0 }
    );
    assert_eq!(link.sent(), [SET_SAVEPOINT, "UPDATE t SET a = 1"]);
}

/// 트랜잭션 안의 문장마다 savepoint를 둔다. 앞 문장의 savepoint는 풀고 새로 둔다(쌓이지 않게).
/// Auto여도 트랜잭션 안(사용자가 쓴 `BEGIN`)이면 같다.
#[tokio::test]
async fn statements_inside_a_transaction_each_get_a_savepoint() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    for (sql, mode) in [
        ("A", TxMode::Auto),
        ("B", TxMode::Manual),
        ("C", TxMode::Auto),
    ] {
        let (sink, mut events) = sink();
        handle.execute(sql.into(), mode, sink).await;
        assert_eq!(
            finished_tx(next(&mut events).await),
            Some(TxStatus::InTransaction)
        );
    }
    assert_eq!(
        link.sent(),
        [
            SET_SAVEPOINT,
            "A",
            RENEW_SAVEPOINT,
            "B",
            RENEW_SAVEPOINT,
            "C"
        ]
    );
}

/// 트랜잭션 밖(Auto)과 실패한 트랜잭션에는 savepoint를 두지 않는다. 실패한 트랜잭션의 문장은 바로
/// `25P02`로 끝난다.
#[tokio::test]
async fn no_savepoint_outside_a_transaction_or_in_a_failed_one() {
    let (handle, link) = session();
    let (sink, mut events) = sink();
    handle.execute("A".into(), TxMode::Auto, sink).await;
    outcome(next(&mut events).await);

    set_tx(&handle, &link, TxStatus::Failed).await;
    for mode in [TxMode::Auto, TxMode::Manual] {
        let (sink, mut events) = self::sink();
        handle.execute("B".into(), mode, sink).await;
        outcome(next(&mut events).await);
    }
    assert_eq!(link.sent(), ["A", "B", "B"]);
}

/// 트랜잭션과 savepoint를 다루는 문장은 savepoint 없이 보낸다. 그 문장이 savepoint를 두거나 풀거나
/// 트랜잭션을 끝냈을 수 있으므로, 다음 문장 앞에서는 앞 savepoint를 풀지 않고 새로 둔다(풀면 사용자의
/// savepoint까지 풀리거나, savepoint가 없어 트랜잭션이 failed가 된다).
#[tokio::test]
async fn transaction_control_runs_without_a_savepoint_and_the_next_one_is_not_released() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    let control = [
        "SAVEPOINT a",
        " release a",
        "/* c */ ROLLBACK TO SAVEPOINT a",
        "-- c\nCOMMIT AND CHAIN",
        "ROLLBACK AND CHAIN",
        ";END AND CHAIN",
        "abort and chain",
        "BEGIN",
        "START TRANSACTION",
        "PREPARE TRANSACTION 'x'",
        "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
        "set  transaction read only",
    ];
    let mut expected = Vec::new();
    for sql in control {
        let (sink, mut events) = sink();
        handle.execute(sql.into(), TxMode::Manual, sink).await;
        outcome(next(&mut events).await);
        expected.push(sql);
    }
    let (sink, mut events) = sink();
    handle.execute("A".into(), TxMode::Manual, sink).await;
    outcome(next(&mut events).await);
    let (sink, mut events) = self::sink();
    handle.execute("B".into(), TxMode::Manual, sink).await;
    outcome(next(&mut events).await);
    expected.extend([SET_SAVEPOINT, "A", RENEW_SAVEPOINT, "B"]);
    assert_eq!(link.sent(), expected);
}

/// `SET TRANSACTION`은 subtransaction 안에서 실행할 수 없다. Manual의 첫 문장이면 `BEGIN`만 보낸다.
#[tokio::test]
async fn manual_set_transaction_begins_without_a_savepoint() {
    let (handle, link) = session();
    let (sink, mut events) = sink();
    handle
        .execute(
            "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE".into(),
            TxMode::Manual,
            sink,
        )
        .await;
    assert_eq!(
        finished_tx(next(&mut events).await),
        Some(TxStatus::InTransaction)
    );
    let (sink, mut events) = self::sink();
    handle.execute("A".into(), TxMode::Manual, sink).await;
    outcome(next(&mut events).await);
    assert_eq!(
        link.sent(),
        [
            "BEGIN",
            "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
            SET_SAVEPOINT,
            "A"
        ]
    );
}

#[tokio::test]
async fn statements_that_only_look_like_transaction_control_get_a_savepoint() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    for sql in [
        "SELECT 'COMMIT'",
        "SETTINGS",
        "SET search_path = a",
        "savepoints",
    ] {
        let (sink, mut events) = sink();
        handle.execute(sql.into(), TxMode::Manual, sink).await;
        outcome(next(&mut events).await);
    }
    assert_eq!(
        link.sent(),
        [
            SET_SAVEPOINT,
            "SELECT 'COMMIT'",
            RENEW_SAVEPOINT,
            "SETTINGS",
            RENEW_SAVEPOINT,
            "SET search_path = a",
            RENEW_SAVEPOINT,
            "savepoints"
        ]
    );
}

/// savepoint를 두지 못하면 문장을 보내지 않고 그 오류로 마친다. 다음 문장은 풀 savepoint가 없다.
#[tokio::test]
async fn a_failed_savepoint_finishes_the_query_with_that_error() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    link.fail_next_simple("53200");
    let (sink, mut events) = sink();
    handle.execute("A".into(), TxMode::Manual, sink).await;
    assert_eq!(
        outcome(next(&mut events).await),
        QueryOutcome::Failed(server_error("53200"))
    );
    let (sink, mut events) = self::sink();
    handle.execute("B".into(), TxMode::Manual, sink).await;
    outcome(next(&mut events).await);
    assert_eq!(link.sent(), [SET_SAVEPOINT, SET_SAVEPOINT, "B"]);
}

/// 쿼리가 도는 동안의 `State`는 actor가 보낸 `BEGIN`을 안다.
#[tokio::test]
async fn state_during_a_query_knows_the_transaction_it_began() {
    let (handle, link) = session();
    link.expect_query();
    let (sink, _events) = sink();
    handle.execute("A".into(), TxMode::Manual, sink).await;
    let state = timeout(Duration::from_secs(1), handle.state()).await;
    assert_eq!(
        state.expect("state가 쿼리를 기다렸다"),
        SessionState::Open {
            tx: TxStatus::InTransaction
        }
    );
}

#[tokio::test]
async fn auto_execute_never_begins() {
    let (handle, link) = session();
    let (sink, mut events) = sink();
    handle
        .execute("UPDATE t SET a = 1".into(), TxMode::Auto, sink)
        .await;
    assert_eq!(finished_tx(next(&mut events).await), Some(TxStatus::Idle));
    assert_eq!(link.sent(), ["UPDATE t SET a = 1"]);
}

#[tokio::test]
async fn a_failed_begin_finishes_the_query_with_that_error() {
    let (handle, link) = session();
    link.fail_next_simple("53300");
    let (sink, mut events) = sink();
    handle
        .execute("UPDATE t SET a = 1".into(), TxMode::Manual, sink)
        .await;
    let event = next(&mut events).await;
    assert!(
        matches!(
            &event,
            QueryEvent::Finished {
                outcome: QueryOutcome::Failed(error),
                tx: Some(TxStatus::Idle),
                ..
            } if *error == server_error("53300")
        ),
        "{event:?}"
    );
    assert_eq!(link.sent(), [BEGIN_WITH_SAVEPOINT]);
}

#[tokio::test]
async fn end_transaction_commits_and_reports_idle() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    assert_eq!(
        handle.end_transaction(TxEnd::Commit).await,
        ended(TxStatus::Idle)
    );
    assert_eq!(link.sent().last().map(String::as_str), Some("COMMIT"));
}

/// 서버는 실패한 트랜잭션의 `COMMIT`을 `ROLLBACK`으로 처리한다. 보내면 Commit이 된 것처럼 보인다.
#[tokio::test]
async fn commit_in_a_failed_transaction_is_refused() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::Failed).await;
    assert_eq!(
        handle.end_transaction(TxEnd::Commit).await,
        Some(EndResult {
            outcome: EndOutcome::TransactionFailed,
            tx: Some(TxStatus::Failed),
        })
    );
    assert!(link.sent().is_empty());

    assert_eq!(
        handle.end_transaction(TxEnd::Rollback).await,
        ended(TxStatus::Idle)
    );
    assert_eq!(link.sent(), ["ROLLBACK"]);
}

#[tokio::test]
async fn a_failed_commit_reports_the_server_error() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    link.fail_next_simple("23503");
    // 서버는 실패한 COMMIT 뒤에 트랜잭션을 끝낸다.
    link.set_tx(TxStatus::Idle);
    assert_eq!(
        handle.end_transaction(TxEnd::Commit).await,
        Some(EndResult {
            outcome: EndOutcome::Server(server_error("23503")),
            tx: Some(TxStatus::Idle),
        })
    );
}

#[tokio::test]
async fn end_transaction_on_a_lost_connection_has_no_tx_status() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    link.lose();
    let result = handle.end_transaction(TxEnd::Rollback).await.unwrap();
    assert!(
        matches!(result.outcome, EndOutcome::ConnectionLost { .. }),
        "{result:?}"
    );
    assert_eq!(result.tx, None);
}

/// 연결이 끊긴 뒤에는 마지막으로 읽은 상태(Failed)를 믿지 않는다.
#[tokio::test]
async fn commit_on_a_lost_connection_is_connection_lost_even_if_the_transaction_had_failed() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::Failed).await;
    link.lose();
    let result = handle.end_transaction(TxEnd::Commit).await.unwrap();
    assert!(
        matches!(result.outcome, EndOutcome::ConnectionLost { .. }),
        "{result:?}"
    );
    assert_eq!(result.tx, None);
}

/// 끝내기는 실행 중인 문장을 cancel하고 savepoint로 되돌린 뒤 보낸다. 버린 문장은 Commit되지 않는다.
#[tokio::test]
async fn end_transaction_rolls_back_a_paused_query_before_ending() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    let feed = link.expect_query();
    feed.rows(0..1200);
    let (sink, mut events) = logging_sink(&link);
    handle.execute("A".into(), TxMode::Manual, sink).await;
    let (first, _) = timeout(Duration::from_secs(2), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(batch(first).rows.len(), 500);

    assert_eq!(
        answer(handle.end_transaction(TxEnd::Commit)).await,
        ended(TxStatus::Idle)
    );
    assert_eq!(link.cancels(), 1);
    let (event, sent_then) = events.recv().await.unwrap();
    assert!(
        matches!(
            event,
            QueryEvent::Finished {
                outcome: QueryOutcome::Discarded,
                tx: Some(TxStatus::InTransaction),
                ..
            }
        ),
        "{event:?}"
    );
    assert_eq!(sent_then, [SET_SAVEPOINT, "A", UNDO_STATEMENT]);
    assert_eq!(link.sent(), [SET_SAVEPOINT, "A", UNDO_STATEMENT, "COMMIT"]);
}

#[tokio::test]
async fn a_query_sent_after_end_runs_after_it() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    let feed_a = link.expect_query();
    feed_a.rows(0..1200);
    let (sink_a, mut events_a) = sink();
    handle.execute("A".into(), TxMode::Manual, sink_a).await;
    assert_eq!(batch(next(&mut events_a).await).rows.len(), 500);
    let gate = link.hold_cancels().await;

    // A의 cancel이 끝나지 않았으므로 끝내기는 A를 버리는 동안 기다린다.
    let ending = handle.end_transaction(TxEnd::Commit);
    tokio::pin!(ending);
    // poll해서 명령을 보낸다. A를 마치지 않았으므로 답은 아직 없다.
    assert!(
        timeout(Duration::from_millis(50), &mut ending)
            .await
            .is_err()
    );
    let (sink_b, mut events_b) = sink();
    handle.execute("B".into(), TxMode::Manual, sink_b).await;
    drop(gate);

    assert_eq!(answer(ending).await, ended(TxStatus::Idle));
    assert_eq!(
        outcome(finished_event(&mut events_a).await),
        QueryOutcome::Discarded
    );
    assert_eq!(
        outcome(next(&mut events_b).await),
        QueryOutcome::Completed { rows: 0 }
    );
    // 끝내기 뒤에는 트랜잭션 밖이므로 B 앞에 BEGIN이 간다.
    assert_eq!(
        link.sent(),
        [
            SET_SAVEPOINT,
            "A",
            UNDO_STATEMENT,
            "COMMIT",
            BEGIN_WITH_SAVEPOINT,
            "B"
        ]
    );
}

#[tokio::test]
async fn ends_waiting_for_a_query_run_in_order() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    let feed_a = link.expect_query();
    feed_a.rows(0..1200);
    let (sink_a, mut events_a) = sink();
    handle.execute("A".into(), TxMode::Manual, sink_a).await;
    assert_eq!(batch(next(&mut events_a).await).rows.len(), 500);
    let gate = link.hold_cancels().await;

    let commit = handle.end_transaction(TxEnd::Commit);
    let rollback = handle.end_transaction(TxEnd::Rollback);
    tokio::pin!(commit, rollback);
    assert!(
        timeout(Duration::from_millis(50), &mut commit)
            .await
            .is_err()
    );
    assert!(
        timeout(Duration::from_millis(50), &mut rollback)
            .await
            .is_err()
    );
    drop(gate);

    assert_eq!(answer(commit).await, ended(TxStatus::Idle));
    assert_eq!(answer(rollback).await, ended(TxStatus::Idle));
    assert_eq!(
        link.sent(),
        [SET_SAVEPOINT, "A", UNDO_STATEMENT, "COMMIT", "ROLLBACK"]
    );
}

/// 1200행 결과의 첫 batch를 받고 actor가 look-ahead를 마쳐 `Paused`가 될 때까지 기다린다.
/// 남은 699행은 fake에 들어 있고 결과는 끝나지 않았다.
async fn first_batch(
    handle: &SessionHandle,
    link: &FakeLink,
    mode: TxMode,
) -> (FakeFeed, QueryId, UnboundedReceiver<QueryEvent>) {
    let feed = link.expect_query();
    feed.rows(0..1200);
    let (sink, mut events) = sink();
    let query = handle.execute("A".into(), mode, sink).await.unwrap();
    assert_eq!(batch(next(&mut events).await).rows.len(), 500);
    quiet(&mut events).await;
    (feed, query, events)
}

#[tokio::test(start_paused = true)]
async fn a_paused_result_expires_after_the_idle_timeout() {
    let (handle, link) = session();
    let (_feed, _, mut events) = first_batch(&handle, &link, TxMode::Auto).await;

    tokio::time::advance(Duration::from_secs(599)).await;
    quiet(&mut events).await;
    assert_eq!(link.cancels(), 0);

    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(outcome(next(&mut events).await), QueryOutcome::Expired);
    assert_eq!(link.cancels(), 1);
}

#[tokio::test(start_paused = true)]
async fn fetch_more_restarts_the_idle_timer() {
    let (handle, link) = session();
    let (_feed, query, mut events) = first_batch(&handle, &link, TxMode::Auto).await;

    tokio::time::advance(Duration::from_secs(500)).await;
    assert_eq!(handle.fetch_more(query).await, Some(true));
    assert_eq!(batch(next(&mut events).await).first_row, 500);
    quiet(&mut events).await;

    // 첫 batch에서는 1000초, 다음 batch에서는 500초가 지났다.
    tokio::time::advance(Duration::from_secs(500)).await;
    quiet(&mut events).await;
    assert_eq!(link.cancels(), 0);

    tokio::time::advance(Duration::from_secs(100)).await;
    assert_eq!(outcome(next(&mut events).await), QueryOutcome::Expired);
}

/// 트랜잭션 안의 문장을 다음 쿼리가 버리면 바로 cancel하고, cancel이 끝난 뒤 savepoint로 그 문장만
/// 되돌린다. 트랜잭션은 열린 채다.
#[tokio::test]
async fn discarding_inside_a_transaction_cancels_then_rolls_back_the_statement() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    let (_feed_a, _, mut events_a) = first_batch(&handle, &link, TxMode::Manual).await;
    let gate = link.hold_cancels().await;
    let (sink_b, mut events_b) = sink();
    handle.execute("B".into(), TxMode::Manual, sink_b).await;

    // cancel이 끝나기 전에는 되돌리지 않는다. 늦게 닿은 cancel이 `ROLLBACK TO`를 멈출 수 있다.
    assert!(eventually(|| link.cancels() == 1).await);
    quiet(&mut events_a).await;
    assert_eq!(link.sent(), [SET_SAVEPOINT, "A"]);

    drop(gate);
    let finished_a = next(&mut events_a).await;
    assert!(
        matches!(
            finished_a,
            QueryEvent::Finished {
                outcome: QueryOutcome::Discarded,
                tx: Some(TxStatus::InTransaction),
                ..
            }
        ),
        "{finished_a:?}"
    );
    assert_eq!(
        finished_tx(next(&mut events_b).await),
        Some(TxStatus::InTransaction)
    );
    // `ROLLBACK TO`는 savepoint를 남기므로 B 앞에서 풀고 다시 둔다.
    assert_eq!(
        link.sent(),
        [SET_SAVEPOINT, "A", UNDO_STATEMENT, RENEW_SAVEPOINT, "B"]
    );
    assert_eq!(link.cancels(), 1);
}

/// Manual에서 `BEGIN`과 함께 savepoint를 두고 시작한 쿼리도 같다.
#[tokio::test]
async fn discarding_a_query_that_began_the_transaction_rolls_it_back() {
    let (handle, link) = session();
    let (_feed_a, _, mut events_a) = first_batch(&handle, &link, TxMode::Manual).await;
    let (sink_b, mut events_b) = sink();
    handle.execute("B".into(), TxMode::Manual, sink_b).await;

    assert_eq!(
        finished_tx(finished_event(&mut events_a).await),
        Some(TxStatus::InTransaction)
    );
    outcome(next(&mut events_b).await);
    assert_eq!(
        link.sent(),
        [
            BEGIN_WITH_SAVEPOINT,
            "A",
            UNDO_STATEMENT,
            RENEW_SAVEPOINT,
            "B"
        ]
    );
    assert_eq!(link.cancels(), 1);
}

/// cancel이 늦어 문장이 끝까지 돌았어도 버린 문장이므로 되돌린다. 끝난 것으로 알리지 않는다.
#[tokio::test]
async fn a_statement_that_completed_despite_the_cancel_is_rolled_back() {
    for (user_cancel, expected) in [
        (false, QueryOutcome::Discarded),
        (true, QueryOutcome::Cancelled),
    ] {
        let (handle, link) = session();
        set_tx(&handle, &link, TxStatus::InTransaction).await;
        link.ignore_cancels(1);
        let feed = link.expect_query();
        let (sink, mut events) = sink();
        let query = handle
            .execute("UPDATE t SET a = 1".into(), TxMode::Manual, sink)
            .await
            .unwrap();
        let (sink_b, mut events_b) = self::sink();
        if user_cancel {
            assert_eq!(handle.cancel(query).await, Some(Ok(())));
        } else {
            handle.execute("B".into(), TxMode::Manual, sink_b).await;
        }
        assert!(eventually(|| link.cancels() == 1).await);
        feed.complete(3);

        let finished = next(&mut events).await;
        assert!(
            matches!(
                &finished,
                QueryEvent::Finished {
                    outcome,
                    tx: Some(TxStatus::InTransaction),
                    ..
                } if *outcome == expected
            ),
            "{finished:?}"
        );
        assert_eq!(
            link.sent()[..3],
            [SET_SAVEPOINT, "UPDATE t SET a = 1", UNDO_STATEMENT]
        );
        if !user_cancel {
            outcome(next(&mut events_b).await);
        }
    }
}

/// 문장이 스스로 오류로 끝나면 되돌리지 않는다. 트랜잭션은 failed다.
#[tokio::test]
async fn a_statement_failing_on_its_own_is_not_rolled_back() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    let feed = link.expect_query();
    let (sink, mut events) = sink();
    handle
        .execute("SELECT 1/0".into(), TxMode::Manual, sink)
        .await;
    link.set_tx(TxStatus::Failed);
    feed.fail("22012");
    let finished = next(&mut events).await;
    assert!(
        matches!(
            &finished,
            QueryEvent::Finished {
                outcome: QueryOutcome::Failed(error),
                tx: Some(TxStatus::Failed),
                ..
            } if *error == server_error("22012")
        ),
        "{finished:?}"
    );
    assert_eq!(link.sent(), [SET_SAVEPOINT, "SELECT 1/0"]);
}

/// 사용자의 Cancel도 문장만 되돌린다. 트랜잭션은 열린 채다.
#[tokio::test]
async fn user_cancel_inside_a_transaction_rolls_back_the_statement() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    let (_feed, query, mut events) = first_batch(&handle, &link, TxMode::Manual).await;

    assert_eq!(handle.cancel(query).await, Some(Ok(())));
    assert_eq!(link.cancels(), 1);
    let finished = next(&mut events).await;
    assert!(
        matches!(
            finished,
            QueryEvent::Finished {
                outcome: QueryOutcome::Cancelled,
                tx: Some(TxStatus::InTransaction),
                ..
            }
        ),
        "{finished:?}"
    );
    assert_eq!(link.sent(), [SET_SAVEPOINT, "A", UNDO_STATEMENT]);
}

/// 사용자의 Cancel이 기다리는 쿼리를 빼도 버리는 중인 문장은 그대로 되돌린다.
#[tokio::test]
async fn user_cancel_while_discarding_inside_a_transaction_still_rolls_back() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    link.fail_cancels();
    let (feed_a, query, mut events_a) = first_batch(&handle, &link, TxMode::Manual).await;
    let (sink_b, mut events_b) = sink();
    handle.execute("B".into(), TxMode::Manual, sink_b).await;
    assert!(eventually(|| link.cancels() == 1).await);

    // 버리는 중인 A에 사용자의 Cancel이 오면 cancel을 다시 보내고 그 결과를 답한다.
    assert!(matches!(handle.cancel(query).await, Some(Err(_))));
    assert_eq!(link.cancels(), 2);
    feed_a.complete(1200);
    assert_eq!(
        outcome(finished_event(&mut events_a).await),
        QueryOutcome::Discarded
    );
    assert_eq!(
        finished_tx(next(&mut events_b).await),
        Some(TxStatus::InTransaction)
    );
    assert_eq!(
        link.sent(),
        [SET_SAVEPOINT, "A", UNDO_STATEMENT, RENEW_SAVEPOINT, "B"]
    );
}

#[tokio::test(start_paused = true)]
async fn expiry_inside_a_transaction_cancels_and_rolls_back() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    let (_feed, _, mut events) = first_batch(&handle, &link, TxMode::Manual).await;

    tokio::time::advance(Duration::from_secs(600)).await;
    let finished = next(&mut events).await;
    assert!(
        matches!(
            finished,
            QueryEvent::Finished {
                outcome: QueryOutcome::Expired,
                tx: Some(TxStatus::InTransaction),
                ..
            }
        ),
        "{finished:?}"
    );
    assert_eq!(link.cancels(), 1);
    assert_eq!(link.sent(), [SET_SAVEPOINT, "A", UNDO_STATEMENT]);
}

/// `ROLLBACK TO`가 실패하면(사용자가 savepoint를 풀었거나 그 앞으로 되돌린 경우) 서버가 알려 주는
/// 상태를 그대로 둔다. 다음 문장 앞에서는 savepoint를 풀지 않는다.
#[tokio::test]
async fn a_failed_rollback_to_leaves_the_state_the_server_reports() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    let (_feed_a, query, mut events_a) = first_batch(&handle, &link, TxMode::Manual).await;
    link.fail_next_simple("3B001");
    // 서버는 실패한 `ROLLBACK TO` 뒤에 트랜잭션을 failed로 둔다.
    link.set_tx(TxStatus::Failed);

    assert_eq!(handle.cancel(query).await, Some(Ok(())));
    let finished = next(&mut events_a).await;
    assert!(
        matches!(
            finished,
            QueryEvent::Finished {
                outcome: QueryOutcome::Cancelled,
                tx: Some(TxStatus::Failed),
                ..
            }
        ),
        "{finished:?}"
    );
    let (sink_b, mut events_b) = sink();
    handle.execute("B".into(), TxMode::Manual, sink_b).await;
    outcome(next(&mut events_b).await);
    assert_eq!(link.sent(), [SET_SAVEPOINT, "A", UNDO_STATEMENT, "B"]);
}

/// 되돌리려는데 연결이 끊겼으면 끊긴 것으로 알린다. 화면은 트랜잭션을 잃은 것으로 안다.
#[tokio::test]
async fn connection_lost_while_rolling_back_is_connection_lost() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    let (_feed_a, query, mut events_a) = first_batch(&handle, &link, TxMode::Manual).await;
    link.lose();

    assert_eq!(handle.cancel(query).await, Some(Ok(())));
    let finished = next(&mut events_a).await;
    assert!(
        matches!(
            finished,
            QueryEvent::Finished {
                outcome: QueryOutcome::ConnectionLost { .. },
                tx: None,
                ..
            }
        ),
        "{finished:?}"
    );
    assert_eq!(link.sent(), [SET_SAVEPOINT, "A", UNDO_STATEMENT]);
}

/// 트랜잭션 밖의 문장을 버리면 되돌릴 savepoint가 없다.
#[tokio::test]
async fn discarding_outside_a_transaction_does_not_roll_back() {
    let (handle, link) = session();
    let (_feed_a, query, mut events_a) = first_batch(&handle, &link, TxMode::Auto).await;
    assert_eq!(handle.cancel(query).await, Some(Ok(())));
    assert_eq!(outcome(next(&mut events_a).await), QueryOutcome::Cancelled);
    handle.state().await;
    assert_eq!(link.sent(), ["A"]);
}

/// 세션을 닫으면 연결이 닫혀 트랜잭션이 어차피 되돌아간다. 되돌리지 않고 cancel만 한다.
#[tokio::test]
async fn closing_inside_a_transaction_cancels_without_rolling_back() {
    let (handle, link) = session();
    set_tx(&handle, &link, TxStatus::InTransaction).await;
    let (_feed_a, _, mut events_a) = first_batch(&handle, &link, TxMode::Manual).await;

    handle.close().await;
    assert_eq!(link.cancels(), 1);
    assert_eq!(outcome(next(&mut events_a).await), QueryOutcome::Discarded);
    assert_eq!(link.sent(), [SET_SAVEPOINT, "A"]);
}
