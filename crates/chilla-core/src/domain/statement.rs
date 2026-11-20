/// 문장 하나의 위치. byte offset이고 `end`는 포함하지 않는다. 문장을 끝내는 `;`는 들어가지 않는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatementSpan {
    pub start: usize,
    pub end: usize,
}

/// `:name` 하나. byte offset이고 `start`는 `:`, `end`는 이름 끝(포함하지 않음)이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParameterSpan {
    pub name: String,
    pub start: usize,
    pub end: usize,
}
