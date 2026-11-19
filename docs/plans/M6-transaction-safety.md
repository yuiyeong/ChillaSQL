# M6 트랜잭션과 안전장치 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 탭마다 Auto/Manual 트랜잭션을 고르고 Commit, Rollback하게 한다. 열린 트랜잭션을 잃을 수 있는 동작(탭 닫기, Auto 전환, 접속 바꾸기, 연결 대상 저장, 프로젝트 바꾸기, 앱 종료)은 먼저 묻고, 위험 쿼리는 실행 전에 확인한다. 이 마일스톤이 끝나면 운영 DB에 접속한다.

**Architecture:** 트랜잭션 상태는 M1의 `TxTap`이 읽은 값을 session actor가 쿼리마다 `Finished` event에 실어 보낸다. Manual 모드는 Rust가 맡는다: 실행 요청에 `TxMode`를 싣고, actor가 트랜잭션 밖에서 Manual 실행을 받으면 `BEGIN`을 먼저 보낸다. Commit과 Rollback은 actor의 `end_transaction` 명령이다. 받다 만 결과는 트랜잭션 안에서는 cancel 없이 버리고(cancel이 트랜잭션을 실패시키므로), 10분 동안 더 가져오지 않으면 actor가 닫는다. 위험 쿼리 판별은 새 port `StatementInspector`를 `pg_query`의 parser로 구현한다. 화면은 탭별 트랜잭션 정보(`TxInfo`)와 모드를 `runsStore`에 두고, 확인은 native `ask` 대신 캔버스 모양의 `DialogHost` 하나로 그린다. 앱 종료는 Rust가 막고 화면에 `quit-requested` event를 보내며, 화면이 확인한 뒤 `quit_app`을 부른다.

**Tech Stack:** M5의 stack 그대로. `pg_query` 18.1의 `parse`(protobuf AST)를 새로 쓴다. 새 crate는 없다.

**Spec:** [기획서](../spec.md) 4.1(접속별 색상), 4.2(트랜잭션 중 끊김), 4.3(트랜잭션 전체), 4.6(받다 만 결과), 4.8(위험 쿼리 확인, 환경 색상), 4.10(Commit, Rollback 단축키), 8장 2단계 / [마일스톤](../milestones.md) M6 / [디자인](../design/README.md)의 `Safety`, `Dialogs`, `TabsConn`(3), `States`(트랜잭션 실패), `Tunnel`(6), `ConnectionForm`(color), `Tokens` / [구조](../architecture.md)

## 먼저 확인한 것 (계획 작성 중 확인)

| 확인한 것 | 결과 | 결정 |
| --- | --- | --- |
| M1의 트랜잭션 상태 감지 | `TxTap`이 ReadyForQuery의 상태 byte를 읽고 actor가 쿼리가 끝날 때마다 `tx_status()`를 저장한다(`settle`). 화면으로는 `session_state` command로만 나가고 화면은 아직 부르지 않는다 | 쿼리마다 `Finished`에 `tx`를 싣는다. 화면이 따로 묻지 않으므로 순서가 꼬이지 않는다 |
| DataGrip의 Commit, Rollback 키 | DataGrip과 같은 JetBrains DatabaseTools plugin(이 Mac의 PyCharm 2026.2에 든 것)의 `plugin.xml`: `Console.Transaction.Commit`은 `$default` keymap에 `control alt shift ENTER`, `Console.Transaction.Rollback`은 단축키가 없다. macOS keymap은 `control`을 `meta`로 바꾸므로 Commit은 `Opt+Shift+Cmd+Enter`다. 웹의 keymap 문서에는 두 action이 나오지 않는다 | Commit은 DataGrip대로 `Opt+Shift+Cmd+Enter`. Rollback은 DataGrip에 없으므로 디자인대로 `Opt+Shift+Cmd+Z`. 디자인의 Commit `Opt+Shift+Cmd+K`는 쓰지 않는다 |
| 접속 저장과 프로젝트 바꾸기의 세션 닫기(M3) | `applySavedProject`는 연결 대상이 바뀐 접속을 쓰는 탭을 묻지 않고 `release`한다. `switchProject`는 `reset`한다 | 둘 다 열린 트랜잭션이 있으면 먼저 묻는다(Task 11) |
| 현재 종료 경로 | menu의 Quit은 `PredefinedMenuItem::quit`이고, `RunEvent::Exit`에서 `shutdown`을 부른다. 창 닫기와 Dock의 Quit은 따로 다루지 않는다 | Quit을 custom menu item으로 바꾸고 창 닫기, `ExitRequested`를 막는다. Dock Quit이 `ExitRequested`로 오는지는 Task 1에서 확인한다. 확인 결과 `ExitRequested`가 오지 않는다(Task 1 결과 참고) |
| 받다 만 결과를 버리는 방법(M2) | 다음 쿼리, 취소, 탭 닫기 모두 cancel + drain이다. 트랜잭션 안에서 cancel이 닿으면 문장이 `57014`로 실패해 트랜잭션이 failed가 된다 | 트랜잭션 안에서 *버릴* 때는 cancel 없이 끝까지 읽는다. 5초가 넘으면 cancel한다(아래). 사용자가 누른 Cancel은 지금처럼 cancel한다 |

## 이 계획에서 정한 것

기획서에 없거나 다르게 정한 것이다. Task 1에서 진행상황의 결정 기록에 옮기고, 기획서와 마일스톤도 고친다.

- **Commit `Opt+Shift+Cmd+Enter`, Rollback `Opt+Shift+Cmd+Z`.** 위 표의 근거. 기획서 4.10과 9장을 고친다.
- **Manual 모드의 `BEGIN`은 Rust가 보낸다.** 실행마다 `TxMode`를 싣고, actor는 Manual 실행을 받았는데 트랜잭션 밖(`Idle`)이면 그 쿼리 전에 `BEGIN`을 보낸다. `BEGIN`이 실패하면 그 오류로 쿼리를 끝낸다. 모드는 화면의 탭 상태이고 세션은 모드를 기억하지 않는다. 그래서 탭의 세션이 바뀌어도(재연결, 접속 바꾸기) 모드는 그대로다. Manual 모드에서 트랜잭션 안에서 못 도는 문장(`VACUUM`, `CREATE DATABASE`)은 서버 오류가 난다. DataGrip과 같다.
- **문장 수.** `Finished`의 `tx`가 열린 채(`in_transaction`)로 `completed`된 실행만 센다. 실패하거나 취소된 문장은 세지 않는다. 트랜잭션을 연 실행이 Auto 모드면 그것은 사용자가 쓴 `BEGIN`이므로 세지 않고, Manual 모드면 앱이 `BEGIN`을 붙인 사용자 문장이므로 센다. 문장이 0개인 열린 트랜잭션은 문장 수 대신 `manual BEGIN`이라고 쓴다(TabsConn 3).
- **경과 시간**은 트랜잭션을 연 실행이 시작한 시각(`ResultData.startedAt`)부터 센다. 탭에는 `TX 3:12`, toolbar에는 `Open · 2 statements · 3:12`. 실패 상태는 `Failed · 2 statements · 3:12`이고 Commit이 disabled다.
- **Commit과 Rollback은 actor 명령 `end_transaction`**이다. 지금 쿼리가 있으면 버린 뒤(트랜잭션 안이므로 cancel 없이) 보낸다. 기다리던 다음 쿼리는 끝내기 뒤에 실행한다. 끝내기가 기다리는 쿼리에 밀려 사라지지 않는다. 실패 상태에서 온 Commit은 보내지 않고 `TransactionFailed`로 답한다(서버는 실패한 트랜잭션의 `COMMIT`을 `ROLLBACK`으로 처리하므로 보내면 Commit이 된 것처럼 보인다). `COMMIT`이 서버 오류로 실패하면(deferred constraint) 그 오류를 결과 panel에 그리고 트랜잭션은 끝난 것으로 둔다.
- **Commit, Rollback, Auto/Manual 전환이 가능한 때**: 탭이 연결 중이 아니고, 실행 중이면 batch를 기다리는 중(`fetch: "ready"`)일 때. 쿼리를 읽고 있는 동안은 disabled다(먼저 Cancel).
- **닫기 전 확인의 Rollback은 명시적으로 보낸다.** "Roll back and close"도 `ROLLBACK`을 보낸 뒤 닫는다. 실패해도(연결이 끊김) 진행한다. 세션이 닫히면 서버가 어차피 되돌린다. "Commit and …"은 Commit이 성공해야 진행하고, 실패하면 멈추고 오류를 보인다. 실패 상태인 트랜잭션의 확인에는 Commit 버튼이 없다.
- **여러 탭의 확인은 앱 종료와 같은 모양이다.** 연결 대상 저장과 프로젝트 바꾸기에서 열린 트랜잭션이 있는 탭이 둘 이상이면 탭 목록을 보이고 "Roll back all and …"과 Cancel만 둔다. 한꺼번에 Commit하지 않는다는 앱 종료의 결정(2026-11-18)과 같은 이유다. 한 탭이면 Commit, Rollback, Cancel이다.
- **앱 종료의 "Roll back all and quit"은 ROLLBACK을 따로 보내지 않는다.** `quit_app` → `shutdown`이 세션을 닫고 서버가 되돌린다. 종료를 오래 막지 않으려는 것이다.
- **확인 순서.** 트랜잭션 확인이 먼저, 저장하지 않은 변경 확인이 다음이다. 프로젝트 바꾸기는 두 확인 → 폴더 고르기 → Commit(골랐으면) → 열기 순서다. 폴더 고르기를 취소하면 Commit하지 않는다.
- **트랜잭션 중 끊김.** 열린 트랜잭션이 있는 탭에서 (a) 그 접속의 터널이 다시 시작되면(stale) 바로, (b) 실행이 `connection_lost`로 끝나거나 세션이 없어졌으면(`unknown_session`) 그때, 결과 panel 위에 "Transaction lost" 알림(Tunnel 6)을 띄우고 트랜잭션 정보를 지운다. 알림은 OK나 다음 실행이 지운다. 터널 없는 접속은 다음 실행에서야 끊김을 안다.
- **받다 만 결과 자동 닫기.** batch를 보내고 `fetch_more`를 10분 동안 받지 못하면 actor가 결과를 버리고 새 outcome `expired`로 끝낸다. 시간은 `QueryLimits.idle_result_timeout`(600초)이다. 설정 파일로 바꾸는 것은 M8이다.
- **트랜잭션 안에서 버리기.** 다음 쿼리, 끝내기, 자동 닫기가 트랜잭션 안의 쿼리를 버릴 때는 cancel 없이 남은 행을 읽어 버린다. 5초(`QueryLimits.tx_drain_limit`) 안에 끝나지 않으면 cancel한다. 그러면 트랜잭션이 failed가 되고 화면이 Failed로 보인다. 세션 닫기는 지금처럼 cancel한다(어차피 되돌아간다).
- **위험 쿼리.** 실행할 문장 하나를 `pg_query::parse`로 읽어 첫 위험을 돌려준다: WHERE 없는 `UPDATE`, `DELETE`(CTE 안의 것 포함), `DROP`(`DropStmt`의 모든 object, `DROP DATABASE`), `TRUNCATE`. `EXPLAIN ANALYZE`는 안쪽 문장을 실행하므로 안쪽을 본다. `EXPLAIN`(ANALYZE 없음)과 `PREPARE`는 실행하지 않으므로 보지 않는다. parse가 실패하면 위험 없음이다(서버가 오류를 낸다). `DO` block, 함수 안의 문장, `ALTER TABLE … DROP COLUMN`은 보지 않는다. 읽기 전용 접속에서 확인하지 않는 것은 읽기 전용(M8)과 함께 만든다.
- **위험 쿼리의 문구**는 모드와 트랜잭션으로 고른다: Manual이거나 트랜잭션이 열려 있으면 "되돌릴 수 있음", Auto이고 트랜잭션 밖이면 "되돌릴 수 없음". "Run again"도 확인한다. 터널 오류의 "Try again"은 이미 확인한 실행이므로 묻지 않는다.
- **확인 dialog는 하나의 host로 그린다**(Dialogs, Safety). native `ask`를 쓰던 M3의 확인(저장하지 않은 탭 닫기, 프로젝트 바꾸기, 밖에서 바뀐/지워진 파일 저장)도 캔버스 문구와 모양으로 바꾼다. 저장하지 않은 탭 닫기는 캔버스대로 "Don't save / Cancel / Save"이고 Save는 저장에 성공했을 때만 닫는다. dialog가 열린 동안 단축키는 동작하지 않고, Escape는 Cancel, 기본 focus는 Cancel이다. 한 번에 하나만 보이고 나머지는 차례를 기다린다.
- **`color` 값 검사.** `chilla.toml`의 `color`가 `green`, `yellow`, `red`, `blue`, `purple`이 아니면 프로젝트를 열지 않는다(모르는 key를 거절하는 것과 같은 이유). 접속 sheet의 `color`는 다섯 swatch의 radiogroup이고, 고른 swatch를 다시 누르면 색을 지운다(회색). 새 접속은 색이 없다.
- **종료 경로.** menu의 Quit을 custom item(`quit`, `Cmd+Q`)으로 바꾸고, 창 닫기(`CloseRequested`)와 사용자가 요청한 `ExitRequested`(`code`가 `None`)를 막은 뒤 `quit-requested` event를 보낸다. 화면은 열린 트랜잭션이 없으면 바로, 있으면 확인한 뒤 `quit_app`을 부른다. `quit_app`이 flag를 세운 뒤의 종료는 막지 않는다. 확인하는 동안 온 두 번째 요청은 무시한다. 화면이 응답하지 않으면 강제 종료로만 끝난다(감수).

