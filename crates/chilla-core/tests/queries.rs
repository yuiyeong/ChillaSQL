//! `App`의 쿼리 use case를 실제 구성(test DB, `PgQuerySplitter`)으로 검사한다.
//! test DB는 `scripts/test-db.sh up`으로 띄운다.

mod support;

use std::time::{Duration, Instant};

use chilla_core::application::AppError;
use chilla_core::domain::{
    QueryEvent, QueryId, QueryOutcome, RowBatch, SessionId, SessionInfo, SessionState,
    StatementSpan, TxMode, TxStatus,
};
use support::{
    TestApp, activity, admin, app_with_project, backend_exists, eventually, finished, next, sink,
    store_password, terminate_backend, wait_until_running,
};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::timeout;

type Events = UnboundedReceiver<QueryEvent>;

const OPEN: SessionState = SessionState::Open { tx: TxStatus::Idle };

/// 비밀번호를 저장하고 세션 하나를 연다.
async fn open_session(app: &TestApp) -> SessionInfo {
    store_password(app).await;
    app.open_session("local").await.unwrap()
}

/// 쿼리를 실행하고 그 이벤트를 받는 쪽을 돌려준다.
async fn start(app: &TestApp, session: SessionId, sql: &str) -> (QueryId, Events) {
    let (sink, events) = sink();
    let query = app
        .execute(session, sql.into(), TxMode::Auto, false, sink)
        .await
        .unwrap();
    (query, events)
}

/// 쿼리를 실행하고 `Finished`까지의 이벤트를 모두 돌려준다.
async fn run(app: &TestApp, session: SessionId, sql: &str) -> Vec<QueryEvent> {
    let (_, mut events) = start(app, session, sql).await;
    let mut all = Vec::new();
    loop {
        let event = next(&mut events).await;
        let done = matches!(event, QueryEvent::Finished { .. });
        all.push(event);
        if done {
            return all;
        }
    }
}

fn outcome(event: &QueryEvent) -> &QueryOutcome {
    match event {
        QueryEvent::Finished { outcome, .. } => outcome,
        other => panic!("Finished가 아니다: {other:?}"),
    }
}

async fn rows(events: &mut Events) -> RowBatch {
    match next(events).await {
        QueryEvent::Rows(batch) => batch,
        other => panic!("Rows가 아니다: {other:?}"),
    }
}

fn completed(rows: u64) -> QueryOutcome {
    QueryOutcome::Completed { rows }
}

/// M2 완료 기준: 100만 행 쿼리의 첫 500행이 0.1초 안에 도착한다.
/// execute를 부른 때부터 재므로 "DB 응답 후"보다 엄격하다.
#[tokio::test]
async fn first_500_rows_of_a_million_arrive_within_100ms() {
    let admin = admin().await;
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let t = Instant::now();
    let (_, mut events) = start(&app, session.id, "SELECT * FROM big_table").await;
    let QueryEvent::Columns(columns) = next(&mut events).await else {
        panic!("첫 이벤트는 Columns여야 한다");
    };
    let batch = rows(&mut events).await;
    let arrived = t.elapsed();
    println!("첫 500행이 도착하기까지: {arrived:?}");

    let names: Vec<&str> = columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "id",
            "name",
            "amount",
            "created_at",
            "is_active",
            "tags",
            "payload",
            "note"
        ]
    );
    assert_eq!(batch.first_row, 0);
    assert_eq!(batch.rows.len(), 500);
    assert_eq!(batch.retained_from, 0);
    assert!(batch.rows.iter().all(|row| row.len() == 8));
    assert!(arrived < Duration::from_millis(100), "{arrived:?}");

    // 화면이 fetch_more를 부르기 전에는 다음 batch를 읽지 않는다.
    assert!(
        timeout(Duration::from_millis(300), events.recv())
            .await
            .is_err()
    );
    let (state, wait_event) = activity(&admin, session.backend_pid).await;
    assert_eq!(state.as_deref(), Some("active"));
    assert_eq!(wait_event.as_deref(), Some("ClientWrite"));

    app.close_session(session.id).await.unwrap();
}

#[tokio::test]
async fn fetch_more_continues_where_the_batch_ended() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let (query, mut events) = start(&app, session.id, "SELECT id FROM big_table ORDER BY id").await;
    assert!(matches!(next(&mut events).await, QueryEvent::Columns(_)));
    let first = rows(&mut events).await;
    assert_eq!(first.first_row, 0);
    assert_eq!(first.rows.last().unwrap(), &[Some("500".to_string())]);

    app.fetch_more(session.id, query).await.unwrap();
    let second = rows(&mut events).await;
    assert_eq!(second.first_row, 500);
    assert_eq!(second.rows[0], [Some("501".to_string())]);
    assert_eq!(second.rows.len(), 500);

    app.close_session(session.id).await.unwrap();
}

