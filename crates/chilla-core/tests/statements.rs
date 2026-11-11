use std::time::{Duration, Instant};

use chilla_core::application::{SplitError, StatementSplitter};
use chilla_core::infrastructure::PgQuerySplitter;

fn spans(sql: &str) -> Vec<(usize, usize)> {
    PgQuerySplitter
        .split(sql)
        .unwrap()
        .into_iter()
        .map(|s| (s.start, s.end))
        .collect()
}

fn texts(sql: &str) -> Vec<&str> {
    PgQuerySplitter
        .split(sql)
        .unwrap()
        .into_iter()
        .map(|s| &sql[s.start..s.end])
        .collect()
}

/// M2 완료 기준: `$$` 블록, 문자열, 주석 안의 `;`를 경계로 보지 않는다.
#[test]
fn semicolons_inside_dollar_quotes_strings_and_comments_are_not_boundaries() {
    assert_eq!(
        texts("SELECT 1; DO $$ BEGIN PERFORM 1; END $$; SELECT ';'"),
        ["SELECT 1", "DO $$ BEGIN PERFORM 1; END $$", "SELECT ';'"]
    );
    assert_eq!(
        texts("SELECT $tag$ ; $tag$; SELECT E'it\\'s;'; SELECT \"a;b\" FROM t"),
        [
            "SELECT $tag$ ; $tag$",
            "SELECT E'it\\'s;'",
            "SELECT \"a;b\" FROM t"
        ]
    );
    assert_eq!(
        texts("SELECT 1 /* ; */ + 2; -- ;\nSELECT 3"),
        ["SELECT 1 /* ; */ + 2", "SELECT 3"]
    );
}

#[test]
fn spans_run_from_the_first_token_to_the_last() {
    assert_eq!(
        spans("  -- leading; comment\nSELECT 1;\n\n/* c; */ SELECT 2 -- trailing;\n; SELECT 3"),
        [(22, 30), (42, 50), (66, 74)]
    );
}

#[test]
fn offsets_are_bytes() {
    assert_eq!(
        spans("SELECT '한글;'; SELECT '😀' ; SELECT 2"),
        [(0, 16), (18, 31), (34, 42)]
    );
}

#[test]
fn empty_statements_are_skipped() {
    assert_eq!(texts("SELECT 1;;  ; SELECT 2;"), ["SELECT 1", "SELECT 2"]);
    for sql in ["", "  \n ", "-- only comment", "/* a */  ", " ; ; "] {
        assert!(spans(sql).is_empty(), "{sql:?}");
    }
}

/// Review Focus 4
#[test]
fn statements_with_syntax_errors_are_still_statements() {
    assert_eq!(
        texts("SELECT 1; SELEC 2; COMIT; SELECT :id::int"),
        ["SELECT 1", "SELEC 2", "COMIT", "SELECT :id::int"]
    );
    // 닫히지 않은 괄호는 뒤를 한 문장으로 묶는다.
    assert_eq!(texts("SELECT (1; SELECT 2"), ["SELECT (1; SELECT 2"]);
}

#[test]
fn parenthesized_and_atomic_bodies_stay_whole() {
    assert_eq!(
        texts(
            "CREATE RULE r AS ON INSERT TO t DO ALSO (INSERT INTO a VALUES (1); INSERT INTO b VALUES (2)); SELECT 1"
        )
        .len(),
        2
    );
    let atomic = texts(
        "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 END; SELECT 2; END; SELECT 3",
    );
    assert_eq!(
        atomic,
        [
            "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 END; SELECT 2; END",
            "SELECT 3"
        ]
    );
    // BEGIN과 ATOMIC 사이의 주석은 body를 닫지 않는다.
    assert_eq!(
        texts(
            "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN /* c */ ATOMIC SELECT 1; SELECT 2; END; SELECT 3"
        ),
        [
            "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN /* c */ ATOMIC SELECT 1; SELECT 2; END",
            "SELECT 3"
        ]
    );
    // 트랜잭션의 BEGIN은 atomic body를 열지 않는다.
    assert_eq!(
        texts("BEGIN; SELECT CASE WHEN true THEN 1 END; COMMIT; END"),
        ["BEGIN", "SELECT CASE WHEN true THEN 1 END", "COMMIT", "END"]
    );
}

/// Review Focus 4
#[test]
fn unterminated_text_cannot_be_split() {
    for sql in [
        "SELECT 'unterminated",
        "SELECT 1; DO $$ BEGIN",
        "SELECT 1 /* open",
    ] {
        let err: SplitError = PgQuerySplitter.split(sql).unwrap_err();
        assert!(err.message.starts_with("unterminated"), "{sql:?}: {err}");
    }
}

#[test]
fn ten_thousand_statements_split_within_100ms() {
    let sql: String = (0..10_000)
        .map(|i| format!("SELECT {i} FROM big_table WHERE id = {i};\n"))
        .collect();
    let started = Instant::now();
    let statements = PgQuerySplitter.split(&sql).unwrap();
    let elapsed = started.elapsed();
    assert_eq!(statements.len(), 10_000);
    assert!(elapsed < Duration::from_millis(100), "{elapsed:?}");
}
