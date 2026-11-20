# ChillaSQL 진행상황

마지막 갱신: 2026-11-20

## 지금

- **진행 중**: 없음. M8 에디터·실행 편의를 끝냄(2026-11-20, [M8](plans/M8-editor-run.md)). 3단계가 끝났다
- **작업 위치**: main. branch `m8-editor-run`을 2026-11-20에 fast-forward로 합치고 지움. origin/main은 `d2be9bf`이고 그 뒤의 commit은 push하지 않았다
- **디자인 기준**: [docs/design](design/README.md)의 캔버스 사본과 D2Coding. M4부터 화면은 이것을 따른다
- **다음 할 일**: 기획서 8장대로 3단계를 며칠 실제로 써 본다(완료 기준: 하루 업무를 DataGrip 없이 처리). 그 뒤 M9 계획. 부하가 걸리면 가끔 실패하는 test(`tunnel_process` 몇 개, `ten_thousand_statements_split_within_100ms`, vitest `aliased_columns_come_from_the_aliased_table`)를 따로 손본다. 터널 test 몇 개는 동작이 망가지면 실패 대신 멈춘다(작업 로그 M5 Task 4, 7). 사용자가 시간 제한을 넣지 않기로 함
- **앱 동작 확인 방법** (M3 Task 13, M4 Task 1, M4 Task 13에서 확인한 것)
  - computer use는 dev binary(`pnpm tauri dev`)를 조작할 앱으로 고르지 못한다. `scripts/build-app.sh --debug`로 `target/debug/bundle/macos/ChillaSQL.app`을 만들어(dev 빌드와 같은 identity로 서명됨) `open`한다. 그러면 키체인 확인 창이 뜨지 않는다. 이 `.app`은 dev와 `localStorage`가 따로라 마지막 프로젝트가 다르다
  - computer use 도구가 없는 세션에서는 Bash로 한다: `open --stderr <file>`로 앱의 stderr를 받고, `screencapture -x -R<x,y,w,h>`로 창을 찍고, System Events(`osascript`)로 창 위치와 menu를 다루고, 클릭과 끌기는 CGEvent를 보내는 작은 Swift script로 한다. 한글 입력기가 켜져 있으면 `keystroke "c" using command down`이 다른 key로 들어가 에디터에 한글이 입력되므로 `key code 8 using command down`처럼 key code로 보낸다
  - 단축키를 보내려면 full-screen control이 필요하다. 폴더 picker는 다른 process라 글자를 입력할 수 없다. 경로를 `pbcopy`로 넣고 `Shift+Cmd+G`(key code 5), `Cmd+V`, `Return` 두 번을 key code로 보내면 연다(M4 Task 13)
  - 사용자가 같은 Mac을 쓰는 중이면 System Events의 key는 앞에 있는 다른 앱으로 간다. key는 `CGEvent.postToPid`로 앱 process에 직접 보내고, 클릭과 screenshot 전에는 앱을 앞으로 가져와 앞에 있는지 확인한다. screenshot에 다른 앱이 찍히면 지운다(M4 Task 13)
  - 짧게 보였다 사라지는 화면(빈 frame, 위치 튐)은 `screencapture -v -V<초> -R…`로 녹화하고 AVFoundation으로 frame을 뽑아 Vision OCR로 읽는다(M4 Task 13)
  - 한글 입력기를 거치는 입력(조합 중의 단축키)은 computer use로 만들 수 없다. 사용자에게 부탁한다
- **알려진 것, M3에서 고치지 않은 것**은 아래 작업 로그(2026-11-12)에 있다
- **M2가 화면에 주는 계약** (M4의 결과 표가 지키는 것)
  - `runReducer`는 `retainedFrom`보다 앞의 행을 버리고, 남은 첫 행의 번호를 `firstRow`에 둔다(표의 row key가 `firstRow + index`)
  - 화면은 `rows` event의 `retainedFrom`보다 앞의 행을 버리고 그 구간을 "다시 실행해야 볼 수 있음"으로 그린다
  - `split_statements`의 span과 server 오류의 `position`은 모두 보낸 text 기준 0-based UTF-16 code unit offset이다
  - `finished`의 outcome은 `completed`, `failed`, `cancelled`, `discarded`, `connection_lost`, `client_error` 여섯이다. cancel한 쿼리도 서버에서 이미 끝났고 버린 행이 없으면 `completed`로 온다
  - `fetch_more`는 그 세션이 발급한 query id면 끝난 쿼리에도 `Ok`다. 결과의 끝은 `finished` event로만 안다
  - 화면이 사라진(Channel이 끊긴) 쿼리는 다음 실행이나 세션 닫기 전까지 DB에 열려 있다(자동 닫기는 M6). 받다 만 결과는 다음 실행, 취소, 탭 닫기에서 버려진다
  - `COPY … FROM STDIN` / `TO STDOUT`은 지원하지 않는다. 실행하면 그 세션의 연결을 끊고 `connection_lost`로 알린다

## 마일스톤 현황

상태: `대기` → `계획 중` → `진행 중` → `완료`

| 마일스톤 | 단계 | 상태 | 계획 | 시작 | 완료 |
| --- | --- | --- | --- | --- | --- |
| M0 셋업 | 1 | 완료 | [M0](plans/M0-setup.md) | 2026-11-11 | 2026-11-11 |
| M1 접속·세션 코어 | 1 | 완료 | [M1](plans/M1-session-core.md) | 2026-11-11 | 2026-11-11 |
| M2 쿼리 실행 코어 | 1 | 완료 | [M2](plans/M2-query-core.md) | 2026-11-11 | 2026-11-11 |
| M3 프로젝트·에디터 화면 | 1 | 완료 | [M3](plans/M3-project-editor.md) | 2026-11-12 | 2026-11-18 |
| M4 결과 표 | 1 | 완료 | [M4](plans/M4-result-table.md) | 2026-11-18 | 2026-11-18 |
| M5 터널 | 2 | 완료 | [M5](plans/M5-tunnel.md) | 2026-11-19 | 2026-11-19 |
| M6 트랜잭션과 안전장치 | 2 | 완료 | [M6](plans/M6-transaction-safety.md) | 2026-11-19 | 2026-11-19 |
| M7 스키마 트리와 자동완성 | 3 | 완료 | [M7](plans/M7-schema-autocomplete.md) | 2026-11-20 | 2026-11-20 |
| M8 에디터·실행 편의 | 3 | 완료 | [M8](plans/M8-editor-run.md) | 2026-11-20 | 2026-11-20 |
| M9 쿼리 도구 | 4 | 대기 | | | |
| M10 결과 표 확장 | 4 | 대기 | | | |

## 결정 기록

기획서와 다르게 정했거나 기획서에 없던 결정. 기획서도 함께 고친다.

