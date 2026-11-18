# M4 결과 표 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 결과를 가상 스크롤 표로 보여 주고 스크롤하면 이어서 가져와 100만 행 결과도 끊김 없이 스크롤하게 한다. 같은 마일스톤에서 화면 문구를 영어 dictionary로 옮기고, D2Coding과 캔버스의 token과 화면 틀을 적용해 1단계를 끝낸다.

**Architecture:** 행은 지금처럼 `runsStore`의 `ResultData.rows`(보관 상한 안의 행)에만 둔다. 새 `ResultGrid`는 TanStack Table을 column 정의와 너비 조절에만 쓰고 row model은 부르지 않는다. 몸통은 TanStack Virtual이 고른 index로 `rows[i]`를 바로 그린다. 스크롤이 보관된 행의 끝 가까이 오면 `runsStore.fetchMore`가 batch 하나에 `fetch_more`를 한 번 보낸다. 앞쪽 행이 버려지면 버린 만큼 `scrollTop`을 당겨 보던 행이 그 자리에 남는다. 화면 문구는 `src/shared/i18n`의 `t(key)`로만 쓰고, 색과 글자 크기는 `src/index.css`의 Tailwind `@theme` token으로만 쓴다.

**Tech Stack:** M3의 stack에 `@tanstack/react-table` 9.3(`useTable`, `tableFeatures`, `columnSizingFeature`, `columnResizingFeature`), `@tanstack/react-virtual` 3.14(`useVirtualizer`), `tauri-plugin-clipboard-manager` 2 / `@tauri-apps/plugin-clipboard-manager` 2.5를 더한다. `@codemirror/theme-one-dark`는 뺀다.

**Spec:** [기획서](../spec.md) 1장(화면 언어, 글꼴), 2장(결과 표, 화면 문구, SQL 글꼴), 4.6(결과 표의 나눠 가져오기, 보관 상한, 가상 스크롤, 컬럼 너비, 셀과 행 복사), 6장(결과 표 스크롤) / [마일스톤](../milestones.md) M4 / [디자인](../design/README.md)의 `Tokens`, `Main`, `States`, `TabsConn` / [진행상황](../progress.md)의 "M4에서 챙길 것"

## 먼저 확인한 것 (계획 작성 중 확인)

package의 문서와 type, `tauri-utils` 2.10.2 source, font file로 확인했다. webview가 있어야 확인할 수 있는 것은 Task 1에 둔다.

| 확인한 것 | 결과 | 결정 |
| --- | --- | --- |
| `@tanstack/react-table`의 현재 판 | 9.0.0이 2026-08-04에 나왔고 최신은 9.3.1(2026-10-12)이다. v9는 `useTable({ features, columns, data })`이고 기능은 `tableFeatures({ ... })`로 켠다. 너비 조절은 `columnSizingFeature`와 `columnResizingFeature`가 함께 있어야 하고 handle에는 `header.getResizeHandler()`를 `mousedown`과 `touchstart` 둘 다에 단다. package 안의 `skills/` 문서에 있다 | **v9를 쓴다.** `features`와 `columns`는 module scope나 `useMemo`에 둔다(바뀌면 model을 다시 만든다). row model(`getRowModel`)은 부르지 않는다. 10만 행마다 `Row` object를 만들면 batch마다 수십 ms가 든다 |
| `@tanstack/react-virtual` | 3.14.26. `useVirtualizer({ count, getScrollElement, estimateSize, overscan, paddingStart, paddingEnd, scrollMargin, initialRect })` | 행 높이가 고정(26px)이라 `measureElement`는 쓰지 않는다. jsdom test는 `initialRect`로 크기를 준다 |
| D2Coding의 글자 폭 | `hmtx` advance가 0, 500, 1000뿐이고 unitsPerEm은 1000이다 | 결과 표(13px)에서 반각 글자는 6.5px, 전각(한글 등)은 13px로 계산해 컬럼 너비를 맞춘다. canvas로 재지 않는다 |
| overlay title bar | `tauri-utils` 2.10.2의 window config에 `titleBarStyle`, `hiddenTitle`, `trafficLightPosition`이 있다 | 탭 줄이 title bar를 겸한다(`Main`). 신호등 위치와 drag는 Task 1에서 빌드된 앱으로 확인한다 |
| `tauri-plugin-clipboard-manager` | 2.5.0. `writeText(text)`, permission `clipboard-manager:allow-write-text` | 결과 header의 복사 버튼과 "Copy message"는 이 plugin으로 쓴다. `Cmd+C`의 경로는 Task 1에서 정한다(아래 표) |
| Edit menu의 Copy | M3에서 menu의 key equivalent가 webview의 `keydown`보다 먼저 잡힌다고 확인했다. Copy 항목은 webview에 `copy:`를 보낸다 | 결과 표의 `Cmd+C`가 `keydown`으로 오는지 DOM `copy` event로 오는지 Task 1에서 확인한다 |

## 이 계획에서 정한 것

기획서에 없거나 다르게 정한 것이다. 해당 Task에서 진행상황의 결정 기록에 옮기고, 기획서나 마일스톤을 고쳐야 하면 같이 고친다.

- **TanStack Table은 column 정의와 너비 조절에만 쓴다.** 몸통은 virtualizer의 index로 `rows[i]`를 바로 그린다(위 표). 정렬(M10)이 row model을 쓰게 되면 그때 다시 본다.
- **이어서 가져오기**: 마지막으로 보이는 행이 보관된 행의 끝에서 100행(`FETCH_AHEAD`) 안이고 Rust가 다음 batch를 기다리는 중(`fetch === "ready"`)이면 `fetch_more`를 한 번 보낸다. 다음 `rows`나 `finished`가 올 때까지 다시 보내지 않는다. 사용자가 맨 아래에 있으면 batch가 올 때마다 바로 다음을 요청한다.
- **버린 구간**: `firstRow > 0`이면 몸통 맨 위에 높이 40px의 줄 하나("Rows 1–{n} were dropped · run again to see them"과 "Run again" 버튼)를 둔다. 앞쪽 행이 버려지면 `scrollTop`을 `(줄이 새로 생겼으면 40) − 버린 행 수 × 26`만큼 바꿔 보던 행을 그 자리에 둔다. "Run again"은 그 결과의 SQL을 지금 탭의 접속으로 다시 실행한다.
- **컬럼 너비**: 처음 너비는 header와 첫 batch의 값에 맞추고 64~480px로 자른다. handle을 두 번 누르면 header와 보관된 행 중 앞 2,000행에 맞춘다(같은 범위). 끌어서는 48px까지 줄인다. 행 번호 column은 조절하지 않는다. 너비는 실행마다 새로 정하고 저장하지 않는다.
- **선택과 복사**: 셀을 누르면 그 셀, 행 번호를 누르면 그 행, 행 번호를 Shift와 누르면 범위를 고른다. 셀 복사는 값 그대로(NULL은 빈 문자열), 행 복사는 header 없는 TSV다. NULL은 빈 칸이고, tab, 줄바꿈, CR, `"`가 든 값은 `"`로 감싸고 안의 `"`를 `""`로 쓴다(Numbers, Google Sheets가 읽는 형식). 복사하면 결과 panel 아래 가운데에 2초 동안 알림을 띄운다. 버린 구간의 행은 고를 수 없다.
- **표시**: NULL은 fg-3 기울임의 `NULL`, 빈 문자열은 fg-3의 `''`다. 300자를 넘는 값은 앞부분과 `…`만 그린다(M3와 같음). 한 줄로 그리고 넘치면 `…`로 자른다. column header의 type 표시와 숫자 오른쪽 정렬은 type을 알아야 해서 M8이다.
- **결과 header의 이름**은 SQL의 첫 단어(대문자)와 `FROM`, `INTO`, `UPDATE`, `TABLE`, `JOIN` 뒤의 첫 이름이다. 없으면 첫 단어만이다(예: `SELECT users`, `UPDATE users`, `SELECT`). 32자에서 자른다.
- **행을 돌려주지 않는 문장**: 첫 단어가 `INSERT`, `UPDATE`, `DELETE`, `MERGE`면 "12 rows inserted/updated/deleted/merged", 그 밖은 "Done"이다. 서버의 command tag는 받지 않으므로 캔버스의 `UPDATE 12`는 그리지 않는다.
- **오류 화면**은 서버 메시지(mono 15), detail, hint, `SQLSTATE`, 줄과 칸, 소요 시간, "Copy message" 버튼이다. "Go to error"는 에디터의 오류 밑줄과 함께 M8이다. 오류도 빨간 글자가 아니라 icon과 문장으로 구분한다(Tokens의 규칙).
- **toolbar**: 접속 chip과 접속 menu, 너비를 고정한 split 실행 버튼(왼쪽 200px, 오른쪽 26px)이다. 실행 중에는 같은 자리가 227px의 Cancel 버튼이 된다. 오른쪽 menu의 "Run file"은 M8까지 disabled다. Auto/Manual(M6), Reformat(M8), Explain(M9)은 넣지 않는다. **Save 버튼은 뺀다**(캔버스에 없음. `Cmd+S`는 그대로).
- **sidebar**: Files, Schema, History 탭 중 Schema(M7)와 History(M9)는 disabled다. 파일 목록은 디렉토리 tree이고 처음에는 모두 펼친다.
- **접속 색**: `chilla.toml`의 `color`가 `green`, `yellow`, `red`, `blue`, `purple`이면 그 token, 아니거나 없으면 line-2(회색)로 그린다. 창 상단 bar, 탭 dot, toolbar chip, sidebar와 접속 menu의 dot에만 쓴다. 값 검사와 접속 sheet의 `color` 칸은 M6이다.
- **결과 panel 높이**는 396px로 시작하고 에디터와의 경계(5px)를 끌어 바꾼다. 에디터와 결과 panel은 각각 120px 밑으로 줄지 않는다. 저장하지 않는다.
- **빈 상태**: 결과 panel과 탭이 없는 에디터는 `⌘↵ Run statement at cursor`, `⇧⌘L New tab`을 보여 준다. 캔버스의 `⌥⌘L Reformat`은 M8에 더한다.
- **화면 문구**: 영어 dictionary `en`(`src/shared/i18n/en.ts`)과 `t(key, params)`. 복수형은 key 끝의 `.one`/`.other`를 `tc(key, count)`가 고른다. 숫자는 `en-US` 묶음(`124,500`)이다. **Rust가 보내는 오류 message도 영어로 바꾼다**(M1~M3의 "사용자에게 보이는 message는 한국어"를 대신한다). 한국어는 M8에서 오류 `kind`별로 화면이 번역한다. macOS menu는 이미 영어(`PredefinedMenuItem`의 기본 label)라 M4에서 고치지 않는다.
- **확인 dialog는 native(`ask`)로 둔다.** 문구만 영어로 옮긴다. 캔버스의 dialog 모양은 M6에서 Commit/Rollback을 고르는 dialog를 만들 때 함께 바꾼다. 이름 없는 탭의 저장 경로 입력은 이미 화면의 form이라 캔버스의 "Save Query 1" dialog로 바꾼다.
- **접속 sheet와 프로젝트 열기 화면**은 token, 버튼, 문구만 바꾸고 배치는 그대로 둔다. sheet 배치는 `tunnel` 칸을 더하는 M5에서, 프로젝트 열기 화면은 최근 프로젝트 목록을 더하는 M8에서 캔버스대로 바꾼다.
- **release 빌드 서명**은 Task 1에서 정한다. 계획의 기본안은 `scripts/build-app.sh`가 `pnpm tauri build --bundles app`으로 `.app`을 만든 뒤 `cargo-runner.sh`와 같은 identity, 같은 identifier(`com.yuiyeong.chillasql`)로 `codesign`하는 것이다(M3 Task 13에서 쓴 방법). identity를 고르는 code는 `scripts/signing-identity.sh` 하나로 모은다.

