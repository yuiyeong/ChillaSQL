import { expect, test } from "vitest";
import { catalogFixture, relation } from "../../test/fixtures";
import { isView, relationNamed, relationsOf } from "./catalog";

test("relation_named_finds_by_schema_and_name", () => {
  const catalog = catalogFixture();
  expect(relationNamed(catalog, "public", "users")?.oid).toBe(1);
  expect(relationNamed(catalog, "billing", "users")).toBeUndefined();
});

test("relations_of_groups_by_schema_in_order", () => {
  const catalog = catalogFixture();
  expect(relationsOf(catalog, "public").map((r) => r.name)).toEqual([
    "orders",
    "users",
  ]);
  expect(relationsOf(catalog, "nope")).toEqual([]);
  expect(relationsOf(catalog, "public")).toBe(relationsOf(catalog, "public"));
});

test("views_and_materialized_views_are_views", () => {
  expect(isView(relation(1, "s", "v", [], "view"))).toBe(true);
  expect(isView(relation(1, "s", "m", [], "materialized_view"))).toBe(true);
  expect(isView(relation(1, "s", "t", [], "foreign_table"))).toBe(false);
});
