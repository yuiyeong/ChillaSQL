# M2 쿼리 실행 코어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 세션에서 SQL 문장 하나를 실행하고, 결과를 500행씩 Tauri Channel로 보내고, 이어서 가져오고, 취소할 수 있게 한다. 화면은 만들지 않는다.

**Architecture:** session actor가 쿼리 하나의 결과 stream을 갖고 `Reading` → `Paused` → `Draining` 상태를 오간다. 실행은 simple query protocol(`simple_query_raw`)로 하고 값은 서버가 만든 text 그대로 받는다. actor는 500행을 읽으면 sink(Tauri Channel)에 보내고 stream을 더 당기지 않는다. 남은 결과를 버릴 때는 별도 연결로 cancel 요청을 보내고 stream을 끝까지 읽는다(cancel + drain). 문장 나누기는 `pg_query::scan`의 token으로 한다.

**Tech Stack:** M1의 stack에 `futures-util` 0.3(`StreamExt`)과 `tauri::ipc::Channel`을 더한다. `tokio-postgres` 0.7.18, `pg_query` 18.1.0, Tauri 2.12.

**Spec:** [기획서](../spec.md) 4.5(쿼리 실행), 4.6(결과 표)의 나눠 가져오기·받다 만 결과·보관 상한, 6장(성능 기준) / [마일스톤](../milestones.md) M2 / [구조](../architecture.md)

## 먼저 확인한 것 (계획 작성 중 확인)

세션 구조를 정하는 사실은 `tokio-postgres` 0.7.18, `pg_query` 18.1.0, `tauri` 2.12.5 source와 scratch test(test DB 대상, 저장소 밖)로 확인했다. 마일스톤의 "먼저 확인할 것"(Channel 직렬화 형식)은 webview가 있어야 잴 수 있어서 Task 1에 둔다.

| 확인한 것 | 결과 | 결정 |
| --- | --- | --- |
| `simple_query_raw`가 주는 것 | `RowDescription`(컬럼 이름만. type OID는 없다) → `Row`(값은 text, NULL은 `None`, 빈 문자열은 `Some("")`) → `CommandComplete(n)` → stream 끝. 요청을 보내고 바로 돌아오며 서버의 응답은 stream을 poll할 때 온다. 행이 없는 문장은 `CommandComplete`만 온다(`INSERT` 3행 → 3, `CREATE TABLE` → 0, 빈 문자열 → 0) | **simple query protocol을 쓴다.** extended protocol(`query_raw`)은 값을 binary로만 받아서 type마다 text 변환을 직접 만들어야 한다. text로 받으면 enum, domain, extension type(`vector`)도 서버의 표기 그대로 나온다 |
| 오류 뒤의 stream | `Err(DbError)` 다음 poll에서 끝난다(`None`). `SELECT *\nFROM nope`의 오류 위치는 `Original(15)`(보낸 text의 1부터 세는 글자 위치) | 오류를 받아도 `None`까지 읽는다. 그래야 ReadyForQuery가 `TxTap`을 지나간다 |
| 조용한 쿼리 | `SELECT pg_sleep(10)`은 끝날 때까지 아무 message도 오지 않는다(RowDescription도 서버 buffer에 있다) | actor는 stream을 기다리는 동안에도 명령(cancel, 상태, 닫기)을 받아야 한다 → `select!` |
| 받다 만 결과 | `SELECT * FROM big_table`에서 500행을 읽는 데 4.2ms. 멈추면 서버는 `active/ClientWrite`로 기다린다. cancel 요청 0.7ms, 남은 32,714행을 45ms에 비우고 `57014`로 끝난다. 다음 쿼리는 0.4ms | 남은 결과 버리기는 cancel + drain (M1 결정 그대로) |
| cancel 없이 stream만 drop | 다음 쿼리가 1.06초 뒤에 답한다(driver가 100만 행을 다 읽고 버린다). 느린 쿼리면 그 쿼리가 끝날 때까지 기다린다 | drop만으로 버리지 않는다. 반드시 cancel을 보낸다 |
| cancel 요청 | `cancel_token().cancel_query_raw(stream, NoTls)`에 직접 연 `TcpStream`을 넘기면 된다(`&mut TcpStream`도 받는다). 요청 뒤 서버가 그 연결을 3ms 안에 닫는다(EOF). `pg_sleep(10)`은 cancel 5ms 뒤 `57014`로 끝난다. 쿼리가 없을 때 온 cancel은 서버가 무시한다 | cancel 요청을 보낸 뒤 EOF까지 기다린다. EOF는 서버가 signal을 보냈다는 뜻이라, 그 뒤에 시작한 다음 쿼리가 늦게 온 cancel에 죽지 않는다(50회 반복에서 0회) |
| 실행 중 연결이 끊김 | `pg_terminate_backend` → `Err(DbError 57P01)` 다음부터 `Err(closed)`가 **끝없이 반복**된다(`None`이 오지 않는다). `simple_query_raw`는 닫힌 client에서 바로 `Err`다 | port 구현이 DB 오류가 아닌 `Err`를 `ConnectionLost`로 바꾸고 그 뒤에는 `None`을 돌려준다. drain loop가 돌지 않게 한다 |
| 쿼리 실행 중 client drop | `pg_sleep(5)` 중에 client를 drop하면 driver task가 4.8초 뒤(쿼리가 끝난 뒤)에야 끝난다 | 닫을 때도 cancel을 먼저 보낸다. 그래도 안 끝나면 기다리지 않고 닫는다 |
| `pg_query::split_with_parser` | 정확하다(`BEGIN ATOMIC` 본문도 한 문장). 하지만 text 어디든 문법 오류가 하나라도 있으면 전체가 실패한다. `:id` 파라미터(M9)도 문법 오류다 | 쓰지 않는다. 편집 중인 파일은 대개 어딘가 깨져 있다 |
| `pg_query::split_with_scanner` | keyword가 없는 문장을 조용히 뺀다(`SELEC 2`, `COMIT`). `BEGIN ATOMIC` 본문의 `;`에서 자른다. span에 앞의 공백과 주석이 들어간다 | 쓰지 않는다. 오타 난 문장이 "문장 없음"이 된다 |
| `pg_query::scan` | token마다 종류와 byte 위치를 준다. `;`는 `Ascii59`, 괄호는 `Ascii40`/`Ascii41`, 주석은 `SqlComment`/`CComment`. `$$` 블록과 문자열은 token 하나다. 닫히지 않은 따옴표, `$$`, `/*`는 `Err`다 | **`scan`의 token으로 직접 나눈다.** 괄호 깊이와 `BEGIN ATOMIC … END`(psql과 같은 규칙)만 따라간다. 위의 두 함수가 틀리는 입력 13개에서 scratch로 확인했다 |
| 500행 batch의 JSON | `big_table` 500행(`Vec<Vec<Option<String>>>`)이 130,397 byte, `serde_json` 직렬화 2.8ms(debug build) | Rust 쪽 비용은 충분히 작다. webview까지의 시간은 Task 1에서 잰다 |
| Tauri `Channel::send` | JSON이 8,192 byte 미만이면 `eval`로, 이상이면 webview가 `plugin:__TAURI_CHANNEL__\|fetch`로 가져간다. 500행 batch는 fetch 경로다 | Task 1에서 이 경로의 지연을 잰다 |

## 이 계획에서 정한 것

기획서에 없거나 다르게 정한 것이다. Task 1에서 진행상황의 결정 기록과 기획서에 반영한다.

- **simple query protocol로 실행하고 값은 text로 받는다.** 결과 컬럼은 이름만 안다. type OID(M8의 타입별 표시)와 테이블 OID(M10의 셀 편집)는 그때 `TxTap`이 RowDescription을 읽게 하거나 `prepare`로 Describe해서 얻는다. M2에서는 만들지 않는다.
- **한 번에 문장 하나만 실행한다.** 받은 text에 문장이 2개 이상이면 `MultipleStatements` 오류다. simple query로 여러 문장을 한꺼번에 보내면 서버가 하나의 암묵적 트랜잭션으로 묶어서 4.5의 "순서대로 실행하고 오류가 나면 그 문장에서 멈춤"과 달라진다. 여러 문장 실행은 M8(파일 전체 실행과 문장별 결과 탭)에서 한다.
- **실행할 text는 받은 그대로 보낸다.** 앞뒤를 자르지 않는다. 서버가 알려 주는 오류 위치가 화면이 보낸 text 기준이 된다. 나눌 수 없는 text(닫히지 않은 따옴표)도 그대로 보내 서버의 오류를 보여 준다. 서버는 text 전체를 parse한 뒤에 실행하므로 일부만 실행되는 일은 없다.
- **문장 나누기는 `pg_query::scan`의 token으로 한다**(기획서 4.5는 "SQL 파서로"). 문법 오류가 있는 문장도 문장으로 나눈다.
- **문장 위치는 Rust 안에서는 byte offset, 화면으로는 UTF-16 code unit offset으로 준다.** CodeMirror의 위치가 UTF-16 기준이다.
- **행은 화면이 보관하고 Rust는 보관하지 않는다.** 보관 상한(10만 행)은 Rust가 갖고, batch마다 `retained_from`(화면이 보관할 첫 행 번호)을 알려 준다. 화면은 그보다 앞의 행을 버리고 "다시 실행해야 볼 수 있음"으로 표시한다(M4).
- **batch는 500행 또는 cell byte 합 4 MiB 중 먼저 닿는 쪽에서 끊는다.** 큰 JSONB나 `bytea`가 있는 결과에서 batch 하나가 수백 MB가 되지 않게 한다.
- **batch를 보낸 뒤 항목을 하나 더 읽는다(look-ahead).** 정확히 500행인 결과가 "받다 만 결과"로 남지 않고 바로 끝난다.
- **소요 시간(`elapsed`)은 `Paused`로 기다린 시간을 뺀다.** 화면이 스크롤하지 않아 멈춰 있던 시간은 쿼리의 시간이 아니다.
- **실행 중인 세션의 상태는 actor가 가진 값으로 답한다.** 쿼리가 끝날 때마다 `tx_status()`를 읽어 저장한다(M1에서 넘어온 주의 사항).
- **취소는 "쿼리를 멈추고 남은 결과를 버린다"이다.** 받다 만 결과에도 쓴다. 취소 뒤에 온 행은 보내지 않고 `Cancelled`로 끝낸다.
- **조금씩 오는 행을 timer로 미리 보내지 않는다.** 500행이 차거나 결과가 끝나야 보낸다. 필요해지면 그때 넣는다.
- 타임아웃(4.5, M8), 받다 만 결과 10분 뒤 자동 닫기(4.6, M6), 화면 쪽 TypeScript wrapper(M3)는 M2에 넣지 않는다.

