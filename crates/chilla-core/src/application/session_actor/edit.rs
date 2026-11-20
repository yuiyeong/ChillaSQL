//! 셀 편집의 UPDATE를 한 단위로 보낸다.
//!
//! 문장마다 바뀐 행이 정확히 하나여야 하고, 아니면 모두 되돌린다. 되돌리는 방법은 트랜잭션 상태에
//! 따른다: 트랜잭션 밖의 Auto는 `BEGIN` … `COMMIT`/`ROLLBACK`, 그 밖에는 `chilla_edit` savepoint를
//! 두고 풀거나 그 앞으로 되돌려 트랜잭션을 열린 채로 둔다. 세션의 `chilla_statement` savepoint 위에
//! 두고 같은 Apply 안에서 풀므로 [`super::savepoint`]는 건드리지 않는다.

use super::Actor;
use crate::application::{DbConnection, QueryError, RowItem, RowSource};
use crate::domain::{ApplyOutcome, ApplyResult, Row, TxMode, TxStatus};

/// 트랜잭션 밖의 Auto가 여는 문장과 끝내는 문장.
const BEGIN: &str = "BEGIN";
const COMMIT: &str = "COMMIT";
const ROLLBACK: &str = "ROLLBACK";
/// Manual이고 트랜잭션 밖이면 트랜잭션을 열며 둔다. 한 번의 simple query다.
const BEGIN_AND_SET: &str = "BEGIN; SAVEPOINT chilla_edit";
/// 트랜잭션 안이면 둔다.
const SET: &str = "SAVEPOINT chilla_edit";
const RELEASE: &str = "RELEASE SAVEPOINT chilla_edit";
/// 실패하면 savepoint 앞으로 되돌리고 푼다. 한 번의 simple query다.
const UNDO: &str = "ROLLBACK TO SAVEPOINT chilla_edit; RELEASE SAVEPOINT chilla_edit";

/// 앞뒤 문장. 트랜잭션 상태와 모드로 정한다.
struct Frame {
    open: &'static str,
    close: &'static str,
    undo: &'static str,
    /// 트랜잭션을 우리가 열고 닫는다(Auto, 트랜잭션 밖). 닫는 `COMMIT`이 실패하면 서버가 이미
    /// 되돌렸으므로 `undo`를 보내지 않는다.
    owns_transaction: bool,
}

impl Frame {
    fn new(tx: TxStatus, mode: TxMode) -> Self {
        match (tx, mode) {
            (TxStatus::Idle, TxMode::Auto) => Self {
                open: BEGIN,
                close: COMMIT,
                undo: ROLLBACK,
                owns_transaction: true,
            },
            (TxStatus::Idle, TxMode::Manual) => Self {
                open: BEGIN_AND_SET,
                close: RELEASE,
                undo: UNDO,
                owns_transaction: false,
            },
            _ => Self {
                open: SET,
                close: RELEASE,
                undo: UNDO,
                owns_transaction: false,
            },
        }
    }
}

/// 문장 하나가 실패한 방식.
enum Step {
    Wrong { rows: u64 },
    Error(QueryError),
}

impl<D: DbConnection> Actor<D> {
    /// 쿼리가 없을 때 `statements`를 한 단위로 보낸다. 열린 쿼리가 있거나 실패한 트랜잭션이면
    /// 보내지 않는다.
    pub(super) async fn apply(&mut self, statements: &[String], mode: TxMode) -> ApplyResult {
        if self.query.is_some() {
            return ApplyResult {
                outcome: ApplyOutcome::Busy,
                tx: None,
            };
        }
        if self.tx == TxStatus::Failed && !self.connection.is_closed() {
            return ApplyResult {
                outcome: ApplyOutcome::TransactionFailed,
                tx: Some(self.tx),
            };
        }
        let frame = Frame::new(self.tx, mode);
        // 세션이 둔 `chilla_statement`는 이 Apply가 지나도 맨 위에 남는다. 트랜잭션을 우리가 열었으면
        // 없다.
        let kept = self.savepoint_on_top && self.tx == TxStatus::InTransaction;
        self.savepoint_on_top = false;

        let outcome = self.send(statements, &frame).await;
        let lost = matches!(outcome, ApplyOutcome::ConnectionLost { .. });
        // 실패해서 savepoint를 풀지 못했거나 트랜잭션을 우리가 열었으면 맨 위를 모른다.
        self.savepoint_on_top = kept && matches!(outcome, ApplyOutcome::Applied { .. });
        ApplyResult {
            outcome,
            tx: self.read_tx(lost).await,
        }
    }

