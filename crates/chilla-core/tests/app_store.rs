use std::fs;
use std::path::{Path, PathBuf};

use chilla_core::application::{AppStore, NewHistoryEntry, RecentProject};
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
fn a_newer_version_is_refused() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("chilla.sqlite3");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.pragma_update(None, "user_version", 3).unwrap();
    drop(connection);

    let error = SqliteAppStore::open(&path)
        .err()
        .expect("열리지 않아야 한다");

    assert!(error.message.contains("version 3"), "{error}");
}

#[test]
fn upgrades_a_version_1_file() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("chilla.sqlite3");
    // M8이 만든 판 1 파일
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE recent_projects (
                 dir TEXT PRIMARY KEY, name TEXT NOT NULL, opened_at INTEGER NOT NULL
             );
             CREATE TABLE workspaces (
                 dir TEXT PRIMARY KEY, snapshot TEXT NOT NULL, saved_at INTEGER NOT NULL
             );
             INSERT INTO recent_projects (dir, name, opened_at) VALUES ('/a', 'a', 100);
             PRAGMA user_version = 1;",
        )
        .unwrap();
    drop(connection);

    let store = SqliteAppStore::open(&path).unwrap();

    assert_eq!(dirs(&store.recent_projects().unwrap()), ["/a"]);
    store
        .record_query(Path::new("/a"), &entry("select 1", 1))
        .unwrap();
    assert_eq!(search(&store, "/a", &[]).len(), 1);
    drop(store);
    let connection = rusqlite::Connection::open(&path).unwrap();
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 2);
}

fn entry(sql: &str, executed_at: i64) -> NewHistoryEntry {
    NewHistoryEntry {
        connection: "local".into(),
        sql: sql.into(),
        executed_at,
        elapsed_micros: 1500,
    }
}

fn record(store: &SqliteAppStore, dir: &str, sql: &str, executed_at: i64) {
    store
        .record_query(Path::new(dir), &entry(sql, executed_at))
        .unwrap();
}

fn search(store: &SqliteAppStore, dir: &str, words: &[&str]) -> Vec<String> {
    let words: Vec<String> = words.iter().map(|w| w.to_string()).collect();
    store
        .search_history(Path::new(dir), &words, 200)
        .unwrap()
        .into_iter()
        .map(|e| e.sql)
        .collect()
}

#[test]
fn records_and_searches_newest_first() {
    let (_tmp, _path, store) = open();
    record(&store, "/a", "select 1", 100);
    record(&store, "/a", "select 2", 100);
    record(&store, "/a", "select 3", 50);

    // 최근 것은 id가 큰 쪽이다. 시각이 달라도 기록한 순서가 위다.
    assert_eq!(
        search(&store, "/a", &[]),
        ["select 3", "select 2", "select 1"]
    );
    let found = store.search_history(Path::new("/a"), &[], 1).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(
        (
            found[0].connection.as_str(),
            found[0].executed_at,
            found[0].elapsed_micros
        ),
        ("local", 50, 1500)
    );
    assert!(found[0].id > 0);
}

#[test]
fn history_is_per_project() {
    let (_tmp, _path, store) = open();
    record(&store, "/a", "select a", 1);
    record(&store, "/b", "select b", 2);

    assert_eq!(search(&store, "/a", &[]), ["select a"]);
    assert_eq!(search(&store, "/b", &[]), ["select b"]);
    assert_eq!(search(&store, "/c", &[]), Vec::<String>::new());
}

#[test]
fn all_words_must_match() {
    let (_tmp, _path, store) = open();
    record(&store, "/a", "select email from users", 1);
    record(&store, "/a", "select name from users", 2);
    record(&store, "/a", "select email from orders", 3);

    assert_eq!(
        search(&store, "/a", &["users", "email"]),
        ["select email from users"]
    );
}

#[test]
fn match_ignores_ascii_case() {
    let (_tmp, _path, store) = open();
    record(&store, "/a", "select * from users", 1);

    assert_eq!(search(&store, "/a", &["USERS"]), ["select * from users"]);
}

#[test]
fn percent_and_underscore_match_literally() {
    let (_tmp, _path, store) = open();
    record(&store, "/a", "select user_id from t", 1);
    record(&store, "/a", "select userXid from t", 2);
    record(&store, "/a", "select 100% from t", 3);
    record(&store, "/a", "select 100x from t", 4);
    record(&store, "/a", r"select 'a\b' from t", 5);

    assert_eq!(
        search(&store, "/a", &["user_id"]),
        ["select user_id from t"]
    );
    assert_eq!(search(&store, "/a", &["100%"]), ["select 100% from t"]);
    assert_eq!(search(&store, "/a", &[r"a\b"]), [r"select 'a\b' from t"]);
}

#[test]
fn keeps_the_latest_ten_thousand() {
    let (_tmp, _path, store) = open();
    record(&store, "/other", "select other", 0);
    for i in 0..10_001 {
        record(&store, "/a", &format!("select {i}"), i);
    }

    let found = store.search_history(Path::new("/a"), &[], 20_000).unwrap();
    assert_eq!(found.len(), 10_000);
    assert_eq!(found[0].sql, "select 10000");
    assert_eq!(found[9_999].sql, "select 1");
    assert_eq!(search(&store, "/other", &[]), ["select other"]);
}