## Global Constraints

- M1의 Global Constraints를 그대로 따른다(macOS 전용, `chilla-core`는 `tauri`에 의존하지 않음, 탭 = 세션, 비밀번호는 `Password`로만, 사용자에게 보이는 오류 message는 한국어).
- layer 규칙: `domain`은 I/O crate를 쓰지 않는다. `application`은 `tokio`의 `sync`, `task`, `time`만 쓴다. `pg_query`와 `tokio_postgres`는 `infrastructure`에서만 쓴다. `application`의 test module도 `crate::infrastructure`를 쓰지 못한다(`layer_deps`가 본다).
- batch 크기 500행, batch byte 상한 4 MiB(`4 * 1024 * 1024`), 보관 상한 100,000행.
- 시간은 `tokio::time::Instant`로 잰다(test가 시간을 멈출 수 있게).
- 화면으로 가는 JSON의 키는 camelCase, 구분 값(`type`, `outcome`, `kind`)은 snake_case다.
- test DB: `postgres://chilla:chilla@127.0.0.1:54318/chilla_test`(`big_table` 100만 행, 컬럼 `id, name, amount, created_at, is_active, tags, payload, note`). TLS test DB는 port `54319`, 인증서는 `db/tls/ca.crt`, host는 `localhost`.
- 모든 명령은 저장소 루트에서 실행한다. commit 전에 `pnpm check`를 통과시킨다.
- commit 메시지는 영어 conventional prefix에 나머지는 한국어로 쓴다.

## Review Focus

1. **행이 아주 넓은 결과**(MB 단위의 JSONB, `bytea`, 긴 text): 500행을 다 채우기 전에 batch가 끊겨야 한다. batch 하나가 수백 MB가 되면 화면이 멈춘다. → Task 4 Step 1 `wide_rows_end_a_batch_early`
2. **취소 직후 같은 세션에서 실행한 다음 쿼리**: 늦게 도착한 cancel이 다음 쿼리를 죽이면 안 된다. 사용자는 취소하지 않은 쿼리에서 "canceling statement due to user request"를 본다. → Task 3 Step 1 `cancel_waits_until_the_server_has_handled_it`, Task 5 Step 1 `a_late_cancel_does_not_hit_the_next_query`
3. **쿼리 실행 중 연결이 밖에서 끊김**(서버 재시작, `pg_terminate_backend`, VPN): 쿼리는 `Finished`로 끝나고 세션은 `Lost`가 돼야 한다. driver는 닫힌 뒤 같은 오류를 끝없이 돌려주므로 actor가 CPU를 태우며 돌면 안 된다. → Task 3 Step 1 `terminated_connection_ends_the_rows`, Task 4 Step 1 `connection_lost_mid_query_finishes_and_reports_lost`, Task 5 Step 1 `terminated_backend_finishes_the_query_and_loses_the_session`
4. **편집 중인 text**(닫히지 않은 따옴표와 괄호, 오타 난 keyword, `:id`): 나누기가 panic하거나 문장을 조용히 빼면 안 된다. 실행하면 서버의 오류와 위치가 그대로 보여야 한다. → Task 2 Step 1 `statements_with_syntax_errors_are_still_statements`·`unterminated_text_cannot_be_split`, Task 5 Step 1 `text_that_cannot_be_split_gets_the_server_error`
5. **cancel 요청을 보낼 수 없는 상태에서 세션 닫기**(DB로 가는 network가 죽음): 닫기와 앱 종료가 쿼리가 끝날 때까지 멈춰 있으면 안 된다. → Task 4 Step 1 `close_does_not_wait_for_a_query_that_cannot_be_cancelled`

---

## File Structure

```
crates/chilla-core/src/
├── domain/
│   ├── statement.rs                새로. StatementSpan
│   └── query.rs                    새로. QueryId, Column, Row, ServerError, RowBatch, QueryEvent, QueryOutcome, QueryLimits
├── application/
│   ├── ports.rs                    StatementSplitter, RowSource, QueryCancel, DbConnection에 start_query·cancel_handle
│   ├── session_actor.rs            Execute, FetchMore, Cancel 명령과 쿼리 상태
│   ├── app.rs                      split_statements, execute, fetch_more, cancel_query
│   └── test_support.rs             FakeFeed, FakeSplitter. FakeConnection을 새 port에 맞춤
└── infrastructure/
    ├── statement_splitter.rs       새로. PgQuerySplitter
    └── postgres/
        ├── mod.rs                  PgConnection에 start_query·cancel_handle, close의 grace
        ├── rows.rs                 새로. PgRows (RowSource)
        └── cancel.rs               새로. PgCancel (QueryCancel)
crates/chilla-core/tests/
├── statements.rs                   새로. 문장 나누기 (pg_query_smoke.rs는 지운다)
├── query_stream.rs                 새로. port 수준: 결과 stream, cancel, 끊김
├── queries.rs                      새로. App 수준: 완료 기준
└── support/mod.rs                  connect(), 이벤트 수집 helper
src-tauri/src/
├── commands.rs                     split_statements, execute_query, fetch_more, cancel_query와 DTO
├── error.rs                        새 AppError의 kind
└── lib.rs                          PgQuerySplitter 조립, command 등록
```

각 `mod.rs`는 새 type을 `pub use`로 내보낸다. 아래 Interfaces의 경로는 그 기준이다(예: `chilla_core::application::RowSource`, `chilla_core::infrastructure::PgQuerySplitter`).

---

### Task 1: Channel 직렬화 형식 확인과 결정 기록 (먼저 확인할 것)

**Files:**
- Create 후 Delete: `src-tauri/src/probe.rs`, `src/shared/api/channelProbe.ts`
- 임시로 Modify 후 되돌림: `src-tauri/src/lib.rs`, `src/main.tsx`
- Modify: `docs/progress.md`, `docs/spec.md`

**Interfaces:**
- Produces: batch를 JSON으로 보낸다는 결정(Task 6의 `QueryEventDto`가 따른다). 진행상황의 결정 기록

- [x] **Step 1: probe 작성**

`probe.rs`에 command 2개를 둔다.

```rust
/// 500행 batch를 `count`번, `gap_ms` 간격으로 보낸다.
#[tauri::command]
pub async fn probe_channel(on_batch: tauri::ipc::Channel<ProbeBatch>, count: u32, gap_ms: u64);
/// 화면이 잰 결과를 `CHANNEL_PROBE <report>` 한 줄로 stdout에 찍는다.
#[tauri::command]
pub fn probe_report(report: String);

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeBatch {
    r#type: &'static str,              // "rows"
    first_row: u64,
    rows: Vec<Vec<Option<String>>>,
    retained_from: u64,
    elapsed_micros: u64,
    sent_at_ms: f64,                   // send 직전의 UNIX epoch ms
}
```

행은 DB 없이 `big_table`과 같은 모양으로 만든다: 행 `i`는 `[i, "user_{i}", "{(i % 100000) / 100.0:.2}", "2026-01-01 00:00:00+00", "t"|"f", "{tag0,tag3}", {"i": i, "hash": <32자>, "nested": {"even": true}}의 text, note]`이고 note는 `i % 10 == 0`이면 `None`, `5`면 `Some("")`, 아니면 `"x"`를 `i % 200`번. JSON 하나가 130 KB 안팎이어야 한다(실제 `big_table` batch가 130,397 byte였다).

`channelProbe.ts`는 `@tauri-apps/api/core`의 `Channel`과 `invoke`로 두 번 잰다. message마다 `Date.now() - message.sentAtMs`를 모은다.

| 측정 | 인자 | 보고할 값 |
| --- | --- | --- |
| `spaced` | `count: 20, gapMs: 50` | 지연의 median, max (ms) |
| `burst` | `count: 200, gapMs: 0` (10만 행) | 첫 batch를 받은 때부터 마지막 batch까지 걸린 시간, 지연의 max (ms) |

끝나면 `probe_report`에 `{ bytes: JSON.stringify(batch).length, spaced, burst }`를 JSON 문자열로 넘긴다. `src/main.tsx`에서 render 뒤에 한 번 부른다.

