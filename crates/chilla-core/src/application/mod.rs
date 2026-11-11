//! use case와 port trait. `domain`만 의존한다.

mod app;
mod ports;
mod session_actor;
#[cfg(test)]
mod test_support;

pub use app::{App, AppError};

pub use ports::{
    ConnectError, Connector, DbConnection, PasswordKey, PasswordStore, PasswordStoreError,
    ProjectError, ProjectStore,
};