/// M2 완료 기준: 10초짜리 pg_sleep이 취소 후 1초 안에 끝난다.
#[tokio::test]
async fn sleeping_query_ends_within_a_second_of_cancel() {
    let admin = admin().await;
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let (query, mut events) = start(&app, session.id, "SELECT pg_sleep(10)").await;
    wait_until_running(&admin, session.backend_pid).await;
    let t = Instant::now();
    assert_eq!(app.cancel_query(session.id, query).await, Ok(()));
    assert_eq!(finished(&mut events).await, QueryOutcome::Cancelled);
    let ended = t.elapsed();
    println!("cancel 뒤 쿼리가 끝나기까지: {ended:?}");
    assert!(ended < Duration::from_secs(1), "{ended:?}");

    assert_eq!(app.session_state(session.id).await, Ok(OPEN));
    let events = run(&app, session.id, "SELECT 42").await;
    assert_eq!(outcome(events.last().unwrap()), &completed(1));

    app.close_session(session.id).await.unwrap();
}

#[tokio::test]
async fn next_query_discards_the_rest_of_a_big_result() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let (_, mut first) = start(&app, session.id, "SELECT * FROM big_table").await;
    assert!(matches!(next(&mut first).await, QueryEvent::Columns(_)));
    rows(&mut first).await;

    let t = Instant::now();
    let (_, mut second) = start(&app, session.id, "SELECT 42").await;
    assert_eq!(finished(&mut first).await, QueryOutcome::Discarded);
    assert!(matches!(next(&mut second).await, QueryEvent::Columns(_)));
    assert_eq!(rows(&mut second).await.rows, [vec![Some("42".to_string())]]);
    assert_eq!(finished(&mut second).await, completed(1));
    assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());

    app.close_session(session.id).await.unwrap();
}

/// Review Focus 2
#[tokio::test]
async fn a_late_cancel_does_not_hit_the_next_query() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    for round in 0..20 {
        let (_, _first) = start(&app, session.id, "SELECT pg_sleep(10)").await;
        let (_, mut second) = start(&app, session.id, "SELECT 42").await;
        assert_eq!(finished(&mut second).await, completed(1), "round {round}");
    }

    app.close_session(session.id).await.unwrap();
}

#[tokio::test]
async fn rows_affected_and_transaction_state_follow_the_statements() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;
    let state = async || app.session_state(session.id).await.unwrap();

    // 영향받은 행 수만 있는 문장은 Columns 이벤트가 없다.
    let events = run(&app, session.id, "CREATE TEMP TABLE q (id int)").await;
    assert_eq!(events.len(), 1);
    assert_eq!(outcome(&events[0]), &completed(0));

    run(&app, session.id, "BEGIN").await;
    assert_eq!(
        state().await,
        SessionState::Open {
            tx: TxStatus::InTransaction
        }
    );

    let events = run(&app, session.id, "INSERT INTO q VALUES (1),(2),(3)").await;
    assert_eq!(outcome(events.last().unwrap()), &completed(3));

    let events = run(&app, session.id, "SELECT 1/0").await;
    let QueryOutcome::Failed(error) = outcome(events.last().unwrap()) else {
        panic!("Failed가 아니다: {events:?}");
    };
    assert_eq!(error.code, "22012");
    assert_eq!(
        state().await,
        SessionState::Open {
            tx: TxStatus::Failed
        }
    );

    run(&app, session.id, "ROLLBACK").await;
    assert_eq!(state().await, OPEN);

    app.close_session(session.id).await.unwrap();
}

#[tokio::test]
async fn state_answers_while_a_result_is_half_read() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let (_, mut events) = start(&app, session.id, "SELECT * FROM big_table").await;
    assert!(matches!(next(&mut events).await, QueryEvent::Columns(_)));
    rows(&mut events).await;

    let state = timeout(Duration::from_secs(1), app.session_state(session.id))
        .await
        .expect("1초 안에 답하지 않았다");
    assert_eq!(state, Ok(OPEN));

    app.close_session(session.id).await.unwrap();
}

#[tokio::test]
async fn only_one_statement_runs_at_a_time() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    assert_eq!(
        app.execute(
            session.id,
            "SELECT 1; SELECT 2".into(),
            TxMode::Auto,
            false,
            sink().0
        )
        .await,
        Err(AppError::MultipleStatements { count: 2 })
    );
    let events = run(&app, session.id, "DO $$ BEGIN PERFORM 1; END $$").await;
    assert_eq!(outcome(events.last().unwrap()), &completed(0));
    assert_eq!(
        app.execute(
            session.id,
            "-- nothing".into(),
            TxMode::Auto,
            false,
            sink().0
        )
        .await,
        Err(AppError::EmptyStatement)
    );

    app.close_session(session.id).await.unwrap();
}