- [x] **Step 2: 측정**

Run: `pnpm tauri dev` (background). stdout에 `CHANNEL_PROBE`가 나오면 그 줄을 기록하고 process를 끝낸다.

Expected: `CHANNEL_PROBE {"bytes":13…,"spaced":{…},"burst":{…}}`

판정 기준:

| 조건 | 결정 |
| --- | --- |
| `spaced` median ≤ 20ms 이고 `burst` 전체 ≤ 2,000ms | **JSON으로 확정.** 6장의 "첫 결과 표시 0.1초" 중 Channel이 쓰는 몫이 1/5 이하다 |
| 그 밖 | 여기서 멈추고 사용자에게 수치를 보고한다. Task 6의 DTO 형식을 다시 정한 뒤 진행한다 |

- [x] **Step 3: probe 삭제**

`probe.rs`와 `channelProbe.ts`를 지우고 `lib.rs`와 `main.tsx`를 되돌린다.

Run: `git status --short`
Expected: `docs/` 밖에 바뀐 파일이 없다.

- [x] **Step 4: 결정 기록**

- `docs/progress.md`: M2 상태를 `진행 중`으로 바꾼다. 결정 기록에 "이 계획에서 정한 것"의 항목을 한 줄씩, Step 2의 수치와 결정을 한 줄로 남긴다.
- `docs/spec.md` 4.5 문장 나누기 행: "pg\_query의 scanner(PostgreSQL의 lexer)로 문장 경계를 판별. `$$` 블록, 문자열, 주석 안의 `;`는 경계로 보지 않음. 문법 오류가 있는 문장도 문장으로 나눔"
- `docs/spec.md` 4.6 나눠 가져오기 행 끝에 "행이 크면 500행이 되기 전에 끊음(4 MiB)", 보관 상한 행 끝에 "행은 화면이 보관하고, 어디부터 보관할지는 Rust가 알려 줌"을 더한다.

- [x] **Step 5: Commit**

```bash
git add docs
git commit -m "docs: M2 결정 기록과 Channel 직렬화 형식 확인"
```

---

### Task 2: 문장 나누기

**Files:**
- Create: `crates/chilla-core/src/domain/statement.rs`, `crates/chilla-core/src/infrastructure/statement_splitter.rs`
- Modify: `crates/chilla-core/src/domain/mod.rs`, `crates/chilla-core/src/application/ports.rs`, `crates/chilla-core/src/application/mod.rs`, `crates/chilla-core/src/infrastructure/mod.rs`
- Delete: `crates/chilla-core/tests/pg_query_smoke.rs` (`split_with_parser`를 쓰지 않는다)
- Test: `crates/chilla-core/tests/statements.rs`

**Interfaces:**
- Produces:

```rust
// chilla_core::domain
/// 문장 하나의 위치. byte offset이고 `end`는 포함하지 않는다. 문장을 끝내는 `;`는 들어가지 않는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatementSpan { pub start: usize, pub end: usize }

// chilla_core::application
pub trait StatementSplitter: Send + Sync {
    fn split(&self, sql: &str) -> Result<Vec<StatementSpan>, SplitError>;
}
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("문장을 나누지 못했습니다: {message}")]
pub struct SplitError { pub message: String }

// chilla_core::infrastructure
pub struct PgQuerySplitter;                      // impl StatementSplitter
```

나누는 규칙 (`pg_query::scan(sql)`의 token을 차례로 본다):

- `SqlComment`, `CComment`는 건너뛴다. 문장의 일부가 아니다.
- span은 문장의 첫 token의 `start`부터 마지막 token의 `end`까지다. 앞의 공백과 주석, 뒤의 주석은 들어가지 않는다.
- `Ascii59`(`;`)가 괄호 깊이 0이고 atomic 깊이 0일 때 문장이 끝난다. token이 하나도 없는 문장(`;;`)은 만들지 않는다.
- 괄호 깊이: `Ascii40`에서 +1, `Ascii41`에서 -1(0 아래로 내려가지 않는다). `CREATE RULE … DO (a; b)`의 `;`가 여기 걸린다.
- atomic 깊이(psql과 같은 규칙): `BeginP` 바로 다음 token이 `Atomic`이면 1이 된다. 깊이가 1 이상일 때 `Case`에서 +1, `EndP`에서 -1. `BEGIN;`(트랜잭션)은 다음 token이 `Atomic`이 아니라서 해당하지 않는다.
- `scan`이 `Err`면(닫히지 않은 따옴표, `$$`, `/*`) `SplitError { message: <pg_query의 message> }`다.

- [ ] **Step 1: 실패하는 test 작성**

`tests/statements.rs`. helper `texts(sql) -> Vec<&str>`는 `PgQuerySplitter.split(sql).unwrap()`의 span마다 `&sql[start..end]`를 돌려준다. `spans(sql) -> Vec<(usize, usize)>`는 `(start, end)`다.

```rust
/// M2 완료 기준: `$$` 블록, 문자열, 주석 안의 `;`를 경계로 보지 않는다.
#[test] fn semicolons_inside_dollar_quotes_strings_and_comments_are_not_boundaries() {
    // texts("SELECT 1; DO $$ BEGIN PERFORM 1; END $$; SELECT ';'")
    //   == ["SELECT 1", "DO $$ BEGIN PERFORM 1; END $$", "SELECT ';'"]
    // texts("SELECT $tag$ ; $tag$; SELECT E'it\\'s;'; SELECT \"a;b\" FROM t")
    //   == ["SELECT $tag$ ; $tag$", "SELECT E'it\\'s;'", "SELECT \"a;b\" FROM t"]
    // texts("SELECT 1 /* ; */ + 2; -- ;\nSELECT 3") == ["SELECT 1 /* ; */ + 2", "SELECT 3"]
}
#[test] fn spans_run_from_the_first_token_to_the_last() {
    // spans("  -- leading; comment\nSELECT 1;\n\n/* c; */ SELECT 2 -- trailing;\n; SELECT 3")
    //   == [(22, 30), (42, 50), (66, 74)]
}
#[test] fn offsets_are_bytes() {
    // spans("SELECT '한글;'; SELECT '😀' ; SELECT 2") == [(0, 16), (18, 31), (34, 42)]
}
#[test] fn empty_statements_are_skipped() {
    // texts("SELECT 1;;  ; SELECT 2;") == ["SELECT 1", "SELECT 2"]
    // "", "  \n ", "-- only comment", "/* a */  ", " ; ; " 는 모두 빈 Vec
}
/// Review Focus 4
#[test] fn statements_with_syntax_errors_are_still_statements() {
    // texts("SELECT 1; SELEC 2; COMIT; SELECT :id::int")
    //   == ["SELECT 1", "SELEC 2", "COMIT", "SELECT :id::int"]
    // texts("SELECT (1; SELECT 2") == ["SELECT (1; SELECT 2"]      // 닫히지 않은 괄호는 뒤를 한 문장으로 묶는다
}
#[test] fn parenthesized_and_atomic_bodies_stay_whole() {
    // texts("CREATE RULE r AS ON INSERT TO t DO ALSO (INSERT INTO a VALUES (1); INSERT INTO b VALUES (2)); SELECT 1").len() == 2
    // texts("CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 END; SELECT 2; END; SELECT 3")
    //   의 길이 2, [1] == "SELECT 3"
    // texts("BEGIN; SELECT CASE WHEN true THEN 1 END; COMMIT; END")
    //   == ["BEGIN", "SELECT CASE WHEN true THEN 1 END", "COMMIT", "END"]
}
/// Review Focus 4
#[test] fn unterminated_text_cannot_be_split() {
    // "SELECT 'unterminated", "SELECT 1; DO $$ BEGIN", "SELECT 1 /* open" 각각
    //   split == Err(SplitError), message에 "unterminated"가 들어 있다
}
#[test] fn ten_thousand_statements_split_within_100ms() {
    // "SELECT {i} FROM big_table WHERE id = {i};\n"을 10,000번 이은 text → 길이 10,000, 100ms 안
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p chilla-core --test statements`
Expected: FAIL. `PgQuerySplitter`가 없어 compile error가 난다.

- [ ] **Step 3: `StatementSpan`, `StatementSplitter`, `PgQuerySplitter` 구현**

위 규칙대로 구현한다. `pg_query_smoke.rs`를 지운다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: pg_query scanner로 문장 나누기"
```

---

### Task 3: 결과 stream과 cancel (port와 `PgConnection`)

**Files:**
- Create: `crates/chilla-core/src/domain/query.rs`, `crates/chilla-core/src/infrastructure/postgres/rows.rs`, `crates/chilla-core/src/infrastructure/postgres/cancel.rs`
- Modify: `crates/chilla-core/Cargo.toml` (`futures-util = { version = "0.3", default-features = false }`, dev `tokio`에 `test-util`), `crates/chilla-core/src/domain/mod.rs`, `crates/chilla-core/src/application/ports.rs`, `crates/chilla-core/src/application/mod.rs`, `crates/chilla-core/src/application/test_support.rs`, `crates/chilla-core/src/infrastructure/postgres/mod.rs`, `crates/chilla-core/tests/support/mod.rs`
- Test: `crates/chilla-core/tests/query_stream.rs`

**Interfaces:**
- Consumes: M1의 `DbConnection`, `PgConnection`, `tls::negotiate`, `ConnectionProfile`
- Produces:

```rust
// chilla_core::domain (query.rs)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct QueryId(pub u64);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column { pub name: String }