## Global Constraints

- 의존 방향: `infrastructure` → `application` → `domain`. `application`은 `tokio`의 `sync`, `task`, `time`만 쓴다. `pg_query`는 `infrastructure`에만 있다(`tests/layer_deps.rs`).
- `chilla-core`는 `tauri`에 의존하지 않는다. `src-tauri`의 command는 use case를 부르는 일만 한다.
- `@tauri-apps/*`는 `src/shared/api/`에서만 import한다.
- 화면 문구는 `src/shared/i18n/en.ts`에 두고 `t`, `tc`, 이 계획의 `rt`로 쓴다. 복수형은 `.one`/`.other`. SQL keyword(`DELETE`, `WHERE`, `BEGIN`), 서버 오류 메시지, SQLSTATE, `chilla.toml`의 key와 값(`color`, `red`)은 번역하지 않는다.
- 색, 그림자, 글자 크기는 `src/index.css`의 token으로만 쓴다. 접속 색은 창 상단 bar, 탭 dot, toolbar chip, 접속 목록 dot, sheet의 swatch에만 쓴다. 트랜잭션과 실패 상태는 icon과 문장으로 구분한다. danger는 위험 dialog의 실행 버튼과 에디터 오류 밑줄에만 쓴다. Commit과 Rollback은 같은 무게의 secondary 버튼이다(Tokens 규칙).
- 상수: 받다 만 결과 자동 닫기 600초, 트랜잭션 안에서 cancel 없이 버리는 한도 5초.
- commit 전에 `pnpm check`를 통과시킨다. commit message는 `feat:`/`fix:`/`docs:`/`chore:`/`test:` 뒤에 한국어 한 줄이다.
- `docs/`는 평서체, 기술 용어는 영어, 날짜는 `YYYY-MM-DD`, 단축키는 `Opt+Shift+Cmd+Enter`처럼 글자로 쓴다.

## Review Focus

test가 없으면 사용자가 가장 먼저 부딪힐 입력과 상황이다. 각 줄의 test는 해당 Task에 넣었다.

1. **Manual 모드에서 큰 결과를 일부만 받은 뒤 다음 문장을 실행**: 받다 만 결과를 cancel로 버리면 트랜잭션이 failed가 되어 다음 문장이 `25P02`로 거부된다. 트랜잭션은 열린 채여야 한다 → Task 5 `discarding_a_paused_result_inside_a_transaction_keeps_it_open`(test DB의 100만 행).
2. **`COMMIT`이 실패**(deferred constraint): 오류가 보이고, 트랜잭션은 끝났다고 표시되고, "Commit and close"는 탭을 닫지 않아야 한다 → Task 4 `commit_reports_a_deferred_constraint_error`, Task 11 `a_failed_commit_keeps_the_tab_open`.
3. **위험한 문장이 CTE나 `EXPLAIN ANALYZE` 안에 있음**: 겉이 `SELECT`나 `EXPLAIN`이어도 실제로 지운다. 확인해야 한다 → Task 6 `finds_dangers_inside_ctes_and_explain_analyze`.
4. **터널이 다시 시작될 때 Manual 트랜잭션이 열려 있음**: 다음 실행이 옛 트랜잭션이 이어지는 것처럼 보이면 안 된다. "Transaction lost"를 보이고, 문장 수와 경과 시간을 지우고, 다음 실행은 새 `BEGIN`으로 시작한다 → Task 8 `a_stale_session_with_an_open_transaction_reports_it_lost`.
5. **확인 dialog가 열린 채 Cmd+Q를 다시 누르거나 다른 확인이 겹침**: dialog가 둘 겹치거나 단축키가 뒤의 에디터로 가면 안 된다 → Task 7 `a_second_ask_waits_for_the_first`, Task 13 `a_second_quit_request_while_asking_is_ignored`.

---

## File Structure

| 파일 | 할 일 |
| --- | --- |
| `crates/chilla-core/src/domain/connection.rs`, `infrastructure/project_file.rs` | `ConnectionColor`와 값 검사 |
| `crates/chilla-core/src/domain/session.rs` | `TxMode`, `TxEnd`, `EndOutcome`, `EndResult` |
| `crates/chilla-core/src/domain/query.rs` | `Finished.tx`, `QueryOutcome::Expired`, `QueryLimits`의 두 시간 |
| `crates/chilla-core/src/domain/danger.rs` (새) | `Danger` |
| `crates/chilla-core/src/application/ports.rs` | `DbConnection::simple_execute`, `StatementInspector` |
| `crates/chilla-core/src/application/session_actor/{mod,query,tests}.rs` | `tx` 싣기, `BEGIN`, 끝내기, 트랜잭션 안에서 버리기, 자동 닫기 |
| `crates/chilla-core/src/application/test_support/connection.rs` | fake의 `simple_execute` |
| `crates/chilla-core/src/application/app.rs` | `execute`의 mode, `end_transaction`, `inspect_statement` |
| `crates/chilla-core/src/infrastructure/postgres/mod.rs` | `simple_execute` 구현 |
| `crates/chilla-core/src/infrastructure/statement_inspector.rs` (새) | `PgQueryInspector` |
| `crates/chilla-core/tests/transactions.rs` (새) | test DB로 Manual, 끝내기, 버리기 확인 |
| `src-tauri/src/{commands,error,lib,menu}.rs` | DTO, 새 command, quit 경로 |
| `src/shared/api/{types,commands,events}.ts` | 새 type, command, `onQuitRequested` |
| `src/shared/ui/dialogs.ts`, `DialogHost.tsx` (새) | 확인 dialog store와 그림 |
| `src/shared/i18n/rich.tsx` (새), `en.ts` | 굵은 이름과 SQL 조각이 든 문구, M6 문구 |
| `src/shared/api/dialog.ts`, `features/editor/saveTab.ts`, `features/workspace/commands.ts` | native `ask` 제거 |
| `src/features/query/transaction.ts` (새) | `TxInfo`와 순수 함수 |
| `src/features/query/runsStore.ts`, `runReducer.ts` | 트랜잭션 정보, 모드, 끝내기, 끊김 알림, `expired` |
| `src/features/workspace/TransactionControls.tsx` (새), `Toolbar.tsx`, `shortcuts.ts` | 모드, 상태, Commit/Rollback, 단축키 |
| `src/features/editor/TabBar.tsx` | 탭의 `TX 3:12` |
| `src/features/query/TransactionPanels.tsx` (새), `ResultPane.tsx` | 실패한 트랜잭션, Transaction lost, 자동 닫기 문구 |
| `src/features/workspace/transactionPrompts.ts` (새) | 닫기 전 확인 |
| `src/features/workspace/dangerPrompt.ts` (새) | 위험 쿼리 확인 |
| `src/features/workspace/quit.ts` (새), `src/App.tsx` | 종료 확인 |
| `src/features/connections/ConnectionForm.tsx`, `connectionValues.ts`, `colors.ts` | `color` 칸 |