## Global Constraints

- M1~M3의 Global Constraints를 따른다(macOS 전용, `chilla-core`는 `tauri`에 의존하지 않음, 탭 = 세션, 비밀번호는 `Password`로만, JSON의 키는 camelCase이고 구분 값은 snake_case, DB 값과 server message는 React의 text node로만 그림, 단축키는 `KeyboardEvent.code`로 판별, 문서 text는 `EditorState`에만). 바뀌는 것은 아래 둘이다.
  - 사용자에게 보이는 문구는 영어다. 화면 문구는 `t(key)`/`tc(key, count)`로만 쓰고 component와 store에 직접 쓰지 않는다. PostgreSQL 오류 메시지, SQL, `chilla.toml`의 key, 결과 data는 번역하지 않는다.
  - 색은 Tokens의 token으로만 쓴다. Tailwind의 `zinc` 등 기본 palette와 `#rrggbb` literal을 `src/**/*.{ts,tsx}`에 쓰지 않는다(`src/index.css`의 `@theme`에만 있다).
- token(이름과 값은 `Tokens.dc.html` 그대로):
  - surface: `bg-0` `#0F1014`(chrome, 결과), `bg-1` `#15161B`(에디터), `bg-2` `#1C1D23`(control, dialog), `bg-3` `#262830`(선택, menu). line: `line-1` `#23252B`(구분선), `line-2` `#33363E`(control 테두리)
  - text: `fg` `#E8E9ED`, `fg-2` `#A3A6B0`(보조), `fg-3` `#8A8E99`(NULL, gutter). `accent` `#7C9CFF`(primary, 선택), `danger` `#EF6461`(M4에서는 쓰지 않음)
  - 접속: `conn-green` `#3FB68B`, `conn-yellow` `#E8B04B`, `conn-red` `#EF6461`, `conn-blue` `#56A8DC`, `conn-purple` `#A98BFF`
  - 글자 크기 4단계만 쓴다: `title` 17px(dialog와 sheet 제목, semibold), `body` 15px(본문, 버튼, 에디터), `small` 13px(보조 문장, 탭, 결과 표), `label` 12px(section label, kbd, status bar)
  - control(버튼, chip, 입력) 높이 28px, radius 7px. 선택 배경은 `accent` 14~16% 불투명도
  - SQL 문법 색(에디터와 inline SQL): keyword `#C792EA`, function `#82C8E5`, string `#A8D49B`, number `#F0B47D`, comment `#8A8E99` 기울임, operator `#A3A6B0`, identifier `#E8E9ED`, type `#FFCB6B`. 이것도 `@theme`의 token(`syntax-*`)으로 둔다
- 글꼴: SQL 에디터, 결과 data, 문장 안의 SQL 조각만 D2Coding(`font-mono`, `font-variant-ligatures: none`)이고 나머지는 system font(`-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif`)다. 에디터 15px에 줄 24px, 결과 표 13px. font file은 `docs/design/fonts/`의 것을 그대로 쓰고 `OFL.txt`를 함께 넣는다.
- 접속 색은 창 상단 bar, 탭 dot, toolbar chip, 접속 목록의 dot에만 쓴다. 상태(실행 중, 오류, 취소)는 icon과 문장으로만 구분하고 배경 tint를 깔지 않는다. primary 버튼은 화면에 하나(실행)다.
- label이 바뀌는 버튼(Run statement ↔ Run selection ↔ Cancel)은 너비를 고정한다.
- `@tauri-apps/*`는 `src/shared/api/`에서만 import한다. 새 wrapper는 `clipboard.ts`, `path.ts`다. test는 이 module들을 `vi.mock`으로 바꾼다.
- 결과 표의 행은 `ResultData.rows`에만 둔다. 화면이 따로 복사해 들고 있지 않는다.
- test DB: `postgres://chilla:chilla@127.0.0.1:54318/chilla_test`(`big_table` 100만 행).
- 모든 명령은 저장소 루트에서 실행한다. commit 전에 `pnpm check`를 통과시킨다. commit message는 영어 conventional prefix 뒤에 한국어 한 줄이다.

## Review Focus

1. **스크롤 중에 앞쪽 행이 버려짐**: 10만 행을 넘은 결과를 중간쯤 보고 있을 때 batch가 와서 앞쪽이 버려져도 보던 행이 화면에서 밀려나면 안 된다. 버린 구간 줄이 처음 생길 때도 마찬가지다. → Task 6 `anchorShift`의 test, Task 7 Step 1 `앞쪽 행이 버려져도 보던 행이 그 자리에 있다`
2. **에디터의 `Cmd+C`**: 결과 표의 복사 처리가 에디터에서 고른 text의 복사를 가로채면 안 된다. 결과 표에 focus가 있을 때만 결과를 복사한다. → Task 7 Step 1 `focus가 결과 표 밖이면 copy를 건드리지 않는다`
3. **복사한 값에 tab, 줄바꿈, `"`, NULL, 한글, emoji가 있음**: 붙여 넣은 spreadsheet에서 칸이 밀리거나 NULL이 `"NULL"` 글자가 되면 안 된다. → Task 6 `tsv`의 test
4. **`fetch_more` 중복과 끝난 쿼리**: 스크롤 event가 batch 하나에 수십 번 와도 `fetch_more`는 한 번이고, 끝나거나 취소된 결과에는 보내지 않는다. → Task 5 Step 1 `batch 하나에 fetchMore는 한 번만 보낸다`·`끝난 결과에는 fetchMore를 보내지 않는다`
5. **새 실행과 아주 긴 값**: 다시 실행하면 앞 결과의 선택, 스크롤 위치, 컬럼 너비가 남으면 안 된다. 100 KB JSONB나 한글뿐인 값이 있어도 너비 계산이 멈추지 않고 480px에서 잘린다. → Task 7 Step 1 `다시 실행하면 선택과 스크롤을 처음으로 돌린다`, Task 6 `fitWidth`의 test

---

## File Structure

```
scripts/
├── signing-identity.sh               새로. 서명 identity를 고른다(cargo-runner.sh와 build-app.sh가 씀)
├── cargo-runner.sh                   signing-identity.sh를 씀
└── build-app.sh                      새로. .app을 만들고 dev와 같은 identity로 서명
public/fonts/                         새로. D2Coding-Regular.ttf, D2Coding-Bold.ttf, OFL.txt (docs/design/fonts 사본)
src-tauri/
├── tauri.conf.json                   overlay title bar
├── capabilities/default.json         start-dragging, clipboard write
├── Cargo.toml, src/lib.rs            clipboard plugin
└── src/error.rs                      message에 한글이 없는지 test
crates/chilla-core/src/               사용자에게 보이는 message를 영어로
src/
├── index.css                         @theme token, @font-face
├── shared/
│   ├── i18n/en.ts, t.ts              새로. dictionary와 t, tc, formatCount
│   ├── api/clipboard.ts, path.ts     새로. copyText, homeDir
│   ├── api/commands.ts               fetchMore
│   └── ui/                           새로. Button, IconButton, Kbd, Menu, Toast, icons
├── test/
│   ├── setup.ts                      ResizeObserver stub
│   ├── fonts.test.ts                 새로. font file sha256
│   └── sourceRules.test.ts           새로. Hangul 문구, zinc, hex literal이 없는지
└── features/
    ├── query/
    │   ├── runReducer.ts             fetch 상태, startedAt, Rejection
    │   ├── runsStore.ts              fetchMore
    │   ├── grid.ts                   새로. 결과 표의 순수 함수와 상수
    │   ├── ResultGrid.tsx            새로. 가상 스크롤 표
    │   ├── ResultPane.tsx            header와 상태 화면
    │   └── format.ts                 affectedText, formatLive
    ├── editor/
    │   ├── extensions.ts             token theme, D2Coding
    │   ├── editorStatus.ts           새로. 선택 여부, 줄과 칸
    │   ├── documents.ts              documentLineEnding
    │   ├── SqlEditor.tsx             editorStatus 갱신
    │   ├── TabBar.tsx                title bar를 겸하는 탭 줄
    │   └── SaveNameDialog.tsx        새로. 이름 없는 탭 저장 dialog
    ├── project/
    │   ├── Sidebar.tsx               프로젝트 버튼, 접속, 탭 틀, 파일 tree
    │   └── fileTree.ts               새로. 경로 목록 → tree
    ├── connections/colors.ts         새로. 접속 color → token
    └── workspace/
        ├── Workspace.tsx             창 상단 bar, 결과 panel 경계, status bar
        ├── Toolbar.tsx               접속 chip과 menu, split 실행 버튼
        ├── StatusBar.tsx             새로
        └── commands.ts               runAgain, 영어 문구
```

---

### Task 1: 먼저 확인할 것 — release 서명, title bar, 복사 경로, 글꼴

**Files:**
- Create: `scripts/signing-identity.sh`, `scripts/build-app.sh`, `src/shared/api/clipboard.ts`
- Modify: `scripts/cargo-runner.sh`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `package.json`, `docs/progress.md`, `docs/milestones.md`, `docs/spec.md`

**Interfaces:**
- Produces: `copyText(text: string): Promise<void>`(`src/shared/api/clipboard.ts`, plugin의 `writeText`). `scripts/build-app.sh [--debug]` → `target/{release,debug}/bundle/macos/ChillaSQL.app`(서명됨). Task 7이 쓸 `Cmd+C` 경로(`copy` event 또는 `keydown`)의 결정.

webview가 있어야 하는 확인은 `scripts/build-app.sh --debug`로 만든 `.app`에서 한다(진행상황의 "앱 동작 확인 방법"). 임시 probe는 확인 뒤 지운다.

- [x] **Step 1: identity 고르기를 `scripts/signing-identity.sh`로 옮긴다**

`cargo-runner.sh`의 규칙 그대로다: `CHILLA_DEV_IDENTITY`가 있으면 그것, 없으면 `security find-identity -v -p codesigning`의 첫 유효 identity, 없으면 빈 문자열. `cargo-runner.sh`는 이 script를 `source`한다. `pnpm tauri dev`가 전처럼 서명된 binary로 뜨는지 확인한다(`codesign -dvv`에 `Identifier=com.yuiyeong.chillasql`, `Signature=adhoc` 없음).

