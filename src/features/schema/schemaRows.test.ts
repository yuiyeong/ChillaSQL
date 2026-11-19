import { expect, test } from "vitest";
import type { TableDetails } from "../../shared/api/types";
import { catalogFixture, relation } from "../../test/fixtures";
import { schemaRows, type SchemaRow } from "./schemaRows";
import { nodeKey, type DetailsEntry, type SchemaEntry } from "./schemaStore";

function entryWith(
  expanded: string[][],
  patch: Partial<SchemaEntry> = {},
): SchemaEntry {
  return {
    status: "ready",
    catalog: catalogFixture(),
    error: null,
    details: {},
    expanded: new Set(expanded.map(nodeKey)),
    ...patch,
  };
}

/** 줄을 `depth:kind:이름`으로 줄여 본다. */
function brief(rows: SchemaRow[]): string[] {
  return rows.map((row) => {
    const name =
      row.kind === "schema"
        ? row.name
        : row.kind === "group"
          ? row.group
          : row.kind === "relation"
            ? row.relation.name
            : row.kind === "column"
              ? row.column.name
              : row.kind === "index"
                ? row.index.name
                : row.kind === "constraint"
                  ? row.constraint.name
                  : "";
    return `${row.depth}:${row.kind}:${name}`;
  });
}

const USERS_INDEXES = ["public", "tables", "users", "indexes"];

test("no_catalog_has_no_rows", () => {
  expect(schemaRows(entryWith([], { catalog: null }))).toEqual([]);
});

test("collapsed_schema_hides_its_children", () => {
  expect(brief(schemaRows(entryWith([])))).toEqual([
    "0:schema:billing",
    "0:schema:public",
  ]);
});

test("empty_groups_are_left_out", () => {
  const rows = schemaRows(
    entryWith([["public"], ["public", "tables"]], {
      catalog: catalogFixture({
        relations: [
          relation(1, "public", "users"),
          relation(4, "public", "active_users", [], "materialized_view"),
        ],
      }),
    }),
  );
  expect(brief(rows)).toEqual([
    "0:schema:billing",
    "0:schema:public",
    "1:group:tables",
    "2:relation:users",
    "1:group:views",
  ]);
  // billing은 테이블이 없다.
  const billing = schemaRows(
    entryWith([["billing"]], {
      catalog: catalogFixture({ relations: [relation(1, "public", "users")] }),
    }),
  );
  expect(brief(billing).slice(0, 2)).toEqual(["0:schema:billing", "1:empty:"]);
});

test("a_schema_without_relations_shows_empty", () => {
  const rows = schemaRows(
    entryWith([["public"]], {
      catalog: catalogFixture({ relations: [] }),
    }),
  );
  expect(brief(rows)).toEqual([
    "0:schema:billing",
    "0:schema:public",
    "1:empty:",
  ]);
});

test("columns_follow_the_relation", () => {
  const rows = schemaRows(
    entryWith([
      ["public"],
      ["public", "tables"],
      ["public", "tables", "users"],
      ["public", "tables", "users", "columns"],
    ]),
  );
  expect(brief(rows)).toEqual([
    "0:schema:billing",
    "0:schema:public",
    "1:group:tables",
    "2:relation:orders",
    "2:relation:users",
    "3:group:columns",
    "4:column:id",
    "4:column:email",
    "4:column:email_verified_at",
    "3:group:indexes",
    "3:group:constraints",
  ]);
  const users = rows.find((row) => row.kind === "relation" && row.expanded);
  expect(users?.key).toBe(nodeKey(["public", "tables", "users"]));
});

test("details_rows_follow_their_status", () => {
  const expanded = [
    ["public"],
    ["public", "tables"],
    ["public", "tables", "users"],
    USERS_INDEXES,
  ];
  const after = (details?: DetailsEntry) =>
    schemaRows(entryWith(expanded, { details: details ? { 1: details } : {} }))
      .filter((row) => row.depth === 4)
      .map((row) => ({
        kind: row.kind,
        error: "error" in row ? row.error : null,
      }));

  expect(after()).toEqual([{ kind: "loading", error: null }]);
  expect(after({ status: "loading", details: null, error: null })).toEqual([
    { kind: "loading", error: null },
  ]);
  expect(after({ status: "failed", details: null, error: "boom" })).toEqual([
    { kind: "failed", error: "boom" },
  ]);
  const empty: TableDetails = { indexes: [], constraints: [] };
  expect(after({ status: "ready", details: empty, error: null })).toEqual([
    { kind: "empty", error: null },
  ]);
  const one: TableDetails = {
    indexes: [
      { name: "users_pkey", definition: "d", unique: true, primary: true },
    ],
    constraints: [],
  };
  expect(after({ status: "ready", details: one, error: null })).toEqual([
    { kind: "index", error: null },
  ]);
});
