//! `tokio-postgres`로 연결하는 [`Connector`].
//!
//! TCP 연결과 TLS handshake를 직접 하고 그 stream을 [`TxTap`]으로 감싼 뒤 `connect_raw`에
//! 넘긴다. `tokio-postgres`가 socket을 직접 열면 서버가 보내는 byte를 볼 수 없어 트랜잭션
//! 상태를 알 수 없다. 이 때문에 SCRAM channel binding은 쓰지 않는다.

mod cancel;
mod rows;
mod tls;
mod tx_tap;

use std::error::Error as _;
use std::time::Duration;

use socket2::{SockRef, TcpKeepalive};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use tokio_postgres::error::SqlState;
use tokio_postgres::{Client, Config, NoTls, SimpleQueryMessage};

use crate::application::{ConnectError, Connector, DbConnection, QueryError};
use crate::domain::{ConnectionProfile, Password, SslMode, TxStatus};
pub use cancel::PgCancel;
pub use rows::PgRows;
use tls::Verification;
use tx_tap::{TxStatusCell, TxTap};

const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// `close`가 driver task를 기다리는 시간. 실행 중인 쿼리가 있으면 driver는 쿼리가 끝나야
/// 끝나므로, 그 전에 `abort`해서 socket을 닫는다.
const CLOSE_GRACE: Duration = Duration::from_secs(1);
// 30초 조용하면 10초 간격으로 3번 확인한다. 응답이 없는 연결은 1분쯤 뒤에 끊긴 것으로 드러난다.
const KEEPALIVE_IDLE: Duration = Duration::from_secs(30);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(10);
const KEEPALIVE_RETRIES: u32 = 3;
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
        let connection = establish(profile, password, self.connect_timeout);
        tokio::time::timeout(self.connect_timeout, connection)
            .await
            .unwrap_or(Err(ConnectError::Timeout))
    }
}

async fn establish(
    profile: &ConnectionProfile,
    password: Option<&Password>,
    connect_timeout: Duration,
) -> Result<PgConnection, ConnectError> {
    let tcp = open_tcp(profile).await?;
    let Some(verification) = verification(profile) else {
        return start(tcp, profile, password, connect_timeout).await;
    };
    let tls = tls::negotiate(tcp, &profile.host, verification).await?;
    start(tls, profile, password, connect_timeout).await
}

async fn open_tcp(profile: &ConnectionProfile) -> Result<TcpStream, ConnectError> {
    let tcp = TcpStream::connect((profile.host.as_str(), profile.port))
        .await
        .map_err(unreachable)?;
    configure_socket(&tcp).map_err(unreachable)?;
    Ok(tcp)
}

/// 서버 인증서를 어떻게 확인할지. TLS를 쓰지 않으면 `None`이다.
fn verification(profile: &ConnectionProfile) -> Option<Verification<'_>> {
    match (profile.sslmode, &profile.sslrootcert) {
        (SslMode::Disable, _) => None,
        (SslMode::Require, _) => Some(Verification::None),
        (SslMode::VerifyFull, Some(path)) => Some(Verification::RootsFrom(path)),
        (SslMode::VerifyFull, None) => Some(Verification::Platform),
    }
}

/// socket을 직접 열기 때문에 tokio-postgres가 해 주던 설정을 여기서 한다.
///
/// keepalive가 없으면 FIN 없이 죽은 연결(sleep 뒤 복귀, VPN 끊김, NAT timeout)을 읽는 쪽이
/// 영영 모른다. 세션이 `Lost`로 바뀌지 않고 다음 쿼리가 몇 분씩 멈춘다.
fn configure_socket(tcp: &TcpStream) -> std::io::Result<()> {
    tcp.set_nodelay(true)?;
    let keepalive = TcpKeepalive::new()
        .with_time(KEEPALIVE_IDLE)
        .with_interval(KEEPALIVE_INTERVAL)
        .with_retries(KEEPALIVE_RETRIES);
    SockRef::from(tcp).set_tcp_keepalive(&keepalive)
}

/// 이미 열린(필요하면 암호화까지 끝난) stream 위에서 PostgreSQL 세션을 시작한다.
async fn start<S>(
    stream: S,
    profile: &ConnectionProfile,
    password: Option<&Password>,
    connect_timeout: Duration,
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
    let backend_pid = backend_pid(&client).await?;

    Ok(PgConnection {
        client,
        driver,
        tx_status,
        backend_pid,
        profile: profile.clone(),
        connect_timeout,
    })
}

/// simple query로 묻는다. `query_one`은 prepare 때문에 round trip이 한 번 더 든다.
async fn backend_pid(client: &Client) -> Result<i32, ConnectError> {
    let messages = client
        .simple_query("SELECT pg_backend_pid()")
        .await
        .map_err(connect_error)?;
    messages
        .iter()
        .find_map(|message| match message {
            SimpleQueryMessage::Row(row) => row.get(0)?.parse().ok(),
            _ => None,
        })
        .ok_or_else(|| ConnectError::Other {
            message: "서버가 backend pid를 돌려주지 않았습니다".into(),
        })
}

