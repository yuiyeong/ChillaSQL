# M7 스키마 트리와 자동완성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** sidebar의 Schema 화면에서 활성 탭 접속의 스키마, 테이블, 뷰, 컬럼, 인덱스, 제약조건을 탐색하고, 에디터에서 키워드, 스키마, 테이블, 컬럼, 함수를 자동완성한다. 쿼리 안의 테이블 별칭을 알아본다.

**Architecture:** Rust는 접속마다 탭 세션과 따로 catalog connection을 하나 열어 catalog를 읽는다(탭 세션은 받다 만 결과와 트랜잭션이 있어 쿼리를 끼울 수 없다). catalog connection은 그 접속의 터널 lease를 함께 쥐고, 화면이 그 접속을 쓰는 탭이 없어졌다고 알리면 닫는다. 읽기는 `DbConnection`의 새 method 두 개이고, SQL은 `infrastructure/postgres/catalog.rs`에 있다. 화면은 받은 catalog를 접속별로 `schemaStore`에 두고, 트리는 그것을 그리며, 자동완성은 에디터 문서의 `StateField`에 넣은 catalog로 `@codemirror/lang-sql`의 `schemaCompletionSource`와 직접 만든 source(별칭 없는 컬럼, 함수)를 돌린다.

**Tech Stack:** M6의 stack 그대로. `@codemirror/autocomplete` 6.20의 `autocompletion`과 `@codemirror/lang-sql` 6.10의 `schemaCompletionSource`, `keywordCompletionSource`를 새로 쓴다. 새 package와 crate는 없다.

**Spec:** [기획서](../spec.md) 4.2(접속 종료), 4.4(자동완성), 4.7(스키마 트리), 6장(자동완성 0.05초) / [마일스톤](../milestones.md) M7 / [디자인](../design/README.md)의 `Sidebar`(A, B), `Tools`(M7 자동완성), `Tokens` / [구조](../architecture.md)

## 먼저 확인한 것 (계획 작성 중 확인)

| 확인한 것 | 결과 | 결정 |
| --- | --- | --- |
| 별칭 인식을 lang-sql 기본 기능으로 할 수 있는지(마일스톤의 "먼저 확인할 것") | 설치된 `@codemirror/lang-sql` 6.10.0의 `schemaCompletionSource`가 문장의 FROM 뒤를 훑어 별칭을 모은다(`getAliases`). node로 돌려 봄: `SELECT u.em\| FROM users u`, `JOIN orders o ON …`의 `o.`, `FROM billing.invoices AS i`, `WHERE u.\|`, quoted 별칭(`"u"`), 여러 문장 중 둘째 문장이 모두 맞는 컬럼을 준다. 안 되는 것: 별칭 없이 쓰는 컬럼(`SELECT em\| FROM users`는 테이블 이름만 줌), `UPDATE users u SET u.\|`, 대문자로 쓴 unquoted 이름(`U.`, `FROM Users`), subquery 별칭 | schema, 테이블, `alias.`/`table.` 컬럼, 별칭은 lang-sql에 맡긴다. 별칭 없는 컬럼과 함수는 source를 직접 만든다(Task 8). 나머지 셋은 알려진 한계로 둔다 |
| 자동완성이 뜨는 시간 | `@codemirror/autocomplete` 6.20.4의 `activateOnTypingDelay` 기본값이 100ms다 | `activateOnTypingDelay: 0`. 기본값으로는 0.05초를 못 맞춘다 |
| catalog SQL(test DB, PostgreSQL 18) | 함수 이름을 `prokind IN ('f','a','w')`로 거르고 연산자 구현(`pg_operator.oprcode`), `internal`/`cstring`/handler pseudo-type을 받거나 돌려주는 함수를 빼면 1246개, 8ms. `int4_sum`(aggregate 보조 함수)이 남는다. `pg_get_keywords()`에서 `catcode <> 'U'`는 164개. PostgreSQL 18은 NOT NULL을 `pg_constraint`에 `contype = 'n'`으로 둔다 | aggregate 보조 함수(`pg_aggregate`의 transition, final 등)도 뺀다. 제약조건은 `p`, `f`, `u`, `c`, `x`만 보인다 |

## 이 계획에서 정한 것

기획서에 없거나 다르게 정한 것이다. Task 1에서 진행상황의 결정 기록에 옮기고, 기획서와 마일스톤도 고친다.

- **catalog는 탭 세션이 아니라 접속마다 하나인 catalog connection으로 읽는다.** 탭 세션에 catalog 쿼리를 끼우면 받다 만 결과를 버리고, 실패한 트랜잭션에서는 거절된다. catalog connection은 그 접속의 터널 lease를 쥐므로 탭 세션과 같은 터널을 쓴다. 화면은 그 접속을 쓰는 탭이 하나도 없으면 `close_catalog`를 부른다. 그래서 터널은 그 접속을 쓰는 탭이 없어지고 세션도 닫혔을 때 끝난다(기획서 4.2 "접속 종료"에 덧붙인다). 연결이 끊겨 있으면(`ConnectionLost`) 한 번 다시 연결해 다시 읽는다. 서버 오류는 다시 시도하지 않는다.
- **불러오는 때.** 활성 탭에 접속이 있으면(탭을 바꾸거나 탭의 접속을 바꾸면) 그 접속의 catalog를 뒤에서 불러온다. 터널 접속은 이때 터널이 뜬다. 실패하면 Schema 화면에 오류와 Retry를 보이고 저절로 다시 시도하지 않는다.
- **한 번에 읽는 것과 펼칠 때 읽는 것.** 스키마, 테이블, 뷰, 컬럼, 함수 이름, `current_schemas(false)`, reserved keyword는 한 번에 읽어 메모리에 둔다(자동완성이 0.05초 안에 떠야 해서). 인덱스와 제약조건은 테이블의 그 group을 처음 펼칠 때 relation OID로 읽는다. 기획서 4.7 "지연 로딩"을 이렇게 고친다.
- **보이는 범위.** `pg_catalog`, `information_schema`, `pg_toast`, temp schema는 트리와 테이블 자동완성에서 뺀다. 함수 자동완성에는 `pg_catalog`의 함수도 넣되 위 표의 함수는 뺀다. partition(`relispartition`)은 빼고 부모만 보인다. Tables는 relkind `r`, `p`, `f`, Views는 `v`, `m`이다. catalog SQL은 PostgreSQL 11 이상을 가정한다(`prokind`).
- **트리 모양(Sidebar A).** schema → Tables, Views(비어 있으면 그 group은 없음) → 테이블/뷰 → Columns, Indexes, Constraints. 컬럼 icon은 primary key면 `PK`, 아니면 `c`이고 오른쪽에 type(`format_type`)이다. 인덱스는 unique면 오른쪽에 `unique`, `title`에 `pg_get_indexdef`. 제약조건은 오른쪽에 SQL keyword(`PRIMARY KEY`, `FOREIGN KEY`, `UNIQUE`, `CHECK`, `EXCLUDE`), `title`에 `pg_get_constraintdef`. 처음에는 `current_schemas(false)`의 첫 schema와 그 Tables만 펼친다. 펼친 상태는 접속마다 store에 남고 새로고침해도 이름으로 남는다. 화살표 key 이동은 만들지 않는다(Files 목록과 같다).
- **새로고침**은 catalog 전체를 다시 읽고, 받아 둔 인덱스와 제약조건을 버린 뒤 펼쳐 있는 것만 다시 읽는다. 읽는 동안 옛 트리를 그대로 보인다.
- **Select first rows.** 테이블이나 뷰를 더블클릭하거나 menu에서 고르면 새 탭(같은 접속, Auto)에 `SELECT * FROM "schema"."name" LIMIT 500`을 넣고 실행한다. 지금 탭의 받다 만 결과와 트랜잭션을 건드리지 않으려는 것이다. 500은 batch 하나다.
- **트리 menu.** 테이블과 뷰는 Select first rows, Copy name이고 나머지 항목은 Copy name뿐이다. Show DDL은 M9에서 넣는다(캔버스에는 있음). Copy name은 그 항목 이름 하나를 PostgreSQL `quote_ident`와 같은 규칙으로 복사하고 toast를 보인다: 소문자, 숫자, `_`, `$`로만 되어 있고 숫자로 시작하지 않고 reserved keyword(`catcode <> 'U'`)가 아니면 그대로, 아니면 `"`로 감싼다.
- **자동완성.** 입력하면 바로 뜬다. 직접 여는 key는 CodeMirror 기본(`Ctrl+Space`, `Opt+\``, `Opt+I`)이다. keyword는 대문자로 넣는다. 함수는 이름만 넣는다. detail은 컬럼 `users · text`, 테이블 `public`, 뷰 `public · view`, 함수 schema 이름이다. kind 글자는 Tools 캔버스의 c, t, f, k에 schema `s`를 더하고 footer 설명에도 넣는다. 활성 탭에 접속이 없거나 catalog가 아직 없으면 keyword만 나온다.

