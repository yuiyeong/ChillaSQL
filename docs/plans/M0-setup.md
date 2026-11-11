# M0 셋업 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 빈 Tauri 앱이 뜨고, `cargo test`와 `pnpm test`가 통과하고, script 하나로 100만 행짜리 test DB가 뜨는 상태를 만든다.

**Architecture:** 저장소 루트가 pnpm 프로젝트(React 화면)이자 Cargo workspace다. Rust는 Tauri command 층(`src-tauri`, crate `chillasql`)과 DB 코어(`crates/chilla-core`)로 나누고, 코어는 `tauri`에 의존하지 않는다. test DB는 docker compose의 PostgreSQL 18이며 init SQL로 100만 행을 만든다.

**Tech Stack:** Tauri 2.12, React + TypeScript + Vite(create-tauri-app `react-ts` template), Tailwind CSS 4(`@tailwindcss/vite`), Zustand 5, Vitest 4 + Testing Library + jsdom, Rust edition 2024, `pg_query` 18.1, Docker Compose + `postgres:18`

**Spec:** [기획서](../spec.md) 2장(기술 스택), 3장(구조), 8장 1단계 / [마일스톤](../milestones.md) M0

## Global Constraints

- macOS 전용. 다른 OS 대응 코드를 넣지 않는다.
- Tauri는 2.x를 쓴다. crates.io 최신이 `3.0.0-alpha`라도 쓰지 않는다.
- 패키지 매니저는 pnpm이다.
- 앱 이름은 `ChillaSQL`, 짧은 이름은 `chilla`다.
- `chilla-core`는 `tauri`에 의존하지 않는다. Tauri command 층만 `tauri`를 안다.
- test DB는 PostgreSQL 18이다.
- 모든 명령은 저장소 루트에서 실행한다(`cargo test`, `pnpm test`, `pnpm tauri dev`).
- commit 메시지는 영어 conventional prefix(`feat:`, `chore:`, `test:`, `docs:`)에 나머지는 한국어로 쓴다.

## Review Focus

1. **fresh clone에서 `dist/` 없이 `cargo test`를 실행하는 경우**: Tauri의 `generate_context!`가 `frontendDist`(`../dist`)가 없다고 실패할 수 있다. `pnpm build` 전에도 `cargo test`가 통과해야 한다. → Task 1 Step 7
2. **`pg_query` 빌드에 필요한 도구가 없는 경우**: `protoc`, `cmake`, libclang 중 무엇이 빠졌는지 알려야 한다. 설치한 도구는 기록으로 남긴다. → Task 1 Step 5
3. **test DB volume이 이미 있는 경우**: init SQL은 volume이 비었을 때만 돈다. 다시 `up`하면 seed를 건너뛰어도 데이터 검증은 통과해야 하고, 데이터가 다르면 `reset`을 안내해야 한다. → Task 3 Step 5
4. **init SQL이 도는 도중에 health check가 통과하는 경우**: `postgres` image는 init 중에 unix socket만 여는 임시 서버를 띄운다. health check는 TCP(`-h 127.0.0.1`)로 해야 seed가 끝난 뒤에 통과한다. → Task 3 Step 3, Step 4
5. **Docker가 꺼져 있거나 54318 포트가 이미 쓰이는 경우**: script는 0이 아닌 값으로 끝나고 원인을 한 줄로 보여 줘야 한다. → Task 3 Step 5

---

### Task 1: Tauri 골격, Cargo workspace, `pg_query` compile 확인 (먼저 확인할 것)

**Files:**
- Create: create-tauri-app `react-ts` template 전체(`package.json`, `index.html`, `vite.config.ts`, `tsconfig*.json`, `src/`, `public/`, `src-tauri/`). `.gitignore`와 `README.md`는 가져오지 않는다.
- Create: `Cargo.toml` (workspace)
- Create: `crates/chilla-core/Cargo.toml`, `crates/chilla-core/src/lib.rs`
- Modify: `src-tauri/Cargo.toml` (`chilla-core` 의존 추가), `src-tauri/tauri.conf.json`
- Test: `crates/chilla-core/tests/pg_query_smoke.rs`

**Interfaces:**
- Produces: Cargo workspace members `src-tauri`(package `chillasql`, lib `chillasql_lib`)와 `crates/chilla-core`(package `chilla-core`, lib `chilla_core`). `chilla-core`는 `pg_query = "18.1"`을 일반 dependency로 가진다. M2가 이 위에 문장 나누기를 만든다.

