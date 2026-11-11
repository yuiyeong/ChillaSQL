use std::path::PathBuf;
use std::str::FromStr;

/// `chilla.toml`의 `sslmode`. 조용히 평문으로 내려가는 `prefer`는 두지 않는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SslMode {
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
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "disable" => Ok(SslMode::Disable),
            "require" => Ok(SslMode::Require),
            "verify-full" => Ok(SslMode::VerifyFull),
            _ => Err(()),
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
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    type Setter = fn(&mut ConnectionProfile, String);

    fn local() -> ConnectionProfile {
        ConnectionProfile {
            name: "local".into(),
            host: "localhost".into(),
            port: 5432,
            database: "app".into(),
            user: "postgres".into(),
            sslmode: SslMode::Disable,
            sslrootcert: None,
            tunnel: None,
            color: Some("green".into()),
        }
    }

    #[test]
    fn sslmode_round_trips() {
        for s in ["disable", "require", "verify-full"] {
            assert_eq!(s.parse::<SslMode>().unwrap().as_str(), s);
        }
        assert!("prefer".parse::<SslMode>().is_err());
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
