# M1 접속·세션 코어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rust 쪽에서 프로젝트(`chilla.toml`)를 열고, 키체인의 비밀번호로 세션을 열고 닫을 수 있게 한다. 화면은 만들지 않는다.

**Architecture:** `chilla-core`를 `domain` ← `application` ← `infrastructure` module로 나눈다. 세션 하나는 DB 연결 하나를 가진 tokio task(session actor)이고, `application::App`이 프로젝트 하나와 세션 목록을 가진다. DB 연결은 앱이 TCP와 TLS handshake를 직접 하고 그 stream을 `TxTap`으로 감싸 `tokio-postgres`의 `connect_raw`에 넘긴다. `TxTap`은 서버가 보내는 ReadyForQuery의 상태 byte를 읽어 트랜잭션 상태를 알아낸다.

**Tech Stack:** Rust edition 2024, `tokio` 1, `tokio-postgres` 0.7, `tokio-rustls` 0.26 + `rustls` 0.23(`ring` provider), `rustls-platform-verifier` 0.7, `keyring-core` 1 + `apple-native-keyring-store` 1, `toml` 1, `serde` 1, `thiserror` 2, Tauri 2

**Spec:** [기획서](../spec.md) 4.1(접속 관리), 4.3(탭 = 세션), 5장(프로젝트 디렉토리), 7장(보안) / [마일스톤](../milestones.md) M1 / [구조](../architecture.md)

## 먼저 확인한 것 (계획 작성 중 확인)

마일스톤의 "먼저 확인할 것" 3개 중 2개는 세션 구조를 정하므로 계획을 쓰면서 `tokio-postgres` 0.7.18 source와 scratch test(test DB 대상, 저장소 밖)로 확인했다. 3번은 사람이 dialog를 봐야 해서 Task 1에 둔다.

| 확인할 것 | 결과 | 결정 |
| --- | --- | --- |
| 결과를 500행씩 나눠 받는 방법 | portal은 `Transaction`에서만 만들 수 있다. `query_raw`와 `simple_query_raw`가 돌려주는 stream은 backpressure가 걸린다(응답 channel 크기 1). 500행만 읽고 멈추면 서버는 `active/ClientWrite`로 기다린다. 그 상태에서 cancel을 보내고 stream을 끝까지 읽으면 버퍼에 있던 24,862행이 46ms에 비워지고 `57014`로 끝나며, 연결은 바로 다음 쿼리를 받는다 | **stream을 쓴다. portal은 쓰지 않는다.** portal은 Auto 모드에서도 트랜잭션을 열어 둬야 해서 4.3과 어긋나고 `VACUUM` 같은 문장을 못 돌린다. session actor가 stream을 갖고 500행씩 당겨 읽는다. 남은 결과 버리기는 cancel + drain이다. 구현은 M2 |
| 트랜잭션 상태 감지 방법 | `tokio-postgres`는 모든 곳에서 `Message::ReadyForQuery(_)`로 상태 값을 버린다. 공개 API가 없다. `connect_raw`에 넘기는 stream을 감싸 backend message framing을 따라가면 `Z` message의 상태 byte(`I`/`T`/`E`)를 읽을 수 있고, `BEGIN` → `T`, 오류 → `E`, `ROLLBACK` → `I`를 확인했다 | **stream tap(`TxTap`)을 쓴다.** SQL 파서로 `BEGIN`/`COMMIT`을 추적하는 방법은 추론이라 쓰지 않는다. TLS handshake를 `tokio-postgres` 밖에서 해야 평문 byte를 볼 수 있으므로 `tokio-postgres-rustls`는 쓰지 않고 `tokio-rustls`로 직접 한다. 그 결과 SCRAM channel binding은 쓰지 않는다 |
| 서명하지 않은 빌드의 키체인 확인 창 | Task 1에서 확인 | 결과와 무관하게 자동 test는 실제 키체인을 쓰지 않는다 |

## 이 계획에서 정한 것

기획서에 없거나 다르게 정한 것이다. Task 1에서 진행상황의 결정 기록과 기획서에, Task 2에서 구조 문서에 반영한다.

- `sslmode`는 `disable`(기본값), `require`, `verify-full` 세 값만 받는다. `prefer` 등 다른 값은 오류다.
- `chilla.toml`에 `sslrootcert`(PEM 파일 경로)를 추가한다. `verify-full`에서만 쓴다. 있으면 그 파일의 인증서만 신뢰하고(libpq와 같음), 없으면 macOS의 trust store로 확인한다. 상대 경로는 프로젝트 디렉토리 기준이다.
- `chilla.toml`에 모르는 항목이 있으면 오류다. 오타(`sslmod`)를 조용히 넘기지 않는다.
- 키체인 항목은 service `com.yuiyeong.chillasql`, account `<프로젝트 디렉토리 절대 경로>::<접속 이름>`이다.
- 연결 timeout은 10초다(TCP, TLS, 인증 포함). 연결의 `application_name`은 `ChillaSQL`이다.
- `keyring` crate 대신 `keyring-core` + `apple-native-keyring-store`를 쓴다. `keyring` 4가 platform이 하나인 앱에는 이 조합을 쓰라고 안내한다.
- `application` layer는 `tokio`의 runtime 기능(`sync`, `task`, `time`)을 쓸 수 있다. I/O는 계속 `infrastructure`에만 둔다.
- `pnpm check`가 test DB를 먼저 띄운다. `cargo test`가 test DB에 접속하기 때문이다.
- 화면 쪽 TypeScript wrapper(`src/shared/api/`)와 앱 종료 시 세션 정리는 M1에 넣지 않는다. 각각 M3, M5·M6에서 한다.

## Global Constraints

- macOS 전용. 다른 OS 대응 코드를 넣지 않는다.
- `chilla-core`는 `tauri`에 의존하지 않는다.
- 탭 = 세션. 세션 하나는 DB 연결 하나를 갖는다. connection pool을 쓰지 않는다.
- 비밀번호는 `domain::Password`로만 들고 다닌다. `Password`는 `Serialize`, `Display`, `Clone`을 구현하지 않고 `Debug`는 값을 가린다. Tauri command가 돌려주는 type에는 비밀번호 항목이 없다.
- 오류 message와 `Debug` 출력에 비밀번호와 접속 문자열을 넣지 않는다.
- 자동 test는 실제 키체인을 쓰지 않는다. 키체인을 쓰는 test는 `#[ignore]`로 두고 손으로 돌린다.
- `rustls`는 0.23을 쓴다. crates.io 최신이 `0.24.0-dev`라도 쓰지 않는다. crypto provider는 `ring`이다(`aws-lc-rs`를 dependency tree에 들이지 않는다).
- 사용자에게 보이는 오류 message(`Display`)는 한국어로 쓴다.
- test DB: `postgres://chilla:chilla@127.0.0.1:54318/chilla_test`. TLS test DB(Task 6): 같은 계정, port `54319`.
- 모든 명령은 저장소 루트에서 실행한다. commit 전에 `pnpm check`를 통과시킨다.
- commit 메시지는 영어 conventional prefix에 나머지는 한국어로 쓴다.

## Review Focus

