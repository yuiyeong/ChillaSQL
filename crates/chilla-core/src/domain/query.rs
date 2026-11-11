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