---

### Task 1: 먼저 확인할 것 — 종료 경로, 결정 기록

**Files:**
- Modify: `docs/progress.md`, `docs/milestones.md`, `docs/spec.md`

**Interfaces:**
- Produces: 종료 경로 확인 결과. Task 13이 이 결과를 따른다.

- [x] **Step 1: branch를 만든다**

```bash
git switch -c m6-transactions
```

- [x] **Step 2: Tauri의 종료 경로를 확인한다**

임시로 `src-tauri/src/lib.rs`의 `app.run` closure에서 `RunEvent::ExitRequested { code, .. }`, `RunEvent::WindowEvent { event: WindowEvent::CloseRequested { .. }, .. }`, `RunEvent::Exit`를 받을 때마다 `eprintln!("QUIT_PROBE …")`로 쓰고, `ExitRequested`는 `api.prevent_exit()`, `CloseRequested`는 `api.prevent_close()`를 부른다. menu의 Quit은 그대로 둔다. `scripts/build-app.sh --debug`로 만든 `.app`을 `open --stderr <file>`로 띄운다.

| 동작 | 기록할 것 |
| --- | --- |
| menu의 Quit(`Cmd+Q`) | 어떤 event가 오는지, `prevent_exit`로 막히는지 |
| 창의 닫기 버튼 | `CloseRequested`가 오고 막히는지 |
| Dock의 Quit | 어떤 event가 오는지, 막히는지 |
| `osascript -e 'quit app "ChillaSQL"'` | 위와 같음 |

**결정 규칙**: Dock Quit이 `ExitRequested`(`code: None`)로 오고 막히면 Task 13은 계획대로 한다. 막히지 않으면 그 경로는 확인 없이 끝나며(`shutdown`이 세션을 닫아 서버가 되돌림), 결정 기록에 남긴다. 확인한 뒤 probe를 지운다.

**확인 결과 (2026-11-19, tauri 2.12.5)**: 창의 닫기 버튼은 `CloseRequested`가 오고 `prevent_close`로 막힌다. menu의 Quit(`Cmd+Q`), Dock의 Quit, `osascript` quit은 모두 `ExitRequested` 없이 `RunEvent::Exit`만 오고 막히지 않는다. 그래서 Task 13은 menu의 Quit을 custom item으로 바꿔 확인에 태우고 창 닫기를 막으며, Dock Quit과 외부 quit은 확인 없이 끝나게 둔다(`shutdown`이 세션을 닫아 서버가 되돌림). `ExitRequested { code: None }` 막기는 안전망으로 두되 이 경로들에서는 오지 않는다.

- [x] **Step 3: 결정을 기록하고 commit한다**

- "이 계획에서 정한 것"의 모든 항목, 위 "먼저 확인한 것" 표, Step 2의 결과를 진행상황의 결정 기록에 한 줄씩 남긴다.
- 진행상황: 마일스톤 현황에서 M6을 `진행 중`(계획 링크, 시작 날짜), "지금"의 진행 중, 작업 위치(branch `m6-transactions`), 다음 할 일을 바꾼다.
- 기획서: 4.3에 Manual의 `BEGIN`, 문장 수, 실패 상태의 Commit, 여러 탭 확인을 더한다. 4.6에 `expired`와 트랜잭션 안에서 버리기를 더한다. 4.8에 판별 범위(CTE, `EXPLAIN ANALYZE`, 보지 않는 것)를 더한다. 4.10의 "M4 이후의 키"에 Commit, Rollback 키를 적는다. 9장에서 Commit, Rollback 키 항목의 M6 부분을 지운다.
- 마일스톤: M6 "먼저 확인할 것"에 결과를 적는다. M8에 "읽기 전용 접속에서 위험 쿼리 확인을 하지 않음", "받다 만 결과 닫기 시간 설정"을 더한다.

Run: `pnpm check`
Expected: 통과

```bash
git add docs/plans/M6-transaction-safety.md docs/progress.md docs/milestones.md docs/spec.md
git commit -m "docs: M6 계획과 Task 1 종료 경로 확인 결과를 기록함"
```

---

### Task 2: `color` 값 검사

**Files:**
- Modify: `crates/chilla-core/src/domain/connection.rs`, `crates/chilla-core/src/infrastructure/project_file.rs`, `crates/chilla-core/tests/project_file.rs`, `src-tauri/src/commands.rs`, `src/shared/api/types.ts`, `src/features/connections/colors.ts`, `src/test/fixtures.ts`

**Interfaces:**
- Produces (`domain`):
  - `pub enum ConnectionColor { Green, Yellow, Red, Blue, Purple }` (`Clone, Copy, PartialEq, Eq, Debug`). `ConnectionColor::parse(&str) -> Option<Self>`, `as_str(self) -> &'static str`(`"green"` …), `pub const ALL: [ConnectionColor; 5]`
  - `ConnectionProfile.color: Option<ConnectionColor>`
  - `ProfileError::UnknownColor { value: String }`: `"color must be green, yellow, red, blue or purple, not '{value}'"`
- Produces (화면): `type ConnectionColor = "green" | "yellow" | "red" | "blue" | "purple"`, `Connection.color: ConnectionColor | null`. `connectionColor(color: ConnectionColor | null): string`

- [x] **Step 1: test를 쓴다**

- `connection.rs`: `color_parses_only_the_five_names` — 다섯 이름은 `Some`이고 `as_str`로 돌아온다. `"orange"`, `"Red"`, `""`는 `None`.
- `tests/project_file.rs`: `unknown_color_is_rejected` — `color = "orange"`면 `ProjectError::InvalidConnection { source: ProfileError::UnknownColor { value: "orange" } }`. `color_round_trips` — `color = "red"`를 읽으면 `Some(Red)`이고, `None`으로 저장하면 그 줄이 지워진다.
- `commands.rs`: `connection_dto_rejects_an_unknown_color` — DTO의 `color: Some("orange")`를 `ConnectionProfile::try_from`하면 `UnknownColor`.

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test -p chilla-core color && cargo test -p chillasql connection_dto`
Expected: FAIL(`ConnectionColor`가 없음)

- [x] **Step 3: 구현한다**

`project_file.rs`는 문자열로 읽은 뒤 `ConnectionColor::parse`로 바꾸고, 실패하면 `UnknownColor`다. DTO는 계속 `Option<String>`이다. 화면의 `colors.ts`는 type만 좁힌다(fallback은 그대로 `var(--color-line-2)`).

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add crates src-tauri src
git commit -m "feat: chilla.toml의 color 값을 다섯 색으로 검사함"
```

---

### Task 3: `Finished`에 트랜잭션 상태를 싣는다

**Files:**
- Modify: `crates/chilla-core/src/domain/query.rs`, `application/session_actor/{mod,query,tests}.rs`, `src-tauri/src/commands.rs`, `src/shared/api/types.ts`, `src/features/query/runReducer.test.ts`(fixture), `src/test/fixtures.ts`

**Interfaces:**
- Produces (`domain`): `QueryEvent::Finished { outcome: QueryOutcome, elapsed: Duration, tx: Option<TxStatus> }`. `tx`는 그 쿼리가 끝난 뒤 서버가 알려 준 상태다. 연결이 끊겼거나(`ConnectionLost`) 세션을 닫는 중이면 `None`, 시작하지 않고 끝난 쿼리(`Discarded`, 기다리다 `Cancelled`)는 actor가 마지막으로 읽은 값이다.
- Produces (DTO): `finished` event에 `"tx": "idle" | "in_transaction" | "failed" | null`.
- Produces (화면): `type TxStatus = "idle" | "in_transaction" | "failed"`, `QueryEvent`의 finished에 `tx: TxStatus | null`.

- [x] **Step 1: actor test를 쓴다**

`session_actor/tests.rs`:

- `finished_carries_the_tx_status_read_after_the_query`: fake의 `set_tx(InTransaction)` 뒤 쿼리를 완료시키면 `Finished.tx == Some(InTransaction)`.
- `a_query_failing_at_start_reads_the_tx_status`: `start_query`가 서버 오류로 실패하고 fake의 tx가 `Failed`면 `Finished { outcome: Failed(_), tx: Some(Failed) }`.
- `a_lost_connection_has_no_tx_status`: 결과 도중 `lose()`면 `tx == None`.
- `a_discarded_pending_query_reports_the_last_tx_status`: 앞 쿼리를 버리는 동안 기다리던 쿼리가 다음 쿼리에 밀리면 그 `Finished`의 `tx`는 actor가 마지막으로 읽은 값.

