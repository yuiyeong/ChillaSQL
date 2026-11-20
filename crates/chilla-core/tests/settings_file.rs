use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use chilla_core::domain::{Language, Settings};
use chilla_core::infrastructure::load_settings;
use tempfile::TempDir;

fn write(text: &str) -> (TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.toml");
    fs::write(&path, text).unwrap();
    (dir, path)
}

#[test]
fn missing_file_is_default() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.toml");

    let (settings, error) = load_settings(&path);

    assert_eq!(settings, Settings::default());
    assert_eq!(error, None);
    assert!(!path.exists(), "파일을 만들지 않는다");
}

#[test]
fn reads_every_key() {
    let (_dir, path) = write(
        r#"
language = "ko"

[editor]
font = "Menlo"
font_size = 18

[results]
retained_rows = 5000
idle_timeout = 120
"#,
    );

    let (settings, error) = load_settings(&path);

    assert_eq!(error, None);
    assert_eq!(settings.language, Language::Ko);
    assert_eq!(settings.editor.font, "Menlo");
    assert_eq!(settings.editor.font_size, 18);
    assert_eq!(settings.limits.retained_rows, 5000);
    assert_eq!(
        settings.limits.idle_result_timeout,
        Duration::from_secs(120)
    );
    let defaults = Settings::default().limits;
    assert_eq!(settings.limits.batch_rows, defaults.batch_rows);
    assert_eq!(settings.limits.batch_bytes, defaults.batch_bytes);
}

#[test]
fn bounds_are_accepted() {
    let (_dir, path) =
        write("[editor]\nfont_size = 10\n[results]\nretained_rows = 1000\nidle_timeout = 60\n");
    assert_eq!(load_settings(&path).1, None);
    let (_dir, path) = write(
        "[editor]\nfont_size = 32\n[results]\nretained_rows = 1000000\nidle_timeout = 86400\n",
    );
    assert_eq!(load_settings(&path).1, None);
}

#[test]
fn partial_file_keeps_other_defaults() {
    let (_dir, path) = write("[editor]\nfont_size = 13\n");

    let (settings, error) = load_settings(&path);

    assert_eq!(error, None);
    let mut expected = Settings::default();
    expected.editor.font_size = 13;
    assert_eq!(settings, expected);
}

#[test]
fn unknown_key_is_an_error() {
    let (_dir, path) = write("[editor]\nfontsize = 14\n");

    let (settings, error) = load_settings(&path);

    assert_eq!(settings, Settings::default());
    let error = error.expect("error");
    assert!(error.message.contains("fontsize"), "{}", error.message);
    assert_eq!(error.path, path.display().to_string());
}

#[test]
fn unknown_section_is_an_error() {
    let (_dir, path) = write("[editr]\nfont_size = 14\n");
    let (settings, error) = load_settings(&path);
    assert_eq!(settings, Settings::default());
    assert!(error.unwrap().message.contains("editr"));
}

#[test]
fn malformed_toml_is_an_error() {
    let (_dir, path) = write("language = \n");
    let (settings, error) = load_settings(&path);
    assert_eq!(settings, Settings::default());
    assert!(error.is_some());
}

#[test]
fn wrong_type_is_an_error() {
    let (_dir, path) = write("[editor]\nfont_size = \"big\"\n");
    let (settings, error) = load_settings(&path);
    assert_eq!(settings, Settings::default());
    assert!(error.unwrap().message.contains("font_size"));
}

#[test]
fn out_of_range_is_an_error() {
    let cases = [
        ("[editor]\nfont_size = 9\n", "font_size"),
        ("[editor]\nfont_size = 33\n", "font_size"),
        ("[editor]\nfont_size = -1\n", "font_size"),
        ("[results]\nretained_rows = 999\n", "retained_rows"),
        ("[results]\nretained_rows = 1000001\n", "retained_rows"),
        ("[results]\nidle_timeout = 59\n", "idle_timeout"),
        ("[results]\nidle_timeout = 86401\n", "idle_timeout"),
        ("language = \"ja\"\n", "language"),
    ];
    for (text, key) in cases {
        let (_dir, path) = write(text);

        let (settings, error) = load_settings(&path);

        assert_eq!(settings, Settings::default(), "{text}");
        let error = error.unwrap_or_else(|| panic!("{text}: error 없음"));
        assert!(error.message.contains(key), "{text}: {}", error.message);
    }
}

#[test]
fn one_bad_value_discards_the_valid_ones() {
    let (_dir, path) = write("language = \"ko\"\n[editor]\nfont_size = 9\n");
    let (settings, error) = load_settings(&path);
    assert_eq!(settings, Settings::default());
    assert!(error.is_some());
}

#[test]
fn unreadable_path_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    // 파일 자리에 디렉토리가 있다.
    let (settings, error) = load_settings(dir.path());
    assert_eq!(settings, Settings::default());
    assert!(error.is_some());
}