1. **연결이 밖에서 끊긴 세션**(서버 재시작, `pg_terminate_backend`): `session_state`는 멈추지 않고 `Lost`를 돌려주고, `close_session`은 정상으로 끝나며 세션이 목록에서 빠져야 한다. → Task 5 Step 1, Task 7 Step 1
2. **응답하지 않는 host**(방화벽, 잘못된 IP, TCP는 받지만 말이 없는 서버): timeout 안에 `Timeout`으로 끝나야 한다. 무한정 기다리면 안 된다. → Task 5 Step 1
3. **비밀번호가 키체인에 없거나 틀린 접속**: `PasswordRequired`와 `AuthFailed`로 구분해 화면이 다시 입력받을 수 있어야 하고, 오류 어디에도 비밀번호가 없어야 한다. → Task 5 Step 1
4. **손으로 고친 `chilla.toml`의 잘못된 값**(`sslmod` 오타, `port = "5432"`, `sslmode = "prefer"`, `require`에 붙은 `sslrootcert`, 없는 `sslrootcert` 파일): 어느 접속의 무엇이 틀렸는지 알려 주고 거부해야 한다. 접속이 하나도 없는 파일은 정상이다. → Task 3 Step 1, Task 6 Step 3
5. **message가 TCP read 경계에 걸리는 경우**: 큰 DataRow 안에 `Z`처럼 보이는 byte가 있거나 header가 두 번의 read에 나뉘어 와도 `TxTap`이 상태를 잘못 읽으면 안 된다. → Task 5 Step 3

---

## File Structure

```
crates/chilla-core/src/
├── lib.rs                          pub mod domain, application, infrastructure
├── domain/
│   ├── connection.rs               ConnectionProfile, SslMode, ProfileError
│   ├── password.rs                 Password
│   ├── project.rs                  Project
│   └── session.rs                  SessionId, TxStatus, SessionInfo, SessionState
├── application/
│   ├── ports.rs                    ProjectStore, PasswordStore, Connector, DbConnection와 오류 type
│   ├── session_actor.rs            세션 하나의 task와 handle
│   └── app.rs                      App, AppError (use case)
└── infrastructure/
    ├── project_file.rs             TomlProjectStore
    ├── memory_password_store.rs    MemoryPasswordStore (test용)
    ├── keychain.rs                 KeychainPasswordStore
    └── postgres/
        ├── mod.rs                  PgConnector, PgConnection
        ├── tx_tap.rs               TxTap, TxStatusCell
        └── tls.rs                  SSLRequest와 rustls 설정
crates/chilla-core/tests/
├── support/mod.rs                  test DB profile, 확인용 연결
├── layer_deps.rs  project_file.rs  password_store.rs
└── connect.rs  tls.rs  sessions.rs
src-tauri/src/
├── lib.rs                          App 조립, command 등록
├── commands.rs                     command와 DTO
└── error.rs                        CommandError
```

각 `mod.rs`는 하위 module의 type을 `pub use`로 다시 내보낸다. 아래 Interfaces의 경로는 그 기준이다(예: `chilla_core::domain::Password`).

---

### Task 1: 키체인 확인 창 확인과 결정 기록 (먼저 확인할 것)

**Files:**
- Modify: `crates/chilla-core/Cargo.toml` (`keyring-core = "1"`, `apple-native-keyring-store = { version = "1", features = ["keychain"] }`)
- Create 후 Delete: `crates/chilla-core/examples/keychain_probe.rs`
- Modify: `docs/progress.md`, `docs/spec.md`, `docs/milestones.md`

**Interfaces:**
- Produces: `chilla-core`의 키체인 dependency(Task 4가 쓴다), 진행상황의 결정 기록

- [x] **Step 1: probe 작성**

`keychain_probe.rs`는 인자 `set | get | delete`를 받는 example이다. `apple_native_keyring_store::keychain::Store::new()`로 store를 만들고 `CredentialStoreApi::build("com.yuiyeong.chillasql.probe", "probe", None)`으로 entry를 얻어 `set_password("probe-value")`, `get_password()`, `delete_credential()`을 부른다. `get`은 걸린 시간과 성공 여부만 출력한다.

- [x] **Step 2: 같은 binary로 저장하고 읽기**

Run: `cargo run -p chilla-core --example keychain_probe -- set && cargo run -p chilla-core --example keychain_probe -- get`
Expected: dialog 없이 성공한다.

- [x] **Step 3: 다시 빌드한 binary로 읽기**

probe의 출력 문자열 하나를 바꿔 binary가 달라지게 한 뒤 실행한다. 이 step은 dialog가 뜨면 실행이 멈추므로, 실행 전에 사용자에게 화면을 봐 달라고 요청하고 결과(dialog가 떴는지, "항상 허용"을 누른 뒤 한 번 더 빌드하면 다시 뜨는지)를 받는다.

Run: `cargo run -p chilla-core --example keychain_probe -- get`
Expected: 둘 중 하나. (a) dialog 없이 성공. (b) "keychain_probe가 키체인의 기밀 정보를 사용하려고 합니다" dialog가 뜬다. ad-hoc 서명은 빌드마다 code hash가 바뀌므로 (b)를 예상한다.

- [x] **Step 4: 정리와 기록**

- `cargo run -p chilla-core --example keychain_probe -- delete` 후 `keychain_probe.rs`를 지운다.
- `docs/progress.md` 결정 기록에 "이 계획에서 정한 것"의 항목과 "먼저 확인한 것" 표의 결정 2개, Step 3의 결과를 한 줄씩 남긴다. M1 상태를 `진행 중`으로 바꾼다.
- Step 3이 (b)면 `docs/milestones.md` M3의 "먼저 확인할 것"에 한 줄을 추가한다: "`pnpm tauri dev` 빌드마다 키체인 확인 창이 뜬다. dev 빌드를 고정된 self-signed code signing identity로 서명할지 정한다". M1의 코드는 바뀌지 않는다.
- `docs/spec.md`를 고친다: 2장 표의 비밀번호 저장 행을 `keyring-core + apple-native-keyring-store (macOS 키체인)`으로, 4.1의 SSL 행에 `sslmode` 세 값과 `sslrootcert`를, 5장 `chilla.toml` 예시의 `production`에 `# sslrootcert = "certs/ca.pem"   # verify-full에서 이 CA만 신뢰` 주석 한 줄을, 7장 접속 비밀번호 행에 키체인 service와 account 형식을 넣는다.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: M1 먼저 확인할 것의 결과와 결정 기록"
```

---

### Task 2: layer 골격, domain type, 의존 방향 test

**Files:**
- Create: `crates/chilla-core/src/domain/{mod,connection,password,project,session}.rs`
- Create: `crates/chilla-core/src/application/mod.rs`, `crates/chilla-core/src/infrastructure/mod.rs` (빈 module)
- Modify: `crates/chilla-core/src/lib.rs`, `crates/chilla-core/Cargo.toml` (`thiserror = "2"`)
- Modify: `docs/architecture.md`
- Test: `crates/chilla-core/tests/layer_deps.rs`, 각 domain 파일의 `#[cfg(test)]`

