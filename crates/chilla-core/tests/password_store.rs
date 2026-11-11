use std::path::PathBuf;

use chilla_core::application::{PasswordKey, PasswordStore};
use chilla_core::domain::Password;
use chilla_core::infrastructure::{KeychainPasswordStore, MemoryPasswordStore};

fn key(project_dir: &str, connection: &str) -> PasswordKey {
    PasswordKey {
        project_dir: PathBuf::from(project_dir),
        connection: connection.into(),
    }
}

fn get(store: &dyn PasswordStore, key: &PasswordKey) -> Option<String> {
    store.get(key).unwrap().map(|p| p.expose().to_string())
}

fn contract(store: &dyn PasswordStore, project_dir: &str) {
    let a = key(project_dir, "a");
    let b = key(project_dir, "b");
    let other = key(&format!("{project_dir}/other"), "a");

    assert_eq!(get(store, &a), None);
    store.set(&a, &Password::new("one".into())).unwrap();
    assert_eq!(get(store, &a).as_deref(), Some("one"));
    store.set(&a, &Password::new("two".into())).unwrap(); // 덮어쓴다
    assert_eq!(get(store, &a).as_deref(), Some("two"));
    assert_eq!(get(store, &b), None); // 접속 이름으로 구분
    assert_eq!(get(store, &other), None); // 프로젝트 경로로 구분
    store.delete(&a).unwrap();
    assert_eq!(get(store, &a), None);
    store.delete(&a).unwrap(); // 없어도 Ok
}

#[test]
fn memory_store_follows_the_contract() {
    contract(&MemoryPasswordStore::default(), "/p");
}

#[test]
#[ignore = "실제 키체인을 쓴다. 손으로 돌린다"]
fn keychain_store_follows_the_contract() {
    let store = KeychainPasswordStore::new().unwrap();
    let project_dir = format!("/chilla-test/{}", std::process::id());
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract(&store, &project_dir)
    }));
    // contract가 중간에 실패해도 키체인에 항목을 남기지 않는다.
    store.delete(&key(&project_dir, "a")).unwrap();
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}
