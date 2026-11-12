# M3 프로젝트·에디터 화면 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱에서 프로젝트를 열고, 접속을 만들고 고르고, SQL 파일을 탭으로 열어 고치고 저장하고, 커서 문장이나 선택 영역을 `Cmd+Enter`로 실행하고 취소할 수 있게 한다. 결과는 첫 batch만 임시 표로 보여 준다.

**Architecture:** Rust에는 M3에 필요한 use case만 더한다(`chilla.toml` 만들기와 접속 저장, `.sql` 파일 목록·읽기·쓰기). 화면은 `src/shared/api`의 함수로만 Rust를 부르고, 기능별 Zustand store(`project`, `tabs`, `runs`)가 상태를 갖는다. 문서 text는 CodeMirror의 `EditorState`에만 두고 store에는 넣지 않는다. 탭마다 세션 하나를 첫 실행 때 열고, 실행마다 run token을 발급해 앞 실행의 늦은 event를 버린다.

**Tech Stack:** M2의 stack에 CodeMirror 6(`@codemirror/state` 6.7, `view` 6.43, `commands` 6.11, `language` 6.13, `lang-sql` 6.10, `search` 6.7, `autocomplete` 6.20, `theme-one-dark` 6.1), `tauri-plugin-dialog` 2 / `@tauri-apps/plugin-dialog` 2.8, `toml_edit` 0.25를 더한다.

**Spec:** [기획서](../spec.md) 4.1(접속 관리), 4.4(SQL 에디터)의 Highlighting·탭·파일 저장, 4.5(쿼리 실행)의 실행 범위·취소·실행 정보, 4.10(단축키), 5장(프로젝트 디렉토리), 6장(성능 기준), 7장(보안) / [마일스톤](../milestones.md) M3 / [구조](../architecture.md) / [진행상황](../progress.md)의 "M3에서 챙길 것"

## 먼저 확인한 것 (계획 작성 중 확인)

`tauri` 2.12.5와 `tauri-utils` 2.10.2의 source, tauri-cli의 `desktop.rs`, `style-mod` 4.1.4와 `@codemirror/view` 6.43의 source, scratch script(저장소 밖)로 확인했다. webview가 있어야 확인할 수 있는 것은 Task 1에 둔다.

| 확인한 것 | 결과 | 결정 |
| --- | --- | --- |
| desktop `tauri dev`의 CSP | Tauri는 `tauri://` protocol로 내보내는 HTML에만 CSP header를 붙인다(`AppManager::get_asset`). desktop dev는 webview가 `devUrl`(Vite)을 직접 열어서 CSP가 붙지 않는다. dev server를 proxy하는 code는 `cfg(all(dev, mobile))`뿐이다 | **CSP는 빌드된 앱에만 적용된다.** Vite HMR은 영향받지 않는다. `devCsp`는 두지 않는다. CSP 확인은 `pnpm tauri build --debug --no-bundle`로 만든 binary에서 한다 |
| CodeMirror가 넣는 style | `style-mod`는 `Document`에는 `<style>` tag를 만든다(`adoptedStyleSheets`는 `ShadowRoot`에서만 쓴다). `@codemirror/view`는 `setAttribute("style")`을 쓰지 않는다(0곳) | `style-src`에 `'unsafe-inline'`이 필요하다. nonce는 Tauri가 HTML을 내보낼 때마다 새로 만들어 화면 code가 알 수 없다. `script-src`는 풀지 않는다 |
| Tauri가 CSP를 고치는 규칙 | `replace_csp_nonce`는 HTML에 nonce token이나 hash가 있는 directive에만 nonce를 더한다. nonce가 붙은 directive에서는 browser가 `'unsafe-inline'`을 무시한다 | Vite의 build 결과에는 inline `<style>`이 없어 `style-src`에 nonce가 붙지 않을 것으로 본다. Task 1에서 실제 header로 확인하고, 붙으면 `dangerousDisableAssetCspModification: ["style-src"]`를 더한다 |
| Tauri의 기본 menu | File과 Window에 `close_window`(`Cmd+W`)가 있다. menu의 key equivalent는 webview의 `keydown`보다 먼저 잡힌다 | menu를 직접 만들고 `close_window`를 뺀다. Edit의 undo, redo, cut, copy, paste, select all은 둔다(없으면 WKWebView에서 `Cmd+C`/`Cmd+V`가 되지 않는다) |
| `tauri dev`가 앱을 띄우는 방법 | `cargo_command(true, …)`가 `cargo run`을 만든다 | cargo의 `target.<cfg>.runner`가 걸린다. runner script에서 binary를 서명한 뒤 실행한다 |
| code signing identity | `security find-identity -v -p codesigning`에 유효한 identity가 1개 있다 | **self-signed identity를 새로 만들지 않고 이미 있는 identity로 서명한다.** script는 identity 이름을 적어 두지 않고 `CHILLA_DEV_IDENTITY`, 없으면 첫 유효 identity를 쓴다. 다시 빌드해도 키체인 확인 창이 뜨지 않는지는 Task 1에서 확인한다 |
| `@codemirror/lang-sql` 6.10.0의 `PostgreSQL` dialect | `DO $$ BEGIN PERFORM 1; END $$`와 `$tag$ … $tag$`는 `String` token 하나다. `a::int`는 `:` 2개(`Punctuation`)와 `int`(`Type`)이고 오류 node가 없다. `->>`, `->`, `#>>`, `@>`, `?`, `?\|`, `\|\|`, `#-`, `@?`는 `Operator`다. `StandardSQL`은 `$$`에서 오류 node를 만든다 | `sql({ dialect: PostgreSQL })`로 4.4의 Highlighting을 맞춘다. Task 9의 test로 고정한다. `$1`은 오류 node가 되는데 파라미터는 M9다 |

## 이 계획에서 정한 것

기획서에 없거나 다르게 정한 것이다. Task 1에서 진행상황의 결정 기록과 기획서에 반영한다.

- **커서 문장은 M2의 `split_statements`로 고른다.** 실행할 때 문서 전체를 한 번 보낸다(1만 줄 scan 약 40ms, async command). 화면에서 따로 판별하지 않는다. 고르는 규칙은 Task 9의 `statementAt`에 있다: 커서가 문장 안이나 끝이면 그 문장, 아니면 같은 줄의 앞 문장, 없으면 같은 줄의 뒤 문장, 그것도 없으면 실행하지 않는다. 다른 줄의 문장은 고르지 않는다(엉뚱한 DML을 실행하지 않게).
- **나눌 수 없는 text(닫히지 않은 따옴표 등)에서 커서 실행은 보내지 않고 `split_failed`의 message를 보여 준다.** 어느 문장인지 알 수 없다. 선택 영역은 M2의 결정대로 받은 그대로 보낸다(앞뒤를 자르지 않는다).
- **CSP는 빌드된 앱에만 적용한다.** `default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' data:; style-src 'self' 'unsafe-inline'`. DB 내용은 React의 text node로만 그린다.
- **dev 빌드는 cargo runner script에서 이 Mac의 code signing identity로 서명한다**(identifier `com.yuiyeong.chillasql`). identity가 없으면 서명하지 않고 그대로 실행한다. release 빌드의 서명은 M4의 1단계 완료 확인 때 정한다.
- **menu에서 Close Window를 뺀다.** `Cmd+W`는 탭을 닫는다. 창은 `Cmd+Q`나 창의 닫기 버튼으로 닫는다.
- **M3의 단축키**(DataGrip macOS 키맵): 실행 `Cmd+Enter`, 취소 `Cmd+F2`, 저장 `Cmd+S`, 새 탭 `Shift+Cmd+L`, 탭 닫기 `Cmd+W`, 다음 탭 `Shift+Cmd+]`, 이전 탭 `Shift+Cmd+[`. `KeyboardEvent.code`로 판별한다(한글 입력 상태에서 `key`는 `ㄴ` 같은 자모다).
- **마지막으로 연 프로젝트 디렉토리를 `localStorage`(`chilla.lastProjectDir`)에 두고 시작할 때 연다.** 최근 프로젝트 목록(M8)이 SQLite로 옮긴다.
- **`chilla.toml`이 없는 디렉토리는 앱이 `[project]`만 든 파일을 만들어 프로젝트로 만들 수 있다.**
- **접속 저장은 `toml_edit`로 그 접속의 table만 고친다.** 주석, 다른 접속, 순서는 그대로다. 저장 전에 결과를 `load`와 같은 검사로 다시 읽어 본다(7장의 "저장 시 검사"). `sslrootcert`가 프로젝트 디렉토리 안이면 상대 경로로 쓴다.
- **접속 이름은 만든 뒤에 바꿀 수 없고, 접속 지우기는 만들지 않는다.** 필요하면 `chilla.toml`을 직접 고친다. `tunnel`(M5)과 `color`(M6)는 form에 없고 저장할 때 그대로 둔다.
- **접속의 연결 대상을 바꿔 저장하면 저장된 비밀번호를 지운다**(같이 새 비밀번호를 넣으면 그것을 저장). M1의 접속 테스트와 같은 이유다: 저장된 비밀번호가 다른 host로 가지 않게 한다.
- **`has_password`는 접속 수정 form을 열 때만 부른다**(M1에서 미룬 것). 접속 목록을 그릴 때는 키체인을 읽지 않는다. 구현은 그대로 둔다.
- **SQL 파일 목록은 프로젝트 디렉토리 아래의 `.sql` 파일이다.** `.`으로 시작하는 이름, `node_modules`, `target`, symlink는 뺀다. 16 MiB를 넘는 파일은 열지 않는다. 파일은 읽을 때의 stamp(mtime과 크기)를 화면이 갖고 있다가 저장할 때 돌려주고, 디스크의 파일이 그 사이 바뀌었으면 덮어쓰기 전에 묻는다.
- **세션은 탭의 첫 실행 때 연다.** 새 탭은 활성 탭의 접속을 물려받고, 활성 탭이 없으면 접속이 없다(첫 접속을 자동으로 고르지 않는다. `chilla.toml`의 첫 접속이 운영일 수 있다).
- **임시 표는 첫 batch(최대 500행)만 보여 주고 `fetch_more`를 부르지 않는다.** 받다 만 결과는 다음 실행, 취소, 탭 닫기에서 버려진다. `retainedFrom`보다 앞의 행을 버리는 것은 reducer가 하고, "다시 실행해야 볼 수 있음" 표시는 M4다.
- **앱이 끝날 때 `close_all_sessions`를 부른다.** 실행 중인 쿼리가 서버에 남지 않게 한다.
- **CodeMirror의 `autocompletion()`은 켜지 않는다**(M7).
- **넣지 않는 것**: 가상 스크롤과 이어서 가져오기(M4), 터널과 접속별 색상(M5, M6), 트랜잭션 표시(M6), 자동완성(M7), 오류 위치 밑줄·여러 문장 실행·저장하지 않은 탭 자동 보관·최근 프로젝트 목록(M8). 저장하지 않은 변경은 탭을 닫을 때와 프로젝트를 바꿀 때만 묻는다. **앱을 끝낼 때는 묻지 않는다**(M8의 자동 보관이 대신한다).

## Global Constraints

- M1, M2의 Global Constraints를 그대로 따른다(macOS 전용, `chilla-core`는 `tauri`에 의존하지 않음, 탭 = 세션, 비밀번호는 `Password`로만, 사용자에게 보이는 message는 한국어, JSON의 키는 camelCase이고 구분 값은 snake_case).
- layer 규칙: 파일 I/O와 `toml_edit`는 `infrastructure`에서만 쓴다. `toml_edit`를 `layer_deps`의 두 목록과 [구조](../architecture.md)의 표에 넣는다.
- `@tauri-apps/*`는 `src/shared/api/`에서만 import한다(ESLint가 강제). 기능 code는 `src/shared/api/commands`와 `src/shared/api/dialog`의 함수만 부르고, test는 이 두 module을 `vi.mock`으로 바꾼다. `types.ts`와 `errors.ts`는 mock하지 않는다.
- 문서 text는 CodeMirror의 `EditorState`에만 둔다. Zustand store, React state, `localStorage`에 넣지 않는다(6장: 1만 줄 파일에서 입력 지연 없음).
- 비밀번호는 form component의 local state에만 두고 저장이나 테스트가 끝나면 비운다. store와 `localStorage`에 넣지 않는다.
- DB에서 온 값과 server의 message는 React의 text node로만 그린다. `dangerouslySetInnerHTML`과 `innerHTML`을 쓰지 않는다.
- 단축키는 `KeyboardEvent.code`로 판별한다.
- dark 테마 고정. 색은 Tailwind의 `zinc` 계열과 `@codemirror/theme-one-dark`를 쓴다.
- test DB: `postgres://chilla:chilla@127.0.0.1:54318/chilla_test`(`big_table` 100만 행).
- 모든 명령은 저장소 루트에서 실행한다. commit 전에 `pnpm check`를 통과시킨다.
- commit 메시지는 영어 conventional prefix에 나머지는 한국어로 쓴다.

## Review Focus

