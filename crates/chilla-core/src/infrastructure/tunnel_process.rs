//! 터널 명령을 사용자 login shell로 실행하는 [`TunnelRunner`].
//!
//! 명령은 새 process group에서 돈다. 끌 때는 group만 보지 않고 자손 프로세스 tree 전체를 찾아
//! 끈다. 터널 CLI 가운데는 ssh를 *다른* process group으로 띄우고, 자기가 SIGTERM을 받아도 ssh를
//! 남기는 것이 있어서다. 같은 이유로 포트가 열린 때의 자손을 기억해 두고 그중 하나가 끝나면
//! 터널이 끊긴 것으로 본다.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep, timeout};

use crate::application::{SpawnError, TunnelProcess, TunnelRunner};

/// stderr를 이만큼만 남긴다(끝부분).
const OUTPUT_LIMIT: usize = 16 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
/// 기억한 자손이 살아 있는지 보는 간격.
const WATCH_INTERVAL: Duration = Duration::from_millis(500);
/// SIGTERM 뒤 SIGKILL까지 기다리는 시간.
const TERM_GRACE: Duration = Duration::from_secs(2);
const STOP_POLL: Duration = Duration::from_millis(50);
const FALLBACK_SHELL: &str = "/bin/zsh";

/// `SHELL`이 절대 경로면 그것, 아니면 `/bin/zsh`.
pub fn login_shell(env_shell: Option<OsString>) -> PathBuf {
    match env_shell.map(PathBuf::from) {
        Some(shell) if shell.is_absolute() => shell,
        _ => PathBuf::from(FALLBACK_SHELL),
    }
}

pub struct ShellTunnelRunner {
    shell: PathBuf,
}

impl ShellTunnelRunner {
    /// 사용자의 `SHELL`을 쓴다. Finder로 띄운 앱에도 `SHELL`이 있다(M5 Task 1).
    pub fn new() -> Self {
        Self::with_shell(login_shell(std::env::var_os("SHELL")))
    }

    pub fn with_shell(shell: PathBuf) -> Self {
        Self { shell }
    }
}

impl Default for ShellTunnelRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl TunnelRunner for ShellTunnelRunner {
    type Process = ShellProcess;

    async fn is_open(&self, host: &str, port: u16) -> bool {
        matches!(
            timeout(PROBE_TIMEOUT, TcpStream::connect((host, port))).await,
            Ok(Ok(_))
        )
    }

    fn spawn(&self, command: &str, dir: &Path) -> Result<ShellProcess, SpawnError> {
        // login shell(-l)이어야 Finder로 띄운 앱도 `.zprofile`의 PATH로 명령을 찾는다.
        let mut child = Command::new(&self.shell)
            .args(["-l", "-c", command])
            .current_dir(dir)
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| SpawnError {
                message: error.to_string(),
            })?;
        let group = child
            .id()
            .and_then(|id| i32::try_from(id).ok())
            .ok_or_else(|| SpawnError {
                message: "The tunnel process has no pid".into(),
            })?;
        let output = Arc::new(Mutex::new(Tail::default()));
        let stderr = child.stderr.take();
        let reader = tokio::spawn({
            let output = output.clone();
            async move {
                let Some(mut stderr) = stderr else { return };
                let mut buf = [0u8; 4096];
                while let Ok(n) = stderr.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    output.lock().unwrap().push(&buf[..n]);
                }
            }
        });
        Ok(ShellProcess {
            child,
            group,
            remembered: Vec::new(),
            output,
            reader,
            ended: None,
        })
    }
}

/// 끝 [`OUTPUT_LIMIT`] byte만 남기는 buffer.
#[derive(Default)]
struct Tail {
    bytes: VecDeque<u8>,
    truncated: bool,
}

impl Tail {
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend(chunk);
        let excess = self.bytes.len().saturating_sub(OUTPUT_LIMIT);
        if excess > 0 {
            self.bytes.drain(..excess);
            self.truncated = true;
        }
    }

    fn text(&self) -> String {
        let (front, back) = self.bytes.as_slices();
        let mut bytes = Vec::with_capacity(self.bytes.len());
        bytes.extend_from_slice(front);
        bytes.extend_from_slice(back);
        // 앞을 잘라 낸 자리가 UTF-8 글자 중간이면 그 조각을 버린다.
        let start = if self.truncated {
            bytes
                .iter()
                .position(|b| b & 0b1100_0000 != 0b1000_0000)
                .unwrap_or(bytes.len())
        } else {
            0
        };
        String::from_utf8_lossy(&bytes[start..]).into_owned()
    }
}

pub struct ShellProcess {
    child: Child,
    /// process group id. shell의 pid와 같다.
    group: i32,
    /// `mark_ready`가 기억한 자손.
    remembered: Vec<i32>,
    output: Arc<Mutex<Tail>>,
    reader: JoinHandle<()>,
    /// 끝났으면 실행한 프로세스의 exit code.
    ended: Option<Option<i32>>,
}

impl ShellProcess {
    /// test가 group이 비었는지 보려고 쓴다.
    #[doc(hidden)]
    pub fn group_id(&self) -> i32 {
        self.group
    }

    /// group, 지금의 자손 tree, 기억한 자손. 중복은 뺀다.
    fn targets(&self) -> Vec<i32> {
        let mut pids = descendants(self.group);
        for pid in &self.remembered {
            if !pids.contains(pid) {
                pids.push(*pid);
            }
        }
        pids
    }