`commands.rs`: `finished` DTO test의 기대값마다 `"tx"`를 더하고, `tx: None`이 `null`인지 단언한다.

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test -p chilla-core session_actor && cargo test -p chillasql finished`
Expected: FAIL(compile error)

- [x] **Step 3: 구현한다**

`settle`은 `tx_status()`를 *먼저* 읽고 그 값으로 `Finished`를 보낸다(지금은 보낸 뒤 읽는다). `start`의 오류 분기도 `ConnectionLost`가 아니면 읽는다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add crates src-tauri src
git commit -m "feat: 쿼리가 끝날 때 트랜잭션 상태를 함께 보냄"
```

---

### Task 4: Manual 모드와 Commit, Rollback (Rust)

**Files:**
- Modify: `crates/chilla-core/src/domain/session.rs`, `application/ports.rs`, `application/session_actor/{mod,tests}.rs`, `application/test_support/connection.rs`, `application/app.rs`, `infrastructure/postgres/mod.rs`, `src-tauri/src/{commands,lib}.rs`, `src/shared/api/{types,commands,commands.test}.ts`
- Create: `crates/chilla-core/tests/transactions.rs`

**Interfaces:**
- Consumes: Task 3의 `Finished.tx`
- Produces (`domain`):
  - `pub enum TxMode { Auto, Manual }`, `pub enum TxEnd { Commit, Rollback }`
  - `pub enum EndOutcome { Ended, TransactionFailed, Server(ServerError), ConnectionLost { message: String }, Client { message: String } }`
  - `pub struct EndResult { pub outcome: EndOutcome, pub tx: Option<TxStatus> }`. `tx`는 끝낸 뒤 읽은 값이고 끊겼으면 `None`
- Produces (port): `DbConnection::simple_execute(&self, sql: &str) -> impl Future<Output = Result<(), QueryError>> + Send`. 결과 행이 없는 문장(`BEGIN`, `COMMIT`, `ROLLBACK`)을 simple query로 보낸다
- Produces (`App`):
  - `execute(&self, session: SessionId, sql: String, mode: TxMode, sink: QuerySink) -> Result<QueryId, AppError>`
  - `end_transaction(&self, session: SessionId, end: TxEnd) -> Result<EndResult, AppError>`. 세션이 없으면 `UnknownSession`
- Produces (command): `execute_query(session_id, sql, mode: "auto" | "manual", on_event)`, `end_transaction(session_id, end: "commit" | "rollback") -> EndResultDto`. `EndResultDto`는 `{ outcome: "ended" | "transaction_failed" | "server_error" | "connection_lost" | "client_error", tx: TxStatus | null, error?: ServerErrorDto, message?: string }`
- Produces (화면 api): `executeQuery(sessionId, sql, mode: TxMode, onEvent)`, `endTransaction(sessionId: number, end: TxEnd): Promise<EndResult>`, type `TxMode = "auto" | "manual"`, `TxEnd = "commit" | "rollback"`, `EndResult`(DTO와 같은 모양)

- [x] **Step 1: actor test를 쓴다**

fake connection에 `simple_execute`를 더한다: 보낸 sql을 `sent()`에 남기고, `fail_next_simple(code)`이면 그 서버 오류를 한 번 돌려주고, `BEGIN` 성공 뒤에는 tx를 `InTransaction`, `COMMIT`/`ROLLBACK` 성공 뒤에는 `Idle`로 바꾼다.

- `manual_execute_outside_a_transaction_sends_begin_first`: tx가 `Idle`이고 `Manual`이면 `sent() == ["BEGIN", "UPDATE t SET a = 1"]`.
- `manual_execute_inside_a_transaction_does_not_begin_again`: tx가 `InTransaction`이면 `sent() == ["UPDATE …"]`.
- `auto_execute_never_begins`.
- `a_failed_begin_finishes_the_query_with_that_error`: `fail_next_simple("53300")`이면 `Finished { outcome: Failed(code 53300), .. }`이고 쿼리는 보내지 않는다.
- `end_transaction_commits_and_reports_idle`: `EndResult { outcome: Ended, tx: Some(Idle) }`, `sent()`의 끝이 `"COMMIT"`.
- `commit_in_a_failed_transaction_is_refused`: tx가 `Failed`면 `TransactionFailed`이고 `COMMIT`을 보내지 않는다. Rollback은 보낸다.
- `end_transaction_discards_a_paused_query_first`: batch를 보내고 멈춘 쿼리가 있으면 그 쿼리가 `Discarded`로 끝난 *뒤* `COMMIT`을 보낸다.
- `a_query_sent_after_end_runs_after_it`: 끝내기가 앞 쿼리를 기다리는 동안 온 쿼리는 끝내기가 끝난 뒤 시작하고, 끝내기는 `Ended`다(밀려 사라지지 않음).

- [x] **Step 2: test DB test를 쓴다**

`tests/transactions.rs`(test DB 54318, 다른 test와 겹치지 않게 `m6_` 이름의 임시 table을 쓴다):

- `manual_commit_is_visible_to_another_session`: 세션 A에서 `Manual`로 `INSERT`, 세션 B에서 보이지 않음, A에서 `Commit`, B에서 보임.
- `manual_rollback_discards_the_change`.
- `commit_reports_a_deferred_constraint_error`: `DEFERRABLE INITIALLY DEFERRED` 외래 키를 어기는 `INSERT` 뒤 `Commit`은 `EndOutcome::Server(code "23503")`, `tx: Some(Idle)`.
- `a_failed_statement_leaves_the_transaction_failed`: Manual에서 없는 table을 읽으면 `Finished.tx == Some(Failed)`, 다음 문장은 `25P02`, `Rollback` 뒤 `Idle`.

- [x] **Step 3: 실패를 확인한다**

Run: `cargo test -p chilla-core --test transactions && cargo test -p chilla-core session_actor`
Expected: FAIL(compile error)

- [x] **Step 4: 구현한다**

- actor: `SessionCommand::Execute`에 `mode`, 새 `SessionCommand::End { end, reply }`. 끝내기는 쿼리가 없으면 바로, 있으면 그 쿼리를 버리고(`DrainReason::Discarded`) `settle`에서 기다리던 다음 쿼리보다 *먼저* 실행한다. 끝내기 여러 개는 온 순서대로다(`VecDeque`).
- `PgConnection::simple_execute`는 `Client::batch_execute`이고 오류는 `start_query`와 같은 방법으로 `QueryError`로 바꾼다.
- `BEGIN`은 `start` 안에서 `self.tx == Idle && mode == Manual`일 때 보낸다.

- [x] **Step 5: 화면 api를 바꾼다**

`commands.test.ts`: `executeQuery`가 `mode`를 command 인자로 넘기고, `endTransaction(3, "commit")`이 `invoke("end_transaction", { sessionId: 3, end: "commit" })`을 부르는지. `runsStore`의 호출은 이 Task에서 `"auto"`를 넘긴다(Task 8이 바꾼다).

- [x] **Step 6: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 7: commit**

```bash
git add crates src-tauri src
git commit -m "feat: Manual 모드의 BEGIN과 Commit, Rollback command를 만듦"
```

---

### Task 5: 트랜잭션 안에서 버리기와 받다 만 결과 자동 닫기

**Files:**
- Modify: `crates/chilla-core/src/domain/query.rs`, `application/session_actor/{mod,query,tests}.rs`, `crates/chilla-core/tests/transactions.rs`, `src-tauri/src/commands.rs`, `src/shared/api/types.ts`, `src/features/query/{runReducer,ResultPane}.tsx`, `src/shared/i18n/en.ts`

**Interfaces:**
- Consumes: Task 4의 actor(끝내기도 버리기를 쓴다)
- Produces (`domain`):
  - `QueryOutcome::Expired`
  - `QueryLimits.idle_result_timeout: Duration`(기본 600초), `QueryLimits.tx_drain_limit: Duration`(기본 5초)
- Produces (DTO, 화면): outcome `"expired"`. 결과 표 아래 끝 줄 문구 `result.expired`: `"Closed after 10 minutes without fetching more. Run again to see the rest."`

- [ ] **Step 1: actor test를 쓴다** (`tokio::time::pause`)

- `a_paused_result_expires_after_the_idle_timeout`: batch 뒤 600초가 지나면 cancel을 보내고 `Finished { outcome: Expired }`. 599초에는 아직 아니다.
- `fetch_more_restarts_the_idle_timer`: 500초에 `fetch_more`, 다음 batch 뒤 500초가 지나도 끝나지 않는다.
- `discarding_inside_a_transaction_reads_to_the_end_without_cancel`: 쿼리 시작 때 tx가 `InTransaction`이면 다음 쿼리가 와도 `cancels() == 0`이고 남은 행을 읽은 뒤 다음 쿼리를 시작한다.
- `a_slow_discard_inside_a_transaction_falls_back_to_cancel`: 5초 안에 결과가 끝나지 않으면 cancel을 한 번 보낸다.
- `user_cancel_inside_a_transaction_still_cancels`: `cancel`은 트랜잭션 안에서도 바로 cancel한다.
- `expiry_inside_a_transaction_does_not_cancel`: 자동 닫기도 트랜잭션 안이면 cancel 없이 읽는다.

- [ ] **Step 2: test DB test를 쓴다**

`tests/transactions.rs`의 `discarding_a_paused_result_inside_a_transaction_keeps_it_open`: Manual로 seed table 100만 행을 `SELECT`해 첫 batch만 받고, 다음 문장 `SELECT 1`을 실행하면 그 `Finished`가 `Completed`, `tx: Some(InTransaction)`.

- [ ] **Step 3: 실패를 확인한다**

Run: `cargo test -p chilla-core session_actor && cargo test -p chilla-core --test transactions`
Expected: FAIL

- [ ] **Step 4: 구현한다**