1. **한글 입력 상태에서 누른 단축키**: `Cmd+S`의 `key`가 `ㄴ`으로 온다. 입력 소스와 무관하게 저장돼야 한다. → Task 12 Step 1 `한글 입력 상태에서도 code로 command를 고른다`
2. **빠르게 두 번 실행**: 앞 쿼리의 늦은 `finished`(`discarded`)가 새 실행의 결과를 덮으면 안 되고, 연결 중에 한 번 더 눌러도 세션이 2개 열리면 안 된다. event는 `execute_query`가 query id를 돌려주기 전에도 온다. → Task 11 Step 1 `앞 실행의 늦은 event는 새 실행의 상태를 바꾸지 않는다`·`연결 중에 한 번 더 실행해도 세션은 하나다`·`cancel은 execute가 query id를 돌려준 뒤 보낸다`
3. **연 뒤에 밖에서 바뀐 파일을 저장**(다른 editor, `git checkout`): 묻지 않고 덮어쓰면 그 변경이 사라진다. → Task 2 Step 1 `replace_refuses_a_file_changed_on_disk`, Task 10 Step 1 `밖에서 바뀐 파일은 물어본 뒤에만 덮어쓴다`
4. **화면이 보낸 경로가 프로젝트 밖을 가리킴**(`../`, 절대 경로, 밖을 가리키는 symlink)과 **아주 큰 `.sql` 파일**(pg_dump): 프로젝트 밖의 파일을 읽거나 쓰면 안 되고, 수백 MB를 IPC로 보내 앱이 멈추면 안 된다. → Task 2 Step 1 `paths_outside_the_project_are_rejected`·`symlinks_are_neither_listed_nor_followed`·`files_over_the_limit_are_not_read`
5. **손으로 쓴 `chilla.toml`에 접속을 저장**: 주석과 다른 접속이 사라지면 안 된다. 연결 대상을 바꾼 접속에 예전 비밀번호가 남아 새 host로 가면 안 된다. → Task 3 Step 1 `save_connection_changes_only_that_connection`, Task 4 Step 1 `save_connection_forgets_the_password_when_the_target_changes`

---

## File Structure

```
.cargo/config.toml                    새로. macOS target의 runner
scripts/cargo-runner.sh               새로. 앱 binary를 서명한 뒤 실행
crates/chilla-core/src/
├── domain/sql_file.rs                새로. SqlPath, FileStamp, SqlFile, WriteMode
├── application/
│   ├── ports.rs                      SqlFileStore, FileError. ProjectStore에 create·save_connection
│   ├── app.rs                        create_project, save_connection, list/read/write_sql_file
│   └── test_support/mod.rs           FakeFiles. FakeProjects를 새 port에 맞춤
└── infrastructure/
    ├── sql_files.rs                  새로. FsSqlFileStore
    └── project_file.rs               create, save_connection (toml_edit)
crates/chilla-core/tests/
├── sql_files.rs                      새로
└── project_file.rs                   create, save_connection
src-tauri/
├── capabilities/default.json         dialog 권한
├── tauri.conf.json                   csp
└── src/
    ├── commands.rs                   새 command 5개와 DTO
    ├── error.rs                      새 AppError의 kind
    ├── menu.rs                       새로. Close Window가 없는 menu
    └── lib.rs                        조립, dialog plugin, menu, 종료 처리
src/
├── App.tsx                           ProjectGate 안에 Workspace
├── shared/api/
│   ├── types.ts                      Rust DTO의 type
│   ├── errors.ts                     CommandError
│   ├── commands.ts                   command마다 함수 하나
│   └── dialog.ts                     pickDirectory, confirm
└── features/
    ├── project/                      projectStore.ts, ProjectGate.tsx, Sidebar.tsx
    ├── connections/                  connectionForm.ts, ConnectionForm.tsx
    ├── editor/                       extensions.ts, documents.ts, statementAt.ts, SqlEditor.tsx,
    │                                 tabsStore.ts, saveTab.ts, TabBar.tsx
    ├── query/                        runReducer.ts, runsStore.ts, format.ts, ResultPane.tsx
    └── workspace/                    commands.ts, shortcuts.ts, Toolbar.tsx, Workspace.tsx
```

test는 대상 파일 옆에 `<이름>.test.ts(x)`로 둔다. Rust의 각 `mod.rs`는 새 type을 `pub use`로 내보낸다.

---

### Task 1: dev 빌드 서명, CSP, 결정 기록 (먼저 확인할 것)

**Files:**
- Create: `.cargo/config.toml`, `scripts/cargo-runner.sh`
- Modify: `src-tauri/tauri.conf.json`, `package.json`, `docs/progress.md`, `docs/spec.md`, `docs/milestones.md`
- Create 후 Delete: `src-tauri/src/probe.rs`, `src/shared/api/probe.ts`
- 임시로 Modify 후 되돌림: `src-tauri/src/lib.rs`, `src/main.tsx`

**Interfaces:**
- Produces: 서명된 dev binary(뒤 task가 키체인을 확인 창 없이 쓴다), 확정된 CSP, CodeMirror package, 진행상황의 결정 기록

- [x] **Step 1: runner script와 cargo 설정**

`.cargo/config.toml`:

```toml
[target.'cfg(target_os = "macos")']
runner = "scripts/cargo-runner.sh"
```

`scripts/cargo-runner.sh`(실행 권한을 준다):

```sh
#!/bin/sh
# cargo가 `cargo run`과 `cargo test`의 binary를 실행하기 전에 부른다.
# 앱 binary만 고정된 identity로 서명해, 다시 빌드해도 키체인이 같은 앱으로 보게 한다.
bin="$1"
shift
if [ "$(basename "$bin")" = "chillasql" ]; then
  identity="${CHILLA_DEV_IDENTITY:-$(security find-identity -v -p codesigning | awk 'NR == 1 && $2 ~ /^[0-9A-F]+$/ { print $2 }')}"
  if [ -n "$identity" ]; then
    codesign --force --sign "$identity" --identifier com.yuiyeong.chillasql "$bin" ||
      echo "cargo-runner: 서명하지 못했습니다. 서명 없이 실행합니다" >&2
  fi
fi
exec "$bin" "$@"
```

Run: `pnpm tauri dev` (background). 창이 뜨면 `codesign -dvv target/debug/chillasql 2>&1 | grep -E '^(Identifier|Authority|Signature)'`
Expected: `Identifier=com.yuiyeong.chillasql`과 `Authority=` 줄이 있고 `Signature=adhoc`이 없다. `codesign`이 key 사용을 묻는 창을 띄우면 사용자에게 "항상 허용"을 눌러 달라고 한다. `pnpm check`도 통과한다(test binary는 이름이 달라 서명하지 않는다).

- [x] **Step 2: 키체인 probe**

`probe.rs`에 command를 둔다. `main.tsx`가 render 뒤에 한 번 부른다.

```rust
/// 키체인 항목(`/chilla-probe` 프로젝트의 `signing` 접속)이 없으면 만들고, 읽는 데 걸린 시간을
/// `KEYCHAIN_PROBE <ms> <created|existing>` 한 줄로 stdout에 찍는다.
#[tauri::command]
pub async fn probe_keychain();
```

`KeychainPasswordStore`와 `PasswordKey { project_dir: "/chilla-probe".into(), connection: "signing".into() }`를 쓴다.

Run: `pnpm tauri dev` → `KEYCHAIN_PROBE … created`. `src-tauri/src/lib.rs`에 빈 줄을 하나 더해 다시 빌드되게 한다 → `KEYCHAIN_PROBE <ms> existing`.

| 조건 | 결정 |
| --- | --- |
| `existing`이 500ms 안에 나온다 | **서명 확정.** |
| 확인 창이 뜨거나 500ms를 넘는다 | 여기서 멈추고 수치를 사용자에게 보고한다. 대안은 Keychain Access의 Certificate Assistant로 만든 self-signed identity를 `CHILLA_DEV_IDENTITY`로 쓰는 것이다 |

끝나면 `security delete-generic-password -s com.yuiyeong.chillasql -a '/chilla-probe::signing'`로 항목을 지운다.

- [x] **Step 3: CSP probe**

Run: `pnpm add @codemirror/state@^6.7.6 @codemirror/view@^6.43.15 @codemirror/commands@^6.11.1 @codemirror/language@^6.13.1 @codemirror/lang-sql@^6.10.0 @codemirror/search@^6.7.2 @codemirror/autocomplete@^6.20.4 @codemirror/theme-one-dark@^6.1.3`

`tauri.conf.json`의 `app.security`:

```json
"security": {
  "csp": {
    "default-src": "'self'",
    "connect-src": "ipc: http://ipc.localhost",
    "img-src": "'self' data:",
    "style-src": "'self' 'unsafe-inline'"
  }
}
```

`probe.rs`에 command 2개를 더한다.

```rust
/// 20,000자 문자열 하나를 Channel로 보낸다(8,192 byte를 넘어 fetch 경로를 탄다).
#[tauri::command]
pub fn probe_channel(on_message: tauri::ipc::Channel<String>);
/// `CSP_PROBE <report>` 한 줄을 stdout에 찍는다.
#[tauri::command]
pub fn probe_report(report: String);
```

`probe.ts`는 `document`에 `securitypolicyviolation` listener를 달고, `new EditorView({ doc: "SELECT a::int", extensions: [sql({ dialect: PostgreSQL }), oneDark], parent: document.body })`를 만들고, `probe_channel`을 부른 뒤 1,000ms 기다려 `probe_report`에 아래 JSON을 넘긴다.

```ts
{
  violations: { directive: string; blockedURI: string }[],   // violatedDirective, blockedURI
  cmStyled: boolean,   // getComputedStyle(document.querySelector(".cm-scroller")!).overflowX === "auto"
  channelChars: number // Channel로 받은 문자열의 길이
}
```

Run: `pnpm tauri build --debug --no-bundle && ./target/debug/chillasql` (background). `CSP_PROBE`가 나오면 기록하고 process를 끝낸다.

| 조건 | 결정 |
| --- | --- |
| `violations`가 비고 `cmStyled`가 `true`이고 `channelChars`가 20000 | **위 CSP로 확정.** |
| `style-src` violation이 있다 | `"dangerousDisableAssetCspModification": ["style-src"]`를 더하고 다시 잰다 |
| `connect-src` violation이 있다 | `blockedURI`의 scheme을 `connect-src`에 더하고 다시 잰다 |
| `script-src`를 풀어야 통과한다 | 여기서 멈추고 사용자에게 보고한다 |

- [x] **Step 4: probe 삭제**

`probe.rs`와 `probe.ts`를 지우고 `lib.rs`와 `main.tsx`를 되돌린다.

Run: `git status --short`
Expected: `.cargo/config.toml`, `scripts/cargo-runner.sh`, `src-tauri/tauri.conf.json`, `package.json`, `pnpm-lock.yaml`, `docs/`만 있다.

- [x] **Step 5: 결정 기록**

- `docs/progress.md`: M3 상태를 `진행 중`으로 바꾼다. 결정 기록에 "이 계획에서 정한 것"의 항목을 한 줄씩, Step 2와 Step 3의 수치와 결정을 한 줄씩 남긴다.
- `docs/spec.md`
  - 4.4 파일 저장 행: "프로젝트 디렉토리에 `.sql` 파일로 저장. 연 뒤에 밖에서 바뀐 파일은 덮어쓰기 전에 확인"
  - 4.5 실행 범위 행 끝에: "커서가 문장 밖이면 같은 줄의 앞 문장, 없으면 같은 줄의 뒤 문장을 실행하고, 그것도 없으면 실행하지 않음"
  - 4.10의 표에 행 추가: `M3의 키` / "실행 Cmd+Enter, 취소 Cmd+F2, 저장 Cmd+S, 새 탭 Shift+Cmd+L, 탭 닫기 Cmd+W, 다음 탭 Shift+Cmd+], 이전 탭 Shift+Cmd+[. 입력 소스와 무관하게 key의 위치로 판별"
  - 5장 첫 문단 끝에: "설정 파일이 없는 디렉토리를 열면 앱이 `[project]`만 든 `chilla.toml`을 만들 수 있다. SQL 파일 목록에는 `.`으로 시작하는 이름, `node_modules`, `target`, symlink가 빠지고, 16 MiB를 넘는 파일은 열지 않는다."
  - 7장 접속 비밀번호 행 끝에: "접속의 연결 대상(host, port, database, user, SSL 설정, 터널)을 바꿔 저장하면 저장된 비밀번호를 지움"
  - 7장 화면과 Rust 사이 행 끝에: "CSP로 앱 자신의 script만 실행"
- `docs/milestones.md`
  - M4 "먼저 확인할 것": "release 빌드(`pnpm tauri build`)를 dev 빌드와 같은 identity로 서명할지(`bundle.macOS.signingIdentity`). 서명이 다르면 키체인이 다른 앱으로 본다"
  - M8 "먼저 확인할 것": "M3는 마지막 프로젝트를 `localStorage`에 두고, 앱을 끝낼 때 저장하지 않은 탭을 묻지 않는다. 최근 프로젝트 목록과 자동 보관이 이 둘을 대신한다"

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: dev 빌드 서명과 CSP, M3 결정 기록"
```

---

### Task 2: SQL 파일 목록, 읽기, 쓰기

**Files:**
- Create: `crates/chilla-core/src/domain/sql_file.rs`, `crates/chilla-core/src/infrastructure/sql_files.rs`
- Modify: `crates/chilla-core/src/domain/mod.rs`, `crates/chilla-core/src/application/ports.rs`, `crates/chilla-core/src/application/mod.rs`, `crates/chilla-core/src/infrastructure/mod.rs`
- Test: `crates/chilla-core/tests/sql_files.rs`, `sql_file.rs` 안의 단위 test

**Interfaces:**
- Produces:

```rust
// chilla_core::domain (sql_file.rs)
/// 프로젝트 디렉토리 기준의 `.sql` 파일 경로. `/`로 나눈 상대 경로다.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct SqlPath(String);
impl SqlPath {
    pub fn parse(value: &str) -> Result<Self, SqlPathError>;
    pub fn as_str(&self) -> &str;
}
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SqlPathError {
    #[error("파일 경로가 비어 있습니다")] Empty,
    #[error("프로젝트 디렉토리 안의 상대 경로여야 합니다")] Absolute,
    #[error("경로에 '{component}'는 쓸 수 없습니다")] Component { component: String },
    #[error("파일 이름은 .sql로 끝나야 합니다")] NotSql,
}
/// 디스크에 있는 파일의 상태. 화면은 뜻을 모르고 저장할 때 그대로 돌려준다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStamp(pub String);
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlFile { pub text: String, pub stamp: FileStamp }
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteMode {
    /// 새 파일. 이미 있으면 쓰지 않는다.
    Create,
    /// 연 파일. 디스크의 파일이 `expected`와 다르면 쓰지 않는다.
    Replace { expected: FileStamp },
    /// 묻고 난 뒤. 있든 없든 쓴다.
    Overwrite,
}

