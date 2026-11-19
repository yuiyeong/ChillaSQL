//! 트랜잭션 안의 문장 하나만 되돌릴 수 있게 그 앞에 두는 savepoint.
//!
//! 세션은 트랜잭션 안의 문장마다 `chilla_statement`를 둔다. 버리거나 취소한 문장은 cancel한 뒤
//! `ROLLBACK TO`로 되돌려 트랜잭션을 열린 채로 둔다. 앞 문장의 savepoint는 풀고 새로 둬서
//! subtransaction이 쌓이지 않게 한다.

/// 앞 문장의 savepoint가 없을 때(트랜잭션의 첫 문장 등) 둔다.
pub(super) const SET: &str = "SAVEPOINT chilla_statement";
/// 앞 문장의 savepoint를 풀고 새로 둔다. 한 번의 simple query다.
pub(super) const RENEW: &str = "RELEASE SAVEPOINT chilla_statement; SAVEPOINT chilla_statement";
/// Manual에서 트랜잭션을 열며 둔다. 한 번의 simple query다.
pub(super) const BEGIN_AND_SET: &str = "BEGIN; SAVEPOINT chilla_statement";
/// 버린 문장을 되돌린다. savepoint는 남는다.
pub(super) const UNDO: &str = "ROLLBACK TO SAVEPOINT chilla_statement";

/// savepoint 없이 보내야 하는 문장인지 첫 keyword로 본다. 세션은 문장 하나만 받으므로 첫 keyword가
/// 문장의 종류다.
///
/// 트랜잭션과 savepoint를 다루는 문장(`SAVEPOINT`, `RELEASE`, `ROLLBACK [TO]`, `COMMIT AND CHAIN` 등)은
/// 세션의 savepoint를 풀거나 그 위에 사용자의 savepoint를 둘 수 있다. 그 뒤에 세션이 savepoint를
/// 풀거나 되돌리면 사용자의 savepoint까지 사라지거나, 풀 savepoint가 없어 트랜잭션이 failed가 된다.
/// 트랜잭션의 성질을 정하는 `SET`(`SET [LOCAL | SESSION] TRANSACTION`, `transaction_isolation`,
/// `transaction_deferrable`, `transaction_read_only`)은 subtransaction 안에서 실패한다.
/// `transaction_read_only`는 read only 트랜잭션을 read write로 바꿀 때만 실패한다.
pub(super) fn runs_without_savepoint(sql: &str) -> bool {
    let is = |word: &str, keyword: &str| word.eq_ignore_ascii_case(keyword);
    let (first, rest) = word(skip_ignored(sql));
    let (second, rest) = word(skip_ignored(rest));
    if CONTROL.iter().any(|keyword| is(first, keyword)) {
        return true;
    }
    if is(first, "PREPARE") {
        return is(second, "TRANSACTION");
    }
    if !is(first, "SET") {
        return false;
    }
    let name = if is(second, "LOCAL") || is(second, "SESSION") {
        word(skip_ignored(rest)).0
    } else {
        second
    };
    TRANSACTION_SETTINGS.iter().any(|keyword| is(name, keyword))
}

/// 트랜잭션과 savepoint를 다루는 문장의 첫 keyword.
const CONTROL: [&str; 8] = [
    "BEGIN",
    "START",
    "COMMIT",
    "END",
    "ROLLBACK",
    "ABORT",
    "SAVEPOINT",
    "RELEASE",
];

/// `SET [LOCAL | SESSION]` 뒤에 오면 트랜잭션의 성질을 정하는 이름.
const TRANSACTION_SETTINGS: [&str; 4] = [
    "TRANSACTION",
    "transaction_isolation",
    "transaction_deferrable",
    "transaction_read_only",
];

/// 앞의 공백, `;`, 주석(`--`, 중첩된 `/* */`)을 건너뛴다.
fn skip_ignored(mut sql: &str) -> &str {
    loop {
        sql = sql.trim_start_matches(|c: char| c.is_whitespace() || c == ';');
        if let Some(rest) = sql.strip_prefix("--") {
            sql = rest.split_once('\n').map_or("", |(_, after)| after);
        } else if sql.starts_with("/*") {
            sql = after_block_comment(sql);
        } else {
            return sql;
        }
    }
}

/// `/*`로 시작하는 block comment의 뒤. 닫히지 않았으면 빈 text다.
fn after_block_comment(sql: &str) -> &str {
    let mut depth = 0usize;
    let mut rest = sql;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("/*") {
            depth += 1;
            rest = after;
        } else if let Some(after) = rest.strip_prefix("*/") {
            depth -= 1;
            rest = after;
            if depth == 0 {
                return rest;
            }
        } else {
            let next = rest.chars().next().map_or(0, char::len_utf8);
            rest = &rest[next..];
        }
    }
    rest
}

/// 앞에서부터 keyword 하나와 그 뒤.
fn word(sql: &str) -> (&str, &str) {
    let end = sql
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(sql.len());
    sql.split_at(end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transaction_control_and_set_transaction_run_without_a_savepoint() {
        for sql in [
            "BEGIN",
            "start transaction",
            "COMMIT AND CHAIN",
            "end",
            "ROLLBACK TO SAVEPOINT a",
            "abort",
            "SAVEPOINT a",
            "RELEASE a",
            "PREPARE TRANSACTION 'x'",
            "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
            "  ;\n-- c\n/* a /* nested */ b */ Set\tTransaction read only",
            "SET LOCAL TRANSACTION ISOLATION LEVEL SERIALIZABLE",
            "set session transaction read write",
            "SET transaction_isolation = 'serializable'",
            "SET LOCAL transaction_isolation TO serializable",
            "set session TRANSACTION_DEFERRABLE = on",
            "SET transaction_deferrable TO off",
            "SET transaction_read_only = off",
            "SET LOCAL transaction_read_only = on",
        ] {
            assert!(runs_without_savepoint(sql), "{sql}");
        }
    }

    #[test]
    fn other_statements_run_with_a_savepoint() {
        for sql in [
            "SELECT 'COMMIT'",
            "SET search_path = a",
            "SET LOCAL search_path = a",
            "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE",
            "SET SESSION AUTHORIZATION DEFAULT",
            "SET default_transaction_isolation = 'serializable'",
            "SET transaction_isolation_x = 1",
            "SET LOCAL",
            "SET",
            "SETTINGS",
            "savepoints",
            "PREPARE p AS SELECT 1",
            "-- COMMIT\nSELECT 1",
            "/* COMMIT */ SELECT 1",
            "/* unclosed COMMIT",
            "",
            "한글 COMMIT",
        ] {
            assert!(!runs_without_savepoint(sql), "{sql}");
        }
    }
}
