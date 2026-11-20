# M8 에디터·실행 편의 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 3단계 완료 기준(하루 업무를 DataGrip 없이 처리)을 채운다. Reformat, 오류 위치 밑줄과 Go to error, 파일 전체 실행과 문장별 결과 탭, 결과의 type 표시와 값 보기 panel, 읽기 전용 접속과 statement timeout, 저장하지 않은 탭 자동 보관과 복원, 최근 프로젝트, 전역 설정 파일, 한국어 화면 문구를 만든다.

**Architecture:** Rust는 세 가지를 새로 한다. (1) `TxTap`이 RowDescription을 읽어 결과 컬럼의 type OID와 typmod를 `Columns` event에 붙이고, type 이름은 catalog connection이 `format_type`으로 답한다. (2) 앱 내부 저장소(SQLite, `rusqlite`)에 최근 프로젝트와 프로젝트별 탭 snapshot을 둔다. snapshot의 내용은 화면이 정한 JSON이고 Rust는 text로 보관만 한다. (3) 전역 설정 파일 `~/.config/chilla/config.toml`을 앱 시작 때 한 번 읽어 `QueryLimits`와 menu 언어에 쓰고 화면에 넘긴다. 여러 문장 실행은 화면이 문장을 하나씩 보내고, 마지막이 아닌 문장은 Rust가 끝까지 읽되 첫 batch만 보낸다(`drain`). 나머지(Reformat, 범위 강조, 오류 밑줄, 타입별 표시, 값 보기, `ko` dictionary)는 화면 일이다.

**Tech Stack:** M7의 stack 그대로. 새 package는 `sql-formatter` 15.9(화면), 새 crate는 `rusqlite`(`bundled`), `iana-time-zone`(Mac의 time zone 이름)이다.

**Spec:** [기획서](../spec.md) 1장(화면 언어), 4.1(읽기 전용), 4.4(Formatting, 오류 위치, 자동 보관), 4.5(실행 범위, 여러 문장, 타임아웃), 4.6(타입별 표시), 4.8(읽기 전용, 위험 쿼리), 4.10(단축키), 5장(전역 설정 파일, 앱 내부 저장소), 9장 / [마일스톤](../milestones.md) M8 / [디자인](../design/README.md)의 `States`(실행 범위, 오류, timeout, 여러 문장, 빈 상태), `Tools`(M8 타입별 표시), `Safety`(C), `ConnectionForm`(B), `Welcome`(A, B), `Sidebar`(D), `Main`(toolbar, 현재 문장 강조), `Tokens` / [구조](../architecture.md)

## 먼저 확인한 것 (계획 작성 중 확인)

| 확인한 것 | 결과 | 결정 |
| --- | --- | --- |
| 결과 컬럼의 type을 얻는 방법(마일스톤 "먼저 확인할 것") | `tokio-postgres` 0.7.18의 `SimpleColumn`은 `name()`만 공개한다. `prepare`로 Describe하면 실행마다 round trip이 하나 더 들고(터널 너머에서 수십 ms), Parse 오류가 Manual 트랜잭션을 실패 상태로 만든다. `TxTap`은 이미 backend message의 framing을 따라가므로 RowDescription(`T`)의 payload도 읽을 수 있다. tap은 `tokio-postgres`가 message를 해석하기 전에 byte를 보므로, `PgRows`가 RowDescription을 받을 때 그 type은 이미 tap에 있다 | `TxTap`이 RowDescription마다 컬럼별 `(type OID, typmod)`를 queue에 넣고, `start_query`가 보내기 전에 queue를 비우고, `PgRows`가 RowDescription을 받을 때 앞에서 하나 꺼낸다. `prepare`는 쓰지 않는다 |
| type 이름(test DB, PostgreSQL 18.6) | `format_type(oid, typmod)`과 `pg_type.typcategory`: `23,-1` → `integer`/`N`, `1043,259` → `character varying(255)`/`S`, `1700,655366` → `numeric(10,2)`/`N`, `1184` → `timestamp with time zone`/`D`, `1009` → `text[]`/`A`, `3802` → `jsonb`/`U`, `114` → `json`/`U`. 캔버스는 `int8`처럼 내부 이름을 쓴다 | 이름은 M7 스키마 트리와 같은 `format_type`이다(캔버스의 `int8` 대신 `bigint`). catalog connection이 `unnest($1::oid[], $2::int4[])`로 한 번에 답한다 |
| 실행될 문장 범위 강조의 비용(마일스톤 "먼저 확인할 것") | `split_statements`는 1만 줄에 약 40ms이고 IPC로 text 전체를 보낸다. 커서가 움직일 때마다 부르면 화살표 key를 누르고 있을 때 밀린다 | span은 문서 StateField에 두고 변경을 따라 옮긴다(`mapPos`). 마지막 입력 뒤 150ms 동안 입력이 없으면 비동기로 다시 나눈다. 커서 이동은 둔 span만 본다. 실행할 때 span이 지금 문서의 것이면 다시 나누지 않는다 |
| 접속 key 이름(마일스톤 "먼저 확인할 것", 기획서 9장) | 캔버스는 `read_only`, `statement_timeout`(input 값 `30s`)을 제안한다. test DB에서 startup option `-c default_transaction_read_only=on -c statement_timeout=1500`으로 연 세션은 `CREATE TEMP TABLE`을 `cannot execute CREATE TABLE in a read-only transaction`으로 거절하고 `pg_sleep(2)`를 SQLSTATE `57014`, `canceling statement due to statement timeout`으로 끊는다 | `read_only = true`(없으면 false), `statement_timeout = 30`(초 단위 정수, 1~86400, 없으면 서버 기본값). `tunnel_timeout`과 같은 단위다. 둘 다 startup option으로 보낸다 |
| DataGrip 키맵(기획서 9장) | DataGrip 도움말의 Shift+Enter는 "Open in Value Editor"(data editor에서 고른 셀의 값을 열기)다. DataGrip의 Cmd+O는 database object 찾기이고 프로젝트 열기 단축키는 없다 | 값 보기는 Shift+Enter. 프로젝트 열기는 macOS 관례대로 Cmd+O(ChillaSQL에는 object 찾기가 없다, 1장 "만들지 않는 것") |
| `sql-formatter` 15.9.1(Task 1 Step 1, `language: "postgresql"`, `keywordCase: "preserve"`, `tabWidth: 2`) | `::date`, `::text[]`, `$1::int`, `'{1,2}'::int[]`는 그대로다. `$$ … $$`와 `$body$ … $body$` 함수 본문은 안의 `;`까지 한 덩어리로 두고 그 뒤의 문장만 새 줄로 나눈다. `->>`, `->`, `@>`, `#>>`, `?|`, `<->`, `<=>`, `<#>`, `"Order Items"`, 한글 식별자와 한글 주석(`--`, `/* */`)은 연산자 앞뒤 공백만 바뀐다. 문법 오류 `SELEC 1 FROM`은 throw하지 않고 `SELEC 1\nFROM`으로 바꾼다. 닫히지 않은 `'`, `"`, `$$`는 `Parse error: Unexpected "'abc from " at line 1 column 8.\nSQL dialect used: "postgresql".`처럼 throw한다. 닫히지 않은 `/* abc`는 throw하지 않고 `/ * abc`로 바꿔 주석이 나눗셈과 곱셈이 된다(의미가 바뀐다). 그 밖에 `:name`은 들여쓰기가 어긋나고 `int4range(1,2)`는 `int4range (1, 2)`가 된다(의미는 같다). 2,000문장(17만 자) text는 195ms | 의미가 바뀌는 입력은 닫히지 않은 `/*` 하나뿐이다. `reformatDocument`는 닫히지 않은 block comment를 먼저 알아보고 `ok: false`로 돌려 문서를 그대로 둔다(Task 10의 test `rejects_unclosed_block_comment`). 문법 오류는 막지 않고 서식만 바꾼다. 2,000문장도 동기로 불러 충분하다(Worker로 옮기지 않는다) |

## 이 계획에서 정한 것

기획서에 없거나 다르게 정한 것이다. Task 1에서 진행상황의 결정 기록에 옮기고, 기획서와 마일스톤도 고친다.