- `Query`는 시작할 때 트랜잭션 안이었는지(`in_transaction: bool`)를 갖는다. 버리기(`Discarded`, `Expired`)는 그 값이 true면 cancel 없이 `Draining`에 들어가고 `tx_drain_limit` 뒤에 cancel한다. `DrainReason`에 `Expired`를 더한다.
- `Paused`에 들어갈 때 `idle_result_timeout`의 시각을 두고 `next_event`의 `select!`가 기다린다.
- 화면: `runReducer`가 `expired`를 끝난 결과로 다룬다(`fetch: "none"`). `ResultPane`의 결과 끝 줄이 `result.expired`를 쓴다. `runReducer.test.ts`에 `expired_keeps_the_rows_and_stops_fetching`.

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 6: commit**

```bash
git add crates src-tauri src
git commit -m "feat: 트랜잭션 안의 결과를 cancel 없이 버리고 받다 만 결과를 10분 뒤 닫음"
```

---

### Task 6: 위험 쿼리 판별 (Rust)

**Files:**
- Create: `crates/chilla-core/src/domain/danger.rs`, `crates/chilla-core/src/infrastructure/statement_inspector.rs`
- Modify: `domain/mod.rs`, `application/ports.rs`, `application/app.rs`, `application/test_support/mod.rs`, `infrastructure/mod.rs`, `crates/chilla-core/tests/support/mod.rs`, `src-tauri/src/{commands,lib}.rs`, `src/shared/api/{types,commands}.ts`

**Interfaces:**
- Produces (`domain`):

```rust
pub enum Danger {
    UpdateWithoutWhere { table: String },
    DeleteWithoutWhere { table: String },
    /// `kind`는 SQL keyword다: "TABLE", "VIEW", "MATERIALIZED VIEW", "INDEX", "SCHEMA",
    /// "SEQUENCE", "FUNCTION", "TYPE", "EXTENSION", "DATABASE". 그 밖의 object는 "".
    Drop { kind: String, names: Vec<String> },
    Truncate { tables: Vec<String> },
}
```

  이름은 문장에 쓴 그대로(`schema.table`이면 그대로, 따옴표는 뺌)다.
- Produces (port): `pub trait StatementInspector: Send + Sync { fn danger(&self, sql: &str) -> Option<Danger>; }`. 첫 위험 하나. parse 실패는 `None`
- Produces (`App`): `App::new`의 `splitter` 다음 인자 `inspector: Arc<dyn StatementInspector>`. `inspect_statement(&self, sql: &str) -> Option<Danger>`(프로젝트가 없어도 된다)
- Produces (command): `inspect_statement(sql) -> DangerDto | null`. `DangerDto`는 `{ kind: "update_without_where" | "delete_without_where", table } | { kind: "drop", object: string, names: string[] } | { kind: "truncate", tables: string[] }`
- Produces (화면 api): `inspectStatement(sql: string): Promise<Danger | null>`, type `Danger`(DTO와 같은 모양)

- [ ] **Step 1: test를 쓴다**

`statement_inspector.rs`의 test(`PgQueryInspector.danger(sql)`):

```rust
#[test]
fn finds_the_four_kinds() {
    assert_eq!(danger("DELETE FROM sessions"), Some(Danger::DeleteWithoutWhere { table: "sessions".into() }));
    assert_eq!(danger("update public.users set plan = 'pro'"), Some(Danger::UpdateWithoutWhere { table: "public.users".into() }));
    assert_eq!(danger("DROP TABLE a, b"), Some(Danger::Drop { kind: "TABLE".into(), names: vec!["a".into(), "b".into()] }));
    assert_eq!(danger("DROP DATABASE app"), Some(Danger::Drop { kind: "DATABASE".into(), names: vec!["app".into()] }));
    assert_eq!(danger("TRUNCATE sessions, events"), Some(Danger::Truncate { tables: vec!["sessions".into(), "events".into()] }));
}

#[test]
fn statements_with_where_or_without_writes_are_safe() {
    for sql in ["DELETE FROM s WHERE id = 1", "UPDATE u SET a = 1 WHERE id = 2", "SELECT * FROM s",
                "EXPLAIN DELETE FROM s", "PREPARE p AS DELETE FROM s", "DELETE FROM s WHERE CURRENT OF c",
                "DELETE FROM", "not sql at all"] {
        assert_eq!(danger(sql), None, "{sql}");
    }
}

#[test]
fn finds_dangers_inside_ctes_and_explain_analyze() {
    assert_eq!(danger("WITH gone AS (DELETE FROM s RETURNING *) SELECT count(*) FROM gone"),
               Some(Danger::DeleteWithoutWhere { table: "s".into() }));
    assert_eq!(danger("EXPLAIN ANALYZE UPDATE u SET a = 1"), Some(Danger::UpdateWithoutWhere { table: "u".into() }));
    assert_eq!(danger("EXPLAIN (ANALYZE, BUFFERS) DELETE FROM s"), Some(Danger::DeleteWithoutWhere { table: "s".into() }));
}
```

`app.rs`의 test: `inspect_statement_works_without_a_project`(fake inspector가 돌려준 값을 그대로). `commands.rs`: `danger_dto_shapes`.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test -p chilla-core statement_inspector`
Expected: FAIL

- [ ] **Step 3: 구현한다**

`pg_query::parse(sql)`의 `protobuf.stmts`를 본다. `SelectStmt`, `InsertStmt`, `UpdateStmt`, `DeleteStmt`의 `with_clause`의 CTE를 재귀로 보고, `ExplainStmt`는 `options`에 `analyze`가 있고 값이 false가 아닐 때만 `query`를 본다. `ObjectType`에서 `kind`로의 대응은 위 목록만 두고 나머지는 `""`다. `docs/architecture.md`의 구성요소 표 "쿼리 실행" 행의 `infrastructure`에 "`pg_query` 위험 쿼리 판별"을 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add crates src-tauri src docs/architecture.md
git commit -m "feat: pg_query parser로 위험 쿼리를 판별함"
```

---

### Task 7: 확인 dialog host와 M3 확인 옮기기

**Files:**
- Create: `src/shared/ui/dialogs.ts`, `src/shared/ui/DialogHost.tsx`, `src/shared/ui/DialogHost.test.tsx`, `src/shared/i18n/rich.tsx`, `src/shared/i18n/rich.test.tsx`
- Modify: `src/shared/api/dialog.ts`, `src/features/editor/saveTab.ts`, `src/features/workspace/commands.ts`, `src/features/workspace/Workspace.tsx`, `src/App.tsx`, `src/shared/i18n/en.ts`, `src/test/resetStores.ts`, 관련 test(`saveTab.test.ts`, `commands.test.ts`, `Workspace.test.tsx`)

**Interfaces:**
- Produces:

```ts
// src/shared/ui/dialogs.ts
export interface DialogAction {
  id: string;            // "cancel"은 Escape와 같다
  label: string;
  variant?: "secondary" | "primary" | "danger"; // 기본 secondary
}
export interface DialogItem { primary: string; secondary: ReactNode }
export interface DialogSpec {
  title: ReactNode;
  body?: ReactNode;
  /** D2Coding pre 한 덩어리(위험 쿼리의 문장). 8줄을 넘으면 그 안에서 scroll */
  sql?: string;
  /** 탭이나 파일 목록(앱 종료, 프로젝트 바꾸기) */
  items?: DialogItem[];
  /** 목록 아래의 덧붙임 */
  note?: ReactNode;
  icon?: "warning";
  /** 왼쪽부터. "cancel"이 반드시 하나 있다 */
  actions: DialogAction[];
}
export function ask(spec: DialogSpec): Promise<string>; // 누른 action의 id
export const useDialogs: UseBoundStore<…>; // { current: DialogSpec | null }
export function isDialogOpen(): boolean;
```

- `rt(key: MessageKey, params: Record<string, ReactNode>): ReactNode` — 문구의 `{name}`을 넘긴 node로 바꾼다. `bold(text)`, `sqlCode(text)`(D2Coding, bg-3, keyword 색 class를 줄 수 있는 `sqlCode(text, { keyword: true })`) helper를 함께 둔다.
- 없어지는 것: `src/shared/api/dialog.ts`의 `confirm`.

- [ ] **Step 1: test를 쓴다**

`DialogHost.test.tsx`:

- `renders_the_spec_as_an_alertdialog`: `role="alertdialog"`, 제목이 `aria-labelledby`, 본문이 `aria-describedby`, action이 왼쪽부터, 처음 focus는 Cancel.
- `escape_resolves_cancel` / `clicking_an_action_resolves_its_id`.
- `a_second_ask_waits_for_the_first`: 두 번 `ask`하면 첫 dialog만 보이고, 첫 답 뒤에 두 번째가 보인다.
- `tab_keeps_focus_inside`: Tab과 Shift+Tab이 dialog 밖으로 나가지 않는다.

`rich.test.tsx`: `rt("dialog.tx.closeBody", { title: bold("a.sql"), connection: bold("staging") })`가 굵은 두 이름을 문장 안에 넣는다. 없는 param은 `{name}`을 그대로 둔다.

`Workspace.test.tsx`: `shortcuts_do_nothing_while_a_dialog_is_open`(dialog가 열린 동안 `Cmd+W`가 탭을 닫지 않음).

M3 확인의 test를 새 dialog로 바꾼다(`saveTab.test.ts`, `commands.test.ts`). 캔버스 문구:

| 확인 | 제목 | 본문 / 목록 | action |
| --- | --- | --- | --- |
| 저장하지 않은 탭 닫기 | `Save changes to {title}?` | `Your changes will be lost if you don't save them.` | `Don't save`, `Cancel`, `Save`(primary) |
| 저장하지 않은 탭이 있을 때 프로젝트 바꾸기 | `{count} tabs have unsaved changes`(`.one`: `1 tab has unsaved changes`) | 탭 제목 목록, note `Switching projects discards these changes and closes every tab's session.` | `Cancel`, `Switch without saving` |
| 밖에서 바뀐 파일 | `{path} changed on disk` | `Another program edited this file after you opened it. Overwriting discards those changes.` | `Cancel`, `Overwrite` |
| 밖에서 지워진 파일 | `{path} was deleted` | `It was deleted from disk after you opened it. Recreate it with this tab's contents?` | `Cancel`, `Recreate` |

