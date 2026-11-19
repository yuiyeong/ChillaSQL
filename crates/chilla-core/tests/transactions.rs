//! Manual 모드와 Commit, Rollback을 실제 구성(test DB)으로 검사한다.
//! test DB는 `scripts/test-db.sh up`으로 띄운다. 다른 test와 겹치지 않게 `m6_` 이름의 table을 쓴다.

mod support;

use std::time::Duration;

use chilla_core::domain::{
    EndOutcome, EndResult, QueryEvent, QueryId, QueryOutcome, SessionId, SessionInfo, TxEnd,
    TxMode, TxStatus,
};
use support::{TestApp, admin, app_with_project, next, sink, store_password};

/// 비밀번호를 저장하고 세션 하나를 연다.
async fn open_session(app: &TestApp) -> SessionInfo {
    store_password(app).await;
    app.open_session("local").await.unwrap()
}

/// `Finished`까지 읽고 그 outcome과 tx를 돌려준다.
async fn finished_tx(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<QueryEvent>,
) -> (QueryOutcome, Option<TxStatus>) {
    loop {
        if let QueryEvent::Finished { outcome, tx, .. } = next(events).await {
            return (outcome, tx);
        }
    }
}

/// 쿼리를 실행하고 `Finished`의 outcome과 tx를 돌려준다. 그 사이의 행은 버린다.
async fn run(
    app: &TestApp,
    session: SessionId,
    sql: &str,
    mode: TxMode,
) -> (QueryOutcome, Option<TxStatus>) {
    let (sink, mut events) = sink();
    app.execute(session, sql.into(), mode, sink).await.unwrap();
    loop {
        if let QueryEvent::Finished { outcome, tx, .. } = next(&mut events).await {
            return (outcome, tx);
        }
    }
}

/// `table`의 행 수를 `session`에서 Auto로 센다.
async fn count(app: &TestApp, session: SessionId, table: &str) -> String {
    let (sink, mut events) = sink();
    let sql = format!("SELECT count(*) FROM {table}");
    app.execute(session, sql, TxMode::Auto, sink).await.unwrap();
    loop {
        match next(&mut events).await {
            QueryEvent::Rows(batch) => return batch.rows[0][0].clone().unwrap(),
            QueryEvent::Finished { outcome, .. } => panic!("행이 없다: {outcome:?}"),
            QueryEvent::Columns(_) => {}
        }
    }
}

fn server_code(outcome: &QueryOutcome) -> &str {
    match outcome {
        QueryOutcome::Failed(error) => &error.code,
        other => panic!("Failed가 아니다: {other:?}"),
    }
}

fn ended() -> EndResult {
    EndResult {
        outcome: EndOutcome::Ended,
        tx: Some(TxStatus::Idle),
    }
}

#[tokio::test]
async fn manual_commit_is_visible_to_another_session() {
    let admin = admin().await;
    admin
        .batch_execute(
            "DROP TABLE IF EXISTS m6_commit_visible; CREATE TABLE m6_commit_visible (id int)",
        )
        .await
        .unwrap();
    let (app, _dir) = app_with_project().await;
    let a = open_session(&app).await;
    let b = app.open_session("local").await.unwrap();

    let inserted = run(
        &app,
        a.id,
        "INSERT INTO m6_commit_visible VALUES (1)",
        TxMode::Manual,
    )
    .await;
    assert_eq!(
        inserted,
        (
            QueryOutcome::Completed { rows: 1 },
            Some(TxStatus::InTransaction)
        )
    );
    assert_eq!(count(&app, b.id, "m6_commit_visible").await, "0");

    assert_eq!(app.end_transaction(a.id, TxEnd::Commit).await, Ok(ended()));
    assert_eq!(count(&app, b.id, "m6_commit_visible").await, "1");

    app.close_session(a.id).await.unwrap();
    app.close_session(b.id).await.unwrap();
    admin
        .batch_execute("DROP TABLE m6_commit_visible")
        .await
        .unwrap();
}

#[tokio::test]
async fn manual_rollback_discards_the_change() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;
    run(
        &app,
        session.id,
        "CREATE TEMP TABLE m6_rollback (id int)",
        TxMode::Auto,
    )
    .await;

    let inserted = run(
        &app,
        session.id,
        "INSERT INTO m6_rollback VALUES (1), (2)",
        TxMode::Manual,
    )
    .await;
    assert_eq!(inserted.0, QueryOutcome::Completed { rows: 2 });
    assert_eq!(count(&app, session.id, "m6_rollback").await, "2");

    assert_eq!(
        app.end_transaction(session.id, TxEnd::Rollback).await,
        Ok(ended())
    );
    assert_eq!(count(&app, session.id, "m6_rollback").await, "0");

    app.close_session(session.id).await.unwrap();
}

