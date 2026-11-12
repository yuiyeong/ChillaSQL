//! 접속 정보, 세션 같은 개념과 규칙. 다른 layer와 I/O crate에 의존하지 않는다.

mod connection;
mod password;
mod project;
mod query;
mod session;
mod sql_file;
mod statement;

pub use connection::{ConnectionProfile, ProfileError, SslMode};
pub use password::Password;
pub use project::Project;
pub use query::{
    Column, QueryEvent, QueryId, QueryLimits, QueryOutcome, Row, RowBatch, ServerError,
};
pub use session::{SessionId, SessionInfo, SessionState, TxStatus};
pub use sql_file::{FileStamp, SqlFile, SqlPath, SqlPathError, WriteMode, has_sql_extension};
pub use statement::StatementSpan;
