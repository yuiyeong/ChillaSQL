# ChillaSQL 진행상황

마지막 갱신: 2026-11-11

## 지금

- **진행 중**: 없음 (M0 완료)
- **다음 할 일**: M1 계획 작성 → `docs/plans/M1-session-core.md`
- **M1에서 챙길 것**: 첫 module을 만들 때 layer 의존 방향 test를 함께 넣는다 ([구조](architecture.md) 2장)

## 마일스톤 현황

상태: `대기` → `계획 중` → `진행 중` → `완료`

| 마일스톤 | 단계 | 상태 | 계획 | 시작 | 완료 |
| --- | --- | --- | --- | --- | --- |
| M0 셋업 | 1 | 완료 | [M0](plans/M0-setup.md) | 2026-11-11 | 2026-11-11 |
| M1 접속·세션 코어 | 1 | 대기 | | | |
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

| 2026-11-11 | M0 | dark 테마 고정, 기본 창 1600×1200(화면 가운데) | 사용자 요청. light 전환은 만들지 않음. 내장 display(14" 기본 1512×982)에서는 창이 화면을 넘을 수 있음 |
| 2026-11-11 | M0 | `@tauri-apps/*` 패키지는 `src/shared/api/`에서만 import. ESLint로 강제 | 화면 코드와 Tauri IPC 사이의 경계를 한 곳에 둠 |
| 2026-11-11 | M0 | release profile에서 `panic = "abort"`와 `strip`을 뺌 | 세션 task 하나의 panic이 앱 전체를 끝내 열린 트랜잭션을 잃지 않게 함. binary 크기는 중요하지 않음 |
| 2026-11-11 | M0 | CSP는 M3에서 켬 (지금은 template 기본값 `null`) | Vite HMR, CodeMirror가 넣는 style에 맞춰 정해야 함. M3 전에는 DB 내용을 화면에 그리지 않음 |

## 작업 로그

최신 항목이 위에 온다.

### 2026-11-11

- M0 완료. 완료 기준 확인: `pnpm check` 통과, `scripts/test-db.sh reset` 12.8초에 `big_table` 100만 행 생성, `pnpm tauri dev`로 `ChillaSQL` 창이 뜨는 것을 screenshot으로 확인
- `pg_query` 18.1.0은 Tauri 빌드 안에서 추가 도구 없이 compile됨 (`protoc`, `cmake` 불필요). `dist/` 없이도 `cargo test` 통과
- 진행 중에 lint, formatter, 구조 규칙 task를 추가해 task가 5개가 됨 ([구조](architecture.md))
- simplify로 template의 Windows·mobile 잔재와 설정 중복을 정리하고, code review high 지적 10건 중 7건을 고침. 고치지 않은 3건: 창 크기(사용자 요청), CSP(M3로 미룸), test DB seed가 `db/init` 변경을 감지하지 못하는 것(`reset`으로 해결, init 파일이 바뀔 때 다시 봄)
- test DB: `postgres://chilla:chilla@127.0.0.1:54318/chilla_test`, `scripts/test-db.sh up | reset | down`
- M0 계획 작성: Tauri 골격과 `pg_query` compile 확인, 화면 골격, test DB, 완료 확인의 4개 task
- 기획서 8장의 4단계를 마일스톤 M0~M10으로 나눔 ([마일스톤](milestones.md))
- 진행 기록 체계를 만듦: 이 파일, `docs/plans/`, `CLAUDE.md`
- 문서 파일 이름을 영어로 바꿈: `spec.md`, `milestones.md`, `progress.md`, `plans/`