| 날짜 | 마일스톤 | 결정 | 이유 |
| --- | --- | --- | --- |
| 2026-11-11 | M0 | lint와 formatter 도입: ESLint + Prettier, clippy + rustfmt. `pnpm check`를 commit 전 통과 기준으로 씀 | 화면과 Rust 양쪽의 스타일과 구조 규칙(`invoke` 위치)을 사람이 아니라 도구로 확인하려고 |
| 2026-11-11 | M0 | layer를 crate가 아니라 `chilla-core` 안의 module(`domain`, `application`, `infrastructure`)로 나눔 | 혼자 쓰는 앱에 crate 여러 개는 과함. 의존 방향은 M1에서 test로 확인 |
| 2026-11-11 | M0 | dark 테마 고정, 기본 창 1512×982(화면 가운데) | 사용자 요청. light 전환은 만들지 않음. 창 크기는 14" MacBook Pro 기본 해상도에 맞춤. 처음 정한 1600×1200은 내장 display를 넘어서 바꿈 |
| 2026-11-11 | M0 | `@tauri-apps/*` 패키지는 `src/shared/api/`에서만 import. ESLint로 강제 | 화면 코드와 Tauri IPC 사이의 경계를 한 곳에 둠 |
| 2026-11-11 | M0 | release profile에서 `panic = "abort"`와 `strip`을 뺌 | 세션 task 하나의 panic이 앱 전체를 끝내 열린 트랜잭션을 잃지 않게 함. binary 크기는 중요하지 않음 |
| 2026-11-11 | M0 | CSP는 M3에서 켬 (지금은 template 기본값 `null`) | Vite HMR, CodeMirror가 넣는 style에 맞춰 정해야 함. M3 전에는 DB 내용을 화면에 그리지 않음 |
| 2026-11-11 | M1 | 결과는 portal이 아니라 stream(`query_raw`, `simple_query_raw`)으로 받고 session actor가 500행씩 당겨 읽음. 남은 결과 버리기는 cancel + drain | portal은 트랜잭션 안에서만 살아서 Auto 모드와 어긋나고 `VACUUM` 같은 문장을 못 돌림. stream은 backpressure가 걸려 읽지 않은 행이 메모리에 쌓이지 않음. 구현은 M2 |
| 2026-11-11 | M1 | 트랜잭션 상태는 연결 stream을 감싼 `TxTap`이 ReadyForQuery의 상태 byte를 읽어 알아냄. TLS handshake는 `tokio-rustls`로 직접 하고 `tokio-postgres`에는 `connect_raw` + `NoTls`로 넘김 | `tokio-postgres` 0.7은 상태 값을 버리고 공개하지 않음. SQL 파서로 추적하는 것은 추론이라 쓰지 않음. 대가로 SCRAM channel binding을 쓰지 않음 |
| 2026-11-11 | M1 | `sslmode`는 `disable`(기본값), `require`, `verify-full`만 받음. `chilla.toml`에 `sslrootcert` 추가(`verify-full` 전용, 있으면 그 CA만 신뢰, 없으면 macOS trust store) | 사설 CA를 쓰는 서버를 `verify-full`로 확인하려면 CA를 지정할 방법이 필요함. `prefer`처럼 조용히 평문으로 내려가는 모드는 두지 않음 |
| 2026-11-11 | M1 | `chilla.toml`에 모르는 항목이 있으면 프로젝트를 열지 않음 | `sslmod` 같은 오타를 조용히 넘기지 않으려고 |
| 2026-11-11 | M1 | 키체인 항목: service `com.yuiyeong.chillasql`, account `<프로젝트 디렉토리 절대 경로>::<접속 이름>`. crate는 `keyring` 대신 `keyring-core` + `apple-native-keyring-store` | `keyring` 4가 platform이 하나인 앱에는 이 조합을 쓰라고 안내함 |
| 2026-11-11 | M1 | 연결 timeout 10초(TCP, TLS, 인증 포함), `application_name`은 `ChillaSQL` | 응답 없는 host에서 무한정 기다리지 않게 함. 서버의 `pg_stat_activity`에서 앱을 구분 |
| 2026-11-11 | M1 | `application` layer는 `tokio`의 runtime 기능(`sync`, `task`, `time`)을 쓸 수 있음. `pnpm check`는 test DB를 먼저 띄움 | session actor가 task와 channel을 씀. `cargo test`가 test DB에 접속함 |
| 2026-11-11 | M1 | 서명하지 않은(ad-hoc) 빌드는 다시 빌드할 때마다 키체인 확인 창이 뜸. 자동 test는 실제 키체인을 쓰지 않고(`MemoryPasswordStore`), dev 빌드 서명은 M3에서 정함 | probe로 확인: 같은 binary는 6ms, 다시 빌드한 binary는 dialog가 떠서 응답까지 7~12초. ad-hoc 서명은 빌드마다 code hash가 바뀜 |
| 2026-11-11 | M1 | 트랜잭션 상태는 오류 직후 서버의 ReadyForQuery까지 기다린 뒤 읽음(`tx_status`가 async) | 서버가 ErrorResponse를 먼저 flush하고 ReadyForQuery를 따로 보내서, 오류 직후에 읽으면 오류 전의 상태가 나옴. 구현 중 test가 잡음 |
| 2026-11-11 | M1 | 접속 테스트는 저장된 접속과 연결 대상(host, port, database, user, SSL 설정, 터널)이 같을 때만 키체인의 비밀번호를 씀. 대상을 바꿔 테스트하려면 비밀번호를 다시 입력 | 화면이 저장된 접속의 이름에 다른 host를 붙여 보내면 저장된 비밀번호가 그 host로 나갈 수 있음 |
| 2026-11-11 | M1 | 비밀번호 저장과 조회는 프로젝트에 있는 접속 이름으로만 함. 지우기는 없는 이름도 받음 | 오타 난 이름으로 아무도 읽지 않는 키체인 항목이 생기지 않게 함. 지우기는 프로젝트에서 빠진 접속의 항목을 치울 수 있어야 함 |
| 2026-11-11 | M1 | DB socket에 TCP keepalive를 켬(30초 조용하면 10초 간격 3번) | socket을 직접 열어서 `tokio-postgres`가 해 주던 설정이 빠짐. 없으면 sleep 뒤 복귀나 VPN 끊김처럼 FIN 없이 죽은 연결을 모름 |
| 2026-11-11 | M2 | simple query protocol로 실행하고 값은 text로 받음. 결과 컬럼은 이름만 알고 type OID와 테이블 OID는 M8, M10에서 얻음 | extended protocol은 값을 binary로만 줘서 type마다 text 변환을 만들어야 함. text로 받으면 enum, domain, `vector`도 서버의 표기 그대로 나옴 |
| 2026-11-11 | M2 | 한 번에 문장 하나만 실행함. 문장이 2개 이상이면 `MultipleStatements` 오류. 여러 문장 실행은 M8 | simple query로 여러 문장을 보내면 서버가 하나의 암묵적 트랜잭션으로 묶어 4.5의 "오류가 나면 그 문장에서 멈춤"과 달라짐 |
| 2026-11-11 | M2 | 실행할 text는 받은 그대로 보냄(앞뒤를 자르지 않음). 나눌 수 없는 text도 그대로 보내 서버의 오류를 보여 줌 | 서버가 알려 주는 오류 위치가 화면이 보낸 text 기준이 됨. 서버는 text 전체를 parse한 뒤 실행하므로 일부만 실행되지 않음 |
| 2026-11-11 | M2 | 문장 나누기는 `pg_query::scan`의 token으로 함(기획서 4.5는 "SQL 파서로"). 문법 오류가 있는 문장도 문장으로 나눔 | `split_with_parser`는 text 어디든 문법 오류가 있으면 전체가 실패함. 편집 중인 파일은 대개 어딘가 깨져 있고 `:id` 파라미터(M9)도 문법 오류임 |
| 2026-11-11 | M2 | 문장 위치는 Rust 안에서 byte offset, 화면으로는 UTF-16 code unit offset | CodeMirror의 위치가 UTF-16 기준 |
| 2026-11-11 | M2 | 행은 화면이 보관하고 Rust는 보관하지 않음. 보관 상한(10만 행)은 Rust가 갖고 batch마다 `retained_from`으로 알려 줌 | 화면이 그보다 앞의 행을 버리고 "다시 실행해야 볼 수 있음"으로 표시(M4). Rust가 행을 이중으로 들고 있지 않게 함 |
| 2026-11-11 | M2 | batch는 500행 또는 cell byte 합 4 MiB 중 먼저 닿는 쪽에서 끊음 | 큰 JSONB나 `bytea`가 있는 결과에서 batch 하나가 수백 MB가 되지 않게 함 |
| 2026-11-11 | M2 | batch를 보낸 뒤 항목을 하나 더 읽음(look-ahead) | 정확히 500행인 결과가 "받다 만 결과"로 남지 않고 바로 끝남 |
| 2026-11-11 | M2 | 소요 시간(`elapsed`)은 `Paused`로 기다린 시간을 뺌 | 화면이 스크롤하지 않아 멈춰 있던 시간은 쿼리의 시간이 아님 |
| 2026-11-11 | M2 | 실행 중인 세션의 상태는 actor가 가진 값으로 답함. 쿼리가 끝날 때마다 `tx_status()`를 읽어 저장 | 쿼리가 stream을 쓰는 동안에는 연결에 물어볼 수 없음(M1에서 넘어온 주의 사항) |
| 2026-11-11 | M2 | 취소는 "쿼리를 멈추고 남은 결과를 버린다". 받다 만 결과에도 쓰고, 취소 뒤에 온 행은 보내지 않고 `Cancelled`로 끝냄 | cancel + drain(M1 결정)으로 연결을 다음 쿼리에 바로 쓸 수 있게 함 |
| 2026-11-11 | M2 | 조금씩 오는 행을 timer로 미리 보내지 않음. 500행이 차거나 결과가 끝나야 보냄 | 필요해지면 그때 넣음 |
| 2026-11-11 | M2 | 타임아웃(4.5, M8), 받다 만 결과 10분 뒤 자동 닫기(4.6, M6), 화면 쪽 TypeScript wrapper(M3)는 M2에 넣지 않음 | 각 마일스톤의 범위 |
| 2026-11-11 | M2 | batch는 Channel로 JSON을 보냄. 500행 batch 하나가 118,374자(JSON 문자 수, 약 118 KB)이고 Rust → webview 지연은 20개를 50ms 간격으로 보냈을 때 median 6.96ms, max 13.90ms, 200개(10만 행)를 한꺼번에 보냈을 때 첫 batch부터 마지막까지 630ms, 지연 max 6.93ms | 기준(median ≤ 20ms, burst 전체 ≤ 2,000ms) 안이라 binary 형식은 쓰지 않음. 6장의 "첫 결과 표시 0.1초" 중 Channel의 몫은 1/5 이하. DB 없이 `big_table`과 같은 모양으로 만든 batch를 `pnpm tauri dev`(debug build)에서 잼 |
| 2026-11-11 | M2 | batch를 보낸 뒤 look-ahead 행을 읽기 전에 온 `fetch_more`는 예정된 pause를 취소함(다음 batch를 이어 읽음) | 계획의 규칙대로면 `true`를 답하고도 `Paused`가 돼 다음 batch가 오지 않음. 화면은 `rows`를 받자마자 `fetch_more`를 보낼 수 있음 |
| 2026-11-11 | M2 | cancel은 서버가 연결을 닫을 때까지(EOF) 기다림. 쿼리보다 먼저 닿은 cancel은 서버가 무시하므로 actor가 1초 간격으로 다시 보냄 | 서버가 요청을 처리하기 전에 돌아오면 다음 쿼리가 cancel에 맞을 수 있음. 먼저 닿은 cancel의 무시는 병렬 실행 15회 중 2회쯤 관찰됨 |
| 2026-11-11 | M2 | cancel한 쿼리를 버리는 동안(`Draining`)에도 결과를 숨기지 않음. 끝날 때 57014가 아닌 server 오류가 있으면 `failed`, `Complete`를 받았고 버린 행이 없으면 `completed`, 그 밖에는 `cancelled`/`discarded` | cancel이 늦게 닿아 commit된 DELETE를 "취소됨"으로 보여 주면 사용자가 실행되지 않았다고 믿음. 화면에 보내지 않은 행이 있으면 결과를 다 받은 것이 아니므로 버린 이유로 알림 |
| 2026-11-11 | M2 | 앞 쿼리를 버리는 동안 대기 중인 쿼리의 cancel은 그 쿼리를 `cancelled`로 버림(cancel 요청은 보내지 않음) | 계획의 "그 밖은 바로 Ok"는 아무것도 하지 않아, 멈추려던 DML이 실행됨 |
| 2026-11-11 | M2 | `fetch_more`는 이 세션이 발급한 query id면 끝난 쿼리에도 no-op `Ok`, 발급한 적 없는 id만 `query_not_active` | look-ahead 때문에 화면이 방금 끝난 쿼리에 `fetch_more`를 보낼 수 있음 |
| 2026-11-11 | M2 | DB 오류가 아닌 stream 오류에서는 연결을 실제로 끊고 `connection_lost`로 알림. `COPY … FROM STDIN` / `TO STDOUT`은 지원하지 않음 | 그런 오류 뒤의 연결은 protocol이 어긋나 다음 쿼리를 받지 못함. 보고와 상태를 일치시킴. `COPY … FROM STDIN`은 cancel도 듣지 않음 |
| 2026-11-11 | M2 | server도 연결 끊김도 아닌 오류는 outcome `client_error`(UTF-8이 아닌 값, NUL 문자가 든 text). 연결은 그대로 둠 | driver가 UTF-8이 아닌 cell에서 panic하고(SQL_ASCII DB, `client_encoding` 변경) NUL이 든 text는 보내지 못함. 둘 다 연결 문제가 아님 |
| 2026-11-11 | M2 | cancel 요청은 연결할 때의 peer address로 보냄 | cancel마다 host를 다시 resolve하면 DNS round-robin host에서 다른 서버로 갈 수 있음(libpq와 같음) |
| 2026-11-11 | M2 | server 오류의 `position`은 DTO에서 보낸 text 기준 0-based UTF-16 offset으로 바꿔 보냄 | 서버는 1부터 세는 글자 번호를 주는데 문장 span은 UTF-16 offset이라 emoji 같은 non-BMP 문자가 앞에 있으면 위치가 어긋남 |
| 2026-11-11 | M2 | `split_statements` command는 async로 돌림(`#[tauri::command(async)]`) | sync command는 main thread에서 돌아 1만 줄 scan(약 40ms)이 화면을 막음 |
| 2026-11-12 | M3 | 커서 문장은 M2의 `split_statements`로 고름. 실행할 때 문서 전체를 한 번 보내고 화면에서 따로 판별하지 않음. 커서가 문장 안이나 끝이면 그 문장, 아니면 같은 줄의 앞 문장, 없으면 같은 줄의 뒤 문장, 그것도 없으면 실행하지 않음 | 1만 줄 scan이 약 40ms이고 async command라 실행마다 보내도 됨. 다른 줄의 문장을 고르지 않는 것은 엉뚱한 DML을 실행하지 않게 하려고 |
| 2026-11-12 | M3 | 나눌 수 없는 text(닫히지 않은 따옴표 등)에서 커서 실행은 보내지 않고 `split_failed`의 message를 보여 줌. 선택 영역은 받은 그대로 보냄 | 어느 문장인지 알 수 없음. 선택 영역은 M2의 결정(앞뒤를 자르지 않음)을 따름 |
| 2026-11-12 | M3 | CSP `default-src 'self'; connect-src ipc: http://ipc.localhost; img-src 'self' data:; style-src 'self' 'unsafe-inline'`. 빌드된 앱에만 적용되고 `devCsp`는 두지 않음 | desktop `tauri dev`는 webview가 `devUrl`(Vite)을 직접 열어 CSP header가 붙지 않음(`tauri` 2.12.5 source). CodeMirror(`style-mod`)가 `<style>` tag를 넣어 `'unsafe-inline'`이 필요하고, nonce는 Tauri가 HTML마다 새로 만들어 화면이 알 수 없음. `script-src`는 풀지 않음 |
| 2026-11-12 | M3 | dev 빌드는 cargo runner script(`scripts/cargo-runner.sh`)에서 이 Mac의 code signing identity로 서명함(identifier `com.yuiyeong.chillasql`). `CHILLA_DEV_IDENTITY`가 있으면 그것을, 없으면 첫 유효 identity를 쓰고, identity가 없으면 서명 없이 실행. release 빌드의 서명은 M4에서 정함 | M1에서 ad-hoc 빌드는 다시 빌드할 때마다 키체인 확인 창이 떴음. `tauri dev`는 `cargo run`이라 cargo의 runner가 걸림. self-signed identity를 새로 만들지 않고 이미 있는 identity를 씀 |
| 2026-11-12 | M3 | menu를 직접 만들고 Close Window를 뺌. `Cmd+W`는 탭을 닫고 창은 `Cmd+Q`나 닫기 버튼으로 닫음. Edit의 undo, redo, cut, copy, paste, select all은 둠 | 기본 menu의 `close_window`(`Cmd+W`)가 webview의 `keydown`보다 먼저 잡힘. Edit menu가 없으면 WKWebView에서 `Cmd+C`/`Cmd+V`가 되지 않음 |
| 2026-11-12 | M3 | M3의 단축키: 실행 `Cmd+Enter`, 취소 `Cmd+F2`, 저장 `Cmd+S`, 새 탭 `Shift+Cmd+L`, 탭 닫기 `Cmd+W`, 다음 탭 `Shift+Cmd+]`, 이전 탭 `Shift+Cmd+[`. `KeyboardEvent.code`로 판별 | DataGrip macOS 키맵(4.10). 한글 입력 상태에서 `key`는 `ㄴ` 같은 자모임 |
| 2026-11-12 | M3 | 마지막으로 연 프로젝트 디렉토리를 `localStorage`(`chilla.lastProjectDir`)에 두고 시작할 때 엶 | 최근 프로젝트 목록(M8)이 생기면 SQLite로 옮김. M8은 옮기지 않고 쓰지 않기로 함(2026-11-20 M8 "최근 프로젝트" 줄) |
| 2026-11-12 | M3 | `chilla.toml`이 없는 디렉토리는 앱이 `[project]`만 든 파일을 만들어 프로젝트로 만들 수 있음 | 새 디렉토리도 설정 파일을 손으로 만들지 않고 앱에서 프로젝트로 열 수 있게 함 |
| 2026-11-12 | M3 | 접속 저장은 `toml_edit`로 그 접속의 table만 고침. 저장 전에 결과를 `load`와 같은 검사로 다시 읽어 봄. `sslrootcert`가 프로젝트 디렉토리 안이면 상대 경로로 씀 | 주석, 다른 접속, 순서를 그대로 둠. 7장의 "저장 시 검사" |
| 2026-11-12 | M3 | 접속 이름은 만든 뒤에 바꿀 수 없고 접속 지우기는 만들지 않음. `tunnel`(M5)과 `color`(M6)는 form에 없고 저장할 때 그대로 둠 | 필요하면 `chilla.toml`을 직접 고침 |
| 2026-11-12 | M3 | 접속의 연결 대상(host, port, database, user, SSL 설정, 터널)을 바꿔 저장하면 저장된 비밀번호를 지움. 같이 새 비밀번호를 넣으면 그것을 저장 | M1의 접속 테스트와 같은 이유: 저장된 비밀번호가 다른 host로 가지 않게 함 |
| 2026-11-12 | M3 | `has_password`는 접속 수정 form을 열 때만 부름. 구현(값을 읽음)은 그대로 둠 | M1에서 미룬 것. 접속 목록을 그릴 때 키체인을 읽지 않음 |
| 2026-11-12 | M3 | SQL 파일 목록은 프로젝트 디렉토리 아래의 `.sql` 파일. `.`으로 시작하는 이름, `node_modules`, `target`, symlink는 빼고 16 MiB를 넘는 파일은 열지 않음. 읽을 때의 stamp(mtime과 크기)를 화면이 갖고 있다가 저장할 때 돌려주고, 그 사이 디스크의 파일이 바뀌었으면 덮어쓰기 전에 물음 | 밖에서 바뀐 파일을 모르고 덮어쓰지 않게 함 |
| 2026-11-12 | M3 | 세션은 탭의 첫 실행 때 엶. 새 탭은 활성 탭의 접속을 물려받고, 활성 탭이 없으면 접속이 없음 | 첫 접속을 자동으로 고르지 않음. `chilla.toml`의 첫 접속이 운영일 수 있음 |
| 2026-11-12 | M3 | 임시 표는 첫 batch(최대 500행)만 보여 주고 `fetch_more`를 부르지 않음. 받다 만 결과는 다음 실행, 취소, 탭 닫기에서 버려짐. `retainedFrom`보다 앞의 행은 reducer가 버림 | 결과 표와 "다시 실행해야 볼 수 있음" 표시는 M4 |
| 2026-11-12 | M3 | 앱이 끝날 때 `close_all_sessions`를 부름 | 실행 중인 쿼리가 서버에 남지 않게 함 |
| 2026-11-12 | M3 | CodeMirror의 `autocompletion()`은 켜지 않음 | 자동완성은 M7 |
| 2026-11-12 | M3 | 저장하지 않은 변경은 탭을 닫을 때와 프로젝트를 바꿀 때만 묻고 앱을 끝낼 때는 묻지 않음. 가상 스크롤과 이어서 가져오기(M4), 터널과 접속별 색상(M5, M6), 트랜잭션 표시(M6), 자동완성(M7), 오류 위치 밑줄·여러 문장 실행·저장하지 않은 탭 자동 보관·최근 프로젝트 목록(M8)은 넣지 않음 | M8의 자동 보관이 앱을 끝낼 때의 확인을 대신함. 나머지는 각 마일스톤의 범위. M8은 프로젝트를 바꿀 때의 확인도 없앰(2026-11-20 M8 "자동 보관과 복원" 줄) |
| 2026-11-12 | M3 | dev 빌드 서명 확정. runner로 서명한 binary가 키체인 항목을 만들고(`KEYCHAIN_PROBE 18.89 created`), 다시 빌드한 binary가 확인 창 없이 읽음(`lib.rs`에 빈 줄을 더해 다시 빌드 `9.03 existing`, probe 문구를 바꿔 CDHash가 바뀐 binary `9.669 existing`). `codesign -dvv`는 `Identifier=com.yuiyeong.chillasql`, Authority 줄 3개, `Signature=adhoc` 없음. cargo의 `runner` 상대 경로는 `.cargo/`가 있는 디렉토리 기준으로 풀림(tauri CLI가 `src-tauri/`에서 cargo를 불러도 됨) | 기준(확인 창 없음, 500ms 이내) 안. 빈 줄만 더한 빌드는 binary가 바뀌지 않았을 수 있어 code를 바꿔 한 번 더 잼. `pnpm tauri dev`에서 잼 |
| 2026-11-12 | M3 | CSP 확정(위 값 그대로). `pnpm tauri build --debug --no-bundle`로 만든 binary에서 `CSP_PROBE {"violations":[],"cmStyled":true,"channelChars":20000}`. `dangerousDisableAssetCspModification`은 필요 없음 | CodeMirror의 `<style>`이 막히지 않고(`.cm-scroller`의 `overflow-x`가 `auto`), 8,192 byte를 넘어 fetch 경로를 타는 20,000자 Channel 메시지도 `connect-src`에 막히지 않음. `style-src`에 nonce가 붙지 않아 `'unsafe-inline'`이 그대로 들음 |
| 2026-11-12 | M3 | 접속의 연결 대상을 바꿔 저장하면 `chilla.toml`을 쓰기 전에 저장된 비밀번호를 지움(입력한 비밀번호는 파일을 쓴 뒤에 저장). 지우기가 실패하면 파일을 쓰지 않음. 계획의 순서(쓴 뒤에 지움)를 바꿈 | 쓰기가 실패하거나 `ProjectChanged`가 나도 새 host에 옛 비밀번호가 남지 않아야 함(7장의 "대상을 바꿔 저장하면 지움"). 대가로 쓰기가 실패하면 대상은 그대로인데 비밀번호만 지워져 다시 입력해야 함(Ruling 6) |
| 2026-11-12 | M3 | 프로젝트에 없던 이름으로 저장할 때도 키체인에 남아 있던 비밀번호를 지움. 같은 대상이고 비밀번호를 입력하지 않았을 때만 키체인을 건드리지 않음 | 접속 지우기가 없어 `chilla.toml`에서 손으로 지우게 돼 있고, 그러면 키체인 항목이 남아 같은 이름으로 다시 만든 접속의 새 host로 갈 수 있음. 대가로 같은 이름으로 다시 만든 접속은 비밀번호를 한 번 더 입력(Ruling 14, code review) |
| 2026-11-12 | M3 | `save_connection`은 `save_lock`으로 하나씩 돌림. 쓰는 동안 프로젝트가 다시 열려도 입력한 비밀번호는 쓴 파일의 디렉토리 key로 저장한 뒤 `ProjectChanged`를 돌려줌 | 한 번의 저장이 키체인 delete, 파일 read-modify-write, state 갱신, 키체인 set에 걸쳐 있어 겹치면 서로의 결과를 덮음. 파일에는 이미 반영됐으므로 비밀번호를 버리면 사용자가 다시 입력해야 함(Ruling 13, simplify) |
| 2026-11-12 | M3 | 임시 파일은 이미 있던 경로를 지운 뒤 `create_new`로 열고, `sync_all` 뒤에 rename함. 임시 파일 이름은 helper(`atomic_write.rs`)가 `.{파일 이름}.chilla-tmp`로 정하고 NAME_MAX를 넘으면 hash로 줄임. `chilla.toml`과 SQL 파일이 같은 helper를 씀 | 프로젝트 디렉토리에 심어 둔 `.chilla.toml.tmp` symlink를 `fs::write`가 따라가 프로젝트 밖 파일에 쓰던 것(자동 security review)을 막음. 파일 이름이 NAME_MAX에 가까우면 임시 이름이 `ENAMETOOLONG`이었고, 보안상 민감한 block이 두 곳에 중복돼 있었음 |
| 2026-11-12 | M3 | 임시 파일은 target이 있으면 `0o600`으로 만들어 쓰기 전에 target의 권한으로 바꿈. target이 없으면 `0o644`에 umask를 적용 | 열 때 `mode`만 주면 umask가 적용돼 0664인 파일이 umask 022에서 0644가 됨. 쓰기 전에 바꾸므로 권한이 넓은 채로 내용이 놓이는 순간이 없음 |
| 2026-11-12 | M3 | `save_connection` 도중 `chilla.toml`이 지워지면 다시 만들지 않고 `ProjectError::Write`. SQL 파일의 `Replace`와 `Overwrite`는 없으면 만듦 | 옛 code는 metadata 오류를 `NotFound`가 아니어도 삼키고 umask 권한으로 파일을 다시 만들었음. 지워진 설정 파일을 저장이 되살리지 않게 함 |
| 2026-11-12 | M3 | symlink인 `chilla.toml`은 저장한 뒤 일반 파일이 됨 | symlink의 대상에 쓰지 않고 프로젝트 밖으로 쓰지 않는 쪽을 택함 |
| 2026-11-12 | M3 | `WriteModeDto`의 `Create`와 `Overwrite`는 빈 struct variant(`Create {}`) | serde가 unit variant에는 `deny_unknown_fields`를 적용하지 않아 `{"mode":"create","stamp":"s"}`가 통과함. JSON은 같음 |
| 2026-11-12 | M3 | 접속 form의 logic 파일 이름을 `connectionForm.ts`에서 `connectionValues.ts`로 바꿈 | `ConnectionForm.tsx`와 대소문자만 달라 macOS(case-insensitive)에서 확장자 없는 import `./ConnectionForm`이 `.ts`로 풀림. 확장자를 붙인 import는 다음 사람이 빼먹기 쉬운 우회라 쓰지 않음(Ruling 7) |
| 2026-11-12 | M3 | 접속 form의 비밀번호는 저장이 성공하면 비우고 접속 테스트 뒤에는 둠. component의 local state에만 있고 form을 닫으면 사라짐 | 테스트 뒤 바로 저장하는 흐름에서 다시 입력하게 하지 않으려고. 대가로 form이 열려 있는 동안 비밀번호가 memory에 조금 더 남음(Ruling 8) |
| 2026-11-12 | M3 | 파일로 연 탭도 활성 탭의 접속을 물려받음 | 새 탭은 활성 탭의 접속을 물려받는다는 규칙과 같음. 대가로 운영 접속 탭 옆에서 연 파일이 운영 접속을 가지지만 실행은 `Cmd+Enter`를 눌러야 함(Ruling 10) |
| 2026-11-12 | M3 | run token이 실행할 문장을 고르는 동안(`split_statements`)도 덮음. 늦게 끝난 앞 실행은 뒤 실행을 덮지 않음 | `Cmd+Enter`를 빠르게 두 번 눌러 문장 나누기가 거꾸로 끝나면 먼저 누른 쪽이 화면을 차지했고, 그 사이 탭을 닫거나 접속을 바꾼 것을 따로 다시 확인해야 했음(simplify) |
| 2026-11-12 | M3 | 실행 중에 거절된 `Cmd+Enter`(빈 줄 등)는 진행 중인 쿼리의 표시와 취소를 건드리지 않고 화면에 아무것도 보여 주지 않음. 번호를 attempt(누른 실행)와 token(시작한 실행)으로 나눔 | 거절된 실행이 상태를 `rejected`로 바꾸면 앞 쿼리의 event가 버려지고 취소 버튼이 동작하지 않는데 쿼리는 서버에서 계속 돎. 문구를 보여 줄 자리를 만드는 것은 M3의 임시 결과 화면 범위를 넘음. 대가로 빈 줄에서 누른 `Cmd+Enter`가 무반응으로 보임(Ruling 15) |
| 2026-11-12 | M3 | 저장의 중복 막기와 이름 검사는 `saveTab` 안에서 함. 같은 탭의 저장이 겹치면 두 번째는 아무것도 하지 않음 | `Cmd+S`를 두 번 누르거나 이름 form을 두 번 제출하면 같은 stamp로 두 번 써서 두 번째가 가짜 `file_changed`를 받았고, 이름 form의 저장은 guard를 거치지 않았음(simplify) |
| 2026-11-12 | M3 | 접속 form이 열려 있는 동안 단축키는 아무것도 하지 않음 | `Cmd+Enter`가 뒤의 탭을 실행하고 `Cmd+W`가 뒤의 탭을 닫았음 |
| 2026-11-12 | M3 | 접속의 연결 대상을 고쳐 저장하면 그 접속을 쓰는 탭의 세션을 놓음. 다음 실행이 새 세션을 엶 | `runsStore`가 접속 이름이 같으면 세션을 다시 써서, host A로 실행한 적 있는 탭이 `local`을 host B로 고친 뒤에도 A에서 실행했고 sidebar는 B를 보여 줬음(code review) |
| 2026-11-12 | M3 | 접속 추가는 이미 있는 이름을 거절함 | `save_connection`이 upsert라 있는 이름을 넣으면 기존 접속을 덮어 `tunnel`, `color`, 저장된 비밀번호가 묻지도 알리지도 않고 지워졌음(code review) |
| 2026-11-12 | M3 | 밖에서 지워진 파일은 저장할 때 "다시 만들까요?"를 묻고 `true`면 `overwrite`로 다시 만듦 | `replace`가 `file_not_found`로 실패하는데 화면이 `file_changed`만 다뤄 그 탭의 내용을 저장할 길이 없었음(code review) |
| 2026-11-12 | M3 | CRLF 파일은 줄 끝을 CRLF로 돌려 씀. tab id를 Set에 두고 저장할 때만 `\r\n`으로 이음(`EditorState.lineSeparator`는 쓰지 않음). 줄 끝이 섞인 파일은 모두 CRLF로 저장됨 | CodeMirror가 줄 끝을 `\n`으로 맞춰 한 글자만 고쳐도 모든 줄이 LF가 됨. `lineSeparator` facet은 붙여 넣은 `\n` text를 줄 하나 안의 문자로 넣어 화면의 줄과 어긋나고 LF가 섞임. 대부분 LF인 파일에 CRLF가 하나라도 있으면 전부 CRLF로 저장되는 것은 드물어서 둠(code review) |
| 2026-11-12 | M3 | `switchProject`의 `pickDirectory()`와 `confirm()`, `closeTab`의 `confirm()`이 실패하면 오류를 보여 줌. `closeTab`은 탭을 닫지 않음 | reject가 unhandled rejection이 되어 화면에 아무것도 없었음. 같은 실패를 `ProjectGate`만 처리했음(code review) |
| 2026-11-12 | M3 | 프로젝트를 바꾸면 모든 탭의 세션을 닫음(`reset`이 모두 `release`). 옛 세션의 닫기가 실패해도 무시 | Rust가 전환하고 화면이 reset하기 전에 시작된 실행의 세션이 새 프로젝트에서 열린 채 잊히는 창을 없앰. 옛 세션의 `closeSession`은 `unknown_session`으로 실패하고 무시됨(Ruling 11) |
| 2026-11-18 | 디자인 | 접속 색은 창 상단 bar(창 전체 폭, 모든 접속이 같은 두께), 탭 dot, toolbar의 접속 chip에만 씀. 오류, 트랜잭션, 연결 성공 같은 상태는 icon과 문장으로 구분하고 배경 tint를 쓰지 않음. 빨강(danger)은 위험 dialog의 실행 버튼과 에디터 오류 밑줄에만 | 접속 색은 사용자가 고르므로 상태 색과 겹치는 것을 막을 수 없음. prod(빨강) 탭에서 오류(빨강)가 나면 구분이 안 됨(디자인 리뷰) |
| 2026-11-18 | 디자인 | "운영" 같은 환경 구분 항목(`env`)을 `chilla.toml`에 두지 않음. 화면에서 "운영" label과 운영 전용 강조를 뺌 | 4.8이 이미 색으로 구분하기로 함. `color = "red"`에 의미를 붙이면 숨은 규칙이 생김. 운영 보호는 읽기 전용과 위험 쿼리 확인이 맡음 |
| 2026-11-18 | 디자인 | 읽기 전용 접속에서는 위험 쿼리 확인을 띄우지 않고 실행해 DB의 거부(SQLSTATE 25006)를 보여 줌 | 세션이 read only라 DB가 어차피 거부함. 확인 dialog의 "지웁니다" 문구가 사실과 달라짐 |
| 2026-11-18 | 디자인 | 탭의 접속은 toolbar에서만 바꿈. sidebar의 접속 목록은 추가와 수정에만 씀(M3 구현과 같음). 열린 트랜잭션이 있는 탭에서 접속을 바꾸면 탭 닫기처럼 Commit 또는 Rollback을 고르게 함. 스키마 탭은 활성 탭의 접속을 보여 줌 | 탭 = 세션 구조에서 접속을 바꾸는 곳이 두 군데면 sidebar를 누를 때 현재 탭이 바뀌는지 새 탭이 열리는지 알 수 없음 |
| 2026-11-18 | 디자인 | 트랜잭션이 열린 탭이 있을 때 앱을 끝내면 "모두 Rollback하고 끝내기"와 취소만 고름. 한꺼번에 Commit하는 선택지는 두지 않음 | 여러 탭의 변경을 한 번에 Commit하면 무엇이 반영되는지 확인하지 않고 넘어가게 됨. Commit하려면 취소하고 각 탭에서 함 |
| 2026-11-18 | 디자인 | 화면 문구는 영어가 기본, 한국어는 전역 설정 파일의 `language = "ko"`로 바꿈. 자체 TypeScript dictionary(`en`, `ko`)와 `t(key)`. 영어 dictionary로 옮기는 일은 M4, 한국어와 언어 설정은 M8 | 사용자 요청. library는 두 언어에 비해 큼. M3가 이미 한국어 문구를 써서 결과 표를 다시 만드는 M4에서 함께 옮김 |
| 2026-11-18 | 디자인 | 글꼴 2종: 화면은 macOS system font, SQL 에디터와 결과 data는 D2Coding 1.4.0(표준 build, Regular와 Bold). 공식 GitHub release에서 받아 앱에 넣음 | 사용자 선택. 한글 폭이 영문의 2배라 한글 주석과 data가 열에 맞음. 가나와 KS X 1001 한자는 있지만 일본 신자체와 중국어 간체는 없어 macOS font로 대신 그려짐(CoreText로 확인). ligature build는 `<>`, `->>`를 합쳐 SQL을 잘못 읽게 할 수 있어 쓰지 않음 |
| 2026-11-18 | 디자인 | 캔버스에 있는 기능은 모두 구현함. 캔버스 디자인 적용(token, 화면 틀)은 M4에서 함. 캔버스에서 생긴 작은 기능(트랜잭션 경과 시간과 문장 수, 실행 범위 강조와 버튼 label, 값 보기 panel, 복사 알림, 트리 항목 menu와 이름 복사, EXPLAIN tree와 원문 보기, DDL을 새 탭에 열기)을 기획서와 milestone M4~M9에 넣음 | 사용자 결정. 화면 모양을 정한 캔버스가 구현 범위의 기준이 되도록 함. M4는 결과 표를 다시 만들고 문구도 옮기므로 화면 틀을 함께 바꿈 |
| 2026-11-18 | 디자인 | 명령·파일·테이블 찾기(`Cmd+K`), `postgres://` URL 붙여넣기, 결과에서 찾기는 만들지 않음 | 기획서에 없는 기능. `Cmd+K`는 JetBrains macOS keymap의 VCS Commit이라 4.10과도 어긋남 |
| 2026-11-18 | M4 | TanStack Table(v9)은 column 정의와 너비 조절에만 씀. 몸통은 virtualizer의 index로 `rows[i]`를 바로 그림. 정렬(M10)이 row model을 쓰게 되면 그때 다시 봄 | row model(`getRowModel`)은 10만 행마다 `Row` object를 만들어 batch마다 수십 ms가 듦 |
| 2026-11-18 | M4 | 이어서 가져오기: 마지막으로 보이는 행이 보관된 행의 끝에서 100행(`FETCH_AHEAD`) 안이고 `fetch === "ready"`이면 `fetch_more`를 한 번 보냄. 다음 `rows`나 `finished`가 올 때까지 다시 보내지 않음. 맨 아래에 있으면 batch가 올 때마다 바로 다음을 요청함 | 스크롤 event가 batch 하나에 수십 번 와도 `fetch_more`는 한 번이어야 함. 맨 아래에서 끝까지 내려가는 동안 멈추지 않게 함 |
| 2026-11-18 | M4 | 버린 구간: `firstRow > 0`이면 몸통 맨 위에 높이 40px 줄("Rows 1–{n} were dropped · run again to see them"과 "Run again")을 둠. 앞쪽 행이 버려지면 `scrollTop`을 `(줄이 새로 생겼으면 40) − 버린 행 수 × 26`만큼 바꿈. "Run again"은 그 결과의 SQL을 지금 탭의 접속으로 다시 실행함 | 기획서 4.6의 "다시 실행해야 볼 수 있음" 표시. 스크롤 중에 앞쪽 행이 버려지거나 줄이 처음 생겨도 보던 행이 그 자리에 있어야 함 |
| 2026-11-18 | M4 | 컬럼 너비: 처음 너비는 header와 첫 batch의 값에 맞추고 64~480px로 자름. handle을 두 번 누르면 header와 보관된 행 중 앞 2,000행에 맞춤(같은 범위). 끌어서는 48px까지 줄임. 행 번호 column은 조절하지 않음. 실행마다 새로 정하고 저장하지 않음 | D2Coding의 advance가 반각 500, 전각 1000(unitsPerEm 1000)이라 값은 글자로 계산하고 canvas로 재지 않음(header 이름은 아래 header 너비 행). 100 KB 값이나 10만 행에서도 계산이 멈추지 않게 범위를 자름 |
| 2026-11-18 | M4 | 선택과 복사: 셀을 누르면 그 셀, 행 번호를 누르면 그 행, Shift와 누르면 범위를 고름. 셀 복사는 값 그대로(NULL은 빈 문자열), 행 복사는 header 없는 TSV. tab, 줄바꿈, CR, `"`가 든 값은 `"`로 감싸고 안의 `"`를 `""`로 씀. 복사하면 결과 panel 아래 가운데에 2초 동안 알림. 버린 구간의 행은 고를 수 없음 | Numbers, Google Sheets가 읽는 형식. 붙여 넣은 spreadsheet에서 칸이 밀리거나 NULL이 `NULL` 글자가 되지 않게 함 |
| 2026-11-18 | M4 | 표시: NULL은 fg-3 기울임의 `NULL`, 빈 문자열은 fg-3의 `''`. 300자를 넘는 값은 앞부분과 `…`만 그림(M3와 같음). 한 줄로 그리고 넘치면 `…`로 자름. column header의 type 표시와 숫자 오른쪽 정렬은 M8 | type 표시와 정렬은 column type이 필요한데 simple query protocol은 type OID를 주지 않음(M2 결정, M8에서 정함) |
| 2026-11-18 | M4 | 결과 header의 이름은 SQL의 첫 단어(대문자)와 `FROM`, `INTO`, `UPDATE`, `TABLE`, `JOIN` 뒤의 첫 이름. 없으면 첫 단어만(`SELECT users`, `UPDATE users`, `SELECT`). 32자에서 자름 | 캔버스의 결과 header처럼 무엇을 실행한 결과인지 보여 줌. 실행한 SQL text만으로 정함 |
| 2026-11-18 | M4 | 행을 돌려주지 않는 문장: 첫 단어가 `INSERT`, `UPDATE`, `DELETE`, `MERGE`면 "12 rows inserted/updated/deleted/merged", 그 밖은 "Done". 캔버스의 `UPDATE 12`는 그리지 않음 | 화면이 서버의 command tag를 받지 않음. 영향받은 행 수와 첫 단어로 문장을 만듦 |
| 2026-11-18 | M4 | 오류 화면은 서버 메시지(mono 15), detail, hint, `SQLSTATE`, 줄과 칸, 소요 시간, "Copy message" 버튼. 빨간 글자가 아니라 icon과 문장으로 구분함. "Go to error"는 M8 | "Go to error"는 에디터의 오류 밑줄(M8)과 한 기능. Tokens의 규칙(danger는 위험 dialog의 실행 버튼과 오류 밑줄에만) |
| 2026-11-18 | M4 | toolbar: 접속 chip과 접속 menu, 너비를 고정한 split 실행 버튼(왼쪽 200px, 오른쪽 26px). 실행 중에는 같은 자리가 227px의 Cancel 버튼. 오른쪽 menu의 "Run file"은 M8까지 disabled. Auto/Manual(M6), Reformat(M8), Explain(M9)은 넣지 않음. Save 버튼은 뺌(`Cmd+S`는 그대로) | 캔버스에 Save 버튼이 없음. label이 바뀌는 버튼은 너비를 고정해 옆이 밀리지 않게 함. 나머지는 해당 마일스톤의 기능 |
| 2026-11-18 | M4 | sidebar: Files, Schema, History 탭 중 Schema(M7)와 History(M9)는 disabled. 파일 목록은 디렉토리 tree이고 처음에는 모두 펼침 | 캔버스의 sidebar 틀. Schema와 History는 해당 마일스톤의 기능 |
| 2026-11-18 | M4 | 접속 색: `chilla.toml`의 `color`가 `green`, `yellow`, `red`, `blue`, `purple`이면 그 token, 아니거나 없으면 line-2(회색). 창 상단 bar, 탭 dot, toolbar chip, sidebar와 접속 menu의 dot에만 씀. 값 검사와 접속 sheet의 `color` 칸은 M6 | 기획서 4.1의 고를 수 있는 색 다섯. 값 검사와 `color` 칸은 M6 범위 |
| 2026-11-18 | M4 | 결과 panel 높이는 396px로 시작하고 에디터와의 경계(5px)를 끌어 바꿈. 에디터와 결과 panel은 각각 120px 밑으로 줄지 않음. 저장하지 않음 | 어느 쪽도 쓸 수 없을 만큼 줄지 않게 함. 화면 설정을 저장할 곳(전역 설정 파일)은 M8 |
| 2026-11-18 | M4 | 빈 상태: 결과 panel과 탭이 없는 에디터는 `⌘↵ Run statement at cursor`, `⇧⌘L New tab`을 보여 줌. 캔버스의 `⌥⌘L Reformat`은 M8에 더함 | Reformat은 M8 기능 |
| 2026-11-18 | M4 | 화면 문구는 영어 dictionary `en`(`src/shared/i18n/en.ts`)과 `t(key, params)`. 복수형은 key 끝의 `.one`/`.other`를 `tc(key, count)`가 고름. 숫자는 `en-US` 묶음(`124,500`). Rust가 보내는 오류 message도 영어로 바꿈(M1~M3의 "사용자에게 보이는 message는 한국어"를 대신함). 한국어는 M8에서 오류 `kind`별로 화면이 번역함. macOS menu는 이미 영어라 M4에서 고치지 않음 | 영어 기본, 한국어 M8(2026-11-18 디자인 결정). Rust message가 한국어로 남으면 영어 화면에 섞임 |
| 2026-11-18 | M4 | 확인 dialog는 native(`ask`)로 두고 문구만 영어로 옮김. 캔버스의 dialog 모양은 M6에서 Commit/Rollback을 고르는 dialog를 만들 때 함께 바꿈. 이름 없는 탭의 저장 경로 입력은 캔버스의 "Save Query 1" dialog로 바꿈 | Commit/Rollback dialog(M6)와 같은 모양이라 한 번에 만듦. 저장 경로 입력은 이미 화면의 form이라 지금 바꿀 수 있음 |
| 2026-11-18 | M4 | 접속 sheet와 프로젝트 열기 화면은 token, 버튼, 문구만 바꾸고 배치는 그대로 둠. sheet 배치는 M5, 프로젝트 열기 화면은 M8에서 캔버스대로 바꿈 | 배치를 바꾸는 일을 `tunnel` 칸(M5), 최근 프로젝트 목록(M8)을 더할 때 한 번에 함 |
| 2026-11-18 | M4 | release 빌드 서명: `scripts/build-app.sh [--debug]`가 `pnpm tauri build --bundles app` 뒤 dev 빌드와 같은 identity, identifier `com.yuiyeong.chillasql`로 `codesign --force --deep`함. identity 고르기는 `scripts/signing-identity.sh` 하나에 두고 `cargo-runner.sh`도 이것을 source함. `bundle.macOS.signingIdentity`는 쓰지 않음 | dev binary(`pnpm tauri dev`)가 만든 키체인 항목을 release `.app`이 확인 창 없이 읽음(`KEYCHAIN_PROBE 16.84 existing`, debug `.app` 15.13과 16.61). `codesign -dvv`는 `Identifier=com.yuiyeong.chillasql`, Authority `Apple Development`, `Signature=adhoc` 없음 |
| 2026-11-18 | M4 | overlay title bar: 창에 `titleBarStyle` `Overlay`, `hiddenTitle`, `trafficLightPosition` `{ "x": 13, "y": 24 }`. drag 줄은 `data-tauri-drag-region`이고 capability에 `core:window:allow-start-dragging`을 더함 | 계획 값 `{14, 22}`에서 첫 원의 중심이 (21, 20)pt였음. 이 macOS의 신호등 원은 지름 14pt이고, tao는 x를 버튼 왼쪽 끝, y를 버튼 높이에 더한 container 높이로 씀. 고친 값에서 중심 (20.0, 22.0)pt(3px bar + 38px 줄의 가운데). 38px 줄을 끌면 창이 끈 만큼(100, 50) 움직이고, 두 번 누르면 zoom되고 다시 누르면 돌아옴. zoom 뒤에도 신호등 위치 같음 |
| 2026-11-18 | M4 | 결과 표의 `Cmd+C`는 DOM `copy` event로 처리함(Task 7). 결과 표에 focus가 있을 때만 `clipboardData.setData("text/plain", …)`와 `preventDefault()`. menu의 Copy와 `Cmd+C`가 한 경로 | 글자 선택이 없는 `tabIndex=0` div에서 `Cmd+C`를 누르면 `keydown`(`code` `KeyC`, `metaKey`)과 `copy` event가 둘 다 옴. `copy`의 target은 focus된 그 div이고 setData 값이 pasteboard에 들어감(`pbpaste` `PROBE_COPY_1`). Edit menu의 Copy를 눌러도 같은 `copy` event가 옴. CodeMirror에서 고른 text의 `Cmd+C`는 M3처럼 그 text가 복사됨 |
| 2026-11-18 | M4 | clipboard는 `tauri-plugin-clipboard-manager` 2(2.5.0)와 permission `clipboard-manager:allow-write-text`. 화면은 `copyText`(`src/shared/api/clipboard.ts`)로 씀 | 결과 header의 복사 버튼과 "Copy message"처럼 `copy` event 밖에서 복사할 때 씀. `copyText("a\tb")` 뒤 `pbpaste`가 `a<TAB>b`이고 CSP violation 없음 |
| 2026-11-18 | M4 | D2Coding은 `public/fonts/`에 두고 `@font-face`의 `url("/fonts/…")`로 읽음. CSP는 바꾸지 않음 | 빌드된 앱에서 `document.fonts.check("13px D2Coding")`이 `true`, FontFace status `loaded`, `a가` 폭 19.5px(반각 6.5 + 전각 13. monospace는 19.05). `default-src 'self'`에 막히지 않음 |
| 2026-11-18 | M4 | 행 번호 column의 폭은 `en-US`로 묶은 행 번호(쉼표 포함)의 글자 수로 셈: `max(52, 글자 수 × 6.5 + 20 + 1)` | 화면에 그리는 것이 `1,000,000`처럼 쉼표가 든 글자라 자릿수만 세면 좁아짐. `+ 1`은 칸의 `border-r`(아래 border 행) |
| 2026-11-18 | M4 | 새 실행은 `ResultGrid`를 다시 mount함(key `${startedAt}:${sql}`). 선택, 스크롤 위치, 컬럼 너비가 처음으로 돌아감. 같은 실행이 `running`에서 `finished`로 바뀔 때는 mount를 유지함 | 앞 결과의 선택은 새 결과의 다른 행과 칸을 가리키고, 스크롤 위치와 컬럼 너비는 앞 결과의 행 수와 column에 맞춘 값이라 새 결과에 남으면 안 됨. table과 virtualizer도 앞 결과의 상태를 들고 있어 다시 만듦. 같은 실행 안에서는 batch마다 `result` object가 바뀌어도 상태를 이어 감 |
| 2026-11-18 | M4 | 앞쪽 행이 버려진 commit에서는 이어서 가져오기 검사를 건너뜀. 위치를 당긴 뒤의 scroll event가 다시 셈 | 그 commit의 보이는 범위는 당기기 전 scroll 위치로 센 것이라, 검사하면 맨 아래로 보고 batch마다 다음을 요청해 결과 전체를 가져옴 |
| 2026-11-18 | M4 | `Button`에 `size="small"`(높이 24px, 13px 글자)을 더함. 표 안의 "Run again"에 씀 | 캔버스 States의 "Run again"이 높이 24px, 13px 글자임. 기본값(28px)은 그대로 |
| 2026-11-18 | M4 | 에디터와 결과 panel의 경계는 keyboard로 움직이지 않음(mouse만) | 기획서와 계획이 요구하지 않고 mouse로 쓰는 desktop 앱임. 필요하면 화살표 key로 나중에 더할 수 있음 |
| 2026-11-18 | M4 | 연결 중(`connecting`)에도 Cancel 버튼을 보여 주되 disabled로 둠 | 기획서 4.5가 취소하는 것은 실행 중인 쿼리임. 세션이 열리기 전에는 취소할 것이 없고 연결은 10초 timeout이 끝냄. 버튼 자리와 너비는 실행 중과 같음. 대가로 느린 연결에서는 최대 10초를 기다림 |
| 2026-11-18 | M4 | toolbar의 진행 막대는 toolbar 아래에 absolute로 겹쳐 그림. 캔버스처럼 흐름 안에 두지 않음 | 막대가 나타나고 사라질 때 에디터가 밀리지 않게 함. 대가로 막대가 에디터의 맨 위 2px를 덮음 |
| 2026-11-18 | M4 | overlay 배경은 `--color-scrim`(검정 50%, 캔버스 값), popover와 dialog의 그림자도 token(`--shadow-popover`, `--shadow-dialog`)으로 둠. Tailwind 기본 palette는 `--color-*: initial`로 끄고 source 규칙 test(기본 palette class, `#hex`, `rgb(` literal 금지)로 지킴 | 색은 Tokens의 token으로만 쓴다는 규칙(Global Constraints)을 사람이 아니라 test가 확인하게 함 |
| 2026-11-18 | M4 | 접속 form의 테스트와 저장 결과는 icon과 문장 한 줄로 그림. 캔버스의 테두리 있는 안내 상자는 쓰지 않음 | 계획(Task 12)이 결과 줄을 icon과 문장으로 정함. 상태는 icon과 문장으로 구분한다는 Tokens의 규칙과 같음. icon도 접속 색을 쓰지 않음 |
| 2026-11-18 | M4 | 자동 너비와 행 번호 column에 칸의 `border-r` 1px을 더함(`CELL_BORDER`): `내용 + 20 + 1` | 칸이 `box-sizing: border-box`라 border가 너비 안에 들어감. 빼면 가장 긴 값과 행 번호가 1px 모자라 `…`로 잘렸음(M4 Task 13) |
| 2026-11-18 | M4 | column header 이름의 너비는 `OffscreenCanvas`의 `measureText`로 잼. 글꼴은 index.css token(`--font-weight-semibold`, `--text-small`, `--font-sans`)으로 만듦. canvas나 token이 없으면(jsdom) 반각 한 칸 9px로 어림함. 값은 그대로 D2Coding 반각으로 셈 | header는 system font 13px semibold라 D2Coding 반각(6.5px)으로 세면 `amount`가 `amo…`로 잘렸음. system font는 글자마다 폭이 달라 글자 수로 셀 수 없음(13px semibold에서 `amount` 7.96px, `name` 8.65px, `m` 11.7px/글자) |
| 2026-11-18 | M4 | 결과 표에 focus가 있을 때 `Home`, `End`, `Cmd+Up`, `Cmd+Down`은 표가 처리해 `scrollTop`을 맨 위나 맨 아래로 바로 옮김(애니메이션 없음). `PageUp`, `PageDown`, wheel은 그대로 둠 | WebKit은 `End`를 약 200ms 애니메이션으로 스크롤하는데 frame마다 수천 행을 지나가 화면이 행보다 먼저 움직여 빈 몸통이 약 130ms 보였음(M4 Task 13). 바로 옮기면 scroll event가 한 번이고 그 frame에 행이 그려짐. PageDown은 한 frame에 overscan(10행)보다 덜 움직임 |
| 2026-11-18 | M4 | 복사 알림은 결과 panel(`relative`)의 아래 가운데, 바닥에서 12px에 띄움(`absolute`). 캔버스(TabsConn 6)의 위치 | 창 기준(`fixed`)이면 결과 panel이 아니라 창 가운데에 뜸. panel 안이라 아래 24px status bar를 가리지 않음 |
| 2026-11-18 | M4 | `t()`는 param을 주어진 그대로(`String(value)`) 씀. 1000 단위로 묶을 number는 호출하는 쪽이 `formatCount`로 넘기고, `tc()`만 `count`를 묶음 | 줄, 칸, 탭 번호처럼 묶으면 안 되는 number를 쓰는 쪽마다 `String()`으로 감쌌음. 묶는 것을 드러내 쓰는 편이 읽기 쉬움(simplify) |
| 2026-11-18 | M4 | `connectionColor`는 색을 정하지 않았거나 모르는 이름이면 null이 아니라 `var(--color-line-2)`를 돌려줌. 8px 접속 dot은 `ConnectionDot` 하나로 그리고 접속이 없으면 속이 빈 원 | toolbar, 창 위 bar, sidebar, 탭 줄이 같은 fallback과 dot markup을 따로 가졌음(simplify) |
| 2026-11-18 | M4 | 끝난(`finished`) 결과는 reducer가 `fetch`를 `none`으로 둠. 표는 `fetch`만 보고 다음 batch를 요청함 | 끝난 결과가 마지막 `fetch` 값을 그대로 가져서 결과 panel, 표, footer가 각각 따로 막았음(simplify) |
| 2026-11-18 | M4 | `Kbd`는 `aria-hidden`이고 단축키는 그 버튼이나 menu 항목의 `aria-keyshortcuts`(`Meta+Enter`, `Meta+F2`)로 알림. 단축키 표시와 `aria-keyshortcuts`는 `shortcuts.ts`의 keymap에서 만듦 | 버튼 이름에 `⌘↵` 같은 기호가 붙어 읽혔고, 표시가 keymap과 따로 적혀 있었음(simplify) |
| 2026-11-18 | M4 | 저장 경로 dialog와 접속 form은 dialog 틀과 input class를 공유하지 않음 | 저장 경로 dialog는 캔버스 Dialogs(radius 12px, input 32px `bg-0`)를 따르고, 접속 form은 M3의 모양(radius 10px, input 28px `bg-1`)이라 하나로 모으면 어느 한쪽이 바뀜. 접속 form은 M5에서 캔버스의 sheet로 다시 만들 때 맞춤(simplify에서 뺀 항목) |
| 2026-11-18 | M4 | 결과 표의 view(열 너비, 선택, 스크롤 위치)를 탭마다 하나씩 module의 Map(`gridViews.ts`)에 둠. 표가 사라질 때(layout effect cleanup) 한 번 저장하고, 같은 실행(`startedAt`과 `sql`)으로 돌아오면 이어 감. 그 사이 앞 행이 버려졌으면 스크롤을 그만큼 당김. 다시 실행하면 처음부터 그리고, `release`(탭 닫기, 접속 바꾸기)와 `reset`(프로젝트 바꾸기)이 지움 | 결과 panel 하나를 모든 탭이 같이 써서 탭을 바꿨다 돌아오면 표가 다시 mount되어 직접 맞춘 너비, 선택, 스크롤을 잃고 자동 너비를 다시 셌음. 스크롤마다 저장하지 않아 frame마다 하는 일은 늘지 않음(code-review) |
| 2026-11-18 | M4 | `fetch_more`가 실패해도 `fetch`를 `fetching`에서 되돌리거나 다시 요청하지 않음 | Rust의 `fetch_more`는 그 세션이 발급한 query id면 끝난 쿼리에도 `Ok`(M2)라 실패는 세션이 없어졌을 때뿐이고, 그때는 `release`/`reset`이 상태를 지우거나 `connection_lost`로 끝남. 실패마다 다시 요청하면 되풀이될 수 있음. 틀렸다면 Run again 전까지 spinner가 남음(code-review에서 고치지 않은 지적) |
| 2026-11-18 | M4 | Run again은 처음 실행의 `origin`(문서 안 위치)을 그대로 씀 | 다시 보내는 text가 지금 문서에 없을 수 있어, 그 text를 가져온 때의 위치가 정해진 유일한 위치임. 고친 문서에 맞춰 옮기는 것은 M8의 오류 위치로 가기와 함께 다룸. 그 사이 문서를 고쳤으면 오류의 Ln/Col이 옛 자리를 가리킬 수 있음(code-review에서 고치지 않은 지적). M8은 처음 text와 옮겨진 위치를 씀(2026-11-20 M8 "오류 위치" 줄) |
| 2026-11-18 | M4 | 결과 탭 label과 행 수 문구는 SQL을 token으로 나눠 정함. 문자열(`'…'`, `E'…'`, `$tag$…$tag$`)과 주석은 건너뛰고, 앞의 `(`를 건너뛰고, 대상 앞의 `IF NOT EXISTS`, `IF EXISTS`, `ONLY`를 건너뜀. `WITH`는 CTE 목록 뒤 같은 괄호 깊이의 첫 `INSERT`/`UPDATE`/`DELETE`/`MERGE`/`SELECT`를 본 문장으로 봄. 첫 단어가 없으면 label은 `Result`. 함수 안의 `FROM`(`extract(year FROM ts)`)은 가려내지 않음 | 함수 안의 `FROM`을 가려내려면 parser가 필요함. 틀려도 label이 조금 이상할 뿐임(code-review에서 일부만 고친 지적) |
| 2026-11-19 | M5 | 1단계 결과를 써 보는 기간 없이 M5를 시작함 | 1단계는 기능이 모자라 실제로 쓸 수 없음(사용자 결정). 기획서 8장을 고침 |
| 2026-11-19 | M5 | M5 완료 확인은 사용자가 고른 실제 터널 접속으로 하고, 그 명령과 서버 이름은 문서에 적지 않음. 문서의 예시는 지어낸 값(`ssh -N -L 25432:db.internal:5432 bastion`)을 씀 | 실제 명령은 private이고 저장소는 public이 될 수 있음(사용자 지시) |
| 2026-11-19 | M5 | `chilla.toml`의 `tunnel_timeout`은 초 단위 정수(1~300), 없으면 20초. `tunnel` 없이 쓰거나 빈 `tunnel`은 오류. 연결 대상이 아니라 바꿔도 비밀번호를 지우지 않음 | 캔버스가 제안한 key 이름. `sslrootcert`와 `sslmode`의 관계와 같게 둠 |
| 2026-11-19 | M5 | 터널 명령은 프로젝트 디렉토리를 cwd로 `$SHELL -l -c <tunnel>`(`SHELL`이 없거나 상대 경로면 `/bin/zsh`)로 새 process group에서 실행. stdin, stdout은 `/dev/null`, stderr는 끝 16 KiB | Finder로 띄운 앱에도 `SHELL`이 있고 login shell이 `.zprofile`의 PATH로 CLI를 찾음. 실행한 디렉토리로 project를 찾는 터널 CLI가 있음(Task 1) |
| 2026-11-19 | M5 | 터널을 끌 때 process group과 자손 프로세스 tree 전체에 `SIGTERM`, 2초 뒤 남은 것에 `SIGKILL` | 터널 CLI가 ssh를 다른 process group으로 띄우고 `SIGTERM`, `SIGINT`를 받아도 ssh를 남김(Task 1). group만 끄면 포트가 열린 채 남음 |
| 2026-11-19 | M5 | 실행한 프로세스나 포트가 열린 때의 자손 가운데 하나라도 끝나면 터널이 끊긴 것으로 보고 1초 뒤 다시 실행. 포트가 열리면 횟수를 처음으로, 연속 3번 실패하면 멈춤. 멈춘 터널은 다음 세션 열기나 Try again이 처음부터 다시 시작 | 터널 CLI는 ssh 자식이 죽어도 살아 남음(Task 1). 포트를 주기적으로 붙어 보면 DB 서버 log에 `incomplete startup packet`이 쌓여 쓰지 않음 |
| 2026-11-19 | M5 | 포트는 명령을 실행하기 전에 한 번, 실행한 뒤 200ms마다 확인(시도마다 500ms). 실행 전에 열려 있으면 `External`로 명령을 실행하지 않고 끄지도 감시하지도 않음 | 기획서 4.2의 "포트가 이미 열려 있음" |
| 2026-11-19 | M5 | DB 재연결은 다음 실행에서 함. 터널이 다시 시작되면 그 접속을 쓰는 탭의 세션을 stale로 두고, 다음 실행이 새 세션을 먼저 연 뒤 옛 세션을 닫음. 끊긴 세션을 새 세션이 대신하면 "Reconnected" banner. 터널 없는 접속의 `connection_lost` 뒤에도 같음 | 옛 세션을 먼저 닫으면 lease가 0이 되어 막 살린 터널이 꺼짐. 쓰지 않는 탭까지 미리 연결하지 않음 |
| 2026-11-19 | M5 | 같은 접속 이름의 터널은 하나. 같은 이름의 터널이 다른 대상이거나 끄는 중이면 꺼질 때까지 기다린 뒤 새로 시작 | 연결 대상을 고쳐 저장한 직후 옛 터널의 포트를 `External`로 잘못 보지 않게 함 |
| 2026-11-19 | M5 | 접속 테스트의 터널은 공유하지 않고 테스트가 끝나면 끔. 포트가 열려 있으면 띄우지 않음 | 저장하지 않은 접속 정보로 띄운 터널을 세션이 쓰지 않게 함 |
| 2026-11-19 | M5 | 터널 시작 중의 Cancel은 그 접속의 터널 시작을 멈춤(같은 터널을 기다리던 다른 탭의 실행도 멈춤). 멈춘 실행의 결과 panel은 빈 상태 | 터널 대기는 20초까지 걸려 M4의 "연결 중 Cancel disabled"로는 기다릴 수밖에 없음 |
| 2026-11-19 | M5 | 터널 상태는 Tauri event `tunnel`(`{ connection, state }`)로 보냄. 터널 오류는 Rust의 영어 message와 stderr(`CommandError.output`)를 그대로 보여 줌 | 화면이 터널 상태를 탭과 toolbar에 그려야 함 |
| 2026-11-19 | M5 | 탭에 시작 중, 재실행 중, 실패, `External` 상태 icon을 그림 | 캔버스는 `External`만 그리지만 마일스톤이 탭의 터널 상태를 요구함 |
| 2026-11-19 | M5 | 앱이 비정상 종료하면 터널이 남을 수 있음. 다음에는 그 포트를 `External`로 봄 | 정상 종료(`Cmd+Q`, 창 닫기)만 터널을 끔 |
| 2026-11-19 | M5 | 접속 sheet는 캔버스 배치에서 `color`(M6), `read_only`와 `statement_timeout`(M8)을 뺌. 창 위쪽에 붙는 600px sheet. 테스트 성공은 `Connected · {ms} ms`, server version은 M8 | 각 칸은 그 기능의 마일스톤에서 더함 |
| 2026-11-19 | M5 | `establish`와 `PgCancel`의 stream 여는 분기는 묶지 않음 | 터널은 local port를 열 뿐이라 여는 방법이 바뀌지 않음 |
| 2026-11-19 | M5 | 터널이 다시 시작될 때 세션을 바꾸는 판단(stale 표시, 새 세션을 먼저 열기)은 화면에 둠. Rust가 세션을 `Lost`로 표시하거나 `reopen_session`을 두는 안은 쓰지 않음 | 계획에서 정한 구조이고 바꾸면 App과 session actor에 상태가 늘어남. 화면이 event 하나를 놓치면 다음 실행이 `connection_lost`로 끝나고 그다음 실행이 새 세션을 엶(simplify에서 고치지 않은 지적) |
| 2026-11-19 | M5 | 재실행 뒤 멈춤(`afterRestart`)은 화면이 event 순서로 가림. Rust 상태에 `GaveUp`을 더하지 않음 | event는 한 channel로 순서대로 오고, 바꾸면 DTO와 화면 type이 함께 바뀜(simplify에서 고치지 않은 지적) |
| 2026-11-19 | M5 | 세션을 닫을 때 터널이 꺼질 때까지 기다림(`close_session`이 늦어질 수 있음) | DB disconnect 뒤 터널 종료 순서와 "닫힌 뒤 프로세스가 남지 않음"을 지키는 가장 단순한 방법. 키체인 읽기와 터널 시작을 동시에 하는 것도 하지 않음(simplify에서 고치지 않은 지적) |
| 2026-11-19 | M5 | 같은 터널인지는 명령, 디렉토리, host, port로 가림. `tunnel_timeout`만 다르면 열린 터널을 같이 씀 | 대기 시간만 바꿔 저장하면 화면이 세션을 닫지 않아(연결 대상 아님) 새 세션 열기가 옛 터널이 꺼지기를 끝없이 기다렸음(code-review) |
| 2026-11-19 | M5 | 터널이 표에서 빠질 때는 실패로 멈춘 터널도 `Stopped`를 보냄. 처음 시작에서 실패하면 toolbar chip의 `Tunnel failed`는 곧 사라지고 결과 panel의 오류가 남음 | 화면이 없어진 터널의 실패 상태를 계속 갖고 있어 Try again이 아무것도 하지 않았음(code-review). 캔버스 Tunnel 2의 chip과 다름 |
| 2026-11-19 | M5 | 터널이 끊기면 남은 자손을 끄기 전에 `Starting{1}`부터 알림. 같은 상태는 두 번 알리지 않음 | 끄는 데 2초까지 걸리는 동안 새 세션이 끊긴 터널을 열린 것으로 보고 연결 오류를 냈음(code-review) |
| 2026-11-19 | M5 | 자손이 살아 있는지는 `kill(pid, 0)`(EPERM도 있음)과 zombie 확인으로 봄 | `proc_pidinfo`는 다른 사용자의 프로세스(sudo로 띄운 ssh 등)를 읽지 못해 죽은 것으로 보고 멀쩡한 터널을 다시 실행했음(code-review) |
| 2026-11-19 | M5 | 터널이 다시 시작될 때 여는 중인 세션은 stale로 두지 않음 | 다시 시작된 터널로 붙는 세션까지 다음 실행이 바꾸고 Reconnected를 띄웠음(code-review) |
| 2026-11-19 | M5 | 접속 테스트의 터널이 떠 있는 동안 같은 포트로 시작한 공유 터널이 `External`이 되는 경우는 고치지 않음 | 테스트와 실행을 동시에 하는 드문 경우이고, 테스트 터널이 꺼진 뒤 다음 실행이 포트가 닫힌 것을 보고 터널을 새로 띄움(code-review에서 고치지 않은 지적) |
| 2026-11-19 | M5 | 끌 때 기억한 pid가 다른 프로세스에 다시 쓰였는지 확인하지 않음 | 2초 안에 pid가 다시 쓰일 가능성이 매우 낮음. 확인하려면 pid마다 시작 시각을 기억해야 함(code-review에서 고치지 않은 지적) |
| 2026-11-19 | M5 | 끊긴 세션을 화면이 event로 추정하는 구조는 그대로 둠 | simplify의 같은 지적과 같은 이유(code-review에서 고치지 않은 지적) |
| 2026-11-19 | M5 | 기획서, 마일스톤, 계획, 디자인 사본, test에 있던 실제 터널 명령과 서비스·프로젝트 이름을 지어낸 예시(`ssh -N -L 25432:db.internal:5432 bastion`, `app`, `billing`)로 바꿈 | 실제 환경 정보가 public 저장소에 남지 않게 함(사용자 지시). git history에는 남아 있음 |
| 2026-11-19 | M6 | M1의 `TxTap`이 읽은 트랜잭션 상태를 session actor가 쿼리마다 `Finished`의 `tx`에 실어 화면으로 보냄 | `TxTap`이 ReadyForQuery의 상태 byte를 읽고 actor가 쿼리가 끝날 때마다 `tx_status()`를 저장함(`settle`). 지금은 `session_state` command로만 나가고 화면이 부르지 않음. 화면이 따로 묻지 않으면 순서가 꼬이지 않음 |
| 2026-11-19 | M6 | Commit은 `Opt+Shift+Cmd+Enter`, Rollback은 `Opt+Shift+Cmd+Z`. 디자인의 Commit `Opt+Shift+Cmd+K`는 쓰지 않음. 기획서 4.10과 9장을 고침 | DataGrip의 Commit과 Rollback 단축키는 같은 JetBrains DatabaseTools plugin(이 Mac의 PyCharm 2026.2)의 `plugin.xml`에서 확인함. `Console.Transaction.Commit`은 `$default` keymap에 `control alt shift ENTER`이고 macOS keymap은 `control`을 `meta`로 바꿈. `Console.Transaction.Rollback`은 단축키가 없어 디자인의 값을 씀. 웹의 keymap 문서에는 두 action이 나오지 않음 |
| 2026-11-19 | M6 | Manual 모드의 `BEGIN`은 Rust가 보냄. 실행마다 `TxMode`를 싣고, actor가 Manual 실행을 받았는데 트랜잭션 밖(`Idle`)이면 그 쿼리 전에 `BEGIN`을 보냄. `BEGIN`이 실패하면 그 오류로 쿼리를 끝냄. Manual에서 트랜잭션 안에서 못 도는 문장(`VACUUM`, `CREATE DATABASE`)은 서버 오류가 남(DataGrip과 같음) | 모드는 화면의 탭 상태이고 세션은 기억하지 않음. 그래서 세션이 바뀌어도(재연결, 접속 바꾸기) 모드가 그대로임 |
| 2026-11-19 | M6 | 트랜잭션 문장 수는 `Finished`의 `tx`가 열린 채(`in_transaction`)로 `completed`된 실행만 셈. 실패하거나 취소된 문장은 세지 않음. 트랜잭션을 연 실행이 Auto 모드면 사용자가 쓴 `BEGIN`이므로 세지 않고, Manual 모드면 앱이 `BEGIN`을 붙인 사용자 문장이므로 셈. 사용자가 쓴 `BEGIN`(Auto)으로 열린 문장 0개의 트랜잭션은 `manual BEGIN`이라고 쓰고(TabsConn 3), 앱이 연 트랜잭션(Manual)은 첫 문장이 실패해 0개여도 `0 statements`라고 씀(code-review). 밀려난 실행의 `finished`는 세지 않고 상태(열림, 실패, 없음)만 따름 | 서버에 들어가 트랜잭션에 남은 문장만 사용자가 한 일로 보이게 하려고. 캔버스(TabsConn 3)가 `manual BEGIN`을 보임 |
| 2026-11-19 | M6 | 트랜잭션 경과 시간은 트랜잭션을 연 실행이 시작한 시각(`ResultData.startedAt`)부터 셈. 탭은 `TX 3:12`, toolbar는 `Open · 2 statements · 3:12`, 실패는 `Failed · 2 statements · 3:12`이고 Commit이 disabled | 트랜잭션이 열린 시각을 따로 서버에 묻지 않고 화면이 이미 가진 값으로 셈 |
| 2026-11-19 | M6 | Commit과 Rollback은 actor 명령 `end_transaction`. 지금 쿼리가 있으면 cancel하고 그 문장을 savepoint로 되돌린 뒤 보내고, 기다리던 다음 쿼리는 끝내기 뒤에 실행함. 실패 상태에서 온 Commit은 보내지 않고 `TransactionFailed`로 답함. `COMMIT`이 서버 오류로 실패하면(deferred constraint) 그 오류를 결과 panel에 그리고 트랜잭션은 끝난 것으로 둠 | 끝내기가 기다리는 쿼리에 밀려 사라지면 안 됨. 서버는 실패한 트랜잭션의 `COMMIT`을 `ROLLBACK`으로 처리하므로 그대로 보내면 Commit이 된 것처럼 보임 |
| 2026-11-19 | M6 | Commit, Rollback, Auto/Manual 전환은 탭이 연결 중이 아니고, 실행 중이면 batch를 기다리는 중(`fetch: "ready"`)일 때만 가능. 쿼리를 읽고 있는 동안은 disabled(먼저 Cancel) | 읽는 중에 끝내기를 보내면 읽던 결과의 처리가 겹침 |
| 2026-11-19 | M6 | 닫기 전 확인의 Rollback은 명시적으로 `ROLLBACK`을 보낸 뒤 닫음. 실패해도(연결이 끊김) 진행함. `Commit and …`은 Commit이 성공해야 진행하고 실패하면 멈추고 오류를 보임. 실패 상태인 트랜잭션의 확인에는 Commit 버튼이 없음 | 세션이 닫히면 서버가 어차피 되돌리므로 Rollback 실패는 막을 이유가 없음. Commit은 실패하면 사용자가 모르는 채 데이터를 잃음 |
| 2026-11-19 | M6 | 여러 탭의 확인(연결 대상 저장, 프로젝트 바꾸기)은 앱 종료와 같은 모양. 열린 트랜잭션이 있는 탭이 둘 이상이면 탭 목록과 `Roll back all and …`, Cancel만 둠. 한 탭이면 Commit, Rollback, Cancel | 한꺼번에 Commit하지 않는다는 앱 종료의 결정(2026-11-18)과 같은 이유 |
| 2026-11-19 | M6 | 앱 종료의 `Roll back all and quit`은 `ROLLBACK`을 따로 보내지 않음. `quit_app`이 `shutdown`으로 세션을 닫고 서버가 되돌림 | 종료를 오래 막지 않으려고 |
| 2026-11-19 | M6 | 확인 순서는 트랜잭션 확인이 먼저, 저장하지 않은 변경 확인이 다음. 고른 Commit/Rollback은 취소되거나 실패할 수 있는 뒤 단계(저장 확인, 저장, 접속 저장, 폴더 고르기)가 끝난 뒤에 보냄(code-review). 프로젝트 바꾸기의 Rollback은 따로 보내지 않고 열기가 옛 세션을 닫는 것에 맡기고, Commit은 열기 전에 보냄 | 취소하거나 실패했는데 트랜잭션만 끝나 있으면 안 됨. 프로젝트 열기(`open_project`)는 `chilla.toml`을 읽은 직후 옛 세션을 닫으므로 Commit을 열기 뒤로 미룰 수 없음. 그래서 Commit을 골랐는데 열기가 실패하면 Commit만 된 채 남음(사용자가 Commit을 골랐으므로 잃는 데이터는 없음) |
| 2026-11-19 | M6 | 트랜잭션 중 끊김: 열린 트랜잭션이 있는 탭에서 (a) 그 접속의 터널이 다시 시작되면(stale) 바로, (b) 실행이 `connection_lost`로 끝나거나 세션이 없어졌으면(`unknown_session`) 그때, 결과 panel 위에 `Transaction lost` 알림(Tunnel 6)을 띄우고 트랜잭션 정보를 지움. 알림은 OK나 다음 실행이 지움. 터널 없는 접속은 다음 실행에서야 끊김을 앎 | 다음 실행이 옛 트랜잭션이 이어지는 것처럼 보이면 안 됨. 서버는 연결이 끊기면 트랜잭션을 되돌리므로 사용자에게 알려야 함 |
| 2026-11-19 | M6 | 받다 만 결과 자동 닫기: batch를 보내고 `fetch_more`를 10분 동안 받지 못하면 actor가 결과를 버리고 새 outcome `expired`로 끝냄. 시간은 `QueryLimits.idle_result_timeout`(600초). 설정 파일로 바꾸는 것은 M8 | 기획서 4.6의 기본값 10분. DB에 쿼리가 열려 있지 않게 함 |
| 2026-11-19 | M6 | 트랜잭션 안에서 버리기와 취소: actor가 트랜잭션 안의 문장마다 앞에 `SAVEPOINT chilla_statement`를 둠(앞 것은 같은 simple query에서 `RELEASE`, Manual의 첫 문장은 `BEGIN; SAVEPOINT …`). 다음 실행, Commit/Rollback, 10분 자동 닫기, 사용자 Cancel이 그 문장을 버리면 바로 cancel하고, 결과와 cancel task가 끝난 뒤 `ROLLBACK TO SAVEPOINT chilla_statement`로 그 문장만 되돌림. 트랜잭션은 열린 채 남고 outcome은 `discarded`/`cancelled`/`expired`. cancel이 늦어 문장이 끝까지 돌았어도, 버리는 중에 문장이 스스로 실패했어도 되돌림. 사용자가 쓴 `SAVEPOINT`, `RELEASE`, `ROLLBACK TO`, `COMMIT AND CHAIN`, `SET [LOCAL\|SESSION] TRANSACTION`, `SET transaction_isolation`/`transaction_deferrable`/`transaction_read_only` 앞에는 savepoint를 두지 않음. 트랜잭션이 실패 상태면 두지 않음 | 처음에는 cancel 없이 남은 행을 읽어 버리고 5초 뒤 cancel했으나, 결과가 크거나 터널이 느리면 cancel로 트랜잭션이 실패했고, 끝까지 읽힌 `UPDATE … RETURNING`이 화면에는 버렸다고 나오면서 트랜잭션에 남았음(code-review, 사용자 결정). 사용자의 savepoint 문장과 트랜잭션 특성 `SET`은 savepoint 안에서 오류가 나거나 사용자의 savepoint를 풀어 버림(test DB에서 확인). 문장마다 왕복이 하나 더 듦. `SELECT pg_export_snapshot()`은 첫 keyword로 가릴 수 없어 savepoint 안에서 실패함 |
| 2026-11-19 | M6 | 위험 쿼리 판별: 실행할 문장 하나를 `pg_query::parse`로 읽어 첫 위험을 돌려줌. WHERE 없는 `UPDATE`와 `DELETE`(CTE 안 포함), `DROP`(`DropStmt`의 모든 object, `DROP DATABASE`, `DROP ROLE`/`USER`/`GROUP`, `DROP OWNED BY`, `DROP TABLESPACE`), `TRUNCATE`. `EXPLAIN ANALYZE`는 안쪽 문장을 봄. `EXPLAIN`(ANALYZE 없음)과 `PREPARE`는 실행하지 않으므로 보지 않음. parse가 실패하면 위험 없음(서버가 오류를 냄). `DO` block, 함수 안의 문장, `ALTER TABLE … DROP COLUMN`은 보지 않음. 기획서 4.8에 반영 `DROP OWNED BY`의 문구는 "그 role이 가진 모든 object를 지움". `COPY (DELETE …) TO STDOUT`은 보지 않음(앱이 `COPY`를 지원하지 않음) | 겉이 `SELECT`나 `EXPLAIN`이어도 CTE와 `EXPLAIN ANALYZE`는 실제로 지움. 읽기 전용 접속에서 확인하지 않는 것은 읽기 전용(M8)과 함께 만듦 |
| 2026-11-19 | M6 | 위험 쿼리 확인의 문구: Manual이거나 트랜잭션이 열려 있으면 "되돌릴 수 있음", Auto이고 트랜잭션 밖이면 "되돌릴 수 없음". `Run again`도 확인하고, 터널 오류의 `Try again`은 이미 확인한 실행이라 묻지 않음 | 트랜잭션이 열려 있으면 Auto여도 Rollback으로 되돌릴 수 있음. `DROP DATABASE`와 `DROP TABLESPACE`는 트랜잭션 안에서 돌지 못해 Manual에서는 "되돌릴 수 있음" 대신 서버 오류가 남(고치지 않음, 잃는 데이터 없음) |
| 2026-11-19 | M6 | 확인 dialog는 캔버스 모양의 `DialogHost` 하나로 그림(Dialogs, Safety). native `ask`를 쓰던 M3의 확인(저장하지 않은 탭 닫기, 프로젝트 바꾸기, 밖에서 바뀐/지워진 파일 저장)도 바꿈. 저장하지 않은 탭 닫기는 캔버스대로 `Don't save / Cancel / Save`이고 Save는 저장에 성공했을 때만 닫음. dialog가 열린 동안 단축키는 동작하지 않고 Escape는 Cancel, 기본 focus는 Cancel. 한 번에 하나만 보이고 나머지는 차례를 기다림 | 마일스톤이 확인 dialog를 캔버스 모양으로 요구함(native `ask`를 대신함). dialog가 겹치거나 단축키가 뒤의 에디터로 가면 안 됨 |
| 2026-11-19 | M6 | `chilla.toml`의 `color`가 `green`, `yellow`, `red`, `blue`, `purple`이 아니면 프로젝트를 열지 않음. 접속 sheet의 `color`는 다섯 swatch의 radiogroup이고 고른 swatch를 다시 누르면 색을 지움(회색). 새 접속은 색이 없음 | 모르는 key를 거절하는 것과 같은 이유. 오타가 조용히 회색이 되면 운영 접속을 구분하지 못함 |
| 2026-11-19 | M6 | 종료 경로: menu의 Quit을 custom item(`quit`, `Cmd+Q`)으로 바꾸고, 창 닫기(`CloseRequested`)와 사용자가 요청한 `ExitRequested`(`code`가 `None`)를 막은 뒤 `quit-requested` event를 보냄. 화면은 열린 트랜잭션이 없으면 바로, 있으면 확인한 뒤 `quit_app`을 부름. `quit_app`이 flag를 세운 뒤의 종료는 막지 않음. 확인하는 동안 온 두 번째 요청은 무시함. 화면이 응답하지 않으면 강제 종료로만 끝남(감수) | 현재는 menu의 Quit이 `PredefinedMenuItem::quit`이고 창 닫기와 Dock의 Quit은 따로 다루지 않음. 열린 트랜잭션을 확인 없이 잃지 않게 함. Dock Quit이 막히는지는 아래 probe 결과 |
| 2026-11-19 | M6 | 접속 저장(`applySavedProject`)과 프로젝트 바꾸기(`switchProject`)는 열린 트랜잭션이 있으면 먼저 물음(M6 Task 11) | M3의 `applySavedProject`는 연결 대상이 바뀐 접속을 쓰는 탭을 묻지 않고 `release`하고 `switchProject`는 `reset`함. 둘 다 열린 트랜잭션을 잃을 수 있음 |
| 2026-11-19 | M6 | 종료 경로 확인(M6 Task 1, tauri 2.12.5, tao 0.37.2, macOS): `ExitRequested`, `CloseRequested`, `Exit`에 probe를 달고 `prevent_exit`, `prevent_close`를 부르며 `.app`을 띄워 확인함. 창의 닫기 버튼은 `CloseRequested`만 오고 `prevent_close`로 막힘(창과 process가 남음). menu의 Quit(`Cmd+Q`, `PredefinedMenuItem::quit`), Dock의 Quit, `osascript -e 'quit app "ChillaSQL"'`는 모두 `ExitRequested` 없이 `RunEvent::Exit`만 오고 막히지 않음(`prevent_exit`이 불리지 않음) | 결정 규칙의 막히지 않는 쪽. 세 경로는 확인 없이 끝나고 `RunEvent::Exit`의 `shutdown`이 세션을 닫아 서버가 되돌림. `code: None`의 `ExitRequested`는 이 경로들에서 오지 않음 |
| 2026-11-19 | M6 | Task 13은 menu의 Quit을 custom item으로 바꿔 `Cmd+Q`와 menu의 Quit을 확인에 태우고 창 닫기를 막음. Dock의 Quit과 `osascript` quit은 확인 없이 끝남(감수). `ExitRequested { code: None }` 막기는 안전망으로 두되 이 경로들에서는 오지 않음 | predefined Quit은 막을 수 없어 custom item이 필요함. Dock과 외부 quit 요청을 막는 방법은 찾지 못함(tao 0.37.2의 app delegate는 `applicationWillTerminate`만 구현하고 종료를 거절할 수 있는 `applicationShouldTerminate`는 없음). 열린 트랜잭션은 서버가 되돌리므로 데이터는 Commit되지 않은 채 사라짐 |
| 2026-11-19 | M6 | Transaction 모드(Auto/Manual)는 `runsStore`가 아니라 `tabsStore`의 탭 field. 세션을 놓아도(`release`) 모드는 탭에 남고 탭을 닫으면 사라짐 | 모드는 세션이 아니라 탭의 것이라 `release(…, { keepMode })` flag를 caller마다 넘기던 것을 없앰(simplify) |
| 2026-11-19 | M6 | Commit/Rollback 가능 조건은 `runsStore`의 selector `endable` 하나. toolbar, 단축키, 결과 panel의 Rollback이 이것을 씀. 닫기 전 확인의 끝내기는 이 조건을 거치지 않음 | 조건이 세 곳에 따로 있었음. 확인 dialog는 쿼리를 읽는 중에도 끝내기를 보내야 해서 store의 `endTransaction` 자체에는 넣지 않음(simplify) |
| 2026-11-19 | M6 | simplify에서 고치지 않은 것: `runsStore`의 탭별 record를 하나(`TabRun`)로 합치기, `discardedByEnd`를 actor의 discard 이유(`DrainReason::Ended`)로 보내기, 접속 저장의 settle 경로를 한 command로, 확실하지 않은 `Finished.tx`를 `null`로 보내기, `IDLE_RESULT_MINUTES`를 core 값에서 받기, 실행 전 `inspect_statement`를 세션 열기와 병렬로 하거나 cache하기, Manual `BEGIN`을 pipeline하기, 탭마다 도는 1초 timer를 하나로 | 앞의 넷은 범위가 크거나 event 계약을 바꿈. `IDLE_RESULT_MINUTES`는 M8 설정과 함께. inspect 병렬은 확인을 Cancel해도 세션을 여는 동작 변경. `BEGIN` pipeline은 오류 순서 위험. timer는 탭이 적어 비용이 작음 |
| 2026-11-19 | M6 | 서버에 보내지 않은 쿼리(대기 중에 취소되거나 밀려난 것)의 `Finished.tx`는 `null`. 화면은 `tx`가 `null`이면 앞의 트랜잭션 표시를 그대로 두고 `connection_lost`일 때만 지움. `null`이 아닌 `tx`는 문장이 끝난 뒤(버린 문장은 되돌린 뒤) 읽은 값이라 밀려난 실행의 것도 상태에 반영함(뒤 실행이 이미 알렸거나, stale 세션이거나, Commit/Rollback이 버린 것은 빼고) | actor의 마지막 값을 싣으면 Manual `BEGIN` 뒤에도 `idle`이 가서 화면이 열린 트랜잭션을 지웠음(code-review) |
| 2026-11-19 | M6 | 접속 저장의 `Commit and save`에서 저장은 되고 Commit이 실패하면 탭은 놓지 않고 form을 연 채 "저장했지만 반영하지 못함"을 알림. 화면의 프로젝트는 저장한 값으로 바꾸고, 탭 세션이 아직 쓰는 앞 접속을 기억해(`unapplied`) 다시 Save하면 앞 대상과 비교해 다시 묻고 반영함 | 탭을 놓으면 Commit 오류가 지워지고 아직 열린 트랜잭션을 확인 없이 잃음. form을 다시 열었을 때 파일과 다른 값을 보이면 다음 저장이 키체인 비밀번호를 지울 수 있음(re-review) |
| 2026-11-20 | M7 | 스키마는 탭 세션이 아니라 접속마다 하나인 catalog connection으로 읽음. 그 접속의 터널 lease를 함께 쥐고, 화면이 그 접속을 쓰는 탭이 없어지면 닫음. 연결이 끊겨 있으면 한 번 다시 연결해 다시 읽음 | 탭 세션에 catalog 쿼리를 끼우면 받다 만 결과를 버리고, 실패한 트랜잭션에서는 거절됨 |
| 2026-11-20 | M7 | 활성 탭에 접속이 있으면(탭이나 탭의 접속을 바꾸면) 그 접속의 catalog를 뒤에서 불러옴. 터널 접속은 이때 터널이 뜸. 실패하면 Schema 화면에 오류와 Retry를 보이고 저절로 다시 시도하지 않음 | 첫 실행 전에도 자동완성을 쓰려고 |
| 2026-11-20 | M7 | 스키마, 테이블, 뷰, 컬럼, 함수 이름, search_path, reserved keyword는 한 번에 읽어 메모리에 두고, 인덱스와 제약조건만 그 group을 처음 펼칠 때 relation OID로 읽음 | 자동완성이 0.05초 안에 떠야 함. 기획서 4.7의 "펼친 항목만 조회"를 고침 |
| 2026-11-20 | M7 | system schema(`pg_catalog`, `information_schema`, `pg_toast`, temp)는 트리와 테이블 자동완성에서 뺌. 함수 자동완성은 `pg_catalog`도 넣되 연산자 구현, aggregate 보조 함수, `internal`·`cstring`·handler pseudo-type 함수는 뺌. partition은 빼고 부모만. 제약조건은 `p`, `f`, `u`, `c`, `x`만(PostgreSQL 18의 NOT NULL `n` 제외). catalog SQL은 PostgreSQL 11 이상 | 트리와 자동완성의 잡음을 줄임 |
| 2026-11-20 | M7 | 트리: schema → Tables, Views(비면 없음) → 테이블/뷰 → Columns, Indexes, Constraints. 처음에는 search_path 첫 schema와 그 Tables만 펼침. 펼친 상태는 접속마다 남고 새로고침해도 이름으로 남음. 화살표 key 이동은 없음 | Sidebar A 캔버스. Files 목록과 같은 조작 |
| 2026-11-20 | M7 | 새로고침은 catalog 전체를 다시 읽고 받아 둔 인덱스, 제약조건을 버린 뒤 펼쳐 있는 것만 다시 읽음. 읽는 동안 옛 트리를 보임 | 새 테이블이 트리와 자동완성 양쪽에 나타나게 |
| 2026-11-20 | M7 | Select first rows(더블클릭 또는 menu)는 새 탭(같은 접속, Auto)에 `SELECT * FROM schema.name LIMIT 500`을 넣고 실행 | 지금 탭의 받다 만 결과와 트랜잭션을 건드리지 않음. 500은 batch 하나 |
| 2026-11-20 | M7 | 트리 menu는 테이블과 뷰에 Select first rows, Copy name, 나머지에 Copy name. Show DDL은 M9. Copy name은 PostgreSQL `quote_ident` 규칙으로 감싼 이름을 복사하고 toast | 붙여 넣은 이름이 그대로 SQL로 쓰이게. DDL 보기는 M9 범위 |
| 2026-11-20 | M7 | 자동완성은 입력하면 바로 뜸(`activateOnTypingDelay` 0). 직접 여는 key는 CodeMirror 기본(`Ctrl+Space`, `Opt+\``, `Opt+I`). keyword는 대문자, 함수는 이름만 넣음. kind 글자는 캔버스의 c, t, f, k에 schema `s`를 더함. 별칭은 lang-sql 6.10 기본 기능(FROM/JOIN)을 쓰고, 별칭 없는 컬럼과 함수 source는 직접 만듦. `UPDATE … u SET u.`, subquery 별칭, lang-sql이 맡는 `U.`처럼 대문자로 쓴 별칭과 schema 경로는 알아보지 않음(직접 만든 별칭 없는 컬럼 source는 따옴표 없는 이름을 소문자로 접음) | 기본 지연 100ms로는 0.05초를 못 맞춤. lang-sql을 node로 돌려 확인함 |
| 2026-11-20 | M7 | 함수 자동완성은 keyword인 이름(`extract`, `substring` 등)도 따옴표로 감싸지 않음. 테이블과 컬럼 이름은 `quote_ident` 규칙대로 감쌈 | 감싸면 일반 함수 호출이 되어 `extract(year from ts)` 같은 특별한 문법이 깨짐(code-review) |
| 2026-11-20 | M7 | 글자 크기 token `--text-tiny`(11px)를 더함. 스키마 트리 icon과 자동완성 kind 글자에 씀 | 캔버스(Sidebar, Tools)가 11px를 쓰고, 글자 크기는 token으로만 씀 |
| 2026-11-20 | M7 | 자동완성 footer의 legend는 popup 너비(340px)를 넘으면 다음 줄로 내림. 스키마 트리 줄의 오른쪽 표시(type 등)는 줄 너비의 반까지만 쓰고 말줄임 | 앱 확인에서 legend가 popup 밖으로 넘치고 `timestamp with time zone`이 컬럼 이름을 가렸음 |
| 2026-11-20 | M7 | 탭이 없으면 Schema 화면에 Choose connection 버튼을 두지 않음 | 접속을 정할 탭이 없어 menu가 아무것도 하지 않음(code-review) |
| 2026-11-20 | M8 | 먼저 확인한 것: 결과 컬럼의 type은 `prepare`가 아니라 `TxTap`이 RowDescription(`T`)을 읽어 얻음. `TxTap`이 컬럼별 `(type OID, typmod)`를 queue에 넣고 `start_query`가 보내기 전에 비우며 `PgRows`가 RowDescription을 받을 때 앞에서 하나 꺼냄 | `tokio-postgres` 0.7.18의 `SimpleColumn`은 `name()`만 공개함. `prepare`는 실행마다 round trip이 하나 더 들고 Parse 오류가 Manual 트랜잭션을 실패 상태로 만듦. tap은 message를 해석하기 전에 byte를 봄 |
| 2026-11-20 | M8 | type 이름은 M7 스키마 트리와 같은 `format_type`(캔버스의 `int8` 대신 `bigint`). catalog connection이 `unnest($1::oid[], $2::int4[])`로 한 번에 답함 | test DB(PostgreSQL 18.6)에서 `format_type(oid, typmod)`과 `pg_type.typcategory`로 확인함(`1043,259` → `character varying(255)`/`S`, `1700,655366` → `numeric(10,2)`/`N`). 스키마 트리와 같은 이름이어야 함 |
| 2026-11-20 | M8 | 실행될 문장의 span은 문서 StateField에 두고 변경을 따라 옮김(`mapPos`). 마지막 입력 뒤 150ms 동안 입력이 없으면 비동기로 다시 나누고, 커서 이동은 둔 span만 봄. 실행할 때 span이 지금 문서의 것이면 다시 나누지 않음 | `split_statements`가 1만 줄에 약 40ms이고 IPC로 text 전체를 보내서 커서가 움직일 때마다 부르면 화살표 key를 누르고 있을 때 밀림 |
| 2026-11-20 | M8 | 접속 key는 `read_only = true`(없으면 false)와 `statement_timeout = 30`(초 단위 정수, 1~86400, 없으면 서버 기본값)이고 둘 다 startup option(`default_transaction_read_only=on`, `statement_timeout`)으로 보냄 | 캔버스의 제안(`read_only`, `statement_timeout`)을 test DB에서 확인함: 읽기 전용 세션은 `CREATE TEMP TABLE`을 거절하고 `pg_sleep(2)`는 SQLSTATE `57014`로 끊김. `tunnel_timeout`과 단위를 맞춤. 기획서 9장에서 지움 |
| 2026-11-20 | M8 | 값 보기는 Shift+Enter, 프로젝트 열기는 Cmd+O | DataGrip에서 Shift+Enter는 "Open in Value Editor"이고 Cmd+O는 database object 찾기라 프로젝트 열기 단축키가 없음. ChillaSQL에는 object 찾기가 없음(기획서 1장 "만들지 않는 것"). 기획서 9장에서 지움 |
| 2026-11-20 | M8 | Reformat은 `sql-formatter` 15.9.1(`language: "postgresql"`, `keywordCase: "preserve"`, `tabWidth: 2`). `::` 캐스팅, `$$ … $$` 본문, `->>`, `@>`, 따옴표 식별자, 한글 식별자와 주석은 의미가 바뀌지 않음. 닫히지 않은 `/*`는 `/ * abc`로 바꿔 의미가 바뀌므로 Reformat하지 않고 toast로 알림. 문법 오류는 막지 않고 서식만 바꿈. 동기로 부름 | 직접 돌려 확인함: 닫히지 않은 `'`, `"`, `$$`는 `Parse error`로 throw, `SELEC 1 FROM`은 throw하지 않음, 2,000문장(17만 자)이 195ms |
| 2026-11-20 | M8 | 결과 컬럼의 type: `Columns` event의 컬럼마다 `type_oid`, `type_modifier`가 붙고 화면은 접속별 cache에 없는 type만 `describe_types`로 물음. 답이 오기 전과 실패하면 header에 type이 없고 왼쪽 정렬 | type 이름 조회가 느리거나 실패해도 결과 표시는 막지 않음 |
| 2026-11-20 | M8 | 타입별 표시: header는 이름 옆에 type(mono 12px, fg-3). typcategory `N`은 오른쪽 정렬. `json`/`jsonb`는 한 줄로 그리고 둘째 단계부터의 object와 array를 `{…}`, `[…]`로 접음(parse가 안 되면 text 그대로). `vector(…)`/`halfvec(…)`이고 값이 4개 이상이면 앞 3개와 `…`, `{n} values`. 배열은 서버 text 그대로 | 캔버스 Tools M8의 표시 규칙 |
| 2026-11-20 | M8 | timestamptz는 세션을 열 때 startup option `TimeZone`에 Mac의 IANA time zone 이름(`iana-time-zone` crate)을 넣어 서버가 Mac 시간으로 text를 만듦. 이름을 못 얻으면 넣지 않고 사용자의 `SET TimeZone`은 그대로 들음 | pgJDBC를 쓰는 DataGrip과 같은 동작이고 화면이 text를 다시 해석하지 않아도 됨. 기획서 4.6에 반영 |
| 2026-11-20 | M8 | 값 보기 panel: 결과 표에서 셀을 고르고 Shift+Enter를 누르면 결과 panel 오른쪽에 340px panel이 열림(다시 누르기, 닫기 버튼, Esc로 닫음). `json`/`jsonb`는 2칸 들여쓰고 에디터 syntax token 색으로 칠함. 열린 채 다른 셀을 고르면 그 셀을 보이고 화면을 닫으면 잊음 | 캔버스 Tools M8. DataGrip의 Value Editor와 같은 key |
| 2026-11-20 | M8 | 여러 문장 실행: 선택 영역이 문장 둘 이상이거나 toolbar menu의 Run file이면 문장을 차례로 실행함. 마지막이 아닌 문장은 Rust가 끝까지 읽고 첫 batch(500행, 4 MiB)만 보냄(`drain`). `completed`가 아니면 거기서 멈추고 나머지는 Not run. 위험한 문장은 그 문장 차례에 확인하고 Run file에는 단축키를 두지 않음 | `drain`이 아니라 버리면 cancel이 되어 `UPDATE … RETURNING`의 변경이 되돌려짐. 앞 문장이 실패했는데 뒤 문장을 실행하면 의도와 다른 결과가 됨 |
| 2026-11-20 | M8 | 결과 탭(States "여러 문장"): 문장이 둘 이상이면 결과 panel header에 탭 줄(`resultLabel(sql)`, 오류는 `Error`, 실행하지 않은 문장은 `Not run`으로 누를 수 없음). 실행 중에는 지금 문장, 멈추면 멈춘 문장의 탭을 고르고 오류 화면 아래에 `Stopped at statement {n}. {rest}`. 앞 문장의 결과는 고정된 snapshot이라 이어서 가져오지 않음 | 캔버스 States의 여러 문장 화면. 앞 문장의 batch를 이어서 가져오려면 그 문장의 결과를 열어 두어야 함 |
| 2026-11-20 | M8 | 오류 위치: 실행할 때 보낸 문장의 문서 offset을 문서 StateField에 두고 변경을 따라 옮기고, 오류 `position`에서 단어 끝까지(단어가 아니면 한 글자) danger 색 wavy underline을 그음. 그 탭의 다음 실행이나 밑줄 범위를 건드리는 편집에서 지움. Ln/Col과 Go to error는 옮겨진 위치를 쓰고 Run again은 처음 보낸 text와 옮겨진 위치를 씀(M4의 "Run again은 처음 `origin`"을 대신함) | M4에서 문서를 고치면 Ln/Col이 옛 자리를 가리킬 수 있어 고치지 않은 지적이 있었음 |
| 2026-11-20 | M8 | 실행될 범위 강조: 선택 영역이 없을 때 커서의 문장(`statementAt`)이 걸친 줄에 `accent/7` 배경과 왼쪽 2px accent 선. 선택 영역이 있거나 문장이 없거나 나눌 수 없으면 그리지 않음 | 캔버스 Main. Cmd+Enter가 무엇을 실행할지 미리 보이려고 |
| 2026-11-20 | M8 | Reformat: `Opt+Cmd+L`, toolbar의 icon 버튼, 빈 상태 안내. 선택 영역이 있으면 그것만, 없으면 문서 전체를 바꾸고 실행 취소 한 번으로 돌아감. 실패하면 문서를 그대로 두고 toast `Couldn't reformat: {첫 줄}` | DataGrip의 Reformat Code와 같은 단축키 |
| 2026-11-20 | M8 | 읽기 전용 접속: `read_only = true`면 세션과 catalog connection을 `default_transaction_read_only=on`으로 열고 위험 쿼리 확인을 하지 않음. 서버가 SQLSTATE `25006`으로 거절하면 오류 화면의 설명 줄에 `{접속} is a read-only connection, so the database rejected the write. Nothing changed.`. 자물쇠 icon을 sidebar 접속 목록, 접속 menu, toolbar chip에 그림 | 캔버스 Safety C. 쓸 수 없는 접속에서 확인을 물을 이유가 없음. 서버가 막으므로 클라이언트가 SQL을 추측하지 않음 |
| 2026-11-20 | M8 | statement timeout: `statement_timeout`이 있는 접속에서 outcome이 `failed`이고 SQLSTATE가 `57014`면 Timed out 화면(제목 `Timed out`, 서버 메시지, `This connection's statement_timeout is {n}s.`). 사용자의 Cancel은 `cancelled`로 옴 | 캔버스 States의 Timed out. 사용자 Cancel도 서버는 `57014`를 돌려주므로 SQLSTATE가 아니라 outcome(`cancelled`)으로 구분함 |
| 2026-11-20 | M8 | `read_only`나 `statement_timeout`을 바꿔 저장하면 연결 대상을 바꾼 저장처럼 그 접속을 쓰는 탭의 세션을 놓고 catalog를 다시 읽음(열린 트랜잭션이 있으면 먼저 물음). 비밀번호는 지우지 않음. 화면 `sessionChanged`가 이 비교(Rust에는 같은 비교를 두지 않음, code-review에서 쓰이지 않는 `same_session`을 지움) | startup option은 세션을 열 때만 적용되므로 열린 세션에는 바뀐 값이 닿지 않음 |
| 2026-11-20 | M8 | 접속 sheet(ConnectionForm B): `tunnel` 아래에 `read_only` switch, 그 아래 접힌 Advanced(`statement_timeout · tunnel_timeout · sslrootcert`). 기존 값이 있는 칸이 있으면 펼친 채 엶. 테스트 성공은 `Connected · PostgreSQL {version}`과 `{ms} ms`(version은 `SHOW server_version`의 첫 단어) | 캔버스 ConnectionForm B |
| 2026-11-20 | M8 | 전역 설정 파일 `~/.config/chilla/config.toml`: key는 `language`, `editor.font`, `editor.font_size`, `results.retained_rows`, `results.idle_timeout`(모두 생략 가능). 앱 시작 때 한 번 읽고 바꾸면 다시 시작해야 반영됨. 파일이 없으면 기본값이고 만들지 않음. 틀린 형식, 모르는 key, 범위를 벗어난 값은 기본값으로 시작하고 첫 화면에 오류 dialog로 이유를 보임. `[keys]`는 M10 | 접속 설정은 프로젝트의 `chilla.toml`에 있고 사용자 전체 설정은 따로 있어야 함. 조용히 무시하면 설정이 안 먹는 이유를 알 수 없음. 기획서 5장에 반영 |
| 2026-11-20 | M8 | 언어: `language`의 dictionary(`en`, `ko`)로 화면을 그림. `ko`는 `Record<MessageKey, string>`이라 빠진 key를 typecheck가 잡음. Commit, Rollback, Auto, Manual, SQL keyword, 설정 key, 단축키 기호는 영어 그대로. 숫자 묶음은 두 언어 모두 `en-US`. Rust 오류는 `CommandError`에 `params`를 더하고 화면이 `error.<kind>` 문구에 넣음. macOS menu는 Rust가 `language`로 고른 label로 만듦 | 기술 용어와 UI 요소 이름이 두 언어에서 같아야 검색과 대화가 맞음. Rust message를 번역하지 않고 화면 dictionary 하나로 모음 |
| 2026-11-20 | M8 | 앱 내부 저장소: `<app_data_dir>/chilla.sqlite3`(`~/Library/Application Support/com.yuiyeong.chillasql/`), `rusqlite`. table은 `recent_projects`와 `workspaces`, schema 판은 `PRAGMA user_version = 1`. 열지 못하면 최근 프로젝트와 자동 보관 없이 앱이 뜨고 오류 dialog를 보임. 쿼리 기록(M9)은 이 파일에 table을 더함 | 최근 프로젝트와 탭 snapshot은 프로젝트 밖의 앱 상태이고 `localStorage`는 dev와 `.app`이 따로이며 Rust가 읽을 수 없음. 저장소가 망가져도 앱은 떠야 함. 기획서 5장에 반영 |
| 2026-11-20 | M8 | 최근 프로젝트: 프로젝트를 열거나 만들 때마다 Rust가 기록하고 최근 10개만 남김. 앱을 시작하면 가장 최근 프로젝트를 엶. 열지 못하면 Welcome A(오류, Open Project… Cmd+O, Recent Projects 목록), `chilla.toml`이 없는 디렉토리는 Welcome B의 sheet로 물음. sidebar의 프로젝트 이름을 누르면 Sidebar D menu. M3의 `localStorage`(`chilla.lastProjectDir`)는 쓰지 않고 값을 옮기지 않음. 없는 디렉토리도 목록에 남고 열 때 오류를 보임 | M3 결정 기록 "마지막 프로젝트를 `localStorage`에"의 약속(SQLite로 옮김)을 옮기지 않는 쪽으로 바꿈: 혼자 쓰는 앱이고 한 번 직접 열면 되며 dev와 `.app`의 값이 따로라 옮길 값이 불확실함 |
| 2026-11-20 | M8 | 자동 보관과 복원: 프로젝트마다 탭 snapshot(JSON, `version: 1`: 탭 순서, 활성 탭, 탭마다 `title`, `path`, `stamp`, `connection`, `mode`, `text`)을 보관함. `text`는 저장하지 않은 변경이 있거나 파일이 없는 탭만. 마지막 변경 1초 뒤에 저장하고 프로젝트를 바꾸기 전과 `quit_app` 앞에는 바로 저장함. 복원한 dirty 탭의 저장은 보관한 `stamp`로 M3의 덮어쓰기 확인을 탐. 세션과 트랜잭션은 되살리지 않고 모드는 되살림. **프로젝트를 바꿀 때 저장하지 않은 탭을 묻지 않음**(M3의 확인을 없앰), 탭 닫기의 확인은 그대로 | 자동 보관이 있으면 바꿀 때 잃는 것이 없어 앱 종료(M3에서 묻지 않기로 함)와 같아짐. 저장하지 않은 text는 `localStorage`가 아니라 앱 내부 저장소에 둠 |
| 2026-11-20 | M8 | 에디터 글꼴: `editor.font`, `editor.font_size`를 `.cm-content`와 gutter에 씀(`font-family: "{font}", "D2Coding", monospace`, line-height는 `round(size × 1.6)`px). 결과 표는 D2Coding 그대로 | 프로젝트 규칙: 결과 data는 D2Coding. 글꼴이 없으면 D2Coding으로 대신 그림 |
| 2026-11-20 | M8 | 받다 만 결과를 닫는 시간(`results.idle_timeout`)과 보관 상한(`results.retained_rows`)이 `QueryLimits`가 되고 화면의 `IDLE_RESULT_MINUTES`는 설정에서 받음 | M6에서 상수로 둔 값을 사용자가 고칠 수 있게 함 |
| 2026-11-20 | M8 | 여러 문장 실행의 세부: 첫 문장의 위험 확인은 실행 전에 하고(Cancel하면 아무것도 바뀌지 않음) 둘째 문장부터는 그 차례에 물음. 마지막 문장에서 멈추면 `Stopped at` 문구를 그리지 않음. 결과 탭 label은 `resultLabel(sql)`(`UPDATE users`)이라 캔버스의 `UPDATE 12`와 다름. 끝까지 읽는 문장을 읽는 동안 Commit, Rollback은 꺼짐. 끝까지 읽은 문장이 첫 batch만 보이면 footer가 `First {shown} of {total} rows`. 문서에서 그 문장의 자리가 지워졌으면 그 문장은 밑줄 없이 실행함 | 첫 문장을 Cancel했을 때 Not run 탭만 남기지 않으려고. 남은 문장이 없으면 멈춘 곳을 말할 것이 없음. command tag는 화면이 받지 않음. drain 중의 Commit은 그 문장을 버림. `End`는 모든 행을 봤다는 뜻이 되어 틀림 |
| 2026-11-20 | M8 | 타입별 표시의 세부: 숫자 열은 header도 오른쪽 정렬. 100,000자를 넘는 JSON은 접지 않음. 컬럼 너비를 맞출 때 4,000자를 넘는 JSON은 parse하지 않고 넓은 값으로 셈. 값 보기 panel은 1,000,000자를 넘는 JSON을 색 없이 보임 | 큰 jsonb 열이 표를 그릴 때나 너비를 맞출 때 화면을 멈추지 않게 함 |
| 2026-11-20 | M8 | 자동 보관의 세부: 빈 이름 없는 탭은 복원해도 dirty가 아님. 입력이 계속되어도 첫 변경 5초 안에 저장함. 저장소를 읽거나 쓰지 못하면 오류를 보이고 그 프로젝트는 보관하지 않으며, 그때 프로젝트를 바꾸면 저장하지 않은 탭을 다시 물음. 복원한 탭의 접속이 프로젝트에 없으면 접속 없음으로 둠. 프로젝트를 바꾸는 동안(보관부터 열기까지) 에디터는 편집할 수 없음. 모든 프로젝트 열기는 `enterProject`를 거침 | 보관되지 않는데 묻지 않으면 편집을 잃음. 열기 중의 편집은 옛 프로젝트에 저장할 수 없음 |
| 2026-11-20 | M8 | 최근 프로젝트의 세부: 목록에서 고른 프로젝트가 없거나 `chilla.toml`이 없으면 sheet 대신 Welcome A에 오류를 보임(폴더 picker로 고른 것만 sheet). sheet는 다른 dialog와 같은 자리(위에서 떨어진 panel)이고 프로젝트 menu 폭은 공용 menu 폭(캔버스는 sidebar 폭) | 목록의 항목은 이미 프로젝트였던 곳이라 새로 만들기를 권하지 않음. 공용 dialog, menu 모양을 따름 |
| 2026-11-20 | M8 | 서버가 Mac의 time zone 이름을 모르면(`22023`, TimeZone) 그 option 없이 한 번 다시 연결함. catalog connection에는 `statement_timeout`을 걸지 않음 | 옛 tzdata 서버에서 모든 연결이 실패하지 않게 함(code-review). 짧은 timeout이 스키마 읽기를 끊지 않게 함 |
| 2026-11-20 | M8 | code-review에서 고치지 않은 지적: read_only 접속은 세션에서 `SET … READ WRITE`로 풀 수 있는데도 위험 쿼리 확인을 건너뜀 | 기획서 4.8("읽기 전용 접속에서는 확인하지 않고 실행")대로 둠. 사용자에게 보고함 |

