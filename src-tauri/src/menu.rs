//! 앱 menu. Tauri의 기본 menu에서 `File`과 `Window`의 "Close Window"를 뺀 것이다.
//! Cmd+W를 화면이 받아 editor tab을 닫게 하려는 것이다(창을 닫는 항목이 있으면 menu가 먼저 가져간다).

use chilla_core::domain::Language;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// Quit 항목의 id. 기본 Quit 항목은 `ExitRequested` 없이 앱을 끝내므로 직접 만들어
/// 화면이 열린 트랜잭션을 확인하게 한다.
pub const QUIT_ID: &str = "quit";

/// 직접 만드는 항목의 label. Predefined 항목은 macOS가 그리는 기본 label을 둔다.
struct Labels {
    quit: &'static str,
    edit: &'static str,
    view: &'static str,
    window: &'static str,
}

impl Labels {
    fn of(language: Language) -> Self {
        match language {
            Language::En => Self {
                quit: "Quit ChillaSQL",
                edit: "Edit",
                view: "View",
                window: "Window",
            },
            Language::Ko => Self {
                quit: "ChillaSQL 종료",
                edit: "편집",
                view: "보기",
                window: "윈도우",
            },
        }
    }
}

pub fn build<R: Runtime>(handle: &AppHandle<R>, language: Language) -> tauri::Result<Menu<R>> {
    let labels = Labels::of(language);
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
                    &MenuItem::with_id(handle, QUIT_ID, labels.quit, true, Some("CmdOrCtrl+Q"))?,
                ],
            )?,
            &Submenu::with_items(
                handle,
                labels.edit,
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
                labels.view,
                true,
                &[&PredefinedMenuItem::fullscreen(handle, None)?],
            )?,
            &Submenu::with_items(
                handle,
                labels.window,
                true,
                &[
                    &PredefinedMenuItem::minimize(handle, None)?,
                    &PredefinedMenuItem::maximize(handle, None)?,
                ],
            )?,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_follow_the_language() {
        let en = Labels::of(Language::En);
        assert_eq!(
            (en.quit, en.edit, en.view, en.window),
            ("Quit ChillaSQL", "Edit", "View", "Window")
        );
        let ko = Labels::of(Language::Ko);
        assert_eq!(
            (ko.quit, ko.edit, ko.view, ko.window),
            ("ChillaSQL 종료", "편집", "보기", "윈도우")
        );
    }
}
