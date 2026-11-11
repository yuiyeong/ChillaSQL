use std::path::{Path, PathBuf};
use std::str::FromStr;

/// `chilla.toml`의 `sslmode`. 조용히 평문으로 내려가는 `prefer`는 두지 않는다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SslMode {
    #[default]
    Disable,
    /// 암호화만 하고 서버 인증서는 확인하지 않는다.
    Require,
    /// 서버 인증서와 host 이름까지 확인한다.
    VerifyFull,
}

impl SslMode {
    pub fn as_str(self) -> &'static str {
        match self {
            SslMode::Disable => "disable",
            SslMode::Require => "require",
            SslMode::VerifyFull => "verify-full",
        }
    }
}

impl FromStr for SslMode {
    type Err = ProfileError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "disable" => Ok(SslMode::Disable),
            "require" => Ok(SslMode::Require),
            "verify-full" => Ok(SslMode::VerifyFull),
            _ => Err(ProfileError::UnknownSslMode {
                value: s.to_string(),
            }),
        }
    }
}

/// 접속 정보. 비밀번호는 여기 없고 키체인에만 있다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionProfile {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub sslmode: SslMode,
    /// `verify-full`에서 신뢰할 CA의 PEM 파일. 절대 경로.
    pub sslrootcert: Option<PathBuf>,
    pub tunnel: Option<String>,
    pub color: Option<String>,
}

impl ConnectionProfile {
    pub const DEFAULT_PORT: u16 = 5432;

    pub fn validate(&self) -> Result<(), ProfileError> {
        let required = [
            ("name", &self.name),
            ("host", &self.host),
            ("database", &self.database),
            ("user", &self.user),
        ];
        for (field, value) in required {
            if value.trim().is_empty() {
                return Err(ProfileError::EmptyField { field });
            }
        }
        if self.port == 0 {
            return Err(ProfileError::ZeroPort);
        }
        if self.sslrootcert.is_some() && self.sslmode != SslMode::VerifyFull {
            return Err(ProfileError::RootCertWithoutVerifyFull);
        }
        Ok(())
    }

    /// 상대 경로인 `sslrootcert`를 프로젝트 디렉토리 기준의 절대 경로로 바꾼다. `chilla.toml`에
    /// 쓰인 값도, 화면이 보낸 값도 이 함수를 거쳐야 같은 파일을 가리킨다.
    pub fn resolved_under(mut self, project_dir: &Path) -> Self {
        // `join`은 절대 경로를 받으면 그 경로를 그대로 돌려준다.
        self.sslrootcert = self.sslrootcert.map(|path| project_dir.join(path));
        self
    }

