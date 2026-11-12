use std::fs;
use std::os::unix::fs::symlink;

use chilla_core::application::{FileError, SqlFileStore};
use chilla_core::domain::{SqlPath, WriteMode};
use chilla_core::infrastructure::FsSqlFileStore;
use tempfile::TempDir;

/// 경로와 내용으로 파일을 만든다. 부모 디렉토리도 만든다.
fn project(files: &[(&str, &str)]) -> TempDir {
    let dir = TempDir::new().unwrap();
    for (path, content) in files {
        let full = dir.path().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, content).unwrap();
    }
    dir
}

fn paths(dir: &TempDir) -> Vec<String> {
    FsSqlFileStore
        .list(dir.path())
        .unwrap()
        .iter()
        .map(|p| p.as_str().to_string())
        .collect()
}

fn p(s: &str) -> SqlPath {
    SqlPath::parse(s).unwrap()
}

#[test]
fn lists_sql_files_recursively_in_order() {
    let dir = project(&[
        ("scratch.sql", ""),
        ("queries/users.sql", ""),
        ("queries/billing/refunds.sql", ""),
        ("notes.txt", ""),
        ("queries/README.md", ""),
        ("Q.SQL", ""),
    ]);
    assert_eq!(
        paths(&dir),
        [
            "Q.SQL",
            "queries/billing/refunds.sql",
            "queries/users.sql",
            "scratch.sql"
        ]
    );
}

#[test]
fn listing_skips_hidden_dependency_and_build_directories() {
    let dir = project(&[
        (".git/x.sql", ""),
        ("node_modules/pkg/x.sql", ""),
        ("target/x.sql", ""),
        ("a/.cache/x.sql", ""),
        (".hidden.sql", ""),
        ("ok.sql", ""),
    ]);
    assert_eq!(paths(&dir), ["ok.sql"]);
}

/// Review Focus 4
#[test]
fn symlinks_are_neither_listed_nor_followed() {
    let outside = project(&[("secret.sql", "SELECT 'secret'")]);
    let dir = project(&[]);
    symlink(outside.path(), dir.path().join("link")).unwrap();
    symlink(outside.path().join("secret.sql"), dir.path().join("s.sql")).unwrap();

    assert_eq!(paths(&dir), Vec::<String>::new());
    assert!(matches!(
        FsSqlFileStore.read(dir.path(), &p("s.sql")),
        Err(FileError::OutsideProject { .. })
    ));
    assert!(matches!(
        FsSqlFileStore.read(dir.path(), &p("link/secret.sql")),
        Err(FileError::OutsideProject { .. })
    ));
    assert!(matches!(
        FsSqlFileStore.write(dir.path(), &p("link/sub/new.sql"), "x", &WriteMode::Create),
        Err(FileError::OutsideProject { .. })
    ));
    assert!(!outside.path().join("sub").exists());
}

#[test]
fn read_returns_the_text_and_a_stamp() {
    let dir = project(&[("a.sql", "SELECT '한글';\n")]);
    let file = FsSqlFileStore.read(dir.path(), &p("a.sql")).unwrap();
    assert_eq!(file.text, "SELECT '한글';\n");
    assert!(!file.stamp.0.is_empty());
    let again = FsSqlFileStore.read(dir.path(), &p("a.sql")).unwrap();
    assert_eq!(again.stamp, file.stamp);

    assert_eq!(
        FsSqlFileStore.read(dir.path(), &p("nope.sql")),
        Err(FileError::NotFound {
            path: "nope.sql".into()
        })
    );
}

/// Review Focus 4
#[test]
fn files_over_the_limit_are_not_read() {
    let dir = project(&[("big.sql", "")]);
    let file = fs::OpenOptions::new()
        .write(true)
        .open(dir.path().join("big.sql"))
        .unwrap();
    file.set_len(FsSqlFileStore::MAX_BYTES + 1).unwrap();
    assert_eq!(
        FsSqlFileStore.read(dir.path(), &p("big.sql")),
        Err(FileError::TooLarge {
            path: "big.sql".into(),
            bytes: FsSqlFileStore::MAX_BYTES + 1
        })
    );

    let text = "x".repeat(FsSqlFileStore::MAX_BYTES as usize + 1);
    assert!(matches!(
        FsSqlFileStore.write(dir.path(), &p("big.sql"), &text, &WriteMode::Overwrite),
        Err(FileError::TooLarge { .. })
    ));
}

#[test]
fn non_utf8_files_are_refused() {
    let dir = project(&[]);
    fs::write(dir.path().join("bin.sql"), [0xff, 0xfe]).unwrap();
    assert_eq!(
        FsSqlFileStore.read(dir.path(), &p("bin.sql")),
        Err(FileError::NotUtf8 {
            path: "bin.sql".into()
        })
    );
}

#[test]
fn create_makes_parent_directories_and_refuses_an_existing_file() {
    let dir = project(&[]);
    let path = p("queries/new/x.sql");
    FsSqlFileStore
        .write(dir.path(), &path, "SELECT 1", &WriteMode::Create)
        .unwrap();
    let full = dir.path().join("queries/new/x.sql");
    assert_eq!(fs::read_to_string(&full).unwrap(), "SELECT 1");

    assert_eq!(
        FsSqlFileStore.write(dir.path(), &path, "SELECT 2", &WriteMode::Create),
        Err(FileError::Exists {
            path: "queries/new/x.sql".into()
        })
    );
    assert_eq!(fs::read_to_string(&full).unwrap(), "SELECT 1");
}

