import { Text } from "@codemirror/state";
import { expect, test } from "vitest";
import type { StatementSpan } from "../../shared/api/types";
import { lineColumn, statementAt } from "./statementAt";

/** 줄 끝이 \n인 text를 CodeMirror 문서로 바꾼다. */
function doc(text: string): Text {
  return Text.of(text.split("\n"));
}

function span(start: number, end: number): StatementSpan {
  return { start, end };
}

test("커서가 문장 안이나 끝이면 그 문장이다", () => {
  const text = "SELECT 1;\nSELECT 2";
  const spans = [span(0, 8), span(10, 18)];
  for (const cursor of [0, 4, 8]) {
    expect(statementAt(doc(text), spans, cursor)).toEqual(span(0, 8));
  }
  for (const cursor of [10, 14, 18]) {
    expect(statementAt(doc(text), spans, cursor)).toEqual(span(10, 18));
  }
});

test("문장 밖이면 같은 줄의 앞 문장이다", () => {
  expect(
    statementAt(doc("SELECT 1;\nSELECT 2"), [span(0, 8), span(10, 18)], 9),
  ).toEqual(span(0, 8));
  expect(statementAt(doc("SELECT 1; -- note"), [span(0, 8)], 17)).toEqual(
    span(0, 8),
  );
  expect(
    statementAt(doc("SELECT 1; SELECT 2"), [span(0, 8), span(10, 18)], 9),
  ).toEqual(span(0, 8));
});

test("앞 문장이 없으면 같은 줄의 뒤 문장이다", () => {
  expect(statementAt(doc("  SELECT 1"), [span(2, 10)], 0)).toEqual(span(2, 10));
});

test("다른 줄의 문장은 고르지 않는다", () => {
  expect(
    statementAt(doc("SELECT 1;\n\nSELECT 2"), [span(0, 8), span(11, 19)], 10),
  ).toBeNull();
  expect(statementAt(doc("-- only\nSELECT 1"), [span(8, 16)], 3)).toBeNull();
  expect(statementAt(doc("SELECT 1"), [], 0)).toBeNull();
});

test("lineColumn은 1부터 세는 줄과 UTF-16 칸이다", () => {
  expect(lineColumn("a\nbc", 0)).toEqual({ line: 1, column: 1 });
  expect(lineColumn("a\nbc", 3)).toEqual({ line: 2, column: 2 });
  expect(lineColumn("😀x", 2)).toEqual({ line: 1, column: 3 });
});
