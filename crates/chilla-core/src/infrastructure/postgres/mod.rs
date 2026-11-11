//! `tokio-postgres`로 연결하는 [`Connector`].
//!
//! TCP 연결과 TLS handshake를 직접 하고 그 stream을 [`TxTap`]으로 감싼 뒤 `connect_raw`에
//! 넘긴다. `tokio-postgres`가 socket을 직접 열면 서버가 보내는 byte를 볼 수 없어 트랜잭션
//! 상태를 알 수 없다. 이 때문에 SCRAM channel binding은 쓰지 않는다.

mod tls;
mod tx_tap;

use std::error::Error as _;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use tokio_postgres::{Client, Config, NoTls};

use crate::application::{ConnectError, Connector, DbConnection};
use crate::domain::{ConnectionProfile, Password, SslMode, TxStatus};
use tls::Verification;
use tx_tap::{TxStatusCell, TxTap};

const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const APPLICATION_NAME: &str = "ChillaSQL";

pub struct PgConnector {
    connect_timeout: Duration,
}

impl PgConnector {
    pub fn new() -> Self {
        Self::with_connect_timeout(DEFAULT_CONNECT_TIMEOUT)
    }

    /// `timeout`은 TCP 연결부터 인증이 끝날 때까지 전체에 걸린다.
    pub fn with_connect_timeout(timeout: Duration) -> Self {
        Self {
            connect_timeout: timeout,
        }
    }
}

impl Default for PgConnector {
    fn default() -> Self {
        Self::new()
    }
}

impl Connector for PgConnector {
    type Connection = PgConnection;

    async fn connect(
        &self,
        profile: &ConnectionProfile,
        password: Option<&Password>,
    ) -> Result<PgConnection, ConnectError> {
        tokio::time::timeout(self.connect_timeout, establish(profile, password))
            .await
            .unwrap_or(Err(ConnectError::Timeout))
    }
}

async fn establish(
    profile: &ConnectionProfile,
    password: Option<&Password>,
) -> Result<PgConnection, ConnectError> {
    let tcp = TcpStream::connect((profile.host.as_str(), profile.port))
        .await
        .map_err(unreachable)?;
    tcp.set_nodelay(true).map_err(unreachable)?;

    let verification = match (profile.sslmode, &profile.sslrootcert) {
        (SslMode::Disable, _) => return start(tcp, profile, password).await,
        (SslMode::Require, _) => Verification::None,
        (SslMode::VerifyFull, Some(path)) => Verification::RootsFrom(path),
        (SslMode::VerifyFull, None) => Verification::Platform,
    };
    let tls = tls::negotiate(tcp, &profile.host, verification).await?;
    start(tls, profile, password).await
}

/// 이미 열린(필요하면 암호화까지 끝난) stream 위에서 PostgreSQL 세션을 시작한다.
async fn start<S>(
    stream: S,
    profile: &ConnectionProfile,
    password: Option<&Password>,
) -> Result<PgConnection, ConnectError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (tap, tx_status) = TxTap::new(stream);

    let mut config = Config::new();
    config
        .user(&profile.user)
        .dbname(&profile.database)
        .application_name(APPLICATION_NAME)
        // 암호화는 이 함수에 오기 전에 끝난다. tokio-postgres는 SSL을 협상하지 않는다.
        .ssl_mode(tokio_postgres::config::SslMode::Disable);
    if let Some(password) = password {
        config.password(password.expose());
    }

    let (client, connection) = config
        .connect_raw(tap, NoTls)
        .await
        .map_err(connect_error)?;
    let driver = tokio::spawn(async move {
        // 끊긴 이유는 `Client`의 다음 호출이 오류로 알려 준다.
        let _ = connection.await;
    });
    let backend_pid = client
        .query_one("SELECT pg_backend_pid()", &[])
        .await
        .map_err(connect_error)?
        .get(0);

    Ok(PgConnection {
        client,
        driver,
        tx_status,
        backend_pid,
    })
}

pub struct PgConnection {
    client: Client,
    /// socket을 읽고 쓰는 task. `client`가 drop되면 Terminate를 보내고 끝난다.
    driver: JoinHandle<()>,
    tx_status: TxStatusCell,
    backend_pid: i32,
}

impl DbConnection for PgConnection {
    fn backend_pid(&self) -> i32 {
        self.backend_pid
    }

    async fn tx_status(&self) -> TxStatus {
        self.tx_status.settled().await
    }

    fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    async fn close(self) {
        drop(self.client);
        let _ = self.driver.await;
    }
}

fn unreachable(error: std::io::Error) -> ConnectError {
    ConnectError::Unreachable {
        message: error.to_string(),
    }
}

fn connect_error(error: tokio_postgres::Error) -> ConnectError {
    if let Some(db) = error.as_db_error() {
        let code = db.code().code();
        let message = db.message().to_string();
        return match code {
            // invalid_password, invalid_authorization_specification
            "28P01" | "28000" => ConnectError::AuthFailed { message },
            _ => ConnectError::Database {
                code: code.to_string(),
                message,
            },
        };
    }
    let message = match error.source() {
        Some(source) => format!("{error}: {source}"),
        None => error.to_string(),
    };
    // tokio-postgres는 오류 종류를 공개하지 않는다. 서버가 비밀번호를 요구하는데 없을 때의
    // 문구로 판별하고, tests/connect.rs의 missing_password_is_password_required가 이를 고정한다.
    if message.contains("password missing") {
        ConnectError::PasswordRequired
    } else {
        ConnectError::Other { message }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// test DB (`scripts/test-db.sh up`).
    fn local_profile() -> ConnectionProfile {
        ConnectionProfile {
            name: "local".into(),
            host: "127.0.0.1".into(),
            port: 54318,
            database: "chilla_test".into(),
            user: "chilla".into(),
            sslmode: SslMode::Disable,
            sslrootcert: None,
            tunnel: None,
            color: None,
        }
    }

    #[tokio::test]
    async fn tx_status_follows_the_server() {
        let conn = PgConnector::new()
            .connect(&local_profile(), Some(&Password::new("chilla".into())))
            .await
            .expect("scripts/test-db.sh up 을 먼저 실행하세요");

        conn.client.batch_execute("BEGIN").await.unwrap();
        assert_eq!(conn.tx_status().await, TxStatus::InTransaction);
        assert!(conn.client.batch_execute("SELECT 1/0").await.is_err());
        assert_eq!(conn.tx_status().await, TxStatus::Failed);
        conn.client.batch_execute("ROLLBACK").await.unwrap();
        assert_eq!(conn.tx_status().await, TxStatus::Idle);
    }
}