// chilla_core::application
pub trait SqlFileStore: Send + Sync {
    /// 프로젝트 디렉토리 아래의 `.sql` 파일. 경로 오름차순이다.
    fn list(&self, project_dir: &Path) -> Result<Vec<SqlPath>, FileError>;
    fn read(&self, project_dir: &Path, path: &SqlPath) -> Result<SqlFile, FileError>;
    fn write(&self, project_dir: &Path, path: &SqlPath, text: &str, mode: &WriteMode)
        -> Result<FileStamp, FileError>;
}
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FileError {
    #[error("{path} 파일이 없습니다")] NotFound { path: String },
    #[error("{path} 파일이 이미 있습니다")] Exists { path: String },
    #[error("{path} 파일이 연 뒤에 밖에서 바뀌었습니다")] Changed { path: String },
    #[error("{path} 파일이 너무 큽니다 ({bytes} byte). 16 MiB까지 엽니다")] TooLarge { path: String, bytes: u64 },
    #[error("{path} 파일이 UTF-8이 아닙니다")] NotUtf8 { path: String },
    #[error("{path}는 프로젝트 디렉토리 밖을 가리킵니다")] OutsideProject { path: String },
    #[error("{path} 파일을 다루지 못했습니다: {message}")] Io { path: String, message: String },
}

// chilla_core::infrastructure
pub struct FsSqlFileStore;                       // impl SqlFileStore
impl FsSqlFileStore { pub const MAX_BYTES: u64 = 16 * 1024 * 1024; }
```

규칙:

- `SqlPath::parse`: 빈 문자열은 `Empty`. `/`로 시작하면 `Absolute`. `/`로 나눈 component가 비었거나, `.`으로 시작하거나(`.`, `..`, `.git`, `.sql` 포함), `\`나 NUL을 담으면 `Component`. 그 검사를 지난 뒤 마지막 component가 대소문자 구분 없이 `.sql`로 끝나지 않으면 `NotSql`. 값은 바꾸지 않고 그대로 갖는다.
- `list`: 디렉토리를 재귀로 돈다. 이름이 `.`으로 시작하는 항목, `node_modules`, `target`, symlink(파일과 디렉토리 모두)는 건너뛴다. 대소문자 구분 없이 `.sql`로 끝나는 일반 파일만 모은다. `SqlPath::parse`가 거절하는 경로와 읽지 못한 하위 디렉토리는 건너뛴다.
- 경로 확인(`read`, `write` 공통): 대상의 조상 중 이미 있는 가장 깊은 디렉토리를 `canonicalize`한 값이 `canonicalize`한 프로젝트 디렉토리로 시작하지 않거나, 대상이 symlink면 `OutsideProject`다. 확인은 디렉토리를 만들기 전에 한다.
- `read`: 크기가 `MAX_BYTES`를 넘으면 읽지 않고 `TooLarge`. UTF-8이 아니면 `NotUtf8`.
- stamp는 `"{mtime의 UNIX epoch nanosecond}-{byte 크기}"`다.
- `write`: text가 `MAX_BYTES`를 넘으면 `TooLarge`. `Create`는 경로 확인 뒤 부모 디렉토리를 만들고(`create_dir_all`) `create_new`로 연다(있으면 `Exists`). `Replace`는 파일이 없으면 `NotFound`, 지금 stamp가 `expected`와 다르면 `Changed`. `Replace`와 `Overwrite`는 같은 디렉토리의 임시 파일(`.<이름>.chilla-tmp`)에 쓰고 `rename`한다. 쓴 뒤의 stamp를 돌려준다.

- [x] **Step 1: 실패하는 test 작성**

`sql_file.rs`의 단위 test:

```rust
#[test] fn parse_accepts_relative_sql_paths() {
    // "scratch.sql", "queries/users.sql", "queries/billing/refunds.SQL", "a b/한글.sql" 은 Ok이고 as_str()이 입력과 같다
}
#[test] fn parse_rejects_paths_that_leave_the_project() {
    // "" → Empty, "/etc/x.sql" → Absolute
    // "../x.sql", "a/../x.sql", "./x.sql", "a//x.sql", ".git/x.sql", "a/.hidden.sql", "a\\x.sql", "a\0.sql" → Component
    // "notes.txt", "queries", "a/b" → NotSql.  ".sql", "a/.sql" → Component (`.`으로 시작한다)
}
```

`tests/sql_files.rs`. helper `project(files: &[(&str, &str)]) -> TempDir`는 경로와 내용으로 파일을 만든다(부모 디렉토리 포함). `paths(dir) -> Vec<String>`는 `FsSqlFileStore.list`의 `as_str()`들이다. `p(s) -> SqlPath`는 `SqlPath::parse(s).unwrap()`이다.

```rust
#[test] fn lists_sql_files_recursively_in_order() {
    // 기획서 5장의 구조 + "notes.txt", "queries/README.md", "Q.SQL"
    // paths == ["Q.SQL", "queries/billing/refunds.sql", "queries/users.sql", "scratch.sql"]
}
#[test] fn listing_skips_hidden_dependency_and_build_directories() {
    // ".git/x.sql", "node_modules/pkg/x.sql", "target/x.sql", "a/.cache/x.sql", ".hidden.sql", "ok.sql" → ["ok.sql"]
}
/// Review Focus 4
#[test] fn symlinks_are_neither_listed_nor_followed() {
    // 프로젝트 밖 디렉토리 outside/secret.sql. project에 symlink "link" → outside, "s.sql" → outside/secret.sql
    // paths == []
    // read(p("s.sql")) == Err(OutsideProject), read(p("link/secret.sql")) == Err(OutsideProject)
    // write(p("link/sub/new.sql"), "x", &Create) == Err(OutsideProject) 이고 outside/sub 디렉토리가 생기지 않았다
}
#[test] fn read_returns_the_text_and_a_stamp() {
    // "a.sql" = "SELECT '한글';\n" → text가 같고 stamp.0이 비어 있지 않다. 다시 읽으면 같은 stamp
    // read(p("nope.sql")) == Err(NotFound { path: "nope.sql" })
}
/// Review Focus 4
#[test] fn files_over_the_limit_are_not_read() {
    // set_len(MAX_BYTES + 1)로 만든 sparse 파일 → Err(TooLarge { bytes: MAX_BYTES + 1, .. })
    // write(.., &"x".repeat(MAX_BYTES as usize + 1), &Overwrite) == Err(TooLarge)
}
#[test] fn non_utf8_files_are_refused() {
    // bytes [0xff, 0xfe] → Err(NotUtf8)
}
#[test] fn create_makes_parent_directories_and_refuses_an_existing_file() {
    // write(p("queries/new/x.sql"), "SELECT 1", &Create) → Ok, 파일 내용이 같다
    // 같은 경로에 다시 Create → Err(Exists), 내용은 "SELECT 1" 그대로
}
#[test] fn replace_writes_when_the_stamp_matches() {
    // read → stamp. write(.., "v2", &Replace { expected: stamp }) → 새 stamp(read의 stamp와 같다), 내용 "v2"
    // 디렉토리에 ".chilla-tmp"로 끝나는 파일이 남지 않는다
}
/// Review Focus 3
#[test] fn replace_refuses_a_file_changed_on_disk() {
    // read → stamp. fs::write로 다른 길이의 내용을 쓴다. Replace { expected: stamp } → Err(Changed), 디스크 내용은 밖에서 쓴 그대로
    // Overwrite → Ok, 내용이 바뀐다
    // 파일을 지운 뒤 Replace → Err(NotFound)
}
/// Review Focus 4
#[test] fn paths_outside_the_project_are_rejected() {
    // SqlPath::parse가 "../x.sql"을 거절하므로 store까지 오지 않는다(위 단위 test).
    // store 수준: 프로젝트 디렉토리 자체가 symlink여도 그 안의 파일은 읽고 쓴다(canonicalize 기준)
}
```

- [x] **Step 2: 실패 확인**

Run: `cargo test -p chilla-core --test sql_files`
Expected: FAIL. `FsSqlFileStore`가 없어 compile error가 난다.

- [x] **Step 3: `SqlPath`, `SqlFileStore`, `FsSqlFileStore` 구현**

위 규칙대로 구현한다.

- [x] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 프로젝트의 SQL 파일 목록, 읽기, 쓰기"
```

---

### Task 3: `chilla.toml` 만들기와 접속 저장

**Files:**
- Modify: `crates/chilla-core/Cargo.toml` (`toml_edit = "0.25"`), `crates/chilla-core/src/application/ports.rs`, `crates/chilla-core/src/infrastructure/project_file.rs`, `crates/chilla-core/src/application/test_support/mod.rs`, `crates/chilla-core/tests/layer_deps.rs`, `docs/architecture.md`
- Test: `crates/chilla-core/tests/project_file.rs`

**Interfaces:**
- Consumes: M1의 `ProjectStore::load`, `ConnectionProfile`, `ProjectError`
- Produces:

```rust
// chilla_core::application
pub trait ProjectStore: Send + Sync {
    fn load(&self, dir: &Path) -> Result<Project, ProjectError>;
    /// `chilla.toml`이 없는 디렉토리에 파일을 만들고 그 프로젝트를 돌려준다.
    fn create(&self, dir: &Path) -> Result<Project, ProjectError>;
    /// 접속 하나를 쓰고 쓴 뒤의 프로젝트를 돌려준다. 같은 이름이 있으면 바꾸고 없으면 끝에 더한다.
    fn save_connection(&self, dir: &Path, profile: &ConnectionProfile) -> Result<Project, ProjectError>;
}
// ProjectError에 더한다
#[error("{} 파일이 이미 있습니다", path.display())] AlreadyExists { path: PathBuf },
#[error("{} 파일을 쓰지 못했습니다: {message}", path.display())] Write { path: PathBuf, message: String },
```

규칙:

- `create`: 내용은 정확히 `[project]\nname = "<디렉토리 이름>"\n`이다(이름은 TOML 문자열로 escape). `create_new`로 열어 이미 있으면 `AlreadyExists`. 디렉토리가 없으면 `Read`. 쓴 뒤 `load`한 결과를 돌려준다.
- `save_connection`:
  1. 지금 파일을 `load`와 같은 검사로 읽는다. 실패하면 그 오류를 돌려주고 쓰지 않는다(password 항목이 있는 파일을 고치지 않는다).
  2. `profile.validate()`가 실패하면 `InvalidConnection`.
  3. `toml_edit::DocumentMut`로 `[connections.<name>]`만 고친다. `host`, `port`, `database`, `user`는 항상 쓴다. `sslmode`는 `disable`이 아니면 쓰고, `disable`이면 이미 있는 key만 값을 바꾼다(없으면 만들지 않는다). `sslrootcert`, `tunnel`, `color`는 `Some`이면 쓰고 `None`이면 key를 지운다. 이미 있는 key는 자리와 그 줄의 주석을 그대로 두고 값만 바꾼다. 값이 같은 key는 건드리지 않는다.
  4. `sslrootcert`가 프로젝트 디렉토리 아래면 그 기준의 상대 경로로, 아니면 절대 경로로 쓴다.
  5. 새 접속은 파일 끝에 빈 줄 하나를 두고 `[connections.<name>]` table로 더한다. key 순서는 `host`, `port`, `database`, `user`, `sslmode`, `sslrootcert`, `tunnel`, `color`다.
  6. 결과 text를 1과 같은 검사로 다시 읽어 본다. 실패하면 `Write`이고 쓰지 않는다.
  7. 같은 디렉토리의 임시 파일(`.chilla.toml.tmp`)에 쓰고 `rename`한다.
- `FakeProjects`(test_support): `create`는 접속이 없는 프로젝트를 등록하고(있으면 `AlreadyExists`), `save_connection`은 같은 이름을 바꾸거나 끝에 더한다. `saved(&self) -> Vec<(PathBuf, ConnectionProfile)>`로 받은 저장 요청을 돌려준다.
- `layer_deps.rs`의 `DOMAIN_FORBIDDEN`과 `APPLICATION_FORBIDDEN`에 `"toml_edit"`를 넣고, [구조](../architecture.md) 2장의 두 표에도 넣는다.

- [x] **Step 1: 실패하는 test 작성**

`tests/project_file.rs`에 더한다. helper `saved(toml: &str, profile: ConnectionProfile) -> (TempDir, Result<Project, ProjectError>, String)`는 파일을 쓰고 `save_connection`을 부른 뒤 결과와 디스크의 text를 돌려준다. `production()`은 `SPEC_EXAMPLE`의 `production`과 같은 `ConnectionProfile`이다.