- [x] **Step 1: template을 scratch 디렉토리에 만들고 저장소 루트로 복사**

저장소 루트가 비어 있지 않으므로 바로 생성하지 않는다.

`SCRATCH`는 저장소 밖의 임시 디렉토리다(예: `mktemp -d`).

```bash
SCRATCH=$(mktemp -d)
cd "$SCRATCH" && pnpm create tauri-app@4.7.5 chillasql --template react-ts --manager pnpm --identifier com.yuiyeong.chillasql --yes
rsync -a --exclude .gitignore --exclude README.md --exclude node_modules "$SCRATCH/chillasql/" /Users/jo/projects/chillasql/
```

`tauri.conf.json`의 `productName`을 `"ChillaSQL"`로, 창 `title`을 `"ChillaSQL"`로 바꾼다.

- [x] **Step 2: 루트 `Cargo.toml` workspace와 빈 `chilla-core` crate 만들기**

```toml
[workspace]
members = ["src-tauri", "crates/chilla-core"]
resolver = "3"
```

`crates/chilla-core`는 edition 2024 lib crate이고 `lib.rs`는 비워 둔다. `src-tauri/Cargo.toml`에 `chilla-core = { path = "../crates/chilla-core" }`를 추가한다.

- [x] **Step 3: 실패하는 test 작성**

```rust
// crates/chilla-core/tests/pg_query_smoke.rs
#[test]
fn splits_statements_ignoring_semicolon_inside_dollar_quote() {
    let sql = "SELECT 1; DO $$ BEGIN PERFORM 1; END $$; SELECT ';'";
    let statements = pg_query::split_with_parser(sql).unwrap();
    assert_eq!(statements.len(), 3);
}
```

- [x] **Step 4: 실패 확인**

Run: `cargo test -p chilla-core`
Expected: FAIL. `unresolved crate pg_query` compile error가 난다.

- [x] **Step 5: `chilla-core`의 `[dependencies]`에 `pg_query = "18.1"`을 추가하고 통과 확인**

Run: `cargo test -p chilla-core`
Expected: PASS (1 test)

build script가 도구 부족으로 실패하면 `brew install protobuf` 또는 `brew install cmake`로 그 도구만 설치하고 다시 돌린다. 설치한 도구와 이유는 진행상황 작업 로그에 남긴다.

- [x] **Step 6: Tauri 빌드 안에서 compile 확인**

Run: `pnpm install && pnpm tauri build --debug --no-bundle`
Expected: 성공. `target/debug/chillasql`이 생긴다.

- [x] **Step 7: `dist/` 없이 workspace 전체 test 확인 (Review Focus 1)**

Run: `rm -rf dist && cargo test`
Expected: PASS

`frontendDist` 경로가 없다는 오류가 나면 `src-tauri/build.rs`에서 `tauri_build::build()`를 부르기 전에 `std::fs::create_dir_all("../dist")`를 호출하고 다시 돌린다.

- [x] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: Tauri 골격과 Cargo workspace 구성, pg_query compile 확인"
```

---

### Task 2: 화면 골격 (Tailwind, Zustand, Vitest)

**Files:**
- Modify: `package.json` (`"test": "vitest run"`, dependencies)
- Modify: `vite.config.ts` (`@tailwindcss/vite` plugin, `test` 블록: `environment: "jsdom"`, `setupFiles: ["./src/test/setup.ts"]`)
- Create: `src/test/setup.ts` (`import "@testing-library/jest-dom/vitest"`)
- Create: `src/index.css` (`@import "tailwindcss";`)
- Modify: `src/App.tsx`, `src/main.tsx` (`./index.css` import)
- Delete: `src/App.css`, `src/assets/react.svg`, `public/tauri.svg`, `public/vite.svg`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json` (template의 `greet` command와 opener plugin 제거)
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: Task 1의 template
- Produces: `pnpm test`(Vitest + jsdom + Testing Library) 환경, Tailwind가 적용된 `App` component. M3가 이 위에 화면을 올린다.

- [x] **Step 1: test 도구 설치**

```bash
pnpm add -D vitest jsdom @testing-library/react @testing-library/jest-dom
```

`package.json`에 `"test": "vitest run"`, `vite.config.ts`에 `test` 블록, `src/test/setup.ts`를 추가한다.

