//! `tokio-postgres`로 연결하는 [`Connector`].
//!
//! TCP 연결과 TLS handshake를 직접 하고 그 stream을 [`TxTap`]으로 감싼 뒤 `connect_raw`에
//! 넘긴다. `tokio-postgres`가 socket을 직접 열면 서버가 보내는 byte를 볼 수 없어 트랜잭션
//! 상태를 알 수 없다. 이 때문에 SCRAM channel binding은 쓰지 않는다.

mod cancel;
mod catalog;
mod rows;
mod tls;
mod tx_tap;

use std::error::Error as _;
use std::net::SocketAddr;
use std::time::Duration;

use socket2::{SockRef, TcpKeepalive};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpStream, ToSocketAddrs};
use tokio::task::JoinHandle;
use tokio_postgres::error::SqlState;
use tokio_postgres::{Client, Config, NoTls, SimpleQueryMessage};

use crate::application::{ConnectError, Connector, DbConnection, QueryError};
use crate::domain::{
    Catalog, ConnectionProfile, Password, SslMode, TableDetails, TxStatus, TypeInfo,
};
pub use cancel::PgCancel;
pub use rows::PgRows;
use tls::Verification;
use tx_tap::{RowTypes, TxStatusCell, TxTap};

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
    /// 세션의 `TimeZone`으로 보낼 Mac의 time zone(IANA 이름). 알 수 없으면 서버 기본값을 쓴다.
    time_zone: Option<String>,
}

impl PgConnector {
    pub fn new() -> Self {
        Self::with_connect_timeout(DEFAULT_CONNECT_TIMEOUT)
    }

    /// `timeout`은 TCP 연결부터 인증이 끝날 때까지 전체에 걸린다.
    pub fn with_connect_timeout(timeout: Duration) -> Self {
        Self {
            connect_timeout: timeout,
            time_zone: iana_time_zone::get_timezone()
                .ok()
                .filter(|zone| is_safe_option_value(zone)),
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
        let connection = establish(profile, password, self);
        tokio::time::timeout(self.connect_timeout, connection)
            .await
            .unwrap_or(Err(ConnectError::Timeout))
    }
}

async fn establish(
    profile: &ConnectionProfile,
    password: Option<&Password>,
    connector: &PgConnector,
) -> Result<PgConnection, ConnectError> {
    let tcp = open_tcp((profile.host.as_str(), profile.port)).await?;
    let server = tcp.peer_addr().map_err(unreachable)?;
    let Some(verification) = verification(profile) else {
        return start(tcp, profile, server, password, connector).await;
    };
    let tls = tls::negotiate(tcp, &profile.host, verification).await?;
    start(tls, profile, server, password, connector).await
}

async fn open_tcp(addr: impl ToSocketAddrs) -> Result<TcpStream, ConnectError> {
    let tcp = TcpStream::connect(addr).await.map_err(unreachable)?;
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
///
/// `server`는 `stream`이 연결된 서버의 주소다.
async fn start<S>(
    stream: S,
    profile: &ConnectionProfile,
    server: SocketAddr,
    password: Option<&Password>,
    connector: &PgConnector,
) -> Result<PgConnection, ConnectError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (tap, tx_status, row_types) = TxTap::new(stream);

    let mut config = Config::new();
    config
        .user(&profile.user)
        .dbname(&profile.database)
        .application_name(APPLICATION_NAME)
        // 암호화는 이 함수에 오기 전에 끝난다. tokio-postgres는 SSL을 협상하지 않는다.
        .ssl_mode(tokio_postgres::config::SslMode::Disable);
    if let Some(options) = startup_options(profile, connector.time_zone.as_deref()) {
        config.options(&options);
    }
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
    let (backend_pid, server_version) = handshake_info(&client).await?;

    Ok(PgConnection {
        client,
        driver,
        tx_status,
        row_types,
        backend_pid,
        server_version,
        profile: profile.clone(),
        server,
        connect_timeout: connector.connect_timeout,
    })
}

/// 세션을 열 때 서버에 보내는 `options`. 보낼 것이 없으면 `None`이다.
///
/// `read_only`는 `default_transaction_read_only`로 건다. 서버가 쓰기를 거절하고(SQLSTATE
/// `25006`) 임시 테이블도 만들 수 없다.
fn startup_options(profile: &ConnectionProfile, time_zone: Option<&str>) -> Option<String> {
    let mut options = Vec::new();
    if profile.read_only {
        options.push("-c default_transaction_read_only=on".to_string());
    }
    if let Some(timeout) = profile.statement_timeout {
        options.push(format!("-c statement_timeout={}", timeout.as_millis()));
    }
    if let Some(zone) = time_zone.filter(|zone| is_safe_option_value(zone)) {
        options.push(format!("-c TimeZone={zone}"));
    }
    (!options.is_empty()).then(|| options.join(" "))
}

/// `options`는 공백으로 나뉘고 `\`로 escape하므로 그런 글자가 든 값은 보내지 않는다.
fn is_safe_option_value(value: &str) -> bool {
    !value.is_empty()
        && !value
            .chars()
            .any(|c| c.is_whitespace() || c == '\'' || c == '\\')
}

/// backend pid와 `server_version`의 첫 단어를 simple query 하나로 묻는다. `query_one`은
/// prepare 때문에 round trip이 한 번 더 든다.
async fn handshake_info(client: &Client) -> Result<(i32, String), ConnectError> {
    let messages = client
        .simple_query("SELECT pg_backend_pid(), current_setting('server_version')")
        .await
        .map_err(connect_error)?;
    messages
        .iter()
        .find_map(|message| match message {
            SimpleQueryMessage::Row(row) => {
                let pid = row.get(0)?.parse().ok()?;
                let version = row.get(1)?.split_whitespace().next()?.to_string();
                Some((pid, version))
            }
            _ => None,
        })
        .ok_or_else(|| ConnectError::Other {
            message: "The server did not return a backend pid and version".into(),
        })
}

pub struct PgConnection {
    client: Client,
    /// socket을 읽고 쓰는 task. `client`가 drop되면 Terminate를 보내고 끝난다.
    driver: JoinHandle<()>,
    tx_status: TxStatusCell,
    /// 서버가 보낸 RowDescription의 type. `PgRows`가 꺼낸다. catalog 읽기는 꺼내지 않으므로
    /// 읽기마다 비운다.
    row_types: RowTypes,
    backend_pid: i32,
    /// `server_version`의 첫 단어("18.6").
    server_version: String,
    /// cancel 요청을 같은 방법(TLS 여부, 인증서 확인)으로 보내려고 갖는다.
    profile: ConnectionProfile,
    /// 연결한 서버의 주소. cancel 요청은 host 이름을 다시 찾지 않고 이 주소로 보낸다.
    /// DNS round robin이나 load balancer 뒤에서는 다시 찾은 주소가 다른 서버일 수 있고,
    /// 그 서버는 cancel을 말없이 무시한다.
    server: SocketAddr,
    connect_timeout: Duration,
}

impl DbConnection for PgConnection {
    type Rows = PgRows;
    type Cancel = PgCancel;