- [x] **Step 2: `scripts/build-app.sh`를 쓰고 release `.app`이 dev가 만든 키체인 항목을 확인 창 없이 읽는지 본다**

`build-app.sh`는 `pnpm tauri build --bundles app`(인자 `--debug`면 `--debug`도)을 부른 뒤 `codesign --force --deep --sign "<identity>" --identifier com.yuiyeong.chillasql <app>`을 한다. identity가 없으면 서명하지 않고 경고를 낸다.

확인: M3 Task 1처럼 임시 probe(`has_password`를 시작할 때 부르고 걸린 시간을 stderr에 `KEYCHAIN_PROBE <ms> <existing|missing>`로 쓴다)로 dev binary가 항목을 만든 뒤, release `.app`을 `open`해 확인 창 없이 `existing`이 500ms 안에 나오면 이 방법으로 정한다. 확인 창이 뜨면 `bundle.macOS.signingIdentity`(환경 변수 `APPLE_SIGNING_IDENTITY`)로 tauri가 서명하게 바꿔 다시 잰다.

- [x] **Step 3: overlay title bar를 켜고 신호등 위치와 drag를 확인한다**

`tauri.conf.json`의 창에 `"titleBarStyle": "Overlay"`, `"hiddenTitle": true`, `"trafficLightPosition": { "x": 14, "y": 22 }`를 더한다. capability에 `core:window:allow-start-dragging`을 더한다. 임시로 `Workspace` 맨 위에 높이 3px 막대와 그 밑 38px의 `data-tauri-drag-region` 줄을 둔다.

확인: 신호등 세 개의 세로 중심이 창 위에서 약 22px(3px bar + 38px 줄의 가운데)이고 첫 원의 가로 중심이 약 20px인지 screenshot으로 본다. 다르면 `trafficLightPosition`을 고쳐 맞춘다. 38px 줄을 끌면 창이 움직이고 두 번 누르면 창이 커지는지 본다.

- [x] **Step 4: clipboard plugin을 더하고 `Cmd+C`의 경로와 글꼴을 확인한다**

`tauri-plugin-clipboard-manager` 2를 `src-tauri/Cargo.toml`과 `lib.rs`(`.plugin(tauri_plugin_clipboard_manager::init())`)에, `@tauri-apps/plugin-clipboard-manager`를 `package.json`에 더한다. capability에 `clipboard-manager:allow-write-text`를 더한다. `copyText`를 쓴다.

임시 probe 화면(`tabIndex=0`인 div 하나, 글자 선택 없음)에서 확인한다.

| 확인 | 기준 |
| --- | --- |
| div에 focus를 두고 `Cmd+C` | `keydown`(`code` `KeyC`, `metaKey`)이 div에 오는지, `copy` event가 오는지 각각 기록한다. `copy`가 오면 그 handler에서 `clipboardData.setData("text/plain", …)`와 `preventDefault()`로 넣은 값이 pasteboard에 있는지(`pbpaste`) 본다 |
| 에디터(CodeMirror)에서 text를 고르고 `Cmd+C` | 고른 text가 pasteboard에 있다(M3와 같음) |
| 버튼을 눌러 `copyText("a\tb")` | `pbpaste`가 `a<TAB>b`다. CSP 위반이 없다 |
| `public/fonts`의 D2Coding을 `@font-face`로 읽기 | `document.fonts.check("13px D2Coding")`이 `true`다. CSP(`default-src 'self'`)에 막히지 않는다 |

**결정 규칙**: `copy` event가 오고 setData가 pasteboard에 반영되면 Task 7은 `copy` event를 쓴다(menu의 Copy와 `Cmd+C`가 한 경로). 오지 않으면 `keydown`의 `Cmd+C`에서 `copyText`를 부른다. 어느 쪽이든 focus가 결과 표 안일 때만 처리한다.

- [x] **Step 5: probe를 지우고 결정을 기록한 뒤 commit한다**

probe code(`KEYCHAIN_PROBE`, 임시 div와 막대)를 지운다. "이 계획에서 정한 것"의 모든 항목과 Step 2~4의 결과(서명 방법, `trafficLightPosition` 값, `Cmd+C` 경로, plugin)를 진행상황의 결정 기록에 한 줄씩 남긴다. 마일스톤 M4의 "먼저 확인할 것"에 결과를 적고, 다음을 고친다: M5에 "접속 sheet를 캔버스 배치로", M6에 "확인 dialog를 캔버스 모양으로", M8에 "Go to error", "빈 상태의 Reformat 안내", "Run file menu 항목 켜기", "Rust 오류 message의 한국어(kind별 번역)". 진행상황의 마일스톤 현황에서 M4를 `진행 중`으로 바꾼다. "앱 동작 확인 방법"의 `.app` 만들기를 `scripts/build-app.sh --debug`로 바꾼다.

Run: `pnpm check`
Expected: 통과

```bash
git add scripts src-tauri package.json pnpm-lock.yaml src/shared/api/clipboard.ts docs
git commit -m "chore: M4 Task 1 release 서명 script, overlay title bar, clipboard plugin을 정함"
```

---

### Task 2: 화면 문구를 영어 dictionary로 옮긴다

**Files:**
- Create: `src/shared/i18n/en.ts`, `src/shared/i18n/t.ts`, `src/shared/i18n/t.test.ts`, `src/test/sourceRules.test.ts`
- Modify: 한국어 문구가 있는 모든 화면 code와 그 test(`ConnectionForm.tsx`, `connectionValues.ts`, `ProjectGate.tsx`, `Sidebar.tsx`, `TabBar.tsx`, `tabsStore.ts`, `saveTab.ts`, `ResultPane.tsx`, `runsStore.ts`, `workspace/commands.ts`, `Toolbar.tsx`, `Workspace.tsx`), `docs/architecture.md`

**Interfaces:**
- Produces:
  - `en`: `{ [key: string]: string }`를 만족하는 `as const` object. key는 `<영역>.<이름>`(예: `toolbar.runStatement`, `result.rows.one`, `result.rows.other`)
  - `type MessageKey = keyof typeof en`
  - `type PluralKey` = `.one`으로 끝나는 key에서 `.one`을 뗀 것(template literal type으로 계산)
  - `t(key: MessageKey, params?: Record<string, string | number>): string`. `{name}`을 바꾼다. number param은 `formatCount`로 쓴다. 없는 param은 `{name}` 그대로 둔다
  - `tc(key: PluralKey, count: number, params?: Record<string, string | number>): string`. `count === 1`이면 `.one`, 아니면 `.other`이고 `{count}`도 채운다
  - `formatCount(n: number): string` → `Intl.NumberFormat("en-US")`(`124500` → `"124,500"`)

- [ ] **Step 1: `t`, `tc`, `formatCount`의 test를 쓴다**

```ts
test("param을 채운다", () => {
  expect(t("tabs.close", { title: "first.sql" })).toBe("Close first.sql");
});
test("number param은 묶어 쓴다", () => {
  expect(t("result.dropped", { end: 24500 })).toBe(
    "Rows 1–24,500 were dropped · run again to see them",
  );
});
test("tc는 1이면 one을 고른다", () => {
  expect(tc("toast.copiedRows", 1)).toBe("Copied 1 row (tab-separated)");
  expect(tc("toast.copiedRows", 2)).toBe("Copied 2 rows (tab-separated)");
});
test("formatCount", () => {
  expect(formatCount(1000000)).toBe("1,000,000");
});
```

- [ ] **Step 2: 화면에 한글 문구가 없다는 규칙 test를 쓴다**

`src/test/sourceRules.test.ts`의 `화면 code에 한글 문구가 없다`: `src/**/*.{ts,tsx}` 중 `*.test.*`와 `src/test/**`를 뺀 파일을 `typescript`의 `createSourceFile`로 읽고, `StringLiteral`, `NoSubstitutionTemplateLiteral`, template의 text 조각, `JsxText`, JSX attribute의 string에 한글(`/[ㄱ-ㆎ가-힣]/`)이 있으면 `파일:줄`과 함께 실패한다. 주석은 보지 않는다.

- [ ] **Step 3: 두 test가 실패하는지 확인한다**

Run: `pnpm vitest run src/shared/i18n src/test/sourceRules.test.ts`
Expected: FAIL(`t`가 없음, 한글 문구가 있는 파일 목록)

- [ ] **Step 4: `en.ts`, `t.ts`를 쓰고 모든 문구를 옮긴다**

옮기는 규칙: 캔버스에 같은 상황의 영어 문구가 있으면 그것을 쓴다(예: 새 탭 제목 `Query {n}`, 탭 닫기 `Close {title}`, 접속 이름 중복 `This name is already taken. To edit that connection, open it from the sidebar.`, 접속 수정 제목 `Edit {name}`, 새 접속 `New Connection`, 비밀번호 설명 `Saved in Keychain, never in chilla.toml`). 없으면 뜻을 그대로 옮긴 sentence case 영어로 쓴다. 한 마디짜리 label에는 마침표를 붙이지 않는다. native `ask`의 문구도 옮긴다(`Discard unsaved changes to {title}?`, `{count} tabs have unsaved changes. Discard them and open another project?`). test는 화면에 보이는 영어를 literal로 단언한다(`t()`를 부르지 않는다). 새 탭 제목이 바뀌므로 `tabsStore` test도 고친다.

`docs/architecture.md` 3장 표에 `src/shared/i18n/`(화면 문구 dictionary와 `t`. 화면 문구는 여기서만 정한다)과 `src/shared/ui/`(공용 component, Task 4) 줄을 더한다.

- [ ] **Step 5: test가 통과하는지 확인한다**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 6: commit한다**

```bash
git add src docs/architecture.md
git commit -m "feat: 화면 문구를 영어 dictionary와 t(key)로 옮김"
```

---

### Task 3: Rust가 보내는 message를 영어로 바꾼다

**Files:**
- Modify: `crates/chilla-core/src/application/app.rs`, `application/ports.rs`, `domain/connection.rs`, `domain/sql_file.rs`, 사용자에게 가는 message를 만드는 `infrastructure/*.rs`, 그 message를 단언하는 test, `src-tauri/src/error.rs`

**Interfaces:**
- Consumes: 없음
- Produces: `CommandError.message`와 `QueryEvent`의 `message`(`connection_lost`, `client_error`)가 영어다. `kind`는 바뀌지 않는다.

- [ ] **Step 1: `command_error_kinds` test에 message 단언을 더한다**

`src-tauri/src/error.rs`의 test가 만드는 모든 `AppError`에 대해 `CommandError::from(error).message`에 한글이 없음을 단언하는 `command_error_messages_are_english`를 더한다(같은 error 목록을 쓰도록 목록을 helper로 뺀다). 안에 든 server message나 io message는 test 값(`"m"`)이다.

- [ ] **Step 2: test가 실패하는지 확인한다**

Run: `cargo test -p chillasql command_error_messages_are_english`
Expected: FAIL