/// 값은 서버가 만든 text다. `None`은 NULL, `Some("")`은 빈 문자열이다.
pub type Row = Vec<Option<String>>;

/// 서버가 돌려준 오류.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerError {
    pub code: String,                 // SQLSTATE
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// 보낸 text에서의 위치. 1부터 세는 글자(char) 번호다.
    pub position: Option<u32>,
}

// chilla_core::application (ports.rs)
pub trait DbConnection: Send + 'static {
    type Rows: RowSource;
    type Cancel: QueryCancel;
    fn backend_pid(&self) -> i32;
    fn tx_status(&self) -> impl Future<Output = TxStatus> + Send;
    fn is_closed(&self) -> bool;
    /// 문장을 보낸다. 서버의 응답은 기다리지 않는다. 연결이 끊겨 있으면 `ConnectionLost`다.
    fn start_query(&self, sql: &str) -> impl Future<Output = Result<Self::Rows, QueryError>> + Send;
    /// 이 연결에서 실행 중인 쿼리를 멈추는 요청. 연결과 따로 살아서 다른 task에서 쓸 수 있다.
    fn cancel_handle(&self) -> Self::Cancel;
    fn close(self) -> impl Future<Output = ()> + Send;
}

/// 쿼리 하나의 결과. 읽지 않으면 서버가 기다린다(backpressure).
pub trait RowSource: Send + 'static {
    /// 다음 항목. 결과가 끝나면 `None`이다. cancel-safe여야 한다(`select!`에서 쓴다).
    ///
    /// `Err(Server)` 뒤에도 `None`까지 읽어야 연결이 다음 쿼리를 받는다.
    /// `Err(ConnectionLost)`는 마지막 항목이고 그 뒤에는 `None`이다.
    fn next(&mut self) -> impl Future<Output = Option<Result<RowItem, QueryError>>> + Send;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowItem {
    Columns(Vec<Column>),
    Row(Row),
    /// 문장이 끝났다. `rows`는 서버가 알려 준 행 수다(영향받은 행 또는 돌려준 행).
    Complete { rows: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum QueryError {
    #[error("{}", .0.message)]
    Server(ServerError),
    #[error("연결이 끊겼습니다: {message}")]
    ConnectionLost { message: String },
}

pub trait QueryCancel: Send + 'static {
    /// cancel 요청을 보내고 서버가 처리할 때까지 기다린다. 실행 중인 쿼리가 없으면 서버가 무시한다.
    fn cancel(self) -> impl Future<Output = Result<(), CancelError>> + Send;
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("취소 요청을 보내지 못했습니다: {message}")]
pub struct CancelError { pub message: String }

// chilla_core::infrastructure::postgres
pub struct PgRows { .. }       // impl RowSource. Pin<Box<SimpleQueryStream>>을 갖는다
pub struct PgCancel { .. }     // impl QueryCancel
```

`application/test_support.rs`의 가짜 연결 (Task 4, 5의 test가 쓴다):

```rust
impl FakeLink {
    /// 다음 `start_query`가 돌려줄 결과를 예약한다(FIFO). 예약이 없으면 `Complete { rows: 0 }`만 있는 결과다.
    pub(crate) fn expect_query(&self) -> FakeFeed;
    /// `start_query`가 받은 SQL, 받은 순서대로.
    pub(crate) fn sent(&self) -> Vec<String>;
    /// `QueryCancel::cancel`이 불린 횟수.
    pub(crate) fn cancels(&self) -> usize;
    /// 이후의 cancel이 `Err(CancelError)`를 돌려주고 아무것도 하지 않게 한다.
    pub(crate) fn fail_cancels(&self);
    /// 다음 `count`번의 cancel이 `Ok(())`를 돌려주되 결과를 끝내지 않게 한다(쿼리보다 먼저 닿은 cancel).
    pub(crate) fn ignore_cancels(&self, count: usize);
    /// `tx_status`가 돌려줄 값. 처음에는 `Idle`이다.
    pub(crate) fn set_tx(&self, tx: TxStatus);
}

/// 가짜 결과 하나에 항목을 넣는 손잡이. Clone이다.
impl FakeFeed {
    pub(crate) fn columns(&self, names: &[&str]);
    /// 행 `i`는 `vec![Some(i.to_string())]`이다.
    pub(crate) fn rows(&self, range: std::ops::Range<u64>);
    pub(crate) fn row(&self, row: Row);
    /// `Complete { rows }`를 넣고 결과를 끝낸다.
    pub(crate) fn complete(&self, rows: u64);
    /// 항목 하나를 그대로 넣는다. 결과를 끝내지 않는다.
    pub(crate) fn push(&self, item: Result<RowItem, QueryError>);
    /// `Err(Server(server_error(code)))`를 넣고 결과를 끝낸다.
    pub(crate) fn fail(&self, code: &str);
    /// `Err(ConnectionLost)`를 넣고 결과를 끝낸다. 연결도 끊긴 것으로 만든다(`is_closed` == true).
    pub(crate) fn lose(&self);
    /// 넣었지만 아직 읽히지 않은 항목 수.
    pub(crate) fn unread(&self) -> usize;
}
```

`pub(crate) fn server_error(code: &str) -> ServerError`는 `code`만 채운 오류다(`message`는 `code`와 같고 나머지는 `None`).

가짜의 동작: 끝나지 않은 결과에서 `next`는 항목이 올 때까지 기다린다. 가짜 cancel은 서버처럼 끝나지 않은 결과에 `Err(Server(server_error("57014")))`를 넣고 끝낸다. 끊긴 연결의 `start_query`는 `Err(ConnectionLost)`다. `tx_status`는 끝나지 않은 결과가 있는 동안 끝나지 않는다(실제 연결에서 ReadyForQuery가 socket에 남아 멈추는 것을 흉내 낸다).

`PgConnection` 구현 규칙:

- `start_query`: `client.simple_query_raw(sql)`. `Err`는 `ConnectionLost`.
- `PgRows::next`: `RowDescription` → `Columns`, `Row` → `Row`(cell마다 `get(i).map(str::to_owned)`), `CommandComplete(n)` → `Complete { rows: n }`. `as_db_error()`가 있는 `Err`는 `Server`(`position`은 `ErrorPosition::Original`만, 나머지는 `None`). 그 밖의 `Err`는 `ConnectionLost`로 돌려주고, 이후의 호출은 stream을 poll하지 않고 `None`을 돌려준다.
- `PgConnection`은 연결할 때 쓴 `ConnectionProfile`을 갖는다(비밀번호는 없다). `cancel_handle`은 `client.cancel_token()`과 그 profile을 가진 `PgCancel`을 만든다.
- `PgCancel::cancel`: 연결할 때와 같은 방법으로 stream을 연다(TCP, `sslmode`에 따라 `tls::negotiate`. `TxTap`은 씌우지 않는다). `cancel_query_raw(&mut stream, NoTls)` 뒤 서버가 연결을 닫을 때까지 읽는다(EOF와 read 오류 모두 닫힌 것이다). 전체에 `PgConnector`의 connect timeout(기본 10초)을 건다. 실패는 `CancelError`.
- `close`: client를 drop하고 driver task를 최대 1초 기다린다. 그 안에 끝나지 않으면 `abort`한다.

- [ ] **Step 1: 실패하는 test 작성**

`tests/support/mod.rs`에 `pub async fn connect() -> PgConnection`(`local_profile()`과 `password()`로 연결)과 `pub async fn collect<R: RowSource>(rows: &mut R) -> Vec<Result<RowItem, QueryError>>`(`None`까지 모음)를 더한다. `tests/query_stream.rs`:

```rust
#[tokio::test] async fn select_yields_columns_rows_and_the_count() {
    // start_query("SELECT 1 AS a, NULL AS b, '' AS c, ARRAY[1,2] AS d") 를 collect
    //   == [Ok(Columns([a, b, c, d])), Ok(Row([Some("1"), None, Some(""), Some("{1,2}")])), Ok(Complete { rows: 1 })]
}
#[tokio::test] async fn statements_without_rows_yield_only_the_count() {
    // "CREATE TEMP TABLE t (id int)" → [Ok(Complete { rows: 0 })]
    // "INSERT INTO t VALUES (1),(2),(3)" → [Ok(Complete { rows: 3 })]
    // "UPDATE t SET id = id + 1 WHERE id > 1 RETURNING id" → Columns([id]), Row 2개, Complete { rows: 2 }
    // "" → [Ok(Complete { rows: 0 })]
}
#[tokio::test] async fn server_error_carries_the_position_and_the_connection_goes_on() {
    // "SELECT *\nFROM nope" → [Err(Server(e))], e.code == "42P01", e.position == Some(15)
    // "SELECT 1/0" → [Err(Server(e))], e.code == "22012", e.position == None
    // 같은 연결에서 "SELECT 42" → Row([Some("42")])가 있다
    // tx_status().await == Idle
}
#[tokio::test] async fn unread_rows_make_the_server_wait() {
    // "SELECT * FROM big_table"에서 Row 500개만 읽고 300ms 기다린다
    // admin의 pg_stat_activity에서 이 backend의 state == "active", wait_event == "ClientWrite"
}
#[tokio::test] async fn cancel_discards_a_half_read_result() {
    // 위처럼 500행을 읽은 뒤 cancel_handle().cancel() == Ok(())
    // collect의 마지막 항목 == Err(Server(code "57014")), collect까지 1초 안
    // 같은 연결에서 "SELECT 42"가 된다
}
/// M2 완료 기준의 port 수준 확인.
#[tokio::test] async fn cancel_ends_a_sleeping_query() {
    // start_query("SELECT pg_sleep(10)") 뒤 200ms 동안 next가 끝나지 않는다(timeout)
    // cancel() == Ok(()), collect에 Err(Server(code "57014"))가 있고 cancel부터 1초 안에 끝난다
}
/// Review Focus 2
#[tokio::test] async fn cancel_waits_until_the_server_has_handled_it() {
    // 50번 반복: start_query("SELECT pg_sleep(10)") → cancel().await → collect → 곧바로
    //   start_query("SELECT 42")를 collect == [Columns, Row([Some("42")]), Complete { rows: 1 }]
}
#[tokio::test] async fn cancel_with_nothing_running_is_harmless() {
    // cancel() == Ok(()), 100ms 뒤 "SELECT 42"가 된다
}
#[tokio::test] async fn cancel_works_over_tls() {
    // tls_profile("localhost", SslMode::VerifyFull, Some("ca.crt"))로 연결
    // "SELECT pg_sleep(10)" → cancel() == Ok(()) → collect에 Err(Server(code "57014"))
}
/// Review Focus 3
#[tokio::test] async fn terminated_connection_ends_the_rows() {
    // start_query("SELECT pg_sleep(10)"), 200ms 뒤 admin에서 pg_terminate_backend
    // collect == [.., Err(Server(code "57P01")), Err(ConnectionLost { .. })] 로 끝난다 (2초 안에 collect가 돌아온다)
    // is_closed() == true, start_query("SELECT 1") == Err(ConnectionLost { .. })
}
#[tokio::test] async fn close_does_not_wait_for_a_running_query() {
    // start_query("SELECT pg_sleep(10)")의 PgRows를 drop하고 close().await → 2초 안에 돌아온다
}
```

`postgres/mod.rs`의 `#[cfg(test)]`에 하나를 더한다. `PgCancel`의 대상이 private이라 여기 둔다(`tx_status_follows_the_server`와 같은 이유).

