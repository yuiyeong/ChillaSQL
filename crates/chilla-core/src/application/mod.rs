//! use case와 port trait. `domain`만 의존한다.

mod app;
mod ports;
mod session_actor;
#[cfg(test)]
mod test_support;

pub use app::{App, AppError};
pub use session_actor::QuerySink;

pub use ports::{
    CancelError, ConnectError, Connector, DbConnection, FileError, PasswordKey, PasswordStore,
    PasswordStoreError, ProjectError, ProjectStore, QueryCancel, QueryError, RowItem, RowSource,
    SpawnError, SplitError, SqlFileStore, StatementSplitter, TunnelProcess, TunnelRunner,
};