- [ ] **Step 3: message를 영어로 바꾼다**

`#[error(...)]`와 사용자에게 가는 `format!`을 영어로 바꾼다. 자리 표시(`{path}`, `{message}` 등)는 그대로 둔다. sentence case이고 끝에 마침표를 붙이지 않는다(예: `{path} was changed on disk after it was opened`, `Only one statement can run at a time. This text has {count}`, `Connection lost: {message}`). 찾기: `rg -nP '"[^"]*[가-힣][^"]*"' crates/*/src src-tauri/src`에서 주석과 `expect`/`panic` 문구(사용자에게 가지 않음)를 뺀 것. 이 message를 단언하던 Rust test와 화면 test를 같이 고친다.

- [ ] **Step 4: test가 통과하는지 확인한다**

Run: `cargo test && pnpm test`
Expected: PASS

- [ ] **Step 5: commit한다**

```bash
git add crates src-tauri src
git commit -m "feat: Rust가 화면으로 보내는 오류 message를 영어로 바꿈"
```

---

### Task 4: token, 글꼴, 공용 UI, 에디터 theme

**Files:**
- Create: `public/fonts/D2Coding-Regular.ttf`, `public/fonts/D2Coding-Bold.ttf`, `public/fonts/OFL.txt`(모두 `docs/design/fonts/`에서 복사), `src/test/fonts.test.ts`, `src/shared/ui/Button.tsx`, `IconButton.tsx`, `Kbd.tsx`, `Menu.tsx`, `Toast.tsx`, `icons.tsx`, `src/shared/ui/Menu.test.tsx`, `src/shared/ui/Toast.test.tsx`, `src/features/editor/extensions.test.ts`의 theme test
- Modify: `src/index.css`, `src/features/editor/extensions.ts`, `package.json`(`@codemirror/theme-one-dark` 제거)

**Interfaces:**
- Produces:
  - Tailwind class: `bg-bg-0`~`bg-bg-3`, `border-line-1`, `border-line-2`, `text-fg`, `text-fg-2`, `text-fg-3`, `bg-accent`, `text-accent`, `text-conn-*`/`bg-conn-*`, `text-title`, `text-body`, `text-small`, `text-label`, `font-sans`(system), `font-mono`(D2Coding). CSS 변수 `--color-*`(CodeMirror theme과 inline style이 씀)
  - `Button({ variant?: "primary" | "secondary" | "ghost", ...button props })` 높이 28px. `IconButton({ label: string, size?: 22 | 28, ...button props })`(`aria-label`은 `label`). `Kbd({ children })`
  - `Menu({ open: boolean, onClose(): void, anchor: RefObject<HTMLElement>, label: string, children })`: `role="menu"`, 열리면 첫 항목에 focus, `Escape`와 바깥 누르기로 `onClose`, 위아래 화살표로 항목 이동. `MenuItem({ onSelect(): void, disabled?, checked?: boolean, children })`: `checked`가 있으면 `role="menuitemradio"`. 고르면 `onSelect` 뒤 `onClose`. `MenuSeparator()`
  - `Toast({ message: string | null })`: `role="status"`, message가 있으면 보임. `useToast(): { message: string | null; show(message: string): void }`는 2,000ms 뒤에 비운다(다시 `show`하면 시간을 새로 잰다)
  - `icons.tsx`: 캔버스의 SVG path를 그대로 옮긴 `PlayIcon`, `StopIcon`, `ChevronDownIcon`, `ChevronRightIcon`, `PlusIcon`, `CloseIcon`, `CopyIcon`, `RefreshIcon`, `FolderIcon`, `FileIcon`, `TunnelIcon`, `CheckIcon`, `ErrorIcon`, `WarningIcon`, `CancelledIcon`, `LinkBrokenIcon`, `TrashIcon`, `SwitchIcon`, `SpinnerIcon`. 모두 `aria-hidden`이고 `currentColor`를 쓴다

- [x] **Step 1: font file test를 쓴다**

`src/test/fonts.test.ts`: `public/fonts/D2Coding-Regular.ttf`와 `D2Coding-Bold.ttf`의 sha256이 `docs/design/README.md` 표의 값(`d5f2b6bf…682f`, `14a0cfa4…2752`, 전체 값은 README에서 복사)과 같고, `public/fonts/OFL.txt`가 있다.

- [x] **Step 2: `Menu`와 `Toast` test를 쓴다**

`Menu`: `열리면 첫 항목에 focus가 간다`, `Escape는 닫는다`, `바깥을 누르면 닫는다`, `ArrowDown은 다음 항목으로 간다`, `disabled 항목은 onSelect를 부르지 않는다`, `항목을 고르면 onSelect 뒤에 닫는다`. `Toast`: fake timer로 `show 뒤 2초가 지나면 사라진다`, `다시 show하면 2초를 새로 잰다`.

- [x] **Step 3: 에디터 theme test를 쓴다**

`extensions.test.ts`의 `문법 색은 token을 쓴다`: `editorExtensions()`로 만든 `EditorState`에서 `HighlightStyle`이 `tags.keyword`, `tags.string`, `tags.number`, `tags.comment`, `tags.operator`, `tags.typeName`에 `var(--color-syntax-keyword)` 등을 준다(`highlightingFor(state, [tags.keyword])`로 class를 얻어 그 rule을 확인하는 방식은 구현이 고른다). `oneDark`가 없다.

- [x] **Step 4: test가 실패하는지 확인한다**

Run: `pnpm vitest run src/test/fonts.test.ts src/shared/ui src/features/editor/extensions.test.ts`
Expected: FAIL

- [x] **Step 5: font를 복사하고 token, 공용 UI, theme을 쓴다**

`src/index.css`: `@theme`에 Global Constraints의 token(색은 `--color-<이름>`, 글자 크기는 `--text-title` 등과 각 `--line-height`, `--font-sans`, `--font-mono`)을 둔다. Tailwind 기본 palette는 `--color-*: initial`로 끈다. `@font-face`는 `D2Coding` Regular(400)와 Bold(600 700)를 `/fonts/…ttf`에서 읽는다. `body`는 `bg-bg-0 text-fg font-sans text-body`다.

`extensions.ts`: `oneDark`를 빼고 `EditorView.theme`(배경 bg-1, 글자 fg, `font-mono` 15px, 줄 24px, gutter 56px 폭에 fg-3, cursor fg, 선택 accent 16%, `font-variant-ligatures: none`)과 `syntaxHighlighting(HighlightStyle.define([...]))`(위 tag와 `tags.function(tags.variableName)`, `tags.standard(tags.name)` → function 색)을 넣는다. `highlightActiveLine()`을 뺀다(캔버스에 없음. 실행 범위 강조는 M8). `pnpm remove @codemirror/theme-one-dark`.

- [x] **Step 6: test가 통과하는지 확인한다**

Run: `pnpm test`
Expected: PASS

- [x] **Step 7: commit한다**

```bash
git add public src package.json pnpm-lock.yaml
git commit -m "feat: 디자인 token, D2Coding, 공용 UI component, 에디터 theme을 더함"
```

---

### Task 5: 이어서 가져오기와 다시 실행 (store)

**Files:**
- Modify: `src/shared/api/commands.ts`, `commands.test.ts`, `src/features/query/runReducer.ts`, `runReducer.test.ts`, `runsStore.ts`, `runsStore.test.ts`, `src/features/workspace/commands.ts`, `commands.test.ts`

**Interfaces:**
- Consumes: Rust command `fetch_more(sessionId, queryId)`(M2)
- Produces:
  - `fetchMore(sessionId: number, queryId: number): Promise<void>`(`shared/api/commands.ts`)
  - `runReducer.ts`: `type FetchState = "none" | "ready" | "fetching"`. `ResultData`에 `fetch: FetchState`와 `startedAt: number`(`Date.now()`)를 더한다. `emptyResult(sql, origin, startedAt)`는 `fetch: "none"`. `rows` event는 `fetch`를 `"ready"`로 둔다. `requestFetch(state: RunState): RunState`는 `running`이고 `fetch === "ready"`일 때만 `"fetching"`인 새 state, 아니면 같은 object
  - `interface Rejection { title: string; detail: string | null }`. `RunState`의 `rejected`는 `{ status: "rejected"; rejection: Rejection }`. `Prepare`는 `RunRequest | Rejection`(또는 그 Promise)을 돌려준다
  - `RunsState.fetchMore(tabId: string): Promise<void>`: `requestFetch`가 state를 바꿨을 때만 `fetchMore(sessionId, await queryId)`를 부른다. 실패는 무시한다(끝은 `finished`로 온다)
  - `workspace/commands.ts`: `runAgain(tabId: string): Promise<void>` — 그 탭의 결과(`running`/`finished`의 `result.sql`, `result.origin`)를 탭의 지금 접속으로 `run`한다. 결과가 없으면 아무것도 하지 않는다. `prepareRun`의 거절은 `Rejection`이다: 접속 없음 `{ title: "Choose a connection to run queries.", detail: null }`, 커서에 문장 없음 `No statement at the cursor`, 빈 선택 `Nothing to run`, `split_failed` → `{ title: "Couldn't find a statement", detail: "An unclosed quote keeps the text from being split into statements. Select what to run and it is sent as is." }`, 그 밖의 오류는 `{ title: messageOf(error), detail: null }`

- [ ] **Step 1: test를 쓴다**

`runReducer.test.ts`:
- `rows event는 fetch를 ready로 둔다`
- `requestFetch는 ready일 때만 fetching으로 바꾼다`: `fetch: "fetching"`, `"none"`, `finished` state에서는 같은 object를 돌려준다
- `rows가 오면 fetching에서 ready로 돌아간다`

`runsStore.test.ts`(M3의 mock과 `deferred`를 쓴다):
- `batch 하나에 fetchMore는 한 번만 보낸다`: `rows` 뒤 `fetchMore(tab)`을 세 번 부르면 `commands.fetchMore`가 1번, 다음 `rows` 뒤 한 번 더 부르면 2번
- `끝난 결과에는 fetchMore를 보내지 않는다`: `finished`(`completed`, `cancelled`) 뒤의 `fetchMore`는 command를 부르지 않는다
- `fetchMore는 execute가 query id를 돌려준 뒤 보낸다`: `executeQuery`의 promise가 끝나기 전에 온 `rows`에서 부른 `fetchMore`는 query id가 나온 뒤 `(sessionId, queryId)`로 간다
- `fetchMore가 실패해도 state를 바꾸지 않는다`
- `거절은 title과 detail을 갖는다`

`workspace/commands.test.ts`:
- `runAgain은 같은 SQL을 지금 접속으로 다시 실행한다`: 첫 실행의 `executeQuery` 인자와 같은 `sql`이 두 번째로 간다
- `split_failed는 Couldn't find a statement로 거절한다`
- `접속이 없으면 Choose a connection으로 거절한다`

- [ ] **Step 2: test가 실패하는지 확인한다**

Run: `pnpm vitest run src/features/query src/features/workspace src/shared/api`
Expected: FAIL

- [ ] **Step 3: 구현한다**

