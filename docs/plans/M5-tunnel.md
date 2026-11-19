# M5 터널 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 접속에 적힌 터널 명령을 앱이 실행하고 감시해서, 터미널 없이 터널 뒤의 DB에 접속하게 한다. 같은 마일스톤에서 접속 sheet를 캔버스 배치로 다시 만든다.

**Architecture:** 터널 관리는 `application`의 `Tunnels`가 맡는다. 접속 이름마다 supervisor task 하나가 명령을 실행하고, 포트가 열리기를 기다리고, 프로세스가 끝나면 다시 실행한다. 세션은 터널의 lease를 갖고, 마지막 lease가 풀리면 터널을 끈다. 프로세스 실행과 포트 확인은 port trait `TunnelRunner`로 나누고, `infrastructure`의 `ShellTunnelRunner`가 사용자 login shell과 process group으로 구현한다. 상태가 바뀌면 `TunnelSink`로 알리고, `src-tauri`가 Tauri event `tunnel`로 화면에 보낸다. 화면은 `useTunnels` store로 상태를 그리고, 터널이 다시 시작되면 그 접속의 탭 세션을 stale로 두었다가 다음 실행에서 새 세션으로 바꾼다.

**Tech Stack:** M4의 stack에 `tokio`의 `process` feature, `libc` 0.2(`killpg`)를 더한다. 통합 test의 가짜 터널은 `python3`로 쓴 TCP forwarder다.

**Spec:** [기획서](../spec.md) 4.1(터널 옵션, 접속 테스트), 4.2(터널 연결 전체), 5장(`chilla.toml`의 `tunnel`), 7장(터널 명령) / [마일스톤](../milestones.md) M5 / [디자인](../design/README.md)의 `Tunnel`, `ConnectionForm`, `Tokens` / [구조](../architecture.md)

## 먼저 확인한 것 (계획 작성 중 확인)

| 확인한 것 | 결과 | 결정 |
| --- | --- | --- |
| 사용자가 쓰는 터널 CLI의 help | 터널을 여는 명령은 Ctrl+C까지 foreground에 남고 local port를 인자로 정한다 | 프로세스가 살아 있는 동안을 터널이 열린 동안으로 본다(Task 1에서 고침: 자손 프로세스까지 본다) |
| 사용자의 shell | `$SHELL`은 `/bin/zsh`이고 터널 CLI는 Homebrew 경로에 있다. `env -i HOME=… /bin/zsh -lc 'command -v <CLI>'`가 찾는다(PATH는 `.zprofile`에서 옴) | 명령은 `$SHELL -l -c <tunnel>`로 실행한다. `-i`는 쓰지 않는다. Finder로 띄운 앱에 `SHELL`이 있는지는 Task 1에서 본다 |
| `establish`와 `PgCancel`의 stream 여는 분기 | 터널은 local port를 열 뿐이고 앱은 그 port에 지금처럼 TCP로 붙는다 | 여는 방법이 바뀌지 않으므로 묶지 않는다(M1의 연결 경로를 그대로 둔다) |
| 화면의 세션 관리(`runsStore`) | 세션은 첫 실행에서 열고, `connection_lost`가 오면 잊고 다음 실행에서 새로 연다 | 터널 재시작 뒤의 재연결도 이 흐름에 얹는다(아래) |

## 이 계획에서 정한 것

기획서에 없거나 다르게 정한 것이다. Task 1에서 진행상황의 결정 기록에 옮기고, 기획서와 마일스톤을 고쳐야 하면 같이 고친다.

- **1단계 사용 기간을 건너뛴다.** 기획서 8장은 단계마다 써 보고 넘어가라고 하지만, 1단계는 기능이 모자라 실제로 쓸 수 없어서 바로 M5를 시작한다(2026-11-19 사용자 결정).
- **완료 확인은 사용자가 고른 실제 터널 접속으로 한다**(2026-11-19 사용자 결정). 그 명령과 서버 이름은 private이라 문서에 적지 않고 사용자의 local `chilla.toml`에만 둔다. 문서의 예시는 `ssh -N -L 25432:db.internal:5432 bastion`처럼 지어낸 값을 쓴다. 기획서와 디자인 사본에 있던 실제 CLI 예시도 이 예시로 바꾼다.
- **`tunnel_timeout`**: `chilla.toml`의 key 이름은 캔버스대로 `tunnel_timeout`이고 값은 초 단위 정수(1~300)다. 없으면 20초다. `tunnel` 없이 쓰면 오류다(`sslrootcert`와 `sslmode`의 관계와 같다). 연결 대상이 아니라서 바꿔 저장해도 비밀번호를 지우지 않는다. `tunnel = ""`처럼 빈 명령도 오류다.
- **실행 방법**: 프로젝트 디렉토리(`chilla.toml`이 있는 곳)를 cwd로 `$SHELL -l -c <tunnel>`. 터널 CLI 중에는 실행한 디렉토리로 project를 찾는 것이 있어서다(Task 1에서 확인). `SHELL`이 없거나 절대 경로가 아니면 `/bin/zsh`다. 새 process group으로 띄우고(`process_group(0)`), stdin과 stdout은 `/dev/null`, stderr는 끝 16 KiB만 남긴다(UTF-8이 아닌 byte는 U+FFFD). 화면의 "Command output (stderr)"는 이 stderr다.
- **끄는 방법**: process group과 자손 프로세스 tree 전체(부모 pid로 찾음, 포트가 열린 때 기억해 둔 자손 포함)에 `SIGTERM`, 2초 뒤에도 남아 있으면 `SIGKILL`. 터널 CLI가 ssh를 *다른* process group으로 띄우고 SIGTERM, SIGINT를 받아도 ssh를 정리하지 않기 때문에 group만으로는 부족하다(Task 1에서 확인). 프로세스가 스스로 끝났을 때도 남은 것을 같은 방법으로 정리한다.
- **포트 확인**: 명령을 실행하기 전에 한 번, 실행한 뒤에는 200ms마다 `host:port`에 TCP로 붙어 본다(시도마다 500ms timeout). 실행 전에 열려 있으면 명령을 실행하지 않고 `External`이다. `External` 터널은 앱이 끄지 않고 감시하지도 않는다. lease를 새로 받을 때 포트를 다시 확인해 닫혀 있으면 명령을 실행한다.
- **끊김과 재실행**: 실행한 프로세스, 또는 포트가 열린 때 기억해 둔 자손 가운데 하나라도 끝나면 터널이 끊긴 것으로 본다. 터널 CLI는 ssh 자식이 죽어도 살아 남아서 프로세스 하나만 보면 끊김을 모른다(Task 1에서 확인). 포트를 주기적으로 붙어 보는 방법은 매번 DB 서버까지 연결이 가서 서버 log에 `incomplete startup packet`을 남기므로 쓰지 않는다. 끊기면 1초 뒤 다시 실행한다(재실행 1/3). 포트가 열리면 횟수를 처음으로 돌린다. 연속 3번 열리지 않으면 `Failed`로 멈춘다. 멈춘 터널은 다음 세션 열기나 "Try again"이 처음부터 다시 시작한다.
- **DB 재연결은 다음 실행에서 한다.** 터널이 다시 시작되면(재실행 1/3을 알리는 event) 화면은 그 접속을 쓰는 탭의 세션을 stale로 표시한다. 그 탭의 다음 실행은 새 세션을 *먼저* 연 뒤 옛 세션을 닫는다. 먼저 닫으면 lease가 0이 되어 막 살린 터널이 꺼지기 때문이다. 끊긴 세션(stale이거나 `connection_lost`로 잊은 세션)을 새 세션이 대신하면 결과 panel 위에 "Reconnected" banner를 띄운다. 터널 없는 접속의 `connection_lost` 뒤에도 같다. 트랜잭션 중 끊김의 알림은 M6이다.
- **같은 접속의 터널은 하나**다. lease를 받을 때 같은 이름의 터널이 다른 대상(명령, host, port)이거나 끄는 중이면 그 터널이 완전히 꺼질 때까지 기다린 뒤 새로 시작한다. 연결 대상을 고쳐 저장하면 화면이 그 접속의 세션을 닫으므로(M3) 옛 터널은 곧 꺼진다.
- **접속 테스트의 터널**은 공유하지 않는다. 포트가 열려 있으면 띄우지 않고, 띄웠으면 테스트가 끝날 때 끈다. 테스트의 실패 문구는 세션 열기와 같다.
- **터널 시작 중의 Cancel**: toolbar의 Cancel(과 `Cmd+.`)은 탭이 연결 중이고 그 접속의 터널이 `Starting`이면 터널 시작을 멈춘다. 같은 터널을 기다리던 다른 탭의 실행도 멈춘다. 멈춘 실행은 결과 panel을 빈 상태로 둔다. 터널이 없는 연결 중에는 지금처럼 disabled다.
- **상태 전달**: Rust는 상태가 바뀔 때마다 Tauri event `tunnel`(`{ connection, state }`)을 보낸다. `Starting tunnel 14 / 20 s`의 초는 화면이 `starting`을 받은 시각부터 센다.
- **오류 문구**: 세션 열기와 접속 테스트의 터널 오류는 Rust의 영어 message와 `output`(stderr)을 그대로 보여 준다. `CommandError`에 `output`을 더한다. 재실행을 3번 실패한 상태는 event로 받아 화면 문구로 그린다.
- **탭의 터널 icon**: 캔버스는 `External`만 그리지만 시작 중과 재실행 중(spinner), 실패(오류 icon)도 탭에 icon으로 보인다. 마일스톤의 "탭과 toolbar의 터널 상태"를 따른다.
- **앱이 비정상 종료하면**(강제 종료, crash) 터널 프로세스가 남을 수 있다. 다음에 앱을 열면 그 포트가 열려 있으므로 `External`로 보인다. 정상 종료(`Cmd+Q`, 창 닫기)만 터널을 끈다.
- **접속 sheet**는 캔버스의 배치를 따르되 `color`(M6), `read_only`와 `statement_timeout`(M8)은 넣지 않는다. 창 위쪽에 붙는 sheet(폭 600px, 아래 모서리만 둥금)다. 테스트 성공 문구는 `Connected · 41 ms`이고 server version은 넣지 않는다(M8). `sslrootcert`의 "Choose…"는 `.pem`, `.crt` 파일 dialog다.

