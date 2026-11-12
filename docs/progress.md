# ChillaSQL 진행상황

마지막 갱신: 2026-11-12

## 지금

- **진행 중**: M3 계획 중. 계획은 [M3](plans/M3-project-editor.md)에 썼고 사용자 검토를 기다린다
- **다음 할 일**: 계획이 확정되면 Task 1(dev 빌드 서명, CSP, 결정 기록)부터 시작한다. Task 1에서 상태를 `진행 중`으로 바꾼다
- **M3에서 챙길 것** (M2가 화면에 주는 계약)
  - 화면은 `rows` event의 `retainedFrom`보다 앞의 행을 버리고 그 구간을 "다시 실행해야 볼 수 있음"으로 그린다
  - `split_statements`의 span과 server 오류의 `position`은 모두 보낸 text 기준 0-based UTF-16 code unit offset이다
  - 선택 영역에 문장이 여러 개면 `multiple_statements`가 온다 (M8 전까지)
  - `finished`의 outcome은 `completed`, `failed`, `cancelled`, `discarded`, `connection_lost`, `client_error` 여섯이다. cancel한 쿼리도 서버에서 이미 끝났고 버린 행이 없으면 `completed`로 온다
  - `fetch_more`는 그 세션이 발급한 query id면 끝난 쿼리에도 `Ok`다. 결과의 끝은 `finished` event로만 안다
  - 화면이 사라진(Channel이 끊긴) 쿼리는 다음 실행이나 세션 닫기 전까지 DB에 열려 있다 (자동 닫기는 M6)
  - `COPY … FROM STDIN` / `TO STDOUT`은 지원하지 않는다. 실행하면 그 세션의 연결을 끊고 `connection_lost`로 알린다

## 마일스톤 현황

상태: `대기` → `계획 중` → `진행 중` → `완료`

| 마일스톤 | 단계 | 상태 | 계획 | 시작 | 완료 |
| --- | --- | --- | --- | --- | --- |
| M0 셋업 | 1 | 완료 | [M0](plans/M0-setup.md) | 2026-11-11 | 2026-11-11 |
| M1 접속·세션 코어 | 1 | 완료 | [M1](plans/M1-session-core.md) | 2026-11-11 | 2026-11-11 |
| M2 쿼리 실행 코어 | 1 | 완료 | [M2](plans/M2-query-core.md) | 2026-11-11 | 2026-11-11 |
| M3 프로젝트·에디터 화면 | 1 | 계획 중 | [M3](plans/M3-project-editor.md) | 2026-11-12 | |
| M4 결과 표 | 1 | 대기 | | | |
| M5 터널 | 2 | 대기 | | | |
| M6 트랜잭션과 안전장치 | 2 | 대기 | | | |
| M7 스키마 트리와 자동완성 | 3 | 대기 | | | |
| M8 에디터·실행 편의 | 3 | 대기 | | | |
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

## 작업 로그

최신 항목이 위에 온다.

### 2026-11-12

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