**Interfaces:**
- Produces (`chilla_core::domain`):

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SslMode { Disable, Require, VerifyFull }
impl SslMode { pub fn as_str(self) -> &'static str }      // "disable" | "require" | "verify-full"
impl std::str::FromStr for SslMode { type Err = (); }      // 위 세 문자열만 받는다

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionProfile {
    pub name: String, pub host: String, pub port: u16, pub database: String, pub user: String,
    pub sslmode: SslMode,
    pub sslrootcert: Option<std::path::PathBuf>,   // 절대 경로
    pub tunnel: Option<String>,                    // M5가 쓴다
    pub color: Option<String>,                     // M6이 쓴다
}
impl ConnectionProfile { pub fn validate(&self) -> Result<(), ProfileError> }

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProfileError { EmptyField { field: &'static str }, ZeroPort, RootCertWithoutVerifyFull }

pub struct Password(String);
impl Password { pub fn new(value: String) -> Self; pub fn expose(&self) -> &str }

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project { pub dir: std::path::PathBuf, pub name: String, pub connections: Vec<ConnectionProfile> }
impl Project { pub fn connection(&self, name: &str) -> Option<&ConnectionProfile> }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SessionId(pub u64);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxStatus { Idle, InTransaction, Failed }
impl TxStatus { pub fn from_wire(byte: u8) -> Option<TxStatus> }   // b'I', b'T', b'E'
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionInfo { pub id: SessionId, pub connection: String, pub backend_pid: i32 }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState { Open { tx: TxStatus }, Lost }
```

- [x] **Step 1: 실패하는 test 작성**

`tests/layer_deps.rs`는 source 파일을 읽어 금지된 경로가 있는지 본다. 주석 줄(`//`로 시작)은 건너뛰고, 줄 안에 `<token>::` 또는 `use <token>`이 있으면 위반이다.

| layer | 금지 token |
| --- | --- |
| `domain` | `crate::application`, `crate::infrastructure`, `tokio`, `tokio_postgres`, `tokio_rustls`, `rustls`, `keyring_core`, `apple_native_keyring_store`, `toml`, `pg_query`, `std::fs`, `std::net`, `std::process` |
| `application` | `crate::infrastructure`, `tokio_postgres`, `tokio_rustls`, `rustls`, `keyring_core`, `apple_native_keyring_store`, `toml`, `pg_query`, `std::fs`, `std::net`, `std::process`, `tokio::net`, `tokio::fs`, `tokio::process` |

```rust
fn violations(layer: &str, source: &str) -> Vec<String>;   // 위반한 줄을 돌려준다

#[test] fn scanner_catches_a_violation() {
    assert_eq!(violations("domain", "use crate::infrastructure::keychain::X;").len(), 1);
    assert_eq!(violations("application", "let s = tokio::net::TcpStream::connect(a);").len(), 1);
    assert!(violations("application", "use tokio::sync::mpsc;").is_empty());
    assert!(violations("domain", "// tokio::net 은 쓰지 않는다").is_empty());
}
#[test] fn domain_and_application_follow_the_dependency_rule() {
    // src/domain, src/application 아래의 모든 .rs 파일에 violations가 없다.
    // 두 디렉토리가 없거나 .rs 파일이 0개면 실패한다.
}
#[test] fn core_does_not_depend_on_tauri() {
    // crates/chilla-core/Cargo.toml 에 "tauri" 가 없다.
}
```

domain 단위 test:

```rust
#[test] fn password_debug_hides_the_value() {
    assert_eq!(format!("{:?}", Password::new("hunter2".into())), "Password(***)");
}
#[test] fn sslmode_round_trips() {
    for s in ["disable", "require", "verify-full"] { assert_eq!(s.parse::<SslMode>().unwrap().as_str(), s); }
    assert!("prefer".parse::<SslMode>().is_err());
}
#[test] fn validate_rejects_bad_profiles() {
    // host, database, user, name 이 각각 "" 또는 "  " → EmptyField { field: "host" } 등
    // port 0 → ZeroPort
    // sslrootcert 가 Some 이고 sslmode 가 Require 또는 Disable → RootCertWithoutVerifyFull
    // 기획서 5장의 local 접속 → Ok
}
#[test] fn tx_status_from_wire() {
    assert_eq!(TxStatus::from_wire(b'I'), Some(TxStatus::Idle));
    assert_eq!(TxStatus::from_wire(b'T'), Some(TxStatus::InTransaction));
    assert_eq!(TxStatus::from_wire(b'E'), Some(TxStatus::Failed));
    assert_eq!(TxStatus::from_wire(b'X'), None);
}
```

- [x] **Step 2: 실패 확인**

Run: `cargo test -p chilla-core`
Expected: FAIL. `domain` module이 없어 compile error가 난다.

- [x] **Step 3: domain type 구현, 빈 `application`·`infrastructure` module 추가**

`ProfileError`의 `Display`는 한국어다(예: `host가 비어 있습니다`, `sslrootcert는 sslmode가 verify-full일 때만 쓸 수 있습니다`).

- [x] **Step 4: 통과 확인**

Run: `cargo test -p chilla-core`
Expected: PASS

- [x] **Step 5: `docs/architecture.md` 갱신**

- 2장 표의 `application` 행 "의존할 수 있는 것"을 `domain`, `tokio`의 runtime 기능(`sync`, `task`, `time`)으로 바꾼다.
- "의존 방향 검사" 문단을 `crates/chilla-core/tests/layer_deps.rs`가 검사한다는 내용과 위 금지 token 표로 바꾼다.
- 4장에 `pnpm check`가 `scripts/test-db.sh up`을 먼저 실행한다는 것과 Docker가 떠 있어야 한다는 것을 적는다(script 변경은 Task 5).

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: chilla-core layer 골격과 domain type, 의존 방향 test"
```

---

### Task 3: `chilla.toml` 읽기

**Files:**
- Create: `crates/chilla-core/src/application/ports.rs`, `crates/chilla-core/src/infrastructure/project_file.rs`
- Modify: `crates/chilla-core/Cargo.toml` (`toml = { version = "1", features = ["preserve_order"] }`, `serde = { version = "1", features = ["derive"] }`, dev `tempfile = "3"`)
- Test: `crates/chilla-core/tests/project_file.rs`

**Interfaces:**
- Consumes: Task 2의 `Project`, `ConnectionProfile`, `SslMode`, `ProfileError`
- Produces:

```rust
// chilla_core::application
pub trait ProjectStore: Send + Sync {
    fn load(&self, dir: &std::path::Path) -> Result<Project, ProjectError>;
}
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProjectError {
    NotFound { path: PathBuf },                      // dir/chilla.toml 이 없다
    Read { path: PathBuf, message: String },
    Parse { message: String },                       // TOML 문법, 모르는 항목, type 불일치, 빠진 필수 항목
    PasswordInConfig { connection: String },
    UnknownSslMode { connection: String, value: String },
    InvalidConnection { connection: String, source: ProfileError },
}
// chilla_core::infrastructure
pub struct TomlProjectStore;
impl ProjectStore for TomlProjectStore { .. }
```

파일 형식:

| 위치 | 항목 | 규칙 |
| --- | --- | --- |
| `[project]` | `name` | 선택. table이나 `name`이 없으면 디렉토리 이름 |
| `[connections.<이름>]` | `host`, `database`, `user` | 필수 |
| | `port` | 선택. 기본값 `5432` |
| | `sslmode` | 선택. 기본값 `disable` |
| | `sslrootcert` | 선택. 상대 경로면 프로젝트 디렉토리에 붙인다 |
| | `tunnel`, `color` | 선택. 문자열 그대로 보관 |

`Project.dir`은 `std::fs::canonicalize`한 절대 경로다. `connections`는 파일에 쓰인 순서다. `connections`가 없으면 빈 목록이다.

- [x] **Step 1: 실패하는 test 작성**

각 test는 `tempfile::tempdir()`에 `chilla.toml`을 쓰고 `TomlProjectStore.load(dir)`를 부른다.

```rust
#[test] fn loads_the_spec_example() {
    // 기획서 5장의 chilla.toml 예시 전체
    // name == "my-service", dir == canonicalize(tempdir)
    // connections 의 이름 순서 == ["production", "staging", "local"]
    // production: host "203.0.113.10", port 5432, sslmode Require, color Some("red"), tunnel None
    // staging: port 25432, tunnel Some("railway connect Postgres18 -e staging --tunnel-only -P 25432")
    // local: sslmode Disable
}
#[test] fn rejects_a_password_entry() {
    // [connections.local] 에 password = "x" → Err(PasswordInConfig { connection: "local" })
    // 키가 Password, PASSWORD 여도 같다
}
#[test] fn missing_file_is_not_found() { /* 빈 디렉토리 → Err(NotFound { path: dir/chilla.toml }) */ }
#[test] fn rejects_unknown_and_malformed_entries() {
    // sslmod = "require"   → Err(Parse { message }) 이고 message 에 "sslmod" 가 있다
    // [project] 에 nmae    → Err(Parse { .. })
    // port = "5432"        → Err(Parse { .. })
    // port = 70000         → Err(Parse { .. })
    // host 없음            → Err(Parse { message }) 이고 message 에 "host" 가 있다
    // sslmode = "prefer"   → Err(UnknownSslMode { connection: "local", value: "prefer" })
    // port = 0             → Err(InvalidConnection { connection: "local", source: ZeroPort })
    // sslmode = "require" + sslrootcert = "ca.pem" → Err(InvalidConnection { source: RootCertWithoutVerifyFull, .. })
}
#[test] fn resolves_sslrootcert_against_the_project_dir() {
    // sslmode = "verify-full", sslrootcert = "certs/ca.pem" → Some(dir.join("certs/ca.pem"))
    // sslrootcert = "/etc/ca.pem" → Some("/etc/ca.pem")
}
#[test] fn defaults() {
    // [project] 없음 → name 은 디렉토리 이름. connections 없음 → 빈 목록. port 없음 → 5432
}
```

- [x] **Step 2: 실패 확인**

Run: `cargo test -p chilla-core --test project_file`
Expected: FAIL. `TomlProjectStore`가 없어 compile error가 난다.

- [x] **Step 3: `ProjectStore`, `ProjectError`, `TomlProjectStore::load` 구현**

두 단계로 읽는다. 먼저 `toml::Table`로 읽어 각 접속 table에 이름이 `password`(ASCII 대소문자 무시)인 키가 있는지 본다. 그 다음 `#[serde(deny_unknown_fields)]`를 붙인 struct로 deserialize하고 `ConnectionProfile`로 옮긴 뒤 `validate()`를 부른다. `ProjectError`의 `Display`는 한국어이고 `PasswordInConfig`는 `접속 '<이름>'에 password 항목이 있습니다. 비밀번호는 설정 파일에 쓰지 않고 키체인에 저장합니다`다.