## Global Constraints

- 터널 대기 기본 20초, 재실행 연속 실패 3회에서 멈춤(기획서 4.2, 9장의 기본값).
- 의존 방향: `infrastructure` → `application` → `domain`. `application`은 `tokio`의 `sync`, `task`, `time`만 쓴다. 새 I/O crate(`libc`)는 `docs/architecture.md`의 표와 `tests/layer_deps.rs`의 목록에 넣는다.
- `chilla-core`는 `tauri`에 의존하지 않는다. `src-tauri`의 command는 use case를 부르는 일만 한다.
- `@tauri-apps/*`는 `src/shared/api/`에서만 import한다.
- 화면 문구는 `src/shared/i18n/en.ts`에 두고 `t(key, params)`로 쓴다. 터널 명령, stderr, `host:port`, 설정 key 이름(`tunnel`, `tunnel_timeout`)은 번역하지 않는다.
- 색, 그림자, 글자 크기는 `src/index.css`의 token으로만 쓴다. 상태는 접속 색이 아니라 icon과 문장으로 구분한다(Tokens).
- 터널 명령과 stderr에 비밀이 들어갈 수 있으므로 log에 쓰지 않는다(기획서 7장). 비밀번호는 지금처럼 화면으로 보내지 않는다.
- commit 전에 `pnpm check`를 통과시킨다. commit message는 `feat:`/`fix:`/`docs:`/`chore:`/`test:` 뒤에 한국어 한 줄이다.
- `docs/`는 평서체, 기술 용어는 영어, 날짜는 `YYYY-MM-DD`, 단축키는 `Cmd+.`처럼 글자로 쓴다.

## Review Focus

test가 없으면 사용자가 가장 먼저 부딪힐 입력과 상황이다. 각 줄의 test는 해당 Task에 넣었다.

1. **연결 대상을 고쳐 저장한 직후 같은 접속으로 실행**: 옛 터널이 꺼지는 중에 새 명령이 실행되면 옛 터널의 포트를 보고 `External`로 잘못 붙는다. 옛 터널이 꺼진 뒤 새 명령을 실행해야 한다 → Task 4 `acquire_waits_until_the_old_tunnel_of_the_name_is_gone`.
2. **터널이 시작되는 중에 탭을 닫거나 프로젝트를 바꿈**: 세션이 생기기 전이라 lease를 가진 쪽이 없어도 프로세스가 남으면 안 된다 → Task 5 `switching_project_while_the_tunnel_starts_stops_it`.
3. **앱 종료 때 시작 중이거나 재실행 중인 터널, 접속 테스트의 터널**: 모두 꺼져야 한다 → Task 4 `stop_all_stops_starting_restarting_and_private_tunnels`.
4. **명령이 바로 실패**(CLI 로그인 만료, 오타): 20초를 기다리지 않고 stderr와 함께 바로 실패해야 한다 → Task 4 `early_exit_fails_without_waiting_for_the_timeout`, Task 7 `a_failing_command_reports_its_stderr`.
5. **stderr가 아주 길거나 UTF-8이 아님**: 메모리가 늘지 않고 끝부분만 깨지지 않게 보여야 한다 → Task 3 `stderr_keeps_only_the_last_16_kib_and_replaces_invalid_utf8`.

---

## File Structure

| 파일 | 할 일 |
| --- | --- |
| `crates/chilla-core/src/domain/tunnel.rs` (새) | `TunnelTarget`, `TunnelState`, `TunnelFailure`, `TunnelEvent`, 기본값 상수 |
| `crates/chilla-core/src/domain/connection.rs` | `tunnel_timeout`, `tunnel_target()`, 검사 |
| `crates/chilla-core/src/infrastructure/project_file.rs` | `tunnel_timeout` 읽기와 쓰기 |
| `crates/chilla-core/src/application/ports.rs` | `TunnelRunner`, `TunnelProcess`, `SpawnError` |
| `crates/chilla-core/src/application/tunnels.rs` (새) | `Tunnels`: lease, supervisor, 재실행, 취소, 모두 끄기 |
| `crates/chilla-core/src/application/test_support/tunnel.rs` (새) | `FakeRunner`, `FakeProcess` |
| `crates/chilla-core/src/application/app.rs` | 세션과 lease, 접속 테스트의 터널, `cancel_tunnel`, `restart_tunnel`, `shutdown` |
| `crates/chilla-core/src/infrastructure/tunnel_process.rs` (새) | `ShellTunnelRunner`, `ShellProcess` |
| `crates/chilla-core/tests/tunnel_process.rs` (새) | 실제 프로세스로 `ShellTunnelRunner` 확인 |
| `crates/chilla-core/tests/tunnels.rs`, `tests/support/forward.py` (새) | test DB 앞에 forwarder를 터널로 두고 App 전체 확인 |
| `src-tauri/src/lib.rs`, `commands.rs`, `error.rs` | setup에서 `CoreApp` 만들기, event, DTO, `output`, 새 command, 종료 |
| `src/shared/api/types.ts`, `commands.ts`, `errors.ts`, `events.ts` (새), `dialog.ts` | 터널 type, event 구독, `cancelTunnel`, `restartTunnel`, `pickFile` |
| `src/features/connections/tunnelsStore.ts` (새) | 접속별 터널 상태 |
| `src/features/connections/TunnelStatus.tsx` (새) | chip의 상태 칸, 탭 icon, 경과 초 |
| `src/features/connections/ConnectionForm.tsx`, `connectionValues.ts` | 캔버스 배치의 sheet, `tunnel`, `tunnel_timeout` |
| `src/features/query/runsStore.ts`, `runReducer.ts` | stale 세션, Reconnected 알림, 터널 오류의 rejection |
| `src/features/query/TunnelPanels.tsx` (새), `ResultPane.tsx` | 시작 중, 실패, 재실행, 멈춤, Reconnected 화면 |
| `src/features/workspace/tunnelEvents.ts` (새), `Workspace.tsx`, `Toolbar.tsx`, `commands.ts` | event 구독, Cancel, sheet 위치 |
| `src/features/editor/TabBar.tsx` | 탭의 터널 icon |
| `src/shared/i18n/en.ts` | 터널과 sheet 문구 |

---

### Task 1: 먼저 확인할 것 — 프로세스 tree, Finder의 환경, 결정 기록

**Files:**
- Modify: `docs/progress.md`, `docs/milestones.md`, `docs/spec.md`

**Interfaces:**
- Produces: 아래 확인 결과. Task 3의 shell 고르기(`SHELL` 다음에 무엇을 볼지)와 Task 3·4의 끄는 방법이 이 결과를 따른다.

실제 터널 명령은 사용자가 허락한 local 접속의 것을 쓰고 문서에는 적지 않는다(아래 `<터널 명령>`). 임시 probe는 확인 뒤 지운다.

- [x] **Step 1: 실제 터널의 프로세스 tree와 SIGTERM을 확인한다**

```bash
perl -e 'setpgrp(0,0); exec @ARGV' /bin/zsh -l -c '<터널 명령>' 2>err.txt &
```

| 확인 | 기준 |
| --- | --- |
| `ps -o pid,pgid,ppid,command -g <pgid>` | shell, CLI, (있으면) ssh 자식이 모두 같은 pgid다. 기록한다 |
| 포트가 열리는 시간 | `nc -z localhost 25432`가 성공할 때까지 걸린 초. 20초 안인지 기록한다 |
| `kill -TERM -<pgid>` | 2초 안에 group의 프로세스가 모두 없어지고 포트가 닫힌다. 남으면 무엇이 남는지 기록한다(Task 3의 `SIGKILL`이 맡는다) |
| `kill -TERM <CLI pid>` 한 개만 | zsh가 끝나는지, ssh 자식이 남는지 기록한다(프로세스가 스스로 끝날 때 group을 정리하는 이유) |
| 없는 서비스 이름으로 실행 | exit code와 stderr 내용을 기록한다(Task 7, Task 11의 실패 화면 확인에 씀) |

- [x] **Step 2: Finder로 띄운 앱의 환경을 확인한다**

임시로 `src-tauri/src/lib.rs`의 시작에서 `eprintln!("SHELL_PROBE {:?}", std::env::var("SHELL"))`와 `std::process::Command::new("/bin/zsh").args(["-l", "-c", "command -v <CLI>"])`의 결과를 stderr에 쓴다. `scripts/build-app.sh --debug`로 만든 `.app`을 `open --stderr <file>`로 띄워 읽는다.

