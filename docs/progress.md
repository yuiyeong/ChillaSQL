# ChillaSQL 진행상황

마지막 갱신: 2026-11-11

## 지금

- **진행 중**: 없음 (M1 완료)
- **다음 할 일**: M2 계획 작성 → `docs/plans/M2-query-core.md`
- **M2에서 챙길 것**:
  - session actor(`application/session_actor.rs`)의 명령 enum에 실행을 더한다. 결과는 stream으로 받고 버릴 때는 cancel + drain
  - 받다 만 결과 stream을 들고 있는 동안에는 actor가 `tx_status()`를 기다리면 안 된다. 서버의 ErrorResponse만 읽히고 ReadyForQuery가 socket에 남으면 그 대기가 끝나지 않아 actor가 stream도 못 당기고 `Close`도 못 받는다. 실행 중인 세션의 상태는 actor가 가진 값으로 답한다
  - cancel은 `connect_raw`로 연 연결이라 `CancelToken::cancel_query_raw`에 직접 연 stream을 넘겨야 한다(SSL이면 TLS handshake도 직접)

## 마일스톤 현황

상태: `대기` → `계획 중` → `진행 중` → `완료`

| 마일스톤 | 단계 | 상태 | 계획 | 시작 | 완료 |
| --- | --- | --- | --- | --- | --- |
| M0 셋업 | 1 | 완료 | [M0](plans/M0-setup.md) | 2026-11-11 | 2026-11-11 |
| M1 접속·세션 코어 | 1 | 완료 | [M1](plans/M1-session-core.md) | 2026-11-11 | 2026-11-11 |
| M2 쿼리 실행 코어 | 1 | 대기 | | | |
| M3 프로젝트·에디터 화면 | 1 | 대기 | | | |
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

## 작업 로그

최신 항목이 위에 온다.

### 2026-11-11

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
