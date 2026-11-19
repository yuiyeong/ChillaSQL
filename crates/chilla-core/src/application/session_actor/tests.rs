use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::{Instant, timeout};

use super::*;
use crate::application::test_support::{
    FakeConnection, FakeLink, next, numbered, server_error, sink,
};
use crate::domain::{Column, QueryEvent, QueryId, QueryLimits, QueryOutcome, RowBatch, TxStatus};

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
    let query = handle.execute("SELECT 1".into(), sink).await;
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
    let query = handle.execute("SELECT 2".into(), sink).await;
    assert_eq!(query, Some(QueryId(2)));
}

#[tokio::test]
async fn statement_without_rows_finishes_with_the_count() {
    let (handle, link) = session();
    link.expect_query().complete(3);
    let (sink, mut events) = sink();
    handle.execute("DELETE FROM t".into(), sink).await;
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
    let query = handle.execute("SELECT n".into(), sink).await.unwrap();

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
    handle.execute("SELECT n".into(), sink).await;

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
    let query = handle.execute("SELECT n".into(), sink).await.unwrap();

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
        retained_rows: 100_000,
    };
    let (handle, link) = session_with(limits);
    let feed = link.expect_query();
    for _ in 0..5 {
        feed.row(vec![Some("x".repeat(400))]);
    }
    feed.complete(5);
    let (sink, mut events) = sink();
    let query = handle.execute("SELECT wide".into(), sink).await.unwrap();

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
    let query = handle.execute("SELECT n".into(), sink).await.unwrap();

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
    let query = handle.execute("SELECT n".into(), sink).await.unwrap();

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
    let a = handle.execute("A".into(), sink_a).await.unwrap();
    let b = handle.execute("B".into(), sink_b).await.unwrap();

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
    handle.execute("SELECT 1/(n-3)".into(), sink).await;

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
    handle.execute("SELECT n".into(), sink).await;

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
    handle.execute("SELECT 1\0".into(), sink).await;

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
    handle.execute("SELECT 1".into(), sink).await;
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

    handle.execute("A".into(), sink_a).await;
    assert_eq!(batch(next(&mut events_a).await).rows.len(), 500);
    assert_eq!(handle.execute("B".into(), sink_b).await, Some(QueryId(2)));

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
    handle.execute("A".into(), sink_a).await;
    let gate = link.hold_cancels().await;

    handle.execute("B".into(), sink_b).await;
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

    handle.execute("A".into(), sink_a).await;
    handle.execute("B".into(), sink_b).await;
    handle.execute("C".into(), sink_c).await;
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
        .execute("SELECT pg_sleep(10)".into(), sink)
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
    let query = handle.execute("SELECT n".into(), sink).await.unwrap();

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
    handle.execute("A".into(), sink_a).await;
    let b = handle.execute("B".into(), sink_b).await.unwrap();

    assert_eq!(handle.cancel(b).await, Some(Ok(())));
    assert_eq!(
        next(&mut events_b).await,
        QueryEvent::Finished {
            outcome: QueryOutcome::Cancelled,
            elapsed: Duration::ZERO
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
    let query = handle.execute("SELECT 1".into(), sink).await.unwrap();
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
        .execute("SELECT pg_sleep(10)".into(), sink)
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
    let query = handle.execute("DELETE FROM t".into(), sink).await.unwrap();

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
    let query = handle.execute("SELECT n".into(), sink).await.unwrap();

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
    let query = handle.execute("SELECT n".into(), sink).await.unwrap();

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
    let query = handle.execute("SELECT n".into(), sink).await.unwrap();

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
    let query = handle.execute("SELECT 1/0".into(), sink).await.unwrap();

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
        .execute("SELECT pg_sleep(10)".into(), sink)
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
    handle.execute("BEGIN".into(), sink).await;
    outcome(next(&mut events).await);
    let in_transaction = SessionState::Open {
        tx: TxStatus::InTransaction,
    };
    assert_eq!(handle.state().await, in_transaction);

    // 가짜의 tx_status는 끝나지 않은 결과가 있으면 영영 끝나지 않는다. actor가 기다리면 timeout난다.
    link.expect_query();
    let (sink, _events) = self::sink();
    handle.execute("SELECT pg_sleep(10)".into(), sink).await;
    let state = timeout(Duration::from_secs(1), handle.state()).await;
    assert_eq!(state.expect("state가 쿼리를 기다렸다"), in_transaction);
}

#[tokio::test]
async fn start_query_on_a_lost_connection_finishes_the_query() {
    let (handle, link) = session();
    link.lose();
    let (sink, mut events) = sink();
    assert_eq!(
        handle.execute("SELECT 1".into(), sink).await,
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
    handle.execute("SELECT n".into(), sink).await;
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
    handle.execute("SELECT n".into(), sink).await;
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
    handle.execute("SELECT pg_sleep(10)".into(), sink).await;

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
    handle.execute("SELECT pg_sleep(10)".into(), sink).await;

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
    let query = handle.execute("SELECT n".into(), sink).await.unwrap();

    batch(next(&mut events).await);
    // actor가 look-ahead를 마치고 Paused가 되게 한다.
    quiet(&mut events).await;
    tokio::time::advance(Duration::from_secs(60)).await;
    assert_eq!(handle.fetch_more(query).await, Some(true));
    let rows = batch(next(&mut events).await);
    assert!(rows.elapsed < Duration::from_secs(1), "{:?}", rows.elapsed);
}
