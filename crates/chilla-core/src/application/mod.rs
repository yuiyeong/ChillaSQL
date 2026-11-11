//! use case와 port trait. `domain`만 의존한다.

mod ports;

pub use ports::{PasswordKey, PasswordStore, PasswordStoreError, ProjectError, ProjectStore};
