# M9 쿼리 도구 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 쿼리 기록(자동 저장, 검색, 에디터로 불러오기), `:id` 파라미터, EXPLAIN ANALYZE tree, 테이블 DDL 보기를 만든다. 완료 기준은 "어제 실행한 쿼리를 검색해 다시 실행", "`:id`가 있는 쿼리를 값을 넣어 실행"이다.

**Architecture:** Rust는 세 가지를 새로 한다. (1) 앱 내부 저장소(SQLite)에 `query_history` table을 더하고(schema 판 2) 기록과 검색을 맡는다. 기록은 화면이 실행의 첫 응답을 받을 때 부른다. (2) `pg_query::scan`의 token으로 문장 안의 `:name` 파라미터 위치를 찾는다. (3) catalog connection이 relation 하나의 DDL 재료를 읽고 `domain`의 순수 함수가 생성문 text로 조립한다. 나머지는 화면 일이다. 파라미터 값은 화면이 SQL text에 그대로 넣고, 보낸 text와 문서 text 사이의 offset 대응(`Rewrite`)을 실행에 붙여 오류 밑줄과 Go to error가 문서 자리를 가리키게 한다. EXPLAIN은 서버의 text 출력을 화면이 parse해 tree로 그린다. DDL은 결과 panel에 그린다.

**Tech Stack:** M8의 stack 그대로. 새 package와 crate는 없다(`@lezer/highlight`의 `highlightCode`, `tagHighlighter`는 이미 있는 package다).

**Spec:** [기획서](../spec.md) 4.5(파라미터, 실행 계획), 4.7(빠른 조회 menu, DDL 보기), 4.9(쿼리 기록), 5장(앱 내부 저장소), 7장(쿼리 기록 평문), 9장 / [마일스톤](../milestones.md) M9 / [디자인](../design/README.md)의 `Tools`(M9 파라미터, EXPLAIN ANALYZE, DDL 보기), `Sidebar`(A의 트리 항목 menu, C 기록), `Main`(toolbar의 Explain 버튼), `Tokens` / [구조](../architecture.md)

## 먼저 확인한 것 (계획 작성 중 확인)

| 확인한 것 | 결과 | 결정 |
| --- | --- | --- |
| `:id`와 `::`를 scanner token으로 구분(마일스톤 "먼저 확인할 것") | `pg_query` 18.1.0 `scan`: `:id` → `Ascii58 ":"` + `Ident "id"`(두 token이 붙어 있음). `::date` → `Typecast`. `:=` → `ColonEquals`. `:user` → `Ascii58` + `User`(keyword_kind `ReservedKeyword`). `:"q"` → `Ascii58` + `Ident "\"q\""`. `:'s'` → `Ascii58` + `Sconst`. `$1` → `Param`. `':no'`는 `Sconst`, `-- :c`는 `SqlComment`. **`a[lo:hi]`는 `Ascii91` `Ident` `Ascii58` `Ident` `Ascii93`으로 `:id`와 모양이 같다** | 파라미터는 `[ ]` 밖의 `Ascii58` 바로 뒤에(사이에 공백 없이) 붙은 `Ident`(따옴표로 시작하지 않는 것) 또는 keyword token이다. 이름은 그 token의 원문(`:userId`면 `userId`, 대소문자 구분)이다. `:"q"`, `:'s'`(psql 변수 문법)는 파라미터로 보지 않는다 |
| DDL을 catalog로 조립할 범위(마일스톤 "먼저 확인할 것") | test DB(PostgreSQL 18.6). `GENERATED ALWAYS AS IDENTITY`, `NOT NULL`, `CHECK`, `PRIMARY KEY`, `GENERATED ALWAYS AS (n*2) STORED`로 만든 테이블에서 `pg_constraint`는 `users_email_not_null`·`users_id_not_null`(contype `n`, `NOT NULL email`), `users_n_check`(`c`), `users_pkey`(`p`)를 준다. **PostgreSQL 18은 NOT NULL을 contype `n`의 제약으로도 둔다.** `pg_attribute`: `attidentity` `a`, `attgenerated` `s`, `pg_get_expr(adbin)` `(n * 2)` | 컬럼(type, COLLATE, identity, generated, NOT NULL, DEFAULT), 제약(contype `p` `u` `f` `c` `x`, `n`은 컬럼의 NOT NULL로만), UNLOGGED, INHERITS, PARTITION BY, PARTITION OF, `WITH (reloptions)`, 제약이 만들지 않은 인덱스, 내부가 아닌 trigger, 테이블과 컬럼 comment. view와 materialized view는 `pg_get_viewdef`. 넣지 않는 것: owner, GRANT, RLS policy, tablespace, statistics, rule, publication, identity의 sequence option, foreign table(menu에 Show DDL이 없다) |
| EXPLAIN ANALYZE의 text 출력(PostgreSQL 18.6) | 컬럼 하나 `QUERY PLAN`(text). 뿌리 node는 `Sort  (cost=425.26..425.38 rows=50 width=261) (actual time=0.113..0.115 rows=50.00 loops=1)`, 자식은 `->  `로 시작하고 들여쓰기가 깊어진다. **18은 actual rows를 `50.00`처럼 소수로 주고 ANALYZE에 BUFFERS를 기본으로 붙인다.** node 사이에 `Sort Key:`, `Buffers:`, `Index Cond:` 같은 detail 줄, 끝에 `Planning:` 블록, `Planning Time: 1.058 ms`, `Execution Time: 0.124 ms` | 화면이 text 출력을 parse한다(사용자 SQL에 `FORMAT JSON`을 붙이지 않는다. 원문 보기가 서버 출력 그대로다). node 줄이 하나도 없으면(`FORMAT JSON` 등) 보통 결과 표다 |

## 이 계획에서 정한 것

기획서에 없거나 다르게 정한 것이다. Task 1에서 진행상황의 결정 기록에 옮기고, 기획서와 마일스톤도 고친다.

