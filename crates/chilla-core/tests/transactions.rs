//! Manual 모드와 Commit, Rollback을 실제 구성(test DB)으로 검사한다.
//! test DB는 `scripts/test-db.sh up`으로 띄운다. 다른 test와 겹치지 않게 `m6_` 이름의 table을 쓴다.

mod support;

use chilla_core::domain::{
    EndOutcome, EndResult, QueryEvent, QueryOutcome, SessionId, SessionInfo, TxEnd, TxMode,
    TxStatus,
};
use support::{TestApp, admin, app_with_project, next, sink, store_password};

/// 비밀번호를 저장하고 세션 하나를 연다.
async fn open_session(app: &TestApp) -> SessionInfo {
    store_password(app).await;
    app.open_session("local").await.unwrap()
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