**결정 규칙**: `SHELL`이 있으면 계획대로 `$SHELL`, 없으면 Task 3은 `getpwuid(getuid()).pw_shell`을 먼저 보고 그다음 `/bin/zsh`를 쓴다. `-l -c`로 CLI를 못 찾으면 `-l -i -c`로 다시 재고 결과를 기록한다.

- [x] **Step 3: probe를 지우고 결정을 기록한 뒤 commit한다**

- "이 계획에서 정한 것"의 모든 항목과 Step 1·2의 결과를 진행상황의 결정 기록에 한 줄씩 남긴다.
- 진행상황: 마일스톤 현황에서 M5를 `진행 중`으로, "지금"의 진행 중, 작업 위치(branch `m5-tunnel`), 다음 할 일을 바꾼다.
- 기획서: 8장 첫 문단에 1단계는 쓰지 않고 넘어갔다고 적는다. 4.2에 실행 방법(login shell, process group), 재연결 시점(다음 실행)을 더한다. 5장의 staging 예시에 `tunnel_timeout = 30`을 주석으로 더한다. 9장의 key 이름 항목에서 `tunnel_timeout`(M5)을 지우고 정한 것을 4.2에 반영한다.
- 마일스톤: M5 "먼저 확인할 것"에 결과를 적는다. M8에 "접속 테스트의 server version 표시"를 더한다.

Run: `pnpm check`
Expected: 통과

```bash
git add docs src-tauri/src/lib.rs
git commit -m "docs: M5 Task 1 터널 프로세스와 Finder 환경을 확인하고 결정을 기록함"
```

---

### Task 2: 접속 정보의 `tunnel_timeout`과 터널 domain type

**Files:**
- Create: `crates/chilla-core/src/domain/tunnel.rs`
- Modify: `crates/chilla-core/src/domain/connection.rs`, `domain/mod.rs`, `crates/chilla-core/src/infrastructure/project_file.rs`, `crates/chilla-core/tests/project_file.rs`, `crates/chilla-core/tests/support/mod.rs`, `crates/chilla-core/src/application/test_support/mod.rs`, `src-tauri/src/commands.rs`, `src/shared/api/types.ts`, `src/test/fixtures.ts`

**Interfaces:**
- Produces (`domain`):
  - `pub const DEFAULT_TUNNEL_TIMEOUT: Duration` (20초), `pub const MAX_TUNNEL_TIMEOUT_SECS: u64` (300)
  - `ConnectionProfile.tunnel_timeout: Option<Duration>`
  - `ConnectionProfile::tunnel_target(&self, project_dir: &Path) -> Option<TunnelTarget>`: `tunnel`이 있으면 `{ command: tunnel, dir: project_dir, host, port, timeout: tunnel_timeout.unwrap_or(DEFAULT_TUNNEL_TIMEOUT) }`
  - `pub struct TunnelTarget { pub command: String, pub dir: PathBuf, pub host: String, pub port: u16, pub timeout: Duration }` (`Clone, PartialEq, Eq, Debug`)
  - `pub enum TunnelState { Starting { attempt: u8, timeout: Duration }, Ready, External, Failed(TunnelFailure), Stopped }`. `attempt`는 처음 시작이 0, 재실행이 1~3이다
  - `pub enum TunnelFailure { Spawn { message: String }, Exited { code: Option<i32>, output: String }, Timeout { secs: u64, output: String }, Cancelled }`. `TunnelFailure::output(&self) -> Option<&str>`
  - `pub struct TunnelEvent { pub connection: String, pub state: TunnelState }`
  - `ProfileError::TunnelTimeoutWithoutTunnel`(`"tunnel_timeout can only be used with tunnel"`), `ProfileError::TunnelTimeoutRange { secs: u64 }`(`"tunnel_timeout must be 1 to 300 seconds, not {secs}"`). 빈 `tunnel`은 `EmptyField { field: "tunnel" }`
- Produces (화면): `Connection.tunnelTimeout: number | null`(초). DTO key는 `tunnelTimeout`, `chilla.toml` key는 `tunnel_timeout`

- [x] **Step 1: domain test를 쓴다**

`connection.rs`의 test에 더한다.

```rust
#[test]
fn validate_checks_the_tunnel_fields() {
    let tunneled = |timeout: Option<u64>| ConnectionProfile {
        tunnel: Some("ssh -N -L 25432:db.internal:5432 bastion".into()),
        tunnel_timeout: timeout.map(Duration::from_secs),
        ..local()
    };
    assert_eq!(tunneled(None).validate(), Ok(()));
    assert_eq!(tunneled(Some(1)).validate(), Ok(()));
    assert_eq!(tunneled(Some(300)).validate(), Ok(()));
    assert_eq!(tunneled(Some(0)).validate(), Err(ProfileError::TunnelTimeoutRange { secs: 0 }));
    assert_eq!(tunneled(Some(301)).validate(), Err(ProfileError::TunnelTimeoutRange { secs: 301 }));
    let blank = ConnectionProfile { tunnel: Some("  ".into()), ..local() };
    assert_eq!(blank.validate(), Err(ProfileError::EmptyField { field: "tunnel" }));
    let orphan = ConnectionProfile { tunnel_timeout: Some(Duration::from_secs(5)), ..local() };
    assert_eq!(orphan.validate(), Err(ProfileError::TunnelTimeoutWithoutTunnel));
}

#[test]
fn tunnel_target_uses_the_default_timeout() {
    assert_eq!(local().tunnel_target(), None);
    let profile = ConnectionProfile { tunnel: Some("ssh -L".into()), port: 25432, ..local() };
    assert_eq!(profile.tunnel_target(), Some(TunnelTarget {
        command: "ssh -L".into(), host: "localhost".into(), port: 25432, timeout: Duration::from_secs(20),
    }));
}
```

`same_target_ignores_only_the_color`는 `same_target_ignores_the_color_and_tunnel_timeout`으로 바꾸고 `tunnel_timeout`만 다른 접속도 같은 대상이라고 단언한다.

- [x] **Step 2: `chilla.toml` test를 쓴다**

`tests/project_file.rs`에 더한다.

- `tunnel_timeout_round_trips`: `tunnel = "ssh -N -L 25432:db.internal:5432 bastion"`, `tunnel_timeout = 30`을 읽으면 `Some(30초)`이고, `save_connection`으로 `tunnel_timeout`을 `None`으로 쓰면 그 줄이 지워진다.
- `tunnel_timeout_must_be_an_integer`: `tunnel_timeout = "20s"`는 `ProjectError::Parse`, `tunnel_timeout = 0`은 `InvalidConnection { source: TunnelTimeoutRange { secs: 0 } }`.
- `tunnel_timeout_without_tunnel_is_rejected`: `InvalidConnection { source: TunnelTimeoutWithoutTunnel }`.

`src-tauri/src/commands.rs`의 `connection_dto_has_no_password_key`가 기대하는 key에 `tunnelTimeout`을 더하고, `connection_dto_round_trips`의 profile에 `tunnel_timeout: Some(30초)`를 넣는다.

- [x] **Step 3: test가 실패하는지 확인한다**

Run: `cargo test -p chilla-core --lib connection && cargo test -p chilla-core --test project_file`
Expected: FAIL (compile error: `tunnel_timeout`, `TunnelTarget` 없음)

- [x] **Step 4: 구현한다**

`domain/tunnel.rs`에 위 type을 쓴다. `ConnectionProfile`에 `tunnel_timeout`을 더하고 `validate`가 빈 `tunnel`, 범위, `tunnel` 없는 `tunnel_timeout`을 검사한다. `project_file.rs`의 `RawConnection`에 `tunnel_timeout: Option<u64>`, `write_fields`의 `tunnel` 다음에 `("tunnel_timeout", …)`를 더한다. `ConnectionDto`에 `#[serde(default)] tunnel_timeout: Option<u64>`를 더한다. `ConnectionProfile`을 만드는 모든 곳(fixture, test support, 화면 fixture의 `connection()`)에 `tunnel_timeout: None` / `tunnelTimeout: null`을 넣는다.

- [x] **Step 5: test가 통과하는지 확인한다**

Run: `cargo test && pnpm typecheck`
Expected: PASS

- [x] **Step 6: commit한다**

```bash
git add crates src-tauri src
git commit -m "feat: 접속 정보에 tunnel_timeout을 더하고 터널 domain type을 만듦"
```

---

### Task 3: 터널 port와 `ShellTunnelRunner`

**Files:**
- Create: `crates/chilla-core/src/infrastructure/tunnel_process.rs`, `crates/chilla-core/tests/tunnel_process.rs`
- Modify: `crates/chilla-core/src/application/ports.rs`, `application/mod.rs`, `infrastructure/mod.rs`, `crates/chilla-core/Cargo.toml`(`tokio`에 `process`, `libc = "0.2"`), `crates/chilla-core/tests/layer_deps.rs`, `docs/architecture.md`

**Interfaces:**
- Produces (`application::ports`):

