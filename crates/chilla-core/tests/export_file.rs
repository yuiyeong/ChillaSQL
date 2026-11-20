use std::fs;
use std::io;

use chilla_core::infrastructure::write_export;
use tempfile::TempDir;

#[test]
fn write_export_replaces_the_file_atomically() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("result.csv");
    fs::write(&path, "old,contents\n").unwrap();

    write_export(&path, "id,name\n1,김\n").unwrap();

    assert_eq!(fs::read_to_string(&path).unwrap(), "id,name\n1,김\n");
    // 임시 파일이 남지 않는다.
    let names: Vec<String> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["result.csv"]);
}

#[test]
fn write_export_creates_a_new_file() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("result.json");

    write_export(&path, "[]").unwrap();

    assert_eq!(fs::read_to_string(&path).unwrap(), "[]");
}

#[test]
fn write_export_reports_a_missing_directory() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("gone").join("result.csv");

    let error = write_export(&path, "x").unwrap_err();

    assert_eq!(error.kind(), io::ErrorKind::NotFound);
    assert!(!dir.path().join("gone").exists());
}
