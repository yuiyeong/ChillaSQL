//! `PgConnection`의 결과 stream과 cancel. test DB는 `scripts/test-db.sh up`으로 띄운다.

mod support;

use std::time::{Duration, Instant};

use chilla_core::application::{
    Connector, DbConnection, QueryCancel, QueryError, RowItem, RowSource,
};
use chilla_core::domain::{Column, ServerError, SslMode, TxStatus};
use chilla_core::infrastructure::{PgConnection, PgConnector};
use support::{
    admin, collect, connect, eventually, password, terminate_backend, tls_admin, tls_profile,
};

type Item = Result<RowItem, QueryError>;

async fn run(conn: &PgConnection, sql: &str) -> Vec<Item> {
    let mut rows = conn.start_query(sql).await.unwrap();
    collect(&mut rows).await
}

fn columns(names: &[&str]) -> Item {
    Ok(RowItem::Columns(
        names
            .iter()
            .map(|name| Column {
                name: name.to_string(),
            })
            .collect(),
    ))
}

fn row(cells: &[Option<&str>]) -> Item {
    Ok(RowItem::Row(
        cells.iter().map(|cell| cell.map(str::to_owned)).collect(),
    ))
}

fn complete(rows: u64) -> Item {
    Ok(RowItem::Complete { rows })
}

fn server_error(item: &Item) -> Option<&ServerError> {
    match item {
        Err(QueryError::Server(e)) => Some(e),
        _ => None,
    }
}

fn has_server_error(items: &[Item], code: &str) -> bool {
    items
        .iter()
        .any(|item| server_error(item).is_some_and(|e| e.code == code))
}

fn select_42() -> Vec<Item> {
    vec![columns(&["?column?"]), row(&[Some("42")]), complete(1)]
}

/// 서버는 쿼리를 읽기 전에 닿은 cancel을 무시한다. cancel이 반드시 닿아야 하는 test는
/// 실행이 시작될 때까지 기다린다.
async fn wait_until_running(admin: &tokio_postgres::Client, pid: i32) {
    let running = eventually(async || {
        let state = admin
            .query_one("SELECT state FROM pg_stat_activity WHERE pid = $1", &[&pid])
            .await
            .unwrap();
        state.get::<_, Option<String>>(0).as_deref() == Some("active")
    })
    .await;
    assert!(running, "쿼리가 실행되지 않는다");
}

/// `Row`를 `count`개 읽는다. 다른 항목은 건너뛴다.
async fn read_rows<R: RowSource>(rows: &mut R, count: usize) {
    let mut read = 0;
    while read < count {
        match rows.next().await {
            Some(Ok(RowItem::Row(_))) => read += 1,
            Some(Ok(_)) => {}
            other => panic!("행을 {read}개 읽은 뒤 {other:?}"),
        }
    }
}

#[tokio::test]
async fn select_yields_columns_rows_and_the_count() {
    let conn = connect().await;

    let items = run(&conn, "SELECT 1 AS a, NULL AS b, '' AS c, ARRAY[1,2] AS d").await;

    assert_eq!(
        items,
        vec![
            columns(&["a", "b", "c", "d"]),
            row(&[Some("1"), None, Some(""), Some("{1,2}")]),
            complete(1),
        ]
    );
    conn.close().await;
}

#[tokio::test]
async fn statements_without_rows_yield_only_the_count() {
    let conn = connect().await;

    assert_eq!(
        run(&conn, "CREATE TEMP TABLE t (id int)").await,
        vec![complete(0)]
    );
    assert_eq!(
        run(&conn, "INSERT INTO t VALUES (1),(2),(3)").await,
        vec![complete(3)]
    );
    assert_eq!(
        run(&conn, "UPDATE t SET id = id + 1 WHERE id > 1 RETURNING id").await,
        vec![
            columns(&["id"]),
            row(&[Some("3")]),
            row(&[Some("4")]),
            complete(2),
        ]
    );
    assert_eq!(run(&conn, "").await, vec![complete(0)]);
    conn.close().await;
}

#[tokio::test]
async fn server_error_carries_the_position_and_the_connection_goes_on() {
    let conn = connect().await;

    let items = run(&conn, "SELECT *\nFROM nope").await;
    assert_eq!(items.len(), 1, "{items:?}");
    let e = server_error(&items[0]).expect("서버 오류");
    assert_eq!(e.code, "42P01");
    assert_eq!(e.position, Some(15));

    let items = run(&conn, "SELECT 1/0").await;
    assert_eq!(items.len(), 1, "{items:?}");
    let e = server_error(&items[0]).expect("서버 오류");
    assert_eq!(e.code, "22012");
    assert_eq!(e.position, None);

    assert!(run(&conn, "SELECT 42").await.contains(&row(&[Some("42")])));
    assert_eq!(conn.tx_status().await, TxStatus::Idle);
    conn.close().await;
}

