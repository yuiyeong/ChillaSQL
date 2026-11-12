//! 같은 디렉토리의 임시 파일에 쓰고 `rename`해서, 도중에 멈춰도 쓰다 만 파일이 남지 않게 한다.

use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// 임시 파일 이름의 끝. 이름은 `.`으로 시작해 SQL 파일 목록에 보이지 않는다.
const TEMP_SUFFIX: &str = ".chilla-tmp";
/// 파일 이름 하나의 byte 상한(macOS의 NAME_MAX).
const NAME_MAX: usize = 255;
/// target이 없을 때 새 파일의 권한.
const NEW_FILE_MODE: u32 = 0o644;

/// `write_atomically`의 target이 없을 때.
pub(super) enum Missing {
    /// 새로 만든다.
    Create,
    /// `NotFound`를 돌려준다.
    Error,
}

/// target과 같은 디렉토리의 임시 파일에 쓰고 rename한다.
///
/// target이 있으면 그 권한(예: 0600)으로 임시 파일을 연다. 임시 파일을 만든 뒤에 실패하면
/// 임시 파일을 지운다.
pub(super) fn write_atomically(target: &Path, text: &str, missing: Missing) -> io::Result<()> {
    let mode = match fs::metadata(target) {
        Ok(existing) => existing.permissions().mode() & 0o7777,
        Err(e) if e.kind() == io::ErrorKind::NotFound && matches!(missing, Missing::Create) => {
            NEW_FILE_MODE
        }
        Err(e) => return Err(e),
    };
    let temp = temp_path(target);
    // 남아 있던 임시 파일(clone한 저장소에 심어 둔 symlink일 수도 있다)을 따라가 쓰지 않도록
    // 치우고 `create_new`로 새로 만든다.
    match fs::remove_file(&temp) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&temp)?;
    let result = file
        .write_all(text.as_bytes())
        .and_then(|()| file.sync_all())
        .and_then(|()| fs::rename(&temp, target));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// 새 파일을 만든다. 이미 있으면 `AlreadyExists`. 쓰다 실패하면 만든 파일을 지운다.
pub(super) fn create_new_file(path: &Path, text: &str) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    if let Err(e) = file.write_all(text.as_bytes()) {
        // 반쯤 쓴 새 파일이 남으면 다시 만들 수도 제대로 읽을 수도 없다.
        let _ = fs::remove_file(path);
        return Err(e);
    }
    Ok(())
}

/// `.{target의 파일 이름}.chilla-tmp`. 그 이름이 NAME_MAX를 넘으면 파일 이름의 hash로 줄인다.
fn temp_path(target: &Path) -> PathBuf {
    let name = target.file_name().unwrap_or_default();
    let mut temp = OsString::from(".");
    temp.push(name);
    temp.push(TEMP_SUFFIX);
    if temp.len() > NAME_MAX {
        let mut hasher = DefaultHasher::new();
        name.hash(&mut hasher);
        temp = format!("{TEMP_SUFFIX}-{:x}", hasher.finish()).into();
    }
    target.with_file_name(temp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_target_is_an_error_when_asked() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("chilla.toml");

        let result = write_atomically(&target, "x", Missing::Error);

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::NotFound);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn missing_target_is_created_when_asked() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.sql");

        write_atomically(&target, "x", Missing::Create).unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), "x");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn temp_names_stay_hidden_and_within_name_max() {
        let short = temp_path(Path::new("/d/a.sql"));
        assert_eq!(short, Path::new("/d/.a.sql.chilla-tmp"));

        let long = format!("{}.sql", "a".repeat(251));
        let temp = temp_path(&Path::new("/d").join(&long));
        let name = temp.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with(".chilla-tmp-"), "{name}");
        assert!(name.len() <= NAME_MAX, "{name}");
        assert_eq!(temp.parent(), Some(Path::new("/d")));
    }
}