- **결과 컬럼의 type.** `Columns` event의 컬럼마다 `type_oid`, `type_modifier`가 붙는다. 화면은 접속별 cache에 없는 type만 `describe_types`로 묻는다. 답이 오기 전과 실패하면 header에 type이 없고 왼쪽 정렬이다.
- **타입별 표시(Tools M8).** header는 이름(13px, weight 600) 옆에 type(mono 12px, fg-3, gap 6px). typcategory `N`은 오른쪽 정렬. `json`/`jsonb`는 한 줄로 그리고 둘째 단계부터의 object와 array를 `{…}`, `[…]`로 접는다(`{"plan": "pro", "billing": {…}}`). parse가 안 되면 받은 text 그대로다. type 이름이 `vector(…)`/`halfvec(…)`이고 값이 4개 이상이면 앞 3개와 `…`, fg-3의 `{n} values`. 배열은 서버 text 그대로(`{beta,vip}`). NULL, 빈 문자열, 300자 자르기는 M4 그대로다.
- **timestamptz.** 세션을 열 때 startup option `TimeZone`에 Mac의 IANA time zone 이름을 넣어 서버가 Mac 시간으로 text를 만든다(pgJDBC를 쓰는 DataGrip과 같다). 이름을 못 얻으면 넣지 않는다. 사용자의 `SET TimeZone`은 그대로 듣는다. 기획서 4.6에 반영.
- **값 보기 panel(Tools M8).** 결과 표에서 셀을 고르고 Shift+Enter를 누르면 결과 panel 오른쪽에 340px panel이 열리고 다시 누르거나 닫기 버튼, Esc로 닫는다. 머리 줄(36px)은 컬럼 이름(mono 13, 500), `{type} · row {n}`(mono 12, fg-2), Copy value, Close. 본문은 mono 13, line-height 1.6. `json`/`jsonb`는 2칸 들여쓴 JSON이고 key, 문자열, 숫자를 에디터 syntax token 색으로 칠한다. 나머지는 줄바꿈하는 원래 text, NULL은 fg-3 기울임 `NULL`. 열린 채 다른 셀을 고르면 그 셀을 보인다. 화면을 닫으면 잊는다.
- **여러 문장 실행.** 선택 영역이 문장 둘 이상으로 나뉘거나 toolbar menu의 Run file을 고르면 문장을 차례로 실행한다. 마지막이 아닌 문장은 Rust가 끝까지 읽고 첫 batch(500행, 4 MiB)만 보낸다(`drain`). 버리면 cancel이 되어 `UPDATE … RETURNING`의 변경이 되돌려지기 때문이다. 마지막 문장은 지금처럼 이어서 가져올 수 있다. 문장이 `completed`가 아니면(오류, Cancel, 연결 끊김, client 오류) 거기서 멈추고 나머지는 Not run이다. 위험한 문장은 그 문장 차례에 확인하고, Cancel하면 그 문장부터 Not run이다. Run file에는 단축키를 두지 않는다.
- **결과 탭(States "여러 문장").** 문장이 둘 이상이면 결과 panel header에 탭 줄을 그린다. label은 fg-3 mono의 번호와 `resultLabel(sql)`(오류는 `Error`, 실행하지 않은 문장은 fg-3의 `Not run`, 누를 수 없다). 실행 중에는 지금 문장의 탭을 고르고, 멈추면 멈춘 문장의 탭을 고른다. 오류 화면 아래에 `Stopped at statement {n}. {rest}`. 앞 문장의 결과는 고정된 snapshot이라 이어서 가져오지 않는다.
- **오류 위치.** 실행할 때 보낸 문장의 문서 offset을 문서 StateField에 두고 변경을 따라 옮긴다. 오류의 `position`(보낸 text 기준 UTF-16 offset)에서 그 자리의 단어 끝(단어가 아니면 한 글자)까지 danger 색 wavy underline(`text-underline-offset: 4px`)을 긋는다. 밑줄은 그 탭의 다음 실행이나 밑줄 범위를 건드리는 편집에서 지운다. 결과 오류 화면의 Ln/Col과 Go to error는 옮겨진 위치를 쓰고, Go to error는 그 자리에 커서를 두고 에디터에 focus한다. Run again은 처음 보낸 text와 옮겨진 위치를 쓴다(M4의 "Run again은 처음 `origin`을 그대로"를 대신한다).
- **실행될 범위 강조(Main).** 선택 영역이 없을 때 커서의 문장(`statementAt`)이 걸친 줄에 `accent/7` 배경과 왼쪽 2px accent 선. 선택 영역이 있거나 문장이 없거나 나눌 수 없으면 그리지 않는다.
- **Reformat.** `Opt+Cmd+L`, toolbar의 Reformat icon 버튼(`Reformat (Opt+Cmd+L)`), 빈 상태 안내 `⌥⌘L Reformat`. 선택 영역이 있으면 그것만, 없으면 문서 전체를 `sql-formatter`(`language: "postgresql"`, `keywordCase: "preserve"`, `tabWidth: 2`)로 바꾼다. 실행 취소 한 번으로 돌아간다. 실패하면 문서를 그대로 두고 toast `Couldn't reformat: {첫 줄}`. `sql-formatter`가 throw하지 않고 의미를 바꾸는 입력(닫히지 않은 `/*`)은 실패로 친다.
- **읽기 전용 접속.** `read_only = true`면 세션과 catalog connection을 `default_transaction_read_only=on`으로 연다. 위험 쿼리 확인을 하지 않는다. 서버가 SQLSTATE `25006`으로 거절하면 오류 화면의 설명 줄이 `SQLSTATE 25006 · {접속} is a read-only connection, so the database rejected the write. Nothing changed.`(Safety C). 자물쇠 icon(`Read-only`)을 sidebar 접속 목록, 접속 menu, toolbar chip에 그린다. 임시 테이블도 거절된다(서버 동작).
- **statement timeout.** `statement_timeout`이 있는 접속에서 outcome이 `failed`이고 SQLSTATE가 `57014`면 결과 panel은 Timed out 화면(States): 제목 `Timed out`, 서버 메시지, `SQLSTATE 57014 · This connection's statement_timeout is {n}s.`. 사용자의 Cancel은 지금처럼 `cancelled`로 온다.
- **세션 설정이 바뀐 저장.** `read_only`나 `statement_timeout`을 바꿔 저장하면 연결 대상을 바꾼 저장처럼 그 접속을 쓰는 탭의 세션을 놓고 catalog를 다시 읽는다(열린 트랜잭션이 있으면 먼저 묻는다). 비밀번호는 지우지 않는다. Rust `same_session`과 화면 `sessionChanged`가 이 비교다.
- **접속 sheet(ConnectionForm B).** `tunnel` 아래에 `read_only` switch와 설명 `Opens sessions read-only so the database rejects writes`. 그 아래 접힌 Advanced(`statement_timeout · tunnel_timeout · sslrootcert`를 mono fg-3로 함께 보임)를 펼치면 세 칸. `statement_timeout`의 hint는 `Seconds. Empty means none`. 기존 값이 있는 칸이 있으면 펼친 채 연다. 테스트 성공은 `Connected · PostgreSQL {version}`과 오른쪽의 `{ms} ms`. version은 `SHOW server_version`의 첫 단어다.
- **전역 설정 파일.** `~/.config/chilla/config.toml`. key는 아래 넷이고 모두 생략할 수 있다. 앱 시작 때 한 번 읽고, 바꾸면 다시 시작해야 반영된다. 파일이 없으면 기본값이고 만들지 않는다. 형식이 틀리거나 모르는 key, 범위를 벗어난 값이 있으면 기본값으로 시작하고 첫 화면에 오류 dialog로 이유를 보인다. 단축키 변경(`[keys]`)은 M10이다.

  ```toml
  language = "en"            # "en" | "ko"
  [editor]
  font = "D2Coding"          # CSS font-family 이름. 없으면 D2Coding으로 대신 그린다
  font_size = 15             # px, 10~32
  [results]
  retained_rows = 100000     # 1000~1000000
  idle_timeout = 600         # 받다 만 결과를 닫는 초, 60~86400
  ```
- **언어.** 화면은 `language`의 dictionary(`en`, `ko`)로 그린다. `ko`의 type은 `Record<MessageKey, string>`이라 빠진 key는 typecheck가 잡는다. `ko` 문구: Commit, Rollback, Auto, Manual, SQL keyword, 설정 key, 단축키 기호는 영어 그대로 두고 나머지를 한국어로 쓴다. 숫자 묶음은 두 언어 모두 `en-US`. Rust 오류는 `CommandError`에 `params`를 더하고 화면이 `error.<kind>` 문구에 넣는다. 영어 문구는 지금 Rust message와 같다. PostgreSQL 오류, OS의 io 오류 text, 터널 stderr는 param 그대로 들어간다. macOS menu는 Rust가 `language`로 고른 label로 만든다.
- **앱 내부 저장소.** `<app_data_dir>/chilla.sqlite3`(Tauri `app_data_dir`, `~/Library/Application Support/com.yuiyeong.chillasql/`). table은 `recent_projects(dir TEXT PRIMARY KEY, name TEXT NOT NULL, opened_at INTEGER NOT NULL)`과 `workspaces(dir TEXT PRIMARY KEY, snapshot TEXT NOT NULL, saved_at INTEGER NOT NULL)`이다. schema 판은 `PRAGMA user_version = 1`. 열지 못하면(파일 손상 등) 최근 프로젝트와 자동 보관 없이 앱이 뜨고 오류 dialog를 보인다. 쿼리 기록(M9)은 이 파일에 table을 더한다.
- **최근 프로젝트.** 프로젝트를 열거나 만들 때마다 Rust가 기록하고 최근 10개만 남긴다. 앱을 시작하면 가장 최근 프로젝트를 연다. 열지 못하면 Welcome A(오류, Open Project… ⌘O, Recent Projects 목록: 두 글자 initials, 이름, `~`로 줄인 경로, 언제 — `Just now`(1분 안), `Today`, `Yesterday`, 그 밖에는 `Nov 9`)를 보인다. `chilla.toml`이 없는 디렉토리는 Welcome B의 sheet로 묻는다. sidebar의 프로젝트 이름을 누르면 Sidebar D의 menu(지금 프로젝트, `Recent`의 나머지, `Open Project… ⌘O`)가 열린다. `Cmd+O`는 폴더 picker다. M3의 `localStorage`(`chilla.lastProjectDir`)는 쓰지 않고 그 값을 옮기지 않는다. 없는 디렉토리도 목록에 남고 열 때 오류를 보인다.
- **자동 보관과 복원.** 화면은 프로젝트마다 탭 snapshot(JSON, `version: 1`)을 보관한다: 탭 순서, 활성 탭, 탭마다 `title`, `path`, `stamp`, `connection`, `mode`, `text`(저장하지 않은 변경이 있거나 파일이 없는 탭만, 아니면 null). 탭이나 문서가 바뀌면 마지막 변경 1초 뒤에 저장하고, 프로젝트를 바꾸기 전과 앱을 끝내기 전(`quit_app` 앞)에는 바로 저장한다. 프로젝트를 열면 snapshot으로 탭을 되살린다: `text`가 있는 탭은 그 text로 dirty하게, 없는 탭은 파일을 다시 읽는다(읽지 못하면 그 탭을 빼고 오류를 한 번 보인다). 복원한 dirty 탭의 저장은 보관한 `stamp`로 M3의 덮어쓰기 확인을 그대로 탄다. 세션과 트랜잭션은 되살리지 않는다(모드는 되살린다). 그래서 **프로젝트를 바꿀 때 저장하지 않은 탭을 묻지 않는다**(M3의 확인을 없앤다. 앱 종료와 같다). 탭 닫기의 확인은 그대로다.
- **에디터 글꼴.** `editor.font`, `editor.font_size`를 `.cm-content`와 gutter에 쓴다(`font-family: "{font}", "D2Coding", monospace`, line-height는 `round(size × 1.6)`px). 결과 표는 D2Coding 그대로다.
- **받다 만 결과를 닫는 시간과 보관 상한.** `results.idle_timeout`, `results.retained_rows`가 `QueryLimits`가 된다. 화면이 쓰는 분 수(M6의 `IDLE_RESULT_MINUTES`)는 설정에서 받는다.

## Global Constraints

- 의존 방향: `infrastructure` → `application` → `domain`(`tests/layer_deps.rs`). `rusqlite`, `iana-time-zone`, 파일 읽기는 `infrastructure`에만 둔다. 두 crate를 `layer_deps.rs`의 `domain`, `application` 금지 목록과 [구조](../architecture.md) 2장 표에 더한다. `chilla-core`는 `tauri`에 의존하지 않는다.
- `@tauri-apps/*`는 `src/shared/api/`에서만 import한다.
- 화면 문구는 `src/shared/i18n/en.ts`(와 `ko.ts`)에 두고 `t`, `tc`로 쓴다. PostgreSQL 오류 메시지, SQL, 설정 파일의 key, 결과 data, type 이름은 번역하지 않는다.
- 색, 그림자, 글자 크기는 `src/index.css`의 token으로만 쓴다. 새 색이 필요하면 token을 더한다(값 보기의 JSON key 색은 에디터 syntax token을 다시 쓴다).
- 상수: 범위 강조 debounce 150ms, 자동 보관 debounce 1000ms, 최근 프로젝트 10개, 값 보기 panel 340px, `statement_timeout` 1~86400초, 설정 값 범위는 위 TOML의 주석.
- commit 전에 `pnpm check`를 통과시킨다. commit message는 `feat:`/`fix:`/`docs:`/`chore:`/`test:` 뒤에 한국어 한 줄이다.
- `docs/`는 평서체, 기술 용어는 영어, 날짜는 `YYYY-MM-DD`, 단축키는 `Opt+Cmd+L`처럼 글자로 쓴다.