```rust
/// 터널 명령을 실행하고 포트를 확인한다.
pub trait TunnelRunner: Send + Sync + 'static {
    type Process: TunnelProcess;
    /// host:port에 TCP로 붙으면 true. 붙은 연결은 바로 닫는다. 500ms 안에 답이 없으면 false.
    fn is_open(&self, host: &str, port: u16) -> impl Future<Output = bool> + Send;
    /// 명령을 사용자 login shell로 새 process group에서 실행한다.
    fn spawn(&self, command: &str, dir: &Path) -> Result<Self::Process, SpawnError>;
}

pub trait TunnelProcess: Send + 'static {
    /// 지금의 자손 프로세스를 기억한다. 포트가 열렸을 때 부른다. 그 뒤 `wait`는 기억한 자손이 끝나는 것도 끝으로 본다.
    fn mark_ready(&mut self);
    /// 실행한 프로세스나 `mark_ready`가 기억한 자손 가운데 하나가 끝날 때까지 기다린다. 실행한 프로세스의
    /// exit code를 돌려준다(아직 살아 있거나 signal로 끝났으면 None). cancel-safe다.
    /// 이미 끝났으면 바로 같은 값을 돌려준다.
    fn wait(&mut self) -> impl Future<Output = Option<i32>> + Send;
    /// 지금까지 받은 stderr의 끝 16 KiB.
    fn output(&self) -> String;
    /// process group, 지금의 자손 tree, 기억한 자손에 SIGTERM, 2초 뒤에도 남아 있으면 SIGKILL. 모두 끝날 때까지 기다린다.
    fn stop(self) -> impl Future<Output = ()> + Send;
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Could not run the tunnel command: {message}")]
pub struct SpawnError { pub message: String }
```

- Produces (`infrastructure`): `ShellTunnelRunner::new() -> Self`(shell을 이때 고른다), `ShellTunnelRunner::with_shell(shell: PathBuf) -> Self`(test용), `pub fn login_shell(env_shell: Option<OsString>) -> PathBuf`

- [x] **Step 1: `tests/tunnel_process.rs`를 쓴다**

모두 `ShellTunnelRunner::with_shell("/bin/zsh".into())`를 쓴다. 아래 code의 `spawn(command)`는 `spawn(command, &tmp())`(test마다 만든 빈 디렉토리)로 읽는다.

```rust
#[tokio::test]
async fn is_open_follows_a_listener() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    assert!(runner().is_open("127.0.0.1", port).await);
    drop(listener);
    assert!(!runner().is_open("127.0.0.1", port).await);
}

#[tokio::test]
async fn wait_returns_the_exit_code_and_output_keeps_stderr() {
    let mut process = runner().spawn("echo out; echo err >&2; exit 3").unwrap();
    assert_eq!(process.wait().await, Some(3));
    assert_eq!(process.wait().await, Some(3));
    assert_eq!(process.output(), "err\n");
}

#[tokio::test]
async fn stderr_keeps_only_the_last_16_kib_and_replaces_invalid_utf8() {
    let mut process = runner()
        .spawn("head -c 40000 /dev/zero | tr '\\0' a >&2; printf '\\377end' >&2")
        .unwrap();
    process.wait().await;
    let output = process.output();
    assert!(output.ends_with("\u{FFFD}end"), "{output:?}");
    assert!(output.len() <= 16 * 1024 + 3);
}

#[tokio::test]
async fn stop_ends_the_whole_group() {
    // 자식 두 개를 둔 shell. stop 뒤에 group에 아무것도 남지 않아야 한다.
    let process = runner().spawn("sleep 60 & sleep 60 & wait").unwrap();
    let group = process.group_id(); // test용 accessor (#[doc(hidden)] pub)
    process.stop().await;
    assert!(!group_alive(group)); // libc::killpg(group, 0) == -1 && errno == ESRCH
}

#[tokio::test]
async fn stop_kills_a_group_that_ignores_sigterm() {
    let process = runner().spawn("trap '' TERM; sleep 60 & wait").unwrap();
    let group = process.group_id();
    let started = Instant::now();
    process.stop().await;
    assert!(!group_alive(group));
    assert!(started.elapsed() >= Duration::from_secs(2));
}

#[tokio::test]
async fn stop_ends_children_in_another_group() {
    // 자식이 자기 process group으로 옮겨 간다(터널 CLI가 ssh를 띄우는 방식).
    let mut process = runner().spawn("perl -e 'setpgrp(0,0); exec \"sleep\", 60' & echo $! >&2; wait", &tmp()).unwrap();
    let child = wait_for_pid_in_output(&process).await;
    process.mark_ready();
    process.stop().await;
    assert!(!pid_alive(child));
}

#[tokio::test]
async fn wait_ends_when_a_remembered_child_exits() {
    let mut process = runner().spawn("sleep 60 & echo $! >&2; wait", &tmp()).unwrap();
    let child = wait_for_pid_in_output(&process).await;
    process.mark_ready();
    unsafe { libc::kill(child, libc::SIGKILL) };
    assert_eq!(timeout(Duration::from_secs(2), process.wait()).await.unwrap(), None);
    process.stop().await;
}

#[tokio::test]
async fn spawn_runs_in_the_given_directory() {
    let dir = tempfile::tempdir().unwrap();
    let mut process = runner().spawn("pwd >&2", dir.path()).unwrap();
    process.wait().await;
    assert_eq!(process.output().trim(), dir.path().canonicalize().unwrap().to_str().unwrap());
}

#[tokio::test]
async fn spawn_with_a_missing_shell_is_an_error() {
    let runner = ShellTunnelRunner::with_shell("/nonexistent/sh".into());
    assert!(matches!(runner.spawn("true"), Err(SpawnError { .. })));
}
```

`tunnel_process.rs`의 unit test로 `login_shell`: `Some("/bin/bash")` → `/bin/bash`, `Some("bash")`(상대 경로)와 `None` → `/bin/zsh`(Task 1에서 passwd를 먼저 보기로 했으면 그 값).

`layer_deps.rs`의 `domain`, `application` 금지 목록에 `libc`를 더한다.

- [x] **Step 2: test가 실패하는지 확인한다**

Run: `cargo test -p chilla-core --test tunnel_process`
Expected: FAIL (compile error)

- [x] **Step 3: 구현한다**

`ShellProcess`는 `tokio::process::Child`, process group id(= 자식 pid), `mark_ready`가 기억한 자손 pid 목록, stderr를 읽는 task가 채우는 `Arc<Mutex<VecDeque<u8>>>`(16 KiB 넘으면 앞을 버림), 끝난 exit code의 cache를 갖는다. `spawn`은 `Command::new(shell).args(["-l", "-c", command]).current_dir(dir).process_group(0).stdin(null).stdout(null).stderr(piped).kill_on_drop(true)`. 자손 찾기는 `libc::proc_listchildpids`를 부모부터 차례로 부르는 `fn descendants(root: i32) -> Vec<i32>`다. `wait`는 `child.wait()`와 500ms마다 기억한 자손이 살아 있는지(`kill(pid, 0)`) 보는 것 중 먼저 끝나는 쪽이다. `output`은 buffer를 `String::from_utf8_lossy`로 바꾼다(앞이 잘려 생긴 깨진 첫 글자는 버린다). `stop`은 group, `descendants(root)`, 기억한 자손에 `SIGTERM`을 보내고 50ms마다 모두 끝났는지 확인하다 2초가 지나면 남은 것에 `SIGKILL`. `is_open`은 `timeout(500ms, TcpStream::connect((host, port)))`. `docs/architecture.md`의 I/O crate 표에 `libc`를 더한다.

- [x] **Step 4: test가 통과하는지 확인한다**

Run: `cargo test -p chilla-core --test tunnel_process --test layer_deps && cargo test -p chilla-core --lib tunnel_process`
Expected: PASS

- [x] **Step 5: commit한다**

```bash
git add crates docs/architecture.md
git commit -m "feat: 터널 명령을 login shell과 process group으로 실행하는 ShellTunnelRunner"
```

---

### Task 4: `Tunnels` — 공유, 감시, 재실행

**Files:**
- Create: `crates/chilla-core/src/application/tunnels.rs`, `crates/chilla-core/src/application/test_support/tunnel.rs`
- Modify: `crates/chilla-core/src/application/mod.rs`, `application/test_support/mod.rs`

**Interfaces:**
- Consumes: Task 2의 `TunnelTarget`, `TunnelState`, `TunnelFailure`, `TunnelEvent`. Task 3의 `TunnelRunner`, `TunnelProcess`.
- Produces:

```rust
pub type TunnelSink = Arc<dyn Fn(TunnelEvent) + Send + Sync>;

/// 터널을 열지 못했다. `Display`는 화면에 그대로 보이는 영어 문장이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelError { pub host: String, pub port: u16, pub failure: TunnelFailure }
// Spawn     → "Could not run the tunnel command: {message}"
// Exited    → "The tunnel command exited with code {code} before {host}:{port} opened"
//             (code가 없으면 "The tunnel command was stopped by a signal before {host}:{port} opened")
// Timeout   → "{host}:{port} didn't open within {secs} seconds"
// Cancelled → "The tunnel start was cancelled"

#[must_use]
pub(crate) struct TunnelLease { /* 접속 이름, entry 번호 */ }
pub(crate) struct PrivateTunnel<P> { /* 띄운 프로세스. 포트가 이미 열려 있었으면 없음 */ }

impl<R: TunnelRunner> Tunnels<R> {
    pub(crate) fn new(runner: R, sink: TunnelSink) -> Self;
    /// 그 접속의 터널이 Ready나 External이 될 때까지 기다리고 lease를 준다.
    pub(crate) async fn acquire(&self, connection: &str, target: &TunnelTarget) -> Result<TunnelLease, TunnelError>;
    /// 마지막 lease면 터널을 끄고(External은 잊기만 한다) 꺼질 때까지 기다린다.
    pub(crate) async fn release(&self, lease: TunnelLease);
    /// Starting이면 멈추고 기다리던 acquire를 모두 Cancelled로 끝낸다. 아니면 아무것도 하지 않는다.
    pub(crate) async fn cancel(&self, connection: &str);
    /// Failed이고 lease가 있으면 처음부터(attempt 0) 다시 시작한다. 아니면 아무것도 하지 않는다.
    pub(crate) async fn restart(&self, connection: &str);
    /// 공유하지 않는 터널(접속 테스트). 포트가 열려 있으면 아무것도 띄우지 않는다.
    pub(crate) async fn start_private(&self, target: &TunnelTarget) -> Result<PrivateTunnel<R::Process>, TunnelError>;
    /// 앱 종료와 프로젝트 바꾸기. 모든 터널(시작 중, 재실행 중, private 포함)을 끄고 기다린다.
    /// 기다리던 acquire는 Cancelled로 끝난다. 그 뒤의 acquire는 평소처럼 새로 시작한다.
    pub(crate) async fn stop_all(&self);
}
impl<P: TunnelProcess> PrivateTunnel<P> { pub(crate) async fn stop(self); }
```