    /// 앞 문장, 문장들, 뒤 문장을 보낸다. 실패하면 되돌린다.
    async fn send(&mut self, statements: &[String], frame: &Frame) -> ApplyOutcome {
        if let Err(error) = self.connection.simple_execute(frame.open).await {
            return outcome_of(None, error);
        }
        let failure = match self.update_all(statements).await {
            Ok(rows) => match self.connection.simple_execute(frame.close).await {
                Ok(()) => return ApplyOutcome::Applied { rows },
                Err(error) => outcome_of(None, error),
            },
            Err(failure) => failure,
        };
        // 실패한 `COMMIT`은 서버가 이미 되돌렸고, 끊긴 연결에는 보낼 수 없다.
        let committing =
            frame.owns_transaction && matches!(failure, ApplyOutcome::Failed { index: None, .. });
        if committing || matches!(failure, ApplyOutcome::ConnectionLost { .. }) {
            return failure;
        }
        match self.connection.simple_execute(frame.undo).await {
            Err(QueryError::ConnectionLost { message }) => ApplyOutcome::ConnectionLost { message },
            _ => failure,
        }
    }

    /// 문장마다 바뀐 행이 하나여야 한다. 처음 어긋난 문장에서 멈춘다.
    async fn update_all(&mut self, statements: &[String]) -> Result<Vec<Row>, ApplyOutcome> {
        let mut rows = Vec::with_capacity(statements.len());
        for (index, sql) in statements.iter().enumerate() {
            match self.update(sql).await {
                Ok(row) => rows.push(row),
                Err(Step::Wrong { rows }) => {
                    return Err(ApplyOutcome::WrongRowCount { index, rows });
                }
                Err(Step::Error(error)) => return Err(outcome_of(Some(index), error)),
            }
        }
        Ok(rows)
    }

    /// UPDATE 하나를 보내 끝까지 읽는다. 바뀐 행이 하나가 아니면 `Wrong`이다.
    async fn update(&mut self, sql: &str) -> Result<Row, Step> {
        let mut source = self
            .connection
            .start_query(sql)
            .await
            .map_err(Step::Error)?;
        let mut returned = Vec::new();
        let mut complete = None;
        let mut error = None;
        // 오류 뒤에도 `None`까지 읽어야 연결이 다음 문장을 받는다.
        while let Some(item) = source.next().await {
            match item {
                Ok(RowItem::Row(row)) => returned.push(row),
                Ok(RowItem::Complete { rows }) => complete = Some(rows),
                Ok(RowItem::Columns(_)) => {}
                Err(failed) => {
                    error.get_or_insert(failed);
                }
            }
        }
        if let Some(error) = error {
            return Err(Step::Error(error));
        }
        let count = complete.unwrap_or(returned.len() as u64);
        match (count, returned.pop()) {
            (1, Some(row)) if returned.is_empty() => Ok(row),
            _ => Err(Step::Wrong { rows: count }),
        }
    }
}

fn outcome_of(index: Option<usize>, error: QueryError) -> ApplyOutcome {
    match error {
        QueryError::Server(error) => ApplyOutcome::Failed { index, error },
        QueryError::ConnectionLost { message } => ApplyOutcome::ConnectionLost { message },
        QueryError::Client { message } => ApplyOutcome::Client { message },
    }
}