## Review Focus

test가 없으면 사용자가 가장 먼저 부딪힐 입력과 상황이다. 각 줄의 test는 해당 Task에 넣었다.

1. **1만 줄 파일에서 화살표 key를 누르고 있음**: 범위 강조가 커서 이동마다 `split_statements`를 부르면 입력이 밀린다 → Task 11 `cursor_moves_do_not_split`.
2. **파일 실행 중간에 1000행을 돌려주는 `UPDATE … RETURNING`**: 첫 batch만 보여도 변경은 남아야 한다 → Task 7 `a_drained_statement_keeps_its_changes`.
3. **한글이나 emoji 뒤의 오류 위치**: 밑줄과 Ln/Col이 그 글자를 정확히 가리켜야 한다 → Task 12 `underline_after_hangul_and_emoji`.
4. **저장하지 않은 탭을 둔 채 Dock Quit, 그 사이 밖에서 파일이 바뀜**: 다시 열면 변경이 남아 있고, 저장하면 덮어쓰기를 묻는다 → Task 17 `restored_dirty_tab_keeps_its_stamp`, `flushes_before_quit`.
5. **설정 파일의 오타(`fontsize = 14`)**: 앱이 기본값으로 뜨고 이유를 보여야 한다 → Task 5 `unknown_key_is_an_error`, Task 9 `settings_error_is_shown_once`.

---

## File Structure

| 파일 | 할 일 |
| --- | --- |
| `crates/chilla-core/src/domain/query.rs` | `Column`에 `type_oid`, `type_modifier` |
| `crates/chilla-core/src/domain/catalog.rs` | `TypeInfo` |
| `crates/chilla-core/src/domain/connection.rs` | `read_only`, `statement_timeout`, `same_session` |
| `crates/chilla-core/src/domain/settings.rs` (새) | `Settings`, `Language`, `EditorSettings`, `SettingsError` |
| `crates/chilla-core/src/infrastructure/postgres/{tx_tap,rows,mod}.rs` | RowDescription의 type, startup option, `server_version`, `describe_types` |
| `crates/chilla-core/src/infrastructure/postgres/catalog.rs` | `describe_types` SQL |
| `crates/chilla-core/src/infrastructure/project_file.rs` | 두 key 읽고 쓰기 |
| `crates/chilla-core/src/infrastructure/settings_file.rs` (새) | `config.toml` 읽기 |
| `crates/chilla-core/src/infrastructure/sqlite_store.rs` (새) | `SqliteAppStore` |
| `crates/chilla-core/src/application/ports.rs` | `DbConnection::describe_types`, `server_version`, `AppStore` |
| `crates/chilla-core/src/application/session_actor/{mod,query}.rs` | `drain` |
| `crates/chilla-core/src/application/app.rs` | `describe_types`, `test_connection`의 version, 최근 프로젝트 기록, workspace snapshot, `QueryLimits` 받기 |
| `src-tauri/src/{commands,error,lib,menu}.rs` | command, DTO, 오류 `params`, 설정과 저장소 setup, menu 언어 |
| `src/shared/api/{types,commands}.ts` | 새 type과 호출 |
| `src/shared/i18n/{en,ko,t,errorKinds.json}` | `ko`, 언어 선택, `error.<kind>` |
| `src/shared/api/errors.ts` | `messageOf`가 kind 문구를 씀 |
| `src/features/settings/settingsStore.ts` (새) | 설정과 설정 오류 |
| `src/features/editor/{runMarks,statementSpans,reformat}.ts` (새) | 실행 위치·오류 밑줄, span cache와 범위 강조, Reformat |
| `src/features/query/{runsStore,runReducer,ResultPane,ResultGrid,format,grid}.ts(x)` | 여러 문장, type 표시, timeout·read-only 화면 |
| `src/features/query/{typesStore,cellDisplay}.ts`, `ValueViewer.tsx` (새) | type cache, 타입별 표시, 값 보기 panel |
| `src/features/connections/*` | sheet의 두 칸, Advanced, read-only icon |
| `src/features/project/{projectStore,ProjectGate,Sidebar,ProjectMenu}.tsx` | 최근 프로젝트, Welcome, 프로젝트 menu |
| `src/features/workspace/{autosave,commands,shortcuts,Toolbar,quit,dangerPrompt}.ts(x)` | 자동 보관, run file, reformat, Cmd+O |

---

### Task 1: 먼저 확인한 것과 결정 기록

**Files:**
- Modify: `docs/progress.md`, `docs/spec.md`, `docs/milestones.md`, `docs/architecture.md`, `package.json`, `pnpm-lock.yaml`

- [x] **Step 1: `sql-formatter`를 확인한다**

`pnpm add sql-formatter@15.9.1` 뒤 scratchpad의 node script로 `format(text, { language: "postgresql", keywordCase: "preserve", tabWidth: 2 })`를 돌린다. 확인할 것: `::date` 캐스팅, `$$ … $$` 함수 본문(안의 `;` 포함), `->>`, `@>`, `"Order Items"`, 한글 식별자와 주석이 의미를 바꾸지 않음. 문법 오류(`SELEC 1 FROM`), 닫히지 않은 따옴표에서 throw하는지와 그 message. 2,000문장 text의 시간. 결과를 이 계획의 "먼저 확인한 것" 표 마지막 줄에 적는다. 의미가 바뀌는 입력이 있으면 그 입력은 Reformat하지 않도록(toast) Task 10의 test에 더한다.

- [x] **Step 2: 문서를 고친다**

- 진행상황: M8을 `진행 중`(시작 2026-11-20, 계획 링크), "지금"을 M8 Task 2로. 결정 기록에 "먼저 확인한 것"의 결정과 "이 계획에서 정한 것"의 줄마다 한 줄(날짜, M8). M3의 "마지막 프로젝트를 `localStorage`에", "앱을 끝낼 때 묻지 않음", M4의 "Run again은 처음 `origin`" 줄에 대신하는 결정을 가리킨다.
- 기획서: 4.1 읽기 전용(key 이름), 4.4(Formatting의 선택 영역, 오류 위치의 Go to error, 자동 보관과 프로젝트 바꾸기), 4.5(여러 문장의 `drain`, 타임아웃의 key와 단위, 실행 범위 강조), 4.6(timestamptz는 Mac의 time zone), 4.10(Cmd+O, Shift+Enter 확정), 5장(전역 설정 key 표, 앱 내부 저장소 위치), 9장에서 정한 두 줄(key 이름, 키맵)을 지운다. 마지막 수정 날짜.
- 마일스톤 M8 "먼저 확인할 것" 넷에 `→ 정함:`으로 결과를 적는다.
- 구조 2장 표에 `rusqlite`, `iana-time-zone`을 `infrastructure`의 crate로 더한다.

- [x] **Step 3: commit**

```bash
git add docs package.json pnpm-lock.yaml
git commit -m "docs: M8 계획과 type 얻기, 범위 강조, 접속 key, 설정·저장소 결정을 기록함"
```

---

### Task 2: 결과 컬럼의 type (Rust)

**Files:**
- Modify: `crates/chilla-core/src/domain/query.rs`, `crates/chilla-core/src/infrastructure/postgres/{tx_tap,rows,mod}.rs`, `crates/chilla-core/src/application/test_support/connection.rs`, `crates/chilla-core/tests/query_stream.rs`, `src-tauri/src/commands.rs`, `src/shared/api/types.ts`, `src/features/query/{runReducer,ResultPane,ResultGrid}.ts(x)`와 그 test

**Interfaces:**
- Produces:
  ```rust
  pub struct Column {
      pub name: String,
      /// RowDescription의 type OID.
      pub type_oid: u32,
      /// RowDescription의 typmod. 없으면 -1.
      pub type_modifier: i32,
  }
  ```
  `TxTap`: `pub(crate) struct RowTypes(Arc<Mutex<VecDeque<Vec<(u32, i32)>>>>)`, `fn clear(&self)`, `fn pop(&self) -> Option<Vec<(u32, i32)>>`. `TxTap::new`가 `(Self, TxStatusCell, RowTypes)`를 돌려준다.
- 화면: `export interface ResultColumn { name: string; typeOid: number; typeModifier: number }`. `QueryEvent`의 `columns`와 `ResultData.columns`가 `ResultColumn[]`이다.

- [x] **Step 1: test를 쓴다**

- `tx_tap.rs`: `row_description_types_are_queued`(필드 둘인 `T` message를 3 byte씩 나눠 넣으면 `pop()`이 `[(23, -1), (1043, 259)]`), `clear_drops_queued_types`, `status_is_still_read_after_a_row_description`.
- `tests/query_stream.rs`: `columns_carry_type_oid_and_modifier`(`SELECT 1::int4 AS a, 'x'::varchar(10) AS b, NULL::numeric(10,2) AS c` → `(23,-1)`, `(1043,14)`, `(1700,655366)`), `types_follow_each_query`(앞 쿼리 뒤에 다른 컬럼의 쿼리를 보내도 그 쿼리의 type).
- `runReducer.test.ts`: `columns_keep_their_types`.

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test -p chilla-core tx_tap query_stream` 와 `pnpm vitest run src/features/query/runReducer.test.ts`
Expected: FAIL(`type_oid` 없음)

- [x] **Step 3: 구현한다**

- `TxTap::start_payload`: `T` message면 payload를 모아(header에 길이가 있다) 다 모이면 field 수(int16) → field마다 name(NUL로 끝남), table OID(4), attnum(2), type OID(4), typlen(2), typmod(4), format(2)에서 type OID와 typmod를 꺼내 queue에 넣는다. 다른 message는 지금처럼 건너뛴다.
- `PgConnection::start_query`가 `simple_query_raw` 전에 `row_types.clear()`. `PgRows`가 `RowDescription`에서 `pop()`한 값을 이름과 짝짓는다. 값이 없거나 수가 다르면 `(0, -1)`이다(화면은 type 없음으로 그린다).
- fake connection은 test가 준 type을 그대로 돌려준다. DTO는 `typeOid`, `typeModifier`(camelCase, 기존 DTO와 같은 규칙).
- 화면은 컬럼 이름이 필요한 곳에서 `column.name`을 쓴다. 그리는 모양은 Task 14가 바꾼다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add crates src-tauri src
git commit -m "feat: RowDescription에서 결과 컬럼의 type OID와 typmod를 읽어 화면에 보냄"
```

---

### Task 3: type 이름 조회

**Files:**
- Modify: `crates/chilla-core/src/domain/catalog.rs`, `crates/chilla-core/src/application/{ports,app}.rs`, `crates/chilla-core/src/infrastructure/postgres/{catalog,mod}.rs`, `crates/chilla-core/src/application/test_support/connection.rs`, `crates/chilla-core/tests/catalog.rs`, `src-tauri/src/{commands,lib}.rs`, `src/shared/api/{types,commands}.ts`
- Create: `src/features/query/{typesStore,typesStore.test}.ts`