    fn signal_all(&mut self, signal: i32, pids: &[i32]) {
        unsafe {
            libc::killpg(self.group, signal);
            for pid in pids {
                libc::kill(*pid, signal);
            }
        }
    }

    /// 실행한 프로세스를 거두고, group과 `pids`가 모두 끝났는가.
    fn all_gone(&mut self, pids: &[i32]) -> bool {
        let root_gone = matches!(self.child.try_wait(), Ok(Some(_)) | Err(_));
        let group_gone = unsafe { libc::killpg(self.group, 0) } != 0;
        root_gone && group_gone && pids.iter().all(|pid| !is_running(*pid))
    }
}

impl TunnelProcess for ShellProcess {
    fn mark_ready(&mut self) {
        self.remembered = descendants(self.group);
    }

    async fn wait(&mut self) -> Option<i32> {
        if let Some(code) = self.ended {
            return code;
        }
        let code = loop {
            tokio::select! {
                status = self.child.wait() => break status.ok().and_then(|s| s.code()),
                () = sleep(WATCH_INTERVAL) => {
                    if self.remembered.iter().any(|pid| !is_running(*pid)) {
                        break None;
                    }
                }
            }
        };
        self.ended = Some(code);
        code
    }

    fn output(&self) -> String {
        self.output.lock().unwrap().text()
    }

    async fn stop(mut self) {
        let mut pids = self.targets();
        self.signal_all(libc::SIGTERM, &pids);
        let deadline = Instant::now() + TERM_GRACE;
        while !self.all_gone(&pids) {
            if Instant::now() >= deadline {
                // SIGTERM 사이에 새로 생긴 자손도 끈다.
                for pid in descendants(self.group) {
                    if !pids.contains(&pid) {
                        pids.push(pid);
                    }
                }
                self.signal_all(libc::SIGKILL, &pids);
                while !self.all_gone(&pids) {
                    sleep(STOP_POLL).await;
                }
                break;
            }
            sleep(STOP_POLL).await;
        }
        self.reader.abort();
    }
}

/// `root`의 자손 pid(자기 자신은 빼고). 부모 pid로 찾으므로 다른 process group의 자손도 나온다.
fn descendants(root: i32) -> Vec<i32> {
    let mut found = Vec::new();
    let mut queue = vec![root];
    while let Some(parent) = queue.pop() {
        for child in children(parent) {
            if !found.contains(&child) {
                found.push(child);
                queue.push(child);
            }
        }
    }
    found
}

fn children(parent: i32) -> Vec<i32> {
    let mut buf = vec![0 as libc::pid_t; 256];
    let size = i32::try_from(buf.len() * size_of::<libc::pid_t>()).unwrap_or(i32::MAX);
    let count = unsafe { libc::proc_listchildpids(parent, buf.as_mut_ptr().cast(), size) };
    let count = usize::try_from(count).unwrap_or(0).min(buf.len());
    buf.truncate(count);
    buf.retain(|pid| *pid > 0);
    buf
}

/// 프로세스가 있고 zombie가 아닌가. 다른 사용자의 프로세스(sudo로 띄운 자손 등)도 본다.
fn is_running(pid: i32) -> bool {
    // signal 0은 보내지 않고 있는지만 본다. 권한이 없다(EPERM)는 것은 있다는 뜻이다.
    let exists = unsafe { libc::kill(pid, 0) } == 0
        || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    if !exists {
        return false;
    }
    // 거두지 않은 zombie도 kill(pid, 0)에는 있다고 나온다. zombie는 정보를 읽지 못하고, 다른
    // 사용자의 프로세스는 권한(EPERM) 때문에 읽지 못한다.
    let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = i32::try_from(size_of::<libc::proc_bsdinfo>()).unwrap_or(i32::MAX);
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if read != size {
        return std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    }
    let info = unsafe { info.assume_init() };
    info.pbi_status != libc::SZOMB
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_shell_uses_an_absolute_shell_or_zsh() {
        assert_eq!(
            login_shell(Some("/bin/bash".into())),
            PathBuf::from("/bin/bash")
        );
        assert_eq!(login_shell(Some("bash".into())), PathBuf::from("/bin/zsh"));
        assert_eq!(login_shell(None), PathBuf::from("/bin/zsh"));
    }

    /// sudo로 띄운 자손처럼 다른 사용자의 프로세스도 살아 있으면 살아 있다.
    #[test]
    fn is_running_sees_processes_of_other_users() {
        assert!(is_running(1), "launchd(pid 1, root)");
        assert!(is_running(std::process::id() as i32));
        assert!(!is_running(i32::MAX));
    }

    #[test]
    fn tail_keeps_the_end_and_drops_a_cut_character() {
        let mut tail = Tail::default();
        tail.push("가".as_bytes());
        assert_eq!(tail.text(), "가");
        let mut long = vec![b'a'; OUTPUT_LIMIT - 1];
        long.extend_from_slice("가".as_bytes());
        tail.push(&long);
        // 앞의 "가"와 `a` 몇 개가 잘리고 첫 byte가 글자 중간이 아니다.
        let text = tail.text();
        assert!(text.ends_with('가'));
        assert!(text.starts_with('a'));
    }
}
