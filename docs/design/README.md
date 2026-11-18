# ChillaSQL 디자인

화면 모양의 기준이다. M4부터 화면은 여기 있는 캔버스 사본을 따른다. 다르게 만들어야 하면 [진행상황](../progress.md)의 결정 기록에 남긴다.

## 캔버스

`canvas/`는 claude.ai의 Design artifact "ChillaSQL UI 리디자인"(비공개)을 2026-11-18에 받아 둔 사본이다(artifact version `1794979968-b701`).

- 구현할 때는 이 사본을 읽는다. `.dc.html`은 캔버스의 runtime(`support.js`) 위에서만 그려지므로 browser로 열면 모양이 나오지 않는다. 화면을 눈으로 볼 때나 고칠 때만 artifact를 연다.
- artifact를 고치면 이 사본도 다시 받아 덮어쓴다. 사본과 artifact가 다르면 사본이 낡은 것이다.
- artboard마다 `<h3 class="label">`의 한국어 heading은 상태를 설명하는 디자인 메모다. 화면 문구가 아니다.
- 색, 글자 크기, 규칙은 `Tokens.dc.html`에 모여 있다.

| 파일 | artboard | 관련 마일스톤 |
| --- | --- | --- |
| `Main.dc.html` | 작업 화면: sidebar, 탭 줄, toolbar, 에디터, 결과 표, status bar | M3, M4 |
| `Welcome.dc.html` | 프로젝트 열기, `chilla.toml`이 없을 때의 sheet | M3, M8 |
| `Tokens.dc.html` | 색, 글꼴, 글자 크기, 버튼, 규칙 | M4 |
| `ConnectionForm.dc.html` | 접속 추가·수정 sheet | M3, M5, M6, M8 |
| `States.dc.html` | 결과 panel 상태 | M3, M4, M6, M8 |
| `Safety.dc.html` | 위험 쿼리와 트랜잭션 확인 | M6, M8 |
| `Tunnel.dc.html` | 터널 상태 | M5, M6 |
| `TabsConn.dc.html` | 탭과 접속, 결과 표 조작 | M3, M4, M6 |
| `Sidebar.dc.html` | sidebar 스키마와 기록, 프로젝트 바꾸기 | M7, M8, M9 |
| `Dialogs.dc.html` | 확인 dialog 모음 | M3, M6 |
| `Tools.dc.html` | 자동완성, 파라미터, 값 보기, EXPLAIN, DDL, 셀 편집, 내보내기 | M7~M10 |

`canvas.json`은 artboard의 크기와 캔버스 위 배치다.

## 글꼴

`fonts/`는 SQL 에디터와 결과 data에 쓰는 D2Coding이다.

| 파일 | 내용 | sha256 |
| --- | --- | --- |
| `D2Coding-Regular.ttf` | 1.4.0 표준 build Regular | `d5f2b6bf5b1826cfbf3734c70582f0cd42ea2e1d6c2636ae681b612bc9c5682f` |
| `D2Coding-Bold.ttf` | 1.4.0 표준 build Bold | `14a0cfa4d96fbd976bc4b1a6ef81e51df353a1689d5273ebcd908c857a4f2752` |
| `OFL.txt` | SIL Open Font License 1.1 | |

- 출처: [naver/d2-coding-font VER1.4.0](https://github.com/naver/d2-coding-font/releases/tag/VER1.4.0)(2026-10-03 release)의 `D2Coding-Ver1.4.0-20261003.zip`에서 `D2Coding/` 폴더의 두 파일. 이름만 바꿨다.
- ligature build(`D2CodingLigature/`)는 쓰지 않는다. `<>`, `->>`를 한 글자처럼 합쳐 SQL 연산자를 잘못 읽게 할 수 있다.
- subset하거나 고치지 않는다. OFL의 Reserved Font Name 때문에 고친 font는 D2Coding이라는 이름을 쓸 수 없다. 앱에 넣을 때 `OFL.txt`를 함께 넣는다.
- 캔버스 사본의 `@font-face`는 artifact asset 주소를 가리킨다. `/_blob/9dcd768ab87d0e66ac1867bef2148601`이 Regular, `/_blob/7f3d51479cd4b88575a6bc2c42556a16`이 Bold다.
- 화면(UI) 글꼴은 macOS system font라 여기 두지 않는다.
