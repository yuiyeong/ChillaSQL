mod commands;
mod error;
mod menu;

use std::sync::Arc;

use chilla_core::infrastructure::{
    FsSqlFileStore, KeychainPasswordStore, PgConnector, PgQuerySplitter, ShellTunnelRunner,
    TomlProjectStore,
};

use commands::{CoreApp, TunnelEventDto};
use tauri::{Emitter, Manager, RunEvent};

/// 화면이 터널 상태를 받는 event 이름.
const TUNNEL_EVENT: &str = "tunnel";

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .menu(menu::build)
        .setup(|app| {
            // 여기서만 port 구현을 고른다. command는 `CoreApp`만 안다. 터널 상태를 화면으로
            // 보내려면 AppHandle이 있어야 해서 setup에서 만든다.
            let handle = app.handle().clone();
            let passwords = KeychainPasswordStore::new().expect("키체인을 쓸 수 없습니다");
            let core = CoreApp::new(
                Arc::new(TomlProjectStore),
                Arc::new(passwords),
                Arc::new(PgQuerySplitter),
                Arc::new(FsSqlFileStore),
                PgConnector::new(),
                ShellTunnelRunner::new(),
                Arc::new(move |event| {
                    // 화면이 없어 보내지 못해도 터널은 그대로 돈다.
                    let _ = handle.emit(TUNNEL_EVENT, TunnelEventDto::from(event));
                }),
            );
            app.manage(core);
            Ok(())
        })
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
            commands::end_transaction,
            commands::fetch_more,
            commands::cancel_query,
            commands::cancel_tunnel,
            commands::restart_tunnel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            tauri::async_runtime::block_on(handle.state::<CoreApp>().shutdown());
        }
    });
}