- Produces (test support): `FakeRunner`(`Clone`). `FakeProcess::mark_ready`는 아무것도 하지 않는다. `set_open(host, port, bool)`, `script(command, Vec<FakeRun>)`로 실행마다의 동작을 정한다. `FakeRun::OpensAfter(Duration)`(그 뒤 포트를 연다), `FakeRun::ExitsAfter(Duration, Option<i32>, &str stderr)`, `FakeRun::Hangs`, `FakeRun::SpawnFails(&str)`. `spawned() -> Vec<String>`, `running() -> usize`(stop되지 않은 프로세스 수), `kill(command)`(포트를 닫고 프로세스를 끝냄, 터널 끊김 흉내). `events_sink() -> (TunnelSink, Arc<Mutex<Vec<TunnelEvent>>>)`.

supervisor는 entry마다 tokio task 하나이고 상태를 `watch` channel로 내보낸다. 흐름:

```
start(attempt):
  emit Starting { attempt, timeout }
  if runner.is_open(host, port) → External (프로세스 없음)
  spawn 실패 → Failed(Spawn)
  200ms마다: process.wait()가 끝나면 → process.stop(); Failed(Exited { code, output })
             is_open이면 → Ready
  timeout 지나면 → process.stop(); Failed(Timeout { secs, output })
Ready: process.mark_ready()를 부른 뒤 process.wait()가 끝나면 → process.stop()(남은 자손 정리)
       attempt 1..=3: sleep 1s; start(attempt); Ready면 Ready로 돌아감
       3번 모두 실패 → 마지막 Failed
명령 Stop(lease 0, stop_all) → process.stop(); emit Stopped; entry 지움
명령 Cancel(Starting일 때만) → process.stop(); Failed(Cancelled)
```

acquire는 entry가 없거나 Failed면 attempt 0으로 시작시키고, External이면 포트를 다시 확인해 닫혔으면 attempt 0으로 시작시킨다. 같은 이름의 entry가 다른 target이거나 끄는 중이면 그 entry가 지워질 때까지 기다린다. acquire가 Failed로 끝나면 받았던 lease를 돌려놓는다(그 entry에 lease가 0이면 entry를 지운다).

- [x] **Step 1: test를 쓴다**

`tunnels.rs`의 `#[cfg(test)] mod tests`. 모두 `#[tokio::test(start_paused = true)]`. target은 `staging`(`command "tunnel"`, `localhost:25432`, 20초)이다.

| test | 단언 |
| --- | --- |
| `acquire_runs_the_command_and_waits_for_the_port` | `OpensAfter(3s)` → acquire가 `Ok`, `spawned() == ["tunnel"]`, event가 `[Starting{0,20s}, Ready]` |
| `acquire_with_an_open_port_is_external_and_runs_nothing` | `set_open(true)` → `Ok`, `spawned()`가 비었음, event `[Starting{0}, External]`. release 뒤 `running() == 0`이고 event 끝이 `Stopped` |
| `two_acquires_share_one_process` | 동시에 acquire 두 번 → `spawned().len() == 1`. 첫 release 뒤 `running() == 1`, 둘째 release 뒤 `0` |
| `timeout_stops_the_process_and_reports_output` | `Hangs`(stderr `"Unauthorized"`) → 20초 뒤 `Err(TunnelError { failure: Timeout { secs: 20, output: "Unauthorized" }, .. })`, `running() == 0`. `to_string() == "localhost:25432 didn't open within 20 seconds"` |
| `early_exit_fails_without_waiting_for_the_timeout` | `ExitsAfter(1s, Some(1), "Error: failed to open tunnel")` → 2초 안에 `Exited { code: Some(1), output }` |
| `spawn_failure_is_reported` | `SpawnFails("No such file")` → `Spawn { message }` |
| `exited_tunnel_is_run_again` | `OpensAfter(1s)` 두 번. `kill("tunnel")` 뒤 `spawned().len() == 2`, event에 `Starting{1}`와 그 뒤 `Ready`. 다시 kill하면 다음 event는 `Starting{1}`(횟수가 처음으로 돌아감) |
| `three_failed_runs_stop_with_the_last_output` | 첫 실행만 열리고 그 뒤 `ExitsAfter(0s, Some(1), "e1"/"e2"/"e3")` → kill 뒤 event `Starting{1}, Starting{2}, Starting{3}, Failed(Exited{output:"e3"})`. 실행 사이가 1초 이상이다 |
| `acquire_after_failure_starts_again_from_zero` | 위 상태에서 acquire → event `Starting{0}` |
| `restart_starts_a_failed_tunnel_again` | 위 상태에서 `restart("staging")` → event `Starting{0}`. Ready 상태에서 restart는 아무 event도 없다 |
| `cancel_fails_waiters_with_cancelled` | `Hangs`에 acquire 두 개, `cancel` → 둘 다 `Cancelled`, `running() == 0` |
| `acquire_waits_until_the_old_tunnel_of_the_name_is_gone` | target A로 lease, target B(`command "tunnel2"`)로 acquire 시작, A의 release는 100ms 뒤. A의 프로세스가 stop된 뒤에야 `"tunnel2"`가 spawn되고 B의 event에 `External`이 없다. `FakeProcess::stop`은 500ms 걸리게 둔다(끄는 중에도 포트가 열려 있음) |
| `stop_all_stops_starting_restarting_and_private_tunnels` | Starting 하나, 재실행 중(1초 대기 중) 하나, `start_private` 하나 → `stop_all` 뒤 `running() == 0`, 기다리던 acquire는 `Cancelled`. 그 뒤 acquire는 다시 spawn한다 |
| `private_tunnel_is_not_shared` | `start_private` 두 번 → `spawned().len() == 2`. 포트가 열려 있으면 spawn 없음. `stop` 뒤 `running() == 0`이고 sink에 event가 없다 |

- [x] **Step 2: test가 실패하는지 확인한다**

Run: `cargo test -p chilla-core --lib tunnels`
Expected: FAIL (compile error)

- [x] **Step 3: `FakeRunner`와 `Tunnels`를 구현한다**

`FakeProcess::wait`는 script대로 `tokio::time::sleep` 뒤 끝난다. 포트 상태는 `FakeRunner` 안의 `HashMap<(String, u16), bool>`이다. `Tunnels`의 entry 표는 `tokio::sync::Mutex<HashMap<String, Entry>>`이고 `Entry`는 target, lease 수, entry 번호, `watch::Receiver<TunnelState>`, supervisor에 명령을 보내는 `mpsc::Sender`, 끝을 기다리는 `JoinHandle`을 갖는다. lock을 쥔 채 기다리지 않는다.

- [x] **Step 4: test가 통과하는지 확인한다**

Run: `cargo test -p chilla-core --lib tunnels`
Expected: PASS

- [x] **Step 5: commit한다**

```bash
git add crates/chilla-core/src/application
git commit -m "feat: 접속마다 터널 하나를 공유하고 끊기면 다시 실행하는 Tunnels"
```

---

### Task 5: 세션과 접속 테스트가 터널을 쓴다

**Files:**
- Modify: `crates/chilla-core/src/application/app.rs`, `application/mod.rs`, `application/test_support/mod.rs`, `crates/chilla-core/tests/support/mod.rs`

**Interfaces:**
- Consumes: Task 4의 `Tunnels`, `TunnelLease`, `PrivateTunnel`, `TunnelError`, `TunnelSink`.
- Produces:
  - `App<C: Connector, T: TunnelRunner>`. `App::new(projects, passwords, splitter, files, connector, runner: T, on_tunnel: TunnelSink)`
  - `AppError::Tunnel(TunnelError)`(`#[error(transparent)]`처럼 `TunnelError`의 `Display`를 쓴다)
  - `App::cancel_tunnel(&self, connection: &str)`, `App::restart_tunnel(&self, connection: &str)`(둘 다 `Result<(), AppError>`, 프로젝트가 없으면 `NoProject`)
  - `App::shutdown(&self)`: 세션을 모두 닫고(lease를 풂) `stop_all`
  - application 밖으로 `TunnelRunner`, `TunnelProcess`, `SpawnError`, `TunnelError`, `TunnelSink`를 내보낸다