## Global Constraints

- 의존 방향: `infrastructure` → `application` → `domain`(`tests/layer_deps.rs`). catalog SQL과 `tokio-postgres` 호출은 `infrastructure`에만 둔다. `chilla-core`는 `tauri`에 의존하지 않는다.
- `@tauri-apps/*`는 `src/shared/api/`에서만 import한다.
- 화면 문구는 `src/shared/i18n/en.ts`에 두고 `t`, `tc`로 쓴다. SQL keyword(`PRIMARY KEY`, `SELECT`), schema·테이블·컬럼 이름, type 이름, 서버 오류 메시지는 번역하지 않는다.
- 색, 그림자, 글자 크기는 `src/index.css`의 token으로만 쓴다. 접속 색은 Schema 화면 머리의 dot에만 쓴다.
- 상수: Select first rows의 `LIMIT 500`, `activateOnTypingDelay` 0, 자동완성 0.05초.
- commit 전에 `pnpm check`를 통과시킨다. commit message는 `feat:`/`fix:`/`docs:`/`chore:`/`test:` 뒤에 한국어 한 줄이다.
- `docs/`는 평서체, 기술 용어는 영어, 날짜는 `YYYY-MM-DD`, 단축키는 `Ctrl+Space`처럼 글자로 쓴다.

## Review Focus

test가 없으면 사용자가 가장 먼저 부딪힐 입력과 상황이다. 각 줄의 test는 해당 Task에 넣었다.

1. **catalog connection이 밖에서 끊김**(서버 재시작, 터널 재시작): 다음 새로고침이나 펼치기가 오류 없이 다시 연결해야 한다 → Task 3 `reconnects_once_when_the_catalog_connection_was_lost`.
2. **이름에 대문자, 공백, reserved keyword가 있는 테이블**(`"Order Items"`, `user`): Select first rows가 실행되고 Copy name과 자동완성이 넣은 이름이 그대로 SQL로 쓰여야 한다 → Task 2 `catalog_lists_user_objects`(`Order Items`), Task 7 `quote_ident_matches_postgres`, `select_first_rows_quotes_names`.
3. **새로고침을 두 번 누르거나 탭을 빠르게 바꿈**: 늦게 온 옛 응답이 새 catalog를 덮으면 안 된다 → Task 5 `a_late_response_does_not_overwrite_a_newer_refresh`.
4. **큰 DB**(테이블 5,000개 × 컬럼 20개): 자동완성이 0.05초 안에 답해야 한다 → Task 9 `completes_within_50ms_on_a_large_catalog`.
5. **같은 접속의 마지막 탭을 닫음**: catalog connection이 닫혀 터널이 남지 않아야 한다 → Task 3 `closing_the_catalog_releases_the_tunnel`, Task 5 `forgets_catalogs_no_tab_uses`.

---

## File Structure

| 파일 | 할 일 |
| --- | --- |
| `crates/chilla-core/src/domain/catalog.rs` (새) | `Catalog`, `Relation`, `RelationKind`, `CatalogColumn`, `FunctionName`, `TableDetails`, `IndexInfo`, `ConstraintInfo`, `ConstraintKind` |
| `crates/chilla-core/src/application/ports.rs` | `DbConnection::read_catalog`, `read_table_details` |
| `crates/chilla-core/src/infrastructure/postgres/catalog.rs` (새) | catalog SQL과 `PgConnection`의 두 method |
| `crates/chilla-core/src/application/test_support/{mod,connection}.rs` | fake의 catalog |
| `crates/chilla-core/src/application/app.rs` | catalog connection, `load_catalog`, `load_table_details`, `close_catalog` |
| `crates/chilla-core/tests/catalog.rs` (새) | test DB로 catalog SQL 검사 |
| `src-tauri/src/{commands,error,lib}.rs` | command 셋, DTO, `catalog_failed` |
| `src/shared/api/{types,commands}.ts` | `Catalog`, `TableDetails`, 호출 셋 |
| `src/shared/sql/identifiers.ts` (새) | `quoteIdent` |
| `src/features/schema/schemaStore.ts` (새) | 접속별 catalog, 인덱스·제약조건, 펼친 상태 |
| `src/features/schema/useSchemaLifecycle.ts` (새) | 불러오는 때와 닫는 때 |
| `src/features/schema/schemaRows.ts` (새) | catalog와 펼친 상태로 화면에 보일 줄을 편다 |
| `src/features/schema/SchemaView.tsx` (새) | Schema 화면(Sidebar A, B) |
| `src/features/project/Sidebar.tsx` | Files/Schema 전환 |
| `src/shared/ui/Menu.tsx` | 마우스 위치에 여는 `at` |
| `src/features/editor/completion.ts` (새) | `catalogField`, completion source |
| `src/features/editor/{extensions,SqlEditor}.ts(x)` | `autocompletion`, popup 모양, catalog 넣기 |
| `src/features/editor/tabsStore.ts`, `src/features/workspace/{commands,Workspace,Toolbar}.ts(x)` | 새 탭의 text, `selectFirstRows`, 접속 menu 열기 |

