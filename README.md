# ChillaSQL

DataGrip을 대신해 혼자 쓰는 PostgreSQL 전용 Mac 데스크톱 클라이언트다. 터널이 필요한 DB는 접속 정보에 터널 명령을 붙여 두면 앱이 연결부터 종료까지 처리한다.

Tauri 2 + React/TypeScript로 만들었다. 화면은 React, DB 연결과 터널은 Rust가 맡는다.

| 항목 | 내용 |
| --- | --- |
| 실행 환경 | macOS (Windows, Linux는 지원하지 않는다) |
| 지원 DB | PostgreSQL |
| 배포 | 스토어 배포 없이 로컬에서 빌드해 직접 설치한다 |
| 화면 | dark 테마 고정. 기본 영어, 전역 설정 파일에서 한국어로 바꾼다 |

## Tauri

[Tauri](https://tauri.app)는 웹 기술(HTML, CSS, JavaScript)로 화면을 만들고 Rust로 앱의 나머지를 만드는 데스크톱 앱 framework다. Electron과 달리 Chromium과 Node.js를 앱에 넣지 않고 OS가 가진 WebView(macOS에서는 WKWebView)로 화면을 그린다. 그래서 앱이 작고 가볍다. 이 저장소는 Tauri 2를 쓴다.

| 구성 | 역할 | 이 저장소에서 |
| --- | --- | --- |
| 화면 (WebView) | HTML, CSS, JavaScript로 그린다 | `src/` (React + TypeScript, Vite로 번들) |
| Rust 코어 | 파일, 네트워크, 프로세스 같은 OS 기능을 다룬다 | `src-tauri/`가 앱 껍데기를, `crates/chilla-core/`가 DB 연결과 터널을 맡는다 |
| command | 화면이 Rust 함수를 부르는 통로(IPC). Rust에서 `#[tauri::command]`로 만들고 화면에서 `invoke`로 부른다 | `src-tauri/src/commands.rs`. 화면 쪽 호출은 `src/shared/api/`에서만 한다 |
| capability | 화면이 쓸 수 있는 plugin 권한 목록. 적지 않은 권한은 막힌다 | `src-tauri/capabilities/default.json` (저장 dialog, clipboard 등) |
| plugin | dialog, clipboard 같은 기능을 더하는 공식 확장 | `tauri-plugin-dialog`, `tauri-plugin-clipboard-manager` |
| 설정 | 창 크기, 보안 정책(CSP), bundle 옵션 | `src-tauri/tauri.conf.json` |

저장한 DB 비밀번호는 화면으로 돌려보내지 않고 Rust 쪽(키체인)에만 둔다. CSP는 앱 자신의 script만 실행하게 막는다.

Tauri CLI(`@tauri-apps/cli`)는 `pnpm install`로 같이 설치되고 `pnpm tauri`로 실행한다.

| 명령 | 하는 일 |
| --- | --- |
| `pnpm tauri dev` | Vite dev server(1420 포트)와 Rust 앱을 함께 띄운다. 화면 코드는 저장하면 바로 반영되고 Rust 코드는 다시 빌드한다 |
| `pnpm tauri build` | frontend를 빌드하고 Rust를 release로 빌드해 `.app`을 만든다. 서명까지 맞춘 빌드는 `scripts/build-app.sh`를 쓴다 |

## 기능

- **접속 관리**: 프로젝트 디렉토리의 `chilla.toml`에 접속 목록을 둔다. 비밀번호는 macOS 키체인에만 저장한다. SSL(`require`, `verify-full`), 읽기 전용 접속, `statement_timeout`을 접속마다 정한다.
- **터널**: 접속 정보에 터널 명령(예: `ssh -N -L 25432:db.internal:5432 bastion`)을 붙이면 앱이 실행하고 감시하고 정리한다.
- **SQL 에디터**: CodeMirror 6. PostgreSQL 문법 강조, 스키마 기반 자동완성, Formatting, 파라미터(`:name`) 입력.
- **쿼리 실행**: 여러 문장 실행, 취소, 행 단위 스트리밍, `EXPLAIN`, 위험 쿼리 확인.
- **트랜잭션**: Auto와 Manual 모드, Commit과 Rollback, 열린 트랜잭션 표시.
- **결과 표**: 가상 스크롤로 100만 행도 다룬다. 복사, 값 보기, 화면 내 정렬, CSV와 JSON 내보내기.
- **셀 편집**: 기본 키가 있는 단일 테이블 결과의 셀을 고치고, 보낼 `UPDATE`를 미리 본 뒤 Apply로 반영한다.
- **스키마 트리**: 스키마, 테이블, 뷰, 컬럼, 인덱스, 제약조건을 보고 DDL을 확인한다.
- **쿼리 기록, 탭 복원**: 프로젝트마다 쿼리 기록을 보관하고, 열려 있던 탭을 다시 열 때 복원한다.
- **단축키**: DataGrip의 macOS 기본 키맵을 따르고, 전역 설정 파일에서 바꿀 수 있다.

기능의 정확한 동작은 [기획서](docs/spec.md)에 있다.

## 개발 환경 준비

macOS에서 아래 순서로 설치한다.

### 1. Xcode Command Line Tools

Rust가 링크하고 C 코드(`pg_query`)를 빌드하는 데 필요하다.

```sh
xcode-select --install
```

### 2. Rust (rustup)

[rustup](https://rustup.rs)은 Rust toolchain 관리자다. `rustc`(compiler), `cargo`(빌드 도구와 package 관리자), `clippy`, `rustfmt`를 한 번에 설치하고, stable, beta, nightly 같은 toolchain과 target을 바꿔 가며 관리한다. 이 저장소는 별도의 toolchain 고정 파일이 없으므로 stable을 쓴다. edition 2024를 쓰므로 Rust 1.85 이상이 필요하다. 개발은 1.99로 했다.

```sh
# rustup 설치. 안내에 따라 기본 설정(stable)을 고른다
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 새 터미널을 열거나 아래로 PATH를 반영한다
source "$HOME/.cargo/env"

# lint와 formatter. 기본 설치에 들어 있지 않으면 추가한다
rustup component add clippy rustfmt

# 확인
rustc --version
cargo --version
```

Rust를 최신으로 올릴 때는 `rustup update`를 쓴다.

### 3. Node.js와 pnpm (Volta)

[Volta](https://volta.sh)는 JavaScript 도구 관리자다. Node, npm, pnpm 같은 도구의 버전을 설치하고, 프로젝트마다 `package.json`의 `volta` 항목으로 버전을 고정해 어느 디렉토리에서든 같은 버전이 실행되게 한다. nvm처럼 shell을 바꿔 끼우는 방식이 아니라 shim으로 동작해서 shell을 새로 열어도 설정이 유지된다. 개발은 Node 24.19로 했다.

```sh
# Volta 설치
curl https://get.volta.sh | bash

# 새 터미널을 열거나 shell 설정을 다시 읽는다
source ~/.zshrc

# Node (LTS 최신)와 pnpm 설치. 설치한 버전이 기본값이 된다
volta install node
volta install pnpm

# 확인
node --version
pnpm --version
```

이 저장소는 `package.json`에 Volta 고정 항목을 두지 않았다. 버전을 고정하고 싶으면 저장소 root에서 `volta pin node@24`를 실행한다.

### 4. Docker (test 전용)

`pnpm check`와 Rust 통합 test는 PostgreSQL 18 test DB를 `docker compose`로 띄운다. 앱을 실행만 할 때는 필요 없다. [Docker Desktop](https://www.docker.com/products/docker-desktop/) 같은 Docker 엔진을 설치하고 실행해 둔다.

## 실행

```sh
# 의존 package 설치
pnpm install

# dev 실행 (화면은 Vite의 1420 포트, Rust는 cargo가 빌드한다)
pnpm tauri dev
```

처음 실행하면 Rust 의존 crate를 모두 빌드해서 몇 분 걸린다.

## 빌드와 설치

```sh
# release .app을 만든다. 결과: target/release/bundle/macos/ChillaSQL.app
scripts/build-app.sh

# dev 빌드와 같은 서명으로 debug .app을 만든다. 앱 동작 확인용
scripts/build-app.sh --debug
```

`build-app.sh`는 이 Mac의 code signing identity로 `.app`을 서명한다. 서명이 dev 빌드와 같아야 키체인이 두 빌드를 같은 앱으로 보고 비밀번호 확인 창을 매번 띄우지 않는다.

- identity를 고르는 순서: 환경 변수 `CHILLA_DEV_IDENTITY`, 없으면 키체인의 첫 유효 code signing identity.
- identity가 없으면 서명 없이 빌드하고, 키체인이 확인 창을 띄울 수 있다.
- 만든 `ChillaSQL.app`을 `/Applications`로 옮겨 쓴다.

## 확인 명령

| 명령 | 하는 일 |
| --- | --- |
| `pnpm check` | test DB를 띄우고 format, lint, typecheck, clippy, vitest, cargo test를 모두 돌린다. commit 전에 통과시킨다 |
| `pnpm test` | vitest만 돌린다 |
| `cargo test` | Rust test만 돌린다 (test DB가 필요하다) |
| `pnpm format` | Prettier와 `cargo fmt`로 코드를 정리한다 |
| `pnpm lint` | ESLint |
| `pnpm lint:rust` | clippy (경고를 오류로 본다) |
| `scripts/test-db.sh [up\|reset\|down]` | test DB를 관리한다. `54318`은 100만 행 seed가 든 PostgreSQL 18, `54319`는 SSL을 켠 서버다 |

## 프로젝트 사용법

앱에서 프로젝트 디렉토리를 열면 그 안의 `chilla.toml`과 `.sql` 파일이 프로젝트로 묶인다. 설정 파일이 없는 디렉토리를 열면 앱이 `[project]`만 든 `chilla.toml`을 만들 수 있다.

```toml
[project]
name = "my-service"

[connections.local]
host = "localhost"
port = 5432
database = "app"
user = "postgres"
color = "green"

# 터널 명령을 먼저 실행한 뒤 접속
[connections.staging]
host = "localhost"
port = 25432
database = "app"
user = "postgres"
tunnel = "ssh -N -L 25432:db.internal:5432 bastion"
color = "yellow"
```

| 저장 위치 | 들어가는 것 |
| --- | --- |
| 프로젝트 디렉토리 | `chilla.toml`(접속 정보와 터널 명령, 비밀번호 제외), `.sql` 파일. git에 올려도 안전하다 |
| `~/.config/chilla/config.toml` | 화면 언어, 에디터 글꼴, 결과 보관 상한, 단축키처럼 모든 프로젝트에 적용되는 설정. 파일이 없으면 기본값이고 바꾸면 앱을 다시 시작한다 |
| macOS 키체인 | 모든 접속의 비밀번호 |
| `~/Library/Application Support/com.yuiyeong.chillasql/` | 쿼리 기록, 열려 있던 탭, 최근 프로젝트 목록(SQLite) |

전역 설정 예시:

```toml
language = "ko"

[shortcuts]
reformat = "Shift+Cmd+F"
```

설정 파일의 형식, key 목록, 단축키 규칙은 기획서 [4.10](docs/spec.md)과 [5장](docs/spec.md)에 있다.

## 저장소 구조

```
crates/chilla-core/   DB 연결, 세션, 쿼리 실행 (Rust). infrastructure → application → domain 방향으로만 의존한다
src-tauri/            Tauri command. use case를 부르는 일만 한다
src/features/<기능>/  화면 기능별 component, store, hook
src/shared/           Tauri 호출(src/shared/api), 화면 문구(src/shared/i18n), 공용 UI
db/, compose.yaml     test DB(PostgreSQL 18)
scripts/              test DB, .app 빌드와 서명
docs/                 기획서, 마일스톤, 진행상황, 구조 규칙, 디자인
```

## 문서

| 문서 | 내용 |
| --- | --- |
| [기획서](docs/spec.md) | 기능 요구사항, 기술 스택, 설정 파일, 성능과 보안 기준 |
| [마일스톤](docs/milestones.md) | 개발 단계와 마일스톤별 완료 기준 |
| [진행상황](docs/progress.md) | 지금 하는 일, 결정 기록, 작업 로그 |
| [구조](docs/architecture.md) | layer 구성과 의존 규칙 |
| [디자인](docs/design/README.md) | 화면 디자인 캔버스, 색과 글자 token, 글꼴 |

## 글꼴 license

SQL 에디터와 결과 data는 D2Coding(OFL-1.1)을 쓴다. 글꼴 파일과 license 전문은 `public/fonts/`에 함께 있다.
