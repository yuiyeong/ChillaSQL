import { EditorSelection } from "@codemirror/state";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  attachView,
  closeDocument,
  detachView,
  documentSelection,
  documentState,
  documentText,
  openDocument,
  setDocumentState,
} from "./documents";
import { unclosedReason, reformatDocument } from "./reformat";

beforeEach(() => {
  openDocument("t", "");
});

afterEach(() => {
  closeDocument("t");
});

function setText(text: string, from = 0, to = from) {
  openDocument("t", text);
  setDocumentState(
    "t",
    documentState("t").update({
      selection: EditorSelection.single(from, to),
    }).state,
  );
}

function undoStored() {
  undo({
    state: documentState("t"),
    dispatch: (tr) => setDocumentState("t", tr.state),
  });
}

test("formats_the_whole_document", () => {
  setText("select a,b from t where x=1");

  expect(reformatDocument("t")).toEqual({ ok: true });

  expect(documentText("t")).toBe(
    "select\n  a,\n  b\nfrom\n  t\nwhere\n  x = 1",
  );
});

test("formats_only_the_selection", () => {
  const before = "SELECT 0;\n";
  const picked = "select a,b from t";
  const after = "\n-- tail\nSELECT 9";
  setText(
    before + picked + after,
    before.length,
    before.length + picked.length,
  );

  expect(reformatDocument("t")).toEqual({ ok: true });

  const formatted = "select\n  a,\n  b\nfrom\n  t";
  expect(documentText("t")).toBe(before + formatted + after);
  // 선택 영역이 새 text를 감싼다.
  expect(documentSelection("t")).toMatchObject({
    from: before.length,
    to: before.length + formatted.length,
  });
});

test("keeps_the_cursor_after_the_same_token_when_formatting_the_whole_document", () => {
  const text = "select a,b from t";
  setText(text, text.indexOf(" from"));

  reformatDocument("t");

  const { head } = documentSelection("t");
  // cursor는 `b` 뒤에 있었다.
  expect(documentText("t").slice(0, head)).toMatch(/select\n {2}a,\n {2}b$/);
});

test("one_undo_restores_the_text", () => {
  setText("select a,b from t");

  reformatDocument("t");
  expect(documentText("t")).not.toBe("select a,b from t");
  undoStored();

  expect(documentText("t")).toBe("select a,b from t");
});

test("failure_leaves_the_document", () => {
  setText("SELECT 1 ]");
  const before = documentState("t");

  const result = reformatDocument("t");

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.reason).toMatch(/^Parse error/);
    expect(result.reason).not.toContain("\n");
  }
  expect(documentState("t")).toBe(before);
});

test("rejects_unclosed_block_comment", () => {
  setText("SELECT 1 /* abc");
  const before = documentState("t");

  expect(reformatDocument("t")).toEqual({
    ok: false,
    reason: "unclosed block comment",
  });
  expect(documentState("t")).toBe(before);
});

test("keeps_casts_and_dollar_bodies", () => {
  const sql = [
    "select created::date, \"Order Items\".한글, data->>'k', tags @> '{a}'",
    'from "Order Items" -- 한글 주석',
    "/* 한글 /* 중첩 */ 주석 */ ;",
    "create function f() returns int as $$ begin select 1; return 2; end $$ language plpgsql;",
  ].join("\n");
  setText(sql);

  expect(reformatDocument("t")).toEqual({ ok: true });

  const text = documentText("t");
  for (const piece of [
    "::date",
    "->>",
    "@>",
    '"Order Items"',
    "한글",
    "-- 한글 주석",
    "/* 한글 /* 중첩 */ 주석 */",
    "$$ begin select 1; return 2; end $$",
  ]) {
    expect(text).toContain(piece);
  }
});

test("does_nothing_for_a_blank_document_or_selection", () => {
  setText("   \n");
  const before = documentState("t");

  expect(reformatDocument("t")).toEqual({ ok: true });

  expect(documentState("t")).toBe(before);
});

test("goes_through_the_mounted_view", () => {
  setText("select a,b from t");
  const dispatched: boolean[] = [];
  const view = new EditorView({
    state: documentState("t"),
    dispatchTransactions(trs, view) {
      view.update(trs);
      dispatched.push(trs.some((tr) => tr.docChanged));
      setDocumentState("t", view.state);
    },
  });
  attachView(view, "t");

  expect(reformatDocument("t")).toEqual({ ok: true });

  expect(dispatched).toEqual([true]);
  expect(view.state.doc.toString()).toBe(documentText("t"));
  expect(documentText("t")).toContain("\n");
  detachView(view);
  view.destroy();
});

test("unclosed_literal_detection", () => {
  const unclosed: [string, string][] = [
    ["SELECT 1 /* abc", "unclosed block comment"],
    ["/* a /* b */ c", "unclosed block comment"],
    ["SELECT 1 -- x */\n/* y", "unclosed block comment"],
    ["SELECT 'abc", "unclosed string"],
    ["SELECT E'abc\\' /*", "unclosed string"],
    ['SELECT "abc', "unclosed quoted identifier"],
    ["SELECT $$ /*", "unclosed dollar-quoted string"],
    ["SELECT $t$ a $$", "unclosed dollar-quoted string"],
  ];
  const closed = [
    "SELECT 1 /* abc */",
    "/* a /* b */ c */ SELECT 1",
    "SELECT '/*'",
    "SELECT 'it''s /*'",
    "SELECT E'\\'/*'",
    'SELECT "/*" FROM t',
    "SELECT 1 -- /*\n, 2",
    "SELECT $$ /* $$",
    "SELECT $tag$ /* $tag$, $1",
    "/* ' */ SELECT 1",
  ];
  for (const [sql, reason] of unclosed) {
    expect(unclosedReason(sql), sql).toBe(reason);
  }
  for (const sql of closed) expect(unclosedReason(sql), sql).toBeNull();
});

test("keeps_whitespace_around_a_selection_ending_with_a_newline", () => {
  const text = "select 1;\nselect 2";
  setText(text, 0, "select 1;\n".length);

  expect(reformatDocument("t")).toEqual({ ok: true });

  expect(documentText("t")).toBe("select\n  1;\nselect 2");
  expect(documentSelection("t")).toMatchObject({ from: 0, to: 12 });
});

test("keeps_leading_and_trailing_whitespace_of_the_whole_document", () => {
  setText("\n\nselect 1;\n");

  expect(reformatDocument("t")).toEqual({ ok: true });

  expect(documentText("t")).toBe("\n\nselect\n  1;\n");
});

test("an_already_formatted_document_is_left_alone", () => {
  setText("select\n  1;\n");
  const before = documentState("t");

  expect(reformatDocument("t")).toEqual({ ok: true });

  expect(documentState("t")).toBe(before);
});