- **쿼리 기록의 저장.** 앱 내부 저장소의 `query_history(id INTEGER PRIMARY KEY, project_dir TEXT NOT NULL, connection TEXT NOT NULL, sql TEXT NOT NULL, executed_at INTEGER NOT NULL, elapsed_micros INTEGER NOT NULL)`와 index `(project_dir, id)`. schema 판은 `PRAGMA user_version = 2`(1인 파일은 table만 더해 올린다). 프로젝트마다 따로 두고 최근 10,000개만 남긴다(기록할 때 그보다 오래된 것을 지운다). `executed_at`은 실행을 시작한 Unix ms다.
- **언제 기록하는가.** 화면이 실행 하나(여러 문장이면 문장 하나)의 첫 `rows` event나 `discarded`가 아닌 `finished` event를 받을 때 한 번 기록한다. 오류로 끝난 문장도 기록한다. 세션을 열지 못했거나 위험 쿼리 확인에서 그만둔 실행은 서버에 가지 않았으므로 기록하지 않는다. 기록하는 text는 서버에 보낸 text(파라미터 값과 `EXPLAIN ANALYZE`가 들어간 것)다. 소요 시간은 그 event의 `elapsedMicros`다. 기록하지 못해도(저장소가 없음, 프로젝트가 바뀜) 실행에는 영향이 없다.
- **검색(Sidebar C).** 검색어를 공백으로 나눈 단어가 모두 SQL text에 들어 있는 기록을 최근 것부터 200개. 영문 대소문자는 구분하지 않고 `%`, `_`, `\`는 글자 그대로 찾는다. 입력 뒤 150ms 동안 입력이 없으면 찾는다. 날짜 묶음 label은 `Today`, `Yesterday`, 그 밖에는 최근 프로젝트와 같은 `Nov 9`다. 항목은 SQL(mono 13, 두 줄까지, 넘치면 `…`)과 `● {접속} · {HH:mm} · {소요 시간}`(12px fg-2, dot은 지금 프로젝트에 그 접속이 있을 때 그 접속 색, 없으면 dot 없음). 고른 항목은 `accent/14` 배경. 아래 줄은 `↵ Open in editor`.
- **에디터로 불러오기.** 항목을 두 번 누르거나 고른 채 `Enter`를 누르면 그 SQL로 새 탭을 열고 기록의 접속이 지금 프로젝트에 있으면 그 접속을 고른다(없으면 새 탭의 기본 접속). 실행하지는 않는다. 검색 칸에서 `↑`/`↓`가 고른 항목을 옮긴다. 목록을 새로 읽으면 첫 항목을 고른다.
- **파라미터(기획서 9장 "파라미터 값을 SQL text에 그대로 넣을지").** 넣는다. 값은 SQL로 그대로 들어가고 문자열은 사용자가 따옴표를 쓴다(Tools M9의 안내 문구). simple query protocol에는 bind가 없다(M2 결정).
- **파라미터 dialog(Tools M9).** 실행(문장, 선택 영역, 파일, Explain)할 문장에 파라미터가 있으면 보내기 전에 에디터 오른쪽 아래(right 16px, bottom 16px)에 330px dialog `Parameter values`를 띄운다. 이름마다 한 줄(`:name` mono 13, 64px | input), 여러 문장이면 처음 나온 순서로 한 번씩 묻는다. 안내 `Values are inserted as SQL. Quote strings. ::date is a cast, not a parameter.`, 버튼 Cancel과 `Run ⌘↵`. 값이 빈 칸이 있으면 Run을 누를 수 없다. `Enter`와 `Cmd+Enter`는 Run, `Esc`는 Cancel(실행하지 않는다). 떠 있는 동안 문서의 `:name`에 `accent/16` 배경을 칠하고 다른 단축키는 동작하지 않는다. 값은 탭마다 이름별로 기억해 다음 dialog에 채운다(프로젝트를 바꾸면 잊는다). 위험 쿼리 확인과 기록은 값을 넣은 text를 본다. Run again과 터널 오류의 Try again은 같은 값으로 다시 보낸다(묻지 않는다).
- **보낸 text와 문서의 offset(`Rewrite`).** 값을 넣거나 `EXPLAIN ANALYZE `를 앞에 붙인 실행은 문서의 문장 text(`source`)와 바꾼 자리 목록을 갖는다. 서버 오류의 position은 이것으로 문서 자리로 옮긴 뒤 밑줄, Ln/Col, Go to error에 쓴다. 넣은 값 안이나 붙인 앞부분 안의 position은 그 `:name`(또는 문장 처음)을 가리킨다.
- **EXPLAIN 보기(Tools M9).** 결과가 컬럼 하나 `QUERY PLAN`이고 `completed`이고 앞 행을 버리지 않았고 node 줄이 있으면 결과 표 대신 tree를 그린다. header는 `EXPLAIN` 탭, `Execution {t} · Planning {t}`(mono, 없는 값은 뺀다), 오른쪽 `Show raw`(누르면 서버 text를 mono pre로 보이고 버튼은 `Show tree`). 표는 `Node | Actual time | Rows (est → actual) | Loops`(grid `minmax(0,1fr) 90px 120px 60px`, 줄 28px, mono 13, 들여쓰기 `10 + 깊이 × 16`px). Actual time은 node가 자식까지 포함해 쓴 시간(`actual time` 끝 값 × loops), 가장 오래 걸린 node는 자기 시간(자기 total − 자식 total 합, 0 미만이면 0)이 가장 큰 node이고 weight 600과 `bg-0` 배경이다. ANALYZE가 없으면 time과 loops가 비고 rows는 추정값만, 강조가 없다. `never executed` node는 time 칸에 fg-3 `never executed`. 받는 중인 `QUERY PLAN` 결과는 끝까지 이어서 가져온다(500행을 넘는 plan).
- **Explain 버튼(Main toolbar).** Reformat 옆 icon 버튼 `Explain plan (EXPLAIN ANALYZE)`. 실행 버튼과 같은 문장(커서 문장 또는 선택 영역)을 `EXPLAIN ANALYZE `를 붙여 실행한다. 문장이 둘 이상이면 실행하지 않고 `Explain runs one statement. Select a single statement.`를 결과 panel에 보인다. 이미 `EXPLAIN`으로 시작하는 문장은 그대로 보낸다. 단축키는 없다(DataGrip에도 기본 키가 없다). 위험 쿼리 확인은 M6대로 `EXPLAIN ANALYZE`의 안쪽 문장을 본다.
- **DDL 보기(Tools M9, Sidebar A).** 스키마 트리의 테이블, partitioned table, view, materialized view menu에 `Show DDL`(Select first rows와 Copy name 사이). 활성 탭의 결과 panel에 `DDL {name}` 탭과 Copy(ghost), Open in new tab, Close를 그리고 본문은 에디터 syntax 색을 칠한 mono 13 pre(line-height 1.6, `bg-0`)다. 읽는 동안 `Loading DDL…`, 실패하면 오류 message. Copy는 toast `Copied DDL`, Open in new tab은 그 text로 같은 접속의 새 탭. **Close는 캔버스에 없지만 더한다**(지난 결과로 돌아갈 방법이 다시 실행뿐이면 받다 만 결과를 잃는다). 그 탭의 다음 실행이나 탭 닫기가 DDL을 지운다. DDL을 보는 동안에도 실행 중인 쿼리는 그대로 받는다.
- **DDL 형식.** `CREATE [UNLOGGED] TABLE schema.name (` 컬럼 줄(2칸 들여쓰기, 이름을 가장 긴 이름 + 1칸으로 맞춤)과 `CONSTRAINT name def` 줄, `)` 뒤 `INHERITS (…)`, `PARTITION BY …`, `WITH (…)`, `;`. 컬럼 줄은 `name type [COLLATE c] [GENERATED ALWAYS|BY DEFAULT AS IDENTITY] [GENERATED ALWAYS AS (expr) STORED|VIRTUAL] [NOT NULL] [DEFAULT expr]`이고 NOT NULL은 identity 컬럼과 primary key 컬럼에는 쓰지 않는다(Tools M9 예시). partition은 `CREATE TABLE schema.name PARTITION OF parent\n  FOR VALUES …;`(컬럼과 상속한 제약을 쓰지 않는다). 그 뒤 줄마다 인덱스(`pg_get_indexdef;`), trigger(`pg_get_triggerdef;`), `COMMENT ON TABLE …`, `COMMENT ON COLUMN …`. 이름은 모두 schema를 붙이고 `quote_ident`로 감싼다. 제약 순서는 p, u, f, c, x, 그 안에서 이름 순.

## Global Constraints

- 의존 방향: `infrastructure` → `application` → `domain`(`tests/layer_deps.rs`). `pg_query`, `rusqlite`, `tokio-postgres`는 `infrastructure`에만 둔다. `chilla-core`는 `tauri`에 의존하지 않는다.
- `@tauri-apps/*`는 `src/shared/api/`에서만 import한다.
- 화면 문구는 `src/shared/i18n/en.ts`와 `ko.ts`에 함께 더한다(`ko`의 type이 빠진 key를 잡는다). PostgreSQL 오류, SQL, plan text, DDL, 결과 data, 접속 이름은 번역하지 않는다. 새 Rust 오류 kind는 `errorKinds.json`과 `error.<kind>` 문구에 더한다.
- 색, 그림자, 글자 크기는 `src/index.css`의 token으로만 쓴다. DDL 색은 에디터 syntax token(`text-syntax-*`)을 다시 쓴다.
- 상수: 기록 보관 프로젝트당 10,000개, 검색 결과 200개, 검색 debounce 150ms, schema 판 2, 파라미터 dialog 330px, plan 들여쓰기 16px.
- offset: Rust의 span은 byte, 화면에 넘길 때 UTF-16(M2의 `utf16_spans`와 같은 변환).
- commit 전에 `pnpm check`를 통과시킨다. commit message는 `feat:`/`fix:`/`docs:`/`chore:`/`test:` 뒤에 한국어 한 줄이다.
- `docs/`는 평서체, 기술 용어는 영어, 날짜는 `YYYY-MM-DD`, 단축키는 `Cmd+Enter`처럼 글자로 쓴다.

## Review Focus

test가 없으면 사용자가 가장 먼저 부딪힐 입력과 상황이다. 각 줄의 test는 해당 Task에 넣었다.

1. **문자열 값에 따옴표를 빠뜨림**(`:name`에 `kim`): 서버 오류 위치가 넣은 값 안을 가리켜도 밑줄은 문서의 `:name`에 → Task 5 `position_inside_a_value_points_at_the_parameter`.
2. **배열 slice와 cast가 섞인 문장**(`a[lo:hi]`, `x::date`, `'a:b'`, `-- :c`, `:=` in `DO $$ … $$`): 파라미터 dialog가 뜨지 않아야 한다 → Task 4 `slices_casts_strings_and_comments_are_not_parameters`.
3. **PostgreSQL 18의 EXPLAIN ANALYZE**(BUFFERS 기본, `rows=50.00`, `Planning:` 블록, `never executed`, `InitPlan`): tree가 깨지거나 강조가 엉뚱한 node로 가지 않아야 한다 → Task 7 `parses_postgres_18_analyze_output`, `subplans_attach_to_their_parent`.
4. **PostgreSQL 18의 NOT NULL 제약, identity, generated, partition이 있는 테이블의 DDL**: NOT NULL이 두 번 나오지 않고 그대로 실행된다 → Task 9 `ddl_round_trips`.
5. **검색어에 `_`나 `%`**(`user_id`): 아무 글자나 맞추지 않는다 → Task 2 `percent_and_underscore_match_literally`.

---

## File Structure

| 파일 | 할 일 |
| --- | --- |
| `crates/chilla-core/src/application/ports.rs` | `HistoryEntry`, `NewHistoryEntry`, `AppStore`의 기록 method, `StatementSplitter::parameters`, `DbConnection::read_ddl` |
| `crates/chilla-core/src/domain/statement.rs` | `ParameterSpan` |
| `crates/chilla-core/src/domain/ddl.rs` (새) | `RelationDdl`과 `render_ddl` |
| `crates/chilla-core/src/infrastructure/sqlite_store.rs` | schema 판 2, 기록과 검색 |
| `crates/chilla-core/src/infrastructure/statement_splitter.rs` | 파라미터 찾기 |
| `crates/chilla-core/src/infrastructure/postgres/{catalog,mod}.rs` | DDL 재료를 읽는 SQL |
| `crates/chilla-core/src/application/app.rs` | `record_query`, `search_history`, `find_parameters`, `load_ddl` |
| `crates/chilla-core/src/application/test_support/*` | fake의 새 method |
| `crates/chilla-core/tests/{app_store,statements}.rs`, `tests/ddl.rs` (새) | Rust test |
| `src-tauri/src/{commands,error,lib}.rs` | command, DTO, 오류 kind |
| `src/shared/api/{types,commands}.ts`, `src/shared/i18n/{en,ko}.ts`, `errorKinds.json` | 호출과 문구 |
| `src/features/history/{historyStore,when}.ts`, `HistoryView.tsx` (새) | 기록 목록, 검색, 불러오기 |
| `src/features/project/Sidebar.tsx` | History 탭 켜기 |
| `src/features/query/rewrite.ts` (새) | `Rewrite`, 값 넣기, 앞에 붙이기, offset 대응 |
| `src/features/query/{runReducer,runsStore,format}.ts` | `rewrite` 전달, 기록 호출, DDL 지우기 |
| `src/features/query/{explainPlan.ts,ExplainView.tsx}` (새) | plan parse와 tree |
| `src/features/query/{ddlStore.ts,DdlView.tsx}` (새) | DDL 상태와 화면 |
| `src/features/query/ResultPane.tsx` | EXPLAIN과 DDL을 그림 |
| `src/features/editor/{runAnchors,extensions}.ts`, `parameterMarks.ts`, `highlightSql.ts` (새) | 오류 위치 대응, `:name` 칠하기, DDL 색 |
| `src/features/workspace/{commands,shortcuts}.ts`, `{parameterPrompt.ts,ParameterPrompt.tsx}` (새), `Toolbar.tsx`, `Workspace.tsx` | 파라미터 묻기, Explain 명령과 버튼 |
| `src/features/schema/SchemaView.tsx` | Show DDL menu |
| `src/shared/ui/icons.tsx` | `ExplainIcon`, `SearchIcon` |

---

### Task 1: 먼저 확인한 것과 결정 기록

**Files:**
- Modify: `docs/progress.md`, `docs/spec.md`, `docs/milestones.md`

- [x] **Step 1: branch를 만든다**

```bash
git switch -c m9-query-tools
```

- [x] **Step 2: 문서를 고친다**

- 진행상황: M9를 `진행 중`(시작 날짜, 계획 링크), "지금"을 M9 Task 2로. 결정 기록에 "먼저 확인한 것"의 결정 세 줄과 "이 계획에서 정한 것"의 줄마다 한 줄(날짜, M9). M4의 "Explain(M9)은 넣지 않음", "History(M9)는 disabled" 줄은 그대로 두고 새 줄이 대신한다고 쓴다.
- 기획서: 4.5 파라미터(값을 SQL text로 넣음, dialog, `[ ]` 밖의 `:name`), 실행 계획(toolbar Explain, text 출력 parse, 자기 시간으로 강조, 원문 보기), 4.7 DDL 보기(범위와 넣지 않는 것, 결과 panel, Close), 4.9(프로젝트별, 최근 10,000개, 보낸 text, 첫 응답에 기록, 단어 검색, 새 탭에 불러오기), 5장 앱 내부 저장소(쿼리 기록 table), 9장에서 "파라미터 값을 SQL text에 그대로 넣을지(M9)"를 지운다. 마지막 수정 날짜.
- 마일스톤 M9 "먼저 확인할 것" 둘에 `→ 정함:`으로 결과를 적는다.

- [x] **Step 3: commit**

```bash
git add docs
git commit -m "docs: M9 계획과 파라미터, DDL 범위, EXPLAIN parse 결정을 기록함"
```

---

### Task 2: 쿼리 기록 저장소 (Rust)

**Files:**
- Modify: `crates/chilla-core/src/application/{ports,app}.rs`, `crates/chilla-core/src/application/test_support/mod.rs`, `crates/chilla-core/src/infrastructure/sqlite_store.rs`, `crates/chilla-core/tests/app_store.rs`, `src-tauri/src/{commands,lib}.rs`, `src/shared/api/{types,commands}.ts`

**Interfaces:**
- Produces:
  ```rust
  pub struct NewHistoryEntry { pub connection: String, pub sql: String,
      /// Unix ms. 실행을 시작한 때
      pub executed_at: i64, pub elapsed_micros: i64 }
  pub struct HistoryEntry { pub id: i64, pub connection: String, pub sql: String,
      pub executed_at: i64, pub elapsed_micros: i64 }
  // AppStore에 더한다
  /// 그 프로젝트의 기록이 10,000개를 넘으면 오래된 것부터 지운다.
  fn record_query(&self, dir: &Path, entry: &NewHistoryEntry) -> Result<(), StoreError>;
  /// `words`가 모두 SQL에 든 기록, 최근 것(id 큰 것)부터 `limit`개. words가 비면 전부.
  fn search_history(&self, dir: &Path, words: &[String], limit: usize) -> Result<Vec<HistoryEntry>, StoreError>;
  // App
  pub async fn record_query(&self, dir: &Path, entry: NewHistoryEntry) -> Result<(), AppError>;
  pub async fn search_history(&self, dir: &Path, query: &str) -> Result<Vec<HistoryEntry>, AppError>; // split_whitespace, 200개
  ```
  둘 다 `dir`이 열린 프로젝트가 아니면 `ProjectChanged`(`save_workspace`와 같은 `open_project_dir`).
  ```ts
  interface HistoryEntry { id: number; connection: string; sql: string; executedAt: number; elapsedMicros: number }
  function recordQuery(dir: string, entry: Omit<HistoryEntry, "id">): Promise<void>;
  function searchHistory(dir: string, query: string): Promise<HistoryEntry[]>;
  ```

- [x] **Step 1: test를 쓴다**

`tests/app_store.rs`:
- `records_and_searches_newest_first`, `history_is_per_project`.
- `all_words_must_match`(`"users email"`은 둘 다 든 SQL만), `match_ignores_ascii_case`(`USERS`가 `select * from users`를 찾음).
- `percent_and_underscore_match_literally`: `user_id`로 찾으면 `userXid`가 든 SQL은 나오지 않고, `100%`로 찾으면 `100x`는 나오지 않는다.
- `keeps_the_latest_ten_thousand`: 10,001개 기록 뒤 그 프로젝트의 첫 기록이 없고 다른 프로젝트의 기록은 그대로다.
- `upgrades_a_version_1_file`: M8 schema(판 1)로 만든 파일에 최근 프로젝트를 넣고 연 뒤 그 값이 남아 있고 기록을 쓸 수 있으며 `user_version`이 2다.
- `a_newer_version_is_refused`(판 3).
- `app.rs` test: `history_needs_the_open_project`(다른 dir이면 `ProjectChanged`), `search_history_limits_to_200`.

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --workspace history`
Expected: FAIL (method 없음)

- [x] **Step 3: 구현한다**

- `migrate`: 0이면 세 table을 만들고 2로, 1이면 `query_history`와 index만 만들고 2로, 2면 그대로.
- 검색은 단어마다 `sql LIKE '%' || ?n || '%' ESCAPE '\'`를 AND로 묶는다. 단어의 `\`, `%`, `_` 앞에 `\`를 붙인다.
- 지우기: `DELETE FROM query_history WHERE project_dir = ?1 AND id <= (SELECT id FROM query_history WHERE project_dir = ?1 ORDER BY id DESC LIMIT 1 OFFSET 10000)`. 기록과 같은 transaction이다.
- command `record_query`, `search_history`. DTO는 camelCase.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add crates src-tauri src
git commit -m "feat: 앱 저장소에 프로젝트별 쿼리 기록을 두고 단어로 찾음"
```

---

### Task 3: 기록 화면 (History)

**Files:**
- Create: `src/features/history/historyStore.ts`, `src/features/history/when.ts`, `src/features/history/HistoryView.tsx`와 각 test
- Modify: `src/features/project/{Sidebar.tsx,recent.ts}`, `src/features/query/runsStore.ts`(와 test), `src/shared/i18n/{en,ko}.ts`, `src/shared/ui/icons.tsx`, `src/test/resetStores.ts`

**Interfaces:**
- Consumes: Task 2의 `recordQuery`, `searchHistory`, `HistoryEntry`.
- Produces:
  ```ts
  // historyStore.ts
  interface HistoryState {
    query: string;
    entries: HistoryEntry[];
    selected: number | null;           // entries index
    status: "idle" | "loading" | "ready" | "failed";
    error: string | null;              // messageOf
    setQuery(query: string): void;     // 150ms 뒤 load
    load(): Promise<void>;             // 늦게 온 답은 버린다(마지막 요청만)
    move(delta: 1 | -1): void;
    select(index: number): void;
    record(entry: Omit<HistoryEntry, "id">): Promise<void>; // 실패는 무시. 끝나면 view가 열려 있을 때 load
    reset(): void;                     // 프로젝트를 바꿀 때
  }
  // when.ts
  function dayLabel(at: number, now: number): string;   // Today | Yesterday | Nov 9
  function timeOfDay(at: number): string;                // "09:41"
  // HistoryView.tsx
  function openHistoryEntry(entry: HistoryEntry): void;  // 새 탭 + 접속
  ```
  문구 key: `history.search`(placeholder와 aria-label `Search history`), `history.openInEditor`(`Open in editor`), `history.empty`(`Queries you run appear here`), `history.noMatch`(`No queries match`).

- [x] **Step 1: test를 쓴다**

- `when.test.ts`: `labels_today_yesterday_and_dates`(자정 직전·직후 경계), `time_is_24_hour`.
- `historyStore.test.ts`: `search_waits_150ms`(fake timer로 149ms에는 안 부름), `a_stale_answer_is_dropped`, `selects_the_first_entry_after_load`, `move_stops_at_the_ends`, `record_failure_is_ignored`.
- `runsStore.test.ts`: `records_once_on_the_first_rows`(rows 두 번, finished 한 번에 `recordQuery` 한 번, `elapsedMicros`는 첫 rows의 값), `records_a_failed_statement`, `does_not_record_a_discarded_first_event`, `does_not_record_when_the_session_did_not_open`, `records_each_statement_of_a_script`.
- `HistoryView.test.tsx`: `groups_by_day`, `shows_connection_dot_only_for_known_connections`, `enter_opens_the_selected_entry_in_a_new_tab`(기록의 접속이 골라짐), `double_click_opens`, `unknown_connection_keeps_the_default`, `arrow_keys_move_selection_from_the_search_field`, `store_unavailable_shows_the_error`.
- `Sidebar.test.tsx`: History 탭이 눌리고 HistoryView를 그린다.

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/history src/features/query/runsStore.test.ts src/features/project/Sidebar.test.tsx`
Expected: FAIL

- [x] **Step 3: 구현한다**

- `runsStore`의 `sendStep` `onEvent`에서 실행마다 한 번 `useHistory.getState().record({ connection, sql: step.sql, executedAt: startedAt, elapsedMicros: event.elapsedMicros })`. 밀려난(fresh가 아닌) 실행도 기록한다.
- `record`와 `load`는 `useProject`의 열린 프로젝트 dir을 쓴다. 프로젝트가 없으면 아무것도 하지 않는다.
- `dayLabel`의 `Nov 9` 형식은 `recent.ts`의 `openedWhen`과 같은 함수를 쓰도록 뽑아 둘이 함께 쓴다.
- HistoryView는 Sidebar C를 따른다: 검색 칸(28px, 7px radius, `bg-0`, 돋보기 icon), 목록(day label은 sidebar의 section label 모양), footer `↵ Open in editor`. 목록은 view가 열릴 때 `load`한다. 프로젝트를 바꾸는 `switchProject`/`enterProject`가 `reset`한다.
- `openHistoryEntry`: `useTabs.newTab({ text: entry.sql })` 뒤 `project.connections`에 그 이름이 있으면 `setConnection`. 새 탭의 에디터에 focus.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add src
git commit -m "feat: 실행한 문장을 기록하고 History에서 찾아 새 탭으로 불러옴"
```

---

### Task 4: 파라미터 찾기 (Rust)

**Files:**
- Modify: `crates/chilla-core/src/domain/statement.rs`, `crates/chilla-core/src/application/{ports,app}.rs`, `crates/chilla-core/src/application/test_support/mod.rs`, `crates/chilla-core/src/infrastructure/statement_splitter.rs`, `crates/chilla-core/tests/statements.rs`, `src-tauri/src/commands.rs`, `src/shared/api/{types,commands}.ts`

**Interfaces:**
- Produces:
  ```rust
  /// `:name` 하나. byte offset이고 `start`는 `:`, `end`는 이름 끝(포함하지 않음).
  pub struct ParameterSpan { pub name: String, pub start: usize, pub end: usize }
  // StatementSplitter에 더한다
  /// 문장 안의 `:name`, start 오름차순. 나눌 수 없는 text면 SplitError.
  fn parameters(&self, sql: &str) -> Result<Vec<ParameterSpan>, SplitError>;
  // App
  pub fn find_parameters(&self, sql: &str) -> Result<Vec<ParameterSpan>, AppError>;
  ```
  ```ts
  interface ParameterSpan { name: string; start: number; end: number } // UTF-16
  function findParameters(sql: string): Promise<ParameterSpan[]>;
  ```

- [x] **Step 1: test를 쓴다**

`tests/statements.rs`:
- `finds_named_parameters`: `SELECT * FROM t WHERE id = :id AND d > :since::date` → `id`, `since`(span이 `:id`, `:since`).
- `slices_casts_strings_and_comments_are_not_parameters`: `SELECT a[1:2], a[lo:hi], x::date, ':no', $1 -- :c`와 `DO $$ BEGIN x := 1; END $$` → 없음.
- `keyword_names_are_parameters`: `:user`, `:limit` → `user`, `limit`.
- `psql_quoted_forms_are_not_parameters`: `:"q"`, `:'s'` → 없음.
- `space_after_colon_is_not_a_parameter`: `: id` → 없음.
- `keeps_case_and_repeats`: `:userId = :userId` → span 둘, 이름 `userId`.
- `parameter_inside_brackets_expression`: `a[:i]`는 slice라 없음(`[ ]` 안이라 보지 않는다).
- `unclosed_quote_is_an_error`.
- command 쪽: `parameter_spans_are_utf16`(`SELECT '한글', :id` → start 12).

- [x] **Step 2: 실패를 확인한다**

Run: `cargo test --workspace parameters`
Expected: FAIL

- [x] **Step 3: 구현한다**

`pg_query::scan`의 token을 차례로 보며 `Ascii91`/`Ascii93`로 bracket 깊이를 센다. 깊이 0의 `Ascii58` 다음 token이 `start == colon.end`이고 (`Ident`이며 원문이 `"`로 시작하지 않음) 또는 `keyword_kind() != NoKeyword`이면 span이다. 주석 token은 건너뛴다. command `find_parameters`는 `split_statements`처럼 UTF-16으로 바꾼다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add crates src-tauri src
git commit -m "feat: scanner token으로 문장 안의 :name 파라미터를 찾음"
```

---

### Task 5: 보낸 text와 문서 offset 대응 (`Rewrite`)

**Files:**
- Create: `src/features/query/rewrite.ts`, `src/features/query/rewrite.test.ts`
- Modify: `src/features/query/{runReducer,runsStore,format}.ts`, `src/features/editor/runAnchors.ts`, `src/features/workspace/commands.ts`와 그 test

**Interfaces:**
- Consumes: Task 4의 `ParameterSpan`.
- Produces:
  ```ts
  /** 보낸 text의 [sentFrom, sentTo)가 문서 문장 text의 [sourceFrom, sourceTo)를 대신한다. UTF-16 */
  interface SentEdit { sentFrom: number; sentTo: number; sourceFrom: number; sourceTo: number }
  /** sentFrom 오름차순, 겹치지 않음 */
  interface Rewrite { source: string; edits: SentEdit[] }
  function substitute(step: ScriptStep, spans: ParameterSpan[], values: Record<string, string>): ScriptStep;
  function prepend(step: ScriptStep, prefix: string): ScriptStep;
  /** 보낸 text의 offset을 문서 문장 text의 offset으로. edit 안이면 그 edit의 sourceFrom */
  function sourceOffset(rewrite: Rewrite | undefined, sent: number): number;
  function sourceText(step: { sql: string; rewrite?: Rewrite }): string;
  ```
  `ScriptStep`과 `ResultData`에 `rewrite?: Rewrite`(바꾼 것이 없으면 없다). `emptyResult`가 step에서 옮긴다.

- [x] **Step 1: test를 쓴다**

`rewrite.test.ts`:
- `substitutes_values_from_the_end`: `WHERE id = :id AND d > :since::date`, `{id: "10482", since: "'2026-11-01'"}` → `WHERE id = 10482 AND d > '2026-11-01'::date`.
- `position_after_a_value_maps_back`: 넣은 값 뒤의 offset이 문서의 같은 글자를 가리킨다.
- `position_inside_a_value_points_at_the_parameter`: 값 `kim` 안의 offset → `:name`의 `:`.
- `prepend_shifts_existing_edits`: `substitute` 뒤 `prepend("EXPLAIN ANALYZE ")`의 offset 대응이 둘 다 맞고 앞부분 안은 0.
- `no_rewrite_is_identity`.
- `format.test.ts`: `error_location_uses_the_source_text`(값에 줄바꿈이 있어도 Ln/Col이 문서 기준).
- `runsStore.test.ts`: `server_error_is_marked_at_the_source_offset`.
- `commands.test.ts`: `run_again_keeps_the_rewrite`(Run again이 같은 sql과 `rewrite`를 보낸다).

- [x] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/query src/features/workspace/commands.test.ts`
Expected: FAIL