`runsStore.fetchMore`는 `set`으로 `requestFetch`를 적용하고 바뀌었을 때만 `executions.get(tabId)`로 command를 부른다. `runAgain`은 `execute("run")`과 같은 run token 경로(`useRuns.getState().run(tabId, prepare)`)를 쓴다. `ResultPane`의 `rejected` 처리를 새 shape에 맞춘다(모양은 Task 8에서 바꾼다).

- [ ] **Step 4: test가 통과하는지 확인한다**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: commit한다**

```bash
git add src
git commit -m "feat: 결과를 이어서 가져오는 fetchMore와 다시 실행을 store에 더함"
```

---

### Task 6: 결과 표의 순수 함수

**Files:**
- Create: `src/features/query/grid.ts`, `src/features/query/grid.test.ts`
- Modify: `src/features/query/format.ts`, `format.test.ts`

**Interfaces:**
- Produces(`grid.ts`):
  - 상수: `ROW_HEIGHT = 26`, `HEADER_HEIGHT = 32`, `GAP_HEIGHT = 40`, `FOOTER_HEIGHT = 30`, `FETCH_AHEAD = 100`, `HALF_WIDTH = 6.5`(D2Coding 13px 반각 advance), `CELL_PADDING = 20`, `MIN_FIT = 64`, `MAX_FIT = 480`, `MIN_DRAG = 48`, `FIT_SAMPLE = 2000`, `CELL_LIMIT = 300`
  - `displayColumns(text: string): number` — 전각은 2, 나머지는 1. 전각 범위: U+1100–115F, U+2E80–A4CF, U+AC00–D7A3, U+F900–FAFF, U+FE30–FE4F, U+FF00–FF60, U+FFE0–FFE6, U+1F300–1FAFF, U+20000–3FFFD. surrogate pair는 글자 하나로 센다. `CELL_LIMIT`자까지만 센다
  - `fitWidth(header: string, values: Iterable<Cell>): number` — `max(displayColumns) × HALF_WIDTH + CELL_PADDING`을 `MIN_FIT`~`MAX_FIT`로 자르고 올림. NULL은 `NULL`(4칸)로 센다. `values`는 앞 `FIT_SAMPLE`개만 본다
  - `cellDisplay(value: Cell): { text: string; muted: boolean; italic: boolean }` — NULL → `NULL`(muted, italic), `""` → `''`(muted), `CELL_LIMIT`를 넘으면 surrogate pair를 가르지 않고 자른 뒤 `…`
  - `copyCell(value: Cell): string` — NULL → `""`, 나머지는 그대로
  - `tsv(rows: readonly Cell[][]): string` — 칸은 `\t`, 행은 `\n`으로 잇고 끝에 줄바꿈이 없다. 규칙은 "이 계획에서 정한 것"의 TSV
  - `shouldFetch(lastVisible: number, retained: number, fetch: FetchState): boolean` — `fetch === "ready" && lastVisible >= retained - FETCH_AHEAD`. `lastVisible`과 `retained`는 보관된 행 안의 index와 개수다
  - `anchorShift(prevFirstRow: number, nextFirstRow: number): number` — `scrollTop`에 더할 값. `(prev === 0 && next > 0 ? GAP_HEIGHT : 0) - (next - prev) * ROW_HEIGHT`. `next < prev`(새 결과)면 0
  - `resultLabel(sql: string): string` — 앞의 공백과 `--`, `/* */` 주석을 건너뛴 첫 단어(대문자) + `FROM|INTO|UPDATE|TABLE|JOIN` 뒤의 첫 이름(따옴표 이름과 `schema.name` 포함). 없으면 첫 단어. 32자를 넘으면 31자와 `…`
  - `type Selection = { kind: "cell"; row: number; column: number } | { kind: "rows"; anchor: number; focus: number } | null` — `row`, `anchor`, `focus`는 절대 행 번호(0부터)
  - `selectedRows(selection: Selection, firstRow: number, rows: readonly Cell[][]): Cell[][]` — 범위 중 보관된 행만, 위에서 아래 순서
- Produces(`format.ts`):
  - `formatLive(millis: number): string` → 소수 한 자리 초(`4.2 s`)
  - `affectedText(sql: string, rows: number): string` — 첫 단어가 `INSERT`/`UPDATE`/`DELETE`/`MERGE`면 `tc("result.inserted" 등, rows)`, 아니면 `t("result.done")`

- [ ] **Step 1: test를 쓴다**

```ts
test("displayColumns는 한글과 emoji를 2칸으로 센다", () => {
  expect(displayColumns("abc")).toBe(3);
  expect(displayColumns("가나")).toBe(4);
  expect(displayColumns("a😀")).toBe(3);
});
test("fitWidth는 64~480px로 자른다", () => {
  expect(fitWidth("id", ["1"])).toBe(64);
  expect(fitWidth("email", ["haneul.kim@example.com"])).toBe(Math.ceil(22 * 6.5 + 20));
  expect(fitWidth("profile", ["x".repeat(100_000)])).toBe(480);
  expect(fitWidth("v", [null])).toBe(64);
});
test("fitWidth는 앞 2,000개만 본다", () => {
  const values = [...Array(2000).fill("a"), "b".repeat(50)];
  expect(fitWidth("c", values)).toBe(64);
});
test("tsv는 NULL을 빈 칸으로, 특수 문자가 든 값을 따옴표로 쓴다", () => {
  expect(
    tsv([
      ["1", null, "a\tb"],
      ["say \"hi\"", "줄\n바꿈", "😀"],
    ]),
  ).toBe('1\t\t"a\tb"\n"say ""hi"""\t"줄\n바꿈"\t😀');
});
test("copyCell은 NULL을 빈 문자열로", () => {
  expect(copyCell(null)).toBe("");
  expect(copyCell("NULL")).toBe("NULL");
});
test("shouldFetch", () => {
  expect(shouldFetch(400, 500, "ready")).toBe(true);
  expect(shouldFetch(399, 500, "ready")).toBe(false);
  expect(shouldFetch(499, 500, "fetching")).toBe(false);
  expect(shouldFetch(499, 500, "none")).toBe(false);
});
test("anchorShift는 버린 행만큼 당기고 처음 생긴 버린 구간 줄만큼 민다", () => {
  expect(anchorShift(0, 500)).toBe(40 - 500 * 26);
  expect(anchorShift(500, 1000)).toBe(-500 * 26);
  expect(anchorShift(500, 500)).toBe(0);
  expect(anchorShift(500, 0)).toBe(0);
});
test("resultLabel", () => {
  expect(resultLabel("-- 최근\nselect * from users u")).toBe("SELECT users");
  expect(resultLabel("UPDATE public.users SET a = 1")).toBe("UPDATE public.users");
  expect(resultLabel("insert into \"Order\" values (1)")).toBe('INSERT "Order"');
  expect(resultLabel("select pg_sleep(1)")).toBe("SELECT");
});
test("selectedRows는 보관된 행만 위에서 아래로", () => {
  const rows = [["a"], ["b"], ["c"]];
  expect(selectedRows({ kind: "rows", anchor: 12, focus: 9 }, 10, rows)).toEqual([["a"], ["b"], ["c"]]);
  expect(selectedRows({ kind: "rows", anchor: 11, focus: 11 }, 10, rows)).toEqual([["b"]]);
});
test("cellDisplay", () => {
  expect(cellDisplay(null)).toEqual({ text: "NULL", muted: true, italic: true });
  expect(cellDisplay("")).toEqual({ text: "''", muted: true, italic: false });
});
```

`format.test.ts`: `formatLive(4230)` → `"4.2 s"`, `affectedText("update users set a=1", 12)` → `"12 rows updated"`, `affectedText("delete from t", 1)` → `"1 row deleted"`, `affectedText("create table t()", 0)` → `"Done"`.

- [ ] **Step 2: test가 실패하는지 확인한다**

Run: `pnpm vitest run src/features/query/grid.test.ts src/features/query/format.test.ts`
Expected: FAIL

- [ ] **Step 3: `grid.ts`와 `format.ts`를 구현한다**

`ResultPane.tsx`의 `CELL_LIMIT`, `isHighSurrogate`, `CellText`의 자르기는 `cellDisplay`로 옮긴다.

- [ ] **Step 4: test가 통과하는지 확인한다**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: commit한다**

```bash
git add src/features/query
git commit -m "feat: 결과 표의 너비, 복사, 이어서 가져오기, 위치 보정 함수를 더함"
```

---

### Task 7: 가상 스크롤 결과 표 `ResultGrid`

**Files:**
- Create: `src/features/query/ResultGrid.tsx`, `src/features/query/ResultGrid.test.tsx`
- Modify: `src/test/setup.ts`(no-op `ResizeObserver`), `package.json`(`@tanstack/react-table@^9.3.1`, `@tanstack/react-virtual@^3.14.26`)

**Interfaces:**
- Consumes: Task 6의 `grid.ts` 전부, Task 1의 `Cmd+C` 경로 결정(`keydown` 경로면 `copyText`를 쓴다)
- Produces: `ResultGrid(props: ResultGridProps)`
  ```ts
  /** 지금 선택을 복사할 text와 알림 문구. 선택이 없으면 null */
  type CopyTarget = { text: string; message: string } | null;

  interface ResultGridProps {
    result: ResultData;          // columns가 null이 아니다
    /** 결과가 끝났으면 서버가 알려 준 전체 행 수 */
    endRows: number | null;
    onFetchMore(): void;
    onRunAgain(): void;
    onCopied(message: string): void;
    /** ResultPane header의 복사 버튼이 부른다 */
    copyTargetRef: RefObject<(() => CopyTarget) | null>;
    /** 선택이 생기거나 없어질 때. header 복사 버튼의 disabled에 쓴다 */
    onSelectionChange(hasSelection: boolean): void;
  }
  ```
  `CopyTarget`은 셀 하나면 `{ text: copyCell(value), message: "Copied cell" }`, 행이면 `{ text: tsv(rows), message: tc("toast.copiedRows", n) }`이다.

배치(`Main`, `States`, `TabsConn`): scroll container 하나가 가로와 세로를 함께 스크롤한다. 맨 위는 `position: sticky`인 header 줄(32px, bg-1, 아래 line-1)이고, 칸은 이름(system font 13 semibold)과 너비 handle(경계에 hover하면 accent 2px)이다. 맨 왼쪽은 행 번호 column(오른쪽 정렬, fg-3, 폭은 `max(52, 자릿수 × 6.5 + 20)`)이다. 몸통은 virtualizer의 `getTotalSize()` 높이이고 `paddingStart`는 버린 구간 줄(`firstRow > 0`이면 `GAP_HEIGHT`), `paddingEnd`는 끝 줄(`FOOTER_HEIGHT`), `scrollMargin`은 `HEADER_HEIGHT`다. 행은 26px, 아래 1px bg-2 선, 칸은 좌우 10px, `text-small font-mono`, 넘치면 `…`. 버린 구간 줄은 사선 무늬 배경(bg-1과 bg-0의 `repeating-linear-gradient(135deg, …)`)에 문구와 작은 "Run again" 버튼이다. 끝 줄은 `fetch === "fetching"`이면 spinner와 `Fetching next 500 rows`, `endRows`가 있으면 `End · {n} rows`, 그 밖은 비운다. 선택된 셀은 accent 1.5px inset 테두리와 accent 16% 배경, 선택된 행은 accent 14% 배경에 행 번호가 fg다. 표는 `role="grid"`, 행은 `role="row"`, 칸은 `role="gridcell"`, header 칸은 `role="columnheader"`이고 `aria-rowcount`는 `firstRow + rows.length + 1`이다.

