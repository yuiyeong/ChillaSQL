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

- [ ] **Step 1: template을 scratch 디렉토리에 만들고 저장소 루트로 복사**

저장소 루트가 비어 있지 않으므로 바로 생성하지 않는다.

`SCRATCH`는 저장소 밖의 임시 디렉토리다(예: `mktemp -d`).

```bash
SCRATCH=$(mktemp -d)
cd "$SCRATCH" && pnpm create tauri-app@4.7.5 chillasql --template react-ts --manager pnpm --identifier com.yuiyeong.chillasql --yes
rsync -a --exclude .gitignore --exclude README.md --exclude node_modules "$SCRATCH/chillasql/" /Users/jo/projects/chillasql/
```

`tauri.conf.json`의 `productName`을 `"ChillaSQL"`로, 창 `title`을 `"ChillaSQL"`로 바꾼다.

- [ ] **Step 2: 루트 `Cargo.toml` workspace와 빈 `chilla-core` crate 만들기**

```toml
[workspace]
members = ["src-tauri", "crates/chilla-core"]
resolver = "3"
```

`crates/chilla-core`는 edition 2024 lib crate이고 `lib.rs`는 비워 둔다. `src-tauri/Cargo.toml`에 `chilla-core = { path = "../crates/chilla-core" }`를 추가한다.

- [ ] **Step 3: 실패하는 test 작성**

```rust
// crates/chilla-core/tests/pg_query_smoke.rs
#[test]
fn splits_statements_ignoring_semicolon_inside_dollar_quote() {
    let sql = "SELECT 1; DO $$ BEGIN PERFORM 1; END $$; SELECT ';'";
    let statements = pg_query::split_with_parser(sql).unwrap();
    assert_eq!(statements.len(), 3);
}
```

- [ ] **Step 4: 실패 확인**

Run: `cargo test -p chilla-core`
Expected: FAIL. `unresolved crate pg_query` compile error가 난다.

- [ ] **Step 5: `chilla-core`의 `[dependencies]`에 `pg_query = "18.1"`을 추가하고 통과 확인**

Run: `cargo test -p chilla-core`
Expected: PASS (1 test)

build script가 도구 부족으로 실패하면 `brew install protobuf` 또는 `brew install cmake`로 그 도구만 설치하고 다시 돌린다. 설치한 도구와 이유는 진행상황 작업 로그에 남긴다.

- [ ] **Step 6: Tauri 빌드 안에서 compile 확인**

Run: `pnpm install && pnpm tauri build --debug --no-bundle`
Expected: 성공. `target/debug/chillasql`이 생긴다.

- [ ] **Step 7: `dist/` 없이 workspace 전체 test 확인 (Review Focus 1)**

Run: `rm -rf dist && cargo test`
Expected: PASS

`frontendDist` 경로가 없다는 오류가 나면 `src-tauri/build.rs`에서 `tauri_build::build()`를 부르기 전에 `std::fs::create_dir_all("../dist")`를 호출하고 다시 돌린다.

- [ ] **Step 8: Commit**

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

- [ ] **Step 1: test 도구 설치**

```bash
pnpm add -D vitest jsdom @testing-library/react @testing-library/jest-dom
```

`package.json`에 `"test": "vitest run"`, `vite.config.ts`에 `test` 블록, `src/test/setup.ts`를 추가한다.

- [ ] **Step 2: 실패하는 test 작성**

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

- [ ] **Step 3: 실패 확인**

Run: `pnpm test`
Expected: FAIL. template App의 heading은 `"Welcome to Tauri + React"`이고 입력란이 있다.

- [ ] **Step 4: `App` 교체, Tailwind 적용, template 잔재 제거**

- `App`은 화면 전체를 채우는 `<main>` 안에 `<h1>ChillaSQL</h1>`만 둔다. Tailwind class로 어두운 배경에 가운데 정렬한다.
- `pnpm add -D tailwindcss @tailwindcss/vite`로 설치하고, `pnpm add zustand`를 한다. 첫 store는 M3에서 만든다.
- Rust 쪽 `greet` command와 `tauri-plugin-opener`를 지운다. crate, `invoke_handler`, capability의 `opener:default`, npm `@tauri-apps/plugin-opener`가 대상이다.

- [ ] **Step 5: 통과 확인**

Run: `pnpm test && pnpm build && cargo test`
Expected: 모두 PASS. `pnpm build`는 tsc 오류 없이 `dist/`를 만든다.

- [ ] **Step 6: Commit**

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

- [ ] **Step 1: `scripts/test-db.sh` 작성 (검증 포함)**

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

- [ ] **Step 2: 실패 확인**

Run: `scripts/test-db.sh up`
Expected: FAIL. `compose.yaml`이 없어서 `no configuration file provided` 오류가 난다.

- [ ] **Step 3: `compose.yaml` 작성**

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

- [ ] **Step 4: `db/init/01-big-table.sql` 작성**

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

- [ ] **Step 5: Review Focus 3, 5 확인**

- Run `scripts/test-db.sh up` 한 번 더 → Expected: seed 없이 바로 PASS
- Run `docker compose exec -T db psql -U chilla -d chilla_test -c "DELETE FROM big_table WHERE id = 1"` 후 `scripts/test-db.sh up` → Expected: exit 1, `reset` 안내. 확인 뒤 `scripts/test-db.sh reset`.
- Docker Desktop을 끈 상태에서 `scripts/test-db.sh up` → Expected: exit 1, `Docker가 실행 중이 아닙니다`. 54318 포트 충돌은 docker의 bind 오류가 그대로 보이고 exit가 0이 아니면 된다.

- [ ] **Step 6: Commit**

```bash
git add compose.yaml db scripts
git commit -m "chore: PostgreSQL 18 test DB와 100만 행 seed script 추가"
```

---

### Task 4: 완료 기준 확인과 기록

**Files:**
- Modify: `docs/progress.md`
- Modify: `docs/plans/M0-setup.md` (체크박스)

- [ ] **Step 1: 완료 기준 실행**

Run: `cargo test && pnpm test && scripts/test-db.sh reset`
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