---

### Task 1: 먼저 확인한 것과 결정 기록

**Files:**
- Modify: `docs/progress.md`, `docs/spec.md`, `docs/milestones.md`

- [x] **Step 1: 문서를 고친다**

- 진행상황: M7을 `진행 중`(시작 2026-11-20, 계획 링크), "지금"을 M7 Task 2로. 결정 기록에 "이 계획에서 정한 것"의 줄마다 한 줄(날짜 2026-11-20, M7).
- 기획서 4.2 "접속 종료": 스키마를 읽는 연결도 그 접속을 쓰는 탭이 없어지면 닫는다고 덧붙인다. 4.4 "자동완성": 입력하면 바로 뜨고 keyword는 대문자. 4.7 "지연 로딩": 위 결정의 문장으로. "빠른 조회": 새 탭에서 앞 500행. 마지막 수정 날짜.
- 마일스톤 M7 "먼저 확인할 것": 위 표의 첫 줄 결과를 `→ 정함:` 꼴로 적는다.

- [x] **Step 2: commit**

```bash
git add docs
git commit -m "docs: M7 계획과 스키마 catalog connection, 자동완성 결정을 기록함"
```

---

### Task 2: catalog 읽기 (Rust)

**Files:**
- Create: `crates/chilla-core/src/domain/catalog.rs`, `crates/chilla-core/src/infrastructure/postgres/catalog.rs`, `crates/chilla-core/tests/catalog.rs`
- Modify: `crates/chilla-core/src/domain/mod.rs`, `crates/chilla-core/src/application/ports.rs`, `crates/chilla-core/src/infrastructure/postgres/mod.rs`, `crates/chilla-core/src/application/test_support/{mod,connection}.rs`

**Interfaces:**
- Produces (domain, 모두 `Debug, Clone, PartialEq, Eq`):
  ```rust
  pub struct Catalog {
      /// `current_schemas(false)` 순서. 자동완성의 기본 schema는 첫 값이다.
      pub search_path: Vec<String>,
      /// system schema를 뺀 schema, 이름 오름차순.
      pub schemas: Vec<String>,
      /// (schema, name) 오름차순. 컬럼은 attnum 순서.
      pub relations: Vec<Relation>,
      /// (schema, name) 중복 없이 오름차순.
      pub functions: Vec<FunctionName>,
      /// `pg_get_keywords()`에서 `catcode <> 'U'`인 word.
      pub reserved_words: Vec<String>,
  }
  pub struct Relation { pub oid: u32, pub schema: String, pub name: String, pub kind: RelationKind, pub columns: Vec<CatalogColumn> }
  pub enum RelationKind { Table, PartitionedTable, ForeignTable, View, MaterializedView }
  pub struct CatalogColumn { pub name: String, pub type_name: String, pub primary_key: bool }
  pub struct FunctionName { pub schema: String, pub name: String }
  pub struct TableDetails { pub indexes: Vec<IndexInfo>, pub constraints: Vec<ConstraintInfo> }
  pub struct IndexInfo { pub name: String, pub definition: String, pub unique: bool, pub primary: bool }
  pub struct ConstraintInfo { pub name: String, pub kind: ConstraintKind, pub definition: String }
  pub enum ConstraintKind { PrimaryKey, ForeignKey, Unique, Check, Exclusion }
  ```
- Produces (`DbConnection`에 더함):
  ```rust
  /// 스키마 트리와 자동완성의 catalog. 연결이 끊겨 있으면 `ConnectionLost`다.
  fn read_catalog(&self) -> impl Future<Output = Result<Catalog, QueryError>> + Send;
  /// 그 relation의 인덱스와 제약조건, 각각 이름 오름차순. 없는 OID면 둘 다 비어 있다.
  fn read_table_details(&self, relation: u32) -> impl Future<Output = Result<TableDetails, QueryError>> + Send;
  ```
- Produces (fake): `FakeConnector::set_catalog(Catalog)`, `set_details(u32, TableDetails)`, `fail_next_catalog(QueryError)`, `catalog_reads() -> usize`(그 connector가 만든 연결 전체의 `read_catalog` 호출 수). 끊긴 link(`FakeLink::lose`)의 두 method는 `ConnectionLost`다.

- [x] **Step 1: integration test를 쓴다** (`tests/catalog.rs`)

test마다 따로 schema를 `support::admin()`으로 `DROP SCHEMA IF EXISTS … CASCADE` 뒤 만든다. `support::connect()`로 연 `PgConnection`을 쓴다.

- `catalog_lists_user_objects`: schema `m7_cat_a`에 `CREATE TABLE "Order Items" (id bigint PRIMARY KEY, "Note" text)`, `CREATE VIEW v_items AS SELECT id FROM "Order Items"`, `CREATE MATERIALIZED VIEW mv_items AS SELECT id FROM "Order Items"`, `CREATE TABLE events (at date) PARTITION BY RANGE (at)`와 partition `events_2026`, `CREATE FUNCTION m7_cat_a.add_one(int) RETURNS int LANGUAGE sql AS 'SELECT $1 + 1'`.
  - `schemas`에 `m7_cat_a`, `public`이 있고 `pg_catalog`, `information_schema`, `pg_toast`가 없다.
  - `m7_cat_a`의 relation은 `Order Items`(Table, 컬럼 `id`/`bigint`/pk true, `Note`/`text`/pk false), `events`(PartitionedTable), `mv_items`(MaterializedView), `v_items`(View) 넷이고 `events_2026`은 없다.
  - `functions`에 (`m7_cat_a`, `add_one`), (`pg_catalog`, `date_trunc`), (`pg_catalog`, `jsonb_build_object`), (`pg_catalog`, `count`)가 있고 이름이 `int4pl`, `textin`, `array_in`, `heap_tableam_handler`, `int4_sum`인 것은 없다.
  - `search_path == ["public"]`. `reserved_words`에 `select`, `user`가 있고 `id`는 없다.
- `table_details_lists_indexes_and_constraints`: schema `m7_cat_b`에 `parent(id int PRIMARY KEY)`, `child(id int PRIMARY KEY, email text NOT NULL UNIQUE, amount int CHECK (amount > 0), parent_id int REFERENCES parent, created_at date)`, `CREATE INDEX child_created ON child (created_at)`.
  - `indexes` 이름 = `child_created`, `child_email_key`, `child_pkey`. `child_pkey`는 unique·primary, `child_email_key`는 unique, `child_created`는 둘 다 false이고 definition이 `CREATE INDEX child_created ON m7_cat_b.child USING btree (created_at)`.
  - `constraints`의 kind는 `child_amount_check` Check, `child_email_key` Unique, `child_parent_id_fkey` ForeignKey, `child_pkey` PrimaryKey이고 NOT NULL 제약조건은 없다. FK definition은 `FOREIGN KEY (parent_id) REFERENCES m7_cat_b.parent(id)`.
