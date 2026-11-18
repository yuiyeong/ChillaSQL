# ChillaSQL

혼자 쓰는 PostgreSQL 전용 Mac 데스크톱 클라이언트. Tauri 2 + React/TypeScript, DB 연결과 터널은 Rust.

- 기획서: `docs/spec.md`
- 마일스톤: `docs/milestones.md`
- 진행상황: `docs/progress.md`
- 구조 규칙: `docs/architecture.md`
- 계획: `docs/plans/M<n>-<name>.md`
- 디자인: `docs/design/README.md`

## 코드 위치

- `crates/chilla-core/`: DB 연결, 세션, 쿼리 실행. 의존은 `infrastructure` → `application` → `domain` 방향으로만 향한다(`tests/layer_deps.rs`가 검사)
- `src-tauri/`: Tauri command. use case를 부르는 일만 한다
- `src/features/<기능>/`: 화면 기능별 component, store, hook
- `src/shared/api/`: Tauri 호출. `@tauri-apps/*`는 여기서만 import한다(ESLint가 검사)
- `src/shared/i18n/`: 화면 문구 dictionary와 `t`, `tc`, `formatCount`

## 명령

- `pnpm check`: test DB를 띄우고 format, lint, typecheck, clippy, vitest, cargo test를 돌린다
- `scripts/test-db.sh [up|reset|down]`: test DB(PostgreSQL 18, docker compose). 54318은 100만 행 seed, 54319는 SSL
- `pnpm tauri dev`: dev 실행
- `scripts/build-app.sh [--debug]`: dev 빌드와 같은 서명으로 `.app`을 만든다. 키체인 확인 창 없이 열리므로 앱 동작 확인에 쓴다

## 작업 규칙

- 작업을 시작하기 전에 진행상황의 "지금" 섹션을 읽고 거기서 이어간다.
- 마일스톤을 시작하면 계획을 먼저 쓰고(아래 개발 순서 1) 진행상황의 상태를 바꾼다.
- task를 끝내면 계획 파일의 체크박스를 체크하고 commit한다.
- commit 전에 `pnpm check`를 통과시킨다.
- commit message는 영어 conventional prefix(`feat:`, `fix:`, `docs:`, `chore:` 등) 뒤에 한국어 한 줄로 쓴다.
- 세션을 끝내기 전에 진행상황의 "지금"과 작업 로그를 갱신한다.
- 앱을 띄워야 하는 동작 확인은 Claude가 직접 한다. 사용자에게는 해도 되는지만 묻고 결과를 받아 오지 않는다. 예외는 computer use로 만들 수 없는 입력(한글 입력기의 조합 중 단축키 등)뿐이고, 이것만 사용자에게 부탁한다. 방법은 진행상황 "지금"의 "앱 동작 확인 방법"에 있다.
- 기획서나 디자인 캔버스와 다르게 정한 것은 진행상황의 결정 기록에 남긴다. 기획서와 다르면 기획서도 고친다.

## 개발 순서

구현 작업은 아래 skill을 순서대로 쓴다.

1. `superpowers:writing-plans`로 계획을 쓴다. 계획 파일은 skill 기본 경로가 아니라 `docs/plans/M<n>-<name>.md`에 둔다.
2. `superpowers:test-driven-development`로 구현한다.
3. `simplify`로 코드를 정리한다.
4. `code-review`를 high로 돌린다.
5. 나온 지적은 `superpowers:receiving-code-review`로 하나씩 다시 검토하고, 고치는 게 맞다고 판단한 것만 고친다. 고치지 않은 지적은 이유와 함께 보고한다.

## 화면 규칙

- 화면을 만들거나 고치기 전에 `docs/design/canvas/`에서 그 화면의 artboard를 읽는다. 어느 파일인지는 `docs/design/README.md`의 표에 있다. 색, 글자 크기, 버튼, dialog 규칙은 `docs/design/canvas/Tokens.dc.html`을 따른다.
- 화면 문구는 `src/shared/i18n/en.ts`에 두고 `t(key, params)`로 쓴다. component와 store에 문구를 직접 쓰지 않는다.
  - 복수형은 key 끝의 `.one`/`.other`를 `tc(key, count)`로 고른다. 1000 단위로 묶을 숫자는 `formatCount`로 바꿔 넘긴다.
  - PostgreSQL 오류 메시지, SQL, 설정 파일의 key, 결과 data는 번역하지 않는다.
  - 한국어(`ko`)와 언어 설정은 M8에서 만든다.
- 색, 그림자, 글자 크기는 `src/index.css`의 token으로만 쓴다. Tailwind 기본 palette는 꺼 두었다.
- 화면 code의 한글 문구, 기본 palette class, 색 literal은 `src/test/sourceRules.test.ts`가 막는다.
- SQL 에디터와 결과 data는 D2Coding, 나머지 화면은 macOS system font다. D2Coding은 `docs/design/fonts/`의 파일을 그대로 `public/fonts/`에 두고 `OFL.txt`를 함께 넣는다. subset하지 않는다.

## 문서 규칙

- `docs/`의 문서는 평서체("~한다")로 쓰고, 기술 용어는 영어 그대로 쓴다.
- 단축키는 `Cmd+Enter`, `Opt+Shift+Cmd+K`처럼 글자로 쓴다. 기호(`⌘`, `⇧`)는 화면 디자인에만 쓴다.
- 날짜는 `YYYY-MM-DD`로 쓴다.
- 결정 기록은 표 한 줄(날짜, 마일스톤, 결정, 이유)로 남긴다. 작업 로그는 최신 날짜가 위에 온다.
- 정하지 않은 것은 기획서 9장(미정 사항)에 모으고, 정하면 해당 장에 반영하고 9장에서 지운다.