    fn backend_pid(&self) -> i32 {
        self.backend_pid
    }

    fn server_version(&self) -> &str {
        &self.server_version
    }

    async fn tx_status(&self) -> TxStatus {
        self.tx_status.settled().await
    }

    fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    async fn start_query(&self, sql: &str) -> Result<PgRows, QueryError> {
        // 앞선 쿼리(연결할 때의 `pg_backend_pid()` 포함)가 남긴 type을 버린다.
        self.row_types.clear();
        // 서버의 응답을 기다리지 않으므로 오류는 보내기 전의 것(끊긴 연결, NUL이 든 text 등)뿐이다.
        let stream = self
            .client
            .simple_query_raw(sql)
            .await
            .map_err(query_error)?;
        Ok(PgRows::new(
            stream,
            self.driver.abort_handle(),
            self.row_types.clone(),
        ))
    }

    async fn simple_execute(&self, sql: &str) -> Result<(), QueryError> {
        self.client.batch_execute(sql).await.map_err(query_error)
    }

    async fn read_catalog(&self) -> Result<Catalog, QueryError> {
        self.row_types.clear();
        catalog::read_catalog(&self.client).await
    }

    async fn read_table_details(&self, relation: u32) -> Result<TableDetails, QueryError> {
        self.row_types.clear();
        catalog::read_table_details(&self.client, relation).await
    }

    async fn describe_types(&self, types: &[(u32, i32)]) -> Result<Vec<TypeInfo>, QueryError> {
        self.row_types.clear();
        catalog::describe_types(&self.client, types).await
    }