- `table_details_of_an_unknown_oid_are_empty`: `read_table_details(0)`이 빈 두 목록.

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test -p chilla-core --test catalog`
Expected: FAIL (`read_catalog`가 없음)

- [x] **Step 3: 구현한다**

- 쿼리는 `self.client.query(sql, &[…])`(extended protocol, typed 값)로 보낸다. relkind와 contype은 SQL에서 `::text`로 바꿔 받는다. OID는 `u32`(`oid`)다.
- relation과 컬럼은 한 쿼리다: `pg_class` ⋈ `pg_namespace`, `LEFT JOIN pg_attribute`(`attnum > 0 AND NOT attisdropped`, 컬럼 없는 테이블도 남게), `LEFT JOIN pg_index`(`indisprimary`)로 `attnum = ANY(indkey)`면 pk. Rust에서 (schema, name)이 같은 줄을 묶는다.
- system schema 조건: `nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND nspname NOT LIKE 'pg\_temp\_%' AND nspname NOT LIKE 'pg\_toast\_temp\_%'`. 함수만 `pg_catalog`를 남긴다.
- 함수에서 뺄 pseudo-type은 `pg_type.typname IN ('internal','cstring','trigger','event_trigger','language_handler','fdw_handler','index_am_handler','table_am_handler','tsm_handler')`의 OID로 고른다(버전마다 없는 이름이 있어도 실패하지 않게). aggregate 보조 함수는 `pg_aggregate`의 `aggtransfn`, `aggfinalfn`, `aggcombinefn`, `aggserialfn`, `aggdeserialfn`, `aggmtransfn`, `aggminvtransfn`, `aggmfinalfn`에 있는 것이다.
- search_path: `SELECT s FROM unnest(current_schemas(false)) WITH ORDINALITY AS t(s, i) ORDER BY i`.
- 쿼리 오류는 `QueryError`로 바꾼다(`postgres/mod.rs`의 `query_error`).
- fake: `FakeConnector`가 가진 catalog를 새 link가 함께 본다. 기본값은 빈 `Catalog`다.

- [x] **Step 4: 통과를 확인한다**

Run: `cargo test -p chilla-core`
Expected: PASS (`layer_deps` 포함)

- [x] **Step 5: commit**

```bash
git add crates
git commit -m "feat: 연결에서 스키마 catalog와 테이블의 인덱스, 제약조건을 읽음"
```

---

### Task 3: App의 catalog connection

**Files:**
- Modify: `crates/chilla-core/src/application/app.rs`(unit test 포함)

**Interfaces:**
- Consumes: Task 2의 `DbConnection::read_catalog`, `read_table_details`, fake의 catalog
- Produces:
  ```rust
  /// 그 접속의 catalog connection(없으면 연다, 터널 lease를 함께 쥔다)으로 catalog를 읽는다.
  pub async fn load_catalog(&self, connection: &str) -> Result<Catalog, AppError>;
  pub async fn load_table_details(&self, connection: &str, relation: u32) -> Result<TableDetails, AppError>;
  /// catalog connection을 닫고 터널 lease를 놓는다. 없으면 아무것도 하지 않는다.
  pub async fn close_catalog(&self, connection: &str) -> Result<(), AppError>;
  ```
  `AppError::Catalog(QueryError)` — message `Could not read the schema: {0}`.
- 접속마다 slot 하나(`Arc<tokio::sync::Mutex<Option<…>>>`)를 둬 한 연결의 읽기를 차례로 하고, 같은 접속을 동시에 두 번 열지 않는다. 여는 사이 프로젝트가 바뀌면(`project_generation`) `open_session`처럼 닫고 `ProjectChanged`다. `switch_project`와 `shutdown`이 catalog connection을 모두 닫는다.

- [x] **Step 1: test를 쓴다** (`app.rs`의 `mod tests`, 기존 `fixture()`)

- `load_catalog_opens_one_connection_and_reuses_it`: `load_catalog` 둘과 `load_table_details` 하나 → `connector.requests().len() == 1`, `catalog_reads() == 2`, 돌려준 값이 `set_catalog`의 값.
- `catalog_connection_shares_the_tunnel_with_sessions`: 터널 접속(`set_tunnel`)으로 `open_session` 뒤 `load_catalog` → `runner.spawned().len() == 1`. `close_session` 뒤에도 `runner.running() == 1`.
- `closing_the_catalog_releases_the_tunnel`: 위에 이어 `close_catalog` → `runner.running() == 0`, catalog link가 `closed()`.
- `reconnects_once_when_the_catalog_connection_was_lost`: `load_catalog` 뒤 그 link를 `lose()` → 다음 `load_catalog`가 `Ok`, `requests().len() == 2`, 옛 link가 `closed()`.
- `a_second_loss_is_reported`: `fail_next_catalog(ConnectionLost)` 두 번 → `Err(AppError::Catalog(QueryError::ConnectionLost { .. }))`.
- `server_errors_are_not_retried`: `fail_next_catalog(Server(…))` → `Err(Catalog(Server))`, `requests().len() == 1`.
- `switching_projects_closes_catalog_connections`와 `shutdown_closes_catalog_connections`: link가 `closed()`.
- `close_catalog_without_a_connection_is_ok`, `load_catalog_of_an_unknown_connection_fails`(`UnknownConnection`).

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test -p chilla-core --lib app::tests`
Expected: FAIL

- [x] **Step 3: 구현한다**

여는 순서와 비밀번호, 터널 lease는 `open_session`의 것을 같이 쓰도록 꺼낸다(`connect_profile` 같은 private 함수). 읽다 `ConnectionLost`가 오면 그 연결을 닫고 lease를 놓은 뒤 한 번만 새로 열어 다시 읽는다.

- [x] **Step 4: 통과를 확인한다**

Run: `cargo test -p chilla-core`
Expected: PASS

- [x] **Step 5: commit**

```bash
git add crates
git commit -m "feat: 접속마다 catalog connection을 열어 터널을 함께 쓰고, 끊기면 한 번 다시 연결함"
```

---

### Task 4: Tauri command와 화면 API

**Files:**
- Modify: `src-tauri/src/{commands,error,lib}.rs`, `src/shared/api/{types,commands,commands.test}.ts`