- [x] **Step 4: 통과 확인**

Run: `cargo test -p chilla-core`
Expected: PASS (`layer_deps` 포함)

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: chilla.toml 읽기와 password 항목 거부"
```

---

### Task 4: 비밀번호 저장소 (키체인)

**Files:**
- Modify: `crates/chilla-core/src/application/ports.rs`
- Create: `crates/chilla-core/src/infrastructure/memory_password_store.rs`, `crates/chilla-core/src/infrastructure/keychain.rs`
- Test: `crates/chilla-core/tests/password_store.rs`

**Interfaces:**
- Consumes: Task 2의 `Password`, Task 1의 키체인 dependency
- Produces:

```rust
// chilla_core::application
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PasswordKey { pub project_dir: PathBuf, pub connection: String }
pub trait PasswordStore: Send + Sync {
    fn get(&self, key: &PasswordKey) -> Result<Option<Password>, PasswordStoreError>;
    fn set(&self, key: &PasswordKey, password: &Password) -> Result<(), PasswordStoreError>;
    fn delete(&self, key: &PasswordKey) -> Result<(), PasswordStoreError>;   // 없는 항목이어도 Ok
}
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("키체인에 접근하지 못했습니다: {message}")]
pub struct PasswordStoreError { pub message: String }

// chilla_core::infrastructure
#[derive(Default)] pub struct MemoryPasswordStore { .. }
pub struct KeychainPasswordStore { .. }
impl KeychainPasswordStore { pub fn new() -> Result<Self, PasswordStoreError> }
```

키체인 항목: service `com.yuiyeong.chillasql`, account `format!("{}::{}", key.project_dir.display(), key.connection)`.

- [ ] **Step 1: 실패하는 test 작성**

```rust
fn contract(store: &dyn PasswordStore, project_dir: PathBuf) {
    let a = PasswordKey { project_dir: project_dir.clone(), connection: "a".into() };
    let b = PasswordKey { project_dir: project_dir.clone(), connection: "b".into() };
    let other = PasswordKey { project_dir: project_dir.join("other"), connection: "a".into() };
    assert!(store.get(&a).unwrap().is_none());
    store.set(&a, &Password::new("one".into())).unwrap();
    assert_eq!(store.get(&a).unwrap().unwrap().expose(), "one");
    store.set(&a, &Password::new("two".into())).unwrap();              // 덮어쓴다
    assert_eq!(store.get(&a).unwrap().unwrap().expose(), "two");
    assert!(store.get(&b).unwrap().is_none());                          // 접속 이름으로 구분
    assert!(store.get(&other).unwrap().is_none());                      // 프로젝트 경로로 구분
    store.delete(&a).unwrap();
    assert!(store.get(&a).unwrap().is_none());
    store.delete(&a).unwrap();                                          // 없어도 Ok
}
#[test] fn memory_store_follows_the_contract() { contract(&MemoryPasswordStore::default(), "/p".into()); }
#[test] #[ignore = "실제 키체인을 쓴다. 손으로 돌린다"]
fn keychain_store_follows_the_contract() {
    // project_dir 은 format!("/chilla-test/{}", std::process::id())
    // contract 가 중간에 실패해도 a 를 지우도록 끝에서 delete 를 한 번 더 부른다
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p chilla-core --test password_store`
Expected: FAIL. `MemoryPasswordStore`가 없어 compile error가 난다.

- [ ] **Step 3: port와 두 구현 작성**

`KeychainPasswordStore`는 `apple_native_keyring_store::keychain::Store::new()`를 들고 있다가 `CredentialStoreApi::build(service, account, None)`으로 entry를 만든다. `keyring_core::set_default_store`는 쓰지 않는다. `get_password`의 `keyring_core::Error::NoEntry`는 `Ok(None)`, `delete_credential`의 `NoEntry`는 `Ok(())`다. 그 밖의 오류는 `PasswordStoreError { message: err.to_string() }`다.

- [ ] **Step 4: 통과 확인**

Run: `cargo test -p chilla-core` 그리고 `cargo test -p chilla-core --test password_store -- --ignored`
Expected: 둘 다 PASS. 두 번째는 Task 1 Step 3이 (b)였다면 확인 창이 뜰 수 있다. 사용자에게 알리고 실행한다.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 키체인 비밀번호 저장소와 PasswordStore port"
```

---

### Task 5: DB 연결과 `TxTap` (TLS 없음)

**Files:**
- Modify: `crates/chilla-core/src/application/ports.rs`
- Create: `crates/chilla-core/src/infrastructure/postgres/{mod,tx_tap}.rs`
- Create: `crates/chilla-core/tests/support/mod.rs`
- Modify: `crates/chilla-core/Cargo.toml` (`tokio = { version = "1", features = ["net", "rt", "sync", "time", "io-util", "macros"] }`, `tokio-postgres = "0.7"`; dev에 `tokio`의 `rt-multi-thread` 추가)
- Modify: `package.json` (`check` 앞에 `scripts/test-db.sh up &&`)
- Test: `crates/chilla-core/tests/connect.rs`, `tx_tap.rs`와 `postgres/mod.rs`의 `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 2의 `ConnectionProfile`, `Password`, `TxStatus`
- Produces:

```rust
// chilla_core::application
pub trait Connector: Send + Sync + 'static {
    type Connection: DbConnection;
    fn connect(&self, profile: &ConnectionProfile, password: Option<&Password>)
        -> impl Future<Output = Result<Self::Connection, ConnectError>> + Send;
}
pub trait DbConnection: Send + 'static {
    fn backend_pid(&self) -> i32;
    fn tx_status(&self) -> TxStatus;
    fn is_closed(&self) -> bool;                                   // 연결이 밖에서 끊겼으면 true
    fn close(self) -> impl Future<Output = ()> + Send;             // 서버가 세션을 끝낼 때까지 기다린다
}
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConnectError {
    Unreachable { message: String },          // TCP 연결 실패, DNS 실패
    Timeout,
    TlsNotSupported,                          // Task 6
    Certificate { message: String },          // Task 6
    PasswordRequired,                         // 서버가 비밀번호를 요구하는데 없다
    AuthFailed { message: String },           // SQLSTATE 28P01, 28000
    Database { code: String, message: String },   // 그 밖의 서버 오류. 예: 3D000
    Other { message: String },
}

