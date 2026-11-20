import { expect, test } from "vitest";
import type { Cell } from "../../shared/api/types";
import { compareNumeric, nextSort, sortOrder } from "./sortRows";

/** 한 열짜리 행으로 정렬해 보이는 순서의 값을 돌려준다. */
function sorted(
  values: Cell[],
  direction: "asc" | "desc",
  category: string | undefined,
): Cell[] {
  const rows = values.map((value) => [value]);
  const order = sortOrder(rows, { column: 0, direction }, category)!;
  return Array.from(order, (index) => rows[index][0]);
}

test("numbers_sort_by_value", () => {
  expect(
    sorted(
      [
        "10",
        "9",
        "-2",
        "9007199254740993",
        "9007199254740992",
        "NaN",
        "Infinity",
        "-Infinity",
        "1.50",
        "1.5",
      ],
      "asc",
      "N",
    ),
  ).toEqual([
    "-Infinity",
    "-2",
    "1.50",
    "1.5",
    "9",
    "10",
    "9007199254740992",
    "9007199254740993",
    "Infinity",
    "NaN",
  ]);
});

test("compareNumeric_reads_sign_digits_and_fraction", () => {
  expect(compareNumeric("-10", "-9")).toBeLessThan(0);
  expect(compareNumeric("-0.5", "-0.25")).toBeLessThan(0);
  expect(compareNumeric("007", "7")).toBe(0);
  expect(compareNumeric("-0", "0")).toBe(0);
  expect(compareNumeric("0.05", "0.5")).toBeLessThan(0);
  expect(compareNumeric("0.5", "0.51")).toBeLessThan(0);
  expect(compareNumeric("-Infinity", "-99999999999999999999")).toBeLessThan(0);
  expect(compareNumeric("Infinity", "NaN")).toBeLessThan(0);
  // 수로 읽을 수 없는 값은 수 뒤에 오고, 그끼리는 문자열 순이다.
  expect(compareNumeric("10", "$1.00")).toBeLessThan(0);
  expect(compareNumeric("$2.00", "$1.00")).toBeGreaterThan(0);
});

test("nulls_last_ascending_first_descending", () => {
  const values: Cell[] = ["2", null, "1", null, "3"];
  expect(sorted(values, "asc", "N")).toEqual(["1", "2", "3", null, null]);
  expect(sorted(values, "desc", "N")).toEqual([null, null, "3", "2", "1"]);
});

test("text_uses_code_unit_order", () => {
  expect(sorted(["가", "a", "B"], "asc", "S")).toEqual(["B", "a", "가"]);
  expect(sorted(["가", "a", "B"], "desc", "S")).toEqual(["가", "a", "B"]);
});

test("stable_for_ties", () => {
  const rows: Cell[][] = [
    ["b", "1"],
    ["a", "2"],
    ["b", "3"],
    ["a", "4"],
  ];
  const ascending = sortOrder(rows, { column: 0, direction: "asc" }, "S")!;
  expect(Array.from(ascending)).toEqual([1, 3, 0, 2]);
  // 내림차순에서도 같은 값은 결과 순서다.
  const descending = sortOrder(rows, { column: 0, direction: "desc" }, "S")!;
  expect(Array.from(descending)).toEqual([0, 2, 1, 3]);
  // NULL끼리도 결과 순서다.
  const nulls = sortOrder(
    [
      [null, "x"],
      ["a", "y"],
      [null, "z"],
    ],
    { column: 0, direction: "desc" },
    "S",
  )!;
  expect(Array.from(nulls)).toEqual([0, 2, 1]);
});

test("unknown_category_is_text", () => {
  expect(sorted(["9", "10", "-2"], "asc", undefined)).toEqual([
    "-2",
    "10",
    "9",
  ]);
});

test("no_sort_has_no_order", () => {
  expect(sortOrder([["1"]], null, "N")).toBeNull();
});

test("cycle_asc_desc_none", () => {
  const ascending = nextSort(null, 2);
  expect(ascending).toEqual({ column: 2, direction: "asc" });
  const descending = nextSort(ascending, 2);
  expect(descending).toEqual({ column: 2, direction: "desc" });
  expect(nextSort(descending, 2)).toBeNull();
  // 다른 열을 누르면 그 열의 오름차순이다.
  expect(nextSort(descending, 0)).toEqual({ column: 0, direction: "asc" });
});