#[tokio::test]
async fn commit_reports_a_deferred_constraint_error() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;
    for sql in [
        "CREATE TEMP TABLE m6_parent (id int PRIMARY KEY)",
        "CREATE TEMP TABLE m6_child (parent int REFERENCES m6_parent DEFERRABLE INITIALLY DEFERRED)",
    ] {
        let (outcome, _) = run(&app, session.id, sql, TxMode::Auto).await;
        assert_eq!(outcome, QueryOutcome::Completed { rows: 0 });
    }

    // 외래 키는 COMMIT에서 검사한다.
    let inserted = run(
        &app,
        session.id,
        "INSERT INTO m6_child VALUES (1)",
        TxMode::Manual,
    )
    .await;
    assert_eq!(inserted.0, QueryOutcome::Completed { rows: 1 });

    let result = app
        .end_transaction(session.id, TxEnd::Commit)
        .await
        .unwrap();
    let EndOutcome::Server(error) = &result.outcome else {
        panic!("Server가 아니다: {result:?}");
    };
    assert_eq!(error.code, "23503");
    assert_eq!(result.tx, Some(TxStatus::Idle));
    assert_eq!(count(&app, session.id, "m6_child").await, "0");

    app.close_session(session.id).await.unwrap();
}

#[tokio::test]
async fn a_failed_statement_leaves_the_transaction_failed() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let (outcome, tx) = run(&app, session.id, "SELECT * FROM m6_missing", TxMode::Manual).await;
    assert_eq!(server_code(&outcome), "42P01");
    assert_eq!(tx, Some(TxStatus::Failed));

    let (outcome, tx) = run(&app, session.id, "SELECT 1", TxMode::Manual).await;
    assert_eq!(server_code(&outcome), "25P02");
    assert_eq!(tx, Some(TxStatus::Failed));

    assert_eq!(
        app.end_transaction(session.id, TxEnd::Commit).await,
        Ok(EndResult {
            outcome: EndOutcome::TransactionFailed,
            tx: Some(TxStatus::Failed),
        })
    );
    assert_eq!(
        app.end_transaction(session.id, TxEnd::Rollback).await,
        Ok(ended())
    );

    app.close_session(session.id).await.unwrap();
}

/// 받다 만 결과를 cancel로 버리면 문장이 `57014`로 실패해 트랜잭션이 failed가 된다. 세션은 그 문장
/// 앞에 둔 savepoint로 되돌려 트랜잭션을 열린 채로 둔다. 남은 행을 다 읽지 않으므로 시간에 기대지 않는다.
#[tokio::test]
async fn discarding_a_paused_result_inside_a_transaction_keeps_it_open() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let (big, mut first) = sink();
    app.execute(
        session.id,
        // socket buffer보다 훨씬 커서 첫 batch 뒤에 서버는 문장을 끝내지 못하고 기다린다.
        "SELECT id FROM big_table".into(),
        TxMode::Manual,
        big,
    )
    .await
    .unwrap();
    assert!(matches!(next(&mut first).await, QueryEvent::Columns(_)));
    assert!(matches!(next(&mut first).await, QueryEvent::Rows(_)));

    let (outcome, tx) = run(&app, session.id, "SELECT 1", TxMode::Manual).await;
    assert_eq!(outcome, QueryOutcome::Completed { rows: 1 });
    assert_eq!(tx, Some(TxStatus::InTransaction));
    assert_eq!(
        finished_tx(&mut first).await,
        (QueryOutcome::Discarded, Some(TxStatus::InTransaction))
    );

    assert_eq!(
        app.end_transaction(session.id, TxEnd::Rollback).await,
        Ok(ended())
    );
    app.close_session(session.id).await.unwrap();
}

