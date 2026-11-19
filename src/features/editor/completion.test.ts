import {
  CompletionContext,
  type Completion,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import type { Catalog } from "../../shared/api/types";
import { catalogFixture, relation } from "../../test/fixtures";
import {
  catalogField,
  catalogSources,
  kindLetter,
  setCatalog,
  sqlCompletionSources,
} from "./completion";

const catalog = catalogFixture({
  relations: [
    ...catalogFixture().relations,
    relation(5, "public", "Order Items", [["id", "bigint", true]]),
    relation(6, "public", "active_users", [["id", "bigint"]], "view"),
  ],
});

/** `|`가 커서다. */
function stateFor(doc: string, withCatalog: Catalog | null = catalog) {
  const pos = doc.indexOf("|");
  const text = doc.replace("|", "");
  let state = EditorState.create({
    doc: text,
    extensions: [sql({ dialect: PostgreSQL }), catalogField],
  });
  if (withCatalog !== null) {
    state = state.update({ effects: setCatalog.of(withCatalog) }).state;
  }
  ensureSyntaxTree(state, text.length, 5000);
  return { state, pos };
}

/** 모든 source의 결과를 모은다. */
async function complete(
  doc: string,
  { explicit = false, withCatalog = catalog as Catalog | null } = {},
): Promise<Completion[]> {
  const { state, pos } = stateFor(doc, withCatalog);
  const context = new CompletionContext(state, pos, explicit);
  const results = await Promise.all(
    sqlCompletionSources().map((source) => source(context)),
  );
  return results
    .filter((r): r is CompletionResult => r !== null)
    .flatMap((r) => [...r.options]);
}

const labels = (options: Completion[]) => options.map((o) => o.label);
const find = (options: Completion[], label: string) =>
  options.find((o) => o.label === label);

test("aliased_columns_come_from_the_aliased_table", async () => {
  const doc = "SELECT u.em| FROM users u JOIN orders o ON o.user_id = u.id";
  const options = await complete(doc);
  expect(labels(options)).toEqual(
    expect.arrayContaining(["email", "email_verified_at"]),
  );
  expect(find(options, "email")?.detail).toBe("users · text");
  expect(find(options, "email")?.type).toBe("column");

  const orders = await complete(
    "SELECT o.| FROM users u JOIN orders o ON o.user_id = u.id",
  );
  expect(labels(orders)).toEqual(expect.arrayContaining(["id", "user_id"]));
  expect(labels(orders)).not.toContain("email");
});

test("unqualified_columns_come_from_tables_in_the_statement", async () => {
  expect(labels(await complete("SELECT em| FROM users"))).toContain("email");
  expect(labels(await complete("UPDATE users SET em|"))).toContain("email");
  const both = labels(
    await complete("SELECT | FROM users u JOIN billing.invoices i", {
      explicit: true,
    }),
  );
  expect(both).toEqual(expect.arrayContaining(["email", "amount"]));
});

test("columns_of_other_statements_are_not_offered", async () => {
  const options = await complete(
    "SELECT 1 FROM orders;\nSELECT us| FROM users",
  );
  expect(labels(options)).not.toContain("user_id");
});

test("tables_need_no_default_schema_prefix", async () => {
  const users = find(await complete("SELECT * FROM us|"), "users");
  expect(users?.type).toBe("table");
  expect(users?.detail).toBe("public");

  expect(labels(await complete("SELECT * FROM billing.|"))).toContain(
    "invoices",
  );

  const quoted = find(await complete("SELECT * FROM Ord|"), "Order Items");
  expect(quoted?.apply).toBe('"Order Items"');

  expect(
    find(await complete("SELECT * FROM act|"), "active_users")?.detail,
  ).toBe("public · view");
});

test("functions_and_keywords", async () => {
  const fn = find(await complete("SELECT date_t|"), "date_trunc");
  expect(fn?.type).toBe("function");
  expect(fn?.detail).toBe("pg_catalog");
  expect(labels(await complete("SEL|"))).toContain("SELECT");
});

test("without_a_catalog_only_keywords_come", async () => {
  const options = await complete("SELECT * FROM us|", { withCatalog: null });
  expect(labels(options)).not.toContain("users");
  const fromCatalog = ["schema", "table", "view", "column", "function"];
  expect(options.filter((o) => fromCatalog.includes(o.type ?? ""))).toEqual([]);
  expect(labels(options)).toContain("SELECT");
});

test("sources_are_built_once_per_catalog", () => {
  expect(catalogSources(catalog)).toBe(catalogSources(catalog));
  let state = EditorState.create({ extensions: [catalogField] });
  state = state.update({ effects: setCatalog.of(catalog) }).state;
  const first = state.field(catalogField)?.sources;
  state = state.update({ effects: setCatalog.of(catalog) }).state;
  expect(state.field(catalogField)?.sources).toBe(first);
  state = state.update({ effects: setCatalog.of(null) }).state;
  expect(state.field(catalogField)).toBeNull();
});

test("kind_letters", () => {
  const letter = (type: string) => kindLetter({ label: "x", type });
  expect(letter("schema")).toBe("s");
  expect(letter("column")).toBe("c");
  expect(letter("table")).toBe("t");
  expect(letter("view")).toBe("t");
  expect(letter("constant")).toBe("t");
  expect(letter("function")).toBe("f");
  expect(letter("keyword")).toBe("k");
  expect(letter("type")).toBe("k");
  expect(letter("variable")).toBe("k");
});

test("completes_within_50ms_on_a_large_catalog", async () => {
  const schemas = ["s0", "s1", "s2"];
  const relations = Array.from({ length: 5000 }, (_, i) =>
    relation(
      i + 1,
      schemas[i % 3],
      `t${i}`,
      Array.from({ length: 20 }, (_, c): [string, string] => [`c${c}`, "text"]),
    ),
  );
  const large = catalogFixture({
    searchPath: ["s0"],
    schemas,
    relations,
  });
  catalogSources(large);

  for (const doc of [
    "SELECT t.| FROM s1.t4999 t",
    "SELECT c1| FROM s2.t10",
    "SELECT * FROM t49|",
  ]) {
    const started = performance.now();
    const options = await complete(doc, { withCatalog: large });
    const elapsed = performance.now() - started;
    expect(options.length).toBeGreaterThan(0);
    expect(elapsed, doc).toBeLessThan(50);
  }
});
