mod commands;
mod error;
mod menu;

use std::sync::Arc;

use chilla_core::infrastructure::{
    FsSqlFileStore, KeychainPasswordStore, PgConnector, PgQueryInspector, PgQuerySplitter,
    ShellTunnelRunner, TomlProjectStore,
};

use commands::{CoreApp, Quitting, TunnelEventDto};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};

/// 화면이 터널 상태를 받는 event 이름.
const TUNNEL_EVENT: &str = "tunnel";

/// Rust가 종료를 요청받았음을 화면에 알리는 event 이름. 끝낼지는 화면이 묻고 `quit_app`으로 끝낸다.
const QUIT_REQUESTED_EVENT: &str = "quit-requested";

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .menu(menu::build)
        // Cmd+Q는 menu의 `quit` 항목이 받는다. 기본 Quit 항목은 `ExitRequested` 없이 바로 끝낸다.
        .on_menu_event(|app, event| {
            if event.id() == menu::QUIT_ID {
                let _ = app.emit(QUIT_REQUESTED_EVENT, ());
            }
        })
        // 창 닫기 button도 화면이 확인한 뒤에만 끝낸다.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.app_handle().emit(QUIT_REQUESTED_EVENT, ());
            }
        })
        .setup(|app| {
            // 여기서만 port 구현을 고른다. command는 `CoreApp`만 안다. 터널 상태를 화면으로
            // 보내려면 AppHandle이 있어야 해서 setup에서 만든다.
            let handle = app.handle().clone();
            let passwords = KeychainPasswordStore::new().expect("키체인을 쓸 수 없습니다");
            let core = CoreApp::new(
                Arc::new(TomlProjectStore),
                Arc::new(passwords),
                Arc::new(PgQuerySplitter),
                Arc::new(PgQueryInspector),
                Arc::new(FsSqlFileStore),
                PgConnector::new(),
                ShellTunnelRunner::new(),
                Arc::new(move |event| {
                    // 화면이 없어 보내지 못해도 터널은 그대로 돈다.
                    let _ = handle.emit(TUNNEL_EVENT, TunnelEventDto::from(event));
                }),
            );
            app.manage(core);
            app.manage(Quitting::default());
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
            commands::inspect_statement,
            commands::execute_query,
            commands::end_transaction,
            commands::fetch_more,
            commands::cancel_query,
            commands::cancel_tunnel,
            commands::restart_tunnel,
            commands::quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| match event {
        // tauri 2.12 / tao 0.37에서는 Cmd+Q, Dock Quit, 외부 종료가 `ExitRequested` 없이 바로
        // `Exit`가 된다(tao가 보내지 않는다). 이 분기는 보내는 버전을 위한 안전망이다.
        // Dock Quit은 확인 없이 끝나고, `Exit`의 `shutdown`이 세션을 닫아 서버가 되돌린다.
        RunEvent::ExitRequested { api, code, .. } => {
            if handle.state::<Quitting>().should_prevent_exit(code) {
                api.prevent_exit();
                let _ = handle.emit(QUIT_REQUESTED_EVENT, ());
            }
        }
        RunEvent::Exit => {
            tauri::async_runtime::block_on(handle.state::<CoreApp>().shutdown());
        }
        _ => {}
    });
}