- [ ] **Step 1: test를 쓴다**

test는 `useVirtualizer`에 `initialRect: { width: 800, height: 400 }`이 들어가 jsdom에서도 행이 그려지는 것에 기댄다(component가 이 값을 기본으로 준다). 결과는 `ResultData`를 직접 만들어 넘긴다.

- `보이는 행만 그린다`: 10,000행 결과에서 `role="row"`가 100개보다 적다
- `행 번호는 firstRow부터 센다`: `firstRow: 24500`이면 첫 행 번호가 `24,501`이고 `Rows 1–24,500 were dropped · run again to see them`과 `Run again` 버튼이 있다. 버튼은 `onRunAgain`을 부른다
- `NULL과 빈 문자열을 구분해 그린다`
- `끝 가까이 스크롤하면 onFetchMore를 부른다`: `fetch: "ready"`인 500행 결과에서 scroll container의 `scrollTop`을 끝으로 바꾸고 `scroll` event를 보내면 1번, `fetch: "fetching"`이면 0번
- `앞쪽 행이 버려져도 보던 행이 그 자리에 있다`: `firstRow: 0`, 1,000행에서 `scrollTop = 13000`으로 둔 뒤 `firstRow: 500`, 1,000행(앞 500행이 버려지고 뒤에 500행)으로 다시 그리면 `scrollTop`이 `13000 + 40 - 500 × 26`이다
- `셀을 누르고 복사하면 값이 가고 알림을 부른다`: 셀을 누른 뒤 grid에서 Task 1이 정한 경로(`copy` event면 `fireEvent.copy`에 `clipboardData` stub, `keydown`이면 `Cmd+C`)로 복사하면 그 값이 들어가고 `onCopied("Copied cell")`
- `행 번호를 Shift와 누르면 범위를 TSV로 복사한다`: 행 2를 누르고 Shift로 행 3을 누른 뒤 복사하면 두 행의 TSV와 `onCopied("Copied 2 rows (tab-separated)")`
- `focus가 결과 표 밖이면 copy를 건드리지 않는다`: 셀을 고른 뒤 바깥의 `textarea`에 focus를 두고 copy event를 보내면 `clipboardData.setData`가 불리지 않고 `preventDefault`되지 않는다
- `다시 실행하면 선택과 스크롤을 처음으로 돌린다`: `result` object의 `sql`이나 `startedAt`이 바뀐 새 결과를 넘기면 선택이 없고 `scrollTop`이 0이다
- `처음 너비는 header와 첫 batch에 맞춘다`: `email` column의 너비가 `fitWidth("email", 그 column의 값)`이다(header 칸의 style width로 확인)
- `handle을 두 번 누르면 내용에 맞춘다`: 너비를 끌어 줄인 상태에서 handle을 `dblClick`하면 `fitWidth` 값으로 돌아간다

- [ ] **Step 2: test가 실패하는지 확인한다**

Run: `pnpm vitest run src/features/query/ResultGrid.test.tsx`
Expected: FAIL

- [ ] **Step 3: package를 더하고 `ResultGrid`를 구현한다**

`pnpm add @tanstack/react-table@^9.3.1 @tanstack/react-virtual@^3.14.26`. API는 설치된 `node_modules/@tanstack/react-table/dist/index.d.ts`와 `node_modules/@tanstack/table-core/skills/table-features/references/column-sizing.md`, `column-resizing.md`에서 확인한다.

- table: module scope의 `features = tableFeatures({ columnSizingFeature, columnResizingFeature })`, `columnResizeMode: "onChange"`. column은 `result.columns`로 `useMemo`하고 id는 index 문자열이다. `columnSizing` state는 component가 갖고(`useState`) 결과가 바뀌면 header와 첫 batch로 다시 정한다. 결과의 정체는 `result.startedAt`으로 가린다(같은 실행 동안 `result` object는 batch마다 바뀐다). 너비는 header 줄에서 CSS 변수(`--col-<id>`)로 한 번 내리고 칸은 그 변수를 쓴다. `getRowModel()`은 부르지 않는다
- 이어서 가져오기: scroll event와 `rows.length`가 바뀐 뒤(`useEffect`)에 virtualizer의 마지막 보이는 index로 `shouldFetch`를 보고 `onFetchMore()`
- 위치 보정: `useLayoutEffect`에서 같은 결과의 `firstRow`가 바뀌면 `scrollTop += anchorShift(prev, next)`
- 선택: `useState<Selection>`. 결과가 바뀌면 `null`. 셀을 누르면 grid에 focus를 준다
- 복사: Task 1의 결정대로. 처리하는 조건은 `document.activeElement`가 grid 안이고 선택이 있을 때다

- [ ] **Step 4: test가 통과하는지 확인한다**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: commit한다**

```bash
git add src package.json pnpm-lock.yaml
git commit -m "feat: 가상 스크롤 결과 표와 이어서 가져오기, 컬럼 너비, 셀과 행 복사"
```

---

### Task 8: 결과 panel의 header와 상태 화면

**Files:**
- Modify: `src/features/query/ResultPane.tsx`, `src/features/query/ResultPane.test.tsx`

**Interfaces:**
- Consumes: `ResultGrid`(Task 7), `useRuns`의 `fetchMore`(Task 5), `runAgain`(Task 5, `workspace/commands.ts`), `resultLabel`, `formatElapsed`, `formatLive`, `affectedText`, `errorLocation`, `Toast`/`useToast`, `copyText`, `Kbd`, icon들
- Produces: `ResultPane({ tabId: string | null; hasConnection: boolean })`. 탭이 있고 접속이 없으면 빈 상태 대신 `Choose a connection to run queries.`를 보여 준다

header(36px, 아래 line-1): 왼쪽에 결과 탭 하나(24px, bg-3, `resultLabel(sql)`, 13 medium), 그 옆에 meta(13, fg-2, 숫자는 mono), 오른쪽 끝에 복사 IconButton(`Copy selected cells`, 선택이 없으면 disabled). meta와 body는 아래 표대로다. elapsed는 `formatElapsed`, 행 수는 `formatCount`다.

| 상태 | header meta | body |
| --- | --- | --- |
| 탭 없음, 또는 `idle` | header 없음 | 가운데 `⌘↵ Run statement at cursor`, `⇧⌘L New tab`(Kbd와 13 fg-2). 탭에 접속이 없으면 `Choose a connection to run queries.` |
| `connecting` | header 없음 | `Connecting…` |
| `running`, 행 없음 | `Running {formatLive}`(100ms마다 갱신) | `Waiting for the first row from the server` |
| `running`, 행 있음 | `{n}+ rows · {elapsed}` | `ResultGrid`(`endRows: null`) |
| `completed`, columns 있음 | `{n} rows · {elapsed}` | `ResultGrid`(`endRows: outcome.rows`) |
| `completed`, columns 없음 | `{elapsed}` | CheckIcon과 `affectedText`(17 semibold) |
| `failed` | header 이름만 | ErrorIcon, 서버 message(mono 15), detail, hint(fg-2), meta 줄 `SQLSTATE {code}`·`Ln {line}, Col {column}`·`{elapsed}`, `Copy message` 버튼(누르면 `copyText(message)`와 알림 `Copied message`) |
| `cancelled` | `{n} rows · {elapsed}` | 위에 CancelledIcon `Cancelled`와 `Stopped on the server. The {n} rows received stay visible.`(0행이면 `Stopped on the server.`), 행이 있으면 아래에 `ResultGrid` |
| `discarded` | header 이름만 | TrashIcon `Results discarded`, `Running the next query discarded the rows not yet fetched. Run again to see them.` |
| `connection_lost` | header 이름만 | LinkBrokenIcon `Connection lost`, message(mono 13), `The next run opens a new session. SET values and temp tables are gone.` |
| `client_error` | header 이름만 | ErrorIcon과 message |
| `rejected` | header 없음 | WarningIcon과 `rejection.title`, `detail`이 있으면 그 아래 fg-2 |

알림(`Toast`)은 결과 panel 아래 가운데에 뜬다(bg-3, line-2 테두리, 32px, CheckIcon). 문구는 `ResultGrid`의 `onCopied`와 `Copy message`가 정한다.

- [x] **Step 1: test를 쓴다**

M3의 `ResultPane.test.tsx`를 위 표에 맞춰 고친다. 더하는 test:
- `실행 중이고 행이 없으면 경과 시간을 보여 준다`: fake timer로 `startedAt`에서 4,230ms 뒤 `Running 4.2 s`
- `행이 오면 rows 뒤에 +를 붙인다`: `500+ rows · 38 ms`
- `끝나면 End 줄과 전체 행 수를 보여 준다`: `1,240 rows · 41 ms`와 `End · 1,240 rows`
- `행을 돌려주지 않는 문장은 영향받은 행 수를 문장으로`: `12 rows updated`
- `오류의 Copy message는 서버 message를 복사하고 알린다`: `copyText`가 message로 불리고 `Copied message`가 보인다
- `Run again은 runAgain을 부른다`(버린 구간이 있는 결과)
- `스크롤 끝에서 fetchMore를 부른다`: `ResultGrid`의 `onFetchMore`가 `useRuns.getState().fetchMore(tabId)`로 간다
- `split_failed 거절은 제목과 설명을 보여 준다`
- `접속이 없는 탭은 접속을 고르라고 한다`

- [x] **Step 2: test가 실패하는지 확인한다**

Run: `pnpm vitest run src/features/query/ResultPane.test.tsx`
Expected: FAIL

- [x] **Step 3: `ResultPane`을 구현한다**

M3의 `memo`와 "running과 finished가 같은 자리에 같은 component로 표를 그린다"는 그대로 둔다(끝나도 `ResultGrid`가 다시 mount되지 않아 스크롤 위치가 남는다).

- [x] **Step 4: test가 통과하는지 확인한다**

Run: `pnpm test`
Expected: PASS

- [x] **Step 5: commit한다**

```bash
git add src/features/query
git commit -m "feat: 결과 panel의 header와 상태 화면을 캔버스대로 바꿈"
```

---

### Task 9: 창 틀 — 창 상단 bar, 결과 panel 경계, status bar, 빈 에디터