// chilla_core::infrastructure
pub struct PgConnector { .. }
impl PgConnector {
    pub fn new() -> Self;                                          // timeout 10초
    pub fn with_connect_timeout(timeout: std::time::Duration) -> Self;
}
impl Connector for PgConnector { type Connection = PgConnection; }
pub struct PgConnection { .. }
impl DbConnection for PgConnection { .. }

// infrastructure::postgres::tx_tap (crate 안에서만)
pub(crate) struct TxStatusCell(..);                                // Clone
impl TxStatusCell { pub(crate) fn get(&self) -> TxStatus }         // 첫 Z 전에는 Idle
pub(crate) struct TxTap<S> { .. }                                  // AsyncRead + AsyncWrite
impl<S> TxTap<S> {
    pub(crate) fn new(inner: S) -> (Self, TxStatusCell);
    fn observe(&mut self, bytes: &[u8]);                           // read한 byte를 순서대로 넘긴다
}

// tests/support/mod.rs
pub fn local_profile() -> ConnectionProfile;    // name "local", 127.0.0.1:54318, chilla_test, chilla, Disable
pub fn password() -> Password;                  // "chilla"
pub async fn admin() -> tokio_postgres::Client; // 확인용 직접 연결. 실패하면 "scripts/test-db.sh up 을 먼저 실행하세요"로 panic
pub async fn backend_exists(admin: &tokio_postgres::Client, pid: i32) -> bool;   // pg_stat_activity
pub async fn eventually(check: impl AsyncFnMut() -> bool) -> bool;                // 50ms 간격으로 최대 2초
```

- [ ] **Step 1: 실패하는 integration test 작성 (`tests/connect.rs`)**

```rust
#[tokio::test] async fn connects_and_closes() {
    // connect(local_profile, Some(password)) → backend_pid > 0, tx_status == Idle, !is_closed
    // admin 에서 그 pid 의 application_name == "ChillaSQL"
    // close().await 뒤 eventually(!backend_exists(pid))
}
#[tokio::test] async fn wrong_password_is_auth_failed_and_does_not_leak() {
    // Password "wrong-secret-9f3" → Err(AuthFailed { .. })
    // format!("{err} {err:?}") 에 "wrong-secret-9f3" 가 없다
}
#[tokio::test] async fn missing_password_is_password_required() { /* password None → Err(PasswordRequired) */ }
#[tokio::test] async fn unknown_database_is_a_database_error() {
    // database "no_such_db" → Err(Database { code, .. }) 이고 code == "3D000"
}
#[tokio::test] async fn closed_port_is_unreachable() { /* port 1 → Err(Unreachable { .. }) */ }
#[tokio::test] async fn silent_server_times_out() {
    // tokio::net::TcpListener 를 127.0.0.1:0 에 열고 accept 한 socket 을 들고만 있는다
    // PgConnector::with_connect_timeout(300ms) → Err(Timeout), 걸린 시간 < 2초
}
#[tokio::test] async fn terminated_backend_is_detected() {
    // connect 뒤 admin 에서 SELECT pg_terminate_backend(pid)
    // eventually(conn.is_closed()), 그 뒤 close().await 가 1초 안에 끝난다
}
```

- [ ] **Step 2: 실패 확인**

Run: `scripts/test-db.sh up && cargo test -p chilla-core --test connect`
Expected: FAIL. `PgConnector`가 없어 compile error가 난다.

- [ ] **Step 3: `TxTap` 단위 test 작성과 구현**

`observe`는 backend message framing을 따라간다. message는 type 1 byte + 길이 4 byte(big-endian, 길이 자신 포함) + payload다. header 5 byte를 모으고, type이 `Z`면 다음 1 byte를 `TxStatus::from_wire`로 읽어 cell에 쓰고, 아니면 payload `길이 - 4` byte를 복사 없이 건너뛴다. 상태는 header buffer(5 byte), 모은 수, 건너뛸 수뿐이다. `AsyncRead::poll_read`는 inner가 새로 채운 구간만 `observe`에 넘기고, `AsyncWrite`는 inner에 그대로 넘긴다.

```rust
fn msg(ty: u8, payload: &[u8]) -> Vec<u8>;   // test helper

#[test] fn reads_status_from_ready_for_query() {
    // observe(msg(b'Z', b"T")) → InTransaction. 이어서 msg(b'Z', b"E") → Failed, msg(b'Z', b"I") → Idle
}
#[test] fn starts_idle() { /* observe 전 cell.get() == Idle */ }
#[test] fn result_is_the_same_at_every_split_point() {
    // bytes = msg(b'R', &[0,0,0,0]) + msg(b'D', &[7; 300]) + msg(b'Z', b"T")
    // 모든 i 에 대해 observe(&bytes[..i]); observe(&bytes[i..]) → InTransaction
    // 1 byte 씩 넘겨도 InTransaction
}
#[test] fn payload_that_looks_like_ready_for_query_is_ignored() {
    // observe(msg(b'D', b"Z\0\0\0\x05E") + msg(b'Z', b"I")) → Idle
    // observe(msg(b'D', b"Z\0\0\0\x05E")) 만 넘기면 Idle 그대로 (Failed 가 아니다)
}
#[test] fn last_status_wins_within_one_buffer() { /* msg(Z,T) + msg(C,"BEGIN\0") + msg(Z,E) → Failed */ }
```

Run: `cargo test -p chilla-core tx_tap`
Expected: 구현 전 FAIL, 구현 후 PASS

- [ ] **Step 4: `PgConnector`, `PgConnection` 구현**

연결 순서는 다음과 같고 전체를 `tokio::time::timeout(connect_timeout, ..)`으로 감싼다.

1. `TcpStream::connect((host, port))` 후 `set_nodelay(true)`. 실패는 `Unreachable`.
2. `profile.sslmode`가 `Disable`이 아니면 `ConnectError::Other { message: "SSL은 아직 지원하지 않습니다" }`를 돌려준다. Task 6이 이 자리를 바꾼다.
3. `TxTap::new(stream)`.
4. `tokio_postgres::Config`에 `user`, `dbname`, `application_name("ChillaSQL")`, `ssl_mode(SslMode::Disable)`, 비밀번호가 있으면 `password`를 넣고 `connect_raw(tap, NoTls)`.
5. 돌려받은 `Connection`을 `tokio::spawn`하고 `JoinHandle`을 보관한다.
6. `SELECT pg_backend_pid()`로 pid를 얻는다.

오류 변환: `as_db_error()`가 있으면 SQLSTATE `28P01`·`28000`은 `AuthFailed`, 나머지는 `Database { code, message }`다. message는 서버의 `message()`만 쓴다. `tokio_postgres`가 비밀번호 없이 인증 요청을 받았을 때 내는 오류는 문자열이 `password missing`을 포함하는지로 판별해 `PasswordRequired`로 바꾼다(공개된 kind가 없다. `missing_password_is_password_required` test가 이 문자열을 고정한다). 나머지는 `Other`다.

`close`는 `Client`를 drop하고 `JoinHandle`을 await한다. `is_closed`는 `Client::is_closed()`다. `ConnectError`의 `Display`는 한국어다.

- [ ] **Step 5: 실제 서버로 `TxTap` 확인 (`postgres/mod.rs`의 `#[cfg(test)]`)**

