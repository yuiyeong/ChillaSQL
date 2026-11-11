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
