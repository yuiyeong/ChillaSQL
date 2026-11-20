//! layer 의존 방향 검사. compiler는 같은 crate 안의 module 사이 의존 방향을 막지 못한다.
//! 규칙은 docs/architecture.md 2장에 있다.

use std::fs;
use std::path::{Path, PathBuf};

use syn::visit::Visit;

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
    "toml_edit",
    "pg_query",
    "rusqlite",
    "iana_time_zone",
    "std::fs",
    "std::net",
    "std::process",
    "libc",
];

const APPLICATION_FORBIDDEN: &[&str] = &[
    "crate::infrastructure",
    "tokio_postgres",
    "tokio_rustls",
    "rustls",
    "keyring_core",
    "apple_native_keyring_store",
    "toml",
    "toml_edit",
    "pg_query",
    "rusqlite",
    "iana_time_zone",
    "std::fs",
    "std::net",
    "std::process",
    "tokio::net",
    "tokio::fs",
    "tokio::process",
    "libc",
];

const LAYERS: [(&str, &[&str]); 2] = [
    ("domain", DOMAIN_FORBIDDEN),
    ("application", APPLICATION_FORBIDDEN),
];

/// source가 쓰는 경로 가운데 금지된 것을 돌려준다.
///
/// 글자를 찾지 않고 `syn`으로 parse해서 본다. `use std::{fs, path::Path};`처럼 묶은 import나
/// 여러 줄에 걸친 import는 한 줄 안에 `std::fs`라는 글자가 없어서 글자 검색으로는 놓친다.
fn violations(forbidden: &[&str], source: &str) -> Vec<String> {
    let file = syn::parse_file(source).unwrap_or_else(|e| panic!("parse 실패: {e}\n{source}"));
    let mut found = Found {
        forbidden,
        paths: Vec::new(),
    };
    found.visit_file(&file);
    found.paths
}

struct Found<'a> {
    forbidden: &'a [&'a str],
    paths: Vec<String>,
}

impl Found<'_> {
    fn check(&mut self, segments: &[String]) {
        // `super::super::infrastructure`도 `crate::infrastructure`로 본다.
        let relative = segments
            .iter()
            .take_while(|s| *s == "super" || *s == "self")
            .count();
        let mut path: Vec<&str> = segments[relative..].iter().map(String::as_str).collect();
        if relative > 0 {
            path.insert(0, "crate");
        }
        let is_forbidden = self.forbidden.iter().any(|token| {
            let token: Vec<&str> = token.split("::").collect();
            path.starts_with(&token)
        });
        if is_forbidden {
            self.paths.push(path.join("::"));
        }
    }

    fn check_use(&mut self, tree: &syn::UseTree, prefix: &mut Vec<String>) {
        match tree {
            syn::UseTree::Path(path) => {
                prefix.push(path.ident.to_string());
                self.check_use(&path.tree, prefix);
                prefix.pop();
            }
            syn::UseTree::Group(group) => {
                for tree in &group.items {
                    self.check_use(tree, prefix);
                }
            }
            syn::UseTree::Glob(_) => self.check(prefix),
            syn::UseTree::Name(syn::UseName { ident, .. })
            | syn::UseTree::Rename(syn::UseRename { ident, .. }) => {
                prefix.push(ident.to_string());
                self.check(prefix);
                prefix.pop();
            }
        }
    }
}

impl<'ast> Visit<'ast> for Found<'_> {
    fn visit_item_use(&mut self, item: &'ast syn::ItemUse) {
        self.check_use(&item.tree, &mut Vec::new());
    }

    fn visit_path(&mut self, path: &'ast syn::Path) {
        let segments: Vec<String> = path.segments.iter().map(|s| s.ident.to_string()).collect();
        self.check(&segments);
        syn::visit::visit_path(self, path);
    }

    /// macro의 인자는 parse되지 않은 token이다 (`tokio::select!` 등). 글자로 찾는다.
    fn visit_macro(&mut self, mac: &'ast syn::Macro) {
        let body: String = mac.tokens.to_string().split_whitespace().collect();
        let is_ident = |c: char| c.is_alphanumeric() || c == '_' || c == ':';
        for token in self.forbidden {
            let used = body.match_indices(token).any(|(start, _)| {
                let boundary = !body[..start].chars().next_back().is_some_and(is_ident);
                boundary && body[start + token.len()..].starts_with("::")
            });
            if used {
                self.paths.push(format!("{token} (macro 안)"));
            }
        }
        syn::visit::visit_macro(self, mac);
    }
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
    let domain = DOMAIN_FORBIDDEN;
    let application = APPLICATION_FORBIDDEN;
    assert_eq!(
        violations(domain, "use crate::infrastructure::keychain::X;").len(),
        1
    );
    assert_eq!(
        violations(
            application,
            "async fn f() { let s = tokio::net::TcpStream::connect(a); }"
        )
        .len(),
        1
    );
    assert!(violations(application, "use tokio::sync::mpsc;").is_empty());
    assert!(violations(domain, "// tokio::net 은 쓰지 않는다").is_empty());
    assert_eq!(violations(domain, "use tokio;").len(), 1);
    assert!(violations(domain, "fn f() { let custom_toml_name = 1; }").is_empty());
}

#[test]
fn scanner_catches_grouped_and_multiline_imports() {
    let application = APPLICATION_FORBIDDEN;
    assert_eq!(
        violations(application, "use std::{fs, path::Path};"),
        ["std::fs"]
    );
    assert_eq!(
        violations(application, "use tokio::{net::TcpStream, sync::mpsc};"),
        ["tokio::net::TcpStream"]
    );
    assert_eq!(
        violations(
            application,
            "use crate::{\n    domain::Project,\n    infrastructure::PgConnector,\n};"
        ),
        ["crate::infrastructure::PgConnector"]
    );
    assert_eq!(
        violations(
            application,
            "use super::super::infrastructure::PgConnector;"
        ),
        ["crate::infrastructure::PgConnector"]
    );
    assert_eq!(
        violations(application, "use std::fs as files;"),
        ["std::fs"]
    );
    assert_eq!(
        violations(application, "use tokio::net::*;"),
        ["tokio::net"]
    );
}

#[test]
fn scanner_looks_inside_function_bodies_and_macros() {
    let application = APPLICATION_FORBIDDEN;
    assert_eq!(
        violations(application, "fn f() { let _ = std::fs::read(\"x\"); }"),
        ["std::fs::read"]
    );
    assert!(
        !violations(
            application,
            "async fn f() { tokio::select! { _ = tokio::net::TcpStream::connect(a) => {} } }"
        )
        .is_empty()
    );
    assert!(
        violations(
            application,
            "async fn f() { tokio::select! { _ = tokio::time::sleep(d) => {} } }"
        )
        .is_empty()
    );
}

#[test]
fn domain_and_application_follow_the_dependency_rule() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for (layer, forbidden) in LAYERS {
        let files = rust_files(&src.join(layer));
        assert!(!files.is_empty(), "{layer}에 .rs 파일이 없다");
        for file in files {
            let found = violations(forbidden, &fs::read_to_string(&file).unwrap());
            assert!(found.is_empty(), "{}: {found:#?}", file.display());
        }
    }
}

#[test]
fn core_does_not_depend_on_tauri() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    assert!(!fs::read_to_string(manifest).unwrap().contains("tauri"));
}