**Interfaces:**
- Consumes: Task 3의 세 method
- Produces (command): `load_catalog(connection) -> CatalogDto`, `load_table_details(connection, relation: u32) -> TableDetailsDto`, `close_catalog(connection)`. `AppError::Catalog`의 kind는 `catalog_failed`.
- Produces (화면, `types.ts`):
  ```ts
  export type RelationKind = "table" | "partitioned_table" | "foreign_table" | "view" | "materialized_view";
  export interface CatalogColumn { name: string; type: string; primaryKey: boolean }
  export interface Relation { oid: number; schema: string; name: string; kind: RelationKind; columns: CatalogColumn[] }
  export interface Catalog { searchPath: string[]; schemas: string[]; relations: Relation[]; functions: { schema: string; name: string }[]; reservedWords: string[] }
  export type ConstraintKind = "primary_key" | "foreign_key" | "unique" | "check" | "exclusion";
  export interface TableDetails {
    indexes: { name: string; definition: string; unique: boolean; primary: boolean }[];
    constraints: { name: string; kind: ConstraintKind; definition: string }[];
  }
  ```
- Produces (`commands.ts`): `loadCatalog(connection: string): Promise<Catalog>`, `loadTableDetails(connection: string, relation: number): Promise<TableDetails>`, `closeCatalog(connection: string): Promise<void>`.

- [x] **Step 1: test를 쓴다**

- `commands.rs`: `catalog_dto_uses_camel_case_and_snake_case_kinds`(`CatalogColumn.type_name` → `"type"`, `primary_key` → `"primaryKey"`, `MaterializedView` → `"materialized_view"`), `table_details_dto_kinds`.
- `error.rs`: 기존 kind 표 test에 `catalog_failed`를 더한다.
- `commands.test.ts`: 세 호출의 command 이름과 인자(`{ connection }`, `{ connection, relation }`).

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test -p chillasql && pnpm vitest run src/shared/api`
Expected: FAIL

- [x] **Step 3: 구현한다** — command는 use case만 부르고 `lib.rs`의 `generate_handler!`에 셋을 더한다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add src-tauri src/shared/api
git commit -m "feat: catalog를 읽고 닫는 command를 화면에 열어 줌"
```

---

### Task 5: 화면의 schema store와 불러오는 때

**Files:**
- Create: `src/features/schema/{schemaStore,schemaStore.test,useSchemaLifecycle}.ts`, `src/features/schema/useSchemaLifecycle.test.tsx`
- Modify: `src/features/workspace/{commands,commands.test,Workspace}.ts(x)`, `src/test/resetStores.ts`

**Interfaces:**
- Consumes: Task 4의 세 호출
- Produces:
  ```ts
  export interface DetailsEntry { status: "loading" | "ready" | "failed"; details: TableDetails | null; error: string | null }
  export interface SchemaEntry {
    status: "loading" | "ready" | "failed";
    /** 마지막으로 받은 catalog. 새로고침하는 동안에도 남는다. */
    catalog: Catalog | null;
    error: string | null;
    /** relation OID별 */
    details: Record<number, DetailsEntry>;
    /** 펼친 node의 key(`nodeKey`) */
    expanded: ReadonlySet<string>;
  }
  export interface SchemaState {
    entries: Record<string, SchemaEntry>;
    /** entry가 없거나 failed면 불러온다. */
    ensure(connection: string): Promise<void>;
    refresh(connection: string): Promise<void>;
    /** 그 OID의 details가 없거나 failed면 불러온다. */
    loadDetails(connection: string, relation: number): Promise<void>;
    toggle(connection: string, key: string): void;
    /** Rust의 catalog connection을 닫고 entry를 지운다. */
    forget(connection: string): Promise<void>;
    /** Rust를 부르지 않고 비운다. 프로젝트를 바꿀 때 */
    reset(): void;
  }
  export const useSchema: UseBoundStore<StoreApi<SchemaState>>;
  /** node의 key. path는 [schema], [schema, "tables"|"views"], [schema, group, name], [schema, group, name, "columns"|"indexes"|"constraints"]이다. */
  export function nodeKey(path: readonly string[]): string; // JSON.stringify(path)
  export function useSchemaLifecycle(): void;
  ```
- 응답은 그 접속에 마지막으로 보낸 요청의 것만 반영한다(접속별 요청 번호). `forget`이나 `reset` 뒤에 온 응답은 버린다.
- 처음 `ready`가 되면 `expanded`에 `[searchPath[0]]`과 `[searchPath[0], "tables"]`를 넣는다(이미 entry가 있던 새로고침에서는 그대로).

- [x] **Step 1: test를 쓴다**

`schemaStore.test.ts`(`shared/api/commands` mock):
- `ensure_loads_once`: 두 번 불러도 `loadCatalog` 한 번. `ready` 뒤 `catalog`가 그 값.
- `ensure_retries_a_failed_catalog`, `failed_keeps_the_message`(`messageOf(error)`).
- `first_load_expands_the_default_schema_and_its_tables`.
- `refresh_keeps_the_old_catalog_while_loading`, `refresh_reloads_expanded_details_by_name`: `public.users`의 indexes를 펼쳐 둔 채 새로고침하면 새 catalog의 `users` OID로 `loadTableDetails`를 부르고 접힌 테이블은 부르지 않는다.
- `a_late_response_does_not_overwrite_a_newer_refresh`: 첫 응답을 늦게 끝내도 둘째 catalog가 남는다.
- `forget_closes_and_drops_the_entry`, `a_response_after_forget_is_ignored`.

`useSchemaLifecycle.test.tsx`(hook을 render한 채 `tabsStore`를 바꾼다):
- `forgets_catalogs_no_tab_uses`: 접속 `local`의 마지막 탭을 닫으면 `closeCatalog("local")`. 같은 접속의 탭이 남아 있으면 부르지 않는다.
- `loads_the_catalog_of_the_active_tab`: 활성 탭의 접속을 바꾸면 `loadCatalog(새 접속)`. 접속이 없는 탭이면 부르지 않는다.

`commands.test.ts`:
- `saving_a_changed_target_reloads_its_catalog`: `applySavedProject`로 대상이 바뀐 접속은 `closeCatalog` 뒤 그 접속을 쓰는 탭이 있으면 `loadCatalog`.
- `switching_projects_resets_schemas`.

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/schema src/features/workspace/commands.test.ts`
Expected: FAIL

- [x] **Step 3: 구현한다**

- `useSchemaLifecycle`은 `Workspace`에서 부른다. effect 둘: 활성 탭의 접속이 바뀌면 `ensure`, 탭들의 접속 집합에 없는 entry는 `forget`.
- `applySavedProject`는 바뀐 접속마다 `forget` 뒤, 그 접속을 쓰는 탭이 있으면 `ensure`한다. `switchProject`는 `useSchema.getState().reset()`을 다른 reset과 함께 부른다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add src
git commit -m "feat: 활성 탭 접속의 catalog를 뒤에서 불러와 접속별로 보관함"
```

---

### Task 6: sidebar의 Schema 화면

