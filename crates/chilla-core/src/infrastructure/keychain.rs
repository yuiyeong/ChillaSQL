use std::sync::Arc;

use apple_native_keyring_store::keychain::Store;
use keyring_core::api::CredentialStoreApi;
use keyring_core::{Entry, Error};

use crate::application::{PasswordKey, PasswordStore, PasswordStoreError};
use crate::domain::Password;

const SERVICE: &str = "com.yuiyeong.chillasql";

/// macOS 키체인에 비밀번호를 두는 [`PasswordStore`].
///
/// 항목은 service `com.yuiyeong.chillasql`, account `<프로젝트 디렉토리>::<접속 이름>`이다.
pub struct KeychainPasswordStore {
    store: Arc<Store>,
}

impl KeychainPasswordStore {
    pub fn new() -> Result<Self, PasswordStoreError> {
        Ok(Self {
            store: Store::new().map_err(store_error)?,
        })
    }

    fn entry(&self, key: &PasswordKey) -> Result<Entry, PasswordStoreError> {
        let account = format!("{}::{}", key.project_dir.display(), key.connection);
        self.store
            .build(SERVICE, &account, None)
            .map_err(store_error)
    }
}

impl PasswordStore for KeychainPasswordStore {
    fn get(&self, key: &PasswordKey) -> Result<Option<Password>, PasswordStoreError> {
        match self.entry(key)?.get_password() {
            Ok(value) => Ok(Some(Password::new(value))),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(store_error(e)),
        }
    }

    fn set(&self, key: &PasswordKey, password: &Password) -> Result<(), PasswordStoreError> {
        self.entry(key)?
            .set_password(password.expose())
            .map_err(store_error)
    }

    fn delete(&self, key: &PasswordKey) -> Result<(), PasswordStoreError> {
        match self.entry(key)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(store_error(e)),
        }
    }
}

fn store_error(error: Error) -> PasswordStoreError {
    PasswordStoreError {
        message: error.to_string(),
    }
}