세션 표의 값은 `SessionEntry { handle: SessionHandle, tunnel: Option<TunnelLease> }`다. `open_session`은 비밀번호를 읽은 뒤 `tunnel_target()`이 있으면 acquire하고 연결한다. 연결이 실패하거나 그 사이 프로젝트가 바뀌면 lease를 풀고 돌아간다. 세션을 닫을 때는 DB 연결을 닫은 *뒤* lease를 푼다(기획서 4.2의 순서). 프로젝트를 바꿀 때(`switch_project`)는 세션을 모두 닫은 뒤 `stop_all`을 불러, 세션이 생기기 전이라 lease를 쥔 쪽이 없는 시작 중 터널과 접속 테스트의 터널도 끈다. `stop_all`은 그 뒤의 acquire를 막지 않는다. `test_connection`은 `start_private`로 띄우고 연결한 뒤 연결을 닫고 터널을 끈다(연결이 실패해도 끈다).

- [ ] **Step 1: test를 쓴다**

`app.rs`의 test fixture에 `FakeRunner`와 event sink를 더하고 `staging`(`FakeProjects`의 접속)에 `tunnel = "tunnel"`을 준다. `FakeConnector`와 `FakeRunner`가 같은 `Arc<Mutex<Vec<&'static str>>>` log에 `"db close"`, `"tunnel stop"`을 남기게 한다.

| test | 단언 |
| --- | --- |
| `open_session_starts_the_tunnel_first` | `OpensAfter(1s)` → `open_session("staging")`이 `Ok`, `spawned() == ["tunnel"]`. `local`(터널 없음)은 spawn이 없다 |
| `close_session_closes_the_database_before_the_tunnel` | close 뒤 log가 `["db close", "tunnel stop"]` |
| `sessions_of_one_connection_share_the_tunnel` | 세션 둘 → spawn 1번. 하나 닫으면 `running() == 1`, 둘 다 닫으면 `0` |
| `tunnel_failure_is_an_app_error_and_opens_no_connection` | `ExitsAfter(0s, Some(1), "nope")` → `Err(AppError::Tunnel(TunnelError { failure: Exited { .. }, .. }))`, `connector.connects() == 0` |
| `connect_failure_releases_the_tunnel` | connector가 `AuthFailed` → `running() == 0` |
| `switching_project_while_the_tunnel_starts_stops_it` | `Hangs`로 `open_session` 시작, 1초 뒤 `open_project("/q")` → `open_session`은 `ProjectChanged` 또는 `Tunnel(Cancelled)`, `running() == 0` |
| `test_connection_runs_a_private_tunnel_and_stops_it` | 저장 전 profile(`tunnel = "tunnel-test"`) → `Ok`, 끝난 뒤 `running() == 0`, sink에 event가 없다. 연결이 실패해도 `running() == 0` |
| `cancel_tunnel_stops_a_starting_tunnel` | `Hangs`로 `open_session` 시작, `cancel_tunnel("staging")` → `Err(Tunnel(Cancelled))` |
| `shutdown_closes_sessions_and_tunnels` | 세션 하나, Starting 하나 → `shutdown` 뒤 `running() == 0`, `session_state`는 `UnknownSession` |

- [ ] **Step 2: test가 실패하는지 확인한다**

Run: `cargo test -p chilla-core --lib app`
Expected: FAIL (compile error)

- [ ] **Step 3: 구현한다**

`close_all`은 `SessionEntry`마다 "닫고 lease 풀기"를 `JoinSet`으로 돌린다. `tests/support/mod.rs`의 `app_with_project()`가 `ShellTunnelRunner::new()`와 아무것도 하지 않는 sink로 App을 만들게 고친다(반환 type `App<PgConnector, ShellTunnelRunner>`).

- [ ] **Step 4: test가 통과하는지 확인한다**

Run: `cargo test -p chilla-core`
Expected: PASS

- [ ] **Step 5: commit한다**

```bash
git add crates
git commit -m "feat: 세션 열기와 접속 테스트가 터널을 띄우고 마지막 세션이 닫히면 끔"
```

---

### Task 6: Tauri command, event, 종료

**Files:**
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/error.rs`

**Interfaces:**
- Consumes: Task 5의 `App` API.
- Produces:
  - `pub type CoreApp = App<PgConnector, ShellTunnelRunner>`. `CoreApp`은 `tauri::Builder::setup`에서 만들고 `manage`한다. sink는 `AppHandle::emit("tunnel", TunnelEventDto)`다(실패는 무시)
  - event `tunnel`의 JSON: `{ "connection": "staging", "state": { "status": "starting", "attempt": 0, "timeoutSecs": 20 } }`. `status`는 `starting`, `ready`, `external`, `failed`, `stopped`. `failed`는 `reason`(`spawn`, `exited`, `timeout`, `cancelled`)과 그 칸(`message` / `code`, `output` / `secs`, `output`)을 펼친다
  - `CommandError { kind, message, output: Option<String> }`. `output`은 `None`이면 JSON에서 빠진다. kind: `tunnel_spawn`, `tunnel_exited`, `tunnel_timeout`, `tunnel_cancelled`. `output`은 `Exited`, `Timeout`일 때 stderr다
  - command `cancel_tunnel(connection: String)`, `restart_tunnel(connection: String)`
  - `RunEvent::Exit`에서 `close_all_sessions` 대신 `shutdown`

- [ ] **Step 1: test를 쓴다**

`commands.rs`: `tunnel_event_dto_shapes`가 다섯 상태와 네 실패의 JSON을 위 모양으로 단언한다(`serde_json::json!`과 비교). `error.rs`: `all_errors()`에 `AppError::Tunnel`의 네 실패를 kind와 함께 더하고, `tunnel_errors_carry_the_output`이 `Timeout`의 `output`이 `Some("Unauthorized")`, `Cancelled`의 JSON에 `output` key가 없음을 단언한다.

- [ ] **Step 2: test가 실패하는지 확인한다**

Run: `cargo test -p chillasql`
Expected: FAIL

- [ ] **Step 3: 구현한다**

`TunnelStateDto`는 `#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]`, 실패는 `#[serde(flatten)]`한 `TunnelFailureDto`(`tag = "reason"`)다(`OutcomeDto`와 같은 방식). `generate_handler!`에 두 command를 더한다.

- [ ] **Step 4: test가 통과하는지 확인한다**

Run: `cargo test -p chillasql && pnpm lint:rust`
Expected: PASS

- [ ] **Step 5: commit한다**

```bash
git add src-tauri
git commit -m "feat: 터널 상태 event와 cancel_tunnel, restart_tunnel command를 더하고 앱 종료 때 터널을 끔"
```

---

### Task 7: 실제 프로세스와 test DB로 터널 전체를 확인한다

**Files:**
- Create: `crates/chilla-core/tests/tunnels.rs`, `crates/chilla-core/tests/support/forward.py`

**Interfaces:**
- Consumes: Task 5의 `App`, Task 3의 `ShellTunnelRunner`, `tests/support`의 `app_with_project`, `admin`, `eventually`.
- Produces: 없음(test만)

`forward.py <listen_port> <target_port> <pid_file>`는 `127.0.0.1:<listen_port>`에서 받아 `127.0.0.1:<target_port>`(test DB 54318)로 잇는 thread forwarder다. 시작하면 자기 pid를 `pid_file`에 쓴다. 터널 명령은 `exec python3 <절대 경로>/forward.py <port> 54318 <pid_file>`이다. port는 test마다 `TcpListener::bind("127.0.0.1:0")`으로 빈 port를 얻어 쓴다.

- [ ] **Step 1: test를 쓴다**

| test | 단언 |
| --- | --- |
| `a_session_runs_through_the_tunnel` | `chilla.toml`에 터널 접속을 쓰고 `open_session` → `SELECT 1`이 `Completed`. `close_session` 뒤 그 port가 닫히고(`TcpStream::connect` 실패) pid가 없다 |
| `a_killed_tunnel_is_run_again_and_a_new_session_works` | pid에 `SIGKILL` → 첫 세션의 `session_state`가 `eventually` `Lost`, event에 `Starting { attempt: 1 }` 다음 `Ready`. 새 `open_session`이 `SELECT 1`을 `Completed`로 끝낸다 |
| `a_failing_command_reports_its_stderr` | 터널 명령 `echo 'Unauthorized. Please login' >&2; exit 1` → `AppError::Tunnel`의 `failure`가 `Exited { code: Some(1), output: "Unauthorized. Please login\n" }`이고 1초 안에 돌아온다 |
| `an_already_open_port_is_used_as_is` | forwarder를 test가 먼저 띄움 → event `External`, `close_session`과 `shutdown` 뒤에도 그 forwarder가 살아 있다 |
| `shutdown_leaves_no_tunnel_process` | 세션 둘(같은 접속)과 터널 하나 → `shutdown` 뒤 pid가 없다 |

- [ ] **Step 2: test가 실패하는지 확인한다**

Run: `cargo test -p chilla-core --test tunnels`
Expected: 구현은 Task 5에서 끝났으므로 통과해야 한다. 실패하면 원인을 Task 3~5에서 고친다. test가 정말 확인하는지 보려고 `ShellProcess::stop`의 `killpg`를 잠시 지우고 `shutdown_leaves_no_tunnel_process`가 실패하는 것을 본 뒤 되돌린다.

- [ ] **Step 3: test가 통과하는지 확인한다**

Run: `scripts/test-db.sh up && cargo test -p chilla-core --test tunnels`
Expected: PASS

- [ ] **Step 4: commit한다**

```bash
git add crates/chilla-core/tests
git commit -m "test: forwarder를 터널로 두고 재실행과 종료를 실제 프로세스로 확인함"
```

---

### Task 8: 화면의 터널 상태와 세션 재연결 (API, store)

