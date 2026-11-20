//! 셀 편집의 UPDATE를 실제 구성(test DB)으로 한 단위로 보내는지 검사한다.
//! test DB는 `scripts/test-db.sh up`으로 띄운다. test마다 `m10_apply_` schema를 따로 만들고 끝에 지운다.

mod support;

use chilla_core::domain::{
    ApplyOutcome, ApplyResult, QueryEvent, QueryOutcome, SessionId, TxEnd, TxMode, TxStatus,
};
use support::{TestApp, admin, app_with_project, next, sink, store_password};

/// test가 만든 schema. 시작할 때 지난 실행이 남긴 것을 지우고, test가 실패해도 drop할 때 지운다.
struct Schema(String);

impl Schema {
    async fn create(name: &str, sql: &str) -> Self {
        let name = format!("m10_apply_{name}");
        admin()
            .await
            .batch_execute(&format!(
                "DROP SCHEMA IF EXISTS {name} CASCADE; CREATE SCHEMA {name}; SET search_path = {name}; {sql}"
            ))
            .await
            .unwrap();
        Self(name)
    }
}

impl Drop for Schema {
    /// test의 runtime은 이미 멈추는 중일 수 있어 따로 띄운 thread와 runtime에서 지운다.
    fn drop(&mut self) {
        let sql = format!("DROP SCHEMA IF EXISTS {} CASCADE", self.0);
        let _ = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async { admin().await.batch_execute(&sql).await })
        })
        .join();
    }
}

async fn open_session(app: &TestApp) -> SessionId {
    store_password(app).await;
    app.open_session("local").await.unwrap().id
}

/// 다른 연결에서 본 값.
async fn value(sql: &str) -> String {
    admin().await.query_one(sql, &[]).await.unwrap().get(0)
}

fn texts(values: &[&str]) -> Vec<Vec<Option<String>>> {
    values.iter().map(|v| vec![Some(v.to_string())]).collect()
}

fn statements(sql: &[&str]) -> Vec<String> {
    sql.iter().map(|s| s.to_string()).collect()
}

/// 쿼리를 실행하고 `Finished`의 outcome을 돌려준다.
async fn run(app: &TestApp, session: SessionId, sql: &str, mode: TxMode) -> QueryOutcome {
    let (sink, mut events) = sink();
    app.execute(session, sql.into(), mode, false, sink)
        .await
        .unwrap();
    loop {
        if let QueryEvent::Finished { outcome, .. } = next(&mut events).await {
            return outcome;
        }
    }
}

#[tokio::test]
async fn auto_mode_commits() {
    let schema = Schema::create(
        "auto",
        "CREATE TABLE t (id int PRIMARY KEY, at timestamptz); INSERT INTO t VALUES (1, NULL)",
    )
    .await;
    let s = &schema.0;
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let result = app
        .apply_edits(
            session,
            statements(&[&format!(
                "UPDATE {s}.t SET at = '2026-11-20 00:00:00+00' WHERE id = 1 RETURNING at"
            )]),
            TxMode::Auto,
        )
        .await
        .unwrap();

    // 세션의 time zone은 Mac의 것이라 text는 test 환경마다 다르다. 서버가 만든 text가 그대로 오고,
    // 같은 시각을 가리키는지만 본다.
    let ApplyOutcome::Applied { rows } = &result.outcome else {
        panic!("{result:?}");
    };
    let returned = rows[0][0].clone().unwrap();
    let same = value(&format!(
        "SELECT ('{returned}'::timestamptz = '2026-11-20 00:00:00+00'::timestamptz)::text"
    ))
    .await;
    assert_eq!(same, "true", "{returned}");
    assert_eq!(result.tx, Some(TxStatus::Idle));
    assert_eq!(
        value(&format!(
            "SELECT (at = '2026-11-20 00:00:00+00'::timestamptz)::text FROM {s}.t WHERE id = 1"
        ))
        .await,
        "true"
    );
}

