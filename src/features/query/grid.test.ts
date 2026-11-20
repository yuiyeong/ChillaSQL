import { afterEach, expect, test, vi } from "vitest";
import {
  anchorShift,
  cellDisplay,
  copyCell,
  displayColumns,
  createHeaderMeasure,
  estimateHeaderWidth,
  fitWidth,
  headerMeasure,
  rowNumberWidth,
  rowSpan,
  selectedRows,
  selectionRetained,
  shouldFetch,
  tsv,
} from "./grid";

test("displayColumns는 한글과 emoji를 2칸으로 센다", () => {
  expect(displayColumns("abc")).toBe(3);
  expect(displayColumns("가나")).toBe(4);
  expect(displayColumns("a😀")).toBe(3);
});

test("displayColumns는 U+1100부터 전각 범위를 본다", () => {
  expect(displayColumns("\u10ff")).toBe(1);
  expect(displayColumns("\u1100")).toBe(2);
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

test("fitWidth는 header를 header용 너비로 잰다", () => {
  // canvas가 없으면 system font semibold의 반각 한 칸을 9px로 어림한다. D2Coding의 6.5px로 세면 amount가 잘린다.
  expect(fitWidth("amount", ["1"])).toBe(6 * 9 + 20 + 1);
  expect(fitWidth("h".repeat(30), ["1"])).toBe(30 * 9 + 20 + 1);
  expect(fitWidth("h", ["1"], () => 100.2)).toBe(Math.ceil(100.2 + 20 + 1));
  // 값은 그대로 D2Coding 반각으로 센다.
  expect(fitWidth("h", ["x".repeat(20)], () => 10)).toBe(20 * 6.5 + 20 + 1);
});

test("fitWidth는 header의 type 이름도 센다", () => {
  const plain = fitWidth("id", ["1"]);
  // 이름 뒤 gap 6px과 mono 12px 반각 6px씩
  expect(fitWidth("id", ["1"], undefined, { type: "bigint" })).toBe(
    Math.ceil(2 * 9 + 6 + 6 * 6 + 20 + 1),
  );
  expect(fitWidth("id", ["1"], undefined, { type: "bigint" })).toBeGreaterThan(
    plain,
  );
  expect(fitWidth("id", ["1"], undefined, { type: undefined })).toBe(plain);
});

test("fitWidth는 줄여 그린 값의 너비로 센다", () => {
  const vector = `[${Array.from({ length: 1536 }, () => "0.0213").join(",")}]`;
  // `[0.0213, 0.0213, 0.0213, …` 26칸과 ` 1,536 values` 13칸
  expect(fitWidth("v", [vector], () => 10, { kind: "vector" })).toBe(
    Math.ceil(39 * 6.5 + 20 + 1),
  );
  expect(fitWidth("v", [vector], () => 10)).toBe(480);
});

test("fitWidth는 큰 JSON을 parse하지 않고 넓은 값으로 센다", () => {
  const parse = vi.spyOn(JSON, "parse");
  const big = `{"a": {"b": "${"x".repeat(5000)}"}}`;
  const values = Array.from({ length: 2000 }, () => big);

  // 앞 300자가 반각이라 480px 상한까지 넓어진다.
  expect(fitWidth("p", values, () => 10, { kind: "json" })).toBe(480);
  expect(parse).not.toHaveBeenCalled();

  // 작은 JSON은 접은 너비로 센다.
  expect(fitWidth("p", ['{"a": {"b": 1}}'], () => 10, { kind: "json" })).toBe(
    Math.ceil(10 * 6.5 + 20 + 1),
  );
  expect(parse).toHaveBeenCalledTimes(1);
  parse.mockRestore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("style");
});

test("createHeaderMeasure는 canvas가 없으면 어림값을 쓴다", () => {
  expect(createHeaderMeasure()).toBe(estimateHeaderWidth);
  expect(estimateHeaderWidth("가a")).toBe(3 * 9);
});

test("createHeaderMeasure는 header의 글꼴 token으로 canvas에서 잰다", () => {
  const fonts: string[] = [];
  class FakeCanvas {
    getContext() {
      return {
        font: "10px sans-serif",
        measureText(this: { font: string }, text: string) {
          fonts.push(this.font);
          return { width: text.length * 7.25 };
        },
      };
    }
  }
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  const root = document.documentElement.style;
  root.setProperty("--font-weight-semibold", "600");
  root.setProperty("--text-small", "13px");
  root.setProperty("--font-sans", "-apple-system, sans-serif");

  expect(createHeaderMeasure()("amount")).toBe(6 * 7.25);
  expect(fonts).toEqual(["600 13px -apple-system, sans-serif"]);
});

test("createHeaderMeasure는 글꼴 token이 없으면 어림값을 쓴다", () => {
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return { font: "", measureText: () => ({ width: 1 }) };
      }
    },
  );

  expect(createHeaderMeasure()).toBe(estimateHeaderWidth);
});