```rust
#[tokio::test] async fn cancel_to_an_unreachable_server_is_an_error() {
    // test DB에 연결해 cancel_handle()을 얻고, 그 PgCancel의 port를 닫힌 port로 바꾼다
    //   (TcpListener를 127.0.0.1:0에 bind해 port를 얻은 뒤 drop)
    // cancel() == Err(CancelError { .. })
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p chilla-core --test query_stream`
Expected: FAIL. `start_query`가 없어 compile error가 난다.

- [ ] **Step 3: domain type, port, `PgRows`, `PgCancel`, 가짜 연결 구현**

`FakeConnection`이 새 `DbConnection`을 구현해야 crate가 compile된다. 위의 가짜 interface를 이 step에서 만든다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS (M1의 test도 그대로 통과한다)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 결과 stream과 cancel port, PgConnection 구현"
```

---

### Task 4: session actor의 쿼리 실행

**Files:**
- Modify: `crates/chilla-core/src/domain/query.rs`, `crates/chilla-core/src/domain/mod.rs`, `crates/chilla-core/src/application/session_actor.rs`, `crates/chilla-core/src/application/mod.rs`, `crates/chilla-core/src/application/app.rs` (`spawn` 호출 한 곳)
- Test: `session_actor.rs`와 `domain/query.rs`의 `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 3의 `DbConnection::start_query`·`cancel_handle`, `RowSource`, `RowItem`, `QueryError`, `QueryCancel`, `CancelError`, 가짜 연결
- Produces:

```rust
// chilla_core::domain (query.rs)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowBatch {
    /// 결과에서 이 batch 첫 행의 번호(0부터).
    pub first_row: u64,
    pub rows: Vec<Row>,
    /// 화면이 보관할 첫 행 번호. 그 앞의 행은 버린다.
    pub retained_from: u64,
    /// 쿼리를 보낸 뒤 이 batch를 다 읽을 때까지 걸린 시간. `Paused`로 기다린 시간은 뺀다.
    pub elapsed: Duration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryEvent {
    Columns(Vec<Column>),
    Rows(RowBatch),
    /// 쿼리마다 정확히 한 번, 마지막에 온다.
    Finished { outcome: QueryOutcome, elapsed: Duration },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueryOutcome {
    /// `rows`는 서버가 알려 준 행 수다. `Columns`가 왔으면 돌려준 행, 아니면 영향받은 행이다.
    Completed { rows: u64 },
    Failed(ServerError),
    /// 사용자가 취소했다.
    Cancelled,
    /// 다음 쿼리나 세션 닫기에 밀려 버려졌다.
    Discarded,
    ConnectionLost { message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueryLimits {
    pub batch_rows: usize,        // 500
    pub batch_bytes: usize,       // 4 * 1024 * 1024
    pub retained_rows: u64,       // 100_000
}
impl Default for QueryLimits { .. }      // 위의 값
impl QueryLimits {
    /// `received`행을 받은 뒤 화면이 보관할 첫 행 번호: `received.saturating_sub(retained_rows)`.
    pub fn retained_from(&self, received: u64) -> u64;
}

// chilla_core::application
/// 쿼리의 이벤트를 받는 쪽. session actor의 task 안에서 불린다. 오래 막으면 그 세션이 멈춘다.
pub type QuerySink = Box<dyn FnMut(QueryEvent) + Send + 'static>;

// application::session_actor (crate 안에서만)
pub(crate) fn spawn<D: DbConnection>(connection: D, limits: QueryLimits) -> SessionHandle;
impl SessionHandle {
    /// 쿼리를 맡기고 바로 돌아온다. 결과는 `sink`로 간다. task가 끝났으면 `None`이다.
    pub(crate) async fn execute(&self, sql: String, sink: QuerySink) -> Option<QueryId>;
    /// 받다 만 결과의 다음 batch를 읽게 한다. 그 쿼리가 지금 쿼리가 아니거나 버리는 중이면 `Some(false)`다.
    pub(crate) async fn fetch_more(&self, query: QueryId) -> Option<bool>;
    /// 쿼리를 멈추고 남은 결과를 버린다. cancel 요청이 서버에 닿은 뒤 돌아온다.
    /// 그 쿼리가 지금 쿼리가 아니면 아무것도 하지 않고 `Some(Ok(()))`다.
    pub(crate) async fn cancel(&self, query: QueryId) -> Option<Result<(), CancelError>>;
}
```

동작 규칙:

- 세션은 쿼리를 한 번에 하나만 갖는다. 쿼리의 상태는 `Reading`(행을 읽는 중), `Paused`(batch를 보내고 `fetch_more`를 기다림), `Draining`(남은 결과를 버리는 중) 셋이다.
- loop는 `tokio::select!`(`biased`, 명령이 먼저)로 명령과 `rows.next()`를 함께 기다린다. `rows.next()`는 `Reading`과 `Draining`에서만 poll한다. `Paused`에서는 poll하지 않는다(서버가 기다린다).
- `QueryId`는 세션마다 1부터 올라간다. `Execute`는 id를 정해 **바로** 답한다.
- **`Execute`, 쿼리가 없을 때**: `start_query`. `Err(ConnectionLost { message })`면 `Finished { outcome: ConnectionLost { message } }`만 보낸다. `Ok`면 `Reading`.
- **`Reading`**:
  - `Columns` → `QueryEvent::Columns`를 보낸다.
  - `Row` → batch에 넣는다. batch가 `batch_rows`행이 되거나 batch의 cell byte 합(`Some(s)`의 `s.len()` 합)이 `batch_bytes` 이상이면 `Rows`를 보낸다.
  - batch를 보낸 뒤에는 항목을 하나 더 읽는다(look-ahead). 행이면 다음 batch의 첫 행으로 두고 `Paused`가 된다. 결과가 끝나면 아래 "끝"으로 간다.
  - `Complete { rows }` → 값을 기억하고 계속 읽는다.
  - `Err(Server(e))` → 처음 것을 기억하고 계속 읽는다.
  - 끝(`None`) → 남은 batch가 있으면 보내고, `Finished`를 보낸다. 기억한 오류가 있으면 `Failed(e)`, 없으면 `Completed { rows }`(`Complete`가 없었으면 0). 그 뒤 `tx = connection.tx_status().await`로 저장한다.
  - `Err(ConnectionLost { message })` → 남은 batch를 보내고 `Finished`를 보낸다. 기억한 오류가 있으면 `Failed(e)`, 없으면 `ConnectionLost { message }`. `tx_status`는 부르지 않는다.