```rust
#[test] fn create_writes_a_minimal_file_that_loads() {
    // 빈 TempDir → create == Ok(project): name이 디렉토리 이름, connections가 비었다
    // 파일 내용 == format!("[project]\nname = \"{name}\"\n")
    // 다시 create → Err(AlreadyExists), 없는 디렉토리 → Err(Read { .. })
}
/// Review Focus 5
#[test] fn save_connection_changes_only_that_connection() {
    // SPEC_EXAMPLE에서 production의 color를 "blue"로
    // text == SPEC_EXAMPLE.replace("color = \"red\"", "color = \"blue\"")
    //   (sslmode 줄의 주석, 주석 처리된 sslrootcert 줄, 다른 접속, 순서가 모두 그대로다)
    // 아무것도 바꾸지 않은 production을 저장하면 text == SPEC_EXAMPLE
}
#[test] fn save_connection_appends_a_new_connection_at_the_end() {
    // SPEC_EXAMPLE에 analytics(host "10.0.0.5", port 6432, sslmode Require, color None) 저장
    // text.starts_with(SPEC_EXAMPLE), 접속 이름 순서 == [production, staging, local, analytics]
    // load한 analytics == 저장한 profile. 더한 부분에 "color"와 "tunnel"이 없다
    // sslmode Disable인 새 접속을 저장하면 더한 부분에 "sslmode"가 없다
}
#[test] fn save_connection_removes_optional_keys_that_are_unset() {
    // staging을 tunnel None, color None으로 저장 → load한 staging의 tunnel, color가 None
    // production을 sslmode Disable로 저장 → text에 `sslmode = "disable"`이 있고 그 줄의 주석이 남아 있다
}
#[test] fn save_connection_writes_sslrootcert_relative_to_the_project_dir() {
    // sslmode VerifyFull, sslrootcert <dir>/certs/ca.pem → text에 `sslrootcert = "certs/ca.pem"`, load하면 같은 절대 경로
    // sslrootcert /etc/ssl/ca.pem → text에 `sslrootcert = "/etc/ssl/ca.pem"`
}
#[test] fn save_connection_refuses_a_file_it_cannot_load() {
    // local에 password = "x"가 있는 파일 → Err(PasswordInConfig { connection: "local" }), text가 그대로다
    // port 0인 profile → Err(InvalidConnection { source: ZeroPort, .. }), text가 그대로다
    // 파일이 없는 디렉토리 → Err(NotFound)
}
#[test] fn save_connection_quotes_names_that_need_it() {
    // name "my db.prod" 저장 → load하면 그 이름의 접속이 하나 있다
    // 저장한 text 어디에도 대소문자 구분 없이 "password"가 없다
}
#[test] fn save_connection_leaves_no_temporary_file() {
    // 저장 뒤 디렉토리의 항목이 chilla.toml 하나다
}
```

- [x] **Step 2: 실패 확인**

Run: `cargo test -p chilla-core --test project_file`
Expected: FAIL. `create`와 `save_connection`이 없어 compile error가 난다.

- [x] **Step 3: `create`, `save_connection`, `FakeProjects` 구현**

위 규칙대로 구현한다. `load`의 검사(parse, `reject_passwords`, 접속별 검증)를 text를 받는 함수로 뽑아 `load`와 `save_connection`의 1, 6이 같이 쓴다.

- [x] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: chilla.toml 만들기와 접속 저장"
```

---

### Task 4: 프로젝트 만들기, 접속 저장, SQL 파일 use case

**Files:**
- Modify: `crates/chilla-core/src/application/app.rs`, `crates/chilla-core/src/application/mod.rs`, `crates/chilla-core/src/application/test_support/mod.rs`, `crates/chilla-core/tests/support/mod.rs`, `src-tauri/src/error.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 2의 `SqlFileStore`, `SqlPath`, `SqlFile`, `FileStamp`, `WriteMode`, `FileError`. Task 3의 `ProjectStore::create`·`save_connection`
- Produces:

```rust
impl<C: Connector> App<C> {
    pub fn new(
        projects: Arc<dyn ProjectStore>,
        passwords: Arc<dyn PasswordStore>,
        splitter: Arc<dyn StatementSplitter>,
        files: Arc<dyn SqlFileStore>,
        connector: C,
    ) -> Self;
    /// `chilla.toml`을 만들고 그 프로젝트를 연다. 여는 것은 `open_project`와 같다.
    pub async fn create_project(&self, dir: &Path) -> Result<Project, AppError>;
    /// 접속을 `chilla.toml`에 쓰고 열려 있는 프로젝트에 반영한다. 세션은 그대로 둔다.
    pub async fn save_connection(&self, profile: ConnectionProfile, password: Option<Password>)
        -> Result<Project, AppError>;
    pub async fn list_sql_files(&self) -> Result<Vec<SqlPath>, AppError>;
    pub async fn read_sql_file(&self, path: &str) -> Result<SqlFile, AppError>;
    pub async fn write_sql_file(&self, path: &str, text: String, mode: WriteMode)
        -> Result<FileStamp, AppError>;
}
// AppError에 더한다
#[error(transparent)] File(#[from] FileError),
#[error("파일 경로가 잘못됐습니다: {0}")] InvalidPath(#[from] SqlPathError),
```

`CommandError`의 kind:

| `AppError` | kind |
| --- | --- |
| `Project(AlreadyExists)` | `project_exists` |
| `Project(Write)` | `project_write_failed` |
| `InvalidPath(_)`, `File(OutsideProject)` | `invalid_path` |
| `File(NotFound)` | `file_not_found` |
| `File(Exists)` | `file_exists` |
| `File(Changed)` | `file_changed` |
| `File(TooLarge)` | `file_too_large` |
| `File(NotUtf8)` | `file_not_utf8` |
| `File(Io)` | `file_io` |

규칙:

- `create_project`: `projects.create(dir)`가 성공하면 `open_project`와 같은 순서로 프로젝트를 바꾼다(generation을 올리고 열려 있던 세션을 모두 닫는다). 실패하면 지금 프로젝트와 세션은 그대로다.
- `save_connection`:
  1. 프로젝트가 없으면 `NoProject`. `profile.resolved_under(dir)` 뒤 `validate()`가 실패하면 `InvalidProfile`이고 쓰지 않는다.
  2. 저장 전의 같은 이름 접속(`previous`)을 기억하고 `projects.save_connection`을 부른다(blocking).
  3. 쓰는 동안 프로젝트가 다시 열렸으면(generation이 다르면) state를 건드리지 않고 `ProjectChanged`다. 아니면 `state.project`를 돌려받은 프로젝트로 바꾼다. generation은 올리지 않고 세션은 닫지 않는다(열려 있는 세션은 저장 전의 접속 정보로 붙어 있다).
  4. 비밀번호: `password`가 `Some`이면 저장한다. `None`이고 `previous`가 있고 `!previous.same_target(&profile)`이면 저장된 비밀번호를 지운다. 그 밖에는 키체인을 건드리지 않는다.
- 파일 use case: 프로젝트가 없으면 `NoProject`. `SqlPath::parse`가 실패하면 `InvalidPath`이고 store를 부르지 않는다. store 호출은 `blocking`으로 한다.
- `FakeFiles`(test_support): `calls(&self) -> Vec<(PathBuf, String)>`로 받은 (프로젝트 디렉토리, 경로)를 돌려준다. `list`는 빈 Vec, `read`는 `SqlFile { text: "", stamp: FileStamp("s".into()) }`, `write`는 `FileStamp("s".into())`를 돌려준다.
- `src-tauri/src/lib.rs`는 `Arc::new(FsSqlFileStore)`를 넘긴다. `tests/support/mod.rs`의 `app_with_project`도 같다.

- [x] **Step 1: 실패하는 test 작성**

`app.rs`의 test module에 더한다. `fixture()`는 `FakeFiles`를 갖는다(`f.files`).

```rust
#[tokio::test] async fn create_project_opens_it_and_closes_sessions() {
    // /p를 열고 세션 하나. create_project("/new") → Ok(name "new"). 앞 세션의 link가 닫혔다
    // open_session("local") == Err(UnknownConnection)  (/new에는 접속이 없다)
    // create_project("/p") == Err(Project(AlreadyExists)) 이고 /new가 열린 채다
}
#[tokio::test] async fn save_connection_updates_the_project_and_keeps_sessions() {
    // /p에서 세션 하나. local의 host를 "db.internal"로 저장 → 돌려준 project의 local.host가 바뀌었다
    // session_state(앞 세션) == Ok(OPEN). 그 뒤 open_session("local")의 연결 요청 profile.host == "db.internal"
    // 새 이름 "analytics" 저장 → open_session("analytics")가 된다
}
#[tokio::test] async fn save_connection_stores_the_typed_password() {
    // save_connection(profile("local"), Some(pw("typed"))) → open_session("local")의 요청 비밀번호 == Some("typed")
}
/// Review Focus 5
#[tokio::test] async fn save_connection_forgets_the_password_when_the_target_changes() {
    // host, port, database, user, sslmode, tunnel을 하나씩 바꾼 6가지 각각:
    //   set_password("local", "stored") → save_connection(바꾼 profile, None) → has_password("local") == Ok(false)
    // color만 바꾸면 has_password == Ok(true)
    // 대상을 바꾸면서 Some(pw("new"))를 주면 저장된 값이 "new"다
}
#[tokio::test] async fn save_connection_of_a_new_connection_touches_no_password() {
    // save_connection(profile("analytics"), None) → f.passwords.is_empty()
}
#[tokio::test] async fn save_connection_rejects_an_invalid_profile_without_writing() {
    // port 0 → Err(InvalidProfile(ZeroPort)), projects.saved()가 비었다
    // 프로젝트를 열기 전 → Err(NoProject)
}
#[tokio::test] async fn file_use_cases_need_a_project_and_a_valid_path() {
    // 열기 전: list_sql_files, read_sql_file("a.sql"), write_sql_file("a.sql", ..) 모두 Err(NoProject)
    // 연 뒤: read_sql_file("../a.sql")과 write_sql_file("/etc/a.sql", ..) → Err(InvalidPath(_)), f.files.calls()가 비었다
}
#[tokio::test] async fn file_use_cases_pass_the_project_dir() {
    // /p를 열고 read_sql_file("queries/a.sql") → f.files.calls() == [("/p", "queries/a.sql")]
}
```

`error.rs`의 `command_error_kinds`에 위 kind 표의 9행을 더한다.

- [x] **Step 2: 실패 확인**

Run: `cargo test -p chilla-core --lib application::app`
Expected: FAIL. `App::new`의 인자 수가 달라 compile error가 난다.

- [x] **Step 3: use case, `AppError`, kind mapping, `FakeFiles` 구현**

위 규칙대로 구현한다.

- [x] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 프로젝트 만들기, 접속 저장, SQL 파일 use case"
```

---

### Task 5: Tauri command, menu, 종료 처리

**Files:**
- Create: `src-tauri/src/menu.rs`
- Modify: `src-tauri/Cargo.toml` (`tauri-plugin-dialog = "2"`), `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `package.json` (`pnpm add @tauri-apps/plugin-dialog@^2.8.4`)

**Interfaces:**
- Consumes: Task 4의 use case
- Produces: command 5개와 JSON

```rust
#[tauri::command] pub async fn create_project(app: State<'_, CoreApp>, path: String) -> CommandResult<ProjectDto>;
#[tauri::command] pub async fn save_connection(app: State<'_, CoreApp>, connection: ConnectionDto, password: Option<String>) -> CommandResult<ProjectDto>;
#[tauri::command] pub async fn list_sql_files(app: State<'_, CoreApp>) -> CommandResult<Vec<String>>;
#[tauri::command] pub async fn read_sql_file(app: State<'_, CoreApp>, path: String) -> CommandResult<SqlFileDto>;
/// 쓴 뒤의 stamp를 돌려준다.
#[tauri::command] pub async fn write_sql_file(app: State<'_, CoreApp>, path: String, text: String, mode: WriteModeDto) -> CommandResult<String>;

#[derive(Debug, Serialize)]
pub struct SqlFileDto { pub text: String, pub stamp: String }
#[derive(Debug, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum WriteModeDto { Create, Replace { stamp: String }, Overwrite }

// menu.rs
pub fn build<R: tauri::Runtime>(handle: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>>;
```

| JSON | 값 |
| --- | --- |
| `read_sql_file`의 결과 | `{ "text": "...", "stamp": "..." }` |
| `write_sql_file`의 `mode` | `{ "mode": "create" }`, `{ "mode": "replace", "stamp": "..." }`, `{ "mode": "overwrite" }` |

규칙:

- `menu::build`: 앱 이름 submenu(about, separator, services, separator, hide, hide_others, separator, quit), `Edit`(undo, redo, separator, cut, copy, paste, select_all), `View`(fullscreen), `Window`(minimize, maximize). `close_window`는 어디에도 넣지 않는다. 모두 `PredefinedMenuItem`이다.
- `lib.rs`: `.plugin(tauri_plugin_dialog::init())`, `.menu(menu::build)`, 새 command 5개 등록. `.run(context)` 대신 `.build(context)`로 만든 app에 `.run(|handle, event| …)`을 부르고 `RunEvent::Exit`에서 `tauri::async_runtime::block_on(handle.state::<CoreApp>().close_all_sessions())`를 부른다.
- `capabilities/default.json`의 `permissions`: `["core:default", "dialog:allow-open", "dialog:allow-ask"]`

- [ ] **Step 1: 실패하는 test 작성**

`commands.rs`의 test module에 더한다.

```rust
#[test] fn write_mode_dto_shapes() {
    // {"mode":"create"} → Create, {"mode":"replace","stamp":"s"} → Replace { stamp: "s" }, {"mode":"overwrite"} → Overwrite
    // {"mode":"replace"}, {"mode":"append"}, {"mode":"create","stamp":"s"}, {} 는 모두 Err
    // WriteMode로 바꾸면 Replace의 expected == FileStamp("s")
}
#[test] fn sql_file_dto_shape() {
    // SqlFile { text: "SELECT 1", stamp: FileStamp("9-8") } → {"text":"SELECT 1","stamp":"9-8"}, 키는 text와 stamp뿐
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p chillasql write_mode_dto_shapes`
Expected: FAIL. `WriteModeDto`가 없어 compile error가 난다.

- [ ] **Step 3: command, DTO, menu, 종료 처리 구현**

- [ ] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