test("headerMeasure는 처음 만든 함수를 다시 쓴다", () => {
  expect(headerMeasure()).toBe(headerMeasure());
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

test("rowSpan은 행 선택의 위아래 끝이다", () => {
  expect(rowSpan({ kind: "rows", anchor: 12, focus: 9 })).toEqual([9, 12]);
  expect(rowSpan({ kind: "rows", anchor: 3, focus: 3 })).toEqual([3, 3]);
  expect(rowSpan({ kind: "cell", row: 1, column: 0 })).toBeNull();
  expect(rowSpan(null)).toBeNull();
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
    dim: null,
    muted: true,
    italic: true,
  });
  expect(cellDisplay("")).toEqual({
    text: "''",
    dim: null,
    muted: true,
    italic: false,
  });
  expect(cellDisplay("abc")).toEqual({
    text: "abc",
    dim: null,
    muted: false,
    italic: false,
  });
});

test("cellDisplay는 type에 맞게 줄인 뒤에 300자로 자른다", () => {
  expect(cellDisplay('{"a":{"b":1}}', "json").text).toBe('{"a": {…}}');
  expect(cellDisplay("[1,2,3,4]", "vector")).toEqual({
    text: "[1, 2, 3, …",
    dim: "4 values",
    muted: false,
    italic: false,
  });
  // 접은 결과가 300자를 넘을 때만 자른다. 접기 전 원문 길이는 상관없다.
  const wide = `{"a": {${'"k": 1,'.repeat(200)}"z": 1}}`;
  expect(cellDisplay(wide, "json").text).toBe('{"a": {…}}');
  const long = `[${Array.from({ length: 200 }, () => "0.123456").join(",")}]`;
  expect(cellDisplay(long, "text").text).toBe(`${long.slice(0, 300)}…`);
  expect(cellDisplay(null, "number")).toMatchObject({
    text: "NULL",
    muted: true,
  });
});

test("cellDisplay는 긴 값을 surrogate pair를 가르지 않고 자른다", () => {
  const long = `${"a".repeat(299)}😀tail`;
  expect(cellDisplay(long).text).toBe(`${"a".repeat(299)}…`);
  expect(cellDisplay("a".repeat(301)).text).toBe(`${"a".repeat(300)}…`);
  expect(cellDisplay("a".repeat(300)).text).toBe("a".repeat(300));
});

test("selectionRetained는 선택이 보관한 행에 걸치는지 본다", () => {
  // 보관한 행은 100~199번이다.
  expect(selectionRetained(null, 100, 100)).toBe(false);
  expect(
    selectionRetained({ kind: "cell", row: 99, column: 0 }, 100, 100),
  ).toBe(false);
  expect(
    selectionRetained({ kind: "cell", row: 100, column: 0 }, 100, 100),
  ).toBe(true);
  expect(
    selectionRetained({ kind: "cell", row: 200, column: 0 }, 100, 100),
  ).toBe(false);
  expect(
    selectionRetained({ kind: "rows", anchor: 120, focus: 10 }, 100, 100),
  ).toBe(true);
  expect(
    selectionRetained({ kind: "rows", anchor: 99, focus: 10 }, 100, 100),
  ).toBe(false);
});
