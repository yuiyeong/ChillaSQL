//! `~/.config/chilla/config.toml`을 읽는다. 파일은 앱이 만들지도 고치지도 않는다.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::domain::{Settings, SettingsError};

const FONT_SIZE: (i64, i64) = (10, 32);
const RETAINED_ROWS: (i64, i64) = (1_000, 1_000_000);
const IDLE_TIMEOUT_SECS: (i64, i64) = (60, 86_400);

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawFile {
    language: Option<String>,
    #[serde(default)]
    editor: RawEditor,
    #[serde(default)]
    results: RawResults,
}

// 정수는 i64로 받아 범위를 읽은 뒤 검사한다. 음수나 큰 값이 형 변환에서 사라지지 않게 한다.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawEditor {
    font: Option<String>,
    font_size: Option<i64>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawResults {
    retained_rows: Option<i64>,
    idle_timeout: Option<i64>,
}

/// 파일이 없으면 기본값. 틀리면 기본값과 그 이유(맞는 key가 있어도 일부만 쓰지 않는다).
pub fn load_settings(path: &Path) -> (Settings, Option<SettingsError>) {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return (Settings::default(), None),
        Err(e) => return fallback(path, format!("could not read the file: {e}")),
    };
    match parse(&text) {
        Ok(settings) => (settings, None),
        Err(message) => fallback(path, message),
    }
}

fn fallback(path: &Path, message: String) -> (Settings, Option<SettingsError>) {
    let error = SettingsError {
        path: path.display().to_string(),
        message,
    };
    (Settings::default(), Some(error))
}

/// `$HOME/.config/chilla/config.toml`. `HOME`이 없으면 없다.
pub fn settings_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|home| !home.is_empty())?;
    Some(
        PathBuf::from(home)
            .join(".config")
            .join("chilla")
            .join("config.toml"),
    )
}

fn parse(text: &str) -> Result<Settings, String> {
    let raw: RawFile = toml::from_str(text).map_err(|e| e.to_string())?;
    let mut settings = Settings::default();
    if let Some(language) = raw.language {
        settings.language = language
            .parse()
            .map_err(|()| format!("language must be \"en\" or \"ko\", got \"{language}\""))?;
    }
    if let Some(font) = raw.editor.font {
        if font.trim().is_empty() {
            return Err("editor.font must not be empty".into());
        }
        settings.editor.font = font;
    }
    if let Some(size) = raw.editor.font_size {
        settings.editor.font_size = in_range("editor.font_size", size, FONT_SIZE)? as u16;
    }
    if let Some(rows) = raw.results.retained_rows {
        settings.limits.retained_rows =
            in_range("results.retained_rows", rows, RETAINED_ROWS)? as u64;
    }
    if let Some(secs) = raw.results.idle_timeout {
        let secs = in_range("results.idle_timeout", secs, IDLE_TIMEOUT_SECS)?;
        settings.limits.idle_result_timeout = Duration::from_secs(secs as u64);
    }
    Ok(settings)
}

fn in_range(key: &str, value: i64, (min, max): (i64, i64)) -> Result<i64, String> {
    if (min..=max).contains(&value) {
        Ok(value)
    } else {
        Err(format!(
            "{key} must be between {min} and {max}, got {value}"
        ))
    }
}