## 작업 로그

최신 항목이 위에 온다.

### 2026-11-20

- branch `m8-editor-run`을 main에 fast-forward로 합치고 branch를 지움
- M8 Task 21: `.app`(`scripts/build-app.sh --debug`)에서 완료 확인 14개를 Bash(CGEvent, System Events, `screencapture`)로 확인해 모두 통과함. 처음 시작은 Welcome A, 다시 시작하면 0.81 s에 마지막 프로젝트와 탭 3개. 최근 프로젝트 menu, `Cmd+Q` 뒤 저장하지 않은 탭 복원(dirty 점과 내용, 접속), Reformat(문서와 선택 영역, `Cmd+Z` 한 번), 커서 문장 강조, `SELEC` 밑줄과 Go to error(`Ln 2, Col 1`), Run file 결과 탭(`3 Error`, `4 Not run`, `Stopped at statement 3.`), header type과 숫자 오른쪽 정렬과 `{"a": {…}}`와 Mac 시간의 timestamptz와 값 보기 panel, read_only 접속의 `DELETE`(확인 없이 `SQLSTATE 25006 · prod is a read-only connection…`), `statement_timeout = 1`의 Timed out, Test의 `Connected · PostgreSQL 18.6`, `language = "ko"`와 `font_size = 13`(한국어 화면과 menu `편집, 보기, 윈도우`), `fontsize = 14` 오타의 `Settings were not applied` dialog, 1만 줄 파일에서 화살표 key 600번(30 ms 간격)에 커서가 밀리지 않음. 확인용 설정 파일, 앱 저장소, 키체인 항목, `m8_check` 스키마는 지움. 고치지 않고 본 것: 탭이 없을 때 단축키 안내가 에디터와 결과 자리에 두 번 나옴, Go to error 없이 Copy message만 있을 때 버튼이 설명 줄보다 약 14px 안쪽, 최근 목록의 없는 디렉토리는 `<dir>/chilla.toml 파일이 없습니다`로 나옴
- M8 Task 2~20(branch `m8-editor-run`): 결과 컬럼 type(TxTap이 RowDescription을 읽음)과 `describe_types`, 접속의 `read_only`·`statement_timeout`·Mac time zone·server version, 전역 설정 파일, SQLite 앱 저장소, `drain` 실행, 오류 params와 한국어 dictionary, Reformat, 문장 span cache와 범위 강조, 오류 밑줄과 Go to error, 여러 문장 실행과 결과 탭, 타입별 표시와 timeout·read-only 오류 화면, 값 보기 panel, 접속 sheet, 자동 보관과 복원, 최근 프로젝트와 Welcome, 에디터 글꼴. task마다 리뷰를 거쳤고 고친 지적은 결정 기록에 반영함. simplify(36개 중 33개 적용), code-review high(9개 중 7개 고침, 1개는 기획서대로 둠, 1개는 이 문서 갱신). 부하가 걸리면 가끔 실패하는 test: `tunnel_process`의 몇 개, `ten_thousand_statements_split_within_100ms`, vitest `aliased_columns_come_from_the_aliased_table`(다시 돌리면 통과)
- M8 Task 1(branch `m8-editor-run`): 계획의 결정을 결정 기록, 기획서(4.1, 4.4, 4.5, 4.6, 4.10, 5장, 9장), 마일스톤, 구조 문서에 옮김. `sql-formatter` 15.9.1을 설치해 확인함. 닫히지 않은 `/*`만 의미가 바뀌어(`/ * abc`) 그 입력은 Reformat하지 않음(Task 10 test `rejects_unclosed_block_comment`)
- branch `m7-schema-autocomplete`를 main에 fast-forward로 합치고 branch를 지움
- M7 완료(branch `m7-schema-autocomplete`, `cb28bfa`..). Task 1 결정 기록, Task 2 catalog SQL(`infrastructure/postgres/catalog.rs`, test DB integration test 3개. oid 0에서 domain 제약조건이 잡혀 `contypid = 0`을 더함), Task 3 App의 catalog connection(접속마다 slot 하나, 터널 lease 공유, 끊기면 한 번 다시 연결. 첫 구현에서 프로젝트 바꾸기가 여는 중인 slot을 기다려 test가 멈춰서 쓰는 중인 slot은 background에서 닫게 함), Task 4 command 셋, Task 5 화면 store와 불러오는 때, Task 6 Schema 화면, Task 7 menu·Copy name·Select first rows, Task 8 자동완성 source, Task 9 popup(kind 글자, footer)
- M7 simplify: catalog 쿼리를 `try_join!`으로 함께 보내고 relation당 한 줄(`array_agg`), 자동완성 source를 `EditorState.languageData`로(keyword는 `sql({ upperCaseKeywords })`), `shared/sql/catalog.ts`의 색인(WeakMap), details 불러오기를 store `toggle` 하나로. 고치지 않은 것: catalog connection을 actor로 바꾸기(큰 재구성, 지금 구조가 test로 검증됨), generation 확인을 `connect()`로 옮기기(`open_session`의 확인은 insert와 같은 lock 안이어야 함), 트리 렌더 가상화(큰 schema에서 느리면 그때)
- M7 code-review(high): 지적 9개 중 8개를 고침. 고친 것마다 실패하는 test를 먼저 씀(`afecdd3`): footer가 option이 바뀐 뒤 목록 위로 감, `close_catalog`와 겹친 load가 map에서 빠진 slot에 연결, 탭이 없을 때 Choose connection, keyword 함수 이름을 감쌈, 따옴표 없는 대문자 테이블 이름, FROM 목록의 `AS` 뒤 테이블, 우클릭 menu가 창 밖으로 나감, 11px literal. 고치지 않은 것: kind 글자(s/c/t/f/k)와 트리 icon, `↵`/`esc`를 `en.ts`로 옮기기(단축키 glyph처럼 언어와 관계없는 기호). 남은 것: `close_catalog`와 `load_catalog` IPC가 순서를 바꿔 실행되면 map 안의 연결이 다음 forget이나 프로젝트 바꾸기까지 남음(드묾, 화면이 순서를 알려 줘야 고칠 수 있음)
- M7 앱 확인(`.app`, local test DB): 탭이 없을 때와 접속이 없는 탭의 Schema(Sidebar B), Choose connection이 toolbar menu를 엶, 비밀번호가 없을 때 `A password is required`와 Retry, 트리(Sidebar A: `public`과 Tables가 펼쳐짐, `PK id bigint`, Indexes `unique`, Constraints `PRIMARY KEY`), 우클릭 menu(Select first rows `Double-click`, Copy name), Copy name(clipboard와 toast), 더블클릭이 새 탭에서 `SELECT * FROM public.big_table LIMIT 500`(500행), 다른 탭에서 `CREATE SCHEMA m7_check CREATE TABLE t1 (a int)` 뒤 Refresh하면 트리에 `m7_check`(펼친 상태 유지)와 자동완성 `m7_check.` → `t1`, 별칭 `SELECT u.` + `FROM m7_check.t1 u` → `a`(`t1 · integer`), 그 접속의 탭을 모두 닫으면 서버 연결 0개. 확인 중 찾은 화면 문제 셋(긴 type이 이름을 가림, footer legend가 넘침, 우클릭이 글자를 고름)을 고치고 다시 빌드해 확인함. 자동완성 0.05초는 test(5,000 테이블 × 20 컬럼)로 확인
- 관찰(고치지 않음): (1) 접속 form에서 비밀번호를 저장해도 실패한 catalog는 저절로 다시 읽지 않음(Retry를 눌러야 함, 결정대로). (2) debug `.app`에서 트리 밖의 빈 자리를 우클릭하면 WebKit 기본 menu(Reload, Inspect Element)가 뜸. (3) `cargo test`의 `first_500_rows_of_a_million_arrive_within_100ms`가 `pnpm check`에서 한 번 `wait_event` None으로 실패하고 다시 세 번 통과함(timing에 따라 흔들림)
- 앱 확인 방법에 더할 것: process 이름은 `chillasql`(소문자)라 `pgrep -x ChillaSQL`는 비어 있음. 다시 빌드한 뒤 `tell application "ChillaSQL" to activate`가 멈출 때가 있어 `tell application "System Events" to set frontmost of process "chillasql" to true`를 씀. `security add-generic-password -T <app>`로 넣은 키체인 항목은 앱이 확인 창 없이 읽지 못하므로 비밀번호는 접속 form으로 저장함(password 칸은 System Events `keystroke`로 입력됨). 확인용 프로젝트(scratchpad의 `m7check`)와 앱이 만든 키체인 항목(`…/m7check::local`)은 지움


