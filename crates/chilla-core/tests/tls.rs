mod support;

use std::path::Path;

use chilla_core::application::{ConnectError, Connector, DbConnection};
use chilla_core::domain::{ConnectionProfile, SslMode, TxStatus};
use chilla_core::infrastructure::{PgConnection, PgConnector};
use support::{local_profile, password, tls_admin, tls_profile};

async fn connect(profile: &ConnectionProfile) -> Result<PgConnection, ConnectError> {
    PgConnector::new().connect(profile, Some(&password())).await
}

async fn connect_error(profile: &ConnectionProfile) -> ConnectError {
    support::connect_error(profile, Some(password())).await
}

/// 서버가 보기에 그 연결이 암호화돼 있는가.
async fn encrypted(conn: &PgConnection) -> bool {
    tls_admin()
        .await
        .query_one(
            "SELECT ssl FROM pg_stat_ssl WHERE pid = $1",
            &[&conn.backend_pid()],
        )
        .await
        .unwrap()
        .get(0)
}

#[tokio::test]
async fn require_encrypts_without_verifying() {
    // 127.0.0.1은 인증서의 이름과 맞지 않고 CA도 신뢰하지 않지만 require는 확인하지 않는다.
    let conn = connect(&tls_profile("127.0.0.1", SslMode::Require, None))
        .await
        .unwrap();
    assert!(encrypted(&conn).await);
}

#[tokio::test]
async fn verify_full_accepts_the_right_certificate() {
    let conn = connect(&tls_profile(
        "localhost",
        SslMode::VerifyFull,
        Some("ca.crt"),
    ))
    .await
    .unwrap();
    assert!(encrypted(&conn).await);
}

#[tokio::test]
async fn verify_full_rejects_a_hostname_mismatch() {
    let error = connect_error(&tls_profile(
        "127.0.0.1",
        SslMode::VerifyFull,
        Some("ca.crt"),
    ))
    .await;
    assert!(
        matches!(error, ConnectError::Certificate { .. }),
        "{error:?}"
    );
}

#[tokio::test]
async fn verify_full_rejects_an_untrusted_ca() {
    let other_ca = tls_profile("localhost", SslMode::VerifyFull, Some("other-ca.crt"));
    let error = connect_error(&other_ca).await;
    assert!(
        matches!(error, ConnectError::Certificate { .. }),
        "{error:?}"
    );

    // sslrootcert가 없으면 macOS의 trust store로 확인한다. test CA는 거기 없다.
    let system_roots = tls_profile("localhost", SslMode::VerifyFull, None);
    let error = connect_error(&system_roots).await;
    assert!(
        matches!(error, ConnectError::Certificate { .. }),
        "{error:?}"
    );
}

#[tokio::test]
async fn verify_full_reports_an_unreadable_root_cert() {
    let missing = tls_profile("localhost", SslMode::VerifyFull, Some("no-such-ca.crt"));
    match connect_error(&missing).await {
        ConnectError::Certificate { message } => {
            assert!(message.contains("no-such-ca.crt"), "{message}")
        }
        other => panic!("{other:?}"),
    }

    let not_pem = ConnectionProfile {
        sslrootcert: Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")),
        ..tls_profile("localhost", SslMode::VerifyFull, None)
    };
    let error = connect_error(&not_pem).await;
    assert!(
        matches!(error, ConnectError::Certificate { .. }),
        "{error:?}"
    );
}

#[tokio::test]
async fn require_against_a_server_without_ssl_is_tls_not_supported() {
    let profile = ConnectionProfile {
        sslmode: SslMode::Require,
        ..local_profile()
    };
    assert_eq!(connect_error(&profile).await, ConnectError::TlsNotSupported);
}

#[tokio::test]
async fn tx_tap_works_over_tls() {
    let conn = connect(&tls_profile("127.0.0.1", SslMode::Require, None))
        .await
        .unwrap();
    // TLS 뒤의 평문에서 첫 ReadyForQuery를 읽지 못하면 tap이 암호문을 framing으로 해석해
    // 상태가 어긋난다. pg_backend_pid 조회까지 두 번의 ReadyForQuery가 지나간 상태다.
    assert_eq!(conn.tx_status().await, TxStatus::Idle);
    assert!(!conn.is_closed());
}