#[tokio::test]
async fn missing_row_rolls_back_everything() {
    let schema = Schema::create(
        "missing",
        "CREATE TABLE t (id int PRIMARY KEY, a int); INSERT INTO t VALUES (1, 0), (2, 0)",
    )
    .await;
    let s = &schema.0;
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let result = app
        .apply_edits(
            session,
            statements(&[
                &format!("UPDATE {s}.t SET a = 5 WHERE id = 1 RETURNING a"),
                &format!("UPDATE {s}.t SET a = 5 WHERE id = 99 RETURNING a"),
            ]),
            TxMode::Auto,
        )
        .await
        .unwrap();

    assert_eq!(
        result,
        ApplyResult {
            outcome: ApplyOutcome::WrongRowCount { index: 1, rows: 0 },
            tx: Some(TxStatus::Idle),
        }
    );
    assert_eq!(value(&format!("SELECT sum(a)::text FROM {s}.t")).await, "0");
}

#[tokio::test]
async fn more_than_one_row_rolls_back_everything() {
    let schema = Schema::create(
        "many",
        "CREATE TABLE t (id int, a int); INSERT INTO t VALUES (1, 0), (1, 0)",
    )
    .await;
    let s = &schema.0;
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let result = app
        .apply_edits(
            session,
            statements(&[&format!("UPDATE {s}.t SET a = 5 WHERE id = 1 RETURNING a")]),
            TxMode::Auto,
        )
        .await
        .unwrap();

    assert_eq!(
        result.outcome,
        ApplyOutcome::WrongRowCount { index: 0, rows: 2 }
    );
    assert_eq!(value(&format!("SELECT sum(a)::text FROM {s}.t")).await, "0");
}

#[tokio::test]
async fn server_error_in_a_transaction_leaves_it_open() {
    let schema = Schema::create(
        "open_tx",
        "CREATE TABLE t (id int PRIMARY KEY, a int); INSERT INTO t VALUES (1, 0), (2, 0)",
    )
    .await;
    let s = &schema.0;
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;
    let inserted = run(
        &app,
        session,
        &format!("INSERT INTO {s}.t VALUES (10, 0)"),
        TxMode::Manual,
    )
    .await;
    assert_eq!(inserted, QueryOutcome::Completed { rows: 1 });

    // 둘째 문장이 PK를 겹치게 만든다.
    let result = app
        .apply_edits(
            session,
            statements(&[
                &format!("UPDATE {s}.t SET a = 5 WHERE id = 1 RETURNING a"),
                &format!("UPDATE {s}.t SET id = 2 WHERE id = 1 RETURNING id"),
            ]),
            TxMode::Manual,
        )
        .await
        .unwrap();

    match &result.outcome {
        ApplyOutcome::Failed {
            index: Some(1),
            error,
        } => assert_eq!(error.code, "23505"),
        other => panic!("{other:?}"),
    }
    assert_eq!(result.tx, Some(TxStatus::InTransaction));

    // 트랜잭션은 failed가 아니고, 앞서 넣은 행은 남아 있으며, Apply의 변경은 없다.
    let in_tx = run(
        &app,
        session,
        &format!("UPDATE {s}.t SET a = 7 WHERE id = 10"),
        TxMode::Manual,
    )
    .await;
    assert_eq!(in_tx, QueryOutcome::Completed { rows: 1 });
    let ended = app.end_transaction(session, TxEnd::Commit).await.unwrap();
    assert_eq!(ended.tx, Some(TxStatus::Idle));
    assert_eq!(
        value(&format!(
            "SELECT string_agg(id || ':' || a, ',' ORDER BY id) FROM {s}.t"
        ))
        .await,
        "1:0,2:0,10:7"
    );
}

#[tokio::test]
async fn manual_mode_keeps_the_applied_edits_in_the_open_transaction() {
    let schema = Schema::create(
        "manual",
        "CREATE TABLE t (id int PRIMARY KEY, a int); INSERT INTO t VALUES (1, 0)",
    )
    .await;
    let s = &schema.0;
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let result = app
        .apply_edits(
            session,
            statements(&[&format!("UPDATE {s}.t SET a = 5 WHERE id = 1 RETURNING a")]),
            TxMode::Manual,
        )
        .await
        .unwrap();

    assert_eq!(
        result,
        ApplyResult {
            outcome: ApplyOutcome::Applied {
                rows: texts(&["5"])
            },
            tx: Some(TxStatus::InTransaction),
        }
    );
    assert_eq!(value(&format!("SELECT a::text FROM {s}.t")).await, "0");
    app.end_transaction(session, TxEnd::Commit).await.unwrap();
    assert_eq!(value(&format!("SELECT a::text FROM {s}.t")).await, "5");
}