**Files:**
- Create: `src/features/schema/{schemaRows,schemaRows.test}.ts`, `src/features/schema/{SchemaView,SchemaView.test}.tsx`
- Modify: `src/features/project/{Sidebar,Sidebar.test}.tsx`, `src/features/workspace/{Workspace,Toolbar,Toolbar.test}.tsx`, `src/shared/i18n/en.ts`

**Interfaces:**
- Consumes: Task 5의 `useSchema`, `nodeKey`
- Produces:
  ```ts
  export type SchemaRow =
    | { kind: "schema"; key: string; depth: 0; name: string; expanded: boolean }
    | { kind: "group"; key: string; depth: number; group: "tables" | "views" | "columns" | "indexes" | "constraints"; expanded: boolean; relation: Relation | null }
    | { kind: "relation"; key: string; depth: 2; relation: Relation; expanded: boolean }
    | { kind: "column"; key: string; depth: 4; column: CatalogColumn }
    | { kind: "index"; key: string; depth: 4; index: TableDetails["indexes"][number] }
    | { kind: "constraint"; key: string; depth: 4; constraint: TableDetails["constraints"][number] }
    | { kind: "loading" | "empty" | "failed"; key: string; depth: number; relation: Relation | null; error: string | null };
  /** 접힌 node 안은 건너뛰고 보이는 줄만 순서대로 편다. */
  export function schemaRows(entry: SchemaEntry): SchemaRow[];
  export function SchemaView(props: { onChooseConnection(): void }): JSX.Element;
  ```
- Toolbar: 접속 menu의 열림을 `Workspace`로 올린다 — `Toolbar`에 `connectionMenuOpen: boolean`, `onConnectionMenuChange(open: boolean): void`. Sidebar의 Choose connection이 `onConnectionMenuChange(true)`를 부른다.
- 문구(`en.ts`): `schema.label` "Schema", `schema.refresh` "Refresh schema", `schema.noConnection` "No connection in this tab", `schema.chooseConnection` "Choose connection", `schema.loading` "Loading", `schema.retry` "Retry", `schema.empty` "None", `schema.group.tables` "Tables", `schema.group.views` "Views", `schema.group.columns` "Columns", `schema.group.indexes` "Indexes", `schema.group.constraints` "Constraints", `schema.unique` "unique", `schema.materialized` "materialized".

- [x] **Step 1: test를 쓴다**

`schemaRows.test.ts`:
- `collapsed_schema_hides_its_children`, `empty_groups_are_left_out`(뷰가 없는 schema는 Views group이 없음), `a_schema_without_relations_shows_empty`.
- `columns_follow_the_relation`(depth 4, 순서는 catalog 그대로).
- `details_rows_follow_their_status`: 펼친 Indexes가 details 없음/`loading` → `loading` 줄, `failed` → `failed` 줄(error), `ready`인데 비었으면 `empty`.

`SchemaView.test.tsx`(Sidebar A, B):
- `shows_no_connection_and_choose_button`: 활성 탭에 접속이 없으면 `No connection in this tab`과 button, 누르면 `onChooseConnection`.
- `header_shows_the_connection`: dot, 접속 이름, database(mono), Refresh 버튼이 `refresh(접속)`.
- `loading_before_the_first_catalog`, `failed_shows_the_error_and_retry`(Retry가 `ensure`).
- `rows_render_like_the_canvas`: 컬럼 줄의 icon `PK`/`c`, 오른쪽 type, padding-left `8 + depth * 14`px, group 이름은 fg-2.
- `expanding_indexes_loads_details`: Indexes를 누르면 `toggle`과 `loadDetails(접속, oid)`.
- `index_and_constraint_titles_show_the_definition`, `materialized_views_are_labeled`.

`Sidebar.test.tsx`: `schema_segment_switches_the_view`(Files ↔ Schema, History는 계속 disabled). `Toolbar.test.tsx`: `connection_menu_open_is_controlled`.

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/schema src/features/project src/features/workspace/Toolbar.test.tsx`
Expected: FAIL

- [x] **Step 3: 구현한다**

- `docs/design/canvas/Sidebar.dc.html`의 A, B를 따른다: 머리 줄(`.ctx`: dot 8px, 이름 weight 500, database mono 12px fg-2, Refresh 22px icon button), 줄(`.tr`: 높이 24px, text-small, chevron 11px, icon mono 11px fg-3 너비 14px, 오른쪽 mono label fg-3), 고른 줄 `bg-accent/14`, loading 줄은 `SpinnerIcon`과 `schema.loading`. failed 줄과 화면 전체의 실패는 `ErrorIcon`, fg-2 message, Retry 버튼이다.
- Files와 Schema의 전환은 `Sidebar`의 `useState`다. Schema일 때 SQL Files section 자리에 `SchemaView`를 그린다.
- 펼칠 수 있는 줄을 누르면 `toggle`하고, 펼친 Indexes와 Constraints는 `loadDetails`를 부른다. 고른 줄은 `SchemaView`의 state다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add src
git commit -m "feat: sidebar의 Schema 화면에 활성 탭 접속의 스키마 트리를 그림"
```

---

### Task 7: 트리 menu, Copy name, Select first rows

**Files:**
- Create: `src/shared/sql/{identifiers,identifiers.test}.ts`
- Modify: `src/shared/ui/{Menu,Menu.test}.tsx`, `src/features/schema/{SchemaView,SchemaView.test}.tsx`, `src/features/editor/{tabsStore,tabsStore.test}.ts`, `src/features/workspace/{commands,commands.test}.ts`, `src/shared/i18n/en.ts`

**Interfaces:**
- Consumes: Task 6의 `SchemaRow`, `Catalog.reservedWords`
- Produces:
  ```ts
  /** PostgreSQL quote_ident와 같다: ^[a-z_][a-z0-9_$]*$이고 reserved word가 아니면 그대로, 아니면 "로 감싸고 안의 "는 두 번. */
  export function quoteIdent(name: string, reservedWords: ReadonlySet<string>): string;
  export function reservedSet(catalog: Catalog): ReadonlySet<string>; // catalog별 memo
  // Menu: anchor 대신 마우스 위치
  interface MenuProps { anchor?: RefObject<HTMLElement | null>; at?: { x: number; y: number }; … }
  // tabsStore
  newTab(options?: { text?: string }): string;
  // workspace/commands.ts
  /** 활성 탭의 접속으로 새 탭을 열어 앞 500행을 조회한다. */
  export function selectFirstRows(relation: Relation, reservedWords: ReadonlySet<string>): Promise<void>;
  ```
- 문구: `schema.menu.label` "{name}", `schema.menu.selectFirstRows` "Select first rows", `schema.menu.doubleClick` "Double-click", `schema.menu.copyName` "Copy name", `schema.copied` "Copied {name}".

- [x] **Step 1: test를 쓴다**