**Files:**
- Create: `src/shared/api/events.ts`, `src/features/connections/tunnelsStore.ts`, `src/features/connections/tunnelsStore.test.ts`, `src/features/workspace/tunnelEvents.ts`, `src/features/workspace/tunnelEvents.test.ts`
- Modify: `src/shared/api/types.ts`, `commands.ts`, `errors.ts`, `commands.test.ts`, `src/features/query/runsStore.ts`, `runsStore.test.ts`, `runReducer.ts`, `src/features/workspace/commands.ts`, `commands.test.ts`, `src/test/resetStores.ts`

**Interfaces:**
- Consumes: Task 6의 event와 command, `CommandError.output`.
- Produces:

```ts
// types.ts
export type TunnelFailure =
  | { reason: "spawn"; message: string }
  | { reason: "exited"; code: number | null; output: string }
  | { reason: "timeout"; secs: number; output: string }
  | { reason: "cancelled" };
export type TunnelState =
  | { status: "starting"; attempt: number; timeoutSecs: number }
  | { status: "ready" }
  | { status: "external" }
  | ({ status: "failed" } & TunnelFailure)
  | { status: "stopped" };
export interface TunnelEvent { connection: string; state: TunnelState }

// events.ts
export function onTunnelEvent(handler: (event: TunnelEvent) => void): Promise<() => void>;
// commands.ts
export function cancelTunnel(connection: string): Promise<void>;
export function restartTunnel(connection: string): Promise<void>;
// errors.ts: CommandError에 readonly output: string | null (payload에 없으면 null)

// tunnelsStore.ts
export interface TunnelView {
  state: Exclude<TunnelState, { status: "stopped" }>;
  /** 이 상태를 받은 시각. 같은 상태가 다시 오면 그대로다 */
  since: number;
  /** 재실행(attempt ≥ 1) 중이었거나 그 끝에 온 상태면 true. 다음 attempt 0이나 ready에서 false로 돌아간다 */
  afterRestart: boolean;
}
export const useTunnels: { tunnels: Record<string, TunnelView>; apply(event: TunnelEvent, now?: number): void; reset(): void };

// tunnelEvents.ts
export function subscribeTunnelEvents(): Promise<() => void>;

// runReducer.ts
export interface Rejection { title: string; detail: string | null; output?: string; retry?: RunRequest }
// runsStore.ts (RunsState에 더함)
notices: Record<string, "reconnected">;
markStale(connection: string): void;
dismissNotice(tabId: string): void;

// workspace/commands.ts
export async function cancelRun(tabId: string): Promise<void>;
```

`RunRequest`는 `runsStore.ts`에서 `runReducer.ts`로 옮겨 순환 import를 피한다.

- [ ] **Step 1: test를 쓴다**

`tunnelsStore.test.ts`:
- `apply_keeps_the_latest_state_and_when_it_started`: `starting`(now 1000) → `since 1000`, 같은 attempt의 `starting`이 다시 와도 `since`는 그대로, `ready` → `since`가 새 now. `stopped` → key가 없어짐. `reset` → 비었음.
- `after_restart_marks_failures_of_a_rerun`: `starting{1}` → `failed` 순서면 `afterRestart === true`, `starting{0}` → `failed`면 `false`.

`tunnelEvents.test.ts`(events.ts는 mock):
- `restart_marks_sessions_stale`: `starting { attempt: 1 }` event → `useRuns.markStale("staging")`이 불림. `attempt: 0`은 부르지 않음. 모든 event가 `useTunnels.apply`로 감.

`runsStore.test.ts`:
- `a_stale_session_is_replaced_by_opening_first`: 실행 한 번 뒤 `markStale("staging")`, 다음 실행 → `openSession`이 `closeSession(옛 id)`보다 먼저 불림(call 순서), `notices[tab] === "reconnected"`.
- `a_lost_session_gives_a_reconnected_notice_on_the_next_run`: `connection_lost` event 뒤 다음 실행이 새 세션을 열면 `notices[tab] === "reconnected"`. 그다음 실행이 시작하면 notice가 지워짐. `dismissNotice`도 지움.
- `stale_marks_only_tabs_of_that_connection`: `local` 탭은 다음 실행에서 `openSession`을 다시 부르지 않음.
- `tunnel_cancelled_returns_the_tab_to_idle`: `openSession`이 `CommandError("tunnel_cancelled")`로 reject → `runs[tab].status === "idle"`.
- `tunnel_errors_keep_output_and_the_request_to_retry`: `CommandError("tunnel_timeout", "localhost:25432 didn't open within 20 seconds", "Unauthorized")` → rejection `{ title: message, output: "Unauthorized", retry: <그 RunRequest> }`.

`workspace/commands.test.ts`:
- `cancel_during_tunnel_start_cancels_the_tunnel`: 탭이 `connecting`이고 `useTunnels`의 `staging`이 `starting` → `cancelRun`이 `cancelTunnel("staging")`을 부르고 `useRuns.cancel`은 부르지 않음. 터널이 `ready`면 `useRuns.cancel`.
- 프로젝트를 바꾸면 `useTunnels.reset`이 불림.

- [ ] **Step 2: test가 실패하는지 확인한다**

Run: `pnpm vitest run src/features/connections src/features/query/runsStore.test.ts src/features/workspace`
Expected: FAIL

- [ ] **Step 3: 구현한다**

`SessionSlot`에 `stale: boolean`, 탭별로 "끊긴 세션을 대신해야 함" 표시(`lost: Set<string>`)를 둔다. `slotFor`는 같은 접속이고 stale이 아니면 그 slot, stale이면 새 세션을 연 *뒤* 옛 slot을 닫는다. 접속이 다르면 지금처럼 닫은 뒤 연다. `forget`이 `connection_lost`나 `unknown_session` 때문에 불리면 `lost`에 넣는다. 새 세션이 열렸을 때 stale을 대신했거나 `lost`에 있었으면 notice를 둔다. `execute("cancel")`은 `cancelRun(tabId)`을 부른다. `Workspace`가 mount될 때 `subscribeTunnelEvents()`를 부르고 unmount 때 해제한다. `switchProject`가 탭을 비울 때 `useTunnels.reset()`도 부른다.

- [ ] **Step 4: test가 통과하는지 확인한다**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 5: commit한다**

```bash
git add src
git commit -m "feat: 화면이 터널 상태를 받고 터널이 다시 시작되면 다음 실행에서 새 세션으로 바꿈"
```

---

### Task 9: 접속 sheet를 캔버스 배치로

**Files:**
- Modify: `src/features/connections/ConnectionForm.tsx`, `ConnectionForm.test.tsx`, `connectionValues.ts`, `connectionValues.test.ts`, `src/features/workspace/Workspace.tsx`, `src/shared/api/dialog.ts`, `src/shared/i18n/en.ts`
- 읽을 것: `docs/design/canvas/ConnectionForm.dc.html`(A, B), `Tokens.dc.html`

**Interfaces:**
- Consumes: Task 2의 `Connection.tunnelTimeout`, Task 8의 `CommandError.output`.
- Produces: `FormValues`에 `tunnel: string`, `tunnelTimeout: string`. `pickFile(extensions: string[]): Promise<string | null>`(`dialog.ts`).

배치(캔버스 A, B에서 color, read_only, statement_timeout을 뺀 것): header(새 접속은 "New Connection", 수정은 "Edit {name}"와 오른쪽의 "Name can't be changed") → Name(새 접속만) → group(host 와 port 96px, database와 user 두 칸, password와 "Saved in Keychain, never in chilla.toml") → group(sslmode segmented control) → group(tunnel textarea, 오른쪽 "Leave empty to connect directly", placeholder `ssh -N -L … or another tunnel command`, 내용이 있으면 2줄 아니면 1줄) → group(Advanced disclosure. 접힌 줄에 `tunnel_timeout · sslrootcert`, 펼치면 `tunnel_timeout`("Seconds · only with tunnel", placeholder `20`, 터널이 비면 disabled)과 `sslrootcert`(+ "Choose…", verify-full이 아니면 disabled)) → 알림 → footer(Test, 빈 칸, Cancel, Save). 처음에는 `tunnelTimeout`이나 `sslrootcert`가 있을 때만 펼친다. group 사이는 1px `line-1` 선, input 32px `bg-0`, sheet 600px `bg-2`, radius는 아래만 12px, 창 위쪽에 붙는다(`Workspace`의 scrim 안에서 `items-start`).

알림: 연결 대상을 바꿔 비밀번호를 지울 때(B의 lock 알림, password 칸 위), 테스트 성공 `Connected · {ms} ms`(check icon, ms는 오른쪽 mono), 실패는 error icon과 message, `output`이 있으면 그 아래 mono pre.

- [ ] **Step 1: test를 쓴다**

`connectionValues.test.ts`:
- `tunnel_is_trimmed_and_empty_means_none`: `"  ssh -L x  "` → `tunnel: "ssh -L x"`, `""` → `null`.
- `tunnel_timeout_is_whole_seconds_from_1_to_300`: `"30"` → `30`, `""` → `null`, `"0"`, `"301"`, `"2.5"`, `"20s"` → `{ error: t("connectionForm.tunnelTimeoutRange") }`.
- `tunnel_timeout_is_dropped_without_a_tunnel`: tunnel `""`, tunnelTimeout `"30"` → `tunnelTimeout: null`.
- `targetChanged`는 `tunnelTimeout`만 다르면 false.