- branch `m6-transactions`를 main에 fast-forward로 합치고 branch를 지움
- M6 SAVEPOINT 방식 앱 확인(`.app`, `b6c2589`, local test DB, Manual 모드): (1) `INSERT` → 받다 만 `SELECT * FROM big_table` → 다음 `INSERT`가 약 0.9초에 끝나고(전에는 버리기에 약 4.3초) `Open · 2 statements`, (2) 받다 만 `UPDATE m6_t SET n = n + 1000000 RETURNING n`(2002행) 뒤 `SELECT max(n)`이 2000으로 되돌려졌고 앞 `INSERT`는 남음, (3) 실행 중 `pg_sleep(5)`를 Cancel하면 `Cancelled`이고 트랜잭션은 `Open`, 앞 문장 남음, (4) 받다 만 결과가 있는 채로 Commit(`Opt+Shift+Cmd+Enter`)하면 "Ending the transaction discarded…"가 보이고 밖에서 두 `INSERT`가 보이며 열린 트랜잭션 없음, (5) Manual 첫 문장이 문법 오류면 `Failed · 0 statements`
- 관찰(고치지 않음): 확인 dialog가 떠 있는 동안 `Cmd+A`를 누르면 dialog 뒤 화면의 글자가 모두 선택됨. 단축키는 꺼져 있어 실행은 되지 않음