- **`fetch_more(query)`**: 지금 쿼리이고 `Paused`면 `Reading`으로 바꾸고 `true`. 지금 쿼리이고 `Reading`이면 `true`. 그 밖은 `false`.
- **`cancel(query)`**: 지금 쿼리이고 `Reading`이나 `Paused`면 `Draining(Cancelled)`로 바꾸고, `connection.cancel_handle().cancel()`을 `tokio::spawn`으로 돌려 그 결과를 답한다. 그 밖은 바로 `Ok(())`.
- **`Execute`, 쿼리가 있을 때**: 지금 쿼리가 `Draining`이 아니면 `Draining(Discarded)`로 바꾸고 cancel을 spawn한다. 새 쿼리는 기다리는 자리(하나)에 둔다. 기다리던 쿼리가 이미 있으면 그 sink에 `Finished { outcome: Discarded, elapsed: Duration::ZERO }`를 보내고 바꾼다.
- **`Draining`**: 읽은 행과 오류는 버린다. **결과가 끝나고(`None` 또는 `ConnectionLost`) cancel task도 끝났을 때** `Finished`를 보낸다: `ConnectionLost`로 끝났으면 `ConnectionLost`, 아니면 `Draining`의 이유(`Cancelled` 또는 `Discarded`). 그 뒤 `tx`를 저장하고(끊겼으면 건너뛴다) 기다리던 쿼리를 시작한다. cancel task를 기다리는 이유는 Review Focus 2다.
- **cancel 다시 보내기**: `Draining`에서 cancel task가 끝나고 1초가 지나도 결과가 끝나지 않으면 cancel을 다시 보낸다(결과가 끝날 때까지 1초 간격). cancel이 쿼리보다 먼저 서버에 닿으면 서버가 무시하고 쿼리는 끝까지 돈다. `Execute`를 연달아 두 번 보내면 생길 수 있다. `Draining`의 쿼리는 어차피 버릴 것이라 여러 번 보내도 안전하다.
- **`State`**: 쿼리가 있으면 **기다리지 않고** 답한다: `is_closed()`면 `Lost`, 아니면 `Open { tx: 저장한 값 }`. 쿼리가 없으면 M1대로 `tx_status().await`를 읽어 답하고 저장한다.
- **`Close`, 또는 handle이 모두 drop됨**: 쿼리가 있으면 (`Draining`이 아닐 때) cancel을 spawn하고, 결과가 끝나기를 최대 1초 기다린다. 쿼리의 sink에 `Finished`(`Draining(Cancelled)`였으면 `Cancelled`, 아니면 `Discarded`)를, 기다리던 쿼리의 sink에 `Finished(Discarded)`를 보낸 뒤 `connection.close()`를 한다.
- `elapsed`는 `tokio::time::Instant`로 재고 `Paused`인 동안은 세지 않는다.

- [ ] **Step 1: 실패하는 test 작성**

`domain/query.rs`:

```rust
#[test] fn retained_from_is_zero_until_the_cap_is_passed() {
    // QueryLimits::default(): batch_rows == 500, batch_bytes == 4 * 1024 * 1024, retained_rows == 100_000
    // retained_from(0) == 0, retained_from(100_000) == 0, retained_from(100_500) == 500
}
```

`session_actor.rs`. helper: `session()`은 `(SessionHandle, FakeLink)`(limits는 기본값), `session_with(limits)`, `sink()`는 `(QuerySink, UnboundedReceiver<QueryEvent>)`, `next(&mut events)`는 1초 안에 온 이벤트(없으면 panic), `quiet(&mut events)`는 50ms 동안 이벤트가 없음을 확인한다. M1의 test 4개는 `spawn`의 인자만 고쳐 그대로 둔다.

```rust
#[tokio::test] async fn small_result_arrives_as_one_batch_then_finishes() {
    // feed: columns(["id"]), rows(0..3), complete(3)
    // execute("SELECT 1") == Some(QueryId(1)), link.sent() == ["SELECT 1"]
    // 이벤트: Columns([id]) → Rows { first_row: 0, rows 3개, retained_from: 0 } → Finished { Completed { rows: 3 } }
    // 다음 execute == Some(QueryId(2))
}
#[tokio::test] async fn statement_without_rows_finishes_with_the_count() {
    // feed: complete(3) → 이벤트는 Finished { Completed { rows: 3 } } 하나뿐
}
#[tokio::test] async fn rows_arrive_500_at_a_time_and_wait_for_fetch_more() {
    // feed: columns, rows(0..1200), complete(1200)
    // Columns → Rows { first_row: 0, 500행 } → quiet. feed.unread() == 700 (look-ahead로 501개째 행까지 읽었다. Complete 포함 700)
    // fetch_more(q) == Some(true) → Rows { first_row: 500, 500행 } → quiet
    // fetch_more(q) == Some(true) → Rows { first_row: 1000, 200행 } → Finished { Completed { rows: 1200 } }
}
#[tokio::test] async fn result_of_exactly_500_rows_finishes_without_fetch_more() {
    // feed: rows(0..500), complete(500) → Rows { 500행 } → Finished { Completed { rows: 500 } }
}
/// Review Focus 1
#[tokio::test] async fn wide_rows_end_a_batch_early() {
    // limits { batch_rows: 500, batch_bytes: 1000, retained_rows: 100_000 }
    // feed: 400 byte짜리 cell 하나인 행 5개, complete(5)
    // Rows { first_row: 0, 3행 } → quiet → fetch_more → Rows { first_row: 3, 2행 } → Finished
}
#[tokio::test] async fn retained_from_moves_once_the_cap_is_passed() {
    // limits { batch_rows: 2, batch_bytes: 기본값, retained_rows: 4 }, feed: rows(0..7), complete(7)
    // fetch_more를 반복하며 받은 Rows의 (first_row, retained_from) == [(0, 0), (2, 0), (4, 2), (6, 3)], 그 뒤 Finished
}
#[tokio::test] async fn fetch_more_for_another_query_is_refused() {
    // 받다 만 쿼리 q에서 fetch_more(QueryId(99)) == Some(false)
    // q가 끝난 뒤 fetch_more(q) == Some(false)
}
#[tokio::test] async fn server_error_keeps_the_rows_received_before_it() {
    // feed: columns, rows(0..3), fail("22012") → Columns → Rows { 3행 } → Finished { Failed(code "22012") }
}
#[tokio::test] async fn next_execute_discards_the_previous_result() {
    // A의 feed: rows(0..1200) (끝내지 않는다), B의 feed: rows(0..1), complete(1)
    // execute(A) → Rows { 500행 }. execute(B) == Some(QueryId(2)) 가 바로 돌아온다
    // A의 이벤트: Finished { Discarded } (그 사이 Rows 없음). link.cancels() == 1
    // B의 이벤트: Rows { 1행 } → Finished { Completed { rows: 1 } }. link.sent() == [A, B]
}
#[tokio::test] async fn execute_while_draining_replaces_the_waiting_query() {
    // link.fail_cancels()로 A가 Draining에 머물게 한다. A의 feed는 끝내지 않는다
    // execute(A), execute(B), execute(C) → B의 이벤트: Finished { Discarded }. link.sent() == [A]
    // A의 feed.complete(0) → A: Finished { Discarded }, link.sent() == [A, C]
}
#[tokio::test] async fn cancel_ends_a_running_query_as_cancelled() {
    // feed에 아무것도 넣지 않는다(pg_sleep처럼). execute → quiet
    // cancel(q) == Some(Ok(())), link.cancels() == 1 → Finished { Cancelled }
}
#[tokio::test] async fn cancel_of_a_half_read_result_drops_the_rest() {
    // feed: rows(0..1200). Rows { 500행 } 뒤 cancel(q) == Some(Ok(())) → Finished { Cancelled } (그 사이 Rows 없음)
}
#[tokio::test] async fn cancel_of_a_finished_or_unknown_query_does_nothing() {
    // 끝난 q와 QueryId(99)에 cancel == Some(Ok(())), link.cancels() == 0
}
#[tokio::test] async fn failed_cancel_reports_the_error() {
    // link.fail_cancels(), feed는 끝내지 않는다. cancel(q) == Some(Err(CancelError { .. }))
    // feed.complete(0) → Finished { Cancelled }
}
#[tokio::test(start_paused = true)] async fn cancel_is_sent_again_when_the_query_outlives_it() {
    // link.ignore_cancels(1), 끝내지 않는 feed. cancel(q) == Some(Ok(())), link.cancels() == 1, quiet
    // tokio::time::advance(1초) 뒤 link.cancels() == 2 → Finished { Cancelled }
}
#[tokio::test] async fn state_answers_while_a_query_is_running() {
    // "BEGIN": link.set_tx(InTransaction), feed.complete(0) → Finished 뒤 state() == Open { tx: InTransaction }
    // 끝내지 않는 feed로 execute → state()가 1초 안에 Open { tx: InTransaction }
    //   (가짜의 tx_status는 끝나지 않은 결과가 있으면 영영 끝나지 않는다. actor가 기다리면 이 test가 timeout난다)
}
#[tokio::test] async fn start_query_on_a_lost_connection_finishes_the_query() {
    // link.lose() 뒤 execute == Some(QueryId(1)) → Finished { ConnectionLost { .. } }
}
/// Review Focus 3
#[tokio::test] async fn connection_lost_mid_query_finishes_and_reports_lost() {
    // feed: rows(0..3), lose() → Rows { 3행 } → Finished { ConnectionLost { .. } }, state() == Lost
}
#[tokio::test] async fn server_error_before_the_connection_dies_is_the_outcome() {
    // feed: push(Err(Server(server_error("57P01")))), lose() → Finished { Failed(code "57P01") }, state() == Lost
}
#[tokio::test] async fn close_with_a_running_query_cancels_it_first() {
    // 끝내지 않는 feed. handle.close().await → link.cancels() == 1, link.closed(), 이벤트: Finished { Discarded }
}
/// Review Focus 5
#[tokio::test(start_paused = true)] async fn close_does_not_wait_for_a_query_that_cannot_be_cancelled() {
    // link.fail_cancels(), 끝내지 않는 feed. close()가 (가짜 시간) 2초 안에 돌아오고 link.closed()
}
#[tokio::test(start_paused = true)] async fn elapsed_does_not_count_the_time_spent_paused() {
    // feed: rows(0..1200), complete(1200). 첫 Rows 뒤 tokio::time::advance(60초), fetch_more
    // 두 번째 Rows의 elapsed < 1초
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p chilla-core --lib session_actor`
Expected: FAIL. `SessionHandle::execute`가 없어 compile error가 난다.