    /// 같은 서버에 같은 방법으로 같은 사용자로 붙는가. 저장된 비밀번호를 이 접속 정보에
    /// 써도 되는지 가릴 때 쓴다. 색처럼 연결과 무관한 항목은 보지 않는다.
    pub fn same_target(&self, other: &ConnectionProfile) -> bool {
        let ConnectionProfile {
            name,
            host,
            port,
            database,
            user,
            sslmode,
            sslrootcert,
            tunnel,
            color: _,
        } = self;
        *name == other.name
            && *host == other.host
            && *port == other.port
            && *database == other.database
            && *user == other.user
            && *sslmode == other.sslmode
            && *sslrootcert == other.sslrootcert
            && *tunnel == other.tunnel
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProfileError {
    #[error("{field}가 비어 있습니다")]
    EmptyField { field: &'static str },
    #[error("port는 1 이상이어야 합니다")]
    ZeroPort,
    #[error("sslrootcert는 sslmode가 verify-full일 때만 쓸 수 있습니다")]
    RootCertWithoutVerifyFull,
    #[error("sslmode '{value}'는 쓸 수 없습니다. disable, require, verify-full 중 하나여야 합니다")]
    UnknownSslMode { value: String },
}

#[cfg(test)]
impl ConnectionProfile {
    /// test용 접속 정보. 기획서 5장의 `local` 접속과 같은 값이다.
    pub(crate) fn fixture(name: &str) -> Self {
        Self {
            name: name.into(),
            host: "localhost".into(),
            port: Self::DEFAULT_PORT,
            database: "app".into(),
            user: "postgres".into(),
            sslmode: SslMode::Disable,
            sslrootcert: None,
            tunnel: None,
            color: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Setter = fn(&mut ConnectionProfile, String);

    fn local() -> ConnectionProfile {
        ConnectionProfile::fixture("local")
    }

    #[test]
    fn sslmode_round_trips() {
        for s in ["disable", "require", "verify-full"] {
            assert_eq!(s.parse::<SslMode>().unwrap().as_str(), s);
        }
        assert_eq!(
            "prefer".parse::<SslMode>(),
            Err(ProfileError::UnknownSslMode {
                value: "prefer".into()
            })
        );
        assert_eq!(SslMode::default(), SslMode::Disable);
    }

    #[test]
    fn validate_accepts_the_spec_local_connection() {
        assert_eq!(local().validate(), Ok(()));
    }

    #[test]
    fn validate_rejects_empty_fields() {
        for blank in ["", "  "] {
            let cases: [(&'static str, Setter); 4] = [
                ("name", |p, v| p.name = v),
                ("host", |p, v| p.host = v),
                ("database", |p, v| p.database = v),
                ("user", |p, v| p.user = v),
            ];
            for (field, set) in cases {
                let mut profile = local();
                set(&mut profile, blank.to_string());
                assert_eq!(profile.validate(), Err(ProfileError::EmptyField { field }));
            }
        }
    }

    #[test]
    fn resolved_under_makes_a_relative_root_cert_absolute() {
        let with_cert = |path: &str| ConnectionProfile {
            sslmode: SslMode::VerifyFull,
            sslrootcert: Some(PathBuf::from(path)),
            ..local()
        };
        let dir = Path::new("/p");
        assert_eq!(
            with_cert("certs/ca.pem").resolved_under(dir).sslrootcert,
            Some(PathBuf::from("/p/certs/ca.pem"))
        );
        assert_eq!(
            with_cert("/etc/ca.pem").resolved_under(dir).sslrootcert,
            Some(PathBuf::from("/etc/ca.pem"))
        );
        assert_eq!(local().resolved_under(dir).sslrootcert, None);
    }

    #[test]
    fn same_target_ignores_only_the_color() {
        let saved = local();
        assert!(saved.same_target(&ConnectionProfile {
            color: Some("red".into()),
            ..local()
        }));
        let different: [ConnectionProfile; 8] = [
            ConnectionProfile {
                name: "other".into(),
                ..local()
            },
            ConnectionProfile {
                host: "evil.example".into(),
                ..local()
            },
            ConnectionProfile {
                port: 6543,
                ..local()
            },
            ConnectionProfile {
                database: "other".into(),
                ..local()
            },
            ConnectionProfile {
                user: "other".into(),
                ..local()
            },
            ConnectionProfile {
                sslmode: SslMode::Require,
                ..local()
            },
            ConnectionProfile {
                sslrootcert: Some("/ca.pem".into()),
                ..local()
            },
            ConnectionProfile {
                tunnel: Some("ssh -L".into()),
                ..local()
            },
        ];
        for other in different {
            assert!(!saved.same_target(&other), "{other:?}");
        }
    }

    #[test]
    fn validate_rejects_port_zero() {
        let profile = ConnectionProfile { port: 0, ..local() };
        assert_eq!(profile.validate(), Err(ProfileError::ZeroPort));
    }

    #[test]
    fn validate_rejects_root_cert_without_verify_full() {
        for sslmode in [SslMode::Disable, SslMode::Require] {
            let profile = ConnectionProfile {
                sslmode,
                sslrootcert: Some(PathBuf::from("/ca.pem")),
                ..local()
            };
            assert_eq!(
                profile.validate(),
                Err(ProfileError::RootCertWithoutVerifyFull)
            );
        }
        let profile = ConnectionProfile {
            sslmode: SslMode::VerifyFull,
            sslrootcert: Some(PathBuf::from("/ca.pem")),
            ..local()
        };
        assert_eq!(profile.validate(), Ok(()));
    }
}
