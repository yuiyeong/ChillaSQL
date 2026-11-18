import { expect, test } from "vitest";
import {
  anchorShift,
  cellDisplay,
  copyCell,
  displayColumns,
  fitWidth,
  resultLabel,
  rowNumberWidth,
  selectedRows,
  shouldFetch,
  tsv,
} from "./grid";

test("displayColumns는 한글과 emoji를 2칸으로 센다", () => {
  expect(displayColumns("abc")).toBe(3);
  expect(displayColumns("가나")).toBe(4);
  expect(displayColumns("a😀")).toBe(3);
});

test("displayColumns는 CELL_LIMIT자까지만 센다", () => {
  expect(displayColumns("x".repeat(100_000))).toBe(300);
});

test("fitWidth는 64~480px로 자른다", () => {
  expect(fitWidth("id", ["1"])).toBe(64);
  expect(fitWidth("email", ["haneul.kim@example.com"])).toBe(
    Math.ceil(22 * 6.5 + 20 + 1),
  );
  expect(fitWidth("profile", ["x".repeat(100_000)])).toBe(480);
  expect(fitWidth("v", [null])).toBe(64);
});

test("fitWidth는 앞 2,000개만 본다", () => {
  const values = [...Array(2000).fill("a"), "b".repeat(50)];
  expect(fitWidth("c", values)).toBe(64);
});

test("fitWidth는 header도 센다", () => {
  expect(fitWidth("h".repeat(30), ["1"])).toBe(Math.ceil(30 * 6.5 + 20 + 1));
});

test("fitWidth는 가장 긴 값과 padding에 칸의 border-r 1px까지 더한다", () => {
  // 2026-09-24 04:07:00+00은 22자. 1px이 모자라면 마지막 글자가 …로 잘린다.
  expect(fitWidth("t", ["2026-09-24 04:07:00+00"])).toBe(22 * 6.5 + 20 + 1);
  expect(fitWidth("n", ["user_569553"])).toBe(Math.ceil(11 * 6.5 + 20 + 1));
});

test("rowNumberWidth는 마지막 행 번호와 padding, border-r 1px에 맞추고 52px보다 좁지 않다", () => {
  expect(rowNumberWidth(9)).toBe(52);
  // "1,000,000"은 9자
  expect(rowNumberWidth(1_000_000)).toBe(Math.ceil(9 * 6.5 + 20 + 1));
  // "1,800"은 5자
  expect(rowNumberWidth(1_800)).toBe(Math.max(52, Math.ceil(5 * 6.5 + 20 + 1)));
});

test("tsv는 NULL을 빈 칸으로, 특수 문자가 든 값을 따옴표로 쓴다", () => {
  expect(
    tsv([
      ["1", null, "a\tb"],
      ['say "hi"', "줄\n바꿈", "😀"],
    ]),
  ).toBe('1\t\t"a\tb"\n"say ""hi"""\t"줄\n바꿈"\t😀');
});

test("tsv는 \\r이 든 값도 따옴표로 쓴다", () => {
  expect(tsv([["a\rb"]])).toBe('"a\rb"');
});

test("copyCell은 NULL을 빈 문자열로", () => {
  expect(copyCell(null)).toBe("");
  expect(copyCell("NULL")).toBe("NULL");
});

test("shouldFetch", () => {
  expect(shouldFetch(400, 500, "ready")).toBe(true);
  expect(shouldFetch(399, 500, "ready")).toBe(false);
  expect(shouldFetch(499, 500, "fetching")).toBe(false);
  expect(shouldFetch(499, 500, "none")).toBe(false);
});

test("anchorShift는 버린 행만큼 당기고 처음 생긴 버린 구간 줄만큼 민다", () => {
  expect(anchorShift(0, 500)).toBe(40 - 500 * 26);
  expect(anchorShift(500, 1000)).toBe(-500 * 26);
  expect(anchorShift(500, 500)).toBe(0);
  expect(anchorShift(500, 0)).toBe(0);
});

test("resultLabel", () => {
  expect(resultLabel("-- 최근\nselect * from users u")).toBe("SELECT users");
  expect(resultLabel("UPDATE public.users SET a = 1")).toBe(
    "UPDATE public.users",
  );
  expect(resultLabel('insert into "Order" values (1)')).toBe('INSERT "Order"');
  expect(resultLabel("select pg_sleep(1)")).toBe("SELECT");
});

test("resultLabel은 주석을 건너뛰고 긴 label을 자른다", () => {
  expect(resultLabel("/* a */ -- b\n  delete from t")).toBe("DELETE t");
  const label = resultLabel(`select * from ${"a".repeat(60)}`);
  expect(label).toBe(`SELECT ${"a".repeat(24)}…`);
  expect([...label]).toHaveLength(32);
});

test("selectedRows는 보관된 행만 위에서 아래로", () => {
  const rows = [["a"], ["b"], ["c"]];
  expect(
    selectedRows({ kind: "rows", anchor: 12, focus: 9 }, 10, rows),
  ).toEqual([["a"], ["b"], ["c"]]);
  expect(
    selectedRows({ kind: "rows", anchor: 11, focus: 11 }, 10, rows),
  ).toEqual([["b"]]);
  expect(
    selectedRows({ kind: "rows", anchor: 1, focus: 10 }, 10, rows),
  ).toEqual([["a"]]);
  expect(selectedRows(null, 10, rows)).toEqual([]);
  expect(selectedRows({ kind: "cell", row: 10, column: 0 }, 10, rows)).toEqual(
    [],
  );
});

test("cellDisplay", () => {
  expect(cellDisplay(null)).toEqual({
    text: "NULL",
    muted: true,
    italic: true,
  });
  expect(cellDisplay("")).toEqual({ text: "''", muted: true, italic: false });
  expect(cellDisplay("abc")).toEqual({
    text: "abc",
    muted: false,
    italic: false,
  });
});

test("cellDisplay는 긴 값을 surrogate pair를 가르지 않고 자른다", () => {
  const long = `${"a".repeat(299)}😀tail`;
  expect(cellDisplay(long).text).toBe(`${"a".repeat(299)}…`);
  expect(cellDisplay("a".repeat(301)).text).toBe(`${"a".repeat(300)}…`);
  expect(cellDisplay("a".repeat(300)).text).toBe("a".repeat(300));
});
