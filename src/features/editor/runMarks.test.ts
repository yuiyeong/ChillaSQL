import { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import { executeQuery, openSession } from "../../shared/api/commands";
import type { QueryEvent } from "../../shared/api/types";
import { useRuns } from "../query/runsStore";
import {
  attachView,
  closeDocument,
  detachView,
  documentState,
  openDocument,
  setDocumentState,
} from "./documents";
import {
  anchorOf,
  errorRange,
  markRunStart,
  markServerError,
  runMarksField,
  setErrorMark,
  setRunAnchor,
} from "./runMarks";

const TEXT = "SELECT 1;\nSELEC 2";
let views: EditorView[] = [];

/** 탭 문서를 열고 보여 준다. SqlEditor처럼 dispatch한 state를 documents에 따라 둔다. */
function show(tabId: string, text: string): EditorView {
  openDocument(tabId, text);
  const view = new EditorView({
    state: documentState(tabId),
    parent: document.body,
    dispatchTransactions(trs, v) {
      v.update(trs);
      setDocumentState(tabId, v.state);
    },
  });
  attachView(view, tabId);
  views.push(view);
  return view;
}

function dispatch(tabId: string, spec: Parameters<EditorView["dispatch"]>[0]) {
  const view = views.find((v) => v.state === documentState(tabId));
  if (view !== undefined) view.dispatch(spec);
  else setDocumentState(tabId, documentState(tabId).update(spec).state);
}

function marks(tabId: string) {
  return documentState(tabId).field(runMarksField);
}

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  for (const view of views) {
    detachView(view);
    view.destroy();
  }
  views = [];
  closeDocument("t");
});

test("anchor_moves_with_edits_before_it", () => {
  show("t", TEXT);
  dispatch("t", { effects: setRunAnchor.of({ runKey: "k", from: 10 }) });
  expect(anchorOf("t", "k")).toBe(10);

  dispatch("t", { changes: { from: 0, insert: "-- hi\n" } });
  expect(anchorOf("t", "k")).toBe(16);

  // 문장 시작에서 줄을 넣어도 문장이 밀린다.
  dispatch("t", { changes: { from: 16, insert: "\n" } });
  expect(anchorOf("t", "k")).toBe(17);

  // 문장 뒤의 편집은 옮기지 않는다.
  dispatch("t", {
    changes: { from: documentState("t").doc.length, insert: "x" },
  });
  expect(anchorOf("t", "k")).toBe(17);
});

test("anchor_moves_in_a_tab_that_is_not_shown", () => {
  openDocument("t", TEXT);
  markRunStart("t", [{ runKey: "k", from: 10 }]);

  dispatch("t", { changes: { from: 0, insert: "\n" } });

  expect(anchorOf("t", "k")).toBe(11);
});

test("anchor_is_null_when_its_text_is_deleted", () => {
  show("t", TEXT);
  dispatch("t", { effects: setRunAnchor.of({ runKey: "k", from: 10 }) });

  dispatch("t", { changes: { from: 8, to: 14 } });

  expect(anchorOf("t", "k")).toBeNull();
  // 지운 뒤 다시 쓴 text를 가리키지 않는다.
  dispatch("t", { changes: { from: 8, insert: "SELEC" } });
  expect(anchorOf("t", "k")).toBeNull();
});

test("anchor_stays_when_the_deletion_starts_at_it", () => {
  show("t", TEXT);
  dispatch("t", { effects: setRunAnchor.of({ runKey: "k", from: 10 }) });

  // 문장의 앞 글자만 지우면 문장은 남아 있으므로 시작은 그 자리다.
  dispatch("t", { changes: { from: 10, to: 12 } });

  expect(anchorOf("t", "k")).toBe(10);
});

test("anchor_is_null_for_a_closed_document_or_unknown_run", () => {
  expect(anchorOf("t", "k")).toBeNull();
  show("t", TEXT);
  expect(anchorOf("t", "k")).toBeNull();
});

test("underline_covers_the_word", () => {
  const view = show("t", TEXT);
  markRunStart("t", [{ runKey: "k", from: 10 }]);

  markServerError("t", "k", 0);

  expect(marks("t").error).toEqual({ from: 10, to: 15 });
  const marked = [...view.dom.querySelectorAll(".cm-errorMark")];
  expect(marked.map((el) => el.textContent)).toEqual(["SELEC"]);
});

test("underline_follows_edits_above_it", () => {
  show("t", TEXT);
  markRunStart("t", [{ runKey: "k", from: 10 }]);
  markServerError("t", "k", 0);

  dispatch("t", { changes: { from: 0, insert: "\n" } });
  // 밑줄 시작 앞에 줄을 넣는 것은 밑줄을 건드리지 않는다.
  dispatch("t", { changes: { from: 11, insert: "\n" } });

  expect(marks("t").error).toEqual({ from: 12, to: 17 });
});