#[tokio::test]
async fn unread_rows_make_the_server_wait() {
    let admin = admin().await;
    let conn = connect().await;
    let mut rows = conn.start_query("SELECT * FROM big_table").await.unwrap();

    read_rows(&mut rows, 500).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let activity = admin
        .query_one(
            "SELECT state, wait_event FROM pg_stat_activity WHERE pid = $1",
            &[&conn.backend_pid()],
        )
        .await
        .unwrap();
    assert_eq!(
        activity.get::<_, Option<String>>(0).as_deref(),
        Some("active")
    );
    assert_eq!(
        activity.get::<_, Option<String>>(1).as_deref(),
        Some("ClientWrite")
    );

    conn.cancel_handle().cancel().await.unwrap();
    collect(&mut rows).await;
    conn.close().await;
}

#[tokio::test]
async fn cancel_discards_a_half_read_result() {
    let conn = connect().await;
    let mut rows = conn.start_query("SELECT * FROM big_table").await.unwrap();
    read_rows(&mut rows, 500).await;

    let started = Instant::now();
    assert_eq!(conn.cancel_handle().cancel().await, Ok(()));
    let items = collect(&mut rows).await;
    let elapsed = started.elapsed();

    let last = items.last().expect("항목이 있다");
    assert_eq!(server_error(last).map(|e| e.code.as_str()), Some("57014"));
    assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
    assert_eq!(run(&conn, "SELECT 42").await, select_42());
    conn.close().await;
}

/// M2 완료 기준의 port 수준 확인.
#[tokio::test]
async fn cancel_ends_a_sleeping_query() {
    let conn = connect().await;
    let mut rows = conn.start_query("SELECT pg_sleep(10)").await.unwrap();

    let waited = tokio::time::timeout(Duration::from_millis(200), rows.next()).await;
    assert!(waited.is_err(), "{waited:?}");

    let started = Instant::now();
    assert_eq!(conn.cancel_handle().cancel().await, Ok(()));
    let items = collect(&mut rows).await;
    let elapsed = started.elapsed();

    assert!(has_server_error(&items, "57014"), "{items:?}");
    assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
    conn.close().await;
}

/// Review Focus 2
#[tokio::test]
async fn cancel_waits_until_the_server_has_handled_it() {
    let conn = connect().await;

    for i in 0..50 {
        let mut rows = conn.start_query("SELECT pg_sleep(10)").await.unwrap();
        conn.cancel_handle().cancel().await.unwrap();
        collect(&mut rows).await;
        assert_eq!(run(&conn, "SELECT 42").await, select_42(), "{i}번째");
    }
    conn.close().await;
}

#[tokio::test]
async fn cancel_with_nothing_running_is_harmless() {
    let conn = connect().await;

    assert_eq!(conn.cancel_handle().cancel().await, Ok(()));
    tokio::time::sleep(Duration::from_millis(100)).await;

    assert_eq!(run(&conn, "SELECT 42").await, select_42());
    conn.close().await;
}

#[tokio::test]
async fn cancel_works_over_tls() {
    let admin = tls_admin().await;
    let profile = tls_profile("localhost", SslMode::VerifyFull, Some("ca.crt"));
    let conn = PgConnector::new()
        .connect(&profile, Some(&password()))
        .await
        .unwrap();
    let mut rows = conn.start_query("SELECT pg_sleep(10)").await.unwrap();
    wait_until_running(&admin, conn.backend_pid()).await;

    assert_eq!(conn.cancel_handle().cancel().await, Ok(()));
    let items = collect(&mut rows).await;

    assert!(has_server_error(&items, "57014"), "{items:?}");
    conn.close().await;
}

/// Review Focus 3
#[tokio::test]
async fn terminated_connection_ends_the_rows() {
    let admin = admin().await;
    let conn = connect().await;
    let mut rows = conn.start_query("SELECT pg_sleep(10)").await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;

    terminate_backend(&admin, conn.backend_pid()).await;
    let items = tokio::time::timeout(Duration::from_secs(2), collect(&mut rows))
        .await
        .expect("2초 안에 끝난다");

    let [.., terminated, lost] = items.as_slice() else {
        panic!("{items:?}");
    };
    assert_eq!(
        server_error(terminated).map(|e| e.code.as_str()),
        Some("57P01")
    );
    assert!(
        matches!(lost, Err(QueryError::ConnectionLost { .. })),
        "{lost:?}"
    );
    assert!(conn.is_closed());
    assert!(matches!(
        conn.start_query("SELECT 1").await,
        Err(QueryError::ConnectionLost { .. })
    ));
    conn.close().await;
}

#[tokio::test]
async fn close_does_not_wait_for_a_running_query() {
    let admin = admin().await;
    let conn = connect().await;
    let pid = conn.backend_pid();
    let rows = conn.start_query("SELECT pg_sleep(10)").await.unwrap();

    drop(rows);
    let closed = tokio::time::timeout(Duration::from_secs(2), conn.close()).await;

    assert!(closed.is_ok(), "close가 2초 안에 돌아온다");
    // 서버에서는 아직 pg_sleep이 돈다. 다음 test에 남기지 않는다.
    terminate_backend(&admin, pid).await;
}