**Files:**
- Create: `src/features/editor/editorStatus.ts`, `editorStatus.test.ts`, `src/features/workspace/StatusBar.tsx`, `src/features/connections/colors.ts`, `colors.test.ts`
- Modify: `src/features/editor/SqlEditor.tsx`, `SqlEditor.test.tsx`, `src/features/editor/documents.ts`, `documents.test.ts`, `src/features/workspace/Workspace.tsx`, `Workspace.test.tsx`

**Interfaces:**
- Produces:
  - `connectionColor(color: string | null): string | null` — `green`, `yellow`, `red`, `blue`, `purple`이면 `var(--color-conn-<이름>)`, 아니면 `null`. 화면은 `null`이면 `var(--color-line-2)`로 그린다
  - `useEditorStatus`(zustand): `{ tabId: string | null; hasSelection: boolean; line: number; column: number }`와 `update(tabId: string, state: EditorState): void`. line과 column은 1부터, column은 UTF-16 기준이다. `SqlEditor`가 view를 만들 때, 탭을 바꿀 때, selection이나 문서가 바뀐 transaction마다 부른다
  - `documentLineEnding(tabId: string): "LF" | "CRLF"`
  - `StatusBar({ tabId: string | null })`: 24px, bg-0, 위 line-1, 오른쪽 정렬 12 fg-2. 탭이 있으면 `Ln {line}, Col {column}`, `UTF-8`, `LF`/`CRLF`. 없으면 비운다

`Workspace` 배치(`Main`): 맨 위 3px bar(활성 탭 접속의 색, 없으면 line-2) → 그 아래 sidebar(248px)와 main column. main column은 탭 줄(Task 10), toolbar(Task 11), 에디터(bg-1, 남은 높이), 5px 경계(bg-0, 위 line-1, 가운데 36×3px line-2 막대, `cursor: row-resize`, `role="separator"`, `aria-orientation="horizontal"`, `aria-valuenow`=결과 panel 높이), 결과 panel(bg-0, 처음 396px), status bar다. 경계를 pointer로 끌면 결과 panel 높이가 바뀌고 에디터와 결과 panel은 각각 120px 밑으로 줄지 않는다. 탭이 없으면 에디터 자리에 결과 panel의 빈 상태와 같은 단축키 안내를 둔다. 오류 줄(project error)은 sidebar 아래에 token 색으로 둔다.

- [x] **Step 1: test를 쓴다**

- `colors.test.ts`: `connectionColor("green")` → `"var(--color-conn-green)"`, `connectionColor("orange")`과 `connectionColor(null)` → `null`
- `editorStatus.test.ts`: `update`가 두 번째 줄 세 번째 칸의 커서를 `line: 2, column: 3`으로, 선택이 있으면 `hasSelection: true`
- `documents.test.ts`: CRLF로 연 문서는 `documentLineEnding`이 `"CRLF"`
- `SqlEditor.test.tsx`: `커서를 옮기면 editorStatus가 바뀐다`, `탭을 바꾸면 그 탭의 위치를 보여 준다`
- `Workspace.test.tsx`: `창 상단 bar는 활성 탭 접속의 색이다`(`color = "red"`인 접속의 탭이면 style이 `var(--color-conn-red)`, 접속 없는 탭이면 `var(--color-line-2)`), `경계를 끌면 결과 panel 높이가 바뀐다`(pointerdown/move/up으로 100px 위로 끌면 `aria-valuenow`가 496), `결과 panel은 120px보다 작아지지 않는다`, `status bar는 줄과 칸, 줄 끝을 보여 준다`, `탭이 없으면 단축키 안내를 보여 준다`

- [x] **Step 2: test가 실패하는지 확인한다**

Run: `pnpm vitest run src/features/connections/colors.test.ts src/features/editor src/features/workspace/Workspace.test.tsx`
Expected: FAIL

- [x] **Step 3: 구현한다**

경계 끌기는 `pointerdown`에서 `setPointerCapture`를 하고 `pointermove`의 `clientY` 차이로 높이를 바꾼다. 최대값은 main column 높이에서 탭 줄, toolbar, status bar, 에디터 최소 120px을 뺀 값이다.

- [x] **Step 4: test가 통과하는지 확인한다**

Run: `pnpm test`
Expected: PASS

- [x] **Step 5: commit한다**

```bash
git add src
git commit -m "feat: 창 상단 접속 bar, 결과 panel 경계, status bar를 더함"
```

---

### Task 10: 탭 줄과 sidebar

**Files:**
- Create: `src/features/editor/SaveNameDialog.tsx`, `src/features/project/fileTree.ts`, `fileTree.test.ts`, `src/features/project/Sidebar.test.tsx`, `src/shared/api/path.ts`
- Modify: `src/features/editor/TabBar.tsx`, `TabBar.test.tsx`, `src/features/project/Sidebar.tsx`, `src/features/workspace/Workspace.tsx`

**Interfaces:**
- Consumes: `connectionColor`(Task 9), `IconButton`, `Button`, icon들(Task 4), `useTabs`의 `naming`, `requestName`, `activeId`, `tabs`
- Produces:
  - `homeDir(): Promise<string>`(`shared/api/path.ts`, `@tauri-apps/api/path`의 `homeDir`). capability가 더 필요하면 더한다
  - `type TreeNode = { kind: "folder"; name: string; path: string; children: TreeNode[] } | { kind: "file"; name: string; path: string }`
  - `buildTree(paths: readonly string[]): TreeNode[]` — 각 단계에서 folder가 먼저, 그 안은 이름의 `localeCompare` 순서
  - `shortenHome(dir: string, home: string | null): string` — `home`으로 시작하면 `~`로 바꾼다(`fileTree.ts`에 둔다)
  - `projectInitials(name: string): string` — `-`, `_`, `.`, 공백으로 나눈 앞 두 낱말의 첫 글자(대문자). 낱말이 하나면 앞 두 글자(대문자)
  - `SaveNameDialog({ title: string; onSubmit(path: string): void; onCancel(): void })`: modal(`role="dialog"`, 제목 `Save {title}`, 입력 label `Path inside the project`, placeholder `queries/name.sql`, `Cancel`과 primary `Save`, `Escape`는 취소)

탭 줄(`Main`): 38px, bg-0, 아래 line-1, 빈 자리와 줄 자체에 `data-tauri-drag-region`. 탭은 31px, 위 둥근 8px, 13px. 활성 탭은 bg-1에 line-1 테두리(아래는 bg-1), 아닌 탭은 fg-2. 탭 안은 8px dot(접속 색, 접속이 없으면 1.5px fg-3 테두리의 빈 원), 제목, 닫기다. dirty면 닫기 자리에 7px fg 원(`aria-label="Unsaved"`)을 두고 hover나 focus에서 닫기 버튼(`Close {title}`)으로 바꾼다. 끝에 `New tab (Shift+Cmd+L)` IconButton이다. `role="tablist"`(`Open files`), 탭은 `role="tab"`과 `aria-selected`다. 이름을 묻는 중이면 `SaveNameDialog`를 띄운다.

sidebar(`Main`): 248px, bg-0, 오른쪽 line-1. 위 38px은 신호등 자리(비워 두고 `data-tauri-drag-region`). 그 아래 프로젝트 버튼(`Switch project`, bg-1, line-1 테두리, 26px 이니셜 칸, 이름 semibold, `shortenHome(dir)` 12 fg-2, SwitchIcon) → `onSwitchProject`. 접속 section(`Connections` label, `Add connection` IconButton 22px, 접속마다 `Edit connection {name}` 버튼: dot, 이름 medium, `tunnel`이 있으면 TunnelIcon(`aria-label="Tunnel"`), 아래 mono 12 fg-3의 `host:port/database`). 그 아래 line-1. Files/Schema/History segmented tab(`role="tablist"`, Schema와 History는 `aria-disabled`). Files 아래 `SQL Files` label과 `Refresh file list` IconButton, tree(26px 줄, 깊이마다 16px 들여쓰기, folder는 chevron과 FolderIcon이고 누르면 접고 편다, file은 FileIcon, 활성 탭의 파일은 accent 14% 배경, 열린 탭 중 dirty인 파일은 6px fg 원 `Unsaved`).

- [x] **Step 1: test를 쓴다**

- `fileTree.test.ts`: `buildTree(["scratch.sql", "queries/b.sql", "queries/a.sql", "reports/x/y.sql"])`이 `[queries[a.sql, b.sql], reports[x[y.sql]], scratch.sql]`, `shortenHome("/Users/jo/work/a", "/Users/jo")` → `"~/work/a"`, `shortenHome("/opt/a", "/Users/jo")` → `"/opt/a"`, `projectInitials("chilla-demo")` → `"CD"`, `projectInitials("app")` → `"AP"`
- `TabBar.test.tsx`(M3 test를 고침): `탭의 dot은 접속 색이다`, `dirty 탭은 Unsaved 표시를 갖고 닫기도 할 수 있다`(Unsaved가 보이고 `Close first.sql` 버튼을 눌러 `onClose`), `이름을 묻는 중이면 Save dialog를 띄운다`(제목 `Save Query 1`, 입력 후 `Save`가 `onName`), `Escape는 이름 묻기를 그만둔다`
- `Sidebar.test.tsx`: `프로젝트 버튼은 이니셜, 이름, 줄인 경로를 보여 주고 onSwitchProject를 부른다`(`homeDir` mock), `접속을 누르면 수정한다`, `터널이 있는 접속은 Tunnel icon을 갖는다`, `파일 tree의 folder를 누르면 접는다`, `활성 탭의 파일을 강조하고 dirty 파일에 Unsaved를 붙인다`, `Schema와 History는 disabled다`

- [x] **Step 2: test가 실패하는지 확인한다**

Run: `pnpm vitest run src/features/project src/features/editor/TabBar.test.tsx`
Expected: FAIL

- [x] **Step 3: 구현한다**

- [x] **Step 4: test가 통과하는지 확인한다**

Run: `pnpm test`
Expected: PASS

- [x] **Step 5: commit한다**

```bash
git add src src-tauri/capabilities
git commit -m "feat: title bar를 겸하는 탭 줄과 sidebar를 캔버스대로 바꿈"
```

---

### Task 11: toolbar — 접속 chip과 menu, split 실행 버튼

**Files:**
- Create: `src/features/workspace/Toolbar.test.tsx`
- Modify: `src/features/workspace/Toolbar.tsx`, `src/features/workspace/Workspace.tsx`

**Interfaces:**
- Consumes: `Menu`, `MenuItem`, `MenuSeparator`, `Button`, `Kbd`, icon들(Task 4), `connectionColor`(Task 9), `useEditorStatus`(Task 9), `changeConnection`, `execute`(M3)
- Produces: `Toolbar({ onAddConnection(): void })`