### 2026-11-19

- M6 code-review(high): 지적 7개를 `superpowers:receiving-code-review`로 검토해 모두 고침(6번은 일부). 고친 것마다 실패하는 test를 먼저 씀(`13ca890`, `3835aa0`, `1763fdb`)
  - (2) 트랜잭션 안의 5초 한도: 사용자 결정으로 SAVEPOINT 방식으로 바꿈(결정 기록). (1) 끝까지 읽힌 `UPDATE … RETURNING`이 버렸다고 나오며 트랜잭션에 남던 것과 (4) 닫기 전 Commit이 실행 중 문장을 함께 Commit하던 것도 이것으로 풀림. 가끔 실패하던 `discarding_a_paused_result_inside_a_transaction_keeps_it_open`은 시간에 기대지 않게 됨(5회 연속 통과)
  - (3) 끝내기를 취소·실패할 수 있는 단계 뒤로(결정 기록), (5) 보내지 않은 쿼리의 `tx`를 `null`로(결정 기록), (6) `DROP OWNED`, `DROP ROLE`/`USER`/`GROUP`, `DROP TABLESPACE` 확인. `COPY (DELETE …)`는 고치지 않음, (7) 앱이 연 트랜잭션에 `manual BEGIN`을 쓰지 않음
  - 고친 범위의 re-review: 중요한 결함 없음, nit 4개. 트랜잭션 특성 `SET`의 savepoint 제외, 밀려난 실행의 트랜잭션 상태 반영(이전부터 있던 것: Manual 첫 문장이 밀려나고 다음 실행이 대기 중에 취소되면 화면에 트랜잭션이 없다고 나와 Auto의 `UPDATE`가 commit되지 않을 수 있었음), `Commit and save` 실패 뒤 form의 값을 고침. 버리는 중 스스로 실패한 문장도 되돌리는 것, `DROP DATABASE`/`TABLESPACE`의 Manual 문구는 결정 기록에만 남김
  - `pnpm check` 통과(vitest 608)
