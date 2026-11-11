//! layer 의존 방향 검사. compiler는 같은 crate 안의 module 사이 의존 방향을 막지 못한다.
//! 규칙은 docs/architecture.md 2장에 있다.

use std::fs;
use std::path::{Path, PathBuf};

const DOMAIN_FORBIDDEN: &[&str] = &[
    "crate::application",
    "crate::infrastructure",
    "tokio",
    "tokio_postgres",
    "tokio_rustls",
    "rustls",
    "keyring_core",
    "apple_native_keyring_store",
    "toml",
    "pg_query",
    "std::fs",
    "std::net",
    "std::process",
];

const APPLICATION_FORBIDDEN: &[&str] = &[
    "crate::infrastructure",
    "tokio_postgres",
    "tokio_rustls",
    "rustls",
    "keyring_core",
    "apple_native_keyring_store",
    "toml",
    "pg_query",
    "std::fs",
    "std::net",
    "std::process",
    "tokio::net",
    "tokio::fs",
    "tokio::process",
];

fn forbidden(layer: &str) -> &'static [&'static str] {
    match layer {
        "domain" => DOMAIN_FORBIDDEN,
        "application" => APPLICATION_FORBIDDEN,
        other => panic!("모르는 layer: {other}"),
    }
}

/// `token`이 식별자의 일부가 아니라 경로로 쓰였는지 본다 (`<token>::` 또는 `use <token>`).
fn uses(line: &str, token: &str) -> bool {
    let is_ident = |c: char| c.is_alphanumeric() || c == '_';
    line.match_indices(token).any(|(start, _)| {
        let before = line[..start].chars().next_back();
        let after = &line[start + token.len()..];
        let starts_clean = !before.is_some_and(|c| is_ident(c) || c == ':');
        let as_path = after.starts_with("::");
        let as_use = line[..start].trim_end().ends_with("use")
            && !after.chars().next().is_some_and(is_ident);
        starts_clean && (as_path || as_use)
    })
}

/// 위반한 줄을 돌려준다. 주석 줄은 건너뛴다.
fn violations(layer: &str, source: &str) -> Vec<String> {
    source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .filter(|line| forbidden(layer).iter().any(|token| uses(line, token)))
        .map(str::to_string)
        .collect()
}

fn rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let entries = fs::read_dir(dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display()));
    for entry in entries {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.extend(rust_files(&path));
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            files.push(path);
        }
    }
    files
}

#[test]
fn scanner_catches_a_violation() {
    assert_eq!(
        violations("domain", "use crate::infrastructure::keychain::X;").len(),
        1
    );
    assert_eq!(
        violations("application", "let s = tokio::net::TcpStream::connect(a);").len(),
        1
    );
    assert!(violations("application", "use tokio::sync::mpsc;").is_empty());
    assert!(violations("domain", "// tokio::net 은 쓰지 않는다").is_empty());
    assert_eq!(violations("domain", "use tokio;").len(), 1);
    assert!(violations("domain", "let custom_toml_name = 1;").is_empty());
}

#[test]
fn domain_and_application_follow_the_dependency_rule() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for layer in ["domain", "application"] {
        let files = rust_files(&src.join(layer));
        assert!(!files.is_empty(), "{layer}에 .rs 파일이 없다");
        for file in files {
            let found = violations(layer, &fs::read_to_string(&file).unwrap());
            assert!(found.is_empty(), "{}: {found:#?}", file.display());
        }
    }
}

#[test]
fn core_does_not_depend_on_tauri() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    assert!(!fs::read_to_string(manifest).unwrap().contains("tauri"));
}
