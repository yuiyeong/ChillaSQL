mod support;

use chilla_core::application::{AppError, ConnectError};
use chilla_core::domain::{Password, SessionState, TxStatus};
use support::{
    admin, app_with_project, backend_exists, eventually, store_password, terminate_backend,
};

const OPEN: SessionState = SessionState::Open { tx: TxStatus::Idle };

/// M1 완료 기준: 로컬 DB에 접속해 세션 2개를 따로 열고 닫는다.
#[tokio::test]
async fn two_sessions_open_and_close_independently() {
    let admin = admin().await;
    let (app, _dir) = app_with_project().await;
    store_password(&app).await;

    let a = app.open_session("local").await.unwrap();
    let b = app.open_session("local").await.unwrap();
    assert_ne!(a.id, b.id);
    assert_ne!(a.backend_pid, b.backend_pid);
    assert!(backend_exists(&admin, a.backend_pid).await);
    assert!(backend_exists(&admin, b.backend_pid).await);
    assert_eq!(app.session_state(a.id).await, Ok(OPEN));

    app.close_session(a.id).await.unwrap();
    assert!(eventually(async || !backend_exists(&admin, a.backend_pid).await).await);
    assert!(backend_exists(&admin, b.backend_pid).await);
    assert_eq!(app.session_state(b.id).await, Ok(OPEN));

    app.close_session(b.id).await.unwrap();
    assert!(eventually(async || !backend_exists(&admin, b.backend_pid).await).await);
    assert_eq!(
        app.close_session(a.id).await,
        Err(AppError::UnknownSession { id: a.id })
    );
}

#[tokio::test]
async fn session_without_stored_password_is_password_required() {
    let (app, _dir) = app_with_project().await;
    assert_eq!(
        app.open_session("local").await,
        Err(AppError::Connect(ConnectError::PasswordRequired))
    );
}

#[tokio::test]
async fn terminated_session_is_lost() {
    let admin = admin().await;
    let (app, _dir) = app_with_project().await;
    store_password(&app).await;
    let session = app.open_session("local").await.unwrap();

    terminate_backend(&admin, session.backend_pid).await;

    assert!(
        eventually(async || app.session_state(session.id).await == Ok(SessionState::Lost)).await
    );
    assert_eq!(app.close_session(session.id).await, Ok(()));
}

#[tokio::test]
async fn close_all_sessions_closes_everything() {
    let admin = admin().await;
    let (app, _dir) = app_with_project().await;
    store_password(&app).await;
    let mut pids = Vec::new();
    for _ in 0..3 {
        pids.push(app.open_session("local").await.unwrap().backend_pid);
    }

    app.close_all_sessions().await;

    for pid in pids {
        assert!(eventually(async || !backend_exists(&admin, pid).await).await);
    }
}

#[tokio::test]
async fn test_connection_connects_with_the_given_password() {
    let (app, _dir) = app_with_project().await;
    let profile = support::local_profile();

    assert_eq!(
        app.test_connection(support::local_profile(), Some(support::password()))
            .await,
        Ok(())
    );
    let wrong = Password::new("nope".into());
    assert!(matches!(
        app.test_connection(profile, Some(wrong)).await,
        Err(AppError::Connect(ConnectError::AuthFailed { .. }))
    ));
}
