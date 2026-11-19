//! 실제 프로세스로 [`ShellTunnelRunner`]를 확인한다.

use std::path::Path;
use std::time::{Duration, Instant};

use chilla_core::application::{SpawnError, TunnelProcess, TunnelRunner};
use chilla_core::infrastructure::{ShellProcess, ShellTunnelRunner};
use tempfile::TempDir;
use tokio::time::timeout;

fn runner() -> ShellTunnelRunner {
    ShellTunnelRunner::with_shell("/bin/zsh".into())
}

fn tmp() -> TempDir {
    tempfile::tempdir().unwrap()
}

fn spawn(command: &str, dir: &Path) -> ShellProcess {
    runner().spawn(command, dir).unwrap()
}

/// 프로세스가 아직 있는가(좀비 포함하지 않음은 보장하지 않는다. 우리가 부모가 아니므로 좀비는 남지 않는다).
fn pid_alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

fn group_alive(group: i32) -> bool {
    unsafe { libc::killpg(group, 0) == 0 }
}

/// command가 stderr 첫 줄에 쓴 pid를 기다려 읽는다.
async fn pid_in_output(process: &ShellProcess) -> i32 {
    for _ in 0..100 {
        if let Some(pid) = process
            .output()
            .lines()
            .next()
            .and_then(|line| line.trim().parse().ok())
        {
            return pid;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("pid가 stderr에 오지 않았다: {:?}", process.output());
}

#[tokio::test]
async fn wait_returns_the_exit_code_and_output_keeps_stderr() {
    let dir = tmp();
    let mut process = spawn("echo out; echo err >&2; exit 3", dir.path());
    assert_eq!(process.wait().await, Some(3));
    assert_eq!(process.wait().await, Some(3));
    assert_eq!(process.output(), "err\n");
    process.stop().await;
}

#[tokio::test]
async fn stderr_keeps_only_the_last_16_kib_and_replaces_invalid_utf8() {
    let dir = tmp();
    let mut process = spawn(
        "head -c 40000 /dev/zero | tr '\\0' a >&2; printf '\\377end' >&2",
        dir.path(),
    );
    process.wait().await;
    let output = process.output();
    assert!(
        output.ends_with("\u{FFFD}end"),
        "{:?}",
        &output[output.len() - 10..]
    );
    assert!(output.len() <= 16 * 1024 + 3, "{}", output.len());
    assert!(output.starts_with('a'), "{:?}", &output[..10]);
    process.stop().await;
}

#[tokio::test]
async fn stop_ends_the_whole_group() {
    let dir = tmp();
    let process = spawn("sleep 60 & sleep 60 & wait", dir.path());
    let group = process.group_id();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(group_alive(group));
    process.stop().await;
    assert!(!group_alive(group));
}

#[tokio::test]
async fn stop_kills_a_group_that_ignores_sigterm() {
    let dir = tmp();
    let process = spawn("perl -e '$SIG{TERM} = \"IGNORE\"; sleep 60'", dir.path());
    let group = process.group_id();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let started = Instant::now();
    process.stop().await;
    assert!(!group_alive(group));
    assert!(
        started.elapsed() >= Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
}

/// 자식이 자기 process group으로 옮겨 간다(터널 CLI가 ssh를 띄우는 방식).
#[tokio::test]
async fn stop_ends_children_in_another_group() {
    let dir = tmp();
    let mut process = spawn(
        "perl -e 'setpgrp(0,0); exec \"sleep\", 60' & echo $! >&2; wait",
        dir.path(),
    );
    let child = pid_in_output(&process).await;
    process.mark_ready();
    process.stop().await;
    assert!(!pid_alive(child));
}

/// 부모가 먼저 끝나 launchd 아래로 간 자식도 `mark_ready`가 기억했으면 끈다.
#[tokio::test]
async fn stop_ends_a_remembered_child_whose_parent_exited() {
    let dir = tmp();
    let mut process = spawn(
        "perl -e 'setpgrp(0,0); exec \"sleep\", 60' & echo $! >&2; sleep 0.5",
        dir.path(),
    );
    let child = pid_in_output(&process).await;
    process.mark_ready();
    assert_eq!(process.wait().await, Some(0));
    assert!(pid_alive(child));
    process.stop().await;
    assert!(!pid_alive(child));
}

#[tokio::test]
async fn wait_ends_when_a_remembered_child_exits() {
    let dir = tmp();
    // shell은 끝나지 않고(마지막 sleep) 자식만 끝난다.
    let mut process = spawn("sleep 60 & echo $! >&2; sleep 60", dir.path());
    let child = pid_in_output(&process).await;
    process.mark_ready();
    unsafe { libc::kill(child, libc::SIGKILL) };
    let code = timeout(Duration::from_secs(2), process.wait())
        .await
        .expect("기억한 자식이 끝나면 wait가 끝나야 한다");
    assert_eq!(code, None);
    process.stop().await;
}

#[tokio::test]
async fn spawn_runs_in_the_given_directory() {
    let dir = tmp();
    let mut process = spawn("pwd >&2", dir.path());
    process.wait().await;
    assert_eq!(
        process.output().trim(),
        dir.path().canonicalize().unwrap().to_str().unwrap()
    );
}

#[tokio::test]
async fn spawn_with_a_missing_shell_is_an_error() {
    let runner = ShellTunnelRunner::with_shell("/nonexistent/sh".into());
    let dir = tmp();
    assert!(matches!(
        runner.spawn("true", dir.path()),
        Err(SpawnError { .. })
    ));
}