```rust
#[tokio::test] async fn tx_status_follows_the_server() {
    // test DB 에 connect (profile 은 이 test 안에 직접 쓴다)
    // conn.client.batch_execute("BEGIN") → tx_status() == InTransaction
    // batch_execute("SELECT 1/0") 는 Err → Failed
    // batch_execute("ROLLBACK") → Idle
}
```

- [ ] **Step 6: `package.json`의 `check`를 `scripts/test-db.sh up && pnpm format:check && ...`로 바꾸고 통과 확인**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: tokio-postgres 연결과 ReadyForQuery 상태를 읽는 TxTap"
```

---

### Task 6: SSL (`require`, `verify-full`)

**Files:**
- Create: `crates/chilla-core/src/infrastructure/postgres/tls.rs`
- Modify: `crates/chilla-core/src/infrastructure/postgres/mod.rs`
- Modify: `crates/chilla-core/Cargo.toml` (`tokio-rustls = { version = "0.26", default-features = false, features = ["ring", "tls12", "logging"] }`, `rustls = { version = "0.23", default-features = false, features = ["ring", "std", "tls12", "logging"] }`, `rustls-platform-verifier = "0.7"`)
- Modify: `compose.yaml` (service `db-tls`), `scripts/test-db.sh` (인증서 생성), `.gitignore` (`db/tls/`)
- Modify: `crates/chilla-core/tests/support/mod.rs`
- Test: `crates/chilla-core/tests/tls.rs`

**Interfaces:**
- Consumes: Task 5의 `PgConnector`, `ConnectError`, `TxTap`
- Produces:

```rust
// infrastructure::postgres::tls (crate 안에서만)
pub(crate) async fn negotiate(tcp: TcpStream, profile: &ConnectionProfile)
    -> Result<tokio_rustls::client::TlsStream<TcpStream>, ConnectError>;

// tests/support/mod.rs
pub fn tls_profile(host: &str, sslmode: SslMode, sslrootcert: Option<&str>) -> ConnectionProfile;
// port 54319. sslrootcert 는 db/tls/ 아래 파일 이름("ca.crt")이고 절대 경로로 바꿔 넣는다
pub async fn tls_admin() -> tokio_postgres::Client;   // 54319 에 NoTls 로 붙는 확인용 연결
```

TLS test DB:

| 항목 | 값 |
| --- | --- |
| 접속 | `127.0.0.1:54319`, 계정과 DB는 test DB와 같다. seed 없음 |
| `db/tls/ca.crt`, `ca.key` | test CA |
| `db/tls/server.crt`, `server.key` | CA가 서명한 서버 인증서. CN `localhost`, SAN은 `DNS:localhost`만 (IP SAN 없음), `extendedKeyUsage=serverAuth` |
| `db/tls/other-ca.crt` | 서버 인증서와 무관한 CA |

- [ ] **Step 1: TLS test DB 추가**

- `scripts/test-db.sh`의 `up`은 `db/tls/server.crt`가 없으면 `docker compose up` 전에 `openssl`로 위 파일을 만든다. CA 두 개는 `openssl req -x509 -newkey rsa:2048 -nodes -days 3650`, 서버 인증서는 CSR을 만든 뒤 `openssl x509 -req ... -extfile`로 SAN과 EKU를 넣는다(macOS의 LibreSSL에서 동작하는 option만 쓴다). `reset`은 `db/tls`도 지운다.
- `compose.yaml`에 service `db-tls`를 추가한다. image와 환경 변수는 `db`와 같고 port는 `127.0.0.1:54319:5432`, volume은 `./db/tls:/certs:ro`뿐이다(init SQL과 named volume 없음). PostgreSQL은 key 파일이 `postgres` 소유에 `0600`이어야 하므로 command에서 복사한다.

```yaml
    command:
      - sh
      - -c
      - |
        cp /certs/server.crt /certs/server.key /var/lib/postgresql/ &&
        chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key &&
        chmod 600 /var/lib/postgresql/server.key &&
        exec docker-entrypoint.sh postgres -c ssl=on \
          -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key
```

- healthcheck는 `db`와 같은 명령에 `interval: 2s`, `retries: 30`이다.
- `.gitignore`에 `db/tls/`를 추가한다.

Run: `scripts/test-db.sh reset && docker compose exec -T db-tls psql -U chilla -d chilla_test -tAc "SHOW ssl"`
Expected: `on`

- [ ] **Step 2: 실패하는 test 작성 (`tests/tls.rs`)**

```rust
#[tokio::test] async fn require_encrypts_without_verifying() {
    // tls_profile("127.0.0.1", Require, None) 로 connect → Ok
    // tls_admin 에서 SELECT ssl FROM pg_stat_ssl WHERE pid = <backend_pid> → true
}
#[tokio::test] async fn verify_full_accepts_the_right_certificate() {
    // tls_profile("localhost", VerifyFull, Some("ca.crt")) → Ok, pg_stat_ssl.ssl == true
}
#[tokio::test] async fn verify_full_rejects_a_hostname_mismatch() {
    // tls_profile("127.0.0.1", VerifyFull, Some("ca.crt")) → Err(Certificate { .. })
}
#[tokio::test] async fn verify_full_rejects_an_untrusted_ca() {
    // tls_profile("localhost", VerifyFull, Some("other-ca.crt")) → Err(Certificate { .. })
    // tls_profile("localhost", VerifyFull, None) → Err(Certificate { .. })   (macOS trust store 에 없는 CA)
}
#[tokio::test] async fn verify_full_reports_an_unreadable_root_cert() {
    // sslrootcert 가 없는 파일 → Err(Certificate { message }) 이고 message 에 그 경로가 있다
    // sslrootcert 가 PEM 인증서가 아닌 파일(Cargo.toml) → Err(Certificate { .. })
}
#[tokio::test] async fn require_against_a_server_without_ssl_is_tls_not_supported() {
    // local_profile() 의 sslmode 만 Require 로 (port 54318) → Err(TlsNotSupported)
}
#[tokio::test] async fn tx_tap_works_over_tls() {
    // Require 로 connect → tx_status() == Idle  (TLS 뒤에서도 첫 Z 를 읽는다)
}
```

- [ ] **Step 3: 실패 확인**

Run: `cargo test -p chilla-core --test tls`
Expected: FAIL. `require_against_a_server_without_ssl_is_tls_not_supported`를 포함해 연결하는 test가 Task 5 Step 4의 `Other`로 실패한다.

- [ ] **Step 4: `negotiate` 구현, `PgConnector`에 연결**

1. SSLRequest 8 byte(`00 00 00 08 04 D2 16 2F`)를 쓰고 `read_exact`로 1 byte만 읽는다. `S`면 계속, `N`이면 `TlsNotSupported`, 그 밖은 `Other`.
2. `rustls::ClientConfig`는 `builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))`에서 시작해 `with_safe_default_protocol_versions()` 후 verifier를 고른다.

| 조건 | verifier |
| --- | --- |
| `Require` | 인증서와 hostname을 확인하지 않는 `ServerCertVerifier`. signature 확인(`verify_tls12_signature`, `verify_tls13_signature`, `supported_verify_schemes`)은 provider의 `signature_verification_algorithms`에 맡긴다 |
| `VerifyFull` + `sslrootcert` 있음 | 그 PEM 파일의 인증서만 넣은 `RootCertStore`로 만든 `WebPkiServerVerifier`. 파일을 못 읽거나 인증서가 0개면 `Certificate` |
| `VerifyFull` + `sslrootcert` 없음 | `rustls_platform_verifier::Verifier::new(provider)` |

3. `ServerName::try_from(profile.host.clone())`으로 이름을 만들고(IP 주소도 받는다) `tokio_rustls::TlsConnector::connect`를 부른다.
4. handshake 오류의 `io::Error` 안에 `rustls::Error::InvalidCertificate`가 있으면 `Certificate { message }`, 아니면 `Other`.

`PgConnector`는 Task 5 Step 4의 2번 자리에서 `negotiate`를 부르고, 돌려받은 `TlsStream`을 `TxTap`으로 감싼다. `connect_raw`에는 계속 `SslMode::Disable`과 `NoTls`를 넘긴다(`tokio-postgres`는 이미 암호화된 stream인 줄 모른다).

- [ ] **Step 5: 통과 확인**

Run: `pnpm check`
Expected: PASS

Run: `cargo tree -p chilla-core -i aws-lc-rs`
Expected: `did not match any packages` 오류. `aws-lc-rs`가 tree에 없다.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: sslmode require, verify-full 연결과 TLS test DB"
```

