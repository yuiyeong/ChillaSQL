import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import { splitStatements } from "../../shared/api/commands";
import { CommandError } from "../../shared/api/errors";
import type { StatementSpan } from "../../shared/api/types";
import { deferred } from "../../test/deferred";
import { editorExtensions } from "./extensions";
import { statementSpansField } from "./statementSpans";

let views: EditorView[] = [];

function mount(doc: string, selection = 0): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: selection },
      extensions: editorExtensions(),
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function spansOf(view: EditorView) {
  return view.state.field(statementSpansField);
}

function type(view: EditorView, text: string, at = view.state.doc.length) {
  view.dispatch({ changes: { from: at, insert: text } });
}

function highlightedLines(view: EditorView): string[] {
  return [...view.dom.querySelectorAll(".cm-runRange")].map(
    (line) => line.textContent ?? "",
  );
}

/** 마이크로태스크를 비운다. 나누기 결과를 받아 dispatch할 때까지 기다린다. */
async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(splitStatements).mockResolvedValue([]);
});

afterEach(() => {
  for (const view of views) view.destroy();
  views = [];
  vi.useRealTimers();
});

test("splits_after_typing_stops", async () => {
  const view = mount("SELECT 1");
  await flush();
  vi.mocked(splitStatements).mockClear();

  type(view, "a");
  await vi.advanceTimersByTimeAsync(50);
  type(view, "b");
  await vi.advanceTimersByTimeAsync(50);
  type(view, "c");
  await vi.advanceTimersByTimeAsync(149);
  expect(splitStatements).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(splitStatements).toHaveBeenCalledTimes(1);
  expect(splitStatements).toHaveBeenCalledWith("SELECT 1abc");
});

test("opening_a_document_splits_it_once", async () => {
  vi.mocked(splitStatements).mockResolvedValue([{ start: 0, end: 8 }]);
  const view = mount("SELECT 1");
  expect(spansOf(view)).toEqual({ spans: null, fresh: false });

  await flush();

  expect(splitStatements).toHaveBeenCalledTimes(1);
  expect(spansOf(view)).toEqual({ spans: [{ start: 0, end: 8 }], fresh: true });
});

test("cursor_moves_do_not_split", async () => {
  const view = mount("SELECT 1;\nSELECT 2");
  await flush();
  expect(splitStatements).toHaveBeenCalledTimes(1);

  for (let i = 0; i < 100; i++) {
    view.dispatch({ selection: { anchor: i % 18 } });
  }
  await vi.advanceTimersByTimeAsync(1000);

  expect(splitStatements).toHaveBeenCalledTimes(1);
});

test("late_result_for_an_old_document_is_ignored", async () => {
  const first = deferred<StatementSpan[]>();
  vi.mocked(splitStatements).mockReturnValueOnce(first.promise);
  const view = mount("SELECT 1");
  vi.mocked(splitStatements).mockResolvedValue([{ start: 0, end: 9 }]);

  type(view, "2");
  first.resolve([{ start: 0, end: 8 }]);
  await flush();
  expect(spansOf(view).fresh).toBe(false);

  await vi.advanceTimersByTimeAsync(150);
  expect(spansOf(view)).toEqual({ spans: [{ start: 0, end: 9 }], fresh: true });
});

test("spans_follow_edits_until_resplit", async () => {
  vi.mocked(splitStatements).mockResolvedValue([{ start: 0, end: 8 }]);
  const view = mount("SELECT 1");
  await flush();

  type(view, "-- note\n", 0);

  expect(spansOf(view)).toEqual({
    spans: [{ start: 8, end: 16 }],
    fresh: false,
  });
});

test("a_failed_split_leaves_no_spans", async () => {
  vi.mocked(splitStatements).mockRejectedValue(
    new CommandError("split_failed", "unclosed"),
  );
  const view = mount("SELECT 'a");
  await flush();

  expect(spansOf(view)).toEqual({ spans: null, fresh: true });
});

test("highlights_the_lines_of_the_cursor_statement", async () => {
  vi.mocked(splitStatements).mockResolvedValue([
    { start: 0, end: 8 },
    { start: 10, end: 20 },
  ]);
  const view = mount("SELECT 1;\nSELECT\n  2;\nSELECT 3", 12);
  await flush();
  // 두 번째 문장 "SELECT\n  2"는 줄 둘에 걸친다.
  expect(highlightedLines(view)).toEqual(["SELECT", "  2;"]);

  view.dispatch({ selection: { anchor: 3 } });
  expect(highlightedLines(view)).toEqual(["SELECT 1;"]);
});

test("no_highlight_with_a_selection", async () => {
  vi.mocked(splitStatements).mockResolvedValue([{ start: 0, end: 8 }]);
  const view = mount("SELECT 1");
  await flush();
  expect(highlightedLines(view)).toEqual(["SELECT 1"]);

  view.dispatch({ selection: { anchor: 0, head: 3 } });

  expect(highlightedLines(view)).toEqual([]);
});

test("no_highlight_when_split_failed", async () => {
  vi.mocked(splitStatements).mockRejectedValue(
    new CommandError("split_failed", "unclosed"),
  );
  const view = mount("SELECT 'a");
  await flush();

  expect(highlightedLines(view)).toEqual([]);
});
