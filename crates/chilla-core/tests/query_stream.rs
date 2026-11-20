//! `PgConnection`의 결과 stream과 cancel. test DB는 `scripts/test-db.sh up`으로 띄운다.

mod support;

use std::time::{Duration, Instant};

use chilla_core::application::{
    Connector, DbConnection, QueryCancel, QueryError, RowItem, RowSource,
};
use chilla_core::domain::{Column, ServerError, SslMode, TxStatus};
use chilla_core::infrastructure::{PgConnection, PgConnector};
use support::{
    activity, admin, backend_exists, collect, connect, eventually, password, terminate_backend,
    tls_admin, tls_profile, wait_until_running,
};

type Item = Result<RowItem, QueryError>;

async fn run(conn: &PgConnection, sql: &str) -> Vec<Item> {
    let mut rows = conn.start_query(sql).await.unwrap();
    collect(&mut rows).await
}

const INT4: u32 = 23;
const TEXT: u32 = 25;

/// `(이름, type OID)`. typmod는 없다(-1).
fn columns(columns: &[(&str, u32)]) -> Item {
    Ok(RowItem::Columns(
        columns
            .iter()
            .map(|&(name, type_oid)| Column {
                name: name.to_string(),
                type_oid,
                type_modifier: -1,
                table_oid: 0,
                column_number: 0,
            })
            .collect(),
    ))
}