`ConnectionForm.test.tsx`:
- `saves_the_tunnel_and_its_timeout`: tunnel에 입력, Advanced 펼쳐 `30` → `saveConnection`이 `{ tunnel, tunnelTimeout: 30 }`으로 불림.
- `tunnel_timeout_is_disabled_without_a_tunnel`.
- `a_failed_test_shows_the_command_output`: `testConnection`이 `CommandError("tunnel_timeout", "localhost:25432 didn't open within 20 seconds", "Unauthorized")`로 reject → `role="alert"` 안에 message와 `Unauthorized`.
- `a_passed_test_shows_the_time`: `performance.now`를 mock해 `Connected · 41 ms`.
- `choose_fills_sslrootcert`: verify-full에서 Choose → `pickFile(["pem", "crt"])`의 값이 input에 들어감.
- 기존 test(비밀번호 지움 알림, 이름 중복, port 범위)는 새 배치에서 그대로 통과해야 한다.

- [ ] **Step 2: test가 실패하는지 확인한다**

Run: `pnpm vitest run src/features/connections`
Expected: FAIL

- [ ] **Step 3: 구현한다**

`en.ts`에 `connectionForm.*`(passwordHint, nameFixed, tunnelHint, tunnelPlaceholder, advanced, tunnelTimeoutHint, sslrootcertHint, choose, connectedIn, tunnelTimeoutRange, commandOutput) 문구를 더한다. 문구는 캔버스의 영어 그대로다. segmented control은 `role="radiogroup"`과 `role="radio"` 버튼이다.

- [ ] **Step 4: test가 통과하는지 확인한다**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 5: commit한다**

```bash
git add src
git commit -m "feat: 접속 sheet를 캔버스 배치로 다시 만들고 tunnel과 tunnel_timeout 칸을 더함"
```

---

### Task 10: toolbar, 탭, 결과 panel의 터널 상태

**Files:**
- Create: `src/features/connections/TunnelStatus.tsx`, `TunnelStatus.test.tsx`, `src/features/query/TunnelPanels.tsx`, `TunnelPanels.test.tsx`
- Modify: `src/features/workspace/Toolbar.tsx`, `Toolbar.test.tsx`, `src/features/editor/TabBar.tsx`, `TabBar.test.tsx`, `src/features/query/ResultPane.tsx`, `ResultPane.test.tsx`, `src/features/workspace/Workspace.tsx`, `src/shared/ui/icons.tsx`, `src/shared/i18n/en.ts`
- 읽을 것: `docs/design/canvas/Tunnel.dc.html`(1~5)

**Interfaces:**
- Consumes: Task 8의 `useTunnels`, `useRuns().notices`, `dismissNotice`, `Rejection.output`, `Rejection.retry`, `cancelRun`, `restartTunnel`.
- Produces:
  - `useElapsedSeconds(since: number): number`(1초마다 다시 그림)
  - `TunnelChipStatus({ connection }: { connection: string })`: chip 안의 상태 칸(왼쪽 선, `text-small text-fg-2`). 없음/ready면 아무것도 그리지 않는다
  - `TunnelTabIcon({ connection }: { connection: string | null })`: 탭 제목 뒤 12px icon
  - `TunnelStarting`, `TunnelGaveUp`, `ReconnectedBanner`(`TunnelPanels.tsx`)
  - `ResultPane`에 `onEditConnection(name: string): void` prop. `Workspace`가 sheet를 연다

| 터널 상태 | chip 상태 칸 | 탭 icon(aria-label) | 결과 panel |
| --- | --- | --- | --- |
| `starting`, attempt 0 | spinner + `Starting tunnel` + mono `{n} / {total} s` | spinner (`Starting tunnel`) | 탭이 `connecting`이면 `TunnelStarting`: `Ran the tunnel command. Connects once {host}:{port} opens.`, 명령 pre, Cancel(`cancelRun`) |
| `starting`, attempt ≥ 1 | spinner + `Reconnecting` + mono `{n}/3` | spinner (`Reconnecting`) | 결과 위에 한 줄 `The tunnel process exited. Running the command again ({n}/3).` |
| `failed`(재실행 뒤) | x icon + `Tunnel failed` | error icon (`Tunnel failed`) | `TunnelGaveUp`: `Ran the tunnel 3 times but it didn't open, so it stopped.`, `Command output (stderr)` pre, Try again(`restartTunnel`) |
| `failed`(시작 실패) | x icon + `Tunnel failed` | error icon | 탭의 rejection: message, `Command output (stderr)` pre, Try again(`run(tabId, () => retry)`), Edit connection(ghost, `onEditConnection`) |
| `external` | 바깥 화살표 icon + `External tunnel`, hover tooltip | 같은 icon (`External tunnel`), hover tooltip | 없음. tooltip 문구 `{host}:{port} was already open, so the tunnel command didn't run. ChillaSQL won't close this tunnel when it quits.` |

`failed`가 재실행 뒤인지는 `TunnelView.afterRestart`로 가린다. notice가 `reconnected`면 결과 panel 맨 위에 `ReconnectedBanner`(refresh icon, `Reconnected`, `This is a new session, so session state such as SET values and temporary tables was reset.`, Close → `dismissNotice`). Cancel 버튼은 탭이 `connecting`이고 그 접속의 터널이 `starting`이면 켠다. tooltip은 `role="tooltip"`이고 `aria-describedby`로 잇는다.

- [ ] **Step 1: test를 쓴다**

- `TunnelStatus.test.tsx`: `useTunnels`에 상태를 넣고 위 표의 chip 문구와 탭 icon의 aria-label을 단언한다. fake timer로 3초 지나면 `3 / 20 s`. `external`에 hover하면 tooltip 문구가 보인다.
- `TunnelPanels.test.tsx`/`ResultPane.test.tsx`: 연결 중 + starting이면 명령 text와 Cancel, Cancel이 `cancelTunnel("staging")`을 부름. rejection에 `output`이 있으면 pre와 Try again, Try again이 같은 `RunRequest`로 `run`을 부름, Edit connection이 `onEditConnection("staging")`. 재실행 뒤 failed면 Try again이 `restartTunnel("staging")`. notice가 있으면 banner, Close가 notice를 지움.
- `Toolbar.test.tsx`: 연결 중 + 터널 starting이면 Cancel이 enabled, 터널 없는 연결 중이면 disabled(기존 test 유지).
- `TabBar.test.tsx`: 탭의 접속이 external이면 `External tunnel` icon.

- [ ] **Step 2: test가 실패하는지 확인한다**

Run: `pnpm vitest run src/features`
Expected: FAIL

- [ ] **Step 3: 구현한다**

icon은 캔버스의 path를 그대로 `icons.tsx`에 `ExternalTunnelIcon`, `ReconnectIcon`으로 더한다(spinner와 x는 있는 `SpinnerIcon`, `ErrorIcon`). 문구는 `tunnel.*`, `result.reconnected*` key로 `en.ts`에 둔다.

- [ ] **Step 4: test가 통과하는지 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit한다**

```bash
git add src
git commit -m "feat: toolbar, 탭, 결과 panel에 터널 상태와 Reconnected 알림을 그림"
```

---

### Task 11: 완료 확인 — 실제 터널, 재연결, 종료

**Files:**
- Modify: `docs/plans/M5-tunnel.md`, `docs/progress.md`, `docs/milestones.md`, `docs/spec.md`(달라진 것이 있으면)

**Interfaces:**
- Consumes: 전체.

앱은 `scripts/build-app.sh --debug`로 만든 `.app`으로 Claude가 직접 띄워 확인한다(진행상황 "앱 동작 확인 방법"). 사용자가 허락한 실제 터널 접속을 쓰고, 그 명령은 문서에 적지 않는다.

- [ ] **Step 1: 완료 기준을 확인한다**

| 확인 | 기준 |
| --- | --- |
| 접속 sheet에서 실제 터널 접속(`tunnel = "<터널 명령>"`, port 25432)을 만들고 Test | `Connected · {ms} ms`. 끝난 뒤 `lsof -i :25432`가 비었다 |
| 탭에서 `SELECT now()` 실행 | 결과 panel에 `Starting tunnel`과 초, 이어서 결과. toolbar chip의 상태 칸이 사라진다 |
| 같은 접속의 탭 둘 | 터널 CLI 프로세스가 하나 |
| 터널 CLI 프로세스를 `kill -9` | chip이 `Reconnecting 1/3`을 거쳐 사라진다. 다음 실행이 결과를 내고 `Reconnected` banner가 뜬다 |
| 앱 종료(`Cmd+Q`) | 터널 CLI와 그 자손 프로세스가 없고 `lsof -i :25432`가 비었다 |
| 터미널에서 먼저 터널을 띄우고 실행 | 탭과 chip에 `External tunnel`, 앱 종료 뒤에도 터미널의 터널이 살아 있다 |
| 없는 서비스 이름으로 실행 | 20초를 기다리지 않고 `Tunnel failed`와 stderr, Try again과 Edit connection |

- [ ] **Step 2: 문서를 갱신하고 commit한다**

이 계획의 체크박스를 체크하고, 확인하며 달라진 것을 이 파일의 "Task 11 실행에서 달라진 것"에 적는다. 진행상황의 마일스톤 현황, "지금", 작업 로그, 결정 기록을 갱신한다.

Run: `pnpm check`
Expected: 통과

```bash
git add docs
git commit -m "docs: M5 완료 확인 결과를 기록함"
```

M5가 끝나면 CLAUDE.md의 개발 순서대로 `simplify`, `code-review`(high), `superpowers:receiving-code-review`를 돌린다.