    fn cancel_handle(&self) -> PgCancel {
        PgCancel {
            token: self.client.cancel_token(),
            profile: self.profile.clone(),
            addr: self.server,
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
/// 서버가 거절했으면 `Server`, 연결이 끊겼으면 `ConnectionLost`, 그 밖에는 연결을 그대로 쓸 수 있는
/// `Client`다.
fn query_error(error: tokio_postgres::Error) -> QueryError {
    match error.as_db_error() {
        Some(db) => QueryError::Server(rows::server_error(db)),
        None if error.is_closed() => QueryError::ConnectionLost {
            message: error_message(&error),
        },
        None => QueryError::Client {
            message: error_message(&error),
        },
    }
}

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

    async fn connect() -> PgConnection {
        PgConnector::new()
            .connect(&local_profile(), Some(&Password::new("chilla".into())))
            .await
            .expect("scripts/test-db.sh up 을 먼저 실행하세요")
    }

    fn profile() -> ConnectionProfile {
        ConnectionProfile::fixture("local")
    }

    #[test]
    fn startup_options_are_sent_only_when_set() {
        assert_eq!(startup_options(&profile(), None), None);
        assert_eq!(
            startup_options(&profile(), Some("Asia/Seoul")).as_deref(),
            Some("-c TimeZone=Asia/Seoul")
        );
        let all = ConnectionProfile {
            read_only: true,
            statement_timeout: Some(Duration::from_secs(30)),
            ..profile()
        };
        assert_eq!(
            startup_options(&all, Some("UTC")).as_deref(),
            Some("-c default_transaction_read_only=on -c statement_timeout=30000 -c TimeZone=UTC")
        );
    }

    #[test]
    fn unsafe_time_zone_names_are_not_sent() {
        for zone in ["", "Asia/Seoul KST", "A'B", "A\\B"] {
            assert_eq!(startup_options(&profile(), Some(zone)), None, "{zone:?}");
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

    /// catalog 읽기도 RowDescription을 tap에 쌓는데 catalog connection은 꺼내 가지 않는다.
    /// 읽기마다 비우지 않으면 queue가 끝없이 자란다.
    #[tokio::test]
    async fn catalog_reads_do_not_pile_up_row_types() {
        let conn = connect().await;

        for _ in 0..3 {
            conn.describe_types(&[(23, -1)]).await.unwrap();
        }
        conn.read_table_details(0).await.unwrap();
        conn.describe_types(&[(23, -1)]).await.unwrap();

        // 마지막 읽기(쿼리 하나)가 쌓은 것뿐이다.
        assert!(conn.row_types.pop().is_some());
        assert!(conn.row_types.pop().is_none());
        conn.close().await;
    }

    #[tokio::test]
    async fn tx_status_follows_the_server() {
        let conn = connect().await;

        conn.client.batch_execute("BEGIN").await.unwrap();
        assert_eq!(conn.tx_status().await, TxStatus::InTransaction);
        assert!(conn.client.batch_execute("SELECT 1/0").await.is_err());
        assert_eq!(conn.tx_status().await, TxStatus::Failed);
        conn.client.batch_execute("ROLLBACK").await.unwrap();
        assert_eq!(conn.tx_status().await, TxStatus::Idle);
    }

    #[tokio::test]
    async fn cancel_to_an_unreachable_server_is_an_error() {
        let conn = connect().await;
        let mut cancel = conn.cancel_handle();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        cancel.addr = listener.local_addr().unwrap();
        drop(listener);

        let result = cancel.cancel().await;

        assert!(matches!(result, Err(CancelError { .. })), "{result:?}");
        conn.close().await;
    }

    /// 서버가 연결을 닫기 전에 돌아오면 늦게 처리된 cancel이 다음 쿼리에 닿을 수 있다.
    #[tokio::test]
    async fn cancel_returns_only_after_the_server_closes_the_connection() {
        use tokio::io::AsyncReadExt;

        let conn = connect().await;
        let mut cancel = conn.cancel_handle();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        cancel.addr = listener.local_addr().unwrap();
        // host 이름을 다시 찾지 않는다. 찾으면 이 이름에서 실패한다.
        cancel.profile.host = "cancel-must-not-resolve.invalid".into();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 16];
            socket.read_exact(&mut request).await.unwrap();
            tokio::time::sleep(Duration::from_millis(300)).await;
            drop(socket);
        });

        let started = std::time::Instant::now();
        assert_eq!(cancel.cancel().await, Ok(()));
        let elapsed = started.elapsed();

        assert!(elapsed >= Duration::from_millis(300), "{elapsed:?}");
        server.await.unwrap();
        conn.close().await;
    }
}