/// 테이블 컬럼을 돌려주는 쿼리의 OID는 test마다 달라지므로, 비교하기 전에 0으로 맞춘다.
fn without_table(items: Vec<Item>) -> Vec<Item> {
    items
        .into_iter()
        .map(|item| match item {
            Ok(RowItem::Columns(columns)) => Ok(RowItem::Columns(
                columns
                    .into_iter()
                    .map(|column| Column {
                        table_oid: 0,
                        column_number: 0,
                        ..column
                    })
                    .collect(),
            )),
            other => other,
        })
        .collect()
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
    vec![
        columns(&[("?column?", INT4)]),
        row(&[Some("42")]),
        complete(1),
    ]
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
            columns(&[("a", INT4), ("b", TEXT), ("c", TEXT), ("d", 1007)]),
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
        without_table(run(&conn, "UPDATE t SET id = id + 1 WHERE id > 1 RETURNING id").await),
        vec![
            columns(&[("id", INT4)]),
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

/// SQL_ASCII DB나 client_encoding을 바꾼 세션에서는 UTF-8이 아닌 값이 온다. 그 행만 오류이고
/// 결과와 연결은 이어진다.
#[tokio::test]
async fn non_utf8_cell_is_a_client_error_and_the_rows_go_on() {
    let conn = connect().await;
    run(&conn, "SET client_encoding = 'LATIN1'").await;

    // 보내는 text도 LATIN1로 읽히므로 값은 chr로 만든다. 서버는 é를 0xE9 한 byte로 보낸다.
    let items = run(&conn, "VALUES ('x', chr(233)), ('y', 'z')").await;

    assert_eq!(
        items,
        vec![
            columns(&[("column1", TEXT), ("column2", TEXT)]),
            Err(QueryError::Client {
                message: "The result contains a value that is not UTF-8. Check client_encoding"
                    .into()
            }),
            row(&[Some("y"), Some("z")]),
            complete(2),
        ]
    );
    run(&conn, "SET client_encoding = 'UTF8'").await;
    assert_eq!(run(&conn, "SELECT 42").await, select_42());
    conn.close().await;
}

/// 보내지 못한 text는 연결을 잃은 것이 아니다.
#[tokio::test]
async fn text_with_nul_is_a_client_error_and_the_connection_goes_on() {
    let conn = connect().await;

    let started = conn.start_query("SELECT 1\0").await;

    assert!(
        matches!(started, Err(QueryError::Client { .. })),
        "{:?}",
        started.err()
    );
    assert!(!conn.is_closed());
    assert_eq!(run(&conn, "SELECT 42").await, select_42());
    conn.close().await;
}

#[tokio::test]
async fn unread_rows_make_the_server_wait() {
    let admin = admin().await;
    let conn = connect().await;
    let mut rows = conn.start_query("SELECT * FROM big_table").await.unwrap();

    read_rows(&mut rows, 500).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let (state, wait_event) = activity(&admin, conn.backend_pid()).await;
    assert_eq!(state.as_deref(), Some("active"));
    assert_eq!(wait_event.as_deref(), Some("ClientWrite"));

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
    let admin = admin().await;
    let conn = connect().await;
    let mut rows = conn.start_query("SELECT pg_sleep(10)").await.unwrap();

    let waited = tokio::time::timeout(Duration::from_millis(200), rows.next()).await;
    assert!(waited.is_err(), "{waited:?}");
    // 서버는 실행을 시작하기 전에 닿은 cancel을 무시한다.
    wait_until_running(&admin, conn.backend_pid()).await;

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
    let admin = admin().await;
    let conn = connect().await;

    for i in 0..50 {
        let mut rows = conn.start_query("SELECT pg_sleep(10)").await.unwrap();
        wait_until_running(&admin, conn.backend_pid()).await;
        conn.cancel_handle().cancel().await.unwrap();
        let items = collect(&mut rows).await;
        assert!(has_server_error(&items, "57014"), "{i}번째: {items:?}");
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

/// COPY … FROM STDIN은 지원하지 않는다. 서버가 COPY 상태로 남아 다음 쿼리를 받지 못하므로
/// 결과가 멈추지 않고 연결이 정말로 끊긴다.
#[tokio::test]
async fn copy_from_stdin_loses_the_connection_instead_of_hanging() {
    let admin = admin().await;
    let conn = connect().await;
    let pid = conn.backend_pid();
    run(&conn, "CREATE TEMP TABLE c (id int)").await;
    let mut rows = conn.start_query("COPY c FROM STDIN").await.unwrap();

    let items = tokio::time::timeout(Duration::from_secs(2), collect(&mut rows))
        .await
        .expect("2초 안에 끝난다");

    assert!(
        matches!(items.last(), Some(Err(QueryError::ConnectionLost { .. }))),
        "{items:?}"
    );
    assert!(eventually(async || conn.is_closed()).await);
    assert!(eventually(async || !backend_exists(&admin, pid).await).await);
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

fn column_types(items: &[Item]) -> Vec<(String, u32, i32)> {
    items
        .iter()
        .find_map(|item| match item {
            Ok(RowItem::Columns(columns)) => Some(
                columns
                    .iter()
                    .map(|c| (c.name.clone(), c.type_oid, c.type_modifier))
                    .collect(),
            ),
            _ => None,
        })
        .expect("Columns 항목")
}

#[tokio::test]
async fn columns_carry_type_oid_and_modifier() {
    let conn = connect().await;

    let items = run(
        &conn,
        "SELECT 1::int4 AS a, 'x'::varchar(10) AS b, NULL::numeric(10,2) AS c",
    )
    .await;

    assert_eq!(
        column_types(&items),
        vec![
            ("a".to_string(), 23, -1),
            ("b".to_string(), 1043, 14),
            ("c".to_string(), 1700, 655366),
        ]
    );
    conn.close().await;
}

#[tokio::test]
async fn types_follow_each_query() {
    let conn = connect().await;

    let first = run(&conn, "SELECT 1::int4 AS a").await;
    let second = run(&conn, "SELECT 'x'::text AS t, true AS f").await;
    let third = run(&conn, "SELECT 1::int8 AS n").await;

    assert_eq!(column_types(&first), vec![("a".to_string(), 23, -1)]);
    assert_eq!(
        column_types(&second),
        vec![("t".to_string(), 25, -1), ("f".to_string(), 16, -1)]
    );
    assert_eq!(column_types(&third), vec![("n".to_string(), 20, -1)]);
    conn.close().await;
}

#[tokio::test]
async fn columns_carry_table_and_number() {
    let conn = connect().await;
    let admin = admin().await;
    let table_oid: u32 = admin
        .query_one("SELECT 'big_table'::regclass::oid", &[])
        .await
        .unwrap()
        .get(0);
    let attnum = |name: &'static str| {
        let admin = &admin;
        async move {
            admin
                .query_one(
                    "SELECT attnum FROM pg_attribute \
                     WHERE attrelid = 'big_table'::regclass AND attname = $1",
                    &[&name],
                )
                .await
                .unwrap()
                .get::<_, i16>(0)
        }
    };
    let note_number = attnum("note").await;

    let items = run(&conn, "SELECT id, note, id + 1 FROM big_table LIMIT 1").await;

    let found: Vec<(u32, i16)> = items
        .iter()
        .find_map(|item| match item {
            Ok(RowItem::Columns(columns)) => Some(
                columns
                    .iter()
                    .map(|c| (c.table_oid, c.column_number))
                    .collect(),
            ),
            _ => None,
        })
        .expect("Columns 항목");
    assert_eq!(
        found,
        vec![(table_oid, 1), (table_oid, note_number), (0, 0)]
    );
    conn.close().await;
}