- M6 simplify: 4개 관점(reuse, simplification, efficiency, altitude) 지적 35개를 합쳐 동작을 바꾸지 않는 것을 고침(`8295988`, `32673e7`). 고치지 않은 것은 결정 기록에 남김
  - Rust: `ConnectionColor`를 `SslMode`처럼 `FromStr`로, 위험 쿼리 판별의 `SELECT` arm과 `UPDATE`/`DELETE` arm 중복을 helper로, session actor의 사용자 Cancel과 세션 닫기가 `discard` 한 경로로 cancel을 정함, `QueryError` → outcome 변환을 `From`으로, `simple_execute`와 `start_query`의 오류 분류를 `query_error` 하나로, `Quitting` flag를 지움(tauri 2.12.5 소스에서 `app.exit(0)`은 `ExitRequested { code: Some(0) }`만 보내는 것을 확인)
  - 화면: 트랜잭션 모드를 탭 field로(결정 기록), Commit/Rollback 조건을 `endable` 하나로(결정 기록), `endCalls` Map을 `ending`의 token으로, store의 `setEntry` helper, `formatElapsed`(ms)를 `formatClock`으로, 단축키 억제를 `useShortcuts`가 dialog host 상태로, `connectionColor`의 이름 guard 제거와 접속 색 찾기 helper, `quit.ts`의 중복 filter, danger dialog의 같은 문구 key 합치기, `tc`가 0개에 `.none` key를 고름, `Banner`와 `Scrim`/`MODAL_PANEL` 공용, 탭의 TX badge가 자기 탭의 tx만 구독하고 `nextTx`가 바뀐 것이 없으면 이전 값을 돌려줌
  - `pnpm check` 통과(vitest 583)
- M6 Task 15: `.app`(`afcd47b`)으로 확인함
  - local test DB: 계획 표의 12항목이 모두 기준대로. Manual `INSERT`는 다른 탭에서 보이지 않고 Commit(`Opt+Shift+Cmd+Enter`) 뒤 보이고 Rollback(`Opt+Shift+Cmd+Z`) 뒤 사라짐. Auto의 `BEGIN`은 `Open · manual BEGIN`. 트랜잭션 안의 오류는 `Transaction failed`와 Rollback, Commit disabled. `DELETE FROM m6_t` 확인 문구가 Auto와 Manual에서 다르고 Cancel이면 실행하지 않음. 탭 닫기, 접속 바꾸기(시계 icon), Auto 전환, 연결 대상 저장, 프로젝트 바꾸기의 dialog가 캔버스와 같음. `Cmd+Q`와 창 닫기는 종료 확인을 띄우고 Cancel이면 남고 Roll back all and quit이면 끝나며 서버에 열린 트랜잭션이 없음. `osascript` quit과 Dock의 종료는 확인 없이 끝나고 서버가 되돌림. 저장하지 않은 탭 닫기는 캔버스 dialog. 받다 만 `big_table` 뒤 Manual 다음 문장은 Failed가 되지 않음
  - 실제 터널 접속(사용자가 알려 준 `<터널 명령>`, 확인용 프로젝트는 scratchpad): 앱이 터널을 띄우고 접속 Test가 `Connected`. Manual에서 `CREATE TEMP TABLE m6_check` → `INSERT 1` → Commit → `SELECT` 1행, `INSERT 2` → 2행 → Rollback → 1행. 트랜잭션이 열린 채 터널 프로세스와 ssh를 밖에서 끝내자 곧바로 `Transaction lost`("The 3 uncommitted statements were not applied"). 다음 실행에서 터널이 다시 뜨고 `Reconnected`. 앱을 끝내면 터널 프로세스와 포트가 남지 않음. 터널 CLI가 link된 디렉토리에서 실행해야 해서 `tunnel`에 `cd <디렉토리> && `를 붙임
  - 관찰: 트랜잭션 안에서 받다 만 `big_table`(100만 행)을 cancel 없이 버리는 데 local에서 약 4.3초 걸림. 그동안 다음 문장의 결과 panel은 "Waiting for the first row from the server". 버리기의 fallback(`tx_drain_limit` 5초)에 가까워 행이 넓거나 터널이 느리면 cancel로 넘어가 트랜잭션이 Failed가 될 수 있음. `generate_series` 100만 행(int 한 column)은 터널 너머에서도 몇 초 안에 끝남
  - `pnpm check`에서 `discarding_a_paused_result_inside_a_transaction_keeps_it_open`(`SELECT id FROM big_table`, 단독 약 1.7초)이 한 번 실패하고 재실행에서 통과함. 병렬 실행 부하로 버리기가 5초를 넘어 cancel된 것으로 보임(확인하지 않음)
  - 계획 Task 5의 Interfaces와 Step 4에 남아 있던 옛 문구(결과 표 아래 끝 줄)를 실제 구현(R9, 끝난 상태 카드 "Results closed")으로 고침
