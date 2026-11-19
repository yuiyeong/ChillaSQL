//! use case와 port trait. `domain`만 의존한다.

mod app;
mod ports;
mod session_actor;
#[cfg(test)]
mod test_support;
// Task 5에서 App이 쓰기 전까지 test 밖에서는 쓰이지 않는다. Task 5에서 지운다.
#[cfg_attr(not(test), allow(dead_code))]
mod tunnels;

pub use app::{App, AppError};
pub use session_actor::QuerySink;
pub use tunnels::{TunnelError, TunnelSink};

pub use ports::{
    CancelError, ConnectError, Connector, DbConnection, FileError, PasswordKey, PasswordStore,
    PasswordStoreError, ProjectError, ProjectStore, QueryCancel, QueryError, RowItem, RowSource,
    SpawnError, SplitError, SqlFileStore, StatementSplitter, TunnelProcess, TunnelRunner,
};