/// `m6_sp`(id 1..=2000, v = 0)를 temp table로 만들고 Manual로 `(0, 0)`을 넣는다. 트랜잭션이 열린다.
async fn insert_then_start_update(app: &TestApp, session: SessionId) -> (QueryId, EventsOf) {
    let (outcome, _) = run(
        app,
        session,
        "CREATE TEMP TABLE m6_sp AS SELECT g AS id, 0 AS v FROM generate_series(1, 2000) g",
        TxMode::Auto,
    )
    .await;
    assert_eq!(outcome, QueryOutcome::Completed { rows: 2000 });
    let inserted = run(
        app,
        session,
        "INSERT INTO m6_sp VALUES (0, 0)",
        TxMode::Manual,
    )
    .await;
    assert_eq!(
        inserted,
        (
            QueryOutcome::Completed { rows: 1 },
            Some(TxStatus::InTransaction)
        )
    );

    // 결과가 batch 여러 개라 첫 batch 뒤에 멈춘다.
    let (sink, mut events) = sink();
    let query = app
        .execute(
            session,
            "UPDATE m6_sp SET v = 1 RETURNING id".into(),
            TxMode::Manual,
            sink,
        )
        .await
        .unwrap();
    assert!(matches!(next(&mut events).await, QueryEvent::Columns(_)));
    assert!(matches!(next(&mut events).await, QueryEvent::Rows(_)));
    (query, events)
}

type EventsOf = tokio::sync::mpsc::UnboundedReceiver<QueryEvent>;

/// `m6_sp`의 행 수와 `v = 1`인 행 수.
async fn counts(app: &TestApp, session: SessionId) -> (String, String) {
    (
        count(app, session, "m6_sp").await,
        count(app, session, "m6_sp WHERE v = 1").await,
    )
}

/// 다음 문장이 받다 만 `UPDATE … RETURNING`을 버리면 그 문장만 되돌린다. 서버가 `UPDATE`를 이미
/// 끝냈어도(결과 행만 남은 경우) 적용되지 않는다. 앞의 `INSERT`는 남고 트랜잭션은 열린 채다.
#[tokio::test]
async fn a_discarded_update_returning_is_rolled_back_and_earlier_statements_stay() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;
    let (_, mut update) = insert_then_start_update(&app, session.id).await;

    let (outcome, tx) = run(&app, session.id, "SELECT 1", TxMode::Manual).await;
    assert_eq!(
        (outcome, tx),
        (
            QueryOutcome::Completed { rows: 1 },
            Some(TxStatus::InTransaction)
        )
    );
    assert_eq!(
        finished_tx(&mut update).await,
        (QueryOutcome::Discarded, Some(TxStatus::InTransaction))
    );
    assert_eq!(
        counts(&app, session.id).await,
        ("2001".to_string(), "0".to_string())
    );

    assert_eq!(
        app.end_transaction(session.id, TxEnd::Rollback).await,
        Ok(ended())
    );
    app.close_session(session.id).await.unwrap();
}

/// 사용자의 Cancel도 그 문장만 되돌린다. 트랜잭션은 열린 채이고 앞 문장은 남는다.
#[tokio::test]
async fn user_cancel_inside_a_transaction_keeps_it_open() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;
    let (update, mut update_events) = insert_then_start_update(&app, session.id).await;
    app.cancel_query(session.id, update).await.unwrap();
    assert_eq!(
        finished_tx(&mut update_events).await,
        (QueryOutcome::Cancelled, Some(TxStatus::InTransaction))
    );

    // 서버에서 실행 중인 문장도 같다.
    let (sink, mut sleeping) = sink();
    let sleep = app
        .execute(
            session.id,
            "SELECT pg_sleep(30)".into(),
            TxMode::Manual,
            sink,
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    app.cancel_query(session.id, sleep).await.unwrap();
    assert_eq!(
        finished_tx(&mut sleeping).await,
        (QueryOutcome::Cancelled, Some(TxStatus::InTransaction))
    );

    assert_eq!(
        counts(&app, session.id).await,
        ("2001".to_string(), "0".to_string())
    );
    let (outcome, tx) = run(&app, session.id, "SELECT 1", TxMode::Manual).await;
    assert_eq!(
        (outcome, tx),
        (
            QueryOutcome::Completed { rows: 1 },
            Some(TxStatus::InTransaction)
        )
    );
    app.close_session(session.id).await.unwrap();
}

/// Commit은 실행 중인 문장을 되돌린 뒤 보낸다. 버린 문장은 Commit되지 않는다.
#[tokio::test]
async fn commit_rolls_back_the_running_statement_first() {
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;
    let (_, mut update) = insert_then_start_update(&app, session.id).await;

    assert_eq!(
        app.end_transaction(session.id, TxEnd::Commit).await,
        Ok(ended())
    );
    assert_eq!(
        finished_tx(&mut update).await,
        (QueryOutcome::Discarded, Some(TxStatus::InTransaction))
    );
    assert_eq!(
        counts(&app, session.id).await,
        ("2001".to_string(), "0".to_string())
    );
    app.close_session(session.id).await.unwrap();
}