- [x] **Step 3: 구현한다**

- 서버 오류의 position을 anchor에 더하는 자리는 모두 `sourceOffset(result.rewrite, position)`을 쓴다: `runsStore`의 `markServerError` 호출, `runAnchors.goToError`, `format.errorLocation`(`lineColumn(sourceText(result), …)`).
- `movedStep`과 `retryRun`이 `rewrite`를 그대로 옮긴다.

- [x] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [x] **Step 5: commit**

```bash
git add src
git commit -m "feat: 바꿔 보낸 text의 오류 위치를 문서 자리로 옮김"
```

---

### Task 6: 파라미터 dialog

**Files:**
- Create: `src/features/workspace/parameterPrompt.ts`, `src/features/workspace/ParameterPrompt.tsx`, `src/features/editor/parameterMarks.ts`와 각 test
- Modify: `src/features/workspace/{commands,shortcuts}.ts`, `src/features/workspace/Workspace.tsx`, `src/features/editor/extensions.ts`, `src/shared/i18n/{en,ko}.ts`

**Interfaces:**
- Consumes: Task 4의 `findParameters`, Task 5의 `substitute`.
- Produces:
  ```ts
  // parameterPrompt.ts
  interface ParameterRequest { tabId: string; names: string[]; values: Record<string, string> }
  const useParameterPrompt: { request: ParameterRequest | null };
  /** 값을 묻는다. Cancel이면 null. 이미 떠 있으면 앞의 것을 null로 끝낸다 */
  function askParameters(tabId: string, names: string[]): Promise<Record<string, string> | null>;
  function answerParameters(values: Record<string, string> | null): void;
  function isParameterPromptOpen(): boolean;
  function resetParameterPrompt(): void;  // 프로젝트를 바꿀 때, 기억한 값도 잊음
  // parameterMarks.ts
  const setParameterMarks: StateEffectType<{ from: number; to: number }[]>; // 빈 배열이면 지움
  const parameterMarksField: StateField<DecorationSet>;
  ```
  `runSteps(tabId, choose, finish?)`: `choose` 뒤 문장마다 `findParameters`, 있으면 `askParameters`, null이면 prepare가 null(실행하지 않음), 값이 오면 `substitute`, 그 뒤 `finish`(Task 8의 Explain), 그 뒤 위험 쿼리 확인. `findParameters`가 실패하면(나눌 수 없는 text) 파라미터 없이 보낸다.
  문구 key: `params.title`(`Parameter values`), `params.note`(rich: `Values are inserted as SQL. Quote strings. {cast} is a cast, not a parameter.`), `params.run`(`Run`), `params.cancel`.

