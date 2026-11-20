use std::fs;
use std::path::{Path, PathBuf};

use chilla_core::application::{AppStore, RecentProject};
use chilla_core::infrastructure::SqliteAppStore;
use tempfile::TempDir;

fn open() -> (TempDir, PathBuf, SqliteAppStore) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("chilla.sqlite3");
    let store = SqliteAppStore::open(&path).unwrap();
    (dir, path, store)
}

fn project(dir: &str, opened_at: i64) -> RecentProject {
    RecentProject {
        dir: PathBuf::from(dir),
        name: dir.trim_start_matches('/').to_string(),
        opened_at,
    }
}

fn dirs(projects: &[RecentProject]) -> Vec<&str> {
    projects.iter().map(|p| p.dir.to_str().unwrap()).collect()
}

#[test]
fn records_and_lists_recent_projects_newest_first() {
    let (_tmp, _path, store) = open();
    assert_eq!(store.recent_projects().unwrap(), []);

    store.record_project(&project("/a", 100)).unwrap();
    store.record_project(&project("/b", 300)).unwrap();
    store.record_project(&project("/c", 200)).unwrap();

    let recent = store.recent_projects().unwrap();
    assert_eq!(dirs(&recent), ["/b", "/c", "/a"]);
    assert_eq!(recent[0], project("/b", 300));
}

#[test]
fn keeps_only_ten() {
    let (_tmp, _path, store) = open();
    for i in 0..12 {
        store
            .record_project(&project(&format!("/p{i}"), i))
            .unwrap();
    }

    let recent = store.recent_projects().unwrap();
    assert_eq!(recent.len(), 10);
    assert_eq!(recent[0].dir, Path::new("/p11"));
    assert_eq!(recent[9].dir, Path::new("/p2"));
}

#[test]
fn recording_again_moves_it_to_the_top() {
    let (_tmp, _path, store) = open();
    store.record_project(&project("/a", 100)).unwrap();
    store.record_project(&project("/b", 200)).unwrap();

    let mut again = project("/a", 300);
    again.name = "renamed".into();
    store.record_project(&again).unwrap();

    let recent = store.recent_projects().unwrap();
    assert_eq!(dirs(&recent), ["/a", "/b"]);
    assert_eq!(recent[0].name, "renamed");
}

#[test]
fn recording_in_the_same_second_still_moves_it_to_the_top() {
    let (_tmp, _path, store) = open();
    store.record_project(&project("/a", 100)).unwrap();
    store.record_project(&project("/b", 100)).unwrap();
    store.record_project(&project("/a", 100)).unwrap();

    assert_eq!(dirs(&store.recent_projects().unwrap()), ["/a", "/b"]);
}

#[test]
fn workspace_round_trips_by_dir() {
    let (_tmp, _path, store) = open();
    store
        .save_workspace(Path::new("/a"), r#"{"tabs":["가"]}"#, 10)
        .unwrap();

    assert_eq!(
        store.load_workspace(Path::new("/a")).unwrap().as_deref(),
        Some(r#"{"tabs":["가"]}"#)
    );

    store.save_workspace(Path::new("/a"), "{}", 20).unwrap();
    assert_eq!(
        store.load_workspace(Path::new("/a")).unwrap().as_deref(),
        Some("{}")
    );
}

#[test]
fn workspace_of_another_dir_is_none() {
    let (_tmp, _path, store) = open();
    store.save_workspace(Path::new("/a"), "{}", 10).unwrap();

    assert_eq!(store.load_workspace(Path::new("/b")).unwrap(), None);
}

#[test]
fn reopening_keeps_the_data() {
    let (_tmp, path, store) = open();
    store.record_project(&project("/a", 100)).unwrap();
    store.save_workspace(Path::new("/a"), "{}", 10).unwrap();
    drop(store);

    let store = SqliteAppStore::open(&path).unwrap();

    assert_eq!(dirs(&store.recent_projects().unwrap()), ["/a"]);
    assert_eq!(
        store.load_workspace(Path::new("/a")).unwrap().as_deref(),
        Some("{}")
    );
}

#[test]
fn a_corrupt_file_is_an_error() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("chilla.sqlite3");
    fs::write(&path, vec![0x5a; 4096]).unwrap();

    let error = SqliteAppStore::open(&path)
        .err()
        .expect("열리지 않아야 한다");

    assert!(error.message.contains("not a database"), "{error}");
}

#[test]
fn a_newer_schema_version_is_an_error() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("chilla.sqlite3");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.pragma_update(None, "user_version", 2).unwrap();
    drop(connection);

    let error = SqliteAppStore::open(&path)
        .err()
        .expect("열리지 않아야 한다");

    assert!(error.message.contains("version 2"), "{error}");
}