**Interfaces:**
- Consumes: Task 2의 `Column`
- Produces:
  ```rust
  pub struct TypeInfo { pub oid: u32, pub modifier: i32, pub name: String, /// pg_type.typcategory
      pub category: char }
  // DbConnection
  fn describe_types(&self, types: &[(u32, i32)]) -> impl Future<Output = Result<Vec<TypeInfo>, QueryError>> + Send;
  // App
  pub async fn describe_types(&self, connection: &str, types: Vec<(u32, i32)>) -> Result<Vec<TypeInfo>, AppError>;
  ```
  command `describe_types(connection: String, types: Vec<TypeKeyDto>)`, `TypeKeyDto { oid: u32, modifier: i32 }`.
  ```ts
  export interface TypeInfo { oid: number; modifier: number; name: string; category: string }
  export function describeTypes(connection: string, types: { oid: number; modifier: number }[]): Promise<TypeInfo[]>;
  // typesStore
  export function typeKey(oid: number, modifier: number): string; // "23:-1"
  interface TypesState {
    /** connection → typeKey → TypeInfo */
    types: Record<string, Record<string, TypeInfo>>;
    /** cache에 없고 묻는 중이 아닌 것만 묻는다. 실패는 무시한다(다음 결과가 다시 묻는다). */
    ensure(connection: string, columns: readonly ResultColumn[]): Promise<void>;
    forget(connection: string): void;
    reset(): void;
  }
  export function useColumnType(connection: string | null, column: ResultColumn): TypeInfo | undefined;
  ```

- [x] **Step 1: test를 쓴다**

- `tests/catalog.rs`: `describe_types_formats_with_typmod`(위 "먼저 확인한 것"의 다섯 쌍이 그 이름과 category), `describe_types_skips_unknown_oids`(`(0,-1)`과 없는 OID는 결과에 없음), `describe_types_of_a_domain_and_enum`(test에서 만든 `CREATE TYPE mood AS ENUM`, `CREATE DOMAIN`의 이름이 schema 경로대로).
- `app.rs`의 test: `describe_types_uses_the_catalog_connection`(같은 접속의 `load_catalog`와 연결 하나).
- `typesStore.test.ts`: `asks_only_unknown_types`, `does_not_ask_twice_while_pending`, `failure_is_ignored`, `forget_drops_the_connection`.

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test -p chilla-core describe_types` 와 `pnpm vitest run src/features/query/typesStore.test.ts`
Expected: FAIL

- [x] **Step 3: 구현한다**

- SQL: `SELECT m.oid, m.typmod, format_type(m.oid, m.typmod), t.typcategory FROM unnest($1::oid[], $2::int4[]) AS m(oid, typmod) JOIN pg_type t ON t.oid = m.oid`. `App::describe_types`는 `read_catalog_with`를 쓴다(끊기면 한 번 다시 연결).
- 화면은 `runsStore`가 `columns` event를 받을 때 그 탭의 접속으로 `useTypes.getState().ensure`를 부른다. `useSchema`의 `forget`/`refresh`와 `switchProject`가 `useTypes`의 `forget`/`reset`도 부른다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add crates src-tauri src
git commit -m "feat: catalog connection이 결과 컬럼의 type 이름과 category를 답함"
```

---

### Task 4: 접속의 read_only, statement_timeout, server version (Rust)

**Files:**
- Modify: `crates/chilla-core/src/domain/connection.rs`, `crates/chilla-core/src/infrastructure/project_file.rs`, `crates/chilla-core/src/infrastructure/postgres/mod.rs`, `crates/chilla-core/src/application/{ports,app}.rs`, `crates/chilla-core/Cargo.toml`, `crates/chilla-core/tests/{project_file,connect,sessions}.rs`, `src-tauri/src/commands.rs`, `src/shared/api/{types,commands}.ts`

**Interfaces:**
- Produces:
  ```rust
  // ConnectionProfile
  pub read_only: bool,
  pub statement_timeout: Option<Duration>,
  pub const MAX_STATEMENT_TIMEOUT_SECS: u64 = 86_400;
  /// same_target이고 read_only와 statement_timeout도 같다. 다르면 세션을 새로 열어야 한다.
  pub fn same_session(&self, other: &ConnectionProfile) -> bool;
  // ProfileError
  StatementTimeoutRange { secs: u64 }   // "statement_timeout must be 1 to 86400 seconds, not {secs}"
  // DbConnection
  /// 연결할 때 받은 server_version의 첫 단어("18.6").
  fn server_version(&self) -> &str;
  // App
  pub async fn test_connection(&self, profile, password) -> Result<ServerInfo, AppError>;
  pub struct ServerInfo { pub version: String }
  ```
  TS `Connection`에 `readOnly: boolean`, `statementTimeout: number | null`(초). `testConnection`이 `Promise<{ version: string }>`.

- [x] **Step 1: test를 쓴다**

- `connection.rs`: `statement_timeout_range`(0과 86401 거절), `same_session_compares_read_only_and_timeout`, `same_target_ignores_session_settings`(비밀번호를 지우지 않는다).
- `tests/project_file.rs`: `reads_read_only_and_statement_timeout`, `writes_them_only_when_set`(false와 없음은 key를 쓰지 않음), `rejects_a_string_statement_timeout`(`"30s"`는 `InvalidConnection`).
- `tests/sessions.rs`: `read_only_session_rejects_writes`(`CREATE TEMP TABLE`이 SQLSTATE `25006`), `statement_timeout_cancels_long_queries`(1초, `pg_sleep(2)`가 `57014`), `session_time_zone_is_the_mac_zone`(`SHOW TimeZone`이 `iana_time_zone::get_timezone()`과 같음).
- `tests/connect.rs`: `test_connection_returns_the_server_version`(`"18."`으로 시작).

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test -p chilla-core`
Expected: FAIL

- [x] **Step 3: 구현한다**

- `start`에서 `config.options(…)`: `-c default_transaction_read_only=on`(read_only), `-c statement_timeout={ms}`, `-c TimeZone={zone}`. zone은 `PgConnector::new`에서 `iana_time_zone::get_timezone()`으로 한 번 얻고, 실패하거나 공백·작은따옴표가 든 이름이면 넣지 않는다.
- `server_version`: 연결 직후 `backend_pid`와 같은 simple query에서 `SELECT pg_backend_pid(), current_setting('server_version')`으로 함께 읽는다(round trip을 늘리지 않는다).
- `project_file.rs`는 `tunnel_timeout`과 같은 방식으로 읽고 쓴다.
- 화면 쪽 `Connection` type과 `toConnection` 기본값만 맞춘다(form은 Task 16).

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add crates src-tauri src
git commit -m "feat: 접속의 read_only와 statement_timeout을 세션 시작 option으로 보내고 server version을 돌려줌"
```

---

### Task 5: 전역 설정 파일 (Rust)

**Files:**
- Create: `crates/chilla-core/src/domain/settings.rs`, `crates/chilla-core/src/infrastructure/settings_file.rs`, `crates/chilla-core/tests/settings_file.rs`
- Modify: `crates/chilla-core/src/domain/mod.rs`, `crates/chilla-core/src/infrastructure/mod.rs`, `crates/chilla-core/src/application/app.rs`, `src-tauri/src/{lib,commands,menu}.rs`, `src/shared/api/{types,commands}.ts`

**Interfaces:**
- Produces:
  ```rust
  pub enum Language { En, Ko }
  pub struct EditorSettings { pub font: String, pub font_size: u16 }
  pub struct Settings { pub language: Language, pub editor: EditorSettings, pub limits: QueryLimits }
  impl Default for Settings  // en, "D2Coding", 15, QueryLimits::default()
  #[derive(thiserror::Error)] #[error("{path}: {message}")]
  pub struct SettingsError { pub path: String, pub message: String }
  // infrastructure
  /// 파일이 없으면 기본값. 틀리면 기본값과 그 이유.
  pub fn load_settings(path: &Path) -> (Settings, Option<SettingsError>);
  pub fn settings_path() -> Option<PathBuf>; // $HOME/.config/chilla/config.toml
  // App::new가 limits: QueryLimits를 더 받는다. open_session과 catalog가 그 값을 쓴다.
  ```
  command `load_settings() -> SettingsDto { language: "en" | "ko", editor: { font, fontSize }, idleTimeoutSecs, error: string | null }`. Tauri state로 setup에서 읽은 값을 둔다.

- [x] **Step 1: test를 쓴다**

`tests/settings_file.rs`(임시 디렉토리):
- `missing_file_is_default`.
- `reads_every_key`(위 TOML 예시의 값을 바꿔 쓴 파일).
- `partial_file_keeps_other_defaults`(`[editor] font_size = 13`만).
- `unknown_key_is_an_error`(`[editor] fontsize = 14` → 기본값과 `fontsize`가 든 message).
- `out_of_range_is_an_error`(`font_size = 9`, `retained_rows = 999`, `idle_timeout = 59`, `language = "ja"` 각각).
- `app.rs` test: `sessions_use_the_given_limits`(retained_rows 1000으로 만든 App의 세션이 `retained_from(1500) == 500`).
- `menu.rs` test: `labels_follow_the_language`(ko의 Quit label이 `ChillaSQL 종료`).

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --workspace settings`
Expected: FAIL

- [x] **Step 3: 구현한다**

- serde struct에 `#[serde(deny_unknown_fields)]`, 범위는 읽은 뒤 검사한다. `QueryLimits`의 `batch_rows`, `batch_bytes`는 설정하지 않는다.
- `lib.rs`의 setup이 `load_settings`를 부르고 `Settings`를 `app.manage`, `limits`를 `CoreApp::new`에 넘긴다. menu는 `.menu(…)`의 closure가 managed settings의 언어를 읽어야 하므로 `Builder::menu` 대신 setup 안에서 `app.set_menu(menu::build(handle, language)?)`로 만든다.
- `menu::build(handle, language)`: 직접 만드는 항목(Quit, submenu 제목 `Edit`/`편집`, `View`/`보기`, `Window`/`윈도우`)의 label을 언어로 고른다. Predefined 항목은 macOS가 그리는 기본 label을 둔다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add crates src-tauri src
git commit -m "feat: 전역 설정 파일을 읽어 결과 한도, 언어, 에디터 글꼴을 정함"
```

---

### Task 6: 앱 내부 저장소 (Rust)

**Files:**
- Create: `crates/chilla-core/src/infrastructure/sqlite_store.rs`, `crates/chilla-core/tests/app_store.rs`
- Modify: `crates/chilla-core/Cargo.toml`, `crates/chilla-core/tests/layer_deps.rs`, `crates/chilla-core/src/application/{ports,app}.rs`, `crates/chilla-core/src/application/test_support/mod.rs`, `src-tauri/src/{lib,commands,error}.rs`, `src/shared/api/{types,commands}.ts`

**Interfaces:**
- Produces:
  ```rust
  pub struct RecentProject { pub dir: PathBuf, pub name: String, /// Unix 초
      pub opened_at: i64 }
  pub trait AppStore: Send + Sync {
      /// 최근 것부터 최대 10개.
      fn recent_projects(&self) -> Result<Vec<RecentProject>, StoreError>;
      /// 있으면 시각을 바꾸고, 10개를 넘으면 오래된 것을 지운다.
      fn record_project(&self, project: &RecentProject) -> Result<(), StoreError>;
      fn load_workspace(&self, dir: &Path) -> Result<Option<String>, StoreError>;
      fn save_workspace(&self, dir: &Path, snapshot: &str, saved_at: i64) -> Result<(), StoreError>;
  }
  #[error("Could not use the app database: {message}")]
  pub struct StoreError { pub message: String }
  pub struct SqliteAppStore; impl SqliteAppStore { pub fn open(path: &Path) -> Result<Self, StoreError>; }
  // App: new가 store: Option<Arc<dyn AppStore>>를 받는다(열지 못했으면 None).
  pub async fn recent_projects(&self) -> Result<Vec<RecentProject>, AppError>;
  pub async fn load_workspace(&self) -> Result<Option<String>, AppError>;      // 열린 프로젝트의 것
  pub async fn save_workspace(&self, snapshot: String) -> Result<(), AppError>;
  // AppError::Store(StoreError) → kind "store_failed", None이면 AppError::StoreUnavailable → "store_unavailable"
  ```
  commands `recent_projects`, `load_workspace`, `save_workspace`. `load_settings`의 DTO에 `storeError: string | null`(열지 못한 이유)을 더한다.

- [x] **Step 1: test를 쓴다**

`tests/app_store.rs`(임시 파일):
- `records_and_lists_recent_projects_newest_first`, `keeps_only_ten`, `recording_again_moves_it_to_the_top`.
- `workspace_round_trips_by_dir`, `workspace_of_another_dir_is_none`.
- `reopening_keeps_the_data`, `a_corrupt_file_is_an_error`(아무 byte나 쓴 파일).
- `app.rs` test: `opening_a_project_records_it`(`open_project`, `create_project` 둘 다), `a_failed_open_does_not_record_it`, `save_workspace_needs_a_project`.
- `layer_deps.rs`의 금지 목록에 `rusqlite`.

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --workspace app_store opening_a_project_records_it`
Expected: FAIL

