mod commands;
mod error;

use std::sync::Arc;

use chilla_core::infrastructure::{KeychainPasswordStore, PgConnector, TomlProjectStore};

use commands::CoreApp;

pub fn run() {
    // 여기서만 port 구현을 고른다. command는 `CoreApp`만 안다.
    let passwords = KeychainPasswordStore::new().expect("키체인을 쓸 수 없습니다");
    let app = CoreApp::new(
        Arc::new(TomlProjectStore),
        Arc::new(passwords),
        PgConnector::new(),
    );

    tauri::Builder::default()
        .manage(app)
        .invoke_handler(tauri::generate_handler![
            commands::open_project,
            commands::set_password,
            commands::has_password,
            commands::delete_password,
            commands::test_connection,
            commands::open_session,
            commands::session_state,
            commands::close_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