- [ ] **Step 1: test를 쓴다**

- `parameterPrompt.test.ts`: `remembers_values_per_tab`, `a_second_ask_cancels_the_first`, `reset_forgets_values`.
- `ParameterPrompt.test.tsx`: `one_row_per_name_in_order`, `run_is_disabled_while_a_value_is_empty`, `enter_and_cmd_enter_run`, `escape_cancels`, `focuses_the_first_empty_input`.
- `commands.test.ts`: `asks_before_running_a_statement_with_parameters`(보낸 sql에 값), `cancel_does_not_run`, `script_asks_once_for_all_statements`(이름이 두 문장에 걸쳐 한 번씩), `no_parameters_no_prompt`, `danger_check_sees_the_substituted_text`, `split_error_runs_without_asking`.
- `shortcuts.test.ts`: `shortcuts_are_ignored_while_the_prompt_is_open`.
- `parameterMarks.test.ts`: `marks_follow_edits_and_clear`.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/workspace src/features/editor/parameterMarks.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현한다**

- dialog는 Tools M9를 따른다: 에디터 영역 안 absolute(right 16px, bottom 16px), 330px, padding 14px, gap 10px, `bg-2` 배경, `border-strong`, radius 10px, dialog 그림자 token. 줄은 grid `64px minmax(0, 1fr)`, gap 8px. 안내는 12px meta, `::date`는 inline code. 버튼은 ghost Cancel과 primary `Run ⌘↵`.
- 떠 있는 동안 `step.from`이 있는 문장의 span에 `setParameterMarks`(`accent/16` 배경, 3px radius)를 보내고 닫힐 때 빈 배열을 보낸다.
- `useShortcuts`는 `isDialogOpen() || isParameterPromptOpen()`이면 event를 건드리지 않는다. dialog의 `Cmd+Enter`는 input의 keydown이 받는다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: :name 파라미터가 있으면 값을 물어 SQL에 넣고 실행함"
```

---

### Task 7: EXPLAIN 출력 parse

**Files:**
- Create: `src/features/query/explainPlan.ts`, `src/features/query/explainPlan.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface PlanNode {
    label: string;               // "Seq Scan on orders"
    depth: number;               // 뿌리 0
    estimatedRows: number | null;
    actualRows: number | null;   // 18은 소수
    totalMs: number | null;      // actual time 끝 값 × loops
    selfMs: number | null;       // totalMs − 자식 totalMs 합, 0 미만이면 0
    loops: number | null;
    neverExecuted: boolean;
  }
  interface Plan { nodes: PlanNode[]; planningMs: number | null; executionMs: number | null; slowest: number | null }
  /** text 출력 한 줄씩. node 줄이 없으면 null */
  function parsePlan(lines: string[]): Plan | null;
  /** 컬럼이 `QUERY PLAN` 하나인 결과 */
  function isPlanResult(columns: ResultColumn[] | null): boolean;
  ```

- [ ] **Step 1: test를 쓴다**

fixture는 test DB에서 받은 실제 출력이다(이 계획의 "먼저 확인한 것"의 `EXPLAIN ANALYZE SELECT * FROM big_table b JOIN (SELECT id FROM big_table LIMIT 50) s USING (id) ORDER BY note` 출력 20줄).
- `parses_postgres_18_analyze_output`: node 5개, 깊이 `0 1 2 3 2`, `Index Scan using big_table_pkey on big_table b`의 loops 50과 `totalMs` 0.05, `planningMs` 1.058, `executionMs` 0.124, detail 줄(`Sort Key:`, `Buffers:`, `Index Searches:`)과 `Planning:` 블록은 node가 아니다.
- `integer_rows_from_older_servers`: `rows=118 loops=1`.
- `slowest_is_by_self_time`: Tools M9의 예시 plan(Sort 41.0, Hash Join 40.6, Seq Scan 36.9, Hash 0.3, Index Scan 0.2)에서 `slowest`가 Seq Scan.
- `subplans_attach_to_their_parent`: `InitPlan 1`/`SubPlan 1` 아래의 `->` node가 그 위 node의 자식 깊이다.
- `never_executed_node`.
- `plain_explain_has_estimates_only`: ANALYZE 없는 출력에서 actual 값과 `slowest`가 null.
- `costs_off_and_timing_off`: `(actual rows=1 loops=1)`만 있는 줄, cost 없는 줄도 node다.
- `json_format_is_not_a_plan`: `[{"Plan": …}]` → null.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/query/explainPlan.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현한다**

뿌리는 `->`가 없는 첫 줄 가운데 `(cost=`, `(actual `, `(never executed)`가 있는 줄, 자식은 `->  `로 시작하는 줄이다. label은 그 줄에서 처음 `  (` 앞까지다. `->`의 열 위치로 stack을 쌓아 부모를 정한다(열이 같거나 깊은 것을 pop). 나머지 줄은 detail로 버리고 `Planning Time:`, `Execution Time:`만 읽는다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: EXPLAIN의 text 출력을 node tree로 읽음"
```

---

### Task 8: EXPLAIN 화면과 Explain 버튼

**Files:**
- Create: `src/features/query/ExplainView.tsx`와 test
- Modify: `src/features/query/ResultPane.tsx`(와 test), `src/features/workspace/{commands.ts,Toolbar.tsx}`(와 test), `src/shared/ui/icons.tsx`, `src/shared/i18n/{en,ko}.ts`

**Interfaces:**
- Consumes: Task 7의 `parsePlan`, `isPlanResult`. Task 5의 `prepend`. Task 6의 `runSteps(tabId, choose, finish)`.
- Produces: `CommandId`에 `"explain"`(keymap에는 넣지 않는다). 문구 key: `toolbar.explain`(`Explain plan (EXPLAIN ANALYZE)`), `run.explainOneStatement`, `explain.tab`(`EXPLAIN`), `explain.timings`(`Execution {execution} · Planning {planning}`), `explain.showRaw`, `explain.showTree`, `explain.node`, `explain.actualTime`, `explain.rows`, `explain.loops`, `explain.neverExecuted`.

- [ ] **Step 1: test를 쓴다**

- `ExplainView.test.tsx`: `indents_by_depth`(16px씩), `slowest_row_is_bold`, `rows_show_estimate_and_actual`(`1,200 → 98,410`, 소수는 `50.5`), `show_raw_toggles_server_text`, `timings_omit_missing_values`.
- `ResultPane.test.tsx`: `completed_query_plan_draws_the_tree`, `json_plan_draws_the_grid`, `trimmed_plan_draws_the_grid`(`firstRow > 0`), `running_plan_fetches_more`.
- `commands.test.ts`: `explain_prefixes_the_statement`(`EXPLAIN ANALYZE SELECT 1`), `explain_keeps_an_explain_statement`, `explain_rejects_two_statements`, `explain_asks_parameters_first`(값을 넣은 뒤 앞에 붙임), `explain_error_position_maps_to_the_document`.
- `Toolbar.test.tsx`: `explain_button_runs_explain`, `explain_is_disabled_without_a_connection`.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/query/ExplainView.test.tsx src/features/query/ResultPane.test.tsx src/features/workspace`
Expected: FAIL

- [ ] **Step 3: 구현한다**

- ResultPane: `finished`, `completed`, `isPlanResult`, `firstRow === 0`, `parsePlan(rows의 첫 cell)`이 null이 아니면 grid 대신 `ExplainView`. 실행 중인 `isPlanResult` 결과의 `fetch === "ready"`면 `fetchMore`를 부른다. 여러 문장의 결과 탭에서도 같다.
- ExplainView는 Tools M9를 따른다(이 계획 "EXPLAIN 보기"). 시간은 `formatElapsed(ms × 1000)`, 행 수는 `formatCount`. raw/tree 선택은 component state다.
- Explain 명령: `runSteps(tabId, statementsToRun, explainFinish)`. `explainFinish`는 문장이 둘 이상이면 Rejection, 첫 단어가 `EXPLAIN`(대소문자 무시, 앞 주석과 공백 건너뜀)이면 그대로, 아니면 `prepend(step, "EXPLAIN ANALYZE ")`.
- Toolbar: Reformat 버튼 다음에 Main의 icon(`ExplainIcon`). 실행 버튼이 disabled인 때 같이 disabled.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: EXPLAIN 결과를 tree로 그리고 toolbar의 Explain으로 EXPLAIN ANALYZE를 실행함"
```

---

### Task 9: DDL 조립 (Rust)

**Files:**
- Create: `crates/chilla-core/src/domain/ddl.rs`, `crates/chilla-core/tests/ddl.rs`
- Modify: `crates/chilla-core/src/domain/mod.rs`, `crates/chilla-core/src/application/{ports,app}.rs`, `crates/chilla-core/src/application/test_support/connection.rs`, `crates/chilla-core/src/infrastructure/postgres/{catalog,mod}.rs`, `src-tauri/src/{commands,error}.rs`, `src/shared/api/{types,commands}.ts`, `src/shared/i18n/{en,ko}.ts`, `src/shared/i18n/errorKinds.json`

**Interfaces:**
- Produces:
  ```rust
  /// 이름과 식은 모두 서버가 만든 text다(`quote_ident`, `format_type`, `pg_get_*`).
  pub struct RelationDdl {
      pub name: String,                     // "public.users"
      pub kind: RelationKind,
      pub unlogged: bool,
      pub columns: Vec<DdlColumn>,          // partition이면 비어 있다
      pub constraints: Vec<DdlConstraint>,  // 이 계획의 순서
      pub inherits: Vec<String>,
      pub partition_of: Option<PartitionOf>,
      pub partition_by: Option<String>,     // "RANGE (created_at)"
      pub options: Vec<String>,             // "fillfactor=70"
      pub view_definition: Option<String>,  // pg_get_viewdef(oid, true)
      pub indexes: Vec<String>,             // pg_get_indexdef
      pub triggers: Vec<String>,            // pg_get_triggerdef(oid, true)
      pub comment: Option<String>,          // quote_literal 된 값
      pub column_comments: Vec<(String, String)>, // (quote_ident 된 컬럼, quote_literal 된 값)
  }
  pub struct DdlColumn { pub name: String, pub type_name: String, pub collation: Option<String>,
      pub not_null: bool, pub primary_key: bool, pub default: Option<String>,
      pub identity: Option<Identity>, pub generated: Option<Generated> }
  pub enum Identity { Always, ByDefault }
  pub struct Generated { pub expression: String, pub stored: bool }
  pub struct DdlConstraint { pub name: String, pub definition: String }
  pub struct PartitionOf { pub parent: String, pub bound: String }
  pub fn render_ddl(ddl: &RelationDdl) -> String;
  // DbConnection에 더한다. 없는 OID면 None
  fn read_ddl(&self, relation: u32) -> impl Future<Output = Result<Option<RelationDdl>, QueryError>> + Send;
  // App. None이면 AppError::RelationGone("The table or view no longer exists. Refresh the schema") → kind "relation_gone"
  pub async fn load_ddl(&self, connection: &str, relation: u32) -> Result<String, AppError>;
  ```
  ```ts
  function loadDdl(connection: string, relation: number): Promise<string>;
  ```

- [ ] **Step 1: test를 쓴다**

`domain/ddl.rs` unit:
- `renders_the_design_example`: Tools M9의 users(identity, NOT NULL, `DEFAULT now()`, jsonb, `CONSTRAINT users_pkey PRIMARY KEY (id)`, unique index)가 이름을 13칸으로 맞추고 identity·PK 컬럼에 NOT NULL을 쓰지 않는다.
- `partition_renders_partition_of`, `partitioned_table_renders_partition_by`, `unlogged_inherits_and_options`, `generated_virtual_and_stored`, `view_and_materialized_view`, `comments_come_last`.

`tests/ddl.rs`(test DB, schema `ddl_src`, `ddl_dst`를 만들고 끝에 지운다):
- `ddl_round_trips`: `ddl_src`에 identity, `GENERATED … STORED`, `DEFAULT`, `COLLATE "C"`, CHECK, UNIQUE, FK, EXCLUDE(`btree_gist` 없이 되는 `int4range` `&&`), 제약이 아닌 인덱스, trigger, 테이블·컬럼 comment가 있는 테이블, partitioned table과 partition 하나, INHERITS 테이블, UNLOGGED 테이블, view, materialized view를 만든다. 각 DDL의 `ddl_src.`을 `ddl_dst.`으로 바꿔 차례로 실행하고, `ddl_dst`에서 다시 읽은 DDL을 `ddl_src.`으로 되돌리면 처음 DDL과 같다.
- `postgres_18_not_null_appears_once`: NOT NULL 컬럼의 DDL에 `NOT NULL`이 한 번, `_not_null` 제약 줄이 없다.
- `unknown_oid_is_none`.
- `quoted_names`: `"Order Items"`, 한글 컬럼 이름이 따옴표와 함께 나온다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cargo test --workspace ddl`
Expected: FAIL

- [ ] **Step 3: 구현한다**

- 읽기는 `catalog.rs`에 SQL을 둔다: relation(`pg_class`의 `relkind`, `relpersistence`, `reloptions`, `relispartition`, `pg_get_partkeydef`, `pg_get_expr(relpartbound, oid)`), 컬럼(`attnum > 0 AND NOT attisdropped`, partition이 아니면 `attislocal`인 것만, `format_type`, 타입의 기본과 다른 `attcollation`, `attidentity`, `attgenerated`, `pg_get_expr(adbin)`), 제약(`conislocal`, contype `p u f c x`, `pg_get_constraintdef`), 인덱스(`pg_index`에서 `conindid`로 쓰이지 않은 것, partition이면 부모 인덱스에 attach된 것 제외), trigger(`NOT tgisinternal`), comment(`obj_description`, `col_description`을 `quote_literal`로), `pg_inherits`의 부모, view는 `pg_get_viewdef(oid, true)`. 이름은 `quote_ident(nspname) || '.' || quote_ident(relname)`.
- 읽기는 M7의 `read_catalog_with`로 catalog connection을 쓴다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add crates src-tauri src
git commit -m "feat: catalog에서 테이블과 view의 생성문을 조립함"
```

---

### Task 10: DDL 화면

**Files:**
- Create: `src/features/query/ddlStore.ts`, `src/features/query/DdlView.tsx`, `src/features/editor/highlightSql.ts`와 각 test
- Modify: `src/features/query/{ResultPane.tsx,runsStore.ts}`, `src/features/schema/SchemaView.tsx`(와 test), `src/features/editor/extensions.ts`, `src/shared/i18n/{en,ko}.ts`

**Interfaces:**
- Consumes: Task 9의 `loadDdl`.
- Produces:
  ```ts
  type DdlView =
    | { name: string; status: "loading" }
    | { name: string; status: "ready"; text: string }
    | { name: string; status: "failed"; message: string };
  const useDdl: { views: Record<string, DdlView> };            // tab id →
  function showDdl(relation: Relation): Promise<void>;          // 활성 탭. 늦게 온 답은 같은 요청일 때만
  function closeDdl(tabId: string): void;
  /** 줄마다 [text, className] 조각. className은 text-syntax-* 또는 "" */
  function highlightSql(text: string): { text: string; className: string }[][];
  ```
  문구 key: `schema.menu.showDdl`(`Show DDL`), `ddl.tab`(`DDL {name}`), `ddl.copy`, `ddl.copied`(`Copied DDL`), `ddl.openInNewTab`, `ddl.close`, `ddl.loading`(`Loading DDL…`).

- [ ] **Step 1: test를 쓴다**

- `highlightSql.test.ts`: `keywords_types_and_functions_get_classes`(`CREATE TABLE`, `bigint`, `now()`), `keeps_every_character`(조각을 이으면 원문).
- `ddlStore.test.ts`: `shows_loading_then_text`, `failure_keeps_the_message`, `a_stale_answer_is_dropped`, `close_removes_it`.
- `runsStore.test.ts`: `a_run_closes_the_ddl`, `release_closes_the_ddl`.
- `DdlView.test.tsx`: `copy_shows_a_toast`, `open_in_new_tab_uses_the_same_connection`, `close_returns_to_the_result`(Close 뒤 지난 결과 표).
- `SchemaView.test.tsx`: `table_and_view_menus_have_show_ddl`, `foreign_table_menu_has_no_show_ddl`.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm vitest run src/features/query src/features/schema src/features/editor/highlightSql.test.ts`
Expected: FAIL

- [ ] **Step 3: 구현한다**

- `highlightSql`은 `@lezer/highlight`의 `highlightCode`에 에디터가 쓰는 SQL dialect의 parser와, `syntaxStyle`과 같은 tag를 `text-syntax-*` class로 옮긴 `tagHighlighter`를 넘긴다(HighlightStyle의 CSS는 에디터 밖에 mount되지 않는다). dialect를 `extensions.ts`에서 export한다.
- ResultPane은 그 탭의 DDL이 있으면 다른 상태보다 먼저 DdlView를 그린다. header는 `DDL {name}` 탭, 빈 칸, Copy(ghost 24px), Open in new tab(secondary 24px), Close(icon). 본문 pre는 `bg-0`, padding 12px 16px.
- `runsStore.run`과 `release`가 `closeDdl(tabId)`를 부른다.
- menu 항목의 이름은 `schema.name`(quote 없이 화면 표시용)이다.

- [ ] **Step 4: 통과를 확인한다**

Run: `pnpm check`
Expected: 통과

- [ ] **Step 5: commit**

```bash
git add src
git commit -m "feat: 스키마 트리의 Show DDL로 생성문을 결과 panel에 보이고 복사하거나 새 탭에 엶"
```

---

### Task 11: 정리와 code review

- [ ] **Step 1:** `simplify`를 돌려 고친 것을 commit한다(`chore: …`).
- [ ] **Step 2:** `code-review`를 high로 돌린다.
- [ ] **Step 3:** 지적마다 `superpowers:receiving-code-review`로 다시 검토해 고칠 것만 고치고 commit한다(`fix: …`). 고치지 않은 지적은 이유와 함께 진행상황의 결정 기록에 남긴다.

Run: `pnpm check`
Expected: 통과

---

### Task 12: 완료 확인 — 앱에서 보기

**Files:**
- Modify: `docs/progress.md`, `docs/plans/M9-query-tools.md`(체크)

앱을 띄우기 전에 사용자에게 해도 되는지 묻는다. 방법은 진행상황 "지금"의 "앱 동작 확인 방법"이다. test DB(54318)에 `CREATE SCHEMA m9_check`의 테이블을 만들어 쓰고 끝나면 지운다. "어제 실행한 쿼리"는 하루를 기다리지 않고, 앱을 끝내기 전에 실행한 쿼리를 다시 시작한 뒤 찾는 것으로 대신하고 `Yesterday` 묶음은 화면 test(Task 3 `groups_by_day`)로 본다.

- [ ] **Step 1: local test DB로 화면을 본다** (`scripts/build-app.sh --debug`)

| 확인 | 기준 |
| --- | --- |
| 쿼리 몇 개 실행 → `Cmd+Q` → 다시 시작 → History에서 단어로 검색 → `Enter` → `Cmd+Enter` | 같은 접속의 새 탭에 그 SQL, 실행됨(완료 기준 1) |
| `SELECT * FROM m9_check.t WHERE id = :id AND d > :since::date` 실행 | dialog에 `:id`, `:since`만, 값을 넣고 `Cmd+Enter`로 결과(완료 기준 2). 다시 실행하면 값이 채워져 있음 |
| `:name`에 따옴표 없는 문자열 | 서버 오류 밑줄이 `:name` 자리 |
| `a[1:2]`가 있는 문장 | dialog가 뜨지 않음 |
| 문장에 커서 → toolbar Explain | Tools M9의 tree, 가장 오래 걸린 node 굵게, `Show raw`로 서버 text |
| 스키마 트리 테이블 menu → Show DDL → Open in new tab → 실행(다른 schema 이름으로 바꿔) | 결과 panel의 색칠한 DDL, 새 탭의 DDL이 그대로 실행됨 |
| DDL을 연 채 Close | 지난 결과 표로 돌아감 |

- [ ] **Step 2: 기록하고 commit한다**

- 진행상황: M9를 `완료`(날짜), 작업 로그에 Task별 결과와 Step 1의 결과, "지금"의 다음 할 일(M10 계획).
- 이 계획의 체크박스를 모두 체크한다.

Run: `pnpm check`
Expected: 통과

```bash
git add docs
git commit -m "docs: M9 완료 확인 결과를 기록함"
```
