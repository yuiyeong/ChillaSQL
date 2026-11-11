//! 세션 하나. DB 연결 하나를 혼자 갖는 task다 (탭 = 세션).
//!
//! 연결을 task 하나가 가지므로 한 세션의 명령은 순서대로 처리된다. M2가 쿼리 실행을
//! [`SessionCommand`]에 더하고, 받다 만 결과도 이 task가 갖는다.

use tokio::sync::{mpsc, oneshot};

use super::DbConnection;
use crate::domain::SessionState;

const COMMAND_BUFFER: usize = 8;

enum SessionCommand {
    State(oneshot::Sender<SessionState>),
    Close(oneshot::Sender<()>),
}

/// 세션 task에 명령을 보내는 손잡이. 모두 drop되면 task가 연결을 닫고 끝난다.
#[derive(Clone)]
pub(crate) struct SessionHandle {
    commands: mpsc::Sender<SessionCommand>,
}

pub(crate) fn spawn<D: DbConnection>(connection: D) -> SessionHandle {
    let (commands, receiver) = mpsc::channel(COMMAND_BUFFER);
    tokio::spawn(run(connection, receiver));
    SessionHandle { commands }
}

async fn run<D: DbConnection>(connection: D, mut commands: mpsc::Receiver<SessionCommand>) {
    while let Some(command) = commands.recv().await {
        match command {
            SessionCommand::State(reply) => {
                let state = if connection.is_closed() {
                    SessionState::Lost
                } else {
                    SessionState::Open {
                        tx: connection.tx_status().await,
                    }
                };
                let _ = reply.send(state);
            }
            SessionCommand::Close(reply) => {
                connection.close().await;
                let _ = reply.send(());
                return;
            }
        }
    }
    connection.close().await;
}

impl SessionHandle {
    /// task가 이미 끝났으면 `Lost`다.
    pub(crate) async fn state(&self) -> SessionState {
        let (reply, response) = oneshot::channel();
        if self
            .commands
            .send(SessionCommand::State(reply))
            .await
            .is_err()
        {
            return SessionState::Lost;
        }
        response.await.unwrap_or(SessionState::Lost)
    }

    /// 연결이 닫힐 때까지 기다린다. task가 이미 끝났으면 바로 돌아온다.
    pub(crate) async fn close(self) {
        let (reply, response) = oneshot::channel();
        if self
            .commands
            .send(SessionCommand::Close(reply))
            .await
            .is_ok()
        {
            let _ = response.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::application::test_support::{FakeConnection, FakeLink};
    use crate::domain::TxStatus;

    fn session() -> (SessionHandle, FakeLink) {
        let link = FakeLink::default();
        let connection = FakeConnection {
            pid: 42,
            link: link.clone(),
        };
        (spawn(connection), link)
    }

    async fn eventually(check: impl Fn() -> bool) -> bool {
        for _ in 0..100 {
            if check() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        check()
    }

    #[tokio::test]
    async fn reports_open_then_lost() {
        let (handle, link) = session();
        assert_eq!(
            handle.state().await,
            SessionState::Open { tx: TxStatus::Idle }
        );
        link.lose();
        assert_eq!(handle.state().await, SessionState::Lost);
    }

    #[tokio::test]
    async fn close_closes_the_connection_before_returning() {
        let (handle, link) = session();
        let other = handle.clone();
        handle.close().await;
        assert!(link.closed());
        // 이미 끝난 세션의 handle은 멈추지 않고 Lost를 돌려주고, close는 그냥 끝난다.
        assert_eq!(other.state().await, SessionState::Lost);
        other.close().await;
    }

    #[tokio::test]
    async fn dropping_every_handle_closes_the_connection() {
        let (handle, link) = session();
        drop(handle);
        assert!(eventually(|| link.closed()).await);
    }
}