- [x] **Step 2: 실패하는 test 작성**

```tsx
// src/App.test.tsx
import { render, screen } from "@testing-library/react";
import App from "./App";

test("앱 이름을 보여 주고 template의 greet 입력란은 없다", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "ChillaSQL" })).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).toBeNull();
});
```

- [x] **Step 3: 실패 확인**

Run: `pnpm test`
Expected: FAIL. template App의 heading은 `"Welcome to Tauri + React"`이고 입력란이 있다.

- [x] **Step 4: `App` 교체, Tailwind 적용, template 잔재 제거**

- `App`은 화면 전체를 채우는 `<main>` 안에 `<h1>ChillaSQL</h1>`만 둔다. Tailwind class로 어두운 배경에 가운데 정렬한다.
- `pnpm add -D tailwindcss @tailwindcss/vite`로 설치하고, `pnpm add zustand`를 한다. 첫 store는 M3에서 만든다.
- Rust 쪽 `greet` command와 `tauri-plugin-opener`를 지운다. crate, `invoke_handler`, capability의 `opener:default`, npm `@tauri-apps/plugin-opener`가 대상이다.

- [x] **Step 5: 통과 확인**

Run: `pnpm test && pnpm build && cargo test`
Expected: 모두 PASS. `pnpm build`는 tsc 오류 없이 `dist/`를 만든다.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: Tailwind, Zustand, Vitest를 갖춘 화면 골격"
```

---

### Task 3: test DB와 100만 행 seed

**Files:**
- Create: `compose.yaml`
- Create: `db/init/01-big-table.sql`
- Create: `scripts/test-db.sh` (실행 권한)

**Interfaces:**
- Produces: test DB. M1 이후의 integration test가 접속한다.
  - 접속: `postgres://chilla:chilla@127.0.0.1:54318/chilla_test` (password는 test 전용)
  - 테이블 `public.big_table`, 정확히 1,000,000행
  - `scripts/test-db.sh up | reset | down`. 인자가 없으면 `up`이다.

- [x] **Step 1: `scripts/test-db.sh` 작성 (검증 포함)**

`set -euo pipefail`. 하위 명령은 다음과 같다.
- `up`
  1. `docker info`가 실패하면 `Docker가 실행 중이 아닙니다`를 출력하고 exit 1.
  2. `docker compose up -d --wait`를 실행한다.
  3. `docker compose exec -T db psql -U chilla -d chilla_test -tAc`로 아래 검증 query를 돌린다.
  4. 기대값과 다르면 `데이터가 기대와 다릅니다. scripts/test-db.sh reset 을 실행하세요`를 출력하고 exit 1.
  5. 성공하면 접속 URL을 출력한다.
- `reset`: `docker compose down -v` 후 `up`
- `down`: `docker compose down`

검증 query와 기대값은 다음과 같다.

```sql
SELECT count(*), count(*) FILTER (WHERE note IS NULL), count(*) FILTER (WHERE note = '')
FROM big_table;
-- 기대: 1000000|100000|100000
```

- [x] **Step 2: 실패 확인**

Run: `scripts/test-db.sh up`
Expected: FAIL. `compose.yaml`이 없어서 `no configuration file provided` 오류가 난다.

- [x] **Step 3: `compose.yaml` 작성**

- `name: chillasql`
- service `db`
  - image `postgres:18`
  - env `POSTGRES_USER=chilla`, `POSTGRES_PASSWORD=chilla`, `POSTGRES_DB=chilla_test`
  - ports `127.0.0.1:54318:5432`
  - volumes `./db/init:/docker-entrypoint-initdb.d:ro`, named volume `pgdata:/var/lib/postgresql`. PostgreSQL 18 image는 data 경로가 `/var/lib/postgresql/18/docker`로 바뀌었으므로 상위 디렉토리를 mount한다.
- healthcheck
  - `pg_isready -h 127.0.0.1 -U chilla -d chilla_test`
  - `interval: 2s`, `timeout: 3s`, `retries: 90`, `start_period: 120s`
  - TCP로 확인해야 init 중의 임시 서버에서 통과하지 않는다(Review Focus 4).

- [x] **Step 4: `db/init/01-big-table.sql` 작성**

데이터는 결정적으로 만든다(random 금지). 뒤 마일스톤의 test가 값을 예측할 수 있어야 한다. 컬럼은 M4·M8의 타입별 표시 확인용이다.

