//! 결과 행을 내보낸 파일. 화면이 만든 CSV나 JSON text를 저장 dialog가 고른 경로에 쓴다.

use std::io;
use std::path::Path;

use super::atomic_write::{Missing, write_atomically};

/// 같은 디렉토리의 임시 파일에 쓰고 rename한다. 있으면 덮어쓴다(저장 dialog가 이미 물었다).
/// 디렉토리가 없으면 만들지 않고 `NotFound`다.
pub fn write_export(path: &Path, text: &str) -> io::Result<()> {
    write_atomically(path, text, Missing::Create)
}
