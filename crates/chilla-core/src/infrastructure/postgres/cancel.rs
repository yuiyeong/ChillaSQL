//! 실행 중인 쿼리를 멈추는 cancel 요청.
//!
//! cancel 요청은 새 연결로 보낸다. 세션이 연결한 서버 주소로 연결할 때와 같은 방법(TCP, 필요하면
//! TLS)으로 stream을 열고 `tokio-postgres`에는 그 stream만 넘긴다. 서버의 응답은 없고, 요청을
//! 처리한 뒤 연결을 닫는다.

use std::net::SocketAddr;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio_postgres::{CancelToken, NoTls};

use super::{error_message, open_tcp, tls, verification};
use crate::application::{CancelError, ConnectError, QueryCancel};
use crate::domain::ConnectionProfile;

pub struct PgCancel {
    pub(super) token: CancelToken,
    /// 연결할 때 쓴 접속 정보. 비밀번호는 없다 (cancel 요청에는 인증이 없다).
    /// TLS의 server name과 인증서 확인에 쓴다.
    pub(super) profile: ConnectionProfile,
    /// 세션이 연결한 서버의 주소. 이 주소로 연결한다.
    pub(super) addr: SocketAddr,
    /// stream을 열 때부터 서버가 연결을 닫을 때까지 전체에 걸린다.
    pub(super) timeout: Duration,
}

impl QueryCancel for PgCancel {
    async fn cancel(self) -> Result<(), CancelError> {
        tokio::time::timeout(self.timeout, self.send())
            .await
            .unwrap_or_else(|_| Err(cancel_error(ConnectError::Timeout)))
    }
}

impl PgCancel {
    async fn send(&self) -> Result<(), CancelError> {
        let tcp = open_tcp(self.addr).await.map_err(cancel_error)?;
        match verification(&self.profile) {
            None => request(tcp, &self.token).await,
            Some(verification) => {
                let tls = tls::negotiate(tcp, &self.profile.host, verification)
                    .await
                    .map_err(cancel_error)?;
                request(tls, &self.token).await
            }
        }
    }
}

/// 요청을 보내고 서버가 연결을 닫을 때까지 읽는다. 닫혔으면 서버가 요청을 처리한 것이다.
/// 그 전에 돌아가면 cancel이 다음 쿼리에 닿을 수 있다.
async fn request<S>(mut stream: S, token: &CancelToken) -> Result<(), CancelError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    token
        .cancel_query_raw(&mut stream, NoTls)
        .await
        .map_err(|e| CancelError {
            message: error_message(&e),
        })?;
    let mut buf = [0u8; 64];
    loop {
        match stream.read(&mut buf).await {
            // TLS stream은 close_notify 없이 닫히면 EOF 대신 오류를 낸다. 둘 다 닫힌 것이다.
            Ok(0) | Err(_) => return Ok(()),
            Ok(_) => {}
        }
    }
}

fn cancel_error(error: ConnectError) -> CancelError {
    CancelError {
        message: error.to_string(),
    }
}
