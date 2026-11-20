import { expect, test } from "vitest";
import type { Cell, EditColumn, EditTable } from "../../shared/api/types";
import { editTargetOf, type EditTarget } from "./editTarget";
import { buildUpdates, sqlLiteral, type Changes } from "./editSql";

function editColumn(
  number: number,
  name: string,
  primaryKey = false,
): EditColumn {
  return {
    number,
    name,
    quotedName: `"${name}"`,
    primaryKey,
    updatable: true,
  };
}

const users: EditTable = {
  oid: 100,
  qualifiedName: "public.users",
  name: "users",
  kind: "table",
  columns: [
    editColumn(1, "id", true),
    editColumn(2, "email"),
    editColumn(4, "display_name"),
  ],
};

function targetOf(table: EditTable, order: number[]): EditTarget {
  const result = editTargetOf(
    order.map((number) => ({
      name: `c${number}`,
      typeOid: 25,
      typeModifier: -1,
      tableOid: table.oid,
      columnNumber: number,
    })),
    [table],
    false,
    false,
  );
  if (result === null || "reason" in result) throw new Error("not editable");
  return result;
}

/** 결과 열: id, email, display_name */
const target = targetOf(users, [1, 2, 4]);
const categories = ["N", "S", "S"];
const original: Cell[][] = [
  ["1", "a@example.com", "Ann"],
  ["2", "b@example.com", "Bob"],
  ["3", "c@example.com", null],
];

function changes(entries: [number, [number, Cell][]][]): Changes {
  return new Map(entries.map(([row, cells]) => [row, new Map(cells)]));
}

function build(c: Changes, t: EditTarget = target, cats = categories) {
  return buildUpdates(t, c, (row) => original[row], cats);
}

test("one_statement_per_row_in_row_order", () => {
  // Map의 삽입 순서는 2, 0이다. 결과는 행 번호 순이어야 한다.
  const result = build(
    changes([
      [2, [[2, "c2@example.com"]]],
      [0, [[4, "Annie"]]],
    ]),
  );
  expect(result).toEqual([
    {
      row: 0,
      attnums: [4],
      sql: `UPDATE public.users SET "display_name" = 'Annie' WHERE "id" = 1 RETURNING "display_name";`,
    },
    {
      row: 2,
      attnums: [2],
      sql: `UPDATE public.users SET "email" = 'c2@example.com' WHERE "id" = 3 RETURNING "email";`,
    },
  ]);
});

test("rows_without_changes_are_skipped", () => {
  expect(build(changes([[1, []]]))).toEqual([]);
  expect(build(new Map())).toEqual([]);
});

test("set_follows_attnum_order", () => {
  const result = build(
    changes([
      [
        1,
        [
          [4, "Bobby"],
          [2, "bob@example.com"],
        ],
      ],
    ]),
  );
  expect(result).toHaveLength(1);
  expect(result[0].attnums).toEqual([2, 4]);
  expect(result[0].sql).toBe(
    `UPDATE public.users SET "email" = 'bob@example.com', "display_name" = 'Bobby' WHERE "id" = 2 RETURNING "email", "display_name";`,
  );
});

test("where_uses_the_original_key", () => {
  const result = build(
    changes([
      [
        0,
        [
          [1, "100"],
          [2, "new@example.com"],
        ],
      ],
    ]),
  );
  expect(result[0].sql).toBe(
    `UPDATE public.users SET "id" = 100, "email" = 'new@example.com' WHERE "id" = 1 RETURNING "id", "email";`,
  );
});

test("composite_key_where", () => {
  const link: EditTable = {
    oid: 200,
    qualifiedName: "public.links",
    name: "links",
    kind: "table",
    columns: [
      editColumn(1, "a", true),
      editColumn(2, "b", true),
      editColumn(3, "note"),
    ],
  };
  // 결과 열: note, b, a
  const composite = targetOf(link, [3, 2, 1]);
  const rows: Cell[][] = [["hello", "x'y", "7"]];
  const result = buildUpdates(
    composite,
    changes([[0, [[3, "bye"]]]]),
    (row) => rows[row],
    ["S", "S", "N"],
  );
  expect(result[0].sql).toBe(
    `UPDATE public.links SET "note" = 'bye' WHERE "a" = 7 AND "b" = 'x''y' RETURNING "note";`,
  );
});

test("the category of a duplicated attnum comes from its first result column", () => {
  // 결과 열: email AS e, email, id
  const dup = targetOf(users, [2, 2, 1]);
  const rows: Cell[][] = [["x", "x", "5"]];
  const result = buildUpdates(
    dup,
    changes([[0, [[2, "123"]]]]),
    (row) => rows[row],
    ["S", "N", "N"],
  );
  expect(result[0].sql).toBe(
    `UPDATE public.users SET "email" = '123' WHERE "id" = 5 RETURNING "email";`,
  );
});

test("literals_escape_quotes_and_backslashes", () => {
  expect(sqlLiteral("O'Brien", "S")).toBe(`'O''Brien'`);
  expect(sqlLiteral("C:\\temp", "S")).toBe(`E'C:\\\\temp'`);
  expect(sqlLiteral("it's\\", "S")).toBe(`E'it''s\\\\'`);
  expect(sqlLiteral("line1\nline2", "S")).toBe("'line1\nline2'");
  expect(sqlLiteral("안녕 세계", "S")).toBe("'안녕 세계'");
  expect(sqlLiteral("", "S")).toBe("''");
  expect(sqlLiteral("2026-11-20", undefined)).toBe("'2026-11-20'");
});

test("numbers_are_bare_only_for_numeric_digits", () => {
  expect(sqlLiteral("10482", "N")).toBe("10482");
  expect(sqlLiteral("-1.5", "N")).toBe("-1.5");
  expect(sqlLiteral("NaN", "N")).toBe("'NaN'");
  expect(sqlLiteral("1e5", "N")).toBe("'1e5'");
  expect(sqlLiteral("$1.00", "N")).toBe("'$1.00'");
  expect(sqlLiteral(" 12", "N")).toBe("' 12'");
  expect(sqlLiteral("1.", "N")).toBe("'1.'");
  expect(sqlLiteral("123", "S")).toBe("'123'");
  expect(sqlLiteral("123", undefined)).toBe("'123'");
});

test("null_is_keyword", () => {
  expect(sqlLiteral(null, "S")).toBe("NULL");
  expect(sqlLiteral(null, "N")).toBe("NULL");
  const result = build(changes([[2, [[4, null]]]]));
  expect(result[0].sql).toBe(
    `UPDATE public.users SET "display_name" = NULL WHERE "id" = 3 RETURNING "display_name";`,
  );
});
