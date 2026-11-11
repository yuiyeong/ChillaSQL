use std::collections::HashMap;
use std::sync::Mutex;

use crate::application::{PasswordKey, PasswordStore, PasswordStoreError};
use crate::domain::Password;

/// 메모리에만 두는 [`PasswordStore`]. 실제 키체인을 건드리지 않아야 하는 test가 쓴다.
#[derive(Default)]
pub struct MemoryPasswordStore {
    entries: Mutex<HashMap<PasswordKey, String>>,
}

impl MemoryPasswordStore {
    fn entries(&self) -> std::sync::MutexGuard<'_, HashMap<PasswordKey, String>> {
        // 값을 넣고 빼기만 하므로 poison돼도 map은 온전하다.
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl PasswordStore for MemoryPasswordStore {
    fn get(&self, key: &PasswordKey) -> Result<Option<Password>, PasswordStoreError> {
        Ok(self.entries().get(key).cloned().map(Password::new))
    }

    fn set(&self, key: &PasswordKey, password: &Password) -> Result<(), PasswordStoreError> {
        self.entries()
            .insert(key.clone(), password.expose().to_string());
        Ok(())
    }

    fn delete(&self, key: &PasswordKey) -> Result<(), PasswordStoreError> {
        self.entries().remove(key);
        Ok(())
    }
}