- [ ] **Step 3: `RowBatch`, `QueryEvent`, `QueryOutcome`, `QueryLimits`와 actor 구현**

위 동작 규칙대로 구현한다. `App::open_session`의 `session_actor::spawn(db)`는 `spawn(db, QueryLimits::default())`로 바꾼다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: session actor가 쿼리를 실행하고 결과를 500행씩 보냄"
```

---

### Task 5: `App`의 쿼리 use case

**Files:**
- Modify: `crates/chilla-core/src/application/app.rs`, `crates/chilla-core/src/application/test_support.rs` (`FakeSplitter`), `crates/chilla-core/tests/sessions.rs`와 `src-tauri/src/lib.rs` (`App::new`의 인자), `crates/chilla-core/tests/support/mod.rs`
- Test: `app.rs`의 `#[cfg(test)]`, `crates/chilla-core/tests/queries.rs`

**Interfaces:**
- Consumes: Task 2의 `StatementSplitter`·`SplitError`·`PgQuerySplitter`, Task 4의 `SessionHandle::execute`·`fetch_more`·`cancel`, `QuerySink`
- Produces:

```rust
impl<C: Connector> App<C> {
    pub fn new(
        projects: Arc<dyn ProjectStore>,
        passwords: Arc<dyn PasswordStore>,
        splitter: Arc<dyn StatementSplitter>,
        connector: C,
    ) -> Self;
    /// 프로젝트나 세션이 없어도 된다.
    pub fn split_statements(&self, sql: &str) -> Result<Vec<StatementSpan>, AppError>;
    pub async fn execute(&self, session: SessionId, sql: String, sink: QuerySink) -> Result<QueryId, AppError>;
    pub async fn fetch_more(&self, session: SessionId, query: QueryId) -> Result<(), AppError>;
    pub async fn cancel_query(&self, session: SessionId, query: QueryId) -> Result<(), AppError>;
}

pub enum AppError {
    // M1의 variant에 더한다
    #[error(transparent)]
    Split(#[from] SplitError),
    #[error("실행할 문장이 없습니다")]
    EmptyStatement,
    #[error("문장이 {count}개입니다. 한 번에 문장 하나만 실행할 수 있습니다")]
    MultipleStatements { count: usize },
    #[error("쿼리 {}은 더 가져올 결과가 없습니다", query.0)]
    QueryNotActive { query: QueryId },
    #[error(transparent)]
    Cancel(#[from] CancelError),
}
```

동작 규칙:

- `execute`: 세션이 없으면 `UnknownSession`. `splitter.split(&sql)`이 `Ok`이고 문장이 0개면 `EmptyStatement`, 2개 이상이면 `MultipleStatements { count }`. 1개이거나 `Err`(나눌 수 없음)면 **받은 `sql`을 그대로** 세션에 보낸다. handle이 `None`을 돌려주면(task가 끝남) `UnknownSession`.
- `fetch_more`: `Some(false)`면 `QueryNotActive`. `None`이면 `UnknownSession`.
- `cancel_query`: `Some(Err(e))`면 `Cancel(e)`. `None`이면 `UnknownSession`.
- 세 use case 모두 `session_state`처럼 handle을 복사해 lock 밖에서 부른다.
- `FakeSplitter`(`test_support.rs`): text를 `;`로 잘라 비어 있지 않은 조각마다 span을 만든다. text에 `'`가 홀수 개면 `Err(SplitError)`다.

- [ ] **Step 1: 실패하는 test 작성**

`app.rs`(가짜 port):

```rust
#[tokio::test] async fn execute_refuses_empty_and_multiple_statements() {
    // execute(s, "  ") == Err(EmptyStatement), execute(s, "SELECT 1; SELECT 2") == Err(MultipleStatements { count: 2 })
    // 그 세션의 link.sent()는 비어 있다
}
#[tokio::test] async fn execute_sends_the_text_as_given() {
    // execute(s, " SELECT 1 ;\n") == Ok(QueryId(1)), link.sent() == [" SELECT 1 ;\n"]
}
#[tokio::test] async fn execute_sends_text_that_cannot_be_split() {
    // execute(s, "SELECT 'open") == Ok(_), link.sent() == ["SELECT 'open"]
}
#[tokio::test] async fn query_use_cases_on_an_unknown_session() {
    // execute, fetch_more, cancel_query 모두 Err(UnknownSession { id: SessionId(99) })
}
#[tokio::test] async fn fetch_more_on_a_finished_query_is_query_not_active() {
    // 끝난 쿼리 q에 fetch_more == Err(QueryNotActive { query: q })
}
#[tokio::test] async fn cancel_failure_is_reported() {
    // link.fail_cancels(), 끝내지 않는 feed. cancel_query == Err(Cancel(CancelError { .. }))
}
#[tokio::test] async fn split_statements_needs_no_project() {
    // 프로젝트를 열지 않은 App에서 split_statements("a; b") == Ok(span 2개)
    // split_statements("a 'b") == Err(Split(SplitError { .. }))
}
```

`tests/queries.rs`(실제 구성: `TomlProjectStore`, `MemoryPasswordStore`, `PgQuerySplitter`, `PgConnector`). `sessions.rs`의 `app_with_project`와 `store_password`를 `tests/support/mod.rs`로 옮겨 함께 쓴다. `support`에 `sink()`, `next(&mut events)`(2초 안에 온 이벤트), `finished(&mut events)`(`Finished`가 올 때까지 읽어 그 `QueryOutcome`을 돌려줌)를 더한다.

```rust
/// M2 완료 기준: 100만 행 쿼리의 첫 500행이 0.1초 안에 도착한다.
/// execute를 부른 때부터 재므로 "DB 응답 후"보다 엄격하다.
#[tokio::test] async fn first_500_rows_of_a_million_arrive_within_100ms() {
    // t = now, execute(s, "SELECT * FROM big_table")
    // Columns의 이름 == [id, name, amount, created_at, is_active, tags, payload, note]
    // Rows { first_row: 0, rows 500개, retained_from: 0 }가 t부터 100ms 안에 온다. 각 행의 cell은 8개
    // 그 뒤 300ms 동안 이벤트가 없고, 이 backend는 pg_stat_activity에서 active/ClientWrite다
}
#[tokio::test] async fn fetch_more_continues_where_the_batch_ended() {
    // "SELECT id FROM big_table ORDER BY id" → Rows { first_row: 0 }의 마지막 행 == [Some("500")]
    // fetch_more → Rows { first_row: 500 }, 첫 행 == [Some("501")], 500행
}
/// M2 완료 기준: 10초짜리 pg_sleep이 취소 후 1초 안에 끝난다.
#[tokio::test] async fn sleeping_query_ends_within_a_second_of_cancel() {
    // execute(s, "SELECT pg_sleep(10)"), 200ms 뒤 t = now, cancel_query == Ok(())
    // finished == Cancelled 가 t부터 1초 안
    // session_state == Open { tx: Idle }, 이어서 "SELECT 42" → Completed { rows: 1 }
}
#[tokio::test] async fn next_query_discards_the_rest_of_a_big_result() {
    // "SELECT * FROM big_table"의 첫 Rows 뒤 같은 세션에 execute("SELECT 42")
    // 첫 쿼리: finished == Discarded. 둘째: Rows의 행 == [[Some("42")]], finished == Completed { rows: 1 }, 1초 안
}
/// Review Focus 2
#[tokio::test] async fn a_late_cancel_does_not_hit_the_next_query() {
    // 20번 반복: execute("SELECT pg_sleep(10)") 직후 execute("SELECT 42") → 둘째의 finished == Completed { rows: 1 }
}
#[tokio::test] async fn rows_affected_and_transaction_state_follow_the_statements() {
    // "CREATE TEMP TABLE q (id int)" → Completed { rows: 0 }, Columns 이벤트 없음
    // "BEGIN" → session_state == Open { tx: InTransaction }
    // "INSERT INTO q VALUES (1),(2),(3)" → Completed { rows: 3 }
    // "SELECT 1/0" → Failed(code "22012"), session_state == Open { tx: Failed }
    // "ROLLBACK" → session_state == Open { tx: Idle }
}
#[tokio::test] async fn state_answers_while_a_result_is_half_read() {
    // "SELECT * FROM big_table"의 첫 Rows 뒤 session_state가 1초 안에 Open { tx: Idle }
}
#[tokio::test] async fn only_one_statement_runs_at_a_time() {
    // execute("SELECT 1; SELECT 2") == Err(MultipleStatements { count: 2 })
    // execute("DO $$ BEGIN PERFORM 1; END $$") → Completed { rows: 0 }
    // execute("-- nothing") == Err(EmptyStatement)
}
/// Review Focus 4
#[tokio::test] async fn text_that_cannot_be_split_gets_the_server_error() {
    // execute("SELECT 'open") → Failed(e), e.code == "42601"
    // execute("SELECT *\nFROM nope") → Failed(e), e.code == "42P01", e.position == Some(15)
}
/// Review Focus 3
#[tokio::test] async fn terminated_backend_finishes_the_query_and_loses_the_session() {
    // execute("SELECT pg_sleep(10)"), 200ms 뒤 admin에서 pg_terminate_backend
    // finished == Failed(code "57P01"), eventually(session_state == Lost), close_session == Ok(())
}
#[tokio::test] async fn closing_a_session_stops_its_running_query() {
    // execute("SELECT pg_sleep(10)"), 200ms 뒤 close_session이 2초 안에 돌아온다
    // eventually(그 backend가 pg_stat_activity에 없다)
}
#[tokio::test] async fn split_statements_uses_the_scanner() {
    // split_statements("SELECT 1; SELEC 2") == Ok([StatementSpan { start: 0, end: 8 }, StatementSpan { start: 10, end: 17 }])
}
```

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p chilla-core --test queries`
Expected: FAIL. `App::execute`가 없어 compile error가 난다.

- [ ] **Step 3: use case 구현**

`App::new`의 인자가 늘어난다. `sessions.rs`, `app.rs`의 fixture, `src-tauri/src/lib.rs`의 호출을 함께 고친다(`lib.rs`는 `Arc::new(PgQuerySplitter)`).

- [ ] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 쿼리 실행, 이어서 가져오기, 취소 use case"
```