- M6 Task 2~14(`dfddc0c`..`e07052e`): `chilla.toml`의 `color` 값 검사, `Finished`에 트랜잭션 상태, Manual 모드의 `BEGIN`과 Commit/Rollback command, 트랜잭션 안에서 cancel 없이 버리기와 받다 만 결과 10분 뒤 닫기, `pg_query`로 위험 쿼리 판별, 캔버스 모양의 확인 dialog(native `ask`를 걷어 냄), 탭의 트랜잭션 상태와 Auto/Manual 모드, toolbar의 Commit/Rollback과 탭의 `TX` 경과 시간, 결과 panel의 실패한 트랜잭션과 Transaction lost, 열린 트랜잭션을 잃는 동작의 확인, WHERE 없는 `UPDATE`/`DELETE`와 `DROP`, `TRUNCATE` 확인, 앱 종료 확인, 접속 sheet의 `color` swatch. Task마다 implementer와 review를 따로 돌림. 앱은 아직 띄우지 않음(Task 15)
- M6 Task 14 앱 확인: `.app`에서 색 고르기, 저장, 다시 눌러 지우기와 창 상단 bar, 탭 dot, chip, sidebar dot, `chilla.toml` 반영을 확인함. 수정 sheet에서 `color` legend가 swatch 위 줄에 그려져 고침(`afcd47b`). WKWebView가 fieldset `<legend>`의 `float: left`를 따르지 않아 한 줄 배치는 `role="group"`과 label span으로 만듦. `pnpm check`에서 chilla-core의 `discarding_a_paused_result_inside_a_transaction_keeps_it_open`이 한 번 실패하고 재실행에서 통과함(flaky 의심, 원인은 보지 않음)
- M6 계획(`docs/plans/M6-transaction-safety.md`)을 쓰고 branch `m6-transactions`를 만듦
- M6 Task 1: 종료 경로를 `.app`으로 확인함. 창의 닫기 버튼만 `CloseRequested`로 오고 `prevent_close`로 막힘. menu의 Quit(`Cmd+Q`), Dock의 Quit, `osascript` quit은 `ExitRequested` 없이 `RunEvent::Exit`만 와서 막히지 않음. 확인용 probe는 지움. 계획에서 정한 것 전부와 확인 결과를 결정 기록으로 옮기고 기획서(4.3, 4.6, 4.8, 4.10, 9장)와 마일스톤(M6, M8)을 고침
- branch `m5-tunnel`을 main에 fast-forward로 합치고 branch를 지움
- M5 code-review(high): 지적 9개를 `superpowers:receiving-code-review`로 검토해 6개를 고치고 3개를 고치지 않음. 고친 것마다 실패하는 test를 먼저 씀
- M5 simplify: 4개 관점(reuse, simplification, efficiency, altitude) 검토의 지적 가운데 동작을 바꾸지 않는 것을 고침. Rust는 `wait_settled`가 `Result`를 돌려주고, `last_published`를 지우고, `PrivateTunnel`이 끝날 때 표에서 빠지고, `cancel`/`restart`를 동기 함수로 바꿈. 화면은 `useNow`, `MessageBlock`, `CommandOutput`/`Pre`, `useConnection`, `useTunnel`, `isTunnelStarting`을 함께 쓰게 하고, 같은 상태 event에서 store를 바꾸지 않고, 다시 실행 중에는 초를 세는 timer를 띄우지 않음. 고치지 않은 것은 결정 기록에 남김
- M5 Task 2~10: `tunnel_timeout`, `ShellTunnelRunner`(login shell, process group과 자손 tree 끄기, 기억한 자손의 종료를 끊김으로 봄), `Tunnels`(공유, 재실행 3회, 취소, 모두 끄기, 접속 테스트용 private 터널), 세션·접속 테스트·앱 종료와 연결, Tauri event `tunnel`과 `cancel_tunnel`/`restart_tunnel`, forwarder로 실제 프로세스 통합 test, 화면의 터널 store와 stale 세션 바꾸기, 캔버스 배치의 접속 sheet, toolbar·탭·결과 panel의 터널 상태와 Reconnected banner
- 문서, 디자인 사본, test, M1 계획의 실제 터널 명령과 서비스·프로젝트 이름을 지어낸 예시로 바꿈(사용자 지시). git history에는 남아 있음
- M5 Task 11: 실제 터널로 앱에서 7가지를 확인함(계획 파일의 "Task 11 실행에서 달라진 것"). 확인용 프로젝트는 scratchpad에 두었고 지웠다. 그 프로젝트의 접속 비밀번호가 키체인에 남았을 수 있음(service `com.yuiyeong.chillasql`, account가 scratchpad 경로인 항목)
- M5 계획(`docs/plans/M5-tunnel.md`)을 쓰고 branch `m5-tunnel`을 만듦. 1단계를 써 보는 기간은 건너뜀(사용자 결정)
- M5 Task 1: 실제 터널로 프로세스 tree를 확인함. 포트는 약 3초에 열림. zsh가 단일 명령을 `exec`해 실행한 프로세스가 곧 터널 CLI임. 터널 CLI는 ssh를 다른 process group으로 띄우고, `SIGTERM`이나 `SIGINT`를 받아도 ssh를 남겨 포트가 열린 채 남음. ssh가 먼저 죽어도 CLI는 살아 있음. link되지 않은 디렉토리나 없는 서비스 이름이면 stderr에 이유를 쓰고 바로 exit 1. Finder로 띄운 `.app`에도 `SHELL=/bin/zsh`가 있고 `zsh -l -c`가 CLI를 찾음. 확인용 probe는 지움. 계획의 끄는 방법, 끊김 감지, cwd를 고침(결정 기록)
- 터널 CLI는 터널이 열리면 stderr에 DB 비밀번호를 찍음. 화면은 터널이 열리지 않았을 때만 stderr를 보여 주므로 성공한 실행의 출력은 보이지 않음

### 2026-11-18

- M4 code-review(high): 지적 10개를 `superpowers:receiving-code-review`로 하나씩 검토해 7개를 고치고, 1개를 일부 고치고, 2개를 고치지 않음(`4d60113`..`2a48884`). 고친 것마다 실패하는 test를 먼저 씀
  - 고침: (2) 탭을 바꿨다 돌아오면 결과 표의 너비, 선택, 스크롤이 이어짐(결정 기록), (3) 고른 행이 모두 버려지면 header 복사 버튼이 꺼짐(`selectionRetained`), (4) 저장 경로 dialog가 떠 있는 동안 단축키가 꺼짐(Cmd+Enter가 뒤의 쿼리를 실행하고 Cmd+W가 뒤의 탭을 닫았음), (5) `(`로 시작하는 문장의 label이 비지 않음(없으면 `Result`), (7) `WITH … UPDATE` 같은 문장이 `Done` 대신 행 수를 알림, (8) 프로젝트가 없을 때 toolbar의 접속 selector가 매번 새 `[]`를 돌려줘 그리기를 멈추지 않던 것(module 상수로 바꿈. 같은 꼴의 selector는 이것 하나), (10) 접속 대상 문자열(`host:port/database`)을 `connectionTarget` 하나로
  - 일부 고침: (6) label의 대상 찾기가 문자열과 주석을 건너뛰고 `IF NOT EXISTS`, `IF EXISTS`, `ONLY`를 건너뜀. 함수 안의 `FROM`은 그대로(결정 기록)
  - 고치지 않음: (1) `fetch_more` 실패 처리, (9) Run again의 `origin`(둘 다 결정 기록)
  - test를 더함: format(괄호, 문자열, 주석, IF EXISTS, ONLY, WITH), 복사할 선택이 버려질 때, 저장 경로 dialog 아래의 단축키, 프로젝트 없는 toolbar, `connectionTarget`, 탭을 바꿨다 돌아올 때의 표(같은 실행, 앞 행이 버려진 뒤, 다시 실행, release, reset). vitest 380 → 395
  - 앱은 띄우지 않고 unit test로 확인함
  - `pnpm check` 통과
- M4 simplify: 네 reviewer의 품질 지적을 한 목록(25항목)으로 모아 24항목을 적용함(`526e357`..`48f51d1`). 동작은 바꾸지 않았고 기존 test는 그대로 통과함
  - 결과 표와 reducer: 끝난 결과의 `fetch`는 `none`(결정 기록), `rows` batch마다 행 배열을 한 번만 복사, `ResultGrid`와 header 줄을 `memo`하고 너비 변수를 `useMemo`, header 이름 측정 함수를 한 번만 만듦(`--font-weight-semibold` token을 `@theme static`에 둠), 전각 판별의 ASCII fast path, `rowSpan`, SQL label helper를 `format.ts`로 옮김, 안 쓰는 export를 없앰, 결과 panel의 오류 블록을 `MessageBlock` 하나로
  - `t()`가 number를 묶지 않음(결정 기록). `ConnectionDot`와 `connectionColor`의 fallback(결정 기록). 단축키 표시와 `aria-keyshortcuts`를 keymap에서 만들고 `Kbd`는 `aria-hidden`(결정 기록). `Button`의 size에 padding을 넣고 `chip`, `kbd`, `icon` size와 `dashed` variant를 더함. 실행 split 버튼을 `RunSplitButton`으로 떼어 menu 상태가 실행 중에 함께 사라짐
  - 결과 panel 경계를 끄는 동안 `ResultSplit`만 다시 그림, sidebar의 tree와 줄을 `useMemo`, status bar는 값 하나씩 고르고 `editorStatus.update`의 같은 값 검사를 없앰, `homeDir()`을 module에 한 번만 물어 둠(실패하면 다음에 다시 물음), 실행 요청은 `requestFor` 하나로
  - test helper: `src/test/fixtures.ts`(`connection`, `openProjectWith`), `src/test/layout.ts`(`stubLayout`), `resetStores`가 `useEditorStatus`도 되돌림, `setup.ts`가 `scrollIntoView`를 stub함
  - 뺀 항목: 25(dialog 틀과 input class 공유, 결정 기록). 목록의 "Skip" 8항목도 하지 않음
  - test를 더함: reducer(버릴 행이 보관한 행보다 많을 때, 한 batch의 append, 끝나면 `fetch` none), `rowSpan`, 전각 범위 경계, `headerMeasure` cache, 단축키 표시와 `aria-keyshortcuts`, `homeDir` cache, 끄는 동안의 handle 선. vitest 371 → 380
  - 100만 행 스크롤 probe와 화면 screenshot은 사용자의 요청으로 이번에는 하지 않음
  - `pnpm check` 통과
- M4 Task 13에서 찾은 것 고침. 7가지 중 6가지를 고치고(`3d742ed`..`8983e15`), 1가지(7)는 결함이 아니었다. 고친 것마다 실패하는 test를 먼저 쓰고(jsdom으로 나타낼 수 있는 것), `scripts/build-app.sh --debug`의 `.app`에서 확인함
  1. 자동 너비와 행 번호 column: `fitWidth`와 새 `rowNumberWidth`가 칸의 `border-r` 1px(`CELL_BORDER`)을 더함. 앱에서 `2026-07-30 02:00:00+00`, `user_302520`, 행 번호 `1,000,000`이 잘리지 않음
  2. 결과 header의 행 수: `receivedRows(result)`(`firstRow + rows.length`)로 셈. 실행 중 `310,500+ rows`, 끝나면 `1,000,000 rows`. cancel한 결과의 header도 받은 행 수이고, 안내 문장("The {n} rows received stay visible")은 표에 남은 행 수
  3. 경계 끌기: `pointerdown`에서 `preventDefault`함. pointer capture는 그대로이고, 앱에서 대각선으로 끌어도 글자가 선택되지 않음
  4. header 너비: header 이름을 canvas `measureText`로 잼(결정 기록). 앱에서 `amount`, `created_at`, `is_active`, `payload`가 잘리지 않음
  5. 복사 알림: 결과 panel(`section`, `relative`)의 아래 가운데에 `absolute`로 띄움. 앱에서 panel 가운데, status bar 위에 뜸
  6. 빈 몸통: 진단용 probe가 `End` 뒤의 scroll event를 기록하니 약 200ms 동안 17ms마다 한 번씩 수천 행씩 움직임(4,619 → 22,264 → 51,913 → 83,611px …). WebKit의 `End` 스크롤 애니메이션이다. scroll 위치는 scrolling thread가 먼저 그리고 행은 다음 frame에 오므로, frame마다 overscan(10행)보다 훨씬 멀리 가는 동안 빈 몸통이 보였다. 표가 `Home`, `End`, `Cmd+Up`, `Cmd+Down`을 받아 `scrollTop`을 바로 옮기게 함(결정 기록). 고친 뒤 scroll event는 한 번이고, 60fps `screencapture -v` recording에서 1행에서 7,490행으로 한 frame에 넘어가며 빈 frame이 없음. scrollbar thumb 끌기는 CGEvent로 보낸 끌기가 thumb를 잡지 못해 확인하지 못함
  7. 접속 menu와 에디터: 진단용 probe로 menu가 열린 동안에도 `.cm-line` 2개, 글자, `visibility`, 위치가 그대로이고, menu를 `visibility: hidden`으로 하거나 옆으로 옮기면 글자가 보임. menu가 문서의 두 줄을 덮은 것이었다. 16줄 문서에서 menu 아래의 줄만 가려짐을 확인함. 고칠 것 없음
  - 100만 행 스크롤 probe(Task 13 Step 1과 같은 방법, 확인 뒤 지움)를 두 번 돌림: `{"frames":3999,"p95":17,"max":44,"rows":1000000,"firstRow":900000,"seconds":66.6}` median 17ms, p99 18ms, 20ms를 넘은 frame 9개, 33ms를 넘은 frame 1개. 다시 `{"frames":4001,"p95":17,"max":26,…,"seconds":66.7}`, 20ms를 넘은 frame 5개, 33ms를 넘은 frame 0개. 기준(p95 ≤ 20ms, max ≤ 100ms) 안. 이번에 바꾼 것은 frame마다 하는 일을 늘리지 않음(header 너비는 mount와 두 번 누를 때만 잼)
  - `pnpm check` 통과(vitest 371)
  - 확인용 프로젝트(scratchpad의 `m4fix`)와 그것이 만든 키체인 항목(`…/m4fix::local`)을 지움
- M4 완료. Task 2~12를 구현하고(`d020ebf`..`d7c964b`) Task 13에서 완료 기준을 확인함. 앱 동작은 Bash(CGEvent, System Events, `screencapture`와 녹화, Vision OCR)로 `scripts/build-app.sh --debug`의 `.app`에서 확인함
  - Step 1(100만 행 스크롤): 임시 probe(`VITE_CHILLA_SCROLL_PROBE`일 때만 켜짐, 확인 뒤 지움)가 결과가 오는 동안 매 frame 맨 아래로 스크롤하며 `SELECT * FROM big_table`을 끝까지 받음. `SCROLL_PROBE {"frames":4004,"p95":18,"max":29,"rows":1000000,"firstRow":900000,"seconds":66.7}`, median 17ms, p99 18ms, 20ms를 넘은 frame 7개, 33ms를 넘은 frame 0개. 맨 위 줄은 `Rows 1–900,000 were dropped · run again to see them`. 기준(p95 ≤ 20ms, max ≤ 100ms) 안이라 성능은 고치지 않음. 60Hz display, debug build
  - Step 2: 15항목 중 13항목은 기대대로, 2항목(4행, 6행)은 일부만 확인함
    - 시작부터 프로젝트 화면까지 0.54, 0.52, 0.39s. 신호등 중심 (20, 22)pt, 창 위 3px bar. 탭 줄과 sidebar 위 38px 줄을 끌면 창이 (100, 50) 움직임
    - 에디터 글자 폭 7.5px(D2Coding 15px), 표 6.5px(13px). `Running 1.1 s`(9행에서 봄), `500+ rows · 6 ms`
    - wheel 스크롤 녹화(60fps)에서 빈 frame과 위치 튐이 없음. 10만 행을 넘긴 뒤 batch가 앞 500행을 버리는 동안(`Rows 1–30,500` → `31,000`) 보던 행이 그 자리에 있음. 합성한 trackpad momentum 스크롤 중에 앞 행이 버려져도 momentum이 끝까지 감(버림 없이 450행, 버리며 449행 이동). `Run again`이 다시 실행함
    - 4행: `Fetching next 500 rows`는 보지 못함. 로컬 DB에서는 batch가 녹화의 한 frame(16ms)보다 먼저 와서 끝 줄이 그려지지 않음. 행은 멈추지 않고 이어짐
    - 6행: 끄는 동안 너비가 바뀌고 두 번 누르면 맞춰지지만 맞춘 너비가 1px 좁아 가장 긴 값이 `…`로 잘림(아래 "찾은 것" 1)
    - 셀 복사는 `569553`, 행 두 개는 TSV 두 줄(각 8칸, JSON 안의 `"`는 `""`), 알림 `Copied cell`, `Copied 2 rows (tab-separated)`. TextEdit 대신 `pbpaste`로 확인함. 표에 행이 선택된 채 에디터에서 고른 `big_table`을 `Cmd+C`하면 `big_table`이 복사되고 버튼은 `Run selection`
    - Cancel 앞뒤로 버튼 자리 폭이 같고 `Cancelled` 화면. `syntax error at or near "SELEC"`, `SQLSTATE 42601`, `Ln 1, Col 1`, `Copy message` 뒤 `pbpaste`가 그 message. `UPDATE big_table SET name = name WHERE id = 1;`은 `1 row updated`
    - 결과 panel과 에디터가 각각 120px에서 멈춤. tree의 `billing`을 접고 `users.sql`을 열면 강조되고 고치면 `Unsaved` 점
    - `color = "red"`를 넣고 다시 열면 bar, 탭 dot, chip, sidebar dot이 빨강이고 오류 화면에는 빨간 pixel이 없음
    - 화면 screenshot을 한국어로 OCR해도 한국어 문구가 없음. 글꼴과 clipboard(`copy` event, `copyText`)가 동작해 CSP에 막힌 것이 없음
    - 리뷰에서 앱으로만 볼 수 있다고 한 것: 앞 행을 버릴 때 빈 frame 없음, momentum 유지, 버린 구간 줄과 끝 줄은 가로 스크롤해도 제자리(`sticky`), 컬럼 경계 끌기 동작, 탭 줄과 sidebar 위 줄로 창 끌기 동작, 탭 15개에서 탭 줄 가로 스크롤 동작(새 탭이 보이게 스크롤되고 `+`는 오른쪽에 남음), 알림은 바닥에서 40px라 24px status bar를 가리지 않음
  - Step 3: release `.app`(`scripts/build-app.sh`, 58초)이 debug `.app`에서 저장한 비밀번호로 확인 창 없이(SecurityAgent process 없음) 실행함
  - `pnpm check` 통과(vitest 356, cargo test 220 passed / 1 ignored)
  - 찾은 것. Task 13은 Step 1의 성능 문제만 고칠 수 있어 그대로 두었고, 뒤에 모두 다룸(위의 "M4 Task 13에서 찾은 것 고침")
    1. 자동 너비와 행 번호 column이 1px 좁다. 칸의 `border-r` 1px이 너비 안에 들어가는데 `CELL_PADDING`(20)이 이를 세지 않는다. 가장 긴 값(`2026-09-24 04:07:00+00`, `user_569553`)과 결과의 행 수와 자릿수가 같은 행 번호(`1,8…`, `1,000,0…`)가 `…`로 잘린다 → 고침(`3d742ed`)
    2. 결과 header의 `{n}+ rows`가 보관한 행 수(`rows.length`)라 10만 행 상한을 넘으면 128,000번째 행을 볼 때도 `100,000+ rows`에 머문다. 끝나면 `1,000,000 rows`로 맞게 나온다 → 고침(`b92d210`)
    3. 에디터와 결과 panel의 경계를 끌면 화면의 글자가 선택된다(`pointerdown`에서 `preventDefault`하지 않음) → 고침(`560e6e0`)
    4. column header 이름은 system font semibold인데 너비는 D2Coding 반각으로 센다. `amount`가 64px에서 `amo…`로 잘린다 → 고침(`7447fc7`)
    5. 복사 알림은 창 가운데 아래에 뜬다(`fixed`). 계획은 결과 panel 아래 가운데 → 고침(`299af53`)
    6. `End` key처럼 한 번에 멀리 가면 행이 그려지기 전의 빈 몸통이 약 130ms(30fps 녹화의 4 frame) 보인다. wheel 스크롤에서는 없다 → 고침(`8983e15`). 원인은 WebKit의 `End` 스크롤 애니메이션
    7. toolbar의 접속 menu가 열려 있는 동안 에디터의 글자와 줄 번호가 그려지지 않는다(status bar의 `Ln 1, Col 1`은 그대로). menu를 닫으면 다시 보이고, 다시 열면 또 사라진다. probe build와 일반 debug build에서 재현함. 원인은 보지 않았다 → 결함이 아니었다. 문서가 두 줄뿐이라 열린 menu(불투명, 높이 약 73px)가 그 두 줄을 덮었을 뿐이다. 16줄 문서에서는 menu 아래의 1~3행만 가려지고 나머지는 그대로 보인다
  - 이미 있던 Rust test `first_500_rows_of_a_million_arrive_within_100ms`(`crates/chilla-core/tests/queries.rs`)가 M4 동안 두 번의 `pnpm check`에서 부하 중에 한 번씩 실패하고 다시 돌리면 통과함(flaky). 고치지 않음
  - 확인용 프로젝트(scratchpad의 `m4check`)와 그것이 만든 키체인 항목(`…/m4check::local`)을 지움. 다른 키체인 항목은 건드리지 않음
- M4 Task 1: release `.app`을 dev 빌드와 같은 identity로 서명하는 `scripts/build-app.sh`를 만들고 identity 고르기를 `scripts/signing-identity.sh`로 모음(release `.app`이 dev가 만든 키체인 항목을 확인 창 없이 16.84ms에 읽음). overlay title bar를 켜고 `trafficLightPosition`을 `{13, 24}`로 맞춤(신호등 원이 지름 14pt라 계획 값 `{14, 22}`에서 1pt, 2pt 어긋났음). clipboard plugin을 더하고 `copyText`를 씀. 결과 표의 `Cmd+C`는 `copy` event로 처리하기로 함. D2Coding은 CSP를 바꾸지 않고 읽힘. 계획에서 정한 것 18개와 확인 결과 4개를 결정 기록에 옮기고 기획서 1장·4.6과 마일스톤 M4, M5, M6, M8을 고침. 임시 probe(`KEYCHAIN_PROBE`, probe 화면, 임시 글꼴)는 확인 뒤 지우고, probe가 만든 키체인 항목(`/private/tmp/chilla-m4-probe::probe`)도 지움
- M4 계획 작성(`docs/plans/M4-result-table.md`, Task 13개). 계획을 쓰면서 확인한 것(TanStack Table v9.3.1의 API, D2Coding의 advance 500/1000 em, `tauri-utils` 2.10.2의 overlay title bar 옵션, clipboard plugin 2.5.0)은 계획 맨 위 표에 있다. webview가 있어야 하는 확인은 Task 1에 둠
- M3 완료. Task 13의 완료 기준을 모두 확인함
  - Step 1의 15항목이 모두 기대대로 동작함. 10행(한글 조합 중의 `Cmd+S`, `Cmd+Enter`, 그리고 `Cmd+Z`)은 사용자가, 나머지는 Claude가 computer use로 `.app` debug build에서 확인. 4행 표에 500행과 `500행 표시 · 더 있음`, 5행 `취소됨 · 1.20 s`, 6행 `줄 1:11`, 14행 종료 0.23초 뒤 `ChillaSQL` 세션 0개
  - Step 2: 시작 시간 765, 423, 363ms(기준 1초)
  - Step 3: 빌드된 앱에서 CSP 때문에 막힌 것 없음(에디터 색, 표)
  - `pnpm check` 통과(vitest 213, cargo test 219 passed / 1 ignored). `4cd0db6` 이후 처음 기록
  - 계획과 달라진 것은 계획의 "Task 13 실행에서 달라진 것"에 적음. 앱을 고친 것은 없음
  - 고치지 않은 review 지적은 2026-11-12 항목 그대로다. Task 13에서 새로 나온 문제는 없음
  - Ruling 1~15(`.superpowers/sdd/M3-project-editor/progress.md`, local)를 사용자에게 보여 줌