/// 끝까지 읽는 실행은 남은 행을 버리려고 cancel하지 않으므로 `UPDATE … RETURNING`의 변경이 남는다.
/// 첫 batch만 오고, 서버가 센 행 수로 끝난다.
#[tokio::test]
async fn a_drained_statement_keeps_its_changes() {
    for mode in [TxMode::Auto, TxMode::Manual] {
        let (app, _dir) = app_with_project().await;
        let session = open_session(&app).await;
        let setup = "CREATE TEMP TABLE drained (v int)";
        run(&app, session.id, setup).await;
        run(
            &app,
            session.id,
            "INSERT INTO drained SELECT 0 FROM generate_series(1, 1000)",
        )
        .await;

        let (sink, mut events) = sink();
        app.execute(
            session.id,
            "UPDATE drained SET v = v + 1 RETURNING *".into(),
            mode,
            true,
            sink,
        )
        .await
        .unwrap();
        assert!(matches!(next(&mut events).await, QueryEvent::Columns(_)));
        let batch = rows(&mut events).await;
        assert_eq!((batch.first_row, batch.rows.len()), (0, 500));
        assert_eq!(finished(&mut events).await, completed(1000));

        let events = run(
            &app,
            session.id,
            "SELECT count(*) FILTER (WHERE v = 1), count(*) FROM drained",
        )
        .await;
        let QueryEvent::Rows(counts) = &events[1] else {
            panic!("Rows가 아니다: {events:?}");
        };
        assert_eq!(
            counts.rows,
            [[Some("1000".to_string()), Some("1000".to_string())]],
            "{mode:?}"
        );

        app.close_session(session.id).await.unwrap();
    }
}

/// Review Focus 4
#[tokio::test]
async fn text_that_cannot_be_split_gets_the_server_error() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let events = run(&app, session.id, "SELECT 'open").await;
    let QueryOutcome::Failed(error) = outcome(events.last().unwrap()) else {
        panic!("Failed가 아니다: {events:?}");
    };
    assert_eq!(error.code, "42601");

    let events = run(&app, session.id, "SELECT *\nFROM nope").await;
    let QueryOutcome::Failed(error) = outcome(events.last().unwrap()) else {
        panic!("Failed가 아니다: {events:?}");
    };
    assert_eq!(error.code, "42P01");
    assert_eq!(error.position, Some(15));

    app.close_session(session.id).await.unwrap();
}

/// Review Focus 3
#[tokio::test]
async fn terminated_backend_finishes_the_query_and_loses_the_session() {
    let admin = admin().await;
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let (_, mut events) = start(&app, session.id, "SELECT pg_sleep(10)").await;
    wait_until_running(&admin, session.backend_pid).await;
    terminate_backend(&admin, session.backend_pid).await;

    let QueryOutcome::Failed(error) = finished(&mut events).await else {
        panic!("Failed가 아니다");
    };
    assert_eq!(error.code, "57P01");
    assert!(
        eventually(async || app.session_state(session.id).await == Ok(SessionState::Lost)).await
    );
    assert_eq!(app.close_session(session.id).await, Ok(()));
}

#[tokio::test]
async fn text_that_cannot_be_sent_is_a_client_error() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let events = run(&app, session.id, "SELECT 1\0").await;
    assert!(
        matches!(
            outcome(events.last().unwrap()),
            QueryOutcome::ClientError { .. }
        ),
        "{events:?}"
    );
    assert_eq!(app.session_state(session.id).await, Ok(OPEN));

    app.close_session(session.id).await.unwrap();
}

/// COPY … FROM STDIN은 지원하지 않는다. 세션을 일부러 잃는다.
#[tokio::test]
async fn copy_from_stdin_loses_the_session() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;
    run(&app, session.id, "CREATE TEMP TABLE c (id int)").await;

    let events = run(&app, session.id, "COPY c FROM STDIN").await;
    assert!(
        matches!(
            outcome(events.last().unwrap()),
            QueryOutcome::ConnectionLost { .. }
        ),
        "{events:?}"
    );
    assert!(
        eventually(async || app.session_state(session.id).await == Ok(SessionState::Lost)).await
    );
    assert_eq!(app.close_session(session.id).await, Ok(()));
}

#[tokio::test]
async fn closing_a_session_stops_its_running_query() {
    let admin = admin().await;
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let (_, _events) = start(&app, session.id, "SELECT pg_sleep(10)").await;
    wait_until_running(&admin, session.backend_pid).await;

    let closed = timeout(Duration::from_secs(2), app.close_session(session.id))
        .await
        .expect("2초 안에 닫히지 않았다");
    assert_eq!(closed, Ok(()));
    assert!(eventually(async || !backend_exists(&admin, session.backend_pid).await).await);
}

#[tokio::test]
async fn split_statements_uses_the_scanner() {
    let (app, _dir) = app_with_project().await;

    assert_eq!(
        app.split_statements("SELECT 1; SELEC 2"),
        Ok(vec![
            StatementSpan { start: 0, end: 8 },
            StatementSpan { start: 10, end: 17 }
        ])
    );
}