#[tokio::test]
async fn deferred_constraint_fails_at_commit() {
    let schema = Schema::create(
        "deferred",
        "CREATE TABLE parent (id int PRIMARY KEY);
         INSERT INTO parent VALUES (1);
         CREATE TABLE child (id int PRIMARY KEY, parent_id int
             REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED);
         INSERT INTO child VALUES (1, 1)",
    )
    .await;
    let s = &schema.0;
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;

    let result = app
        .apply_edits(
            session,
            statements(&[&format!(
                "UPDATE {s}.child SET parent_id = 99 WHERE id = 1 RETURNING parent_id"
            )]),
            TxMode::Auto,
        )
        .await
        .unwrap();

    match &result.outcome {
        ApplyOutcome::Failed { index: None, error } => assert_eq!(error.code, "23503"),
        other => panic!("{other:?}"),
    }
    assert_eq!(result.tx, Some(TxStatus::Idle));
    assert_eq!(
        value(&format!("SELECT parent_id::text FROM {s}.child")).await,
        "1"
    );
}

/// 화면이 만드는 literal(`E'…'`, 따옴표 두 번, 줄바꿈, 한글)이 다시 읽어도 같다.
#[tokio::test]
async fn e_string_values_round_trip() {
    let schema = Schema::create(
        "text",
        "CREATE TABLE t (id int PRIMARY KEY, name text); INSERT INTO t VALUES (1, ''), (2, ''), (3, ''), (4, '')",
    )
    .await;
    let s = &schema.0;
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;
    let expected = ["C:\\temp\\n", "O'Brien", "첫째 줄\n둘째 줄 한글", "a\\'b"];

    let result = app
        .apply_edits(
            session,
            statements(&[
                &format!(r"UPDATE {s}.t SET name = E'C:\\temp\\n' WHERE id = 1 RETURNING name"),
                &format!("UPDATE {s}.t SET name = 'O''Brien' WHERE id = 2 RETURNING name"),
                &format!(
                    "UPDATE {s}.t SET name = E'첫째 줄\\n둘째 줄 한글' WHERE id = 3 RETURNING name"
                ),
                &format!(r"UPDATE {s}.t SET name = E'a\\\'b' WHERE id = 4 RETURNING name"),
            ]),
            TxMode::Auto,
        )
        .await
        .unwrap();

    assert_eq!(
        result.outcome,
        ApplyOutcome::Applied {
            rows: texts(&expected)
        }
    );
    let rows = admin()
        .await
        .query(&format!("SELECT name FROM {s}.t ORDER BY id"), &[])
        .await
        .unwrap();
    let stored: Vec<String> = rows.iter().map(|row| row.get(0)).collect();
    assert_eq!(stored, expected);
}

/// 열린 쿼리가 있으면 보내지 않고, 그 결과는 이어 받을 수 있다.
#[tokio::test]
async fn open_query_is_busy_and_keeps_its_result() {
    let schema = Schema::create(
        "busy",
        "CREATE TABLE t (id int PRIMARY KEY, a int); INSERT INTO t VALUES (1, 0)",
    )
    .await;
    let s = &schema.0;
    let (app, _dir) = app_with_project().await;
    let session = open_session(&app).await;
    let (sink, mut events) = sink();
    let query = app
        .execute(
            session,
            "SELECT generate_series(1, 1200)".into(),
            TxMode::Auto,
            false,
            sink,
        )
        .await
        .unwrap();
    let mut received = loop {
        if let QueryEvent::Rows(batch) = next(&mut events).await {
            break batch.rows.len();
        }
    };

    let result = app
        .apply_edits(
            session,
            statements(&[&format!("UPDATE {s}.t SET a = 5 WHERE id = 1 RETURNING a")]),
            TxMode::Auto,
        )
        .await
        .unwrap();

    assert_eq!(result.outcome, ApplyOutcome::Busy);
    assert_eq!(value(&format!("SELECT a::text FROM {s}.t")).await, "0");
    // 받다 만 결과는 그대로 이어 받는다.
    while received < 1200 {
        app.fetch_more(session, query).await.unwrap();
        match next(&mut events).await {
            QueryEvent::Rows(batch) => received += batch.rows.len(),
            other => panic!("{other:?}"),
        }
    }
    let finished = loop {
        if let QueryEvent::Finished { outcome, .. } = next(&mut events).await {
            break outcome;
        }
    };
    assert_eq!(finished, QueryOutcome::Completed { rows: 1200 });
}
