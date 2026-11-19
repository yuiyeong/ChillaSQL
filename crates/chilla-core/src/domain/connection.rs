use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::Duration;

use super::tunnel::{DEFAULT_TUNNEL_TIMEOUT, MAX_TUNNEL_TIMEOUT_SECS, TunnelTarget};

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

/// 접속에 붙이는 색. `chilla.toml`의 `color`는 이 다섯 이름만 쓴다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectionColor {
    Green,
    Yellow,
    Red,
    Blue,
    Purple,
}

impl ConnectionColor {
    pub const ALL: [ConnectionColor; 5] = [
        ConnectionColor::Green,
        ConnectionColor::Yellow,
        ConnectionColor::Red,
        ConnectionColor::Blue,
        ConnectionColor::Purple,
    ];

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|color| color.as_str() == name)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ConnectionColor::Green => "green",
            ConnectionColor::Yellow => "yellow",
            ConnectionColor::Red => "red",
            ConnectionColor::Blue => "blue",
            ConnectionColor::Purple => "purple",
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
    /// 터널의 포트가 열리기를 기다리는 시간. 없으면 [`DEFAULT_TUNNEL_TIMEOUT`]이다. `tunnel`이 있을 때만 쓴다.
    pub tunnel_timeout: Option<Duration>,
    pub color: Option<ConnectionColor>,
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
        if self
            .tunnel
            .as_ref()
            .is_some_and(|tunnel| tunnel.trim().is_empty())
        {
            return Err(ProfileError::EmptyField { field: "tunnel" });
        }
        if let Some(timeout) = self.tunnel_timeout {
            if self.tunnel.is_none() {
                return Err(ProfileError::TunnelTimeoutWithoutTunnel);
            }
            let secs = timeout.as_secs();
            if !(1..=MAX_TUNNEL_TIMEOUT_SECS).contains(&secs) {
                return Err(ProfileError::TunnelTimeoutRange { secs });
            }
        }
        Ok(())
    }

    /// 터널 명령이 있으면 그 터널을 띄우는 데 필요한 것. 명령은 `project_dir`에서 실행한다.
    pub fn tunnel_target(&self, project_dir: &Path) -> Option<TunnelTarget> {
        let command = self.tunnel.clone()?;
        Some(TunnelTarget {
            command,
            dir: project_dir.to_path_buf(),
            host: self.host.clone(),
            port: self.port,
            timeout: self.tunnel_timeout.unwrap_or(DEFAULT_TUNNEL_TIMEOUT),
        })
    }

    /// 상대 경로인 `sslrootcert`를 프로젝트 디렉토리 기준의 절대 경로로 바꾼다. `chilla.toml`에
    /// 쓰인 값도, 화면이 보낸 값도 이 함수를 거쳐야 같은 파일을 가리킨다.
    pub fn resolved_under(mut self, project_dir: &Path) -> Self {
        // `join`은 절대 경로를 받으면 그 경로를 그대로 돌려준다.
        self.sslrootcert = self.sslrootcert.map(|path| project_dir.join(path));
        self
    }

    /// 같은 서버에 같은 방법으로 같은 사용자로 붙는가. 저장된 비밀번호를 이 접속 정보에
    /// 써도 되는지 가릴 때 쓴다. 색과 터널 대기 시간처럼 연결 대상과 무관한 항목은 보지 않는다.
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
            tunnel_timeout: _,
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
    #[error("{field} is empty")]
    EmptyField { field: &'static str },
    #[error("port must be 1 or greater")]
    ZeroPort,
    #[error("sslrootcert can only be used with sslmode verify-full")]
    RootCertWithoutVerifyFull,
    #[error("sslmode '{value}' is not supported. Use disable, require or verify-full")]
    UnknownSslMode { value: String },
    #[error("color must be green, yellow, red, blue or purple, not '{value}'")]
    UnknownColor { value: String },
    #[error("tunnel_timeout can only be used with tunnel")]
    TunnelTimeoutWithoutTunnel,
    #[error("tunnel_timeout must be 1 to 300 seconds, not {secs}")]
    TunnelTimeoutRange { secs: u64 },
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
            tunnel_timeout: None,
            color: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::domain::TunnelTarget;

    type Setter = fn(&mut ConnectionProfile, String);

    fn local() -> ConnectionProfile {
        ConnectionProfile::fixture("local")
    }

    #[test]
    fn color_parses_only_the_five_names() {
        for name in ["green", "yellow", "red", "blue", "purple"] {
            assert_eq!(ConnectionColor::parse(name).unwrap().as_str(), name);
        }
        assert_eq!(ConnectionColor::ALL.len(), 5);
        for name in ["orange", "Red", ""] {
            assert_eq!(ConnectionColor::parse(name), None, "{name}");
        }
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
    fn validate_checks_the_tunnel_fields() {
        let tunneled = |timeout: Option<u64>| ConnectionProfile {
            tunnel: Some("ssh -N -L 25432:db.internal:5432 bastion".into()),
            tunnel_timeout: timeout.map(Duration::from_secs),
            ..local()
        };
        assert_eq!(tunneled(None).validate(), Ok(()));
        assert_eq!(tunneled(Some(1)).validate(), Ok(()));
        assert_eq!(tunneled(Some(300)).validate(), Ok(()));
        assert_eq!(
            tunneled(Some(0)).validate(),
            Err(ProfileError::TunnelTimeoutRange { secs: 0 })
        );
        assert_eq!(
            tunneled(Some(301)).validate(),
            Err(ProfileError::TunnelTimeoutRange { secs: 301 })
        );
        let blank = ConnectionProfile {
            tunnel: Some("  ".into()),
            ..local()
        };
        assert_eq!(
            blank.validate(),
            Err(ProfileError::EmptyField { field: "tunnel" })
        );
        let orphan = ConnectionProfile {
            tunnel_timeout: Some(Duration::from_secs(5)),
            ..local()
        };
        assert_eq!(
            orphan.validate(),
            Err(ProfileError::TunnelTimeoutWithoutTunnel)
        );
    }

    #[test]
    fn tunnel_target_uses_the_project_dir_and_the_default_timeout() {
        let dir = Path::new("/p");
        assert_eq!(local().tunnel_target(dir), None);
        let profile = ConnectionProfile {
            tunnel: Some("ssh -L".into()),
            port: 25432,
            ..local()
        };
        assert_eq!(
            profile.tunnel_target(dir),
            Some(TunnelTarget {
                command: "ssh -L".into(),
                dir: PathBuf::from("/p"),
                host: "localhost".into(),
                port: 25432,
                timeout: Duration::from_secs(20),
            })
        );
        let slow = ConnectionProfile {
            tunnel_timeout: Some(Duration::from_secs(45)),
            ..profile
        };
        assert_eq!(
            slow.tunnel_target(dir).map(|t| t.timeout),
            Some(Duration::from_secs(45))
        );
    }

    #[test]
    fn same_target_ignores_the_color_and_tunnel_timeout() {
        let saved = local();
        assert!(saved.same_target(&ConnectionProfile {
            color: Some(ConnectionColor::Red),
            ..local()
        }));
        assert!(saved.same_target(&ConnectionProfile {
            tunnel_timeout: Some(Duration::from_secs(30)),
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