---

### Task 7: session actor와 `App`

**Files:**
- Create: `crates/chilla-core/src/application/session_actor.rs`, `crates/chilla-core/src/application/app.rs`
- Test: `crates/chilla-core/tests/sessions.rs`, `app.rs`의 `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 3의 `ProjectStore`, Task 4의 `PasswordStore`·`PasswordKey`·`MemoryPasswordStore`, Task 5의 `Connector`·`DbConnection`·`ConnectError`·`PgConnector`
- Produces:

```rust
// chilla_core::application
pub struct App<C: Connector> { .. }
impl<C: Connector> App<C> {
    pub fn new(projects: Arc<dyn ProjectStore>, passwords: Arc<dyn PasswordStore>, connector: C) -> Self;
    pub async fn open_project(&self, dir: &Path) -> Result<Project, AppError>;
    pub async fn set_password(&self, connection: &str, password: Password) -> Result<(), AppError>;
    pub async fn has_password(&self, connection: &str) -> Result<bool, AppError>;
    pub async fn delete_password(&self, connection: &str) -> Result<(), AppError>;
    pub async fn test_connection(&self, profile: ConnectionProfile, password: Option<Password>) -> Result<(), AppError>;
    pub async fn open_session(&self, connection: &str) -> Result<SessionInfo, AppError>;
    pub async fn session_state(&self, id: SessionId) -> Result<SessionState, AppError>;
    pub async fn close_session(&self, id: SessionId) -> Result<(), AppError>;
    pub async fn close_all_sessions(&self);
}
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum AppError {
    NoProject,                                   // 프로젝트를 열기 전
    UnknownConnection { name: String },
    UnknownSession { id: SessionId },
    Project(#[from] ProjectError),
    InvalidProfile(#[from] ProfileError),
    PasswordStore(#[from] PasswordStoreError),
    Connect(#[from] ConnectError),
}

// application::session_actor (crate 안에서만)
pub(crate) struct SessionHandle { .. }
pub(crate) fn spawn<D: DbConnection>(info: SessionInfo, connection: D) -> SessionHandle;
impl SessionHandle {
    pub(crate) fn info(&self) -> &SessionInfo;
    pub(crate) async fn state(&self) -> SessionState;
    pub(crate) async fn close(self);
}
```

동작 규칙:

- session actor는 `DbConnection`을 혼자 갖는 task다. `mpsc` channel(크기 8)로 명령 `State(oneshot::Sender<SessionState>)`와 `Close(oneshot::Sender<()>)`를 받는다. M2가 실행 명령을 이 enum에 더한다.
- `State`: `is_closed()`면 `Lost`, 아니면 `Open { tx: tx_status() }`.
- `Close`: `connection.close().await` 후 응답하고 task를 끝낸다. handle이 모두 drop돼 channel이 닫혀도 `close`하고 끝낸다.
- actor가 이미 끝났으면 `SessionHandle::state`는 `Lost`, `close`는 그냥 끝난다.
- `App`의 상태는 프로젝트 하나(`Option<Project>`)와 `HashMap<SessionId, SessionHandle>`이고 `tokio::sync::Mutex` 하나로 지킨다. `SessionId`는 1부터 올라가는 `AtomicU64`다.
- `open_project`: 새 프로젝트를 먼저 읽고, 성공하면 열려 있던 세션을 모두 닫은 뒤 바꾼다. 읽기에 실패하면 이전 프로젝트와 세션은 그대로다.
- `open_session`: 프로젝트에서 접속을 찾고, 키체인에서 비밀번호를 찾아(없으면 `None`) 연결한다. 연결하는 동안 lock을 잡지 않는다. 연결된 뒤 프로젝트가 바뀌어 있으면 연결을 닫고 `NoProject`를 돌려준다.
- `test_connection`: 프로젝트가 열려 있어야 한다(아니면 `NoProject`). `profile.validate()` 후 넘겨받은 비밀번호로 연결한다. 비밀번호가 `None`이면 `PasswordKey { 현재 프로젝트 dir, profile.name }`으로 키체인을 찾는다. 연결되면 바로 닫는다. 세션 목록에 넣지 않는다.
- `PasswordStore` 호출은 blocking이므로 `tokio::task::spawn_blocking` 안에서 한다.
- `close_session`: 목록에서 빼고 `close`한다. `Lost`인 세션도 `Ok`다. 없는 id는 `UnknownSession`.

- [ ] **Step 1: 실패하는 test 작성**

`app.rs`의 단위 test는 가짜 `Connector`를 쓴다. 가짜 연결은 `Arc<AtomicBool>` 두 개(`closed`, `lost`)를 공유해 test가 `close` 호출을 확인하고 끊김을 흉내 낸다.

```rust
#[tokio::test] async fn commands_before_open_project_are_no_project() {
    // open_session("local"), set_password, has_password, test_connection → Err(NoProject)
}
#[tokio::test] async fn open_session_unknown_connection() { /* Err(UnknownConnection { name: "nope" }) */ }
#[tokio::test] async fn open_session_passes_the_stored_password() {
    // set_password("local", "pw") 뒤 open_session("local") → 가짜 Connector 가 받은 비밀번호 == Some("pw")
    // delete_password 뒤 open_session → None, has_password == false
}
#[tokio::test] async fn lost_session_reports_lost_and_still_closes() {
    // open_session 뒤 lost 를 true 로 → session_state == Lost
    // close_session → Ok, 다시 session_state → Err(UnknownSession)
}
#[tokio::test] async fn opening_another_project_closes_sessions() {
    // 세션 2개를 연 뒤 다른 디렉토리로 open_project → 두 가짜 연결의 closed == true
    // chilla.toml 이 없는 디렉토리로 open_project → Err(Project(NotFound)), 기존 세션의 session_state 는 Open
}
#[tokio::test] async fn test_connection_does_not_register_a_session() {
    // test_connection(profile, Some(pw)) → Ok, 가짜 연결의 closed == true
    // 잘못된 profile(port 0) → Err(InvalidProfile(ZeroPort)), Connector 는 불리지 않는다
    // password None 이고 키체인에 있으면 그 값을 Connector 가 받는다
}
```

`tests/sessions.rs`는 실제 구성(`TomlProjectStore`, `MemoryPasswordStore`, `PgConnector`)을 쓴다. tempdir의 `chilla.toml`에는 test DB를 가리키는 `local` 접속 하나를 쓴다.

```rust
#[tokio::test] async fn two_sessions_open_and_close_independently() {   // M1 완료 기준
    // open_project → set_password("local", "chilla")
    // a = open_session("local"), b = open_session("local")
    // a.id != b.id, a.backend_pid != b.backend_pid, 둘 다 admin 의 pg_stat_activity 에 있다
    // session_state(a.id) == Open { tx: Idle }
    // close_session(a.id) → eventually(a 의 pid 없음), b 의 pid 는 있다, session_state(b.id) 는 Open
    // close_session(b.id) → eventually(b 의 pid 없음)
    // close_session(a.id) → Err(UnknownSession { id: a.id })
}
#[tokio::test] async fn session_without_stored_password_is_password_required() {
    // set_password 없이 open_session("local") → Err(Connect(PasswordRequired))
}
#[tokio::test] async fn terminated_session_is_lost() {            // Review Focus 1
    // open_session 뒤 admin 에서 pg_terminate_backend(pid)
    // eventually(session_state == Lost), close_session → Ok
}
#[tokio::test] async fn close_all_sessions_closes_everything() {
    // 세션 3개 → close_all_sessions → eventually(세 pid 모두 없음)
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p chilla-core --test sessions`
Expected: FAIL. `App`이 없어 compile error가 난다.

- [ ] **Step 3: `session_actor`와 `App` 구현**

`AppError`의 `Display`는 한국어이고, 안에 든 오류가 있으면 그 `Display`를 그대로 보여 준다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS (`layer_deps`가 `application`에서 `tokio::net` 등을 쓰지 않았는지 확인한다)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: session actor와 프로젝트·세션 use case"
```

