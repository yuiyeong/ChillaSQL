use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::atomic_write::{Missing, create_new_file, write_atomically};
use crate::application::{FileError, SqlFileStore};
use crate::domain::{FileStamp, SqlFile, SqlPath, WriteMode};

/// 프로젝트 디렉토리의 `.sql` 파일을 다루는 [`SqlFileStore`].
pub struct FsSqlFileStore;

impl FsSqlFileStore {
    /// 열고 쓸 수 있는 파일 크기의 상한.
    pub const MAX_BYTES: u64 = 16 * 1024 * 1024;
}

/// 목록에서 들어가지 않는 디렉토리. 이름이 `.`으로 시작하는 항목은 따로 모두 건너뛴다.
const SKIPPED_DIRS: [&str; 2] = ["node_modules", "target"];

impl SqlFileStore for FsSqlFileStore {
    fn list(&self, project_dir: &Path) -> Result<Vec<SqlPath>, FileError> {
        let mut found = Vec::new();
        let entries = fs::read_dir(project_dir).map_err(|e| FileError::Io {
            path: project_dir.display().to_string(),
            message: e.to_string(),
        })?;
        collect(entries, "", &mut found);
        found.sort();
        Ok(found)
    }

    fn read(&self, project_dir: &Path, path: &SqlPath) -> Result<SqlFile, FileError> {
        let full = resolve(project_dir, path)?;
        let mut file = File::open(&full).map_err(|e| io_error(path, &e))?;
        let meta = file.metadata().map_err(|e| io_error(path, &e))?;
        if meta.len() > Self::MAX_BYTES {
            return Err(too_large(path, meta.len()));
        }
        // 크기를 본 뒤에 파일이 커졌어도 상한을 넘겨 읽지 않는다.
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        (&mut file)
            .take(Self::MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| io_error(path, &e))?;
        if bytes.len() as u64 > Self::MAX_BYTES {
            let size = file
                .metadata()
                .map_or(bytes.len() as u64, |grown| grown.len());
            return Err(too_large(path, size));
        }
        let text = String::from_utf8(bytes).map_err(|_| FileError::NotUtf8 {
            path: path.as_str().to_string(),
        })?;
        Ok(SqlFile {
            text,
            stamp: stamp(&meta),
        })
    }

    fn write(
        &self,
        project_dir: &Path,
        path: &SqlPath,
        text: &str,
        mode: &WriteMode,
    ) -> Result<FileStamp, FileError> {
        if text.len() as u64 > Self::MAX_BYTES {
            return Err(too_large(path, text.len() as u64));
        }
        let full = resolve(project_dir, path)?;
        match mode {
            WriteMode::Create => create_new(path, &full, text),
            WriteMode::Replace { expected } => {
                let current = fs::metadata(&full).map_err(|e| io_error(path, &e))?;
                if stamp(&current) != *expected {
                    return Err(FileError::Changed {
                        path: path.as_str().to_string(),
                    });
                }
                replace(path, &full, text)
            }
            WriteMode::Overwrite => {
                make_parent_dirs(path, &full)?;
                replace(path, &full, text)
            }
        }
    }
}

fn collect(entries: fs::ReadDir, prefix: &str, found: &mut Vec<SqlPath>) {
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        // `DirEntry::file_type`은 symlink를 따라가지 않으므로 symlink는 어느 쪽도 아니다.
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let relative = format!("{prefix}{name}");
        if kind.is_dir() {
            if SKIPPED_DIRS.contains(&name.as_str()) {
                continue;
            }
            if let Ok(children) = fs::read_dir(entry.path()) {
                collect(children, &format!("{relative}/"), found);
            }
        } else if kind.is_file()
            && let Ok(path) = SqlPath::parse(&relative)
        {
            found.push(path);
        }
    }
}

/// `path`가 가리키는 실제 위치. 프로젝트 디렉토리 밖이거나 symlink면 거절한다.
/// 디렉토리를 만들기 전에 부른다.
fn resolve(project_dir: &Path, path: &SqlPath) -> Result<PathBuf, FileError> {
    let outside = || FileError::OutsideProject {
        path: path.as_str().to_string(),
    };
    let root = fs::canonicalize(project_dir).map_err(|e| FileError::Io {
        path: project_dir.display().to_string(),
        message: e.to_string(),
    })?;
    let full = root.join(path.as_str());

    // 아직 없는 하위 디렉토리는 건너뛰고, 있는 조상 중 가장 깊은 것이 프로젝트 안인지 본다.
    let existing = full
        .ancestors()
        .skip(1)
        .find(|ancestor| ancestor.symlink_metadata().is_ok())
        .ok_or_else(outside)?;
    // 끊어진 symlink는 canonicalize가 실패하므로 밖으로 본다.
    let real = fs::canonicalize(existing).map_err(|_| outside())?;
    if !real.starts_with(&root) {
        return Err(outside());
    }
    if full
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink())
    {
        return Err(outside());
    }
    Ok(full)
}

fn make_parent_dirs(path: &SqlPath, full: &Path) -> Result<(), FileError> {
    match full.parent() {
        Some(parent) => fs::create_dir_all(parent).map_err(|e| io_error(path, &e)),
        None => Ok(()),
    }
}

fn create_new(path: &SqlPath, full: &Path, text: &str) -> Result<FileStamp, FileError> {
    make_parent_dirs(path, full)?;
    create_new_file(full, text).map_err(|e| match e.kind() {
        io::ErrorKind::AlreadyExists => FileError::Exists {
            path: path.as_str().to_string(),
        },
        _ => io_error(path, &e),
    })?;
    written_stamp(path, full)
}

/// 같은 디렉토리의 임시 파일에 쓰고 `rename`한다. 파일이 없으면 새로 만든다.
fn replace(path: &SqlPath, full: &Path, text: &str) -> Result<FileStamp, FileError> {
    write_atomically(full, text, Missing::Create).map_err(|e| io_error(path, &e))?;
    written_stamp(path, full)
}

/// 방금 쓴 파일의 stamp.
fn written_stamp(path: &SqlPath, full: &Path) -> Result<FileStamp, FileError> {
    let meta = fs::metadata(full).map_err(|e| io_error(path, &e))?;
    Ok(stamp(&meta))
}

fn stamp(meta: &fs::Metadata) -> FileStamp {
    let nanos = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_nanos());
    FileStamp(format!("{nanos}-{}", meta.len()))
}

fn io_error(path: &SqlPath, e: &io::Error) -> FileError {
    match e.kind() {
        io::ErrorKind::NotFound => FileError::NotFound {
            path: path.as_str().to_string(),
        },
        _ => FileError::Io {
            path: path.as_str().to_string(),
            message: e.to_string(),
        },
    }
}

fn too_large(path: &SqlPath, bytes: u64) -> FileError {
    FileError::TooLarge {
        path: path.as_str().to_string(),
        bytes,
    }
}