- `identifiers.test.ts` `quote_ident_matches_postgres`: `users` → `users`, `Order Items` → `"Order Items"`, `user`(reserved) → `"user"`, `a"b` → `"a""b"`, `1abc` → `"1abc"`, `col$1` → `col$1`, `Users` → `"Users"`.
- `Menu.test.tsx` `opens_at_a_point`: `at={{ x: 40, y: 60 }}`이면 style의 left 40px, top 60px.
- `tabsStore.test.ts` `new_tab_can_start_with_text`: `newTab({ text: "SELECT 1" })`의 문서 text.
- `commands.test.ts` `select_first_rows_quotes_names`: 활성 탭 접속 `local`에서 `selectFirstRows({ schema: "public", name: "Order Items", … })` → 새 탭이 활성이고 접속 `local`, 모드 auto, text `SELECT * FROM public."Order Items" LIMIT 500`, 그 text로 `executeQuery`.
- `SchemaView.test.tsx`: `double_clicking_a_table_selects_first_rows`, `context_menu_of_a_table`(항목 Select first rows와 오른쪽 `Double-click`, Copy name), `context_menu_of_a_column_only_copies`, `copy_name_copies_the_quoted_name_and_toasts`(`copyText('"Order Items"')`, status `Copied "Order Items"`).

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/shared src/features/schema src/features/editor/tabsStore.test.ts src/features/workspace/commands.test.ts`
Expected: FAIL

- [x] **Step 3: 구현한다**

- `selectFirstRows`는 `newTab({ text })` 뒤 그 탭으로 `useRuns.getState().run(id, () => confirmed(id, requestFor(id, sql, { line: 1, column: 1 })))`을 부른다(`runAgain`과 같은 길).
- menu는 `onContextMenu`의 `clientX`, `clientY`로 연다. menu의 `aria-label`은 그 항목 이름이다. toast는 `useToast`이고 `Toast`를 Schema 화면의 `relative` 틀 안에 둔다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add src
git commit -m "feat: 트리 menu에서 이름을 복사하고 테이블의 앞 500행을 새 탭에서 조회함"
```

---

### Task 8: 자동완성 source

**Files:**
- Create: `src/features/editor/{completion,completion.test}.ts`
- Modify: `src/shared/i18n/en.ts`(`completion.view` "view" — 뷰 detail `public · view`)

**Interfaces:**
- Consumes: Task 4의 `Catalog`, Task 7의 `quoteIdent`, `reservedSet`
- Produces:
  ```ts
  export const setCatalog: StateEffectType<Catalog | null>;
  /** 문서의 catalog와 그것으로 만든 source. 없으면 null이다. */
  export const catalogField: StateField<{ catalog: Catalog; sources: readonly CompletionSource[] } | null>;
  /** 한 catalog의 source는 한 번만 만든다(WeakMap). */
  export function catalogSources(catalog: Catalog): readonly CompletionSource[];
  /** keyword(대문자)와 문서 catalog의 source를 합친다. autocompletion의 override에 넣는다. */
  export function sqlCompletionSources(): readonly CompletionSource[];
  /** popup의 kind 글자: schema s, column c, table·view·alias t, function f, keyword·type k */
  export function kindLetter(completion: Completion): string;
  ```
- `catalogSources`가 만드는 것:
  - `schemaCompletionSource({ dialect: PostgreSQL, schema, defaultSchema: catalog.searchPath[0] })`. `schema`는 `{ [schema]: { self: { label, type: "schema" }, children: { [table]: { self: { label, type: "table", detail }, children: Completion[] } } } }`이고 label이 `quoteIdent`와 다르면 `apply`에 quoted 이름을 둔다. 컬럼 completion은 `{ label, type: "column", detail: \`${table} · ${type}\` }`.
  - 별칭 없는 컬럼: 커서가 `.` 뒤가 아니면, 그 문장(lezer `Statement`)에서 `FROM`, `JOIN`, `UPDATE`, `INTO` 뒤의 이름(schema가 붙을 수 있음)을 모아 그 테이블들의 컬럼을 준다. 이름만 쓴 테이블은 `searchPath`의 앞 schema부터 찾는다. `validFor: /^\w*$/`.
  - 함수: 커서가 `.` 뒤가 아니면 이름 중복 없이 `{ label, type: "function", detail: schema }`. 같은 이름이 여러 schema에 있으면 `searchPath`에 있는 schema, 그다음 `pg_catalog`의 것을 detail로 쓴다.

- [x] **Step 1: test를 쓴다**

fixture catalog: `public.users(id int8 pk, email text, email_verified_at timestamptz)`, `public.orders(id int8, user_id int8)`, `billing.invoices(id int8, amount numeric)`, `public."Order Items"(id int8)`, 함수 `pg_catalog.date_trunc`, `public.add_one`, `searchPath ["public"]`. `EditorState.create({ doc, extensions: [sql({ dialect: PostgreSQL }), catalogField] })`에 `setCatalog`를 dispatch하고, `ensureSyntaxTree` 뒤 각 source를 `new CompletionContext(state, pos, explicit)`로 부른 결과의 label을 합쳐 본다.

- `aliased_columns_come_from_the_aliased_table`: `SELECT u.em| FROM users u JOIN orders o ON o.user_id = u.id` → `email`, `email_verified_at`, detail `users · text`. `o.|` → `id`, `user_id`.
- `unqualified_columns_come_from_tables_in_the_statement`: `SELECT em| FROM users` → `email`. `UPDATE users SET em|` → `email`. explicit `SELECT | FROM users u JOIN billing.invoices i` → `email`과 `amount`가 있다.
- `columns_of_other_statements_are_not_offered`: `SELECT 1 FROM orders;\nSELECT us| FROM users` → `user_id`가 없다.
- `tables_need_no_default_schema_prefix`: `SELECT * FROM us|` → `users`(type table, detail `public`). `SELECT * FROM billing.|` → `invoices`. `SELECT * FROM Ord|` → `Order Items`의 apply `"Order Items"`.
- `functions_and_keywords`: `SELECT date_t|` → `date_trunc`(detail `pg_catalog`). `SEL|` → `SELECT`.
- `without_a_catalog_only_keywords_come`: catalog를 넣지 않은 문서의 `SELECT * FROM us|` → keyword만.
- `sources_are_built_once_per_catalog`: `catalogSources(c) === catalogSources(c)`. `setCatalog`를 같은 값으로 두 번 dispatch해도 field의 `sources`가 같다.
- `kind_letters`: 위 kind 표.

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/editor/completion.test.ts`
Expected: FAIL

- [x] **Step 3: 구현한다** — keyword source는 `keywordCompletionSource(PostgreSQL, true)`다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm vitest run src/features/editor`
Expected: PASS

- [x] **Step 5: commit**

