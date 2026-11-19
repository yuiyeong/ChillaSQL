import { expect, test } from "vitest";
import { catalogFixture } from "../../test/fixtures";
import { quoteIdent, reservedSet } from "./identifiers";

test("quote_ident_matches_postgres", () => {
  const reserved = new Set(["user", "select"]);
  expect(quoteIdent("users", reserved)).toBe("users");
  expect(quoteIdent("Order Items", reserved)).toBe('"Order Items"');
  expect(quoteIdent("user", reserved)).toBe('"user"');
  expect(quoteIdent('a"b', reserved)).toBe('"a""b"');
  expect(quoteIdent("1abc", reserved)).toBe('"1abc"');
  expect(quoteIdent("col$1", reserved)).toBe("col$1");
  expect(quoteIdent("Users", reserved)).toBe('"Users"');
  expect(quoteIdent("_x", reserved)).toBe("_x");
});

test("reserved_set_is_built_once_per_catalog", () => {
  const catalog = catalogFixture();
  expect(reservedSet(catalog)).toBe(reservedSet(catalog));
  expect(reservedSet(catalog).has("user")).toBe(true);
});