배치(`Main`, `States`, `TabsConn`): 44px, bg-1, 아래 line-1, 좌우 12px, 간격 10px.
- 접속 chip(28px, bg-2, line-2 테두리, `aria-label="Change this tab's connection"`, `aria-haspopup="menu"`, `aria-expanded`): dot, 이름(medium), database(mono 13 fg-2), ChevronDown. 접속이 없으면 점선 테두리, 투명 배경, 빈 원 dot, `Choose connection`(fg-2). 탭이 없으면 disabled.
- 접속 menu(`Connections`, 300px): 접속마다 `menuitemradio`(dot, 이름, TunnelIcon, 오른쪽 mono 12 fg-3 `host:port/database`, 지금 접속이 `aria-checked="true"`와 accent 16% 배경), 구분선, `Add connection…`(fg-2) → `onAddConnection`. 고르면 `changeConnection(tabId, name)`.
- 오른쪽 끝 실행: 실행 중(`connecting`이거나 `running`)이 아니면 split 버튼이다. 왼쪽(200px, primary, 왼쪽만 둥긂): PlayIcon, `Run statement` 또는 선택이 있으면 `Run selection`(`useEditorStatus`의 `hasSelection`이고 그 탭이 활성 탭일 때), `⌘↵` Kbd → `execute("run")`. 오른쪽(26px, primary, `aria-label="Choose what to run"`): ChevronDown → menu(`What to run`, 240px): 왼쪽 버튼과 같은 label의 항목(`⌘↵`) → `execute("run")`, `Run file`(disabled). 실행 중이면 같은 자리에 227px secondary `Cancel` 버튼(StopIcon, `⌘F2`) → `execute("cancel")`. 탭이 없거나 접속이 없으면 split 버튼이 disabled다.
- toolbar 바로 아래 2px 진행 막대(bg-2 바탕에 accent 28% 폭이 좌우로 움직임, `aria-hidden`): 상태가 `connecting`이거나, `running`이고 행이 아직 없을 때만.
- Save 버튼은 없다.

- [x] **Step 1: test를 쓴다**

- `접속 chip은 탭의 접속 이름과 database를 보여 준다`
- `접속이 없는 탭은 Choose connection이고 실행 버튼이 disabled다`
- `chip을 누르면 접속 menu가 열리고 고르면 접속을 바꾼다`(`changeConnection`이 `(tabId, "staging")`)
- `Add connection은 onAddConnection을 부른다`
- `선택이 있으면 Run selection이다`(`useEditorStatus.setState`로 `hasSelection: true`)
- `실행 중에는 Cancel이고 누르면 취소한다`(`execute("cancel")`)
- `실행 menu의 Run file은 disabled다`
- `연결 중과 첫 행을 기다리는 동안 진행 막대가 있다`
- `실행 버튼 너비는 label이 바뀌어도 같다`(왼쪽 버튼의 style width가 `200px`, Cancel은 `227px`)

- [x] **Step 2: test가 실패하는지 확인한다**

Run: `pnpm vitest run src/features/workspace/Toolbar.test.tsx`
Expected: FAIL

- [x] **Step 3: 구현한다**

`Workspace`는 `Toolbar`에 `onAddConnection={() => setForm({ original: null })}`을 넘긴다. M3의 `<select>`와 Save 버튼에 기대던 `Workspace.test.tsx`의 test를 chip과 menu로 고친다.

- [x] **Step 4: test가 통과하는지 확인한다**

Run: `pnpm test`
Expected: PASS

- [x] **Step 5: commit한다**

```bash
git add src
git commit -m "feat: toolbar의 접속 chip과 menu, 너비를 고정한 split 실행 버튼"
```

---

### Task 12: 남은 화면의 token과 source 규칙

**Files:**
- Modify: `src/features/connections/ConnectionForm.tsx`, `src/features/project/ProjectGate.tsx`, `src/features/workspace/Workspace.tsx`(접속 form overlay), `src/test/sourceRules.test.ts`, 그 밖에 `zinc`나 hex가 남은 파일

**Interfaces:**
- Consumes: Task 4의 token과 `Button`, `IconButton`
- Produces: `src/**/*.{ts,tsx}`에 기본 palette class와 hex literal이 없다

접속 form은 sheet 모양(bg-2, line-2 테두리, radius 10px, 제목 17 semibold, 입력 28px bg-1 line-2, label은 key 이름이면 mono, 결과 줄은 icon과 문장, 아래에 `Test`, `Cancel`(ghost), `Save`(primary))으로 token만 바꾸고 칸의 배치는 그대로 둔다. 프로젝트 열기 화면은 `ChillaSQL` 제목과 primary `Open Project…` 버튼, 상태 문구를 token으로 바꾼다. overlay 배경은 `rgba(0,0,0,0.5)`를 token(`--color-scrim`)으로 둔다.

- [ ] **Step 1: source 규칙 test를 더한다**

`sourceRules.test.ts`에 둘을 더한다.
- `기본 palette class를 쓰지 않는다`: string literal과 template 조각에 `/\b(?:bg|text|border|outline|ring|divide|fill|stroke)-(?:zinc|gray|slate|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/`가 없다
- `색 literal을 쓰지 않는다`: string literal에 `/#[0-9a-fA-F]{3,8}\b/`과 `rgb(`가 없다

- [ ] **Step 2: test가 실패하는지 확인한다**

Run: `pnpm vitest run src/test/sourceRules.test.ts`
Expected: FAIL(남은 파일 목록)

- [ ] **Step 3: 남은 화면을 token으로 바꾼다**

- [ ] **Step 4: 전체 검사를 통과하는지 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit한다**

```bash
git add src
git commit -m "feat: 접속 form과 프로젝트 열기 화면에 token을 적용하고 source 규칙 test를 더함"
```

---

### Task 13: 완료 확인 — 100만 행 스크롤과 화면

**Files:**
- Modify: `docs/plans/M4-result-table.md`(체크박스와 "실행에서 달라진 것"), `docs/progress.md`, `docs/milestones.md`, `docs/spec.md`(달라진 것이 있으면)

앱 동작은 `scripts/build-app.sh --debug`로 만든 `.app`에서 Claude가 확인한다(진행상황의 "앱 동작 확인 방법").

- [ ] **Step 1: 100만 행 스크롤을 잰다**

임시 probe(확인 뒤 지움): `ResultGrid`에 `import.meta.env.VITE_CHILLA_SCROLL_PROBE`가 있을 때만 켜지는 code를 둔다. 켜지면 결과가 오는 동안 매 frame `scrollTop`을 끝으로 옮기고(맨 아래에 있는 사용자처럼 계속 이어서 가져온다), `requestAnimationFrame` 간격을 모아 결과가 끝나면 표 위에 `SCROLL_PROBE {"frames":…,"p95":…,"max":…,"rows":…,"firstRow":…,"seconds":…}`를 글자로 그린다. 로컬 test DB에서 `SELECT * FROM big_table`을 실행하고 screenshot으로 읽는다.

기준: `rows`가 1,000,000이고 `firstRow`가 900,000(맨 위 줄이 `Rows 1–900,000 were dropped · run again to see them`), frame 간격 p95 ≤ 20ms, max ≤ 100ms. 못 맞추면 원인(batch마다 행 배열 복사, React render, virtualizer)을 재고, 고쳐도 안 되면 기획서 2장대로 canvas 기반 grid로 바꿀지 사용자에게 묻는다. 결과(수치와 걸린 시간)를 작업 로그에 남기고 probe를 지운다.

- [ ] **Step 2: 화면을 손으로 확인한다**

| # | 확인 | 기대 |
| --- | --- | --- |
| 1 | 앱을 띄운다 | 신호등이 sidebar 위 38px 줄 가운데, 창 위 3px bar, 탭 줄을 끌면 창이 움직임. 시작부터 프로젝트 화면까지 1초 이내(M3 기준) |
| 2 | 접속 없는 새 탭(`Shift+Cmd+L`) | 회색 bar, 빈 원 dot, 점선 `Choose connection` chip, 실행 disabled, `Choose a connection to run queries.` |
| 3 | chip menu에서 `local`을 고르고 `SELECT * FROM big_table` 실행 | `Running …` 뒤 `500+ rows · … ms`, 표의 글자가 D2Coding, 에디터도 D2Coding 15px |
| 4 | 표를 끝까지 스크롤 | `Fetching next 500 rows`가 잠깐 보이고 행이 이어짐. 마우스 wheel로 내리는 동안 멈춤이 보이지 않음 |
| 5 | 10만 행을 넘긴 뒤 중간쯤 보면서 batch가 오게 둔다 | 보던 행이 그 자리에 있음. 맨 위에 버린 구간 줄, `Run again`이 다시 실행함 |
| 6 | 컬럼 경계를 끌고 두 번 누른다 | 끄는 동안 너비가 바뀌고 두 번 누르면 내용에 맞춤 |
| 7 | 셀을 누르고 `Cmd+C`, 행 두 개를 고르고 `Cmd+C`, 각각 TextEdit에 붙여 넣기 | 값 그대로 / TSV 두 줄. `Copied cell`, `Copied 2 rows (tab-separated)` 알림 |
| 8 | 에디터에서 text를 고르고 `Cmd+C` | 결과 표가 아니라 고른 text가 복사됨. 실행 버튼이 `Run selection` |
| 9 | `SELECT pg_sleep(10);` 실행 후 Cancel 버튼 | 버튼 너비가 그대로이고 `Cancelled` 화면, toolbar가 흔들리지 않음 |
| 10 | `SELEC 1` 실행, `Copy message` | `syntax error at or near "SELEC"`, `SQLSTATE 42601`, `Ln 1, Col 1`. 붙여 넣으면 message |
| 11 | `UPDATE big_table SET … WHERE id = 1` 같은 문장(test DB에 있는 column으로) | `1 row updated` |
| 12 | 결과 panel 경계를 끈다 | 높이가 바뀌고 120px 밑으로 줄지 않음 |
| 13 | sidebar의 tree에서 folder를 접고 파일을 연다 | 접힘, 활성 파일 강조, 고치면 `Unsaved` 점 |
| 14 | `chilla.toml`의 `local`에 `color = "red"`를 넣고 다시 연다 | bar, 탭 dot, chip, sidebar dot이 빨강. 오류 화면에는 빨강이 없음 |
| 15 | 화면 전체 | 한국어 문구가 없음(PostgreSQL message와 data 제외). 빌드된 앱에서 CSP 때문에 막힌 것 없음(글꼴, clipboard) |

다 되면 `pnpm check`를 다시 통과시킨다.

- [ ] **Step 3: release 빌드를 확인한다**

`scripts/build-app.sh`로 release `.app`을 만들어 띄우고 키체인 확인 창 없이 저장된 접속으로 실행되는지 본다(Task 1의 결정).

- [ ] **Step 4: 완료를 기록하고 commit한다**

계획의 체크박스를 체크하고, 실행에서 달라진 것을 "구현 뒤 정리에서 바뀐 것"/"Task 13 실행에서 달라진 것"으로 계획에 남긴다. 진행상황의 "지금", 마일스톤 현황(M4 `완료`, 완료 날짜), 작업 로그(Step 1의 수치, Step 2의 결과)를 갱신한다. M4가 1단계의 마지막 마일스톤이므로 "지금"에 기획서 8장대로 며칠 실제로 써 본 뒤 M5로 넘어간다고 적는다.

```bash
git add docs
git commit -m "docs: M4 완료 기록"
```
