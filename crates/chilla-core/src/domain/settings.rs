//! 앱 전역 설정. `~/.config/chilla/config.toml`의 값이며 앱을 시작할 때 한 번 읽는다.

use super::QueryLimits;

/// 화면 문구와 앱 menu의 언어.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Language {
    En,
    Ko,
}

/// SQL 에디터의 글꼴.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorSettings {
    /// CSS font-family 이름.
    pub font: String,
    /// px.
    pub font_size: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    pub language: Language,
    pub editor: EditorSettings,
    pub limits: QueryLimits,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: Language::En,
            editor: EditorSettings {
                font: "D2Coding".into(),
                font_size: 15,
            },
            limits: QueryLimits::default(),
        }
    }
}

/// 설정 파일을 읽지 못한 이유. 이때 앱은 기본값으로 시작한다.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{path}: {message}")]
pub struct SettingsError {
    pub path: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings() {
        let settings = Settings::default();
        assert_eq!(settings.language, Language::En);
        assert_eq!(settings.editor.font, "D2Coding");
        assert_eq!(settings.editor.font_size, 15);
        assert_eq!(settings.limits, QueryLimits::default());
    }
}
