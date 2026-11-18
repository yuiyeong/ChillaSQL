# ChillaSQL

혼자 쓰는 PostgreSQL 전용 Mac 데스크톱 클라이언트. Tauri 2 + React/TypeScript, DB 연결과 터널은 Rust.

- 기획: `docs/spec.md`
- 마일스톤: `docs/milestones.md`
- 진행상황: `docs/progress.md`
- 구조 규칙: `docs/architecture.md`
- 마일스톤별 계획: `docs/plans/M<n>-<name>.md`
- 디자인: `docs/design/` (UI 캔버스 사본과 D2Coding. M4부터 화면의 기준)

## 작업 규칙

- 작업을 시작하기 전에 `docs/progress.md`의 "지금" 섹션을 읽고 거기서 이어간다.
- 마일스톤을 시작하면 `docs/plans/`에 계획을 먼저 쓰고, 진행상황의 상태를 바꾼다.
- task를 끝내면 계획 파일의 체크박스를 체크하고 commit한다.
- commit 전에 `pnpm check`를 통과시킨다.
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
