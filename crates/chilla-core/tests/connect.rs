mod support;

use std::time::{Duration, Instant};

use chilla_core::application::{ConnectError, Connector, DbConnection};
use chilla_core::domain::{ConnectionProfile, Password, TxStatus};
use chilla_core::infrastructure::PgConnector;
use support::{
    admin, backend_exists, connect_error, eventually, local_profile, password, terminate_backend,
};

#[tokio::test]
async fn connects_and_closes() {
    let admin = admin().await;
    let conn = PgConnector::new()
        .connect(&local_profile(), Some(&password()))
        .await
        .unwrap();

    let pid = conn.backend_pid();
    assert!(pid > 0);
    assert_eq!(conn.tx_status().await, TxStatus::Idle);
    assert!(!conn.is_closed());
    let application_name: String = admin
        .query_one(
            "SELECT application_name FROM pg_stat_activity WHERE pid = $1",
            &[&pid],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(application_name, "ChillaSQL");

    conn.close().await;
    assert!(eventually(async || !backend_exists(&admin, pid).await).await);
}

#[tokio::test]
async fn wrong_password_is_auth_failed_and_does_not_leak() {
    let secret = "wrong-secret-9f3";
    let error = connect_error(&local_profile(), Some(Password::new(secret.into()))).await;
    assert!(
        matches!(error, ConnectError::AuthFailed { .. }),
        "{error:?}"
    );
    assert!(!format!("{error} {error:?}").contains(secret));
}

#[tokio::test]
async fn missing_password_is_password_required() {
    let error = connect_error(&local_profile(), None).await;
    assert_eq!(error, ConnectError::PasswordRequired);
}

#[tokio::test]
async fn unknown_database_is_a_database_error() {
    let profile = ConnectionProfile {
        database: "no_such_db".into(),
        ..local_profile()
    };
    match connect_error(&profile, Some(password())).await {
        ConnectError::Database { code, .. } => assert_eq!(code, "3D000"),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn closed_port_is_unreachable() {
    let profile = ConnectionProfile {
        port: 1,
        ..local_profile()
    };
    let error = connect_error(&profile, Some(password())).await;
    assert!(
        matches!(error, ConnectError::Unreachable { .. }),
        "{error:?}"
    );
}

#[tokio::test]
async fn silent_server_times_out() {
    // TCP 연결은 받지만 아무 말도 하지 않는 서버.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            held.push(socket);
        }
    });
    let profile = ConnectionProfile {
        port,
        ..local_profile()
    };

    let started = Instant::now();
    let result = PgConnector::with_connect_timeout(Duration::from_millis(300))
        .connect(&profile, Some(&password()))
        .await;

    assert_eq!(result.err(), Some(ConnectError::Timeout));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn terminated_backend_is_detected() {
    let admin = admin().await;
    let conn = PgConnector::new()
        .connect(&local_profile(), Some(&password()))
        .await
        .unwrap();

    terminate_backend(&admin, conn.backend_pid()).await;

    assert!(eventually(async || conn.is_closed()).await);
    tokio::time::timeout(Duration::from_secs(1), conn.close())
        .await
        .expect("close가 1초 안에 끝나야 한다");
}

#[tokio::test]
async fn test_connection_returns_the_server_version() {
    let (app, _dir) = support::app_with_project().await;

    let info = app
        .test_connection(local_profile(), Some(password()))
        .await
        .unwrap();

    assert!(info.version.starts_with("18."), "{}", info.version);
    assert!(!info.version.contains(' '), "{}", info.version);
}

#[tokio::test]
async fn connection_reports_the_server_version() {
    let conn = PgConnector::new()
        .connect(&local_profile(), Some(&password()))
        .await
        .unwrap();

    assert!(conn.server_version().starts_with("18."));
    conn.close().await;
}