---

### Task 6: Tauri command와 Channel

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/error.rs`, `src-tauri/src/lib.rs`
- Test: `commands.rs`와 `error.rs`의 `#[cfg(test)]`

**Interfaces:**
- Consumes: Task 5의 `App::split_statements`·`execute`·`fetch_more`·`cancel_query`, `QueryEvent`, Task 1의 결정(JSON)
- Produces: Tauri command 4개. M3가 `src/shared/api/`에서 부른다.

| command | 인자 | 돌려주는 값 |
| --- | --- | --- |
| `split_statements` | `sql: String` | `StatementSpanDto[]`. `{ start, end }`는 **UTF-16 code unit** offset이다 |
| `execute_query` | `sessionId: u64`, `sql: String`, `onEvent: Channel<QueryEventDto>` | `u64` (query id). 결과는 `onEvent`로 간다 |
| `fetch_more` | `sessionId: u64`, `queryId: u64` | 없음 |
| `cancel_query` | `sessionId: u64`, `queryId: u64` | 없음 |

`QueryEventDto`의 JSON:

```json
{ "type": "columns", "columns": [{ "name": "id" }] }
{ "type": "rows", "firstRow": 0, "rows": [["1", null, ""]], "retainedFrom": 0, "elapsedMicros": 4246 }
{ "type": "finished", "outcome": "completed", "rows": 3, "elapsedMicros": 120 }
{ "type": "finished", "outcome": "failed", "elapsedMicros": 90,
  "error": { "code": "42P01", "message": "relation \"nope\" does not exist", "detail": null, "hint": null, "position": 15 } }
{ "type": "finished", "outcome": "cancelled", "elapsedMicros": 5300 }
{ "type": "finished", "outcome": "discarded", "elapsedMicros": 0 }
{ "type": "finished", "outcome": "connection_lost", "message": "…", "elapsedMicros": 10 }
```

```rust
#[derive(Debug, Clone, Serialize)]
pub struct StatementSpanDto { pub start: usize, pub end: usize }
/// byte offset의 span을 UTF-16 code unit offset으로 바꾼다. text를 한 번만 훑는다.
fn utf16_spans(sql: &str, spans: &[StatementSpan]) -> Vec<StatementSpanDto>;

#[derive(Debug, Clone, Serialize)]
pub enum QueryEventDto { .. }                 // 위의 JSON. `rows`의 cell은 Option<String>
impl From<QueryEvent> for QueryEventDto { .. }
```

`Channel`은 `tauri::ipc::Channel`이다. `execute_query`의 sink는 `Box::new(move |event| { let _ = on_event.send(QueryEventDto::from(event)); })`다. 화면이 사라져 `send`가 실패해도 무시한다. 그 쿼리는 다음 `execute_query`나 `close_session`에서 정리된다.

`kind` 값(M1의 표에 더한다):

| `AppError` | `kind` |
| --- | --- |
| `Split(_)` | `split_failed` |
| `EmptyStatement` | `empty_statement` |
| `MultipleStatements { .. }` | `multiple_statements` |
| `QueryNotActive { .. }` | `query_not_active` |
| `Cancel(_)` | `cancel_failed` |

- [ ] **Step 1: 실패하는 test 작성**

`commands.rs`:

```rust
#[test] fn statement_spans_are_utf16_offsets() {
    // sql = "SELECT '한글'; SELECT '😀'; SELECT 2"
    // utf16_spans(sql, [(0, 15), (17, 30), (32, 40)]) 의 (start, end) == [(0, 11), (13, 24), (26, 34)]
    // 빈 spans → 빈 Vec
}
#[test] fn query_event_dto_shapes() {
    // Columns([Column { name: "id" }]) → { "type": "columns", "columns": [{ "name": "id" }] }
    // Rows(RowBatch { first_row: 500, rows: [[Some("1"), None, Some("")]], retained_from: 2, elapsed: 4246µs })
    //   → { "type": "rows", "firstRow": 500, "rows": [["1", null, ""]], "retainedFrom": 2, "elapsedMicros": 4246 }
    // Finished { Completed { rows: 3 }, 120µs } → { "type": "finished", "outcome": "completed", "rows": 3, "elapsedMicros": 120 }
    // Finished { Failed(ServerError { code: "42P01", message: "m", detail: None, hint: Some("h"), position: Some(15) }), 90µs }
    //   → { "type": "finished", "outcome": "failed", "elapsedMicros": 90,
    //       "error": { "code": "42P01", "message": "m", "detail": null, "hint": "h", "position": 15 } }
    // Finished { Cancelled, .. } → outcome "cancelled", Finished { Discarded, .. } → "discarded"
    // Finished { ConnectionLost { message: "x" }, .. } → outcome "connection_lost", "message": "x"
    // 각 JSON의 키 집합이 위와 정확히 같다
}
```

`error.rs`의 `command_error_kinds`에 위 표의 5개를 더한다.

- [ ] **Step 2: 실패 확인**

Run: `cargo test -p chillasql`
Expected: FAIL. `utf16_spans`와 `QueryEventDto`가 없어 compile error가 난다.

- [ ] **Step 3: DTO와 command 구현, `lib.rs`에 등록**

`generate_handler!`에 `split_statements`, `execute_query`, `fetch_more`, `cancel_query`를 더한다.

- [ ] **Step 4: 통과 확인**

Run: `pnpm check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: 쿼리 실행 Tauri command와 결과 Channel"
```

---

### Task 7: 정리, review, 완료 기준 확인과 기록

**Files:**
- Modify: `docs/progress.md`, `docs/plans/M2-query-core.md` (체크박스), review에서 고치는 코드

- [ ] **Step 1: `simplify`**

`simplify` skill로 M2에서 바뀐 코드를 정리하고 `pnpm check`를 통과시킨 뒤 commit한다(`refactor: simplify 지적 반영 (…)`).

- [ ] **Step 2: `code-review high`**

`code-review`를 high로 돌린다. 지적은 `superpowers:receiving-code-review`로 하나씩 다시 검토해 고치는 게 맞는 것만 고치고 commit한다(`fix: code review 지적 반영 (…)`). 고치지 않은 지적은 이유와 함께 작업 로그에 남긴다.

- [ ] **Step 3: 완료 기준 실행**

Run: `scripts/test-db.sh reset && pnpm check`
Expected: PASS. 완료 기준과 test의 대응은 다음과 같다.

| 완료 기준 | test |
| --- | --- |
| `$$` 블록, 문자열, 주석 안의 `;`를 경계로 보지 않음 | `statements::semicolons_inside_dollar_quotes_strings_and_comments_are_not_boundaries` |
| 100만 행 쿼리의 첫 500행이 DB 응답 후 0.1초 안에 Channel에 도착 | `queries::first_500_rows_of_a_million_arrive_within_100ms`(sink까지) + Task 1의 `spaced` median(Channel에서 webview까지) |
| 10초짜리 `pg_sleep` 쿼리가 취소 후 1초 안에 끝남 | `queries::sleeping_query_ends_within_a_second_of_cancel` |

- [ ] **Step 4: 진행상황 갱신**

- M2 상태를 `완료`로 바꾸고 날짜를 적는다.
- 작업 로그에 완료 기준 확인 결과, Task 1의 수치, 고치지 않은 review 지적을 남긴다.
- "지금"을 `다음 할 일: M3 계획 작성 → docs/plans/M3-project-editor.md`로 바꾸고, M3에서 챙길 것을 적는다: 화면이 `retainedFrom`보다 앞의 행을 버린다, `split_statements`의 offset은 UTF-16이다, 선택 영역에 문장이 여러 개면 `multiple_statements`가 온다(M8 전까지), 화면이 사라진 쿼리는 다음 실행이나 세션 닫기 전까지 DB에 열려 있다(자동 닫기는 M6).

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "docs: M2 완료 기록"
```
