# ChillaSQL

혼자 쓰는 PostgreSQL 전용 Mac 데스크톱 클라이언트. Tauri 2 + React/TypeScript, DB 연결과 터널은 Rust.

- 기획: `docs/spec.md`
- 마일스톤: `docs/milestones.md`
- 진행상황: `docs/progress.md`
- 구조 규칙: `docs/architecture.md`
- 마일스톤별 계획: `docs/plans/M<n>-<name>.md`
- 디자인: `docs/design/` (`README.md`부터 읽는다. UI 캔버스 사본과 D2Coding)

## 작업 규칙

- 작업을 시작하기 전에 `docs/progress.md`의 "지금" 섹션을 읽고 거기서 이어간다.
- 마일스톤을 시작하면 `docs/plans/`에 계획을 먼저 쓰고, 진행상황의 상태를 바꾼다.
- task를 끝내면 계획 파일의 체크박스를 체크하고 commit한다.
- commit 전에 `pnpm check`를 통과시킨다.
- commit message는 영어 conventional prefix(`feat:`, `fix:`, `docs:`, `chore:` 등) 뒤에 한국어 한 줄로 쓴다.
- 세션을 끝내기 전에 진행상황의 "지금"과 작업 로그를 갱신한다.
- 앱을 띄워야 하는 동작 확인은 Claude가 직접 한다. 사용자에게는 해도 되는지만 묻고 결과를 받아 오지 않는다. 예외는 computer use로 만들 수 없는 입력(한글 입력기의 조합 중 단축키 등)뿐이고, 이것만 사용자에게 부탁한다. 방법은 진행상황의 "앱 동작 확인 방법".
- 기획서와 다르게 정한 것은 진행상황의 결정 기록에 남기고 기획서도 고친다.

## 개발 순서

구현 작업은 아래 skill을 순서대로 쓴다.

1. `superpowers:writing-plans`로 계획을 쓴다. 계획 파일은 skill 기본 경로가 아니라 `docs/plans/M<n>-<name>.md`에 둔다.
2. `superpowers:test-driven-development`로 구현한다.
3. `simplify`로 코드를 정리한다.
4. `code-review`를 high로 돌린다.
5. 나온 지적은 `superpowers:receiving-code-review`로 하나씩 다시 검토하고, 고치는 게 맞다고 판단한 것만 고친다. 고치지 않은 지적은 이유와 함께 보고한다.

## 화면 규칙 (M4부터)

- 화면을 만들거나 고치기 전에 `docs/design/canvas/`에서 그 화면의 artboard를 읽는다. 어느 파일인지는 `docs/design/README.md`의 표에 있다. 색, 글자 크기, 버튼, dialog 규칙은 `Tokens.dc.html`을 따른다.
- 캔버스와 다르게 만들면 진행상황의 결정 기록에 남긴다. 캔버스(claude.ai artifact "ChillaSQL UI 리디자인")를 고치면 `docs/design/canvas/`를 다시 받아 함께 commit한다.
- 화면 문구는 영어 dictionary(`en`)에 두고 `t(key)`로 쓴다. component에 문구를 직접 쓰지 않는다. 한국어(`ko`)와 언어 설정은 M8이다. PostgreSQL 오류 메시지, SQL, 설정 파일의 key, 결과 data는 번역하지 않는다.
- SQL 에디터와 결과 data는 D2Coding, 나머지 화면은 macOS system font다. font는 `docs/design/fonts/`의 파일을 그대로 쓰고 `OFL.txt`를 함께 넣는다. subset하지 않는다.

## 문서 규칙

- `docs/`의 문서는 평서체("~한다")로 쓰고, 기술 용어는 영어 그대로 쓴다.
- 단축키는 `Cmd+Enter`, `Opt+Shift+Cmd+K`처럼 글자로 쓴다. 기호(`⌘`, `⇧`)는 화면 디자인에만 쓴다.
- 날짜는 `YYYY-MM-DD`로 쓴다.
- 결정 기록은 표 한 줄(날짜, 마일스톤, 결정, 이유)로 남긴다. 작업 로그는 최신 날짜가 위에 온다.
- 정하지 않은 것은 기획서 9장에 모으고, 정하면 그 장에 반영하고 9장에서 지운다.