test("underline_after_hangul_and_emoji", () => {
  const text = "SELECT '한글😀', xx FRM yy";
  const doc = Text.of([text]);
  const at = text.indexOf("FRM");
  // JS의 UTF-16 offset이 곧 서버(Rust)가 보내는 offset이다.
  expect(at).toBe(18);

  expect(errorRange(doc, at)).toEqual({ from: 18, to: 21 });
  // 단어 중간에서 시작하면 거기서 단어 끝까지다.
  expect(errorRange(doc, at + 1)).toEqual({ from: 19, to: 21 });
  // 한글도 단어다.
  expect(errorRange(Text.of(["SELECT 한글 FROM"]), 7)).toEqual({
    from: 7,
    to: 9,
  });
});

test("underline_is_one_character_when_not_a_word", () => {
  const doc = Text.of(["SELECT (1,, 2)"]);
  expect(errorRange(doc, 10)).toEqual({ from: 10, to: 11 });
  // surrogate pair는 한 글자다.
  expect(errorRange(Text.of(["a😀b"]), 1)).toEqual({ from: 1, to: 3 });
});

test("underline_at_the_end_of_a_line_falls_back_to_the_last_character", () => {
  const text = "SELECT '한글😀', x FROM";
  expect(errorRange(Text.of([text]), text.length)).toEqual({
    from: text.length - 1,
    to: text.length,
  });
  expect(errorRange(Text.of(["a😀", "b"]), 3)).toEqual({ from: 1, to: 3 });
  // 빈 줄이면 긋지 않는다.
  expect(errorRange(Text.of(["a", "", "b"]), 2)).toEqual({ from: 2, to: 2 });
  // 문서 밖의 위치는 문서 끝으로 본다.
  expect(errorRange(Text.of(["ab"]), 99)).toEqual({ from: 1, to: 2 });
});

test("editing_inside_the_mark_clears_it", () => {
  const view = show("t", TEXT);
  markRunStart("t", [{ runKey: "k", from: 10 }]);
  markServerError("t", "k", 0);

  dispatch("t", { changes: { from: 12, insert: "x" } });

  expect(marks("t").error).toBeNull();
  expect(view.dom.querySelector(".cm-errorMark")).toBeNull();
});

test("editing_at_the_end_of_the_mark_clears_it_but_the_start_does_not", () => {
  show("t", TEXT);
  markRunStart("t", [{ runKey: "k", from: 10 }]);
  markServerError("t", "k", 0);

  dispatch("t", { changes: { from: 10, insert: "x" } });
  expect(marks("t").error).toEqual({ from: 11, to: 16 });

  // 단어를 늘리거나 고치면 지운다.
  dispatch("t", { changes: { from: 16, insert: "T" } });
  expect(marks("t").error).toBeNull();
});

test("deleting_part_of_the_mark_clears_it", () => {
  show("t", TEXT);
  dispatch("t", {
    effects: setErrorMark.of({ from: 10, to: 15 }),
  });

  dispatch("t", { changes: { from: 4, to: 11 } });

  expect(marks("t").error).toBeNull();
});

test("next_run_clears_it", async () => {
  vi.mocked(openSession).mockResolvedValue({
    id: 3,
    connection: "local",
    backendPid: 1,
  });
  vi.mocked(executeQuery).mockResolvedValue(7);
  const view = show("t", TEXT);
  const run = (sql: string, from: number) =>
    useRuns.getState().run("t", () => ({
      connection: "local",
      steps: [{ sql, from, origin: { line: 1, column: 1 } }],
    }));

  await run("SELEC 2", 10);
  const first = useRuns.getState().runs.t;
  const key = first.status === "running" ? first.result.runKey : "";
  const onEvent = vi.mocked(executeQuery).mock.calls[0][3];
  const failed: QueryEvent = {
    type: "finished",
    tx: "idle",
    elapsedMicros: 5,
    outcome: "failed",
    error: {
      code: "42601",
      message: 'syntax error at or near "SELEC"',
      detail: null,
      hint: null,
      position: 0,
    },
  };
  onEvent(failed);
  expect(anchorOf("t", key)).toBe(10);
  expect(view.dom.querySelector(".cm-errorMark")?.textContent).toBe("SELEC");

  await run("SELECT 1", 0);

  expect(view.dom.querySelector(".cm-errorMark")).toBeNull();
  expect(marks("t").error).toBeNull();
  // 지난 실행의 anchor는 새 실행이 대신한다.
  expect(anchorOf("t", key)).toBeNull();
  const second = useRuns.getState().runs.t;
  expect(
    second.status === "running" && anchorOf("t", second.result.runKey),
  ).toBe(0);
});

test("a_late_error_of_a_superseded_run_draws_nothing", async () => {
  vi.mocked(openSession).mockResolvedValue({
    id: 3,
    connection: "local",
    backendPid: 1,
  });
  vi.mocked(executeQuery).mockResolvedValue(7);
  show("t", TEXT);
  const run = (sql: string, from: number) =>
    useRuns.getState().run("t", () => ({
      connection: "local",
      steps: [{ sql, from, origin: { line: 1, column: 1 } }],
    }));
  await run("SELEC 2", 10);
  await run("SELECT 1", 0);

  vi.mocked(executeQuery).mock.calls[0][3]({
    type: "finished",
    tx: "idle",
    elapsedMicros: 5,
    outcome: "failed",
    error: {
      code: "42601",
      message: "x",
      detail: null,
      hint: null,
      position: 0,
    },
  });

  expect(marks("t").error).toBeNull();
});