pub struct PgConnection {
    client: Client,
    /// socket을 읽고 쓰는 task. `client`가 drop되면 Terminate를 보내고 끝난다.
    driver: JoinHandle<()>,
    tx_status: TxStatusCell,
    backend_pid: i32,
    /// cancel 요청을 같은 서버로 같은 방법으로 보내려고 갖는다.
    profile: ConnectionProfile,
    connect_timeout: Duration,
}

impl DbConnection for PgConnection {
    type Rows = PgRows;
    type Cancel = PgCancel;

    fn backend_pid(&self) -> i32 {
        self.backend_pid
    }

    async fn tx_status(&self) -> TxStatus {
        self.tx_status.settled().await
    }

    fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    async fn start_query(&self, sql: &str) -> Result<PgRows, QueryError> {
        match self.client.simple_query_raw(sql).await {
            Ok(stream) => Ok(PgRows::new(stream)),
            Err(error) => Err(QueryError::ConnectionLost {
                message: error_message(&error),
            }),
        }
    }

    fn cancel_handle(&self) -> PgCancel {
        PgCancel {
            token: self.client.cancel_token(),
            profile: self.profile.clone(),
            timeout: self.connect_timeout,
        }
    }

    async fn close(self) {
        let PgConnection {
            client, mut driver, ..
        } = self;
        drop(client);
        if tokio::time::timeout(CLOSE_GRACE, &mut driver)
            .await
            .is_err()
        {
            driver.abort();
        }
    }
}

fn unreachable(error: std::io::Error) -> ConnectError {
    ConnectError::Unreachable {
        message: error.to_string(),
    }
}

fn connect_error(error: tokio_postgres::Error) -> ConnectError {
    if let Some(db) = error.as_db_error() {
        let message = db.message().to_string();
        let auth_failed = [
            SqlState::INVALID_PASSWORD,
            SqlState::INVALID_AUTHORIZATION_SPECIFICATION,
        ]
        .contains(db.code());
        return if auth_failed {
            ConnectError::AuthFailed { message }
        } else {
            ConnectError::Database {
                code: db.code().code().to_string(),
                message,
            }
        };
    }
    let message = error_message(&error);
    // tokio-postgres는 오류 종류를 공개하지 않는다. 서버가 비밀번호를 요구하는데 없을 때의
    // 문구로 판별하고, tests/connect.rs의 missing_password_is_password_required가 이를 고정한다.
    if message.contains("password missing") {
        ConnectError::PasswordRequired
    } else {
        ConnectError::Other { message }
    }
}

/// `tokio-postgres`의 오류는 원인(io 오류 등)을 `source`에만 담는다.
fn error_message(error: &tokio_postgres::Error) -> String {
    match error.source() {
        Some(source) => format!("{error}: {source}"),
        None => error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::{CancelError, QueryCancel};

    /// test DB (`scripts/test-db.sh up`). private인 `client`로 SQL을 보내야 해서 이 test만
    /// `tests/`가 아니라 여기 있다.
    fn local_profile() -> ConnectionProfile {
        ConnectionProfile {
            host: "127.0.0.1".into(),
            port: 54318,
            database: "chilla_test".into(),
            user: "chilla".into(),
            ..ConnectionProfile::fixture("local")
        }
    }

    /// FIN 없이 죽은 연결(sleep 뒤 복귀, VPN 끊김)은 keepalive가 있어야 끊긴 줄 안다.
    #[tokio::test]
    async fn sockets_probe_idle_connections() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tcp = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();

        configure_socket(&tcp).unwrap();

        let socket = socket2::SockRef::from(&tcp);
        assert!(tcp.nodelay().unwrap());
        assert!(socket.keepalive().unwrap());
        assert_eq!(socket.tcp_keepalive_time().unwrap(), KEEPALIVE_IDLE);
        assert_eq!(socket.tcp_keepalive_interval().unwrap(), KEEPALIVE_INTERVAL);
        assert_eq!(socket.tcp_keepalive_retries().unwrap(), KEEPALIVE_RETRIES);
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

    #[tokio::test]
    async fn cancel_to_an_unreachable_server_is_an_error() {
        let conn = PgConnector::new()
            .connect(&local_profile(), Some(&Password::new("chilla".into())))
            .await
            .expect("scripts/test-db.sh up 을 먼저 실행하세요");
        let mut cancel = conn.cancel_handle();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        cancel.profile.port = listener.local_addr().unwrap().port();
        drop(listener);

        let result = cancel.cancel().await;

        assert!(matches!(result, Err(CancelError { .. })), "{result:?}");
        conn.close().await;
    }
}