- [x] **Step 3: 구현한다**

- `rusqlite`(`bundled`)는 `Mutex<Connection>`로 갖는다. 호출이 blocking이므로 App은 키체인처럼 `blocking(…)`으로 부른다. 열 때 `PRAGMA user_version`이 0이면 table을 만들고 1로, 1이면 그대로, 그 밖이면 오류다.
- 기록 실패는 프로젝트 열기를 실패시키지 않는다(열기는 성공, 기록만 빠진다).
- `lib.rs`: `app.path().app_data_dir()`에 디렉토리를 만들고 `chilla.sqlite3`를 연다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add crates src-tauri src
git commit -m "feat: SQLite 앱 저장소에 최근 프로젝트와 프로젝트별 탭 snapshot을 둠"
```

---

### Task 7: 끝까지 읽는 실행(`drain`) (Rust)

**Files:**
- Modify: `crates/chilla-core/src/application/session_actor/{mod,query,tests}.rs`, `crates/chilla-core/src/application/app.rs`, `crates/chilla-core/tests/queries.rs`, `src-tauri/src/commands.rs`, `src/shared/api/commands.ts`

**Interfaces:**
- Produces: `App::execute(session, sql, mode, drain: bool, sink)`. `drain`이면 `Columns`와 첫 batch 하나만 보내고 나머지 행은 읽어서 버린 뒤 `Finished { Completed { rows } }`. 그 쿼리에 `fetch_more`는 `Ok`이고 아무것도 하지 않는다. idle timeout을 걸지 않는다. Cancel과 다음 실행에 밀리는 것은 지금과 같다. command `execute_query(…, drain: bool)`, TS `executeQuery(sessionId, sql, mode, onEvent, options?: { drain?: boolean })`.

- [x] **Step 1: test를 쓴다**

- actor test(fake): `drain_sends_one_batch_and_completes`(1200행 → `Rows` 하나(500행), `Completed { rows: 1200 }`), `drain_does_not_expire`(시간을 idle timeout 너머로 보내도 `Expired`가 아님), `drain_can_be_cancelled`.
- `tests/queries.rs`(test DB): `a_drained_statement_keeps_its_changes`(임시 테이블에 1000행을 넣고 `UPDATE t SET v = v + 1 RETURNING *`를 `drain`으로 실행 → batch 500행, `Completed { rows: 1000 }`, 다음 쿼리에서 1000행 모두 바뀌어 있음. Manual 모드에서도 같음).

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test -p chilla-core drain`
Expected: FAIL

- [x] **Step 3: 구현한다**

