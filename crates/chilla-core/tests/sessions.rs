mod support;

use chilla_core::application::{AppError, ConnectError};
use chilla_core::domain::{Password, QueryEvent, QueryOutcome, SessionState, TxMode, TxStatus};
use support::{
    DATABASE, TEST_DB_PORT, USER, admin, app_with_project, app_with_toml, backend_exists,
    eventually, next, sink, store_password, terminate_backend,
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

    assert!(
        app.test_connection(support::local_profile(), Some(support::password()))
            .await
            .is_ok()
    );
    let wrong = Password::new("nope".into());
    assert!(matches!(
        app.test_connection(profile, Some(wrong)).await,
        Err(AppError::Connect(ConnectError::AuthFailed { .. }))
    ));
}

/// test DB의 접속 `local`에 `extra`(toml 줄)를 더한 프로젝트에서 세션을 열고, `sql`을 실행해
/// 그 이벤트를 `Finished`까지 모두 돌려준다.
async fn run_with(extra: &str, sql: &str) -> Vec<QueryEvent> {
    let toml = format!(
        "[connections.local]\nhost = \"127.0.0.1\"\nport = {TEST_DB_PORT}\ndatabase = \"{DATABASE}\"\nuser = \"{USER}\"\n{extra}\n"
    );
    let (app, _dir, _events) = app_with_toml(&toml).await;
    store_password(&app).await;
    let session = app.open_session("local").await.unwrap();
    let (sink, mut events) = sink();
    app.execute(session.id, sql.into(), TxMode::Auto, false, sink)
        .await
        .unwrap();
    let mut all = Vec::new();
    loop {
        let event = next(&mut events).await;
        let done = matches!(event, QueryEvent::Finished { .. });
        all.push(event);
        if done {
            break;
        }
    }
    app.close_session(session.id).await.unwrap();
    all
}

fn failed_code(events: &[QueryEvent]) -> String {
    match events.last() {
        Some(QueryEvent::Finished {
            outcome: QueryOutcome::Failed(error),
            ..
        }) => error.code.clone(),
        other => panic!("Failed가 아니다: {other:?}"),
    }
}

#[tokio::test]
async fn read_only_session_rejects_writes() {
    let events = run_with("read_only = true", "CREATE TEMP TABLE t (id int)").await;
    assert_eq!(failed_code(&events), "25006");

    // 켜지 않으면 같은 문장이 통과한다.
    let events = run_with("", "CREATE TEMP TABLE t (id int)").await;
    assert!(matches!(
        events.last(),
        Some(QueryEvent::Finished {
            outcome: QueryOutcome::Completed { .. },
            ..
        })
    ));
}

#[tokio::test]
async fn statement_timeout_cancels_long_queries() {
    let events = run_with("statement_timeout = 1", "SELECT pg_sleep(2)").await;
    assert_eq!(failed_code(&events), "57014");
}

#[tokio::test]
async fn session_time_zone_is_the_mac_zone() {
    let Ok(zone) = iana_time_zone::get_timezone() else {
        return;
    };
    let events = run_with("", "SHOW TimeZone").await;
    let rows = events
        .iter()
        .find_map(|event| match event {
            QueryEvent::Rows(batch) => Some(batch.rows.clone()),
            _ => None,
        })
        .expect("SHOW TimeZone이 행을 돌려주지 않았다");
    assert_eq!(rows, [[Some(zone)]]);
}
