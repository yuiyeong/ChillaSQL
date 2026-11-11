use std::time::Duration;

/// 실행한 쿼리 하나.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct QueryId(pub u64);

/// 결과의 열 하나.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    pub name: String,
}

/// 값은 서버가 만든 text다. `None`은 NULL, `Some("")`은 빈 문자열이다.
pub type Row = Vec<Option<String>>;

/// 서버가 돌려준 오류.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerError {
    /// SQLSTATE.
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// 보낸 text에서의 위치. 1부터 세는 글자(char) 번호다.
    pub position: Option<u32>,
}

/// 화면에 보내는 행 묶음 하나.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowBatch {
    /// 결과에서 이 batch 첫 행의 번호(0부터).
    pub first_row: u64,
    pub rows: Vec<Row>,
    /// 화면이 보관할 첫 행 번호. 그 앞의 행은 버린다.
    pub retained_from: u64,
    /// 쿼리를 보낸 뒤 이 batch를 다 읽을 때까지 걸린 시간. `Paused`로 기다린 시간은 뺀다.
    pub elapsed: Duration,
}

/// 쿼리 하나가 화면에 알리는 것.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryEvent {
    Columns(Vec<Column>),
    Rows(RowBatch),
    /// 쿼리마다 정확히 한 번, 마지막에 온다.
    Finished {
        outcome: QueryOutcome,
        elapsed: Duration,
    },
}

/// 쿼리가 끝난 방식.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryOutcome {
    /// `rows`는 서버가 알려 준 행 수다. `Columns`가 왔으면 돌려준 행, 아니면 영향받은 행이다.
    Completed {
        rows: u64,
    },
    Failed(ServerError),
    /// 사용자가 취소했다.
    Cancelled,
    /// 다음 쿼리나 세션 닫기에 밀려 버려졌다.
    Discarded,
    ConnectionLost {
        message: String,
    },
    /// 서버의 오류가 아닌 오류로 끝났다(UTF-8이 아닌 값, 보낼 수 없는 text 등). 연결은 그대로다.
    ClientError {
        message: String,
    },
}

/// 결과를 나눠 보내는 크기와 화면이 보관할 행 수.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueryLimits {
    /// batch 하나의 최대 행 수.
    pub batch_rows: usize,
    /// batch의 cell byte 합이 이 값 이상이면 행 수가 덜 차도 보낸다.
    pub batch_bytes: usize,
    /// 화면이 보관하는 최대 행 수.
    pub retained_rows: u64,
}

impl Default for QueryLimits {
    fn default() -> Self {
        Self {
            batch_rows: 500,
            batch_bytes: 4 * 1024 * 1024,
            retained_rows: 100_000,
        }
    }
}

impl QueryLimits {
    /// `received`행을 받은 뒤 화면이 보관할 첫 행 번호.
    pub fn retained_from(&self, received: u64) -> u64 {
        received.saturating_sub(self.retained_rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_from_is_zero_until_the_cap_is_passed() {
        let limits = QueryLimits::default();
        assert_eq!(limits.batch_rows, 500);
        assert_eq!(limits.batch_bytes, 4 * 1024 * 1024);
        assert_eq!(limits.retained_rows, 100_000);
        assert_eq!(limits.retained_from(0), 0);
        assert_eq!(limits.retained_from(100_000), 0);
        assert_eq!(limits.retained_from(100_500), 500);
    }
}
