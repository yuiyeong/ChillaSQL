use std::path::PathBuf;

use super::ConnectionProfile;

/// `chilla.toml`이 있는 디렉토리 하나.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    pub dir: PathBuf,
    pub name: String,
    /// 파일에 쓰인 순서.
    pub connections: Vec<ConnectionProfile>,
}

impl Project {
    pub fn connection(&self, name: &str) -> Option<&ConnectionProfile> {
        self.connections.iter().find(|c| c.name == name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_finds_by_name() {
        let profile = ConnectionProfile::fixture("local");
        let project = Project {
            dir: "/p".into(),
            name: "p".into(),
            connections: vec![profile.clone()],
        };
        assert_eq!(project.connection("local"), Some(&profile));
        assert_eq!(project.connection("nope"), None);
    }
}