```sql
CREATE TABLE big_table (
  id         bigint PRIMARY KEY,
  name       text NOT NULL,
  amount     numeric(12,2) NOT NULL,
  created_at timestamptz NOT NULL,
  is_active  boolean NOT NULL,
  tags       text[] NOT NULL,
  payload    jsonb NOT NULL,
  note       text
);

INSERT INTO big_table
SELECT i,
       'user_' || i,
       (i % 100000) / 100.0,
       timestamptz '2026-01-01 00:00:00+00' + i * interval '1 minute',
       i % 2 = 0,
       ARRAY['tag' || (i % 5), 'tag' || (i % 7)],
       jsonb_build_object('i', i, 'hash', md5(i::text), 'nested', jsonb_build_object('even', i % 2 = 0)),
       CASE WHEN i % 10 = 0 THEN NULL WHEN i % 10 = 5 THEN '' ELSE repeat('x', i % 200) END
FROM generate_series(1, 1000000) AS i;

ANALYZE big_table;
```

Run: `scripts/test-db.sh reset`
Expected: PASS. 접속 URL이 출력된다.

- [x] **Step 5: Review Focus 3, 5 확인**

- Run `scripts/test-db.sh up` 한 번 더 → Expected: seed 없이 바로 PASS
- Run `docker compose exec -T db psql -U chilla -d chilla_test -c "DELETE FROM big_table WHERE id = 1"` 후 `scripts/test-db.sh up` → Expected: exit 1, `reset` 안내. 확인 뒤 `scripts/test-db.sh reset`.
- Docker Desktop을 끈 상태에서 `scripts/test-db.sh up` → Expected: exit 1, `Docker가 실행 중이 아닙니다`. 54318 포트 충돌은 docker의 bind 오류가 그대로 보이고 exit가 0이 아니면 된다.

- [x] **Step 6: Commit**

```bash
git add compose.yaml db scripts
git commit -m "chore: PostgreSQL 18 test DB와 100만 행 seed script 추가"
```

---

### Task 4: lint, formatter, 구조 규칙

M0 진행 중에 추가한 task다(2026-11-11 결정). 코드를 옮기지 않고 도구 설정과 규칙 문서만 넣는다. 실제 layer module은 M1의 첫 코드와 함께 생긴다.

**Files:**
- Create: `eslint.config.js`, `.prettierrc.json`, `.prettierignore`
- Modify: `package.json` (devDependencies, scripts)
- Modify: 기존 `src/**`, `*.ts`, `*.json`, Rust 파일 (formatter가 바꾸는 만큼만)
- Create: `docs/architecture.md`
- Modify: `CLAUDE.md` (구조 문서 pointer와 검사 명령), `docs/spec.md` 2장·3장, `docs/progress.md` 결정 기록

**Interfaces:**
- Consumes: Task 1의 Cargo workspace, Task 2의 `pnpm test`
- Produces: 아래 script. Task 5와 이후 모든 마일스톤이 `pnpm check`를 통과 기준으로 쓴다.
  - `pnpm lint`: `eslint .`
  - `pnpm lint:rust`: `cargo clippy --workspace --all-targets -- -D warnings`
  - `pnpm format`: `prettier --write . && cargo fmt --all`
  - `pnpm format:check`: `prettier --check . && cargo fmt --all --check`
  - `pnpm check`: `format:check`, `lint`, `lint:rust`, `test`, `cargo test`를 순서대로 실행
- Produces: 구조 규칙 (`docs/architecture.md`)
  - Rust: `crates/chilla-core/src/` 아래 `domain`(외부 I/O crate 의존 금지) ← `application`(use case와 port trait, `domain`만 의존) ← `infrastructure`(port 구현: `tokio-postgres`, keychain, 터널 프로세스, `pg_query`). `src-tauri`는 command에서 use case를 부르는 일만 한다.
  - 화면: `src/features/<기능>/`(component, store, hook)와 `src/shared/`. Tauri `invoke`는 `src/shared/api/`에서만 호출한다.

- [ ] **Step 1: 도구 설치와 설정 파일 작성**

```bash
pnpm add -D eslint @eslint/js typescript-eslint eslint-plugin-react-hooks eslint-config-prettier globals prettier prettier-plugin-tailwindcss
```

