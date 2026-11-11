//! integration test가 함께 쓰는 것. test DB는 `scripts/test-db.sh up`으로 띄운다.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use chilla_core::application::{ConnectError, Connector};
use chilla_core::domain::{ConnectionProfile, Password, SslMode};
use chilla_core::infrastructure::PgConnector;

pub const TEST_DB_PORT: u16 = 54318;
/// SSL을 켠 test DB. 서버 인증서의 SAN은 `DNS:localhost`뿐이다.
pub const TLS_DB_PORT: u16 = 54319;
// compose.yaml의 POSTGRES_* 값. 두 test DB가 같이 쓴다.
pub const USER: &str = "chilla";
pub const PASSWORD: &str = "chilla";
pub const DATABASE: &str = "chilla_test";

pub fn local_profile() -> ConnectionProfile {
    ConnectionProfile {
        name: "local".into(),
        host: "127.0.0.1".into(),
        port: TEST_DB_PORT,
        database: DATABASE.into(),
        user: USER.into(),
        sslmode: SslMode::Disable,
        sslrootcert: None,
        tunnel: None,
        color: None,
    }
}

/// TLS test DB의 profile. `sslrootcert`는 `db/tls/` 아래의 파일 이름이다.
pub fn tls_profile(host: &str, sslmode: SslMode, sslrootcert: Option<&str>) -> ConnectionProfile {
    ConnectionProfile {
        name: "tls".into(),
        host: host.into(),
        port: TLS_DB_PORT,
        sslmode,
        sslrootcert: sslrootcert.map(tls_file),
        ..local_profile()
    }
}

/// `scripts/test-db.sh`가 만든 `db/tls/<name>`의 절대 경로.
pub fn tls_file(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../db/tls")
        .join(name)
}

pub fn password() -> Password {
    Password::new(PASSWORD.into())
}

/// 확인용 직접 연결. 검사하려는 코드를 거치지 않는다.
pub async fn admin() -> tokio_postgres::Client {
    admin_on(TEST_DB_PORT).await
}

pub async fn tls_admin() -> tokio_postgres::Client {
    admin_on(TLS_DB_PORT).await
}

pub async fn admin_on(port: u16) -> tokio_postgres::Client {
    let config =
        format!("host=127.0.0.1 port={port} user={USER} password={PASSWORD} dbname={DATABASE}");
    let (client, connection) = tokio_postgres::connect(&config, tokio_postgres::NoTls)
        .await
        .unwrap_or_else(|e| {
            panic!(
                "test DB({port})에 접속하지 못했다. scripts/test-db.sh up 을 먼저 실행하세요: {e}"
            )
        });
    tokio::spawn(connection);
    client
}

pub async fn terminate_backend(admin: &tokio_postgres::Client, pid: i32) {
    admin
        .execute("SELECT pg_terminate_backend($1)", &[&pid])
        .await
        .unwrap();
}

/// 연결이 실패해야 하는 경우의 오류.
pub async fn connect_error(
    profile: &ConnectionProfile,
    password: Option<Password>,
) -> ConnectError {
    match PgConnector::new().connect(profile, password.as_ref()).await {
        Ok(_) => panic!("연결되면 안 된다"),
        Err(e) => e,
    }
}

pub async fn backend_exists(admin: &tokio_postgres::Client, pid: i32) -> bool {
    admin
        .query_one(
            "SELECT count(*) FROM pg_stat_activity WHERE pid = $1",
            &[&pid],
        )
        .await
        .unwrap()
        .get::<_, i64>(0)
        == 1
}

/// `check`가 true가 될 때까지 50ms 간격으로 최대 2초 기다린다.
pub async fn eventually(mut check: impl AsyncFnMut() -> bool) -> bool {
    for _ in 0..40 {
        if check().await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    check().await
}