Run: `pnpm tauri dev` (background)
Expected: 창이 뜨고 menu bar에 `ChillaSQL`, `Edit`, `View`, `Window`가 있다. `File`이 없다. process를 끝낸다.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 프로젝트·접속·SQL 파일 command, menu, 종료 시 세션 닫기"
```

---

### Task 6: 화면의 API 층

**Files:**
- Create: `src/shared/api/types.ts`, `src/shared/api/errors.ts`, `src/shared/api/commands.ts`, `src/shared/api/dialog.ts`
- Test: `src/shared/api/commands.test.ts`

**Interfaces:**
- Consumes: M1, M2, Task 5의 command와 JSON
- Produces:

```ts
// types.ts
export type SslMode = "disable" | "require" | "verify-full";
export interface Connection {
  name: string; host: string; port: number; database: string; user: string;
  sslmode: SslMode; sslrootcert: string | null; tunnel: string | null; color: string | null;
}
export interface Project { name: string; dir: string; connections: Connection[] }
export interface Session { id: number; connection: string; backendPid: number }
export interface StatementSpan { start: number; end: number }
export interface ServerError { code: string; message: string; detail: string | null; hint: string | null; position: number | null }
export type Cell = string | null;
export type Outcome =
  | { outcome: "completed"; rows: number }
  | { outcome: "failed"; error: ServerError }
  | { outcome: "cancelled" }
  | { outcome: "discarded" }
  | { outcome: "connection_lost"; message: string }
  | { outcome: "client_error"; message: string };
export type QueryEvent =
  | { type: "columns"; columns: { name: string }[] }
  | { type: "rows"; firstRow: number; rows: Cell[][]; retainedFrom: number; elapsedMicros: number }
  | ({ type: "finished"; elapsedMicros: number } & Outcome);
export interface SqlFile { text: string; stamp: string }
export type WriteMode = { mode: "create" } | { mode: "replace"; stamp: string } | { mode: "overwrite" };

// errors.ts
export class CommandError extends Error { readonly kind: string; constructor(kind: string, message: string) }
/// invoke가 reject한 값을 CommandError로 바꾼다. `{ kind, message }` object가 아니면 kind는 "internal"이다.
export function toCommandError(value: unknown): CommandError;

// commands.ts — 모두 실패하면 CommandError로 reject한다
export function openProject(path: string): Promise<Project>;
export function createProject(path: string): Promise<Project>;
export function saveConnection(connection: Connection, password: string | null): Promise<Project>;
export function hasPassword(connection: string): Promise<boolean>;
export function testConnection(connection: Connection, password: string | null): Promise<void>;
export function openSession(connection: string): Promise<Session>;
export function closeSession(sessionId: number): Promise<void>;
export function splitStatements(sql: string): Promise<StatementSpan[]>;
/// query id를 돌려준다. event는 이 promise가 끝나기 전에도 `onEvent`로 온다.
export function executeQuery(sessionId: number, sql: string, onEvent: (event: QueryEvent) => void): Promise<number>;
export function cancelQuery(sessionId: number, queryId: number): Promise<void>;
export function listSqlFiles(): Promise<string[]>;
export function readSqlFile(path: string): Promise<SqlFile>;
export function writeSqlFile(path: string, text: string, mode: WriteMode): Promise<string>;

// dialog.ts
export function pickDirectory(): Promise<string | null>;   // open({ directory: true, multiple: false })
export function confirm(message: string): Promise<boolean>; // ask(message, { kind: "warning" })
```

`set_password`, `delete_password`, `session_state`, `fetch_more`는 M3 화면이 쓰지 않아 감싸지 않는다.

- [ ] **Step 1: 실패하는 test 작성**

`commands.test.ts`. `vi.mock("@tauri-apps/api/core")`로 `invoke`를 `vi.fn()`으로, `Channel`을 `onmessage` field만 가진 class로 바꾼다.

```ts
test("command 이름과 인자 key를 그대로 보낸다", async () => {
  // 호출 → invoke가 받은 (이름, 인자)
  // openProject("/p")                        → ("open_project", { path: "/p" })
  // createProject("/p")                      → ("create_project", { path: "/p" })
  // saveConnection(conn, "pw")               → ("save_connection", { connection: conn, password: "pw" })
  // hasPassword("local")                     → ("has_password", { connection: "local" })
  // testConnection(conn, null)               → ("test_connection", { connection: conn, password: null })
  // openSession("local")                     → ("open_session", { connection: "local" })
  // closeSession(3)                          → ("close_session", { sessionId: 3 })
  // splitStatements("a; b")                  → ("split_statements", { sql: "a; b" })
  // cancelQuery(3, 7)                        → ("cancel_query", { sessionId: 3, queryId: 7 })
  // listSqlFiles()                           → ("list_sql_files")  (인자 없이)
  // readSqlFile("a.sql")                     → ("read_sql_file", { path: "a.sql" })
  // writeSqlFile("a.sql", "x", { mode: "replace", stamp: "s" })
  //                                          → ("write_sql_file", { path: "a.sql", text: "x", mode: { mode: "replace", stamp: "s" } })
});
test("executeQuery는 Channel의 message를 onEvent로 넘긴다", async () => {
  // invoke가 받은 인자: { sessionId: 3, sql: "SELECT 1", onEvent: <Channel> }
  // 그 Channel의 onmessage에 { type: "columns", columns: [{ name: "id" }] }를 넣으면 onEvent가 같은 값을 받는다
  // invoke가 7로 resolve하면 executeQuery도 7
});
test("Rust의 오류 object는 CommandError가 된다", async () => {
  // invoke가 { kind: "unreachable", message: "m" }로 reject → CommandError, kind "unreachable", message "m"
  // invoke가 "command not found"(문자열)로 reject → kind "internal", message에 그 문자열이 들어 있다
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run src/shared/api`
Expected: FAIL. `./commands`가 없다.

- [ ] **Step 3: `types.ts`, `errors.ts`, `commands.ts`, `dialog.ts` 구현**

- [ ] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 화면의 Tauri command wrapper"
```

---

### Task 7: 프로젝트 열기와 sidebar

**Files:**
- Create: `src/features/project/projectStore.ts`, `src/features/project/ProjectGate.tsx`, `src/features/project/Sidebar.tsx`
- Modify: `src/App.tsx`, `src/App.test.tsx`
- Test: `projectStore.test.ts`, `ProjectGate.test.tsx`, `Sidebar.test.tsx`

**Interfaces:**
- Consumes: Task 6의 `openProject`, `createProject`, `listSqlFiles`, `pickDirectory`, `CommandError`
- Produces:

```ts
// projectStore.ts
export const LAST_PROJECT_KEY = "chilla.lastProjectDir";
export type ProjectStatus = "booting" | "none" | "missing" | "ready";
export interface ProjectState {
  status: ProjectStatus;
  project: Project | null;
  files: string[];
  error: string | null;
  missingDir: string | null;             // status가 "missing"일 때 chilla.toml이 없던 디렉토리
  boot(): Promise<void>;                 // 마지막 디렉토리를 연다
  open(dir: string): Promise<boolean>;   // 열렸으면 true
  create(dir: string): Promise<boolean>;
  applyProject(project: Project): void;  // 접속을 저장한 뒤
  refreshFiles(): Promise<void>;
}
export const useProject: UseBoundStore<StoreApi<ProjectState>>;

// ProjectGate.tsx — "ready"일 때만 children을 그린다
export function ProjectGate(props: { children: React.ReactNode }): JSX.Element;

// Sidebar.tsx
export function Sidebar(props: {
  onOpenFile(path: string): void;
  onAddConnection(): void;
  onEditConnection(name: string): void;
  onSwitchProject(): void;
}): JSX.Element;
```

규칙:

- `boot`: `localStorage`에 디렉토리가 없으면 `"none"`. 있으면 `open`하고, 실패하면 `"none"`에 `error`를 둔다(`"missing"`으로 가지 않는다).
- `open` / `create`: 성공하면 `status: "ready"`, `project`, `error: null`, `files: []`로 바꾸고 `project.dir`을 `localStorage`에 쓴 뒤 `refreshFiles()`를 **기다리지 않고** 부른다. `open`이 `project_not_found`로 실패하면 `status: "missing"`, `missingDir: dir`이다(프로젝트가 열려 있을 때는 status를 바꾸지 않고 `error`만 둔다). 그 밖의 실패는 `error`만 두고, 열려 있던 프로젝트는 그대로다.
- `localStorage` 접근은 `try`로 감싼다. 실패해도 프로젝트는 열린다.
- `refreshFiles`: 실패하면 `error`를 두고 `files`는 그대로다. 호출 도중 프로젝트가 바뀌었으면 결과를 버린다.
- `ProjectGate`: mount 때 `boot()`를 한 번 부른다. `"booting"`은 빈 화면, `"none"`은 `프로젝트 열기` 버튼(`pickDirectory()` → `open`)과 `error`, `"missing"`은 `<missingDir>에 chilla.toml이 없습니다`와 `chilla.toml 만들기`(`create(missingDir)`)·`다른 디렉토리 열기` 버튼이다.
- `Sidebar`: 맨 위에 프로젝트 이름과 `다른 프로젝트` 버튼. `접속` 구역은 접속마다 이름과 `host:port/database`, `수정` 버튼, 끝에 `접속 추가` 버튼. `SQL 파일` 구역은 `files`의 상대 경로를 그대로 나열하고 `새로고침` 버튼을 둔다. 파일을 누르면 `onOpenFile(path)`다.
- `App.tsx`: `<ProjectGate><div>…</div></ProjectGate>`. Workspace는 Task 12에서 넣는다.

- [ ] **Step 1: 실패하는 test 작성**

각 test 앞에서 `localStorage.clear()`와 store 초기화를 한다. `vi.mock("../../shared/api/commands")`, `vi.mock("../../shared/api/dialog")`.

```ts
// projectStore.test.ts
test("boot는 마지막 디렉토리를 연다");            // localStorage에 "/p" → openProject("/p"), status "ready"
test("마지막 디렉토리가 없으면 none이다");        // openProject를 부르지 않는다
test("boot가 실패하면 none이고 error가 있다");    // project_not_found여도 "missing"이 아니다
test("파일 목록을 기다리지 않고 ready가 된다");   // listSqlFiles가 끝나지 않은 promise여도 open이 true, status "ready", files []
                                                  // 그 promise가 ["a.sql"]로 끝나면 files == ["a.sql"]
test("연 디렉토리를 localStorage에 쓴다");        // openProject가 dir "/private/p"를 돌려주면 그 값
test("chilla.toml이 없으면 missing이고 create로 만든다");
                                                  // open("/new")가 project_not_found → status "missing", missingDir "/new"
                                                  // create("/new") → createProject("/new"), status "ready"
test("여는 데 실패해도 열려 있던 프로젝트는 그대로다"); // ready에서 open("/bad")가 project_invalid → false, project와 status 그대로, error가 message
test("localStorage가 throw해도 열린다");          // Storage.prototype.setItem이 throw → open이 true
test("프로젝트가 바뀐 뒤 끝난 파일 목록은 버린다");
// ProjectGate.test.tsx
test("프로젝트가 없으면 여는 버튼을 보여 주고 고른 디렉토리를 연다"); // pickDirectory가 "/p" → children이 보인다. null이면 아무것도 하지 않는다
test("chilla.toml이 없는 디렉토리는 만들 수 있다");
test("booting 동안에는 children을 그리지 않는다");
// Sidebar.test.tsx
test("접속과 SQL 파일을 나열한다");               // "local", "localhost:5432/app", "queries/users.sql"
test("파일, 수정, 접속 추가, 다른 프로젝트, 새로고침이 각 handler를 부른다");
```

`App.test.tsx`는 `"프로젝트가 없으면 프로젝트 열기 버튼을 보여 준다"`로 바꾼다.

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run src/features/project`
Expected: FAIL. `./projectStore`가 없다.

- [ ] **Step 3: store, `ProjectGate`, `Sidebar` 구현**

- [ ] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 프로젝트 열기와 sidebar"
```

---

### Task 8: 접속 추가와 수정

**Files:**
- Create: `src/features/connections/connectionForm.ts`, `src/features/connections/ConnectionForm.tsx`
- Test: `connectionForm.test.ts`, `ConnectionForm.test.tsx`

**Interfaces:**
- Consumes: Task 6의 `saveConnection`, `testConnection`, `hasPassword`
- Produces:

```ts
// connectionForm.ts
export interface FormValues {
  name: string; host: string; port: string; database: string; user: string;
  sslmode: SslMode; sslrootcert: string;
}
export function initialValues(original: Connection | null): FormValues;   // 새 접속: port "5432", sslmode "disable", 나머지 ""
export function toConnection(values: FormValues, original: Connection | null):
  { connection: Connection } | { error: string };
/// color를 뺀 나머지가 하나라도 다르면 true다(Rust의 `same_target`과 같은 항목).
export function targetChanged(connection: Connection, original: Connection): boolean;

// ConnectionForm.tsx — original이 null이면 새 접속
export function ConnectionForm(props: {
  original: Connection | null;
  onSaved(project: Project): void;
  onClose(): void;
}): JSX.Element;
```

규칙:

- `toConnection`: 문자열 값은 앞뒤 공백을 뺀다. `name`, `host`, `database`, `user`가 비면 `{ error: "<항목>을 입력하세요" }`. `port`가 1~65535의 정수가 아니면 `{ error: "port는 1~65535의 숫자여야 합니다" }`. `sslrootcert`는 `sslmode`가 `verify-full`이고 비어 있지 않을 때만 값이고 그 밖에는 `null`이다. `tunnel`과 `color`는 `original`의 값을 그대로 쓴다(새 접속은 `null`). `original`이 있으면 `name`은 `original.name`이다.
- form: `name`(수정이면 disabled), `host`, `port`, `database`, `user`, `password`(`type="password"`), `sslmode`(select), `sslrootcert`(`verify-full`일 때만 enabled). 버튼은 `테스트`, `저장`, `취소`.
- 수정으로 열릴 때 `hasPassword(original.name)`를 한 번 부른다. `true`면 `password`의 placeholder가 `저장된 비밀번호 유지`다. 실패하면 placeholder 없이 둔다.
- `테스트`: `testConnection(connection, password || null)`. 성공하면 `연결됐습니다`, 실패하면 `error.message`를 보여 준다.
- `저장`: `saveConnection(connection, password || null)` → `password`를 비우고 `onSaved(project)`. 실패하면 `error.message`를 보여 주고 form은 열린 채다.
- `toConnection`이 `error`면 command를 부르지 않고 그 문구를 보여 준다.
- 수정 중에 `targetChanged`이고 `password`가 비었고 저장된 비밀번호가 있으면 `연결 대상을 바꾸면 저장된 비밀번호를 지웁니다. 비밀번호를 다시 입력하세요`를 보여 준다.
- 테스트나 저장이 도는 동안 두 버튼은 disabled다.

- [ ] **Step 1: 실패하는 test 작성**

```ts
// connectionForm.test.ts
test("값의 앞뒤 공백을 빼고 port를 숫자로 바꾼다");       // " localhost " → "localhost", "5432" → 5432
test("빈 필수 항목과 잘못된 port는 error다");            // port "", "abc", "0", "65536", "54.3"
test("sslrootcert는 verify-full일 때만 보낸다");          // require에 값이 있어도 null
test("수정은 이름, tunnel, color를 original에서 가져온다"); // values.name을 바꿔도 original.name
test("targetChanged는 color만 다르면 false다");           // host, port, database, user, sslmode, sslrootcert, tunnel 각각은 true
// ConnectionForm.test.tsx
test("새 접속을 저장하면 saveConnection에 입력한 비밀번호를 넘기고 onSaved를 부른다");
test("비밀번호를 비워 두면 null을 넘긴다");
test("수정은 이름을 고칠 수 없고 저장된 비밀번호가 있으면 placeholder로 알린다"); // hasPassword가 한 번 불린다
test("테스트는 성공과 실패를 문구로 보여 준다");          // testConnection이 auth_failed로 reject → 그 message
test("저장이 실패하면 message를 보여 주고 닫지 않는다");  // onSaved를 부르지 않는다
test("잘못된 값이면 command를 부르지 않는다");
test("연결 대상을 바꾸고 비밀번호를 비우면 지워진다고 알린다");
test("도는 동안 테스트와 저장 버튼은 disabled다");
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run src/features/connections`
Expected: FAIL. `./connectionForm`이 없다.

- [ ] **Step 3: `connectionForm.ts`, `ConnectionForm.tsx` 구현**

- [ ] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 접속 추가와 수정 form"
```

---

### Task 9: 에디터와 커서 문장

**Files:**
- Create: `src/features/editor/extensions.ts`, `src/features/editor/documents.ts`, `src/features/editor/statementAt.ts`, `src/features/editor/SqlEditor.tsx`
- Modify: `src/test/setup.ts` (jsdom에 없는 DOM API가 필요하면 여기에 stub을 둔다)
- Test: `extensions.test.ts`, `documents.test.ts`, `statementAt.test.ts`, `SqlEditor.test.tsx`

**Interfaces:**
- Consumes: Task 6의 `StatementSpan`
- Produces:

```ts
// extensions.ts
export function editorExtensions(): Extension;

// documents.ts — tab id마다 EditorState 하나. Zustand 밖에 둔다
export function openDocument(tabId: string, text: string): void;
export function documentState(tabId: string): EditorState;
export function setDocumentState(tabId: string, state: EditorState): void;
export function documentText(tabId: string): string;
export function documentSelection(tabId: string): { from: number; to: number; head: number };
export function closeDocument(tabId: string): void;

// statementAt.ts
export function statementAt(text: string, spans: StatementSpan[], cursor: number): StatementSpan | null;
/// 1부터 세는 줄과 칸(UTF-16 code unit).
export function lineColumn(text: string, offset: number): { line: number; column: number };

// SqlEditor.tsx — EditorView 하나를 갖고 tabId가 바뀌면 그 tab의 state로 바꾼다
export function SqlEditor(props: { tabId: string; onDocChange(tabId: string): void }): JSX.Element;
```

규칙:

- `editorExtensions`: `lineNumbers()`, `highlightActiveLine()`, `history()`, `drawSelection()`, `indentOnInput()`, `bracketMatching()`, `closeBrackets()`, `highlightSelectionMatches()`, `keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab])`, `sql({ dialect: PostgreSQL })`, `oneDark`. `autocompletion()`은 넣지 않는다. 높이는 부모를 채운다(`EditorView.theme({ "&": { height: "100%" } })`).
- `statementAt` (span은 start 오름차순, `end`는 포함하지 않고 `;`를 담지 않는다):
  1. `start <= cursor <= end`인 span.
  2. 없으면 `end < cursor`인 마지막 span. 단 `text.slice(end, cursor)`에 `\n`이 없어야 한다.
  3. 없으면 `start > cursor`인 첫 span. 단 `text.slice(cursor, start)`에 `\n`이 없어야 한다.
  4. 없으면 `null`.
- `SqlEditor`: mount 때 `new EditorView({ state: documentState(tabId), parent, dispatchTransactions })`. transaction을 적용한 뒤 `setDocumentState(tabId, view.state)`를 부르고, `docChanged`인 transaction이 있으면 `onDocChange(tabId)`를 부른다. `tabId`가 바뀌면 `view.setState(documentState(tabId))` 뒤 `view.focus()`. unmount 때 `view.destroy()`.

- [ ] **Step 1: 실패하는 test 작성**

```ts
// extensions.test.ts — PostgreSQL.language.parser.parse(sql)의 node 이름을 본다. DOM은 쓰지 않는다
test("$$ 블록은 String node 하나다");
  // "DO $$ BEGIN PERFORM 1; END $$; SELECT 2" → "$$ BEGIN PERFORM 1; END $$"를 덮는 String node가 있고 오류 node(⚠)가 없다
  // "SELECT $tag$ it's; $tag$"도 같다
