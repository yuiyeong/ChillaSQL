//! use case와 port trait. `domain`만 의존한다.

mod app;
mod ports;
mod session_actor;
#[cfg(test)]
mod test_support;
mod tunnels;

pub use app::{App, AppError, ServerInfo};
pub use session_actor::QuerySink;
pub use tunnels::{TunnelError, TunnelSink};

pub use ports::{
    AppStore, CancelError, ConnectError, Connector, DbConnection, FileError, HistoryEntry,
    NewHistoryEntry, PasswordKey, PasswordStore, PasswordStoreError, ProjectError, ProjectStore,
    QueryCancel, QueryError, RecentProject, RowItem, RowSource, SpawnError, SplitError,
    SqlFileStore, StatementInspector, StatementSplitter, StoreError, TunnelProcess, TunnelRunner,
};