- `closing_a_dirty_tab_with_save_closes_only_when_saved`: Save를 고르고 `saveTab`이 `"saved"`면 닫고, `"needs_name"`이나 `"failed"`면 닫지 않는다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/shared src/features/editor src/features/workspace`
Expected: FAIL

- [ ] **Step 3: 구현한다**

모양은 `Dialogs.dc.html`과 `Safety.dc.html`의 `.dlg`(폭 452px, 창 위에서 84px, padding 20, gap 14, radius 12, `--shadow-dialog`, 배경 `--color-scrim`)와 Tokens의 dialog 규칙(제목 fg 17 semibold, 본문 fg-2 15, 이름만 fg 굵게)을 따른다. `icon: "warning"`은 Safety의 32px 경고 icon이다. `DialogHost`는 `App.tsx`에 한 번 둔다. `useShortcuts`의 `enabled`에 `!dialogOpen`을 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: 확인 dialog를 캔버스 모양으로 그리고 native ask를 걷어 냄"
```

---

### Task 8: 탭의 트랜잭션 상태와 모드 (화면 store)

**Files:**
- Create: `src/features/query/transaction.ts`, `src/features/query/transaction.test.ts`
- Modify: `src/features/query/runsStore.ts`, `runsStore.test.ts`, `src/test/resetStores.ts`

**Interfaces:**
- Consumes: Task 3의 `tx`, Task 4의 `executeQuery(…, mode, …)`, `endTransaction`
- Produces:

```ts
// transaction.ts
export interface TxInfo {
  status: "open" | "failed";
  /** 세는 규칙은 계획의 "문장 수" */
  statements: number;
  /** 트랜잭션을 연 실행의 startedAt */
  openedAt: number;
}
export function nextTx(
  previous: TxInfo | null,
  tx: TxStatus | null,
  outcome: Outcome["outcome"],
  mode: TxMode,
  startedAt: number,
): TxInfo | null;
/** Commit, Rollback, 모드 전환이 가능한지(계획의 "가능한 때") */
export function canEndTransaction(run: RunState | undefined): boolean;
```

- `runsStore`에 더하는 것:
  - `transactions: Record<string, TxInfo>`(열린 탭만), `modes: Record<string, TxMode>`(없으면 auto), `ending: Record<string, true>`(끝내는 중)
  - `setMode(tabId: string, mode: TxMode): void` — 확인 없이 바꾼다. 확인은 Task 11이 부른 쪽에서 한다
  - `endTransaction(tabId: string, end: TxEnd): Promise<boolean>` — 성공(`ended`)이면 true. `server_error`는 결과 panel을 `rejected`(title `tx.commitFailed`/`tx.rollbackFailed`, detail은 서버 메시지와 SQLSTATE)로 두고 false. `connection_lost`와 `unknown_session`은 끊김으로 다루고(아래) false. `transaction_failed`는 rejected(title `tx.commitRefused`)로 두고 false. 세션이나 트랜잭션이 없으면 아무것도 보내지 않고 true
  - `RunNotice`가 `{ kind: "reconnected" } | { kind: "transactionLost"; statements: number }`로 바뀐다
- `release`, `reset`은 그 탭의 `transactions`, `modes`, `ending`도 지운다. `reset`은 모드도 지운다(프로젝트가 바뀌면 탭이 새로 생긴다).

- [ ] **Step 1: 순수 함수 test를 쓴다**

`transaction.test.ts`:

```ts
it("counts completed statements while the transaction stays open", () => {
  const opened = nextTx(null, "in_transaction", "completed", "manual", 100);
  expect(opened).toEqual({ status: "open", statements: 1, openedAt: 100 });
  expect(nextTx(opened, "in_transaction", "completed", "manual", 200)).toEqual({ status: "open", statements: 2, openedAt: 100 });
});
it("does not count the BEGIN that opened it in Auto mode", () => {
  expect(nextTx(null, "in_transaction", "completed", "auto", 100)).toEqual({ status: "open", statements: 0, openedAt: 100 });
});
it("keeps the count when the transaction fails", () => {
  const open = { status: "open", statements: 2, openedAt: 100 } as const;
  expect(nextTx(open, "failed", "failed", "manual", 300)).toEqual({ status: "failed", statements: 2, openedAt: 100 });
});
it("clears on idle or a lost connection", () => {
  const open = { status: "open", statements: 2, openedAt: 100 } as const;
  expect(nextTx(open, "idle", "completed", "manual", 300)).toBeNull();
  expect(nextTx(open, null, "connection_lost", "manual", 300)).toBeNull();
});
```

`canEndTransaction`: idle, finished, rejected, running+`ready`은 true. connecting, running+`none`, running+`fetching`은 false.

- [ ] **Step 2: store test를 쓴다**

`runsStore.test.ts`(api mock):

- `run_sends_the_tab_mode`: `setMode("t1", "manual")` 뒤 실행이 `executeQuery(…, "manual", …)`를 부른다.
- `finished_updates_the_transaction`: `tx: "in_transaction"`으로 끝나면 `transactions.t1`이 생기고 `idle`이면 지워진다.
- `end_transaction_commits_and_clears`: `endTransaction` mock이 `{ outcome: "ended", tx: "idle" }`이면 true, `transactions.t1`이 없다. 끝나기 전에는 `ending.t1`이 true.
- `a_failed_commit_shows_the_server_error`: `server_error`면 false, run이 rejected, title은 `tx.commitFailed`, detail에 서버 메시지와 SQLSTATE, `transactions.t1`은 `tx` 값(`idle`이면 없음)을 따른다.
- `a_stale_session_with_an_open_transaction_reports_it_lost`: 열린 트랜잭션이 있는 탭의 접속에 `markStale`하면 바로 notice `{ kind: "transactionLost", statements: 2 }`, `transactions.t1` 없음. 다음 Manual 실행은 새 세션을 열고(옛 세션은 닫힘) 그 `executeQuery`에 `"manual"`을 넘긴다.
- `connection_lost_with_an_open_transaction_reports_it_lost`: finished `connection_lost`(tx null)이고 앞에 트랜잭션이 있었으면 같은 notice.
- `release_forgets_the_transaction_and_mode`.

- [ ] **Step 3: 실패를 확인한다**

Run: `pnpm vitest run src/features/query`
Expected: FAIL

- [ ] **Step 4: 구현한다**

`onEvent`의 finished에서 `nextTx`로 바꾼다. 실행의 `startedAt`과 모드는 실행을 시작할 때 잡아 둔다(실행 중에 모드가 바뀌어도 그 실행은 시작 때 모드로 센다).

- [ ] **Step 5: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 6: commit**

```bash
git add src
git commit -m "feat: 탭마다 트랜잭션 상태와 Auto/Manual 모드를 둠"
```

---

### Task 9: toolbar의 트랜잭션 조작, 단축키, 탭의 TX 표시

**Files:**
- Create: `src/features/workspace/TransactionControls.tsx`, `src/features/workspace/TransactionControls.test.tsx`
- Modify: `src/features/workspace/{Toolbar,shortcuts,commands}.ts(x)`, `shortcuts.test.ts`, `commands.test.ts`, `src/features/editor/{TabBar,TabBar.test}.tsx`, `src/shared/i18n/en.ts`

**Interfaces:**
- Consumes: Task 8의 store, Task 11이 만드는 `switchMode`(이 Task에서는 확인 없는 `setMode`를 부르고 Task 11이 바꾼다)
- Produces:
  - `CommandId`에 `"commit" | "rollback"`. keymap 항목에 `alt: boolean`이 생기고 `commit`은 `{ code: "Enter", shift: true, alt: true }`, `rollback`은 `{ code: "KeyZ", shift: true, alt: true }`. 기존 항목은 `alt: false`. `shortcutLabel`은 `⌥⇧⌘↵`, `⌥⇧⌘Z`, `shortcutKeys`는 `Alt+Shift+Meta+Enter`
  - `commands.ts`의 `execute("commit" | "rollback")`은 활성 탭에 트랜잭션이 있고 `canEndTransaction`일 때만 `endTransaction`을 부른다. 실패 상태에서 `commit`은 아무것도 하지 않는다
  - `formatElapsed(ms: number): string` — `m:ss`, 한 시간이 넘으면 `h:mm:ss`(`src/features/query/transaction.ts`)
- 문구(`en.ts`): `tx.mode` "Transaction mode", `tx.auto` "Auto", `tx.manual` "Manual", `tx.open` "Open", `tx.failed` "Failed", `tx.statements.one` "1 statement", `tx.statements.other` "{count} statements", `tx.manualBegin` "manual BEGIN", `tx.commit` "Commit", `tx.rollback` "Rollback", `tx.badge` "TX", `tx.badgeLabel` "Open transaction, {elapsed}"

- [ ] **Step 1: test를 쓴다**

`shortcuts.test.ts`: `Opt+Shift+Cmd+Enter`가 `commit`, `Opt+Shift+Cmd+Z`가 `rollback`, `Shift+Cmd+Z`(alt 없음)는 null, `Opt+Cmd+Enter`(shift 없음)는 null. 기존 key에 alt가 더해지면 null.

`TransactionControls.test.tsx`(TabsConn 3, Safety A의 toolbar):