- `eslint.config.js`는 flat config다. `@eslint/js` recommended, `typescript-eslint` recommended, `react-hooks` recommended를 켜고 `eslint-config-prettier`를 마지막에 둔다. `dist`, `target`, `src-tauri/gen`은 ignore한다.
- `.prettierrc.json`은 `{ "plugins": ["prettier-plugin-tailwindcss"] }`만 둔다. 나머지는 Prettier 기본값이다.
- `.prettierignore`에는 `dist`, `target`, `src-tauri/gen`, `pnpm-lock.yaml`, `docs`, `*.md`를 넣는다. 한국어 문서는 Prettier가 건드리지 않는다.
- Rust는 `rustfmt`와 `clippy` 기본 설정을 쓴다. 설정 파일을 만들지 않는다.
- 위 Interfaces의 script 5개를 `package.json`에 추가한다.

- [ ] **Step 2: `invoke` 위치 규칙을 ESLint로 강제하고 실패 확인**

`eslint.config.js`에 `no-restricted-imports`를 추가한다. `@tauri-apps/api/core`를 import하면 `Tauri invoke는 src/shared/api 안에서만 호출한다` 메시지로 error를 낸다. `src/shared/api/**`만 예외다.

확인용으로 `src/violation.ts`에 `import { invoke } from "@tauri-apps/api/core"; export const x = invoke;`를 쓴다.

Run: `pnpm lint`
Expected: FAIL. `src/violation.ts`에서 위 메시지의 error 1개가 난다.

`src/violation.ts`를 지운다.

- [ ] **Step 3: 기존 코드에 formatter와 lint 적용**

Run: `pnpm format && pnpm check`
Expected: PASS. warning이 없다.

lint가 기존 코드에서 error를 내면 rule을 끄지 않고 코드를 고친다.

- [ ] **Step 4: 구조 규칙 문서화**

- `docs/architecture.md`에 위 Interfaces의 구조 규칙을 쓴다. layer별로 무엇이 들어가고 무엇에 의존할 수 있는지, 기획서 3장의 구성요소(세션 관리, 터널 관리, 쿼리 실행)가 어느 layer에 놓이는지 표로 정리한다. 문체는 기존 문서와 같은 "~한다" 평서체다.
- Rust layer의 의존 방향은 compiler가 강제하지 못한다. M1에서 첫 module을 만들 때 `domain`이 `infrastructure`를 import하지 않는지 확인하는 test를 넣는다는 점을 문서에 적는다.
- `CLAUDE.md`에 `docs/architecture.md` pointer를 추가하고, 작업 규칙에 "commit 전에 `pnpm check`를 통과시킨다"를 추가한다.
- `docs/spec.md` 2장 표에 lint와 formatter 행(ESLint + Prettier, clippy + rustfmt)을 추가하고, 3장에 구조 문서 link 한 줄을 추가한다.
- `docs/progress.md` 결정 기록에 두 행을 추가한다: lint/formatter 도입, layer를 crate가 아니라 `chilla-core` 안의 module로 나눈 것과 그 이유(혼자 쓰는 앱에 crate 여러 개는 과함).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: ESLint, Prettier, clippy, rustfmt 설정과 구조 규칙 문서 추가"
```

---

### Task 5: 완료 기준 확인과 기록

**Files:**
- Modify: `docs/progress.md`
- Modify: `docs/plans/M0-setup.md` (체크박스)

- [ ] **Step 1: 완료 기준 실행**

Run: `pnpm check && scripts/test-db.sh reset`
Expected: 모두 PASS. `reset`에 걸린 시간을 적어 둔다.

- [ ] **Step 2: 창 확인**

Run: `pnpm tauri dev`
Expected: `ChillaSQL` 제목의 창이 뜨고 가운데에 `ChillaSQL` heading이 Tailwind 스타일로 보인다. `screencapture`로 확인한 뒤 종료한다.

- [ ] **Step 3: 진행상황 갱신**

- M0 상태를 `완료`로 바꾸고 완료 날짜를 적는다.
- 작업 로그에 남긴다: `pg_query` compile 결과, 추가로 설치한 도구, Step 1의 시간
- "지금"을 `다음 할 일: M1 계획 작성 → docs/plans/M1-session-core.md`로 바꾼다.
- 기획서와 다르게 정한 것이 있으면 결정 기록에 남긴다.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: M0 완료 기록"
```
