mod commands;
mod error;
mod menu;

use std::sync::Arc;

use chilla_core::infrastructure::{
    FsSqlFileStore, KeychainPasswordStore, PgConnector, PgQuerySplitter, TomlProjectStore,
};

use commands::CoreApp;
use tauri::{Manager, RunEvent};

pub fn run() {
    // 여기서만 port 구현을 고른다. command는 `CoreApp`만 안다.
    let passwords = KeychainPasswordStore::new().expect("키체인을 쓸 수 없습니다");
    let app = CoreApp::new(
        Arc::new(TomlProjectStore),
        Arc::new(passwords),
        Arc::new(PgQuerySplitter),
        Arc::new(FsSqlFileStore),
        PgConnector::new(),
    );

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(menu::build)
        .manage(app)
        .invoke_handler(tauri::generate_handler![
            commands::open_project,
            commands::create_project,
            commands::save_connection,
            commands::list_sql_files,
            commands::read_sql_file,
            commands::write_sql_file,
            commands::set_password,
            commands::has_password,
            commands::delete_password,
            commands::test_connection,
            commands::open_session,
            commands::session_state,
            commands::close_session,
            commands::split_statements,
            commands::execute_query,
            commands::fetch_more,
            commands::cancel_query,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            tauri::async_runtime::block_on(handle.state::<CoreApp>().close_all_sessions());
        }
    });
}
