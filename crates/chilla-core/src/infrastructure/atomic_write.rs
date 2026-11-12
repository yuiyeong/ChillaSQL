//! 같은 디렉토리의 임시 파일에 쓰고 `rename`해서, 도중에 멈춰도 쓰다 만 파일이 남지 않게 한다.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

/// `text`를 `temp`에 쓰고 `target`으로 `rename`한다. 실패하면 `temp`를 지운다.
///
/// `target`이 있으면 그 권한(예: 0600)을 새 파일에 옮긴다. 없으면 새로 만든다. `target`이 없을 때
/// 이를 오류로 볼지는 부르는 쪽이 정한다.
pub(super) fn write_atomically(target: &Path, temp: &Path, text: &str) -> io::Result<()> {
    let result = write_temp_and_rename(target, temp, text);
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn write_temp_and_rename(target: &Path, temp: &Path, text: &str) -> io::Result<()> {
    // 남아 있던 임시 파일(clone한 저장소에 심어 둔 symlink일 수도 있다)을 따라가 쓰지 않도록
    // 치우고 `create_new`로 새로 만든다.
    match fs::remove_file(temp) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let mut file = OpenOptions::new().write(true).create_new(true).open(temp)?;
    file.write_all(text.as_bytes())?;
    if let Ok(existing) = fs::metadata(target) {
        file.set_permissions(existing.permissions())?;
    }
    drop(file);
    fs::rename(temp, target)
}