---

### Task 8: Tauri command 경계

**Files:**
- Create: `src-tauri/src/commands.rs`, `src-tauri/src/error.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml` (`serde = { version = "1", features = ["derive"] }`, dev `serde_json = "1"`)
- Test: `commands.rs`와 `error.rs`의 `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 7의 `App`, `AppError`; `TomlProjectStore`, `KeychainPasswordStore`, `PgConnector`
- Produces: Tauri command 8개. M3가 `src/shared/api/`에서 부른다. JSON 키는 camelCase다.

| command | 인자 | 돌려주는 값 |
| --- | --- | --- |
| `open_project` | `path: String` | `ProjectDto { name, dir, connections: ConnectionDto[] }` |
| `set_password` | `connection: String`, `password: String` | 없음 |
| `has_password` | `connection: String` | `bool` |
| `delete_password` | `connection: String` | 없음 |
| `test_connection` | `connection: ConnectionDto`, `password: Option<String>` | 없음 |
| `open_session` | `connection: String` | `SessionDto { id, connection, backendPid }` |
| `session_state` | `sessionId: u64` | `SessionStateDto { status: "open" \| "lost", tx: "idle" \| "in_transaction" \| "failed" \| null }` |
| `close_session` | `sessionId: u64` | 없음 |

```rust
pub type CoreApp = chilla_core::application::App<chilla_core::infrastructure::PgConnector>;

#[derive(Serialize, Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionDto {
    pub name: String, pub host: String, pub port: u16, pub database: String, pub user: String,
    pub sslmode: String, pub sslrootcert: Option<String>, pub tunnel: Option<String>, pub color: Option<String>,
}
impl From<&ConnectionProfile> for ConnectionDto { .. }
impl TryFrom<ConnectionDto> for ConnectionProfile { type Error = CommandError; }   // 모르는 sslmode 는 kind "invalid_connection"

#[derive(Debug, Serialize)]
pub struct CommandError { pub kind: &'static str, pub message: String }
impl From<AppError> for CommandError { .. }
```

`kind` 값:

| `AppError` | `kind` |
| --- | --- |
| `NoProject` | `no_project` |
| `UnknownConnection` | `unknown_connection` |
| `UnknownSession` | `unknown_session` |
| `Project(NotFound)` | `project_not_found` |
| `Project(PasswordInConfig)` | `password_in_config` |
| `Project(그 밖)` | `project_invalid` |
| `InvalidProfile` | `invalid_connection` |
| `PasswordStore` | `password_store` |
| `Connect(Unreachable)` / `Timeout` / `TlsNotSupported` / `Certificate` | `unreachable` / `timeout` / `tls_not_supported` / `certificate` |
| `Connect(PasswordRequired)` / `AuthFailed` / `Database` / `Other` | `password_required` / `auth_failed` / `database` / `other` |

`message`는 `AppError`의 `Display`다.

- [ ] **Step 1: 실패하는 test 작성**

```rust
#[test] fn connection_dto_has_no_password_key() {
    // ConnectionDto::from(&profile) 을 serde_json::to_value 한 object 의 키 집합 ==
    // {"name","host","port","database","user","sslmode","sslrootcert","tunnel","color"}
}
#[test] fn connection_dto_rejects_a_password_from_the_screen() {
    // {"name":..,"password":"x"} 를 ConnectionDto 로 deserialize → Err
}
#[test] fn connection_dto_round_trips_sslmode() {
    // VerifyFull → "verify-full" → VerifyFull. sslmode "prefer" → Err(kind "invalid_connection")
}
#[test] fn session_state_dto_shapes() {
    // Open { tx: InTransaction } → {"status":"open","tx":"in_transaction"}
    // Lost → {"status":"lost","tx":null}
}
#[test] fn command_error_kinds() {
    // 위 kind 표의 모든 행. 예: AppError::Connect(ConnectError::PasswordRequired) → "password_required"
    // serde_json::to_value(CommandError) 의 키 집합 == {"kind","message"}
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p chillasql`
Expected: FAIL. `commands` module이 없어 compile error가 난다.

- [ ] **Step 3: DTO, `CommandError`, command 구현과 등록**

- command는 `#[tauri::command] pub async fn <name>(app: tauri::State<'_, CoreApp>, ..) -> Result<T, CommandError>` 꼴이고, DTO 변환과 `App` method 호출 한 번만 한다. 판단을 넣지 않는다.
- `set_password`와 `test_connection`은 받은 `String`을 첫 줄에서 `Password::new`로 감싼다.
- `lib.rs`의 `run`은 `App::new(Arc::new(TomlProjectStore), Arc::new(KeychainPasswordStore::new()..), PgConnector::new())`를 `manage`하고 `invoke_handler(tauri::generate_handler![..])`에 8개를 등록한다. `KeychainPasswordStore::new()`가 실패하면 그 message로 `expect`한다.
- 앱이 직접 정의한 command라 `capabilities/default.json`은 바꾸지 않는다.

- [ ] **Step 4: 통과 확인과 창 확인**

Run: `pnpm check`
Expected: PASS

Run: `pnpm tauri dev`
Expected: 이전처럼 `ChillaSQL` 창이 뜬다(시작할 때 panic이 없다). 확인 뒤 종료한다.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 프로젝트·세션 Tauri command와 오류 직렬화"
```

---

### Task 9: 완료 기준 확인과 기록

**Files:**
- Modify: `docs/progress.md`, `docs/plans/M1-session-core.md` (체크박스)

- [ ] **Step 1: 완료 기준 실행**

Run: `scripts/test-db.sh reset && pnpm check`
Expected: PASS. 완료 기준과 test의 대응은 다음과 같다.

| 완료 기준 | test |
| --- | --- |
| 로컬 DB에 접속, 세션 2개를 따로 열고 닫음 | `sessions::two_sessions_open_and_close_independently` |
| `verify-full`로 인증서가 틀린 서버를 거부 | `tls::verify_full_rejects_a_hostname_mismatch`, `tls::verify_full_rejects_an_untrusted_ca` |
| 설정 파일에 password 항목이 있으면 거부 | `project_file::rejects_a_password_entry` |

- [ ] **Step 2: 키체인 test 손으로 실행**

Run: `cargo test -p chilla-core --test password_store -- --ignored`
Expected: PASS. 확인 창이 뜨면 허용한다.

- [ ] **Step 3: 진행상황 갱신**

- M1 상태를 `완료`로 바꾸고 날짜를 적는다.
- 작업 로그에 완료 기준 확인 결과와 Task 1 Step 3의 키체인 결과를 남긴다.
- "지금"을 `다음 할 일: M2 계획 작성 → docs/plans/M2-query-core.md`로 바꾸고, M2에서 챙길 것으로 "session actor의 명령 enum에 실행을 더한다. 결과는 stream으로 받고 버릴 때는 cancel + drain"을 적는다.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: M1 완료 기록"
```