test(":: 캐스팅은 오류 없이 type을 칠한다");
  // "SELECT a::int" → 오류 node가 없고 "int"가 Type node다
test("JSONB 연산자는 Operator node다");
  // "SELECT d->>'k', d->'a', d #>> '{a}', d @> '{}', d ? 'k', d ?| array['a'], d || '{}', d #- '{a}', d @? '$.a'"
  //   → "->>", "->", "#>>", "@>", "?", "?|", "||", "#-", "@?" 각각이 Operator node의 text다. 오류 node가 없다
test("extension으로 문서를 만들 수 있다");
  // EditorState.create({ doc: "SELECT 1", extensions: editorExtensions() }).doc.toString() === "SELECT 1"

// statementAt.test.ts
test("커서가 문장 안이나 끝이면 그 문장이다");
  // "SELECT 1;\nSELECT 2", spans [(0,8),(10,18)]: cursor 0, 4, 8 → (0,8). cursor 10, 14, 18 → (10,18)
test("문장 밖이면 같은 줄의 앞 문장이다");
  // 같은 text에서 cursor 9(`;` 뒤) → (0,8)
  // "SELECT 1; -- note", spans [(0,8)], cursor 17 → (0,8)
  // "SELECT 1; SELECT 2", spans [(0,8),(10,18)], cursor 9 → (0,8)   (앞 문장이 뒤 문장보다 먼저다)
test("앞 문장이 없으면 같은 줄의 뒤 문장이다");
  // "  SELECT 1", spans [(2,10)], cursor 0 → (2,10)
test("다른 줄의 문장은 고르지 않는다");
  // "SELECT 1;\n\nSELECT 2", spans [(0,8),(11,19)], cursor 10(빈 줄) → null
  // "-- only\nSELECT 1", spans [(8,16)], cursor 3 → null
  // spans [] → null
test("lineColumn은 1부터 세는 줄과 UTF-16 칸이다");
  // ("a\nbc", 0) → {1,1}, ("a\nbc", 3) → {2,2}, ("😀x", 2) → {1,3}

// documents.test.ts
test("연 문서의 text와 selection을 돌려준다");      // openDocument("t", "SELECT 1") → text "SELECT 1", selection {0,0,0}
test("setDocumentState 뒤에는 새 state의 값을 준다");
test("닫은 문서는 없다");                           // closeDocument 뒤 documentState가 throw

// SqlEditor.test.tsx — EditorView.findFromDOM(container.querySelector(".cm-editor"))로 view를 얻는다
test("tab의 문서를 그린다");                        // .cm-content의 textContent에 "SELECT 1"
test("고치면 documents가 따라가고 onDocChange를 부른다");
  // view.dispatch({ changes: { from: 0, insert: "-- " } }) → documentText("a") === "-- SELECT 1", onDocChange("a") 1번
  // selection만 바꾸는 dispatch는 onDocChange를 부르지 않고 documentSelection은 바뀐다
test("tab을 바꿨다 돌아와도 내용과 undo 기록이 남는다");
  // a를 고치고 → tabId "b"로 rerender → 다시 "a" → text가 고친 값. undo(view) 뒤 원래 text
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run src/features/editor`
Expected: FAIL. `./statementAt`이 없다.

- [ ] **Step 3: `extensions.ts`, `documents.ts`, `statementAt.ts`, `SqlEditor.tsx` 구현**

- [ ] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: CodeMirror 에디터와 커서 문장 고르기"
```

---

### Task 10: 탭과 파일 열기·저장

**Files:**
- Create: `src/features/editor/tabsStore.ts`, `src/features/editor/saveTab.ts`, `src/features/editor/TabBar.tsx`
- Test: `tabsStore.test.ts`, `saveTab.test.ts`, `TabBar.test.tsx`

**Interfaces:**
- Consumes: Task 9의 `documents.ts`, Task 6의 `readSqlFile`·`writeSqlFile`·`confirm`, Task 7의 `useProject`(`refreshFiles`)
- Produces:

```ts
// tabsStore.ts
export interface Tab {
  id: string; title: string;
  path: string | null;       // 저장한 적 없는 탭은 null
  stamp: string | null;
  dirty: boolean;
  connection: string | null;
}
export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  naming: string | null;     // 파일 이름을 묻는 중인 tab id
  error: string | null;
  newTab(): string;
  openFile(path: string): Promise<void>;
  activate(id: string): void;
  close(id: string): void;
  next(): void; prev(): void;
  setConnection(id: string, connection: string | null): void;
  markDirty(id: string): void;
  markSaved(id: string, path: string, stamp: string): void;
  requestName(id: string | null): void;
  setError(message: string | null): void;
  reset(): void;
}
export const useTabs: UseBoundStore<StoreApi<TabsState>>;

// saveTab.ts
export function normalizeNewPath(input: string): string;
export type SaveResult = "saved" | "needs_name" | "cancelled" | "failed";
export function saveTab(tabId: string, newPath?: string): Promise<SaveResult>;

// TabBar.tsx
export function TabBar(props: { onClose(id: string): void; onNew(): void; onName(path: string): void }): JSX.Element;
```

규칙:

- `newTab`: id는 `crypto.randomUUID()`. title은 `쿼리 N`(N은 store가 1부터 세고 `reset`에서 1로 돌아간다). `connection`은 활성 탭의 값, 활성 탭이 없으면 `null`. `openDocument(id, "")` 뒤 활성 탭이 된다.
- `openFile`: 같은 `path`의 탭이 있으면 `activate`만 한다. 없으면 `readSqlFile` → `openDocument(id, text)` → title이 path의 마지막 component인 탭을 더하고 활성으로 한다. 실패하면 `error`에 message를 두고 탭을 만들지 않는다.
- `close`: 탭을 빼고 `closeDocument`. 활성 탭이었으면 오른쪽 탭, 없으면 왼쪽 탭, 없으면 `null`이 활성이다. 저장하지 않은 변경을 묻는 것과 세션을 닫는 것은 Task 12의 `closeTab`이 한다.
- `next` / `prev`: 끝에서 처음으로 돈다. 탭이 1개 이하면 아무것도 하지 않는다.
- `markDirty`: 이미 dirty면 state를 바꾸지 않는다(글자마다 다시 그리지 않게).
- `markSaved`: `path`, `stamp`, `dirty: false`, title을 path의 마지막 component로 바꾸고 `naming`을 비운다.
- `normalizeNewPath`: 앞뒤 공백을 빼고, 대소문자 구분 없이 `.sql`로 끝나지 않으면 `.sql`을 붙인다.
- `saveTab(tabId, newPath?)`:
  - `path`가 없고 `newPath`도 없으면 `requestName(tabId)` 뒤 `"needs_name"`.
  - `newPath`가 있으면 `writeSqlFile(normalizeNewPath(newPath), text, { mode: "create" })` → `markSaved` → `useProject.getState().refreshFiles()` → `"saved"`.
  - `path`가 있으면 `writeSqlFile(path, text, { mode: "replace", stamp })` → `markSaved` → `"saved"`. `file_changed`로 실패하면 `confirm("<path> 파일이 밖에서 바뀌었습니다. 덮어쓸까요?")`를 묻고, `true`면 `{ mode: "overwrite" }`로 다시 쓰고 `false`면 `"cancelled"`다.
  - 그 밖의 실패는 `setError(error.message)` 뒤 `"failed"`. 탭은 dirty인 채다.
  - text는 `documentText(tabId)`다.
