/// 프로젝트 디렉토리 기준의 `.sql` 파일 경로. `/`로 나눈 상대 경로다.
///
/// 문자열만 보고 판단한다. 디스크의 symlink까지 막는 것은 파일을 여는 쪽의 일이다.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct SqlPath(String);

impl SqlPath {
    pub fn parse(value: &str) -> Result<Self, SqlPathError> {
        if value.is_empty() {
            return Err(SqlPathError::Empty);
        }
        if value.starts_with('/') {
            return Err(SqlPathError::Absolute);
        }
        for component in value.split('/') {
            if component.is_empty()
                || component.starts_with('.')
                || component.contains(['\\', '\0'])
            {
                return Err(SqlPathError::Component {
                    component: component.to_string(),
                });
            }
        }
        if !has_sql_extension(value) {
            return Err(SqlPathError::NotSql);
        }
        Ok(SqlPath(value.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 대소문자 구분 없이 `.sql`로 끝나는지.
fn has_sql_extension(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() >= 4 && bytes[bytes.len() - 4..].eq_ignore_ascii_case(b".sql")
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SqlPathError {
    #[error("File path is empty")]
    Empty,
    #[error("Path must be relative to the project directory")]
    Absolute,
    #[error("Path cannot contain '{component}'")]
    Component { component: String },
    #[error("File name must end with .sql")]
    NotSql,
}

/// 디스크에 있는 파일의 상태. 화면은 뜻을 모르고 저장할 때 그대로 돌려준다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStamp(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlFile {
    pub text: String,
    pub stamp: FileStamp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteMode {
    /// 새 파일. 이미 있으면 쓰지 않는다.
    Create,
    /// 연 파일. 디스크의 파일이 `expected`와 다르면 쓰지 않는다.
    Replace { expected: FileStamp },
    /// 묻고 난 뒤. 있든 없든 쓴다.
    Overwrite,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_relative_sql_paths() {
        for value in [
            "scratch.sql",
            "queries/users.sql",
            "queries/billing/refunds.SQL",
            "a b/한글.sql",
        ] {
            let path = SqlPath::parse(value).unwrap();
            assert_eq!(path.as_str(), value);
        }
    }

    #[test]
    fn parse_rejects_paths_that_leave_the_project() {
        assert_eq!(SqlPath::parse(""), Err(SqlPathError::Empty));
        assert_eq!(SqlPath::parse("/etc/x.sql"), Err(SqlPathError::Absolute));
        for value in [
            "../x.sql",
            "a/../x.sql",
            "./x.sql",
            "a//x.sql",
            ".git/x.sql",
            "a/.hidden.sql",
            "a\\x.sql",
            "a\0.sql",
            ".sql",
            "a/.sql",
        ] {
            assert!(
                matches!(SqlPath::parse(value), Err(SqlPathError::Component { .. })),
                "{value:?}"
            );
        }
        for value in ["notes.txt", "queries", "a/b"] {
            assert_eq!(
                SqlPath::parse(value),
                Err(SqlPathError::NotSql),
                "{value:?}"
            );
        }
    }
}