- `shows_the_mode_radiogroup`: `role="radiogroup"` 이름 "Transaction mode", Auto가 checked. Manual을 누르면 `setMode("t1", "manual")`.
- `shows_status_and_buttons_only_when_open`: 트랜잭션이 없으면 상태 문구와 Commit/Rollback이 없다. `{ open, 2, openedAt }`이면 `Open · 2 statements · 3:12`(가짜 시각), Rollback, Commit 순서.
- `auto_with_manual_begin_says_so`: Auto이고 문장 0개면 `Open · manual BEGIN · 0:42`.
- `failed_disables_commit`: `Failed · 2 statements · …`, Commit disabled, Rollback enabled.
- `disabled_while_reading`: run이 running+`none`이면 두 버튼과 radiogroup이 disabled.
- 버튼의 `aria-keyshortcuts`가 keymap과 같다.

`TabBar.test.tsx`: `shows_tx_and_elapsed_on_a_tab_with_an_open_transaction`(`TX 3:12`, `aria-label`이 `tx.badgeLabel`), 트랜잭션 없는 탭에는 없다.

`commands.test.ts`: `commit_shortcut_ends_the_active_transaction`, `commit_does_nothing_when_failed`.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/workspace src/features/editor`
Expected: FAIL

- [ ] **Step 3: 구현한다**

배치는 Safety A의 `.bar`: 접속 chip, mode segmented(`.seg`), 상태 문구(13px, fg-2, 시간은 D2Coding), 빈 칸, Rollback, Commit. 버튼은 같은 secondary다. 탭 badge는 `.tx`(Safety A). 경과 시간은 `useNow(1000)`으로 트랜잭션이 있을 때만 돈다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: toolbar에 트랜잭션 모드와 Commit, Rollback을, 탭에 TX 경과 시간을 그림"
```

---

### Task 10: 결과 panel의 실패한 트랜잭션과 Transaction lost

**Files:**
- Create: `src/features/query/TransactionPanels.tsx`
- Modify: `src/features/query/{ResultPane,ResultPane.test}.tsx`, `src/shared/i18n/en.ts`

**Interfaces:**
- Consumes: Task 8의 `transactions`, `notices`, `endTransaction`
- Produces: 문구 `tx.failedTitle` "Transaction failed", `tx.failedHint` "An earlier error left the transaction failed. Roll back, then run again.", `tx.lostTitle` "Transaction lost", `tx.lostBody.one`/`.other` "The connection dropped while a transaction was open. The {count} uncommitted statement(s) were not applied. The next run opens a new session.", `tx.lostBody.none` "The connection dropped while a transaction was open. It was not applied. The next run opens a new session.", `common.ok` "OK", `tx.commitFailed` "Commit failed", `tx.rollbackFailed` "Rollback failed", `tx.commitRefused` "The transaction failed, so it can't be committed. Roll back instead."

- [ ] **Step 1: test를 쓴다**

`ResultPane.test.tsx`:

- `a_failed_statement_in_a_failed_transaction_says_so`(States "트랜잭션 실패"): finished `failed`이고 `transactions.t1.status === "failed"`면 제목 `Transaction failed`, Rollback 버튼(단축키 `⌥⇧⌘Z` 표시), 서버 메시지와 SQLSTATE 그대로, `tx.failedHint`. Rollback을 누르면 `endTransaction("t1", "rollback")`.
- 트랜잭션이 없는 실패는 지금 오류 화면 그대로다.
- `transaction_lost_notice_dismisses_with_ok`(Tunnel 6): notice가 `transactionLost`면 제목, 본문(문장 수), OK. OK는 `dismissNotice`.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/query`
Expected: FAIL

- [ ] **Step 3: 구현한다**

모양은 States "트랜잭션 실패"와 Tunnel 6이다. 상태 색이나 배경 tint를 쓰지 않는다(icon과 문장).

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: 결과 panel에 실패한 트랜잭션과 트랜잭션 유실을 그림"
```

---

### Task 11: 열린 트랜잭션을 잃는 동작의 확인

**Files:**
- Create: `src/features/workspace/transactionPrompts.ts`, `transactionPrompts.test.ts`
- Modify: `src/features/workspace/{commands,commands.test,TransactionControls,Workspace}.ts(x)`, `src/features/connections/ConnectionForm.tsx`, `ConnectionForm.test.tsx`, `src/shared/i18n/en.ts`

**Interfaces:**
- Consumes: Task 7의 `ask`, `rt`, Task 8의 store
- Produces:

```ts
export type TxAction = "close" | "switchMode" | "switchConnection" | "saveTarget" | "switchProject";
/**
 * 탭들의 열린 트랜잭션을 어떻게 할지 묻고 고른 대로 끝낸다. 진행해도 되면 true.
 * 트랜잭션이 없으면 묻지 않고 true. Commit이 실패하면 false(오류는 결과 panel에 남음).
 * Rollback은 실패해도 true. 탭이 둘 이상이면 목록과 "Roll back all and …"만 둔다.
 */
export function settleTransactions(
  tabIds: string[],
  action: TxAction,
  context: { connection?: string; target?: string },
): Promise<boolean>;
export function switchMode(tabId: string, mode: TxMode): Promise<void>;
```

- `closeTab`, `changeConnection`, `switchProject`(폴더를 고른 뒤 Commit), `applySavedProject` 앞의 저장이 `settleTransactions`를 먼저 부른다. 저장은 `ConnectionForm`의 새 prop `beforeSave(connection: Connection): Promise<boolean>`로 묻는다(연결 대상이 바뀐 수정일 때만). Workspace가 그 탭들로 `settleTransactions(…, "saveTarget", { connection })`를 넘긴다. Auto 전환은 `switchMode`가 Manual → Auto이고 트랜잭션이 있을 때만 묻는다. Auto → Manual은 묻지 않는다.
- 문구(Dialogs M6, Safety D):

| action | 제목 | 본문 | 버튼(왼쪽부터) |
| --- | --- | --- | --- |
| close | `This tab has an open transaction` | `Closing {title} closes the {connection} session. {question}` | Cancel, `Roll back and close`, `Commit and close` |
| switchConnection | 같음 | `Switching to {target} closes the {connection} session. {question}` | Cancel, `Roll back and switch`, `Commit and switch` |
| switchMode | `End the transaction before switching to Auto` | `{question}` | Cancel, `Roll back and switch`, `Commit and switch` |
| saveTarget(한 탭) | `A tab using this connection has an open transaction` | `Saving a new target closes the sessions of tabs using {connection}. What should happen to the {count} uncommitted statements in {title}?` | Cancel, `Roll back and save`, `Commit and save` |
| switchProject(한 탭) | `A tab has an open transaction` | `Switching projects closes every tab's session. What should happen to the {count} uncommitted statements in {title}?` | Cancel, `Roll back and switch`, `Commit and switch` |
| 여러 탭(saveTarget, switchProject) | `{count} tabs have open transactions` | 목록(제목, `{connection} · {n statements} · {elapsed}`), note `To decide tab by tab, cancel and use Commit or Rollback in each tab.` | Cancel, `Roll back all and save` / `Roll back all and switch` |

  `{question}`은 `What should happen to the {count} uncommitted statements?`(`.one`), 문장 0개면 `What should happen to the open transaction?`. 실패 상태의 트랜잭션은 Commit 버튼을 빼고, 문장은 같다. 이름(`{title}`, `{connection}`, `{target}`)은 `bold`다.

- [ ] **Step 1: test를 쓴다**

`transactionPrompts.test.ts`(`ask`와 store를 mock):

- `does_not_ask_without_a_transaction`.
- `commit_and_close_commits_then_proceeds` / `roll_back_and_close_rolls_back_then_proceeds`.
- `a_failed_commit_keeps_the_tab_open`: `endTransaction`이 false면 false.
- `a_failed_rollback_still_proceeds`.
- `a_failed_transaction_offers_no_commit`: action 목록에 `commit`이 없다.
- `several_tabs_offer_only_roll_back_all`: 목록 두 줄, action은 cancel과 rollback 하나. 고르면 두 탭 모두 Rollback.
- `cancel_does_nothing`.

`commands.test.ts`: `closing_a_tab_with_a_transaction_asks_before_the_unsaved_prompt`, `switch_project_commits_only_after_a_folder_is_chosen`, `switch_mode_to_auto_with_a_transaction_asks`. `ConnectionForm.test.tsx`: `save_stops_when_before_save_says_no`.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/workspace src/features/connections`
Expected: FAIL

- [ ] **Step 3: 구현한다**

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: 열린 트랜잭션을 잃는 동작 앞에서 Commit 또는 Rollback을 고르게 함"
```

---

### Task 12: 위험 쿼리 확인

**Files:**
- Create: `src/features/workspace/dangerPrompt.ts`, `dangerPrompt.test.ts`
- Modify: `src/features/workspace/{commands,commands.test}.ts`, `src/features/query/runsStore.ts`(`Prepare`가 null을 돌려줄 수 있음), `runsStore.test.ts`, `src/shared/i18n/en.ts`

**Interfaces:**
- Consumes: Task 6의 `inspectStatement`, Task 7의 `ask`, `rt`, `sqlCode`, Task 8의 `modes`, `transactions`
- Produces:
  - `confirmDanger(tabId: string, request: RunRequest): Promise<boolean>` — 위험이 없거나 Run을 고르면 true. `inspectStatement`가 실패하면 묻지 않고 true(서버가 판단)
  - `Prepare`의 반환에 `null`: 실행하지 않고 상태도 바꾸지 않는다
- 문구(Safety A, B). 제목과 첫 문장은 위험 종류로, 둘째 문장은 모드로 고른다:

| 위험 | 제목 | 첫 문장 |
| --- | --- | --- |
| delete | `Run {DELETE} without {WHERE}?` | `This deletes every row in {table} on {connection}.` |
| update | `Run {UPDATE} without {WHERE}?` | `This updates every row in {table} on {connection}.` |
| drop | `Run {DROP object}?`(`object`가 ""이면 `{DROP}`) | `This drops {names} on {connection}.` |
| truncate | `Run {TRUNCATE}?` | `This deletes every row in {tables} on {connection}.` |

  둘째 문장: Manual이거나 트랜잭션이 열려 있으면 `You're inside an open transaction, so you can roll it back until you commit.`, 아니면 `Auto mode commits it immediately, and it can't be undone.`(`can't be undone`은 fg 굵게). SQL keyword는 `sqlCode(…, { keyword: true })`, table 이름은 `sqlCode`, 접속 이름은 `bold`. 여러 이름은 `, `로 잇는다. `sql`에 문장 전체, `icon: "warning"`, action은 `Cancel`, `Run`(danger).

- [ ] **Step 1: test를 쓴다**

`dangerPrompt.test.ts`:

- `safe_statements_run_without_asking`.
- `manual_mode_says_it_can_be_rolled_back` / `auto_mode_says_it_cannot_be_undone` / `auto_with_an_open_transaction_says_it_can_be_rolled_back`.
- `drop_title_uses_the_object_kind`(`Run DROP TABLE?`), `unknown_drop_kind_says_drop`.
- `cancel_returns_false` / `run_returns_true`.
- `an_inspection_error_runs_without_asking`.

`commands.test.ts`: `run_asks_before_a_dangerous_statement_and_does_nothing_on_cancel`(run 상태가 바뀌지 않음), `run_again_asks_too`. `runsStore.test.ts`: `a_null_prepare_changes_nothing`.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/workspace src/features/query`
Expected: FAIL

- [ ] **Step 3: 구현한다**

`prepareRun`과 `runAgain`의 prepare가 요청을 만든 뒤 `confirmDanger`를 부른다. 터널 오류의 retry는 부르지 않는다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: WHERE 없는 UPDATE와 DELETE, DROP, TRUNCATE를 실행 전에 확인함"
```

---

### Task 13: 앱 종료 확인

**Files:**
- Create: `src/features/workspace/quit.ts`, `quit.test.ts`
- Modify: `src-tauri/src/{lib,menu,commands}.rs`, `src/shared/api/{commands,events}.ts`, `src/App.tsx`, `src/shared/i18n/en.ts`

**Interfaces:**
- Consumes: Task 1의 확인 결과, Task 7의 `ask`, Task 8의 `transactions`
- Produces (Rust):
  - menu: 앱 submenu의 `PredefinedMenuItem::quit` 자리에 `MenuItem::with_id(handle, "quit", "Quit ChillaSQL", true, Some("CmdOrCtrl+Q"))`. `on_menu_event`에서 id `quit`이면 `quit-requested`를 emit한다
  - `struct Quitting(AtomicBool)`을 manage한다. `CloseRequested`는 늘 `prevent_close` + emit. `ExitRequested { code: None }`은 `Quitting`이 false면 `prevent_exit` + emit
  - command `quit_app()`: `Quitting`을 true로 두고 `app.exit(0)`. `RunEvent::Exit`의 `shutdown`은 그대로
- Produces (화면): `quitApp(): Promise<void>`, `onQuitRequested(handler: () => void): Promise<() => void>`, `requestQuit(): Promise<void>`, `useQuitRequests()`(App에서 한 번)
- 문구(Dialogs "앱 종료"): 제목 `{count} tabs have open transactions`(`.one`: `1 tab has an open transaction`), 목록(탭 제목, `{connection} · {n statements} · {elapsed}`), note `To decide tab by tab, cancel and use Commit or Rollback in each tab.`, action `Cancel`, `Roll back all and quit`

- [ ] **Step 1: test를 쓴다**

`quit.test.ts`:

- `quits_at_once_without_open_transactions`: `quitApp`이 한 번 불린다. 프로젝트가 열려 있지 않아도 같다.
- `asks_and_quits_on_roll_back_all`: 두 탭이면 목록 두 줄, 고르면 `quitApp`(Rollback은 보내지 않음).
- `cancel_keeps_the_app_open`.
- `a_second_quit_request_while_asking_is_ignored`: 묻는 동안 다시 `requestQuit`해도 dialog는 하나이고, 답한 뒤에는 다시 물을 수 있다.

`commands.rs`: Rust 쪽은 menu와 event라 단위 test가 어렵다. `quit_app`과 `Quitting` flag는 Task 15의 앱 확인에서 본다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/workspace/quit.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현한다**

Task 1에서 Dock Quit이 막히지 않는다고 나왔으면 그 경로는 그대로 두고, 결정 기록대로다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src-tauri src
git commit -m "feat: 열린 트랜잭션이 있으면 앱 종료 전에 확인함"
```

---

### Task 14: 접속 sheet의 `color` 칸

**Files:**
- Modify: `src/features/connections/{ConnectionForm,ConnectionForm.test}.tsx`, `connectionValues.ts`, `connectionValues.test.ts`, `src/shared/i18n/en.ts`

**Interfaces:**
- Consumes: Task 2의 `ConnectionColor`
- Produces: `FormValues.color: ConnectionColor | null`. `toConnection`이 그대로 싣는다. `color`는 연결 대상이 아니므로 `targetChanged`가 보지 않는다(지금과 같음). 문구: swatch의 `aria-label`은 색 이름 그대로(`green` … — `chilla.toml`의 값이라 번역하지 않음)

- [ ] **Step 1: test를 쓴다**

- `connectionValues.test.ts`: `color_round_trips_through_the_form`, `changing_only_the_color_is_not_a_target_change`.
- `ConnectionForm.test.tsx`(ConnectionForm A, B): `color_is_a_radiogroup_of_five`(legend `color`, 다섯 radio, 처음 접속의 색이 checked), `clicking_the_checked_swatch_clears_the_color`, `new_connection_has_no_color`, `saving_sends_the_color`.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/connections`
Expected: FAIL

- [ ] **Step 3: 구현한다**

배치는 ConnectionForm A의 Name 옆 fieldset(32px 높이, gap 6)이다. swatch 색은 `connectionColor`의 token이고 checked는 바깥 ring이다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: 접속 sheet에서 접속 색을 고르게 함"
```

---

### Task 15: 완료 확인 — 앱에서 보고 staging에서 Commit, Rollback

**Files:**
- Modify: `docs/progress.md`, `docs/plans/M6-transaction-safety.md`(체크)

앱을 띄우기 전에 사용자에게 해도 되는지 묻는다. 방법은 진행상황 "지금"의 "앱 동작 확인 방법"이다. staging 접속은 사용자의 local `chilla.toml`에 있는 실제 터널 접속이고, 문서에는 그 이름과 명령을 적지 않는다. staging에는 `CREATE TEMP TABLE`만 써서 공유 data를 건드리지 않는다.

- [ ] **Step 1: local test DB로 화면을 본다** (`scripts/build-app.sh --debug`)

| 확인 | 기준 |
| --- | --- |
| Manual 전환 후 `INSERT`, 다른 탭에서 `SELECT` | 다른 탭에서 보이지 않음. 탭에 `TX m:ss`, toolbar에 `Open · 1 statement` |
| Commit(`Opt+Shift+Cmd+Enter`) | 다른 탭에서 보임. TX 표시가 사라짐 |
| Rollback(`Opt+Shift+Cmd+Z`) | 변경이 사라짐 |
| Auto에서 `BEGIN` | `Open · manual BEGIN`, Commit과 Rollback이 보임(TabsConn 3) |
| 트랜잭션 안의 오류 | `Transaction failed`와 Rollback(States), Commit disabled |
| `DELETE FROM t`(Manual, Auto) | 문구가 모드마다 다름(Safety A, B). Cancel이면 실행하지 않음 |
| 열린 트랜잭션에서 탭 닫기, 접속 바꾸기, Auto 전환, 연결 대상 저장, 프로젝트 바꾸기 | Dialogs, Safety D의 문구와 버튼 |
| 열린 트랜잭션에서 `Cmd+Q`(custom menu item), 창 닫기 | 앱 종료 확인. Cancel이면 남고, Roll back all이면 끝남 |
| 열린 트랜잭션에서 Dock의 Quit, `osascript -e 'quit app "ChillaSQL"'` | 확인 없이 끝나고 서버가 트랜잭션을 되돌림(Task 1 결과). 다시 열어 Commit되지 않았는지 확인 |
| 저장하지 않은 탭 닫기 | 캔버스 dialog의 Don't save / Cancel / Save |
| `color` swatch로 색을 바꿔 저장 | 창 상단 bar, 탭 dot, chip이 바뀜 |
| 큰 결과를 받다 만 채로 Manual에서 다음 문장 | 트랜잭션이 Failed가 되지 않음 |

받다 만 결과의 10분 자동 닫기는 자동 test로 확인하고 앱에서는 기다리지 않는다.

- [ ] **Step 2: staging 터널에서 완료 기준을 확인한다**

터미널 없이 앱에서 staging 접속을 열고(터널을 앱이 띄움) Manual 모드에서:

1. `CREATE TEMP TABLE m6_check (n int)` → Commit
2. `INSERT INTO m6_check VALUES (1)` → Commit → `SELECT * FROM m6_check`가 1행
3. `INSERT INTO m6_check VALUES (2)` → Rollback → `SELECT * FROM m6_check`가 여전히 1행
4. 터널 프로세스를 밖에서 끝내 트랜잭션 중 끊김을 만들면 "Transaction lost"가 보인다

- [ ] **Step 3: 기록하고 commit한다**

- 진행상황: M6을 `완료`(날짜), 작업 로그에 Task별 결과와 Step 1·2의 결과, "지금"의 다음 할 일(M7)을 쓴다.
- 이 계획의 체크박스를 모두 체크한다.

Run: `pnpm check`
Expected: 통과

```bash
git add docs
git commit -m "docs: M6 완료 확인 결과를 기록함"
```