#[test]
fn create_returns_the_stamp_that_read_sees() {
    let dir = project(&[]);
    let stamp = FsSqlFileStore
        .write(dir.path(), &p("a.sql"), "SELECT 1", &WriteMode::Create)
        .unwrap();
    assert_eq!(
        FsSqlFileStore.read(dir.path(), &p("a.sql")).unwrap().stamp,
        stamp
    );
}

/// 임시 파일 이름이 파일 이름보다 길어도 NAME_MAX(255 byte)를 넘지 않는다.
#[test]
fn overwrite_writes_a_file_with_a_long_name() {
    let name = format!("{}.sql", "a".repeat(246));
    assert_eq!(name.len(), 250);
    let dir = project(&[(&name, "v1")]);

    FsSqlFileStore
        .write(dir.path(), &p(&name), "v2", &WriteMode::Overwrite)
        .unwrap();

    assert_eq!(fs::read_to_string(dir.path().join(&name)).unwrap(), "v2");
    let entries: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, [name]);
}

/// Review Focus 4
#[test]
fn overwrite_and_replace_refuse_a_symlink_target() {
    let outside = project(&[("victim.sql", "untouched")]);
    let dir = project(&[]);
    symlink(outside.path().join("victim.sql"), dir.path().join("a.sql")).unwrap();
    let stamp = FsSqlFileStore
        .read(outside.path(), &p("victim.sql"))
        .unwrap()
        .stamp;

    for mode in [WriteMode::Overwrite, WriteMode::Replace { expected: stamp }] {
        assert_eq!(
            FsSqlFileStore.write(dir.path(), &p("a.sql"), "x", &mode),
            Err(FileError::OutsideProject {
                path: "a.sql".into()
            }),
            "{mode:?}"
        );
    }
    assert_eq!(
        fs::read_to_string(outside.path().join("victim.sql")).unwrap(),
        "untouched"
    );
}

#[test]
fn replace_writes_when_the_stamp_matches() {
    let dir = project(&[("a.sql", "v1")]);
    let stamp = FsSqlFileStore.read(dir.path(), &p("a.sql")).unwrap().stamp;
    let new_stamp = FsSqlFileStore
        .write(
            dir.path(),
            &p("a.sql"),
            "v2",
            &WriteMode::Replace { expected: stamp },
        )
        .unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("a.sql")).unwrap(), "v2");
    assert_eq!(
        FsSqlFileStore.read(dir.path(), &p("a.sql")).unwrap().stamp,
        new_stamp
    );
    let leftovers: Vec<_> = fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".chilla-tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

/// Review Focus 3
#[test]
fn replace_refuses_a_file_changed_on_disk() {
    let dir = project(&[("a.sql", "v1")]);
    let stamp = FsSqlFileStore.read(dir.path(), &p("a.sql")).unwrap().stamp;
    fs::write(dir.path().join("a.sql"), "changed outside").unwrap();

    assert_eq!(
        FsSqlFileStore.write(
            dir.path(),
            &p("a.sql"),
            "mine",
            &WriteMode::Replace { expected: stamp }
        ),
        Err(FileError::Changed {
            path: "a.sql".into()
        })
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("a.sql")).unwrap(),
        "changed outside"
    );

    FsSqlFileStore
        .write(dir.path(), &p("a.sql"), "mine", &WriteMode::Overwrite)
        .unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("a.sql")).unwrap(),
        "mine"
    );

    let stamp = FsSqlFileStore.read(dir.path(), &p("a.sql")).unwrap().stamp;
    fs::remove_file(dir.path().join("a.sql")).unwrap();
    assert_eq!(
        FsSqlFileStore.write(
            dir.path(),
            &p("a.sql"),
            "x",
            &WriteMode::Replace { expected: stamp }
        ),
        Err(FileError::NotFound {
            path: "a.sql".into()
        })
    );
}

/// Review Focus 4
#[test]
fn paths_outside_the_project_are_rejected() {
    // `SqlPath::parse`가 "../x.sql"을 거절하므로 store까지 오지 않는다(domain의 단위 test).
    // store 수준: 프로젝트 디렉토리 자체가 symlink여도 그 안의 파일은 읽고 쓴다.
    let real = project(&[("a.sql", "SELECT 1")]);
    let holder = TempDir::new().unwrap();
    let linked = holder.path().join("proj");
    symlink(real.path(), &linked).unwrap();

    assert_eq!(
        FsSqlFileStore.read(&linked, &p("a.sql")).unwrap().text,
        "SELECT 1"
    );
    FsSqlFileStore
        .write(&linked, &p("sub/b.sql"), "SELECT 2", &WriteMode::Create)
        .unwrap();
    assert_eq!(
        fs::read_to_string(real.path().join("sub/b.sql")).unwrap(),
        "SELECT 2"
    );
}