- UI 디자인 캔버스(claude.ai artifact "ChillaSQL UI 리디자인", 비공개)에 디자인 리뷰를 반영함. Main을 고치고 결과 panel 상태, 위험 쿼리와 트랜잭션 확인, 접속 sheet, 프로젝트 열기 화면을 다시 그림. 터널 상태와 시각 system token artboard를 새로 만듦. 결정 5개를 결정 기록에 남기고 기획서 4.1, 4.3, 4.7, 4.8을 고침
- milestone 범위와 캔버스를 맞춰 보고 빠진 화면을 채움. 새 artboard: 탭과 접속(M3·M4·M6), 확인 dialog 모음(M3·M6), sidebar 스키마와 기록(M7·M8·M9), 에디터와 결과 도구(M7~M10). 결과 panel 상태에 timeout과 나눌 수 없는 text를 더함
- 앱 종료 dialog는 "모두 Rollback"과 취소만 두기로 하고 기획서 4.3을 고침
- 화면 언어(영어 기본, 한국어 선택)와 글꼴(system font, D2Coding 1.4.0)을 정하고 기획서 1장, 2장, 5장과 M4, M8을 고침. 캔버스 문구를 영어로 바꿈. 상태를 설명하는 heading은 디자인 메모라 한국어로 둠
- 캔버스를 다듬음: 글자 크기 token을 17/15/13/12로 키움(에디터 15px에 줄 24px, 결과 표 13px, control 높이 28px은 그대로). 문장 안의 SQL은 inline code로 씀. label이 바뀌는 실행 버튼과 취소 버튼은 너비를 고정함. dialog 본문은 fg-2로 제목과 구분함
- 캔버스의 기능은 모두 구현하기로 하고, 빠져 있던 것을 기획서 4.3, 4.5, 4.6, 4.7과 M4~M9에 넣음. 디자인 적용은 M4
- 캔버스 사본과 D2Coding을 `docs/design/`에 받아 둠. 구현할 때는 사본을 읽고, artifact는 보거나 고칠 때만 연다
- 문서 정합성 검토: "지금"의 작업 위치를 git과 맞춤. 기획서 3장의 깨진 구조 그림을 text 그림으로 바꿈. 기획서 8장, 9장, 4.1(고를 수 있는 색), 4.4(Reformat), 4.10(M4 이후의 키), "만들지 않는 것"을 오늘 정한 것과 맞춤. 단축키 표기를 `Cmd+Enter` 꼴로 통일
- `4cd0db6`(13:18): 접속 입력란과 파일 경로 입력에서 자동 수정, 자동 대문자, 맞춤법 검사를 끔. 이 세션 밖에서 commit됨
- M3 Task 13의 15항목은 사용자가 일부를 확인했고 모두 기대대로 동작함. 앞으로 동작 확인은 Claude가 직접 하고, 사용자에게는 해도 되는지만 묻는다
- 정하지 않은 것은 기획서 9장에 모음(key 이름, 단축키, 파라미터 값 넣는 방식, 내보내기 범위)
- 보류: 오래 열린 트랜잭션을 시간이 지나면 더 강조하는 것. 대신 모든 탭에 TX와 경과 시간을 항상 표시
- M3 Task 13 Step 2(시작 시간): 765, 423, 363ms로 기준 안. 15행 확인. Step 1의 나머지는 화면을 클릭하고 입력해야 하는데, 이 세션(Claude Code CLI)에는 computer use 도구가 없어 하지 못함(뒤에 desktop app 세션에서 끝냄. 위의 "M3 완료")
- M3 확인 중 키체인에 남은 시험용 항목(`~/projects/chillasql-m3check::local`)을 지움. 확인용 디렉토리는 이미 지워져 있었음

### 2026-11-12

- M3 Task 13 전까지 확인: `pnpm check` 통과(HEAD `bc5c420`). vitest 211(21 files), cargo test 219 passed / 1 ignored. 남은 것은 Task 13의 손으로 확인(Step 1, 3)과 시작 시간 측정(Step 2), 완료 기록(Step 5)
- 알려진 것(M3에서 고치지 않았고 지금 code에서도 그대로인 것)
  - 실행 중에 거절된 `Cmd+Enter`(빈 줄 등)는 화면에 아무 표시가 없다. 빈 줄에서 누른 `Cmd+Enter`가 무반응으로 보인다
  - CRLF가 하나라도 있는 파일은 전체를 CRLF로 표시하고 저장한다. 대부분 LF인 파일은 모든 줄이 CRLF로 저장된다
  - `save_connection`에서 파일과 state를 바꾼 뒤 `passwords.set`이 실패하면 화면의 project가 어긋난다(저장을 다시 누르면 맞춰짐). 쓰는 동안 프로젝트가 다시 열려 `ProjectChanged`가 나도 파일과 키체인에는 반영되어 있다
  - SQL 파일 목록은 깊이와 개수 제한 없이 디렉토리 전체를 돈다. `resolve`와 open 사이의 TOCTOU도 그대로다(`create_new`와 symlink 검사가 막는 범위 밖)
  - `targetChanged`는 `sslrootcert`를 문자열로 비교한다. 접속 테스트 결과가 값을 고친 뒤에 도착하면 옛 값의 "연결됐습니다"가 보인다(테스트 중에도 input이 enabled). `open`이 겹치면 늦게 끝난 쪽이 state를 차지한다. 수정 버튼들의 accessible name은 모두 "수정"이다
  - `missing` 화면은 안내 문구와 같은 말의 `project_not_found` 오류를 한 번 더 보여 준다
  - `concurrent_saves_run_one_at_a_time`은 50ms 대기에 기댄다. `FakeFiles::list`는 호출을 기록하지 않아 `list_sql_files`가 프로젝트 디렉토리를 넘기는지 단언이 없다. `dialog.ts`의 `async`는 불필요하다
  - `scripts/cargo-runner.sh`는 `cargo run --release`의 `chillasql` binary도 서명한다(무해)
- M3 code review high: 지적 10건 중 8건을 고침(commits `6d18a8d`..`bc5c420`)
  - 접속의 연결 대상을 고쳐 저장하면 그 접속을 쓰는 탭의 세션을 놓음(`applySavedProject`)
  - 접속 추가가 이미 있는 이름의 접속을 덮어쓰지 않음(`toConnection`의 `taken`)
  - 밖에서 지워진 파일은 물어본 뒤 다시 만들어 저장함
  - 시작하지 못한 실행(거절된 `Cmd+Enter`)이 진행 중인 쿼리를 화면에서 떼어 내지 않음(attempt와 token으로 나눔)
  - 프로젝트에 없던 이름으로 저장할 때도 남아 있던 비밀번호를 지움. simplify에서 넘어온 `ProjectChanged` 문구("연결하는 동안…")도 같이 고침
  - CRLF 파일을 저장할 때 줄 끝을 CRLF로 돌려 씀. 계획이 정한 `EditorState.lineSeparator`는 붙여 넣은 `\n` text가 한 줄로 들어가 쓰지 않고 tab id Set과 `documentFileText`로 함
  - 프로젝트 바꾸기와 탭 닫기의 dialog가 실패하면 오류를 보여 줌
  - 덮어쓴 파일이 umask와 상관없이 기존 권한을 그대로 가짐
  - 다시 review한 결과 8건 모두 해결됐고 새 Critical, Important는 없음. 다시 review에서 나온 minor 하나(CRLF가 하나라도 있으면 전체를 CRLF로 저장)는 드문 경우라 둠
  - 고치지 않은 것
    - `save_connection`이 파일을 쓸 수 있는지 확인하기 전에 비밀번호를 지움: Ruling 6이 알고 고른 순서. 쓰기가 실패하면 다시 입력하면 되고, 반대 순서는 옛 비밀번호가 새 host로 갈 수 있음. 읽기·검증과 rename을 나누려면 port를 두 단계로 쪼개야 함
    - 파일과 state를 바꾼 뒤 `passwords.set`이 실패하면 화면의 project가 어긋남: 키체인 쓰기가 실패해야 하는 드문 경우이고 열려 있는 form에서 저장을 다시 누르면 맞춰짐. 고치려면 `save_connection`에서 비밀번호 저장을 떼어 command를 둘로 나눠야 함
    - cap 밖 후보 4건 중 3건: SQL 파일 목록의 깊이·개수 제한 없음, button class 중복, `targetChanged`의 `sslrootcert` 문자열 비교. 값이 작거나 simplify에서 이미 건너뜀
- M3 simplify: reviewer 4개(reuse, simplification, efficiency, altitude)가 본 뒤 implementer 둘(Rust, 화면)이 고침(commits `7e5d112`..`ac98090`). vitest 175 → 197
  - Rust: 임시 파일 쓰기를 `atomic_write.rs`로 모음(target 없음의 처리, 임시 파일 이름, 권한을 열 때 줌, `sync_all`). `save_connection`을 `save_lock`으로 직렬화하고 `ProjectChanged`여도 입력한 비밀번호를 저장. 이중 검사(`has_sql_extension`, `error.rs`의 바깥 arm)와 작은 곳(`expect`, `read`의 capacity, `indent` 이름) 정리
  - 화면: 오류 읽기를 `errors.ts` 한 곳에(`messageOf`, `isCommandError`). run token이 문장 고르는 동안도 덮고, 세션 slot 정리를 token과 떼고 `reset`이 세션을 닫음. 저장의 중복 막기와 이름 검사를 `saveTab` 안으로. 접속 form이 열리면 단축키를 멈추고 디렉토리 고르기 실패를 보여 줌. 끝난 결과가 표를 다시 만들지 않고 시간과 긴 값의 경계를 고침. test의 `deferred`와 store 초기화를 `src/test/`로 모음
  - 고치지 않은 것
    - `FileError::TooLarge` 문구의 "16 MiB"가 `MAX_BYTES`와 따로 적혀 있음: variant에 limit을 실으면 port의 type이 바뀜. 문구는 계획이 정한 것
    - `save_connection`이 `App`과 같은 `validate()`를 한 번 더 함: port가 스스로를 지키는 쪽으로 둠. `write_fields`의 두 번 호출, `make_parent_dirs`의 닿지 않는 arm, `tests/project_file.rs`의 helper 중복, app test의 `PasswordKey` helper: 값이 작음
    - `resolve`와 open 사이의 TOCTOU: 혼자 쓰는 앱이고 `create_new`와 symlink 검사가 이미 있음
    - `Tab`의 `path`와 `stamp`를 하나로 묶기, `saveTab`의 반환값 없애기, `ProjectStatus`에서 `"missing"` 빼기: 계획이 정한 interface이고 여러 파일과 test를 고쳐야 해서 값에 비해 변경이 큼
    - `ConnectionForm`의 field를 배열로 그리기, Tailwind button class 공유, `Workspace`의 wrapper 세 곳, StrictMode once-guard hook: 겉모양 정리이고 공용 UI module이 아직 없음. test fixture 공유: 파일마다 값이 조금씩 달라 override가 많아짐
    - 선택 영역 실행에서 문서 전체를 복사하지 않기, `lineColumn`을 `doc.lineAt`으로: `Cmd+Enter`마다 1~3ms. 첫 실행에서 문장 나누기와 세션 열기를 겹치기: run token의 구조와 어긋남
    - 테스트 결과가 값을 고친 뒤에 도착하는 경우, `open`이 겹치는 경우, 수정 버튼들의 accessible name: 드문 경우이고 M3의 범위를 넘음
    - implementer가 건너뛴 두 가지: `missing` 화면에서 error alert를 그리지 않기(`create` 실패처럼 다른 오류까지 가려짐), `outcomeOf`의 rest destructuring(ESLint `no-unused-vars`가 `type`과 `elapsedMicros`를 error로 냄)
- M3 Task 1~12 완료. task마다 구현 뒤 review를 거침(Task 1~12 모두 마지막 review는 clean)
  - fix round가 있었던 task: Task 3(자동 security review가 임시 파일이 심어 둔 symlink를 따라간다고 지적해 `899559b`로 고치고, review가 `sql_files.rs`와 중복이라 지적한 temp-write를 `7a18316`에서 `atomic_write.rs` 하나로 모음), Task 4(`save_connection`이 `chilla.toml`을 쓴 뒤에 키체인을 다뤄 새 대상에 옛 비밀번호가 남을 수 있어 `1dd7c30`에서 비밀번호 삭제를 파일 쓰기 앞으로 옮김), Task 8(`connectionForm.ts`가 `ConnectionForm.tsx`와 대소문자만 달라 `c4a6ffa`에서 `connectionValues.ts`로 바꿈)
  - 계획의 결함으로 실행 중 바로잡은 것
    - Task 4: `FakeProjects::create`가 등록하는 프로젝트의 `name`이 계획에 없어 `add`와 같은 규칙(디렉토리에서 앞의 `/`를 뺀 값)으로 정함. 계획의 `save_connection` 순서가 새 대상에 옛 비밀번호를 남길 수 있어 바꿈(위의 fix round)
    - Task 5: `WriteModeDto`의 unit variant가 `deny_unknown_fields`를 적용받지 않아 빈 struct variant로 바꿈
    - Task 8: 파일 이름 충돌(위의 fix round). Global Constraints의 "저장이나 테스트가 끝나면 (비밀번호를) 비운다"를 "저장이 끝나면 비운다"로 고침
    - Task 9: 닫은 문서를 mount된 `SqlEditor`의 다음 transaction이 되살릴 수 있어 `setDocumentState`를 "열려 있지 않은 id면 아무것도 하지 않음"으로 바꿈(Task 10에서)
    - Task 11, 12: 프로젝트 전환 중 시작된 실행의 세션이 새 프로젝트에서 열린 채 잊히는 창이 있어 `switchProject`가 탭마다 `release`를 부른 뒤 `reset`하도록 함(이후 simplify에서 `reset`이 세션을 닫는 것으로 바뀜). Task 12의 `commandFor` test는 `KeyboardEvent`를 만들어 `Keys` type의 excess property 오류를 피함
  - Task 5, 6, 12가 diff만으로 확인할 수 없어 Task 13 Step 1에 넘긴 것은 위 "지금"에 있음
- M3 Task 1: dev 빌드를 cargo runner에서 이 Mac의 code signing identity로 서명하게 하고(다시 빌드해도 키체인 확인 창 없음, 읽기 9~10ms), CSP를 켬(빌드된 앱에서 violation 없음, CodeMirror style과 20,000자 Channel 메시지 통과). CodeMirror package를 더하고 계획에서 정한 것을 결정 기록과 기획서, 마일스톤에 옮김. 임시 probe(`probe.rs`, `probe.ts`)는 확인 뒤 지움
- M3 계획 작성. 마일스톤의 "먼저 확인할 것" 중 커서 문장 고르기는 계획에서 정했고(M2의 `split_statements`를 씀), CSP와 dev 빌드 서명은 계획을 쓰면서 `tauri` 2.12.5, tauri-cli, `style-mod` 4.1.4의 source와 scratch script(저장소 밖)로 확인한 사실을 계획 맨 위 표에 적음: desktop `tauri dev`에는 CSP가 붙지 않음(빌드된 앱에만), CodeMirror는 `<style>` tag를 넣어 `style-src`에 `'unsafe-inline'`이 필요함, 기본 menu의 `Cmd+W`가 창을 닫음, `tauri dev`는 `cargo run`이라 cargo의 runner에서 서명할 수 있음, 이 Mac에 유효한 code signing identity가 이미 있음, `lang-sql`의 `PostgreSQL` dialect가 `$$`·`::`·JSONB 연산자를 오류 없이 나눔. webview가 있어야 하는 확인(서명 뒤 키체인 확인 창, 실제 CSP header)은 Task 1에 둠. 결정 기록에는 Task 1에서 옮김

### 2026-11-11

- M2 완료. 완료 기준 확인: `scripts/test-db.sh reset`(100만 행 `big_table` 생성, 9.5초) 뒤 `pnpm check` 통과
  - `$$` 블록, 문자열, 주석 안의 `;`를 경계로 보지 않음: `statements::semicolons_inside_dollar_quotes_strings_and_comments_are_not_boundaries`
  - 100만 행 쿼리의 첫 500행이 0.1초 안에 도착: `queries::first_500_rows_of_a_million_arrive_within_100ms`가 `execute`부터 sink까지 4.31ms. Channel에서 webview까지는 Task 1에서 잰 값으로, 50ms 간격일 때 median 6.96ms, max 13.90ms, 200 batch를 한꺼번에 보냈을 때 630ms
  - 10초짜리 `pg_sleep` 쿼리가 취소 후 1초 안에 끝남: `queries::sleeping_query_ends_within_a_second_of_cancel`이 1.90ms
- simplify로 test 가짜 연결을 `test_support/connection.rs`로 나누고 공용 helper를 뽑았으며, session actor의 panic 경로를 없애고 중복을 정리함(7건 모두 반영). `split_statements`를 async command로 바꿈
- code review high 지적 10건 중 8건을 고침: UTF-8이 아닌 값의 panic(`client_error`), DB 오류가 아닌 stream 오류에서 연결을 실제로 끊기, 대기 중인 쿼리의 cancel, `Draining` 쿼리의 실제 결과 보고, cancel을 peer address로 보내기, NUL 문자가 든 text의 `client_error`, 오류 `position`의 단위(0-based UTF-16), look-ahead로 끝난 쿼리의 `fetch_more`. 다시 review한 뒤 test 2개를 더함(drain 중 버린 행의 기록 두 경로). 미뤄 둔 minor 중 actor의 cancel gate test, 재전송 간격 고정, `execute_while_draining`의 단언, splitter test 2개 등도 같이 고침
  - 고치지 않은 것
    - `establish`와 `PgCancel`이 stream을 여는 분기가 각각 6줄씩 중복. plain과 TLS가 다른 type이라 하나로 묶으려면 `Box<dyn>`이나 enum으로 M1의 연결 경로를 바꿔야 함. M5에서 터널로 여는 방법이 바뀔 때 함께 정리([마일스톤](milestones.md) M5에 적음)
    - 미뤄 둔 minor 중 cancel task panic 시 `None`(실제 cancel에는 panic 경로가 없음), sink panic(command의 sink는 panic하지 않음), `cancel_discards_a_half_read_result`의 1초(실패를 본 적 없음), splitter의 100ms timing(측정 40ms), `SessionHandle`이 `None`을 돌려주는 경우의 test, `utf16_spans`의 추가 test, cancel 실패 문구, 중첩 `BEGIN ATOMIC`의 깊이 덮어쓰기(유효한 SQL에서는 불가능)
    - 빈 결과의 `Columns` 직후에 cancel이 닿으면 `Columns` 없이 `completed`(행 수는 맞음). 화면이 `Columns` 없는 `completed`를 "행 없는 문장"으로 그리면 header만 빠짐. UTF-8이 아닌 행은 빠지고 뒤 행은 계속 전달되어 행 번호가 서버와 어긋남(outcome이 `client_error`라 사용자가 앎)
- 계획의 결함으로 실행 중 바로잡은 것: Task 5에서 `error.rs`의 kind mapping까지 함(`match`가 exhaustive라 variant만 더하면 compile되지 않음). 50회 반복 test가 cancel의 EOF 대기를 고정하지 못해 가짜 listener를 쓰는 test(`cancel_returns_only_after_the_server_closes_the_connection`)를 더함. 고정 200ms 대기를 backend가 active가 될 때까지의 대기로 바꿈. look-ahead 중에 온 `fetch_more`를 잃지 않도록 규칙을 바꿈
- 알려진 것: `query_stream` test가 Task 3 시점에 약 260회 중 1회 실패했음. 원인으로 의심된 `cancel_ends_a_sleeping_query`(`wait_until_running` 없이 cancel)를 고친 뒤 반복 실행(20회씩)에서는 재현되지 않음
- M2 계획 작성. 세션 구조를 정하는 사실은 계획을 쓰면서 `tokio-postgres` 0.7.18, `pg_query` 18.1.0 source와 scratch test(저장소 밖)로 확인해 계획 맨 위 표에 적음: 실행은 simple query protocol(값은 text), 문장 나누기는 `split_with_parser`와 `split_with_scanner` 대신 `pg_query::scan`의 token으로, cancel 요청은 서버가 연결을 닫을 때까지(EOF) 기다림, 연결이 끊기면 driver가 같은 오류를 끝없이 돌려줌. 마일스톤의 "먼저 확인할 것"(Channel 직렬화 형식)은 webview가 있어야 해서 Task 1에 둠
- M1 완료. 완료 기준 확인: `scripts/test-db.sh reset` 7초 뒤 `pnpm check` 통과. `sessions::two_sessions_open_and_close_independently`(세션 2개를 따로 열고 닫음), `tls::verify_full_rejects_a_hostname_mismatch`와 `tls::verify_full_rejects_an_untrusted_ca`(`verify-full`이 틀린 인증서를 거부), `project_file::rejects_a_password_entry`(password 항목 거부). 키체인 contract test는 손으로 돌려 통과(`cargo test -p chilla-core --test password_store -- --ignored`)
- TLS test DB 추가: `127.0.0.1:54319`, compose service `db-tls`. 인증서는 `scripts/test-db.sh`가 `db/tls/`에 만듦(gitignore)
- 자동 security review 지적 1건을 고침: 접속 테스트가 접속 이름만으로 키체인 비밀번호를 꺼내 화면이 보낸 host로 보내던 것
- simplify로 `sslmode` 오류 문구 중복, `TxTap`의 직접 만든 알림, test fixture 중복 등을 정리하고, code review high 지적 10건 중 7건을 고침: 연결 중 프로젝트 reload 감지(generation), 상태 대기 중 끊긴 세션을 `Lost`로, 화면이 보낸 `sslrootcert` 상대 경로, TCP keepalive, 없는 접속 이름의 비밀번호 저장, grouped import를 놓치던 layer 검사(`syn`으로 바꿈), 인증서를 새로 만들어도 `db-tls`가 옛 인증서를 쓰던 것
- 고치지 않은 3건
  - 주소가 여러 개인 host에서 첫 주소가 응답이 없으면 10초를 다 쓰고 다음 주소를 못 감(IPv6가 막힌 dual-stack). 지금 쓰는 접속은 `localhost`와 IP 주소라 해당하지 않음. 그런 host를 쓰게 되면 주소별로 나눠 시도하게 고침
  - `has_password`가 비밀번호 자체를 읽음. `apple-native-keyring-store`에는 값을 읽지 않는 존재 확인이 없고(`get_credential`도 값을 읽음), 직접 만들려면 `security-framework`를 따로 써야 함. 화면이 언제 부를지 정하는 M3에서 다시 봄
  - backend pid를 query 대신 startup의 BackendKeyData에서 읽기. `simple_query`로 round trip을 1번으로 줄였고, 남은 1번은 TLS와 인증의 round trip에 비해 작음. tap이 아는 protocol을 늘리지 않음
- M1 계획 작성. "먼저 확인할 것" 중 결과 나눠 받기와 트랜잭션 상태 감지는 계획을 쓰면서 `tokio-postgres` 0.7.18 source와 scratch test로 확인해 계획 맨 위 표에 적음: 결과는 portal이 아니라 stream으로 받고, 트랜잭션 상태는 `connect_raw`에 넘기는 stream을 감싸 ReadyForQuery의 상태 byte를 읽음. 결정 기록에는 Task 1에서 옮김
- M0 완료. 완료 기준 확인: `pnpm check` 통과, `scripts/test-db.sh reset` 12.8초에 `big_table` 100만 행 생성, `pnpm tauri dev`로 `ChillaSQL` 창이 뜨는 것을 screenshot으로 확인
- `pg_query` 18.1.0은 Tauri 빌드 안에서 추가 도구 없이 compile됨 (`protoc`, `cmake` 불필요). `dist/` 없이도 `cargo test` 통과
- 진행 중에 lint, formatter, 구조 규칙 task를 추가해 task가 5개가 됨 ([구조](architecture.md))
- simplify로 template의 Windows·mobile 잔재와 설정 중복을 정리하고, code review high 지적 10건 중 7건을 고침. 고치지 않은 3건: 창 크기(이후 1512×982로 바꿈), CSP(M3로 미룸), test DB seed가 `db/init` 변경을 감지하지 못하는 것(`reset`으로 해결, init 파일이 바뀔 때 다시 봄)
- test DB: `postgres://chilla:chilla@127.0.0.1:54318/chilla_test`, `scripts/test-db.sh up | reset | down`
- M0 계획 작성: Tauri 골격과 `pg_query` compile 확인, 화면 골격, test DB, 완료 확인의 4개 task
- 기획서 8장의 4단계를 마일스톤 M0~M10으로 나눔 ([마일스톤](milestones.md))
- 진행 기록 체계를 만듦: 이 파일, `docs/plans/`, `CLAUDE.md`
- 문서 파일 이름을 영어로 바꿈: `spec.md`, `milestones.md`, `progress.md`, `plans/`
