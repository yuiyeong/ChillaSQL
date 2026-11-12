//! 앱 menu. Tauri의 기본 menu에서 `File`과 `Window`의 "Close Window"를 뺀 것이다.
//! Cmd+W를 화면이 받아 editor tab을 닫게 하려는 것이다(창을 닫는 항목이 있으면 menu가 먼저 가져간다).

use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

pub fn build<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    Menu::with_items(
        handle,
        &[
            &Submenu::with_items(
                handle,
                handle.package_info().name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(handle, None, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::services(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::hide(handle, None)?,
                    &PredefinedMenuItem::hide_others(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::quit(handle, None)?,
                ],
            )?,
            &Submenu::with_items(
                handle,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(handle, None)?,
                    &PredefinedMenuItem::redo(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::cut(handle, None)?,
                    &PredefinedMenuItem::copy(handle, None)?,
                    &PredefinedMenuItem::paste(handle, None)?,
                    &PredefinedMenuItem::select_all(handle, None)?,
                ],
            )?,
            &Submenu::with_items(
                handle,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(handle, None)?],
            )?,
            &Submenu::with_items(
                handle,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(handle, None)?,
                    &PredefinedMenuItem::maximize(handle, None)?,
                ],
            )?,
        ],
    )
}
