import { EditorSelection } from "@codemirror/state";
import { afterEach, expect, test } from "vitest";
import {
  closeDocument,
  documentSelection,
  documentState,
  documentText,
  openDocument,
  setDocumentState,
} from "./documents";

afterEach(() => {
  closeDocument("t");
});

test("연 문서의 text와 selection을 돌려준다", () => {
  openDocument("t", "SELECT 1");

  expect(documentText("t")).toBe("SELECT 1");
  expect(documentSelection("t")).toEqual({ from: 0, to: 0, head: 0 });
});

test("setDocumentState 뒤에는 새 state의 값을 준다", () => {
  openDocument("t", "SELECT 1");
  const next = documentState("t").update({
    changes: { from: 0, insert: "-- " },
    selection: EditorSelection.single(10, 3),
  }).state;

  setDocumentState("t", next);

  expect(documentState("t")).toBe(next);
  expect(documentText("t")).toBe("-- SELECT 1");
  expect(documentSelection("t")).toEqual({ from: 3, to: 10, head: 3 });
});

test("닫은 문서는 없다", () => {
  openDocument("t", "SELECT 1");

  closeDocument("t");

  expect(() => documentState("t")).toThrow();
});
