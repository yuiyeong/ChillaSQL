use std::path::PathBuf;
use std::time::Duration;

/// 접속에 `tunnel_timeout`이 없을 때 포트가 열리기를 기다리는 시간.
pub const DEFAULT_TUNNEL_TIMEOUT: Duration = Duration::from_secs(20);
/// `tunnel_timeout`으로 정할 수 있는 가장 긴 시간(초).
pub const MAX_TUNNEL_TIMEOUT_SECS: u64 = 300;

/// 터널 하나를 띄우는 데 필요한 것. 접속 정보와 프로젝트 디렉토리에서 만든다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelTarget {
    /// 사용자가 입력한 그대로의 명령.
    pub command: String,
    /// 명령을 실행할 디렉토리(프로젝트 디렉토리).
    pub dir: PathBuf,
    /// 터널이 열면 붙을 곳. 접속 정보의 host와 port다.
    pub host: String,
    pub port: u16,
    /// 명령을 실행한 뒤 포트가 열리기를 기다리는 시간.
    pub timeout: Duration,
}

/// 접속 하나의 터널 상태.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelState {
    /// 명령을 실행하고 포트가 열리기를 기다린다. 처음 시작은 `attempt` 0, 끊긴 뒤 다시 실행하면 1부터다.
    Starting {
        attempt: u8,
        timeout: Duration,
    },
    /// 앱이 띄운 터널의 포트가 열렸다.
    Ready,
    /// 명령을 실행하기 전부터 포트가 열려 있었다. 앱이 띄우지 않았으므로 끄지 않는다.
    External,
    Failed(TunnelFailure),
    /// 마지막 세션이 끊겨 터널을 껐다.
    Stopped,
}

/// 터널을 열지 못한 이유.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelFailure {
    /// 명령을 실행하지 못했다(shell이 없는 경우 등).
    Spawn { message: String },
    /// 포트가 열리기 전에 명령이 끝났다. `code`는 exit code이고 signal로 끝났으면 없다.
    Exited { code: Option<i32>, output: String },
    /// 기다리는 시간 안에 포트가 열리지 않았다.
    Timeout { secs: u64, output: String },
    /// 사용자가 터널 시작을 멈췄거나 앱이 터널을 모두 껐다.
    Cancelled,
}

impl TunnelFailure {
    /// 명령의 stderr. 명령이 실행된 실패에만 있다.
    pub fn output(&self) -> Option<&str> {
        match self {
            TunnelFailure::Exited { output, .. } | TunnelFailure::Timeout { output, .. } => {
                Some(output)
            }
            TunnelFailure::Spawn { .. } | TunnelFailure::Cancelled => None,
        }
    }
}

/// 터널 상태가 바뀌었다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelEvent {
    pub connection: String,
    pub state: TunnelState,
}