- `TabBar`: 탭마다 title, dirty면 `●`, 닫기 버튼(`onClose(id)`). 탭을 누르면 `activate`. 끝에 새 탭 버튼(`onNew`). `naming`이 활성 탭이면 그 아래에 경로 입력(placeholder `queries/이름.sql`)과 `저장` 버튼을 그리고, 제출하면 `onName(입력값)`, `Escape`면 `requestName(null)`. `error`가 있으면 한 줄로 보여 주고 누르면 지운다.

- [ ] **Step 1: 실패하는 test 작성**

```ts
// tabsStore.test.ts
test("새 탭은 번호가 오르는 제목과 빈 문서로 활성이 된다");       // "쿼리 1", "쿼리 2". documentText(id) === ""
test("새 탭은 활성 탭의 접속을 물려받고 탭이 없으면 접속이 없다");
test("파일을 열면 내용과 stamp를 가진 탭이 된다");               // title "users.sql", path "queries/users.sql", dirty false
test("이미 연 파일은 그 탭을 활성으로 할 뿐이다");               // readSqlFile을 다시 부르지 않는다
test("파일을 못 열면 error를 두고 탭을 만들지 않는다");          // file_too_large
test("활성 탭을 닫으면 오른쪽, 없으면 왼쪽 탭이 활성이다");      // [a,b,c]에서 b를 닫으면 c, c를 닫으면 a. 마지막이면 null
test("닫은 탭의 문서는 지운다");
test("next와 prev는 끝에서 돈다");
test("markDirty는 이미 dirty면 state를 바꾸지 않는다");          // useTabs.getState().tabs가 같은 참조
test("reset은 탭과 문서를 모두 지우고 번호를 처음으로 돌린다");
// saveTab.test.ts
test("normalizeNewPath는 .sql을 붙인다");                        // " queries/a " → "queries/a.sql", "a.SQL" → "a.SQL"
test("이름 없는 탭은 이름을 묻는다");                            // "needs_name", naming === tabId, writeSqlFile을 부르지 않는다
test("이름을 주면 새 파일로 쓰고 파일 목록을 새로 읽는다");      // writeSqlFile("queries/a.sql", text, { mode: "create" }), listSqlFiles 호출
test("있는 파일 이름이면 실패하고 탭은 그대로다");               // file_exists → "failed", error가 message, path는 null
test("연 파일은 읽을 때의 stamp로 쓰고 새 stamp를 갖는다");      // { mode: "replace", stamp: "s1" } → stamp "s2", dirty false
/// Review Focus 3
test("밖에서 바뀐 파일은 물어본 뒤에만 덮어쓴다");
  // writeSqlFile이 file_changed로 reject
  //   confirm false → "cancelled", writeSqlFile 1번, dirty 그대로
  //   confirm true  → 두 번째 호출이 { mode: "overwrite" }, "saved"
// TabBar.test.tsx
test("탭 제목과 dirty 표시를 그리고 누르면 활성으로 한다");
test("닫기와 새 탭 버튼이 handler를 부른다");
test("naming인 탭은 경로 입력을 그리고 제출하면 onName을 부른다"); // Escape면 naming이 null
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run src/features/editor`
Expected: FAIL. `./tabsStore`가 없다.

- [ ] **Step 3: `tabsStore.ts`, `saveTab.ts`, `TabBar.tsx` 구현**

- [ ] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: SQL 파일 탭과 저장"
```

---

### Task 11: 쿼리 실행 상태와 임시 표

**Files:**
- Create: `src/features/query/runReducer.ts`, `src/features/query/runsStore.ts`, `src/features/query/format.ts`, `src/features/query/ResultPane.tsx`
- Test: `runReducer.test.ts`, `runsStore.test.ts`, `format.test.ts`, `ResultPane.test.tsx`

**Interfaces:**
- Consumes: Task 6의 `openSession`, `closeSession`, `executeQuery`, `cancelQuery`, `QueryEvent`, `Outcome`, `Cell`
- Produces:

```ts
// runReducer.ts
export interface Origin { line: number; column: number }   // 보낸 text가 문서에서 시작한 곳. 1부터 센다
export interface ResultData {
  sql: string;               // 서버에 보낸 text
  origin: Origin;
  columns: string[] | null;
  firstRow: number;          // rows[0]의 행 번호
  rows: Cell[][];
  elapsedMicros: number | null;
}
export type RunState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "running"; result: ResultData }
  | { status: "finished"; result: ResultData; outcome: Outcome }
  | { status: "rejected"; message: string };
export function emptyResult(sql: string, origin: Origin): ResultData;
export function reduce(state: RunState, event: QueryEvent): RunState;

// runsStore.ts
export interface RunRequest { connection: string; sql: string; origin: Origin }
export interface RunsState {
  runs: Record<string, RunState>;                 // tab id → 상태. 없으면 idle로 본다
  run(tabId: string, request: RunRequest): Promise<void>;
  reject(tabId: string, message: string): void;
  cancel(tabId: string): Promise<void>;
  release(tabId: string): Promise<void>;          // 탭을 닫거나 접속을 바꿀 때
  reset(): void;                                  // 프로젝트를 바꾼 뒤. 세션은 Rust가 이미 닫았다
}
export const useRuns: UseBoundStore<StoreApi<RunsState>>;

// format.ts
export function formatElapsed(micros: number): string;
/// 서버가 준 오류 위치(보낸 text의 UTF-16 offset)를 문서의 줄과 칸으로 바꾼다.
export function errorLocation(result: ResultData, position: number): { line: number; column: number };

// ResultPane.tsx
export function ResultPane(props: { tabId: string | null }): JSX.Element;
```

규칙:

- `reduce`: `state.status`가 `"running"`이 아니면 state를 그대로 돌려준다. `columns`는 이름만 `result.columns`에 둔다. `rows`는 뒤에 붙인 다음 행 번호가 `retainedFrom`보다 작은 행을 앞에서 버리고 `firstRow`를 맞춘다. `elapsedMicros`를 갱신한다. `finished`는 `{ status: "finished", result, outcome }`이고 `elapsedMicros`를 갱신한다.
- `runsStore`는 tab마다 store 밖의 값을 갖는다: run token(숫자), 세션(`{ connection, opening: Promise<number> }`), 진행 중인 `executeQuery`의 promise.
- `run`:
  1. token을 올린다. 이 호출의 뒤 단계는 token이 그대로일 때만 state를 바꾼다. 세션을 기다리는 사이 token이 바뀌었으면 그 호출은 `executeQuery`를 부르지 않고 끝난다.
  2. 그 tab의 세션이 없거나 `connection`이 다르면(다르면 먼저 `closeSession`) `"connecting"`으로 두고 `openSession(connection)`을 부른다. 같은 tab에서 여는 중인 promise가 있으면 그것을 같이 기다린다(세션을 2개 열지 않는다). 실패하면 `"rejected"`(message)이고 세션을 비운다.
  3. `{ status: "running", result: emptyResult(sql, origin) }`로 두고 `executeQuery(sessionId, sql, onEvent)`를 부른다. `onEvent`는 token이 그대로일 때만 `reduce`를 적용한다.
  4. `executeQuery`가 reject하면 `"rejected"`(message). kind가 `unknown_session`이면 세션을 비운다(다음 실행이 새로 연다).
  5. `finished`의 outcome이 `connection_lost`면 세션을 비우고 `closeSession`을 부른다(실패는 무시).
- `cancel`: status가 `"running"`일 때만 한다. 진행 중인 `executeQuery`의 promise가 query id를 돌려준 뒤 `cancelQuery(sessionId, queryId)`를 보낸다. 실패하면 무시한다(쿼리의 결과는 event로 온다).
- `release`: token을 올리고, 세션이 있으면(여는 중이면 끝난 뒤) `closeSession`을 부르고(실패는 무시) 그 tab의 state와 세션을 지운다.
- `reset`: 모든 tab의 token을 올리고 state와 세션을 지운다. `closeSession`은 부르지 않는다.
- `formatElapsed`: 1,000 미만은 `"0.42 ms"`(ms 단위 소수 2자리), 1,000,000 미만은 `"123 ms"`(정수), 그 이상은 `"1.23 s"`(소수 2자리).
- `errorLocation`: `lineColumn(result.sql, position)`이 `{ l, c }`일 때 `l === 1`이면 `{ line: origin.line, column: origin.column + c - 1 }`, 아니면 `{ line: origin.line + l - 1, column: c }`.
- `ResultPane`의 표시:

| 상태 | 표시 |
| --- | --- |
| `tabId`가 `null`이거나 `idle` | `Cmd+Enter로 실행` |
| `connecting` | `연결 중…` |
| `running`, 행 없음 | `실행 중…` |
| `running`, 행 있음 | 표와 `<n>행 표시 · 더 있음` |
| `finished` `completed`, columns 있음 | 표와 `<rows>행 · <elapsed>` |
| `finished` `completed`, columns 없음 | `<rows>행 영향 · <elapsed>` |
| `finished` `failed` | `error.message`, 있으면 `detail`과 `hint`, `position`이 있으면 `줄 <line>:<column>`, `code` |
| `finished` `cancelled` | `취소됨 · <elapsed>` (받은 행이 있으면 표도) |
| `finished` `discarded` | `결과를 버렸습니다` |
| `finished` `connection_lost` | `연결이 끊겼습니다: <message>`와 `다음 실행에서 새 세션을 엽니다` |
| `finished` `client_error` | `message` |
| `rejected` | `message` |

- 표: `<table>`에 `columns`를 header로, `rows`를 그대로 그린다. `null`은 흐린 `NULL`, 빈 문자열은 빈 cell이다. 300자를 넘는 값은 앞 300자와 `…`만 그린다.

- [ ] **Step 1: 실패하는 test 작성**

```ts
// runReducer.test.ts
test("columns, rows, finished를 차례로 쌓는다");
test("retainedFrom보다 앞의 행을 버린다");
  // rows firstRow 0 [a,b,c] 뒤 { firstRow: 3, rows: [d], retainedFrom: 2 } → rows [c,d], firstRow 2
test("running이 아닌 상태는 event를 무시한다");   // idle, finished, rejected 각각 같은 참조를 돌려준다
// runsStore.test.ts — openSession은 { id: 3, … }, executeQuery는 7로 resolve하는 mock
test("첫 실행은 세션을 열고 그 세션으로 실행한다");            // openSession("local") 1번, executeQuery(3, sql, fn)
test("같은 탭의 다음 실행은 세션을 다시 쓴다");                // openSession 1번, executeQuery 2번
/// Review Focus 2
test("연결 중에 한 번 더 실행해도 세션은 하나다");
  // openSession이 끝나지 않은 동안 run 2번 → openSession 1번. 끝나면 executeQuery는 마지막 실행의 sql로 1번
/// Review Focus 2
test("앞 실행의 늦은 event는 새 실행의 상태를 바꾸지 않는다");
  // run A의 onEvent를 잡아 둔다. run B 뒤 A의 onEvent에 finished(discarded) → state는 B의 running 그대로
test("event는 execute가 query id를 돌려주기 전에도 반영된다");
  // executeQuery가 끝나지 않은 동안 onEvent에 columns와 rows → state.result.rows가 있다
test("접속 실패는 rejected이고 다음 실행에서 다시 연다");      // unreachable → rejected. 다시 run → openSession 2번
test("execute가 거절되면 rejected다");                        // multiple_statements의 message
test("unknown_session으로 거절되면 세션을 버린다");            // 다음 run이 openSession을 다시 부른다
test("connection_lost로 끝나면 세션을 닫고 버린다");           // closeSession(3) 호출, 다음 run이 새로 연다
/// Review Focus 2
test("cancel은 execute가 query id를 돌려준 뒤 보낸다");
  // executeQuery가 끝나지 않은 동안 cancel() → cancelQuery 0번. 7로 resolve하면 cancelQuery(3, 7)
test("실행 중이 아니면 cancel은 아무것도 하지 않는다");        // idle, connecting, finished
test("접속이 바뀐 탭은 앞 세션을 닫고 새로 연다");             // run(local) → run(staging): closeSession(3), openSession("staging")
test("release는 세션을 닫고 그 뒤의 event를 무시한다");        // runs[tabId]가 없다
test("reset은 closeSession을 부르지 않고 모두 지운다");
test("탭마다 세션이 따로다");                                  // tab a, b → openSession 2번
// format.test.ts
test("formatElapsed");            // 420 → "0.42 ms", 123456 → "123 ms", 1234567 → "1.23 s"
test("errorLocation은 보낸 text의 위치를 문서의 줄과 칸으로 바꾼다");
  // sql "SELECT *\nFROM nope", origin {3,5}: position 0 → {3,5}, position 7 → {3,12}, position 14 → {4,6}
// ResultPane.test.tsx — 위 표의 행마다 test 하나. 더해서:
test("NULL과 빈 문자열을 다르게 그린다");
test("300자를 넘는 값은 줄여 그린다");            // 1,000자 값 → cell의 text 길이 301
test("실패는 message, detail, hint, 위치를 보여 준다"); // "줄 4:6"
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run src/features/query`
Expected: FAIL. `./runReducer`가 없다.

- [ ] **Step 3: `runReducer.ts`, `runsStore.ts`, `format.ts`, `ResultPane.tsx` 구현**

- [ ] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 쿼리 실행 상태와 임시 결과 표"
```

---

### Task 12: workspace와 단축키

**Files:**
- Create: `src/features/workspace/commands.ts`, `src/features/workspace/shortcuts.ts`, `src/features/workspace/Toolbar.tsx`, `src/features/workspace/Workspace.tsx`
- Modify: `src/App.tsx`
- Test: `commands.test.ts`, `shortcuts.test.ts`, `Workspace.test.tsx`