```bash
git add src
git commit -m "feat: catalog로 스키마, 테이블, 별칭과 별칭 없는 컬럼, 함수, keyword를 자동완성하는 source"
```

---

### Task 9: 에디터의 자동완성

**Files:**
- Modify: `src/features/editor/{extensions,extensions.test,SqlEditor,SqlEditor.test}.ts(x)`, `src/features/editor/completion.test.ts`, `src/features/workspace/Workspace.tsx`, `src/shared/i18n/en.ts`

**Interfaces:**
- Consumes: Task 8의 `catalogField`, `setCatalog`, `sqlCompletionSources`, `kindLetter`, Task 5의 `useSchema`
- Produces: `SqlEditor`의 새 prop `catalog: Catalog | null`. `Workspace`가 활성 탭 접속의 `entries[conn]?.catalog ?? null`을 넘긴다. 문구: `completion.insert` "Insert", `completion.close` "Close", `completion.legend` "s schema · c column · t table · f function · k keyword".

- [x] **Step 1: test를 쓴다**

- `extensions.test.ts` `autocompletion_is_on_without_typing_delay`: `editorExtensions()`로 만든 state의 `completionConfig`(state facet)에서 `activateOnTypingDelay === 0`, `icons === false`.
- `SqlEditor.test.tsx`:
  - `the_catalog_reaches_the_document`: `catalog` prop을 주고 render → 그 탭 문서의 `catalogField` 값의 `catalog`가 그것. 다른 탭으로 바꾸면 그 탭 문서에도 들어간다.
  - `popup_has_kind_letters_and_footer`: `users` catalog로 `SELECT u.em` 끝에 커서를 두고 `startCompletion(view)` → `.cm-tooltip-autocomplete`에 `c`, `email`, `users · text`와 footer의 `Insert`, `Close`, legend가 있다.
- `completion.test.ts` `completes_within_50ms_on_a_large_catalog`: schema 3개, 테이블 5,000개, 테이블마다 컬럼 20개. `catalogSources`를 한 번 만든 뒤(이 시간은 재지 않는다), `SELECT t.| FROM s1.t4999 t`, `SELECT c1| FROM s2.t10`, `SELECT * FROM t49|` 세 context에서 모든 source를 부르는 시간이 각각 `performance.now()`로 50ms 미만.

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/editor`
Expected: FAIL

- [x] **Step 3: 구현한다**

- `extensions.ts`: `catalogField`와 `autocompletion({ override: [...sqlCompletionSources()], activateOnTypingDelay: 0, icons: false, addToOptions: [{ render: kind 글자 span, position: 20 }] })`를 더한다. 주석 "자동 완성은 넣지 않는다"를 지운다.
- popup 모양은 `Tools.dc.html`의 `.pop`, `.ac`를 따른다: 너비 340px, padding 4px, `bg-3`, border `line-2`, radius 8px, `shadow-popover`, 줄 높이 26px, radius 5px, text-small, 고른 줄 `accent` 16%, kind 글자 너비 16px 11px fg-3, detail은 오른쪽 끝 12px fg-2, 맞은 글자(`.cm-completionMatchedText`)는 굵게 밑줄 없이.
- footer는 ViewPlugin이 popup이 열려 있을 때(`completionStatus(state) === "active"`) `.cm-tooltip-autocomplete` 끝에 한 번 붙인다: `↵ Insert`, `esc Close`, 오른쪽 legend(12px fg-2, 위 border `line-2`).
- `SqlEditor`: `catalog`나 `tabId`가 바뀌면 `view.dispatch({ effects: setCatalog.of(catalog) })`. 탭을 바꿀 때는 `setState` 뒤에 넣는다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add src
git commit -m "feat: 에디터에서 입력하면 바로 스키마 자동완성 popup을 띄움"
```

---

### Task 10: 정리와 code review

CLAUDE.md 개발 순서 3~5다.

- [x] **Step 1:** `simplify`로 M7에서 바꾼 코드를 정리하고 `pnpm check`를 통과시킨 뒤 commit한다(`chore:`).
- [x] **Step 2:** `code-review`를 high로 돌린다.
- [x] **Step 3:** 지적마다 `superpowers:receiving-code-review`로 다시 검토해 맞는 것만 고친다. 고친 것은 `pnpm check` 뒤 commit(`fix:`)하고, 고치지 않은 지적과 이유는 작업 로그에 남긴다.

---

### Task 11: 완료 확인 — 앱에서 보기

**Files:**
- Modify: `docs/progress.md`, `docs/plans/M7-schema-autocomplete.md`(체크)

앱을 띄우기 전에 사용자에게 해도 되는지 묻는다. 방법은 진행상황 "지금"의 "앱 동작 확인 방법"이다. test DB(54318)에 `CREATE SCHEMA m7_check`의 테이블 몇 개를 만들어 쓰고 끝나면 지운다.

- [ ] **Step 1: local test DB로 화면을 본다** (`scripts/build-app.sh --debug`)

| 확인 | 기준 |
| --- | --- |
| 접속이 있는 탭에서 Schema | Sidebar A의 모양. `public`과 Tables가 펼쳐져 있고 `big_table`의 컬럼에 `PK id bigint` |
| 접속이 없는 탭 | Sidebar B의 `No connection in this tab`. Choose connection이 toolbar의 접속 menu를 엶 |
| Indexes, Constraints 펼치기 | 처음에 Loading, 그 뒤 `big_table_pkey` |
| `big_table` 더블클릭 | 새 탭에 `SELECT * FROM public.big_table LIMIT 500`, 결과 500행 |
| menu의 Copy name | toast, 붙여 넣으면 이름 |
| 다른 탭에서 `CREATE TABLE m7_check.t1 (a int)` 뒤 Refresh | 트리에 `m7_check.t1`, 에디터에서 `SELECT * FROM m7_check.` 뒤에 `t1` |
| `SELECT u.` 뒤에 `FROM m7_check.t1 u`가 있는 문장에서 `u.` 입력 | 입력하자 popup에 `a`(Tools M7 모양: kind 글자, detail, footer) |
| 접속이 다른 탭으로 바꾸기 | 트리와 자동완성이 그 접속의 것 |
| 그 접속의 탭을 모두 닫기 | catalog connection이 닫힘(`pg_stat_activity`에 그 앱의 연결이 남지 않음) |

자동완성 0.05초는 Task 9의 test로 확인하고, 앱에서는 입력 뒤 popup이 늦게 뜨지 않는지 본다.

- [ ] **Step 2: 기록하고 commit한다**

- 진행상황: M7을 `완료`(날짜), 작업 로그에 Task별 결과와 Step 1의 결과, "지금"의 다음 할 일(M8)을 쓴다.
- 이 계획의 체크박스를 모두 체크한다.

Run: `pnpm check`
Expected: 통과

```bash
git add docs
git commit -m "docs: M7 완료 확인 결과를 기록함"
```
