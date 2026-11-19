use super::ServerError;

/// 세션 하나는 DB 연결 하나다 (탭 = 세션).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionId(pub u64);

/// 서버가 ReadyForQuery로 알려 주는 트랜잭션 상태.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxStatus {
    Idle,
    InTransaction,
    /// 트랜잭션 안에서 오류가 났다. `ROLLBACK` 전에는 다른 문장을 받지 않는다.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo {
    pub id: SessionId,
    pub connection: String,
    pub backend_pid: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    Open {
        tx: TxStatus,
    },
    /// 연결이 밖에서 끊겼다 (서버 재시작, `pg_terminate_backend` 등).
    Lost,
}

/// 실행의 트랜잭션 모드. 화면의 탭 상태이고 세션은 기억하지 않는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxMode {
    /// 보낸 문장 그대로다. 문장마다 서버가 commit한다(`BEGIN`을 쓰지 않았으면).
    Auto,
    /// 트랜잭션 밖이면 그 문장 전에 `BEGIN`을 보낸다.
    Manual,
}

/// 트랜잭션을 끝내는 방법.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxEnd {
    Commit,
    Rollback,
}

impl TxEnd {
    /// 서버에 보내는 문장.
    pub fn sql(self) -> &'static str {
        match self {
            Self::Commit => "COMMIT",
            Self::Rollback => "ROLLBACK",
        }
    }
}

/// 트랜잭션을 끝낸 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndOutcome {
    Ended,
    /// 실패한 트랜잭션의 Commit이다. 서버는 그 `COMMIT`을 `ROLLBACK`으로 처리하므로 보내지 않았다.
    TransactionFailed,
    /// 서버가 거절했다(deferred constraint 등). 실패한 `COMMIT` 뒤 트랜잭션은 끝나 있다.
    Server(ServerError),
    ConnectionLost {
        message: String,
    },
    /// 서버의 오류가 아닌 오류. 연결은 그대로다.
    Client {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndResult {
    pub outcome: EndOutcome,
    /// 끝낸 뒤 서버가 알려 준 트랜잭션 상태. 연결이 끊겼으면 `None`이다.
    pub tx: Option<TxStatus>,
}
