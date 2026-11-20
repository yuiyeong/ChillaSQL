//! 접속 정보, 세션 같은 개념과 규칙. 다른 layer와 I/O crate에 의존하지 않는다.

mod catalog;
mod connection;
mod danger;
mod password;
mod project;
mod query;
mod session;
mod sql_file;
mod statement;
mod tunnel;

pub use catalog::{
    Catalog, CatalogColumn, ConstraintInfo, ConstraintKind, FunctionName, IndexInfo, Relation,
    RelationKind, TableDetails, TypeInfo,
};
pub use connection::{ConnectionColor, ConnectionProfile, ProfileError, SslMode};
pub use danger::Danger;
pub use password::Password;
pub use project::Project;
pub use query::{
    Column, QueryEvent, QueryId, QueryLimits, QueryOutcome, Row, RowBatch, ServerError,
};
pub use session::{
    EndOutcome, EndResult, SessionId, SessionInfo, SessionState, TxEnd, TxMode, TxStatus,
};
pub use sql_file::{FileStamp, SqlFile, SqlPath, SqlPathError, WriteMode};
pub use statement::StatementSpan;
pub use tunnel::{
    DEFAULT_TUNNEL_TIMEOUT, MAX_TUNNEL_TIMEOUT_SECS, TunnelEvent, TunnelFailure, TunnelState,
    TunnelTarget,
};