`Pending`에 `drain: bool`을 더하고, 첫 batch를 보낸 뒤 `drain`이면 `Paused`로 가지 않고 행을 버리며 읽는다. 버린 행의 byte는 batch 한도에 세지 않는다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add crates src-tauri src
git commit -m "feat: 여러 문장 실행을 위해 결과를 끝까지 읽고 첫 batch만 보내는 drain 실행을 더함"
```

---

### Task 8: 오류의 params (Rust)

**Files:**
- Create: `src/shared/i18n/errorKinds.json`
- Modify: `src-tauri/src/error.rs`, `src/shared/api/errors.ts`

**Interfaces:**
- Produces: `CommandError { kind, message, params: BTreeMap<&'static str, String>, output }`(`params`가 비면 보내지 않음). param 이름은 Rust message의 빈칸 이름이다: `path`, `name`, `connection`, `message`, `count`, `bytes`, `secs`, `code`, `id`, `query`. `errorKinds.json`은 `{ "<kind>": ["param", …] }`. TS `CommandError`에 `readonly params: Record<string, string>`.

- [x] **Step 1: test를 쓴다**

- `error.rs`: `kinds_and_params_match_the_screen`(`all_errors()`가 만드는 `(kind, params의 key 집합)`이 `../src/shared/i18n/errorKinds.json`과 같음 — 같은 kind인데 variant마다 param이 다르면 합집합), `params_hold_the_variable_parts`(`ProjectError::NotFound`의 `path`, `ConnectError::Database`의 `code`와 `message`).
- `errors.test.ts`: `params_are_read_from_the_payload`.

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test -p chilla error` 와 `pnpm vitest run src/shared/api`
Expected: FAIL

- [x] **Step 3: 구현한다**

`From<AppError>`에서 kind를 고르는 match 옆에서 params를 채운다. kind 하나가 여러 variant를 묶으면(`project_invalid`, `invalid_connection`) 서버·파일 message를 `message` param 하나로 넘긴다. 화면이 쓰는 것은 Task 9다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add src-tauri src
git commit -m "feat: Rust 오류에 화면이 번역할 params를 붙임"
```

---

### Task 9: 설정 store, 한국어 dictionary, 오류 번역

**Files:**
- Create: `src/features/settings/{settingsStore,settingsStore.test}.ts`, `src/shared/i18n/ko.ts`, `src/shared/i18n/ko.test.ts`
- Modify: `src/shared/i18n/{en,t,t.test}.ts`, `src/shared/api/errors.ts`, `src/App.tsx`, `src/App.test.tsx`, `src/test/{resetStores,sourceRules.test}.ts`

**Interfaces:**
- Consumes: Task 5의 `loadSettings`, Task 8의 `CommandError.params`, `errorKinds.json`
- Produces:
  ```ts
  export type Language = "en" | "ko";
  export function setLanguage(language: Language): void; // t, tc가 그 dictionary를 쓴다
  export const ko: Record<MessageKey, string>;
  interface SettingsState {
    status: "loading" | "ready";
    language: Language;
    editor: { font: string; fontSize: number };
    idleTimeoutSecs: number;
    /** 설정 파일이나 앱 저장소의 오류. 첫 화면이 한 번 보이고 지운다. */
    errors: string[];
    load(): Promise<void>;
    dismissErrors(): void;
  }
  ```
  `messageOf(error)`: `CommandError`이고 `error.<kind>` key가 있으면 `t(key, params)`, 아니면 지금처럼 `error.message`.
- 문구(`en.ts`): `error.<kind>`마다 지금 Rust message(빈칸은 `{param}`), `settings.errorTitle` "Settings were not applied", `settings.storeErrorTitle` "Recent projects and unsaved tabs are not kept".

- [x] **Step 1: test를 쓴다**

- `t.test.ts`: `t_uses_the_selected_language`, `plurals_follow_the_language`.
- `ko.test.ts`: `every_error_kind_has_a_message`(`errorKinds.json`의 kind마다 en과 ko에 `error.<kind>`가 있고, 그 문구의 `{…}`가 param 이름과 같음), `placeholders_match_en`(모든 key에서 ko와 en의 `{…}` 집합이 같음).
- `errors.test.ts`: `message_of_a_command_error_is_translated`(ko에서 `project_not_found`가 한국어 문구와 path), `unknown_kind_keeps_the_rust_message`.
- `settingsStore.test.ts`: `load_sets_the_language`, `settings_error_is_shown_once`(`errors`에 들어가고 `dismissErrors` 뒤 비어 있음).
- `App.test.tsx`: `waits_for_settings_before_the_project`, `shows_settings_errors_in_a_dialog`.
- `sourceRules.test.ts`: `ko.ts`는 한글 문구 검사에서 뺀다(dictionary다).

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/shared src/features/settings src/App.test.tsx`
Expected: FAIL

- [x] **Step 3: 구현한다**

- `App`이 `useSettings.load()`를 기다린 뒤 `setLanguage`하고 `ProjectGate`를 그린다. `errors`가 있으면 `ask`(DialogHost)로 제목과 이유를 보이고 OK에서 `dismissErrors`.
- `ko.ts`는 `en.ts`의 모든 key를 "이 계획에서 정한 것"의 `ko` 문구 규칙으로 옮긴다. 복수형 key는 같은 문구를 둔다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add src
git commit -m "feat: 한국어 dictionary와 언어 설정, Rust 오류를 kind별로 번역함"
```

---

### Task 10: Reformat

**Files:**
- Create: `src/features/editor/{reformat,reformat.test}.ts`
- Modify: `src/features/workspace/{commands,shortcuts,shortcuts.test,Toolbar,Toolbar.test}.ts(x)`, `src/features/query/ResultPane.tsx`(`Hints`), `src/shared/ui/icons.tsx`, `src/shared/i18n/{en,ko}.ts`

**Interfaces:**
- Produces:
  ```ts
  /** 선택 영역이 있으면 그것만, 없으면 문서 전체. 바꾸지 못하면 그 이유. */
  export function reformatDocument(tabId: string): { ok: true } | { ok: false; reason: string };
  ```
  `CommandId`에 `"reformat"`(`Opt+Cmd+L`, `KeyL` + `altKey` + `metaKey`). toolbar의 Reformat icon 버튼은 Auto/Manual 오른쪽 빈 공간 뒤, 실행 버튼 앞 구분선 앞에 둔다(Main).
- 문구: `toolbar.reformat` "Reformat (Opt+Cmd+L)", `result.hintReformat` "Reformat", `toast.reformatFailed` "Couldn't reformat: {reason}".

- [ ] **Step 1: test를 쓴다**

- `reformat.test.ts`: `formats_the_whole_document`, `formats_only_the_selection`(앞뒤 text는 그대로, 선택 영역이 새 text를 감쌈), `one_undo_restores_the_text`, `failure_leaves_the_document`(`SELECT 'unclosed` → `ok: false`, 문서 그대로), `keeps_casts_and_dollar_bodies`(Task 1에서 확인한 입력: `::date`, `$$ … ; … $$`, `->>`, `@>`, `"Order Items"`, 한글 식별자와 주석), `rejects_unclosed_block_comment`(`SELECT 1 /* abc` → `ok: false`, 문서 그대로. `sql-formatter`는 이것을 throw하지 않고 `/ * abc`로 바꾸기 때문이다).
- `shortcuts.test.ts`: `opt_cmd_l_is_reformat`(한글 입력기 상태의 `key`여도 `code`로).
- `Toolbar.test.tsx`: `reformat_button_runs_the_command`. ResultPane의 `Hints`: `hints_include_reformat`.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/editor/reformat.test.ts src/features/workspace`
Expected: FAIL

- [ ] **Step 3: 구현한다**

`documentState(tabId)`에 transaction 하나(`changes` + 새 selection)를 적용해 `setDocumentState`, 보이는 탭이면 view에도 같은 transaction을 보낸다(문서 변경 경로는 `SqlEditor`가 쓰는 것과 같게 해서 dirty와 자동 보관이 따라오게 한다). 닫히지 않은 `/*`는 `sql-formatter`를 부르기 전에 알아보고 `ok: false`로 돌려준다(reason은 `unclosed block comment`). 실패는 `Toast`로 보인다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src package.json pnpm-lock.yaml
git commit -m "feat: Opt+Cmd+L과 toolbar 버튼으로 선택 영역이나 문서를 Reformat함"
```

---

### Task 11: span cache와 실행될 범위 강조

**Files:**
- Create: `src/features/editor/{statementSpans,statementSpans.test}.ts`
- Modify: `src/features/editor/{statementAt,statementAt.test,extensions}.ts`, `src/features/workspace/commands.ts`

**Interfaces:**
- Produces:
  ```ts
  interface TextLike { length: number; sliceString(from: number, to?: number): string }
  export function statementAt(text: TextLike, spans: StatementSpan[], cursor: number): StatementSpan | null;
  /** 지금 문서에 맞으면 fresh. 편집 뒤 다시 나누기 전에는 옮긴 span이고 fresh가 false. 나눌 수 없으면 spans가 null. */
  export const statementSpansField: StateField<{ spans: StatementSpan[] | null; fresh: boolean }>;
  /** 마지막 문서 변경 150ms 뒤 splitStatements를 부르고, 그 사이 문서가 바뀌지 않았으면 넣는다. 문서를 처음 열 때도 부른다. */
  export const statementSpansPlugin: ViewPlugin;
  /** 선택 영역이 없을 때 커서 문장이 걸친 줄의 Decoration.line(class `cm-runRange`). */
  export const runRangeHighlight: Extension;
  ```
  `statementToRun`은 `statementSpansField`가 fresh면 그 span을 쓰고, 아니면 지금처럼 `splitStatements`를 부른다.

- [ ] **Step 1: test를 쓴다**

- `statementAt.test.ts`: 기존 test를 `Text.of(…)`로 돌린다.
- `statementSpans.test.ts`(EditorView, fake timer, `splitStatements` mock):
  - `splits_after_typing_stops`(입력 셋을 50ms 간격으로 → 마지막 뒤 150ms에 한 번).
  - `cursor_moves_do_not_split`(문서를 바꾸지 않고 selection을 100번 바꿔도 처음 한 번뿐).
  - `late_result_for_an_old_document_is_ignored`.
  - `spans_follow_edits_until_resplit`(문장 앞에 줄을 넣으면 옮긴 span, `fresh: false`).
  - `highlights_the_lines_of_the_cursor_statement`(두 줄 문장 → 두 줄에 `cm-runRange`), `no_highlight_with_a_selection`, `no_highlight_when_split_failed`.
- `commands.test.ts`: `run_uses_fresh_spans_without_splitting`.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/editor src/features/workspace/commands.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현한다**

`cm-runRange`: `background: color-mix(in srgb, var(--color-accent) 7%, transparent)`, `box-shadow: inset 2px 0 0 var(--color-accent)`(Main의 현재 문장). `editorExtensions()`에 field, plugin, highlight를 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: 문장 span을 문서에 두고 커서 문장의 줄을 배경과 왼쪽 선으로 강조함"
```

---

### Task 12: 오류 밑줄과 Go to error

**Files:**
- Create: `src/features/editor/{runMarks,runMarks.test}.ts`
- Modify: `src/features/query/{runReducer,runsStore,ResultPane,ResultPane.test,format}.ts(x)`, `src/features/workspace/commands.ts`, `src/features/editor/extensions.ts`, `src/shared/i18n/{en,ko}.ts`

**Interfaces:**
- Produces:
  ```ts
  /** 실행한 문장의 시작을 문서 offset으로 두고 변경을 따라 옮긴다. runKey는 runsStore의 실행 하나(여러 문장이면 문장마다). */
  export const setRunAnchor: StateEffectType<{ runKey: string; from: number }>;
  export const setErrorMark: StateEffectType<{ from: number; to: number } | null>;
  export const runMarksField: StateField<{ anchors: Record<string, number>; error: { from: number; to: number } | null }>;
  /** 그 실행의 지금 문서 offset. 문서가 그 자리를 지웠으면 null. */
  export function anchorOf(tabId: string, runKey: string): number | null;
  /** 오류 위치(보낸 text의 UTF-16 offset)의 밑줄 범위: 그 자리의 단어 끝까지, 단어가 아니면 한 글자. */
  export function errorRange(doc: Text, at: number): { from: number; to: number };
  export function goToError(tabId: string): void;
  ```
  `RunRequest`, `ResultData`에 `runKey: string`과 문서 offset `from: number`를 더한다(`origin`의 Ln/Col은 표시할 때 `anchorOf`로 다시 계산한다). 문구: `result.goToError` "Go to error".

- [ ] **Step 1: test를 쓴다**

`runMarks.test.ts`:
- `anchor_moves_with_edits_before_it`, `anchor_is_null_when_its_text_is_deleted`.
- `underline_covers_the_word`(`SELECT 1;\nSELEC 2`의 position → `SELEC`에 `cm-errorMark`).
- `underline_after_hangul_and_emoji`(`SELECT '한글😀', x FROM`의 서버 position이 가리키는 `FROM` 다음 자리 — Rust가 보낸 UTF-16 offset 그대로 맞음).
- `editing_inside_the_mark_clears_it`, `next_run_clears_it`.
`ResultPane.test.tsx`:
- `go_to_error_moves_the_cursor`(누르면 selection이 오류 자리, 에디터 focus).
- `error_location_follows_edits`(위에 줄을 넣으면 `Ln 3`).
`commands.test.ts`: `run_again_uses_the_moved_position`.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/editor/runMarks.test.ts src/features/query src/features/workspace/commands.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현한다**

- `runsStore.run`이 실행을 시작할 때 `setRunAnchor`를 그 탭 문서에 넣고(보이는 탭이면 view로) 이전 `setErrorMark(null)`. `finished`가 `failed`이고 `position`이 있으면 `anchorOf + position`(`ServerError.position`은 보낸 text의 0-based UTF-16 offset)에서 `errorRange`로 `setErrorMark`.
- `cm-errorMark`: `text-decoration: underline wavy var(--color-danger)`, `text-underline-offset: 4px`(States).
- 오류 화면의 버튼 순서는 States대로 Go to error, Copy message.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: 서버 오류 위치에 밑줄을 긋고 Go to error로 그 자리로 감"
```

---

### Task 13: 여러 문장 실행과 결과 탭

**Files:**
- Modify: `src/features/query/{runsStore,runsStore.test,ResultPane,ResultPane.test,gridViews}.ts(x)`, `src/features/workspace/{commands,commands.test,dangerPrompt,Toolbar,Toolbar.test}.ts(x)`, `src/shared/i18n/{en,ko}.ts`

**Interfaces:**
- Consumes: Task 7의 `executeQuery(…, { drain })`, Task 12의 `runKey`, `setRunAnchor`
- Produces:
  ```ts
  export interface ScriptStep { sql: string; from: number; origin: Origin }
  export interface RunRequest { connection: string; steps: ScriptStep[] }  // 문장 하나면 steps 길이 1
  export interface ScriptRun {
    steps: ScriptStep[];
    /** 끝난 앞 문장의 고정된 결과. index는 문장 번호 - 1 */
    done: RunState[];
    /** runs[tabId]가 보이는 문장 */
    current: number;
    /** 결과 탭에서 고른 문장 */
    selected: number;
    /** 멈췄으면 그 문장. 끝까지 갔으면 null */
    stoppedAt: number | null;
  }
  // RunsState
  scripts: Record<string, ScriptRun>;      // 문장이 둘 이상인 실행만
  selectStep(tabId: string, index: number): void;
  // run(tabId, prepare, confirmStep?: (step: ScriptStep) => Promise<boolean>)
  ```
  `CommandId`에 `"runFile"`. toolbar menu의 Run file을 켠다. 문구: `result.notRun` "Not run", `result.errorTab` "Error", `result.stoppedAt` "Stopped at statement {n}.", `result.notRunRest.one` "Statement {first} was not run.", `result.notRunRest.other` "Statements {first}–{last} were not run.".

- [ ] **Step 1: test를 쓴다**

`runsStore.test.ts`:
- `runs_steps_in_order_on_one_session`(`openSession` 한 번, `executeQuery`가 차례로, 마지막만 `drain: false`).
- `stops_at_the_first_failure`(2번이 `failed` → 3번을 보내지 않고 `stoppedAt: 1`).
- `cancel_stops_the_script`.
- `a_cancelled_confirmation_stops_before_that_step`(`confirmStep`이 false인 문장과 그 뒤는 보내지 않음).
- `each_step_counts_toward_the_transaction`(Manual, 세 문장 성공 → `statements: 3`).
- `last_step_can_fetch_more`, `earlier_steps_are_frozen`(`fetchMore`가 앞 문장에 보내지 않음).
- `a_new_run_replaces_the_script`.
`commands.test.ts`:
- `selection_with_two_statements_runs_a_script`, `run_file_runs_every_statement`, `run_file_on_an_empty_document_is_rejected`.
- `danger_is_confirmed_when_its_step_comes`.
`ResultPane.test.tsx`(States "여러 문장"):
- `script_shows_result_tabs`(`1 SELECT users`, `2 UPDATE 12`, `3 Error`, `4 Not run`(disabled)), `stopped_message_names_the_rest`, `choosing_a_tab_shows_its_result`, `single_statement_has_no_tabs`.
`Toolbar.test.tsx`: `run_file_is_enabled`.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/query src/features/workspace`
Expected: FAIL

- [ ] **Step 3: 구현한다**

- `runsStore`: `runs[tabId]`는 지금 문장의 `RunState`로 두어 fetch, cancel, 트랜잭션 계산을 그대로 쓴다. 문장이 `completed`로 끝나면 그 `RunState`를 `done`에 옮기고 같은 token과 세션으로 다음 문장을 보낸다. token이 바뀌면(새 실행, release) 다음 문장을 보내지 않는다.
- `commands.ts`: 선택 영역은 `splitStatements`로 나눠 둘 이상이면 step 여러 개(나눌 수 없으면 지금처럼 그대로 하나). `runFile`은 문서 전체를 나눈 span 전부. 위험 확인은 `confirmStep`으로 넘긴다(`confirmDanger`를 step마다).
- `gridViews`의 key에 문장 번호를 넣어 탭마다 컬럼 너비를 따로 둔다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: 파일 전체와 여러 문장 선택을 차례로 실행하고 문장마다 결과 탭을 보여 줌"
```

---

### Task 14: 결과의 type 표시, timeout과 read-only 오류 화면

**Files:**
- Create: `src/features/query/{cellDisplay,cellDisplay.test}.ts`
- Modify: `src/features/query/{ResultGrid,ResultGrid.test,ResultPane,ResultPane.test,grid}.ts(x)`, `src/shared/i18n/{en,ko}.ts`

**Interfaces:**
- Consumes: Task 3의 `useColumnType`, Task 4의 `Connection.readOnly`, `statementTimeout`
- Produces:
  ```ts
  export type ValueKind = "number" | "json" | "vector" | "text";
  export function valueKind(type: TypeInfo | undefined): ValueKind;
  /** 표의 한 줄 표시. dim은 fg-3로 그릴 꼬리(`1536 values`). */
  export function cellText(value: Cell, kind: ValueKind): { text: string; dim: string | null };
  ```
  문구: `result.timedOut` "Timed out", `result.timeoutDetail` "This connection's statement_timeout is {secs}s.", `result.readOnlyDetail` "{connection} is a read-only connection, so the database rejected the write. Nothing changed.", `result.vectorValues` "{count} values".

- [ ] **Step 1: test를 쓴다**

`cellDisplay.test.ts`:
- `numeric_category_is_a_number`, `json_and_jsonb_are_json`, `vector_and_halfvec_are_vectors`(`vector(1536)`), `unknown_type_is_text`.
- `json_collapses_nested_values`(`{"plan":"pro","billing":{"cycle":"yearly"},"tags":["a"]}` → `{"plan": "pro", "billing": {…}, "tags": […]}`), `json_scalar_and_invalid_stay`(`"x"`, `{bad`).
- `vector_shows_three_values_and_the_count`(`[0.0213,-0.114,0.0871,0.5]` → `[0.0213, -0.114, 0.0871, …`와 dim `4 values`), `short_vector_stays`.
- `null_and_empty_string_are_unchanged`.
`ResultGrid.test.tsx`: `header_shows_the_type`, `numbers_are_right_aligned`, `header_width_counts_the_type`.
`ResultPane.test.tsx`:
- `timeout_shows_the_timed_out_panel`(접속 `statementTimeout: 30`, `failed` `57014` → `Timed out`과 `statement_timeout is 30s`), `57014_without_a_timeout_is_a_plain_error`.
- `read_only_rejection_explains_it`(read-only 접속, `25006`).

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/query`
Expected: FAIL

- [ ] **Step 3: 구현한다**

Tools M8의 모양: header `gap-1.5`, 이름 13px semibold, type mono 12px fg-3. number는 `justify-end`와 에디터의 숫자 syntax token 색. M4의 300자 자르기는 `cellText` 다음에 한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: 결과 header에 type을 보이고 숫자, JSON, vector를 type에 맞게 그리며 timeout과 read-only 거절을 설명함"
```

---

### Task 15: 값 보기 panel

**Files:**
- Create: `src/features/query/{ValueViewer,ValueViewer.test}.tsx`
- Modify: `src/features/query/{ResultPane,ResultGrid}.tsx`, `src/shared/i18n/{en,ko}.ts`, `src/index.css`(필요하면 syntax token)

**Interfaces:**
- Consumes: Task 14의 `valueKind`, M4 결과 표의 셀 선택
- Produces:
  ```ts
  export function ValueViewer(props: {
    column: ResultColumn; type: TypeInfo | undefined; row: number; value: Cell;
    onClose(): void;
  }): JSX.Element;
  /** json이면 2칸 들여쓴 JSON의 token. 아니면 null. */
  export function jsonTokens(value: string): { text: string; kind: "key" | "string" | "number" | "literal" | "punct" }[] | null;
  ```
  결과 표가 focus를 가진 채 셀이 골라져 있을 때 `Shift+Enter`가 열고 닫는다(전역 단축키가 아니다). 문구: `viewer.label` "Value viewer", `viewer.copy` "Copy value", `viewer.close` "Close value viewer", `viewer.meta` "{type} · row {row}", `toast.copiedValue` "Copied value".

- [ ] **Step 1: test를 쓴다**

`ValueViewer.test.tsx`:
- `shift_enter_opens_and_closes`, `escape_closes`, `follows_the_selected_cell`.
- `json_is_pretty_printed_and_colored`(Tools의 `profile` 값 → 들여쓴 줄, key span이 key token class).
- `text_wraps_and_null_is_marked`, `copy_copies_the_full_value`(300자를 넘는 값도 전체).
- `header_shows_name_type_and_row`(`profile`, `jsonb · row 1`).

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/query/ValueViewer.test.tsx`
Expected: FAIL

- [ ] **Step 3: 구현한다**

Tools M8: `aside` 340px, `border-l border-line`, `bg-bg-1`, 머리 줄 36px, Copy와 Close는 `IconButton`. 열린 상태는 `ResultPane`의 state다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: Shift+Enter로 고른 셀의 전체 값을 오른쪽 panel에 보임"
```

---

### Task 16: 접속 sheet와 read-only 표시

**Files:**
- Modify: `src/features/connections/{ConnectionForm,ConnectionForm.test,connectionValues,connectionValues.test}.ts(x)`, `src/features/project/{Sidebar,Sidebar.test}.tsx`, `src/features/workspace/{Toolbar,Toolbar.test,commands,commands.test,dangerPrompt,dangerPrompt.test,transactionPrompts}.ts(x)`, `src/shared/ui/icons.tsx`, `src/shared/i18n/{en,ko}.ts`

**Interfaces:**
- Consumes: Task 4의 `readOnly`, `statementTimeout`, `testConnection`의 `version`
- Produces:
  ```ts
  // FormValues
  readOnly: boolean;
  /** 초. 비우면 없음 */
  statementTimeout: string;
  /** targetChanged이거나 readOnly, statementTimeout이 다르면 true. 세션을 놓을지 정한다. */
  export function sessionChanged(connection: Connection, original: Connection): boolean;
  export function LockIcon(props: { size?: number }): JSX.Element; // aria-label "Read-only"
  ```
  `applySavedProject`, 저장 전 트랜잭션 확인(`saveTarget`)은 `targetChanged` 대신 `sessionChanged`를 쓴다. 비밀번호를 지운다는 안내는 `targetChanged` 그대로다. `confirmDanger`는 탭의 접속이 `readOnly`면 묻지 않고 true.
- 문구: `connectionForm.readOnlyHint` "Opens sessions read-only so the database rejects writes", `connectionForm.advancedKeys` "statement_timeout · tunnel_timeout · sslrootcert", `connectionForm.statementTimeoutHint` "Seconds. Empty means none", `connectionForm.statementTimeoutRange` "statement_timeout must be 1 to 86400 seconds", `connectionForm.connectedVersion` "Connected · PostgreSQL {version}", `common.readOnly` "Read-only".

- [ ] **Step 1: test를 쓴다**

- `connectionValues.test.ts`: `statement_timeout_is_parsed_and_checked`, `session_changed_includes_session_settings`, `target_changed_ignores_them`.
- `ConnectionForm.test.tsx`(ConnectionForm B): `read_only_switch_saves`, `advanced_is_collapsed_and_lists_its_keys`, `advanced_opens_when_a_value_is_set`, `test_success_shows_the_version`.
- `commands.test.ts`: `saving_a_read_only_change_releases_sessions_but_keeps_the_password`.
- `dangerPrompt.test.ts`: `read_only_connection_is_not_asked`.
- `Sidebar.test.tsx`, `Toolbar.test.tsx`: `read_only_connections_show_the_lock`(sidebar 목록, 접속 menu, toolbar chip).

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/connections src/features/project src/features/workspace`
Expected: FAIL

- [ ] **Step 3: 구현한다**

ConnectionForm B의 배치: `tunnel` 다음 group에 switch 줄(`read_only` mono 13 + 설명 13 fg-3, 오른쪽 switch), 그 아래 disclosure 버튼(chevron, `Advanced`, mono fg-3의 key 목록). 펼치면 `statement_timeout`, `tunnel_timeout`, `sslrootcert` 칸을 이 순서로 둔다(M5의 두 칸을 옮긴다). 자물쇠 icon은 Main/TabsConn의 12px path를 쓴다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: 접속 sheet에 read_only와 Advanced의 statement_timeout을 더하고 read-only 접속을 표시함"
```

---

### Task 17: 자동 보관과 복원

**Files:**
- Create: `src/features/workspace/{autosave,autosave.test}.ts`
- Modify: `src/features/editor/{tabsStore,tabsStore.test}.ts`, `src/features/workspace/{commands,commands.test,quit,quit.test,Workspace}.ts(x)`, `src/shared/i18n/{en,ko}.ts`

**Interfaces:**
- Consumes: Task 6의 `loadWorkspace`, `saveWorkspace`
- Produces:
  ```ts
  export interface TabSnapshot {
    title: string; path: string | null; stamp: string | null;
    connection: string | null; mode: TxMode;
    /** 저장하지 않은 변경이 있거나 파일이 없는 탭의 text. 아니면 null */
    text: string | null;
  }
  export interface WorkspaceSnapshot { version: 1; active: number | null; tabs: TabSnapshot[] }
  export function snapshotOf(state: TabsState): WorkspaceSnapshot;
  /** 탭을 되살린다. 읽지 못한 파일의 탭은 빼고 그 경로들을 돌려준다. */
  export function restore(snapshot: WorkspaceSnapshot): Promise<{ skipped: string[] }>;
  /** tabsStore와 문서 변경을 구독해 1초 뒤 저장한다. */
  export function startAutosave(): () => void;
  /** 기다리는 저장을 바로 한다. */
  export function flushAutosave(): Promise<void>;
  // TabsState
  restoreTabs(tabs: TabSnapshot[], active: number | null): void;
  ```
  문구: `autosave.skipped.one` "Couldn't reopen {path}", `autosave.skipped.other` "Couldn't reopen {count} files".

- [ ] **Step 1: test를 쓴다**

`autosave.test.ts`(fake timer):
- `saves_one_second_after_the_last_change`, `clean_file_tabs_store_no_text`, `untitled_and_dirty_tabs_store_text`.
- `restores_tabs_in_order_with_the_active_tab`, `clean_tabs_reread_the_file`, `missing_files_are_skipped_and_reported`.
- `restored_dirty_tab_keeps_its_stamp`(복원한 dirty 탭을 저장할 때 `writeSqlFile`의 mode가 보관한 stamp).
- `a_bad_or_unknown_snapshot_is_ignored`(`version: 2`, JSON이 아님).
`commands.test.ts`: `switching_projects_flushes_and_does_not_ask_about_unsaved_tabs`, `opening_a_project_restores_its_tabs`.
`quit.test.ts`: `flushes_before_quit`(`saveWorkspace`가 `quitApp`보다 먼저).

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/workspace src/features/editor/tabsStore.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현한다**

- 문서 변경은 `onDocChange`(이미 dirty를 표시하는 경로)에서 autosave에 알린다. 저장 실패는 무시한다(다음 변경이 다시 저장한다).
- `switchProject`의 `askProjectDir`에서 dirty 확인을 지운다. 순서: 트랜잭션 확인 → 폴더 고르기 → `flushAutosave` → `open` → reset → `restore`. `ProjectGate`가 처음 연 프로젝트도 `restore`한다.
- 새 탭 제목 번호는 복원한 탭의 `Untitled-{n}` 다음부터다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: 탭과 저장하지 않은 내용을 앱 저장소에 보관하고 프로젝트를 열 때 되살림"
```

---

### Task 18: 최근 프로젝트, Welcome, 프로젝트 menu, Cmd+O

**Files:**
- Create: `src/features/project/{ProjectMenu,ProjectMenu.test,recent,recent.test}.ts(x)`
- Modify: `src/features/project/{projectStore,projectStore.test,ProjectGate,ProjectGate.test,Sidebar,Sidebar.test}.tsx`, `src/features/workspace/{commands,shortcuts,shortcuts.test}.ts`, `src/shared/i18n/{en,ko}.ts`

**Interfaces:**
- Consumes: Task 6의 `recentProjects`
- Produces:
  ```ts
  // projectStore
  recent: RecentProject[];
  refreshRecent(): Promise<void>;
  // boot(): 가장 최근 프로젝트를 연다. 없거나 열지 못하면 "none"(Welcome A).
  export interface RecentProject { dir: string; name: string; openedAt: number }
  /** "chilla-demo" → "CD", "billing" → "BI", "billing-migration" → "BM" */
  export function initials(name: string): string;
  /** home 아래면 "~/…" */
  export function shortPath(dir: string, home: string): string;
  /** Just now, Today, Yesterday, 그 밖에는 언어에 맞는 짧은 날짜 */
  export function openedWhen(openedAt: number, now: number, language: Language): string;
  export function ProjectMenu(props: { onClose(): void }): JSX.Element;
  // commands: switchProject(dir?: string) — dir이 있으면 picker를 건너뛴다.
  ```
  `CommandId`에 `"openProject"`(`Cmd+O`, `KeyO` + `metaKey`). home 경로는 `src/shared/api/path.ts`에 `homeDir()`를 더한다(`@tauri-apps/api/path`).
- 문구: `project.recent` "Recent Projects", `project.recentShort` "Recent", `project.openShortcut` "Open Project…", `project.missingTitle` "{dir} has no chilla.toml", `project.missingBody` "Create a chilla.toml with only [project] and open the folder as a project. Add connections after it opens.", `project.chooseAnother` "Choose another folder…", `project.create` "Create chilla.toml", `when.justNow` "Just now", `when.today` "Today", `when.yesterday` "Yesterday".

- [ ] **Step 1: test를 쓴다**

- `recent.test.ts`: `initials_from_words_and_single_names`, `short_path_uses_tilde`, `opened_when_buckets`(59초 전, 오늘 아침, 어제, 11월 9일 — en `Nov 9`, ko `11월 9일`).
- `projectStore.test.ts`: `boot_opens_the_most_recent_project`, `boot_shows_welcome_when_it_fails`(오류와 목록), `boot_without_recents_shows_welcome`, `local_storage_is_not_used`.
- `ProjectGate.test.tsx`(Welcome A, B): `welcome_lists_recent_projects`(initials, 이름, `~/work/billing`, 언제), `clicking_a_recent_opens_it`, `missing_chilla_toml_asks_in_a_sheet`(Create, Choose another folder…, Cancel).
- `ProjectMenu.test.tsx`(Sidebar D): `menu_lists_other_recent_projects`(지금 프로젝트는 머리에, 목록에는 없음), `choosing_one_switches_project`(`switchProject(dir)`), `open_project_item_opens_the_picker`.
- `shortcuts.test.ts`: `cmd_o_is_open_project`.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/project src/features/workspace/shortcuts.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현한다**

- Welcome A, B와 Sidebar D의 배치를 `docs/design/canvas/Welcome.dc.html`, `Sidebar.dc.html`에서 읽어 따른다. Welcome B는 M4의 `Modal`로 그린다.
- `LAST_PROJECT_KEY`와 `localStorage` 읽기·쓰기를 지운다.
- 프로젝트를 열거나 만든 뒤 `refreshRecent`.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: 최근 프로젝트로 시작하고 Welcome 화면과 sidebar menu, Cmd+O로 프로젝트를 바꿈"
```

---

### Task 19: 에디터 글꼴과 받다 만 결과 시간

**Files:**
- Modify: `src/features/editor/{extensions,SqlEditor,SqlEditor.test}.ts(x)`, `src/features/query/{ResultPane,ResultPane.test}.tsx`(`IDLE_RESULT_MINUTES = 10`을 `round(idleTimeoutSecs / 60)`으로)

**Interfaces:**
- Consumes: Task 9의 `useSettings`의 `editor`, `idleTimeoutSecs`
- Produces: `editorFontTheme(font: string, size: number): Extension`(`.cm-content`, `.cm-gutters`의 font-family, font-size, line-height `round(size × 1.6)`px). `SqlEditor`가 `Compartment`로 넣는다.

- [ ] **Step 1: test를 쓴다**

- `SqlEditor.test.tsx`: `uses_the_editor_font_setting`(`"JetBrains Mono"`, 13 → content style에 `"JetBrains Mono", "D2Coding", monospace`, 13px, 21px).
- `ResultPane.test.tsx`: `expired_message_uses_the_setting`(`idleTimeoutSecs: 1200` → 20분 문구).

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/editor/SqlEditor.test.tsx src/features/query/ResultPane.test.tsx`
Expected: FAIL

- [ ] **Step 3: 구현한다**

기본 설정(`D2Coding`, 15)에서 지금 화면(15px, line-height 24px)과 같게 보이도록 기본값의 line-height만 24px로 둔다(`round(15 × 1.6) = 24`).

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: 에디터 글꼴과 크기, 받다 만 결과를 닫는 시간을 설정에서 받음"
```

---

### Task 20: 정리와 code review

- [ ] **Step 1:** `simplify`를 돌려 고친 것을 commit한다(`chore: …`).
- [ ] **Step 2:** `code-review`를 high로 돌린다.
- [ ] **Step 3:** 지적마다 `superpowers:receiving-code-review`로 다시 검토해 고칠 것만 고치고 commit한다(`fix: …`). 고치지 않은 지적은 이유와 함께 진행상황의 결정 기록에 남긴다.

Run: `pnpm check`
Expected: 통과

---

### Task 21: 완료 확인 — 앱에서 보기

**Files:**
- Modify: `docs/progress.md`, `docs/plans/M8-editor-run.md`(체크)

앱을 띄우기 전에 사용자에게 해도 되는지 묻는다. 방법은 진행상황 "지금"의 "앱 동작 확인 방법"이다. test DB(54318)에 `CREATE SCHEMA m8_check`의 테이블을 만들어 쓰고 끝나면 지운다. `~/.config/chilla/config.toml`이 이미 있으면 내용을 기록해 두고 확인 뒤 되돌린다.

- [ ] **Step 1: local test DB로 화면을 본다** (`scripts/build-app.sh --debug`)

| 확인 | 기준 |
| --- | --- |
| 앱 시작 | 마지막 프로젝트가 1초 안에 열림. 처음이면 Welcome A |
| Sidebar의 프로젝트 이름 → 다른 최근 프로젝트 | Sidebar D의 menu, 고르면 그 프로젝트와 그 프로젝트의 탭 |
| 저장하지 않은 탭을 두고 `Cmd+Q` 뒤 다시 시작 | 그 탭이 dirty로 같은 내용 |
| `Opt+Cmd+L`, 선택 영역에서 `Opt+Cmd+L` | 문서 또는 선택만 바뀌고 `Cmd+Z` 한 번에 돌아감 |
| 커서를 문장 사이로 옮김 | 커서 문장의 줄에 배경과 왼쪽 선 |
| `SELECT 1;\nSELEC 2` 실행 | `SELEC`에 밑줄, 오류 화면의 Go to error가 그 자리로 |
| Run file(문장 4개, 셋째가 오류) | States "여러 문장"의 결과 탭과 `Stopped at statement 3.` |
| `SELECT '{"a":{"b":1}}'::jsonb, 1.5::numeric, now()` → 셀에서 `Shift+Enter` | header의 type, 숫자 오른쪽, `{"a": {…}}`, timestamptz가 Mac 시간, 오른쪽 panel의 들여쓴 JSON |
| `read_only` 접속에서 `DELETE FROM m8_check.t` | 확인 없이 실행, Safety C의 설명, 목록·menu·chip의 자물쇠 |
| `statement_timeout = 1` 접속에서 `SELECT pg_sleep(2)` | Timed out 화면 |
| 접속 sheet의 Test | `Connected · PostgreSQL 18.6` |
| `config.toml`에 `language = "ko"`, `[editor] font_size = 13` 후 다시 시작 | 한국어 화면과 menu, 13px 에디터. Rust 오류(없는 디렉토리 열기)도 한국어 |
| `config.toml`에 `fontsize = 14` | 기본값으로 뜨고 오류 dialog |

1만 줄 파일(`SELECT 1;`을 1만 줄)에서 화살표 key를 누르고 있어도 커서가 밀리지 않는지 본다.

- [ ] **Step 2: 기록하고 commit한다**

- 진행상황: M8을 `완료`(날짜), 작업 로그에 Task별 결과와 Step 1의 결과, "지금"의 다음 할 일(3단계를 며칠 실제로 써 본 뒤 M9)을 쓴다.
- 이 계획의 체크박스를 모두 체크한다.

Run: `pnpm check`
Expected: 통과

```bash
git add docs
git commit -m "docs: M8 완료 확인 결과를 기록함"
```