**Interfaces:**
- Consumes: Task 7의 `useProject`·`Sidebar`, Task 8의 `ConnectionForm`, Task 9의 `SqlEditor`·`documents`·`statementAt`·`lineColumn`, Task 10의 `useTabs`·`saveTab`·`TabBar`, Task 11의 `useRuns`·`ResultPane`, Task 6의 `splitStatements`·`pickDirectory`·`confirm`
- Produces:

```ts
// commands.ts
export type CommandId = "run" | "cancel" | "save" | "newTab" | "closeTab" | "nextTab" | "prevTab";
export function execute(command: CommandId): Promise<void>;   // 활성 탭에 대해
export function closeTab(tabId: string): Promise<void>;
export function changeConnection(tabId: string, connection: string | null): Promise<void>;
export function switchProject(): Promise<void>;

// shortcuts.ts
type Keys = Pick<KeyboardEvent, "code" | "metaKey" | "shiftKey" | "altKey" | "ctrlKey">;
export function commandFor(event: Keys): CommandId | null;
export function useShortcuts(): void;   // window의 capture 단계 keydown
```

| command | key (`code`) |
| --- | --- |
| `run` | `Cmd` + `Enter` |
| `cancel` | `Cmd` + `F2` |
| `save` | `Cmd` + `KeyS` |
| `newTab` | `Shift` + `Cmd` + `KeyL` |
| `closeTab` | `Cmd` + `KeyW` |
| `nextTab` | `Shift` + `Cmd` + `BracketRight` |
| `prevTab` | `Shift` + `Cmd` + `BracketLeft` |

규칙:

- `commandFor`: 표의 modifier와 정확히 같을 때만 고른다(`Shift+Cmd+S`, `Ctrl+Cmd+Enter`, `Alt`가 낀 것은 `null`). `key`는 보지 않는다.
- `useShortcuts`: `commandFor`가 command를 주면 `preventDefault()`와 `stopPropagation()`을 부르고 `execute`를 부른다(CodeMirror의 `Mod-Enter`가 빈 줄을 넣지 않게). `null`이면 건드리지 않는다.
- `execute("run")` (활성 탭이 없으면 아무것도 하지 않는다):
  1. 탭의 `connection`이 `null`이면 `reject(tabId, "접속을 먼저 고르세요")`.
  2. `documentSelection`의 `from !== to`면 `sql = text.slice(from, to)`(자르지 않는다). 공백뿐이면 `reject(tabId, "실행할 문장이 없습니다")`. `origin = lineColumn(text, from)`.
  3. 아니면 `splitStatements(text)`. 실패하면 `reject(tabId, error.message)`. `statementAt(text, spans, head)`가 `null`이면 `reject(tabId, "커서 위치에 문장이 없습니다")`. `sql = text.slice(span.start, span.end)`, `origin = lineColumn(text, span.start)`.
  4. `useRuns.getState().run(tabId, { connection, sql, origin })`.
- `execute("cancel")` → `cancel(activeId)`. `"save"` → `saveTab(activeId)`. `"newTab"` → `newTab()`. `"closeTab"` → `closeTab(activeId)`. `"nextTab"` / `"prevTab"` → `next()` / `prev()`.
- `closeTab`: dirty면 `confirm("'<title>'의 저장하지 않은 변경을 버릴까요?")`를 묻고 `false`면 그만둔다. 그 뒤 `release(tabId)`, `close(tabId)` 순서다.
- `changeConnection`: `release(tabId)` 뒤 `setConnection(tabId, connection)`.
- `switchProject`: dirty 탭이 있으면 `confirm("저장하지 않은 변경이 있는 탭이 <n>개 있습니다. 버리고 다른 프로젝트를 열까요?")`. `pickDirectory()`가 `null`이면 그만둔다. `useProject.getState().open(dir)`이 `true`면 `useTabs.getState().reset()`과 `useRuns.getState().reset()`을 부른다. `chilla.toml`이 없는 디렉토리를 고르면 열려 있던 프로젝트가 그대로이고 `error`만 보인다(Task 7의 규칙).
- `Toolbar`(활성 탭 기준): 접속 `<select>`(`접속 없음`과 프로젝트의 접속들, 바꾸면 `changeConnection`), `실행`, `취소`(run status가 `"running"`일 때만 enabled), `저장`(탭이 dirty이거나 path가 없을 때 enabled). 활성 탭이 없으면 모두 disabled다.
- `Workspace`: 왼쪽 `Sidebar`(너비 고정 260px), 오른쪽 위에서부터 `TabBar`, `Toolbar`, `SqlEditor`(60%), `ResultPane`(40%). 활성 탭이 없으면 에디터 자리에 `Shift+Cmd+L로 새 탭`을 그린다. `useShortcuts()`를 부른다. `Sidebar`의 handler: `onOpenFile` → `openFile`, `onAddConnection` / `onEditConnection` → `ConnectionForm`을 overlay로 연다(local state), `onSwitchProject` → `switchProject`. `ConnectionForm`의 `onSaved` → `applyProject(project)` 뒤 닫는다. `SqlEditor`의 `onDocChange` → `markDirty`. `TabBar`의 `onClose` → `closeTab`, `onNew` → `newTab`, `onName` → `saveTab(activeId, path)`. `useProject`의 `error`는 sidebar 아래에 보여 준다.
- `App.tsx`: `<ProjectGate><Workspace /></ProjectGate>`

- [ ] **Step 1: 실패하는 test 작성**

```ts
// shortcuts.test.ts
test("표의 key마다 command를 고른다");   // 7행
/// Review Focus 1
test("한글 입력 상태에서도 code로 command를 고른다");
  // { code: "KeyS", key: "ㄴ", metaKey: true } → "save". { code: "KeyW", key: "ㅈ", metaKey: true } → "closeTab"
test("modifier가 다르면 고르지 않는다");
  // KeyS만, Shift+Cmd+KeyS, Ctrl+Cmd+Enter, Alt+Cmd+KeyW, Cmd+KeyL(Shift 없음), Cmd+BracketRight(Shift 없음) → null
test("잡은 key는 기본 동작과 전파를 막고 command를 실행한다");
  // useShortcuts를 쓰는 component를 그리고 내부 element에 Cmd+Enter keydown
  //   → defaultPrevented, 그 element의 bubble listener가 불리지 않는다, execute("run")이 불린다
  // "a" keydown은 막지 않는다
// commands.test.ts — 탭을 만들고 openDocument로 text를, setDocumentState로 selection을 둔다
test("접속이 없는 탭은 실행하지 않고 알린다");                 // runs[tabId] rejected "접속을 먼저 고르세요", splitStatements 0번
test("선택 영역은 고른 그대로 실행한다");
  // text "SELECT 1;\n  SELECT 2  ;", selection이 " SELECT 2 "를 덮는다 → run의 sql이 그 문자열 그대로, origin {2,2}
  // splitStatements를 부르지 않는다
test("공백뿐인 선택 영역은 실행하지 않는다");
test("선택이 없으면 커서 문장을 실행한다");
  // text "SELECT 1;\nSELECT 2", cursor 12, splitStatements가 [(0,8),(10,18)] → run의 sql "SELECT 2", origin {2,1}
test("나눌 수 없는 text는 보내지 않고 message를 보여 준다");   // split_failed → rejected, run 0번
test("커서 위치에 문장이 없으면 실행하지 않는다");             // 빈 줄
test("dirty 탭은 물어본 뒤에 닫는다");
  // confirm false → 탭이 남고 release 0번. true → release(tabId) 뒤 close. dirty가 아니면 묻지 않는다
test("접속을 바꾸면 세션을 놓는다");                           // release(tabId) → setConnection
test("프로젝트를 바꾸면 탭과 실행 상태를 비운다");             // open이 true일 때만 reset. pickDirectory null이면 아무것도 안 한다
test("save, cancel, newTab, nextTab, prevTab은 활성 탭에 한다");
// Workspace.test.tsx
test("탭이 없으면 새 탭 안내를 그리고 toolbar는 disabled다");
test("실행 중일 때만 취소 버튼이 enabled다");
test("접속 select는 프로젝트의 접속을 나열하고 바꾸면 탭의 접속이 바뀐다");
test("sidebar의 파일을 누르면 탭으로 열린다");
test("접속 추가를 누르면 form이 열리고 저장하면 접속 목록에 나타난다");
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run src/features/workspace`
Expected: FAIL. `./shortcuts`가 없다.

- [ ] **Step 3: `commands.ts`, `shortcuts.ts`, `Toolbar.tsx`, `Workspace.tsx` 구현**

- [ ] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: workspace 화면과 기본 단축키"
```

---

### Task 13: 완료 확인

**Files:**
- 임시로 Modify 후 되돌림: `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`, `src/features/project/ProjectGate.tsx`
- Modify: `docs/progress.md`, `docs/plans/M3-project-editor.md`

- [ ] **Step 1: 손으로 확인**

Run: `scripts/test-db.sh up && pnpm tauri dev`

사용자와 함께 아래를 차례로 확인하고 결과를 기록한다. 하나라도 다르면 원인을 찾아 고치고(`superpowers:systematic-debugging`) 처음부터 다시 한다.

| 순서 | 하는 일 | 기대 |
| --- | --- | --- |
| 1 | `프로젝트 열기`로 빈 디렉토리를 고르고 `chilla.toml 만들기` | sidebar에 디렉토리 이름. 디렉토리에 `chilla.toml` |
| 2 | `접속 추가`: `local`, `127.0.0.1`, `54318`, `chilla_test`, `chilla`, 비밀번호 `chilla` → `테스트` | `연결됐습니다`. 키체인 확인 창이 뜨지 않는다 |
| 3 | `저장` | 접속 목록에 `local`. `chilla.toml`에 password가 없다 |
| 4 | `Shift+Cmd+L` → 접속 `local` → `SELECT * FROM big_table` → `Cmd+Enter` | 표에 500행, `500행 표시 · 더 있음` |
| 5 | `SELECT pg_sleep(10)`을 다음 줄에 쓰고 `Cmd+Enter` → `Cmd+F2` | 1초 안에 `취소됨` |
| 6 | `SELECT 1; SELEC 2`에서 커서를 `SELEC`에 두고 `Cmd+Enter` | syntax error와 `줄 <n>:<m>`이 `SELEC`의 위치다 |
| 7 | 두 문장을 선택하고 `Cmd+Enter` | `문장이 2개입니다…` |
| 8 | `Cmd+S` → `queries/first` → `저장` | 탭 제목 `first.sql`, sidebar에 `queries/first.sql` |
| 9 | 다른 editor로 그 파일을 고친 뒤 앱에서 고치고 `Cmd+S` | 덮어쓸지 묻는다 |
| 10 | 한글 입력 상태에서 `Cmd+S`, `Cmd+Enter` | 영문 상태와 같다 |
| 11 | `Cmd+Z`, `Shift+Cmd+Z`, `Cmd+C`, `Cmd+V`를 에디터에서 | undo, redo, 복사, 붙여넣기가 된다 |
| 12 | 고친 탭에서 `Cmd+W` | 버릴지 묻는다. 창은 닫히지 않는다 |
| 13 | `Shift+Cmd+]`, `Shift+Cmd+[` | 탭이 바뀐다 |
| 14 | `SELECT pg_sleep(600)` 실행 중에 `Cmd+Q` | 2초 안에 `docker compose exec db psql -U chilla chilla_test -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'ChillaSQL'"`이 0 |
| 15 | 앱을 다시 띄운다 | 프로젝트 화면이 바로 뜬다(고르지 않아도) |

- [ ] **Step 2: 시작 시간 측정**

임시 probe를 둔다. `lib.rs`의 `run()` 첫 줄에서 `Instant::now()`를 재 managed state에 두고, command `probe_startup`이 `STARTUP_PROBE <ms>`를 stdout에 찍는다. `ProjectGate`가 `"ready"`로 처음 그린 뒤(`useEffect`) 한 번 부른다.

Run: `pnpm tauri dev`를 3번 띄운다(Step 1의 프로젝트가 마지막 프로젝트인 상태).

| 조건 | 결정 |
| --- | --- |
| 3번 모두 `STARTUP_PROBE` ≤ 1000 | **완료 기준 충족.** |
| 넘는다 | `pnpm tauri build --debug --no-bundle`의 binary로 다시 잰다(dev는 Vite가 module을 하나씩 내보낸다). 그래도 넘으면 수치를 사용자에게 보고한다 |

probe를 지우고 `git status --short`로 `docs/` 밖에 바뀐 파일이 없는지 확인한다.

- [ ] **Step 3: CSP 재확인**

Run: `pnpm tauri build --debug --no-bundle && ./target/debug/chillasql`
Expected: 프로젝트 화면이 뜨고 에디터에 색이 입혀진다. 쿼리를 실행해 표가 나온다. 사용자가 확인한다.

- [ ] **Step 4: 정리와 review**

`CLAUDE.md`의 개발 순서대로 `simplify`, `code-review`(high), `superpowers:receiving-code-review`를 한다. 고친 뒤 `pnpm check`를 통과시키고 Step 1의 표에서 고친 곳과 닿는 행을 다시 확인한다.

- [ ] **Step 5: 기록**

- `docs/progress.md`: M3 상태를 `완료`로, "지금"을 M4로 바꾼다. 작업 로그에 완료 기준 확인 결과(Step 1의 5행, Step 2의 수치), 계획과 달라진 것, 고치지 않은 review 지적을 남긴다. "M4에서 챙길 것"에 임시 표를 대신할 때 지켜야 할 것(`runReducer`의 `firstRow`와 `retainedFrom`, `fetch_more`를 아직 부르지 않음, 받다 만 결과가 탭을 닫을 때까지 열려 있음)을 적는다.
- 이 파일의 체크박스를 체크하고, 실행 중에 바뀐 것이 있으면 "구현 뒤 정리에서 바뀐 것" 절을 "이 계획에서 정한 것" 아래에 더한다.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: M3 완료 기록"
```
