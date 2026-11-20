import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApplyResult } from "../../shared/api/types";
import { deferred } from "../../test/deferred";
import type { UpdateStatement } from "./editSql";
import { changedCount, useEdits } from "./editsStore";
import { useRuns } from "./runsStore";

function editsOf(tabId = "t") {
  return useEdits.getState().edits[tabId];
}

const realApplyEdits = useRuns.getInitialState().applyEdits;

beforeEach(() => {
  useEdits.getState().reset();
});

afterEach(() => {
  useRuns.setState({ applyEdits: realApplyEdits, runs: {}, ending: {} });
});

test("keeps_the_new_value_by_row_and_attnum", () => {
  useEdits.getState().setCell("t", "run-1", 4, 2, "new", "old");

  expect(editsOf()).toEqual({
    runKey: "run-1",
    changes: new Map([[4, new Map([[2, "new"]])]]),
  });
});

test("same_as_original_removes_the_change", () => {
  const { setCell } = useEdits.getState();
  setCell("t", "run-1", 4, 2, "new", "old");
  setCell("t", "run-1", 4, 3, "x", "y");

  setCell("t", "run-1", 4, 2, "old", "old");

  expect(editsOf()?.changes).toEqual(new Map([[4, new Map([[3, "x"]])]]));

  setCell("t", "run-1", 4, 3, "y", "y");
  expect(changedCount(editsOf())).toBe(0);
});

test("null_cell_left_empty_stays_null", () => {
  useEdits.getState().setCell("t", "run-1", 0, 2, "", null);

  expect(changedCount(editsOf())).toBe(0);

  // 빈 문자열이던 셀을 비우는 것도 변경이 아니고, 값이 있던 셀을 비우면 빈 문자열이다.
  useEdits.getState().setCell("t", "run-1", 0, 3, "", "");
  useEdits.getState().setCell("t", "run-1", 0, 4, "", "a");
  expect(editsOf()?.changes).toEqual(new Map([[0, new Map([[4, ""]])]]));
});

test("set_null_is_a_change_of_a_non_null_cell", () => {
  useEdits.getState().setCell("t", "run-1", 0, 2, null, "a");

  expect(editsOf()?.changes.get(0)?.get(2)).toBeNull();
  expect(changedCount(editsOf())).toBe(1);
});

test("another_run_key_drops_old_changes", () => {
  const { setCell } = useEdits.getState();
  setCell("t", "run-1", 0, 2, "a", "x");
  setCell("t", "run-1", 1, 2, "b", "x");

  setCell("t", "run-2", 5, 3, "c", "x");

  expect(editsOf()).toEqual({
    runKey: "run-2",
    changes: new Map([[5, new Map([[3, "c"]])]]),
  });
});

test("count_counts_cells", () => {
  const { setCell } = useEdits.getState();
  setCell("t", "run-1", 0, 2, "a", "x");
  setCell("t", "run-1", 0, 3, "b", "x");
  setCell("t", "run-1", 7, 2, "c", "x");

  expect(changedCount(editsOf())).toBe(3);
  expect(changedCount(undefined)).toBe(0);
});

test("revert_cell_and_revert_all", () => {
  const { setCell, revertCell, revertAll } = useEdits.getState();
  setCell("t", "run-1", 0, 2, "a", "x");
  setCell("t", "run-1", 1, 2, "b", "x");

  revertCell("t", 0, 2);
  expect(editsOf()?.changes).toEqual(new Map([[1, new Map([[2, "b"]])]]));

  revertAll("t");
  expect(editsOf()).toBeUndefined();
});

test("tabs_are_kept_apart_and_drop_forgets_one_tab", () => {
  const { setCell, drop } = useEdits.getState();
  setCell("a", "run-1", 0, 2, "a", "x");
  setCell("b", "run-9", 0, 2, "b", "x");

  drop("a");

  expect(editsOf("a")).toBeUndefined();
  expect(changedCount(editsOf("b"))).toBe(1);

  useEdits.getState().reset();
  expect(useEdits.getState().edits).toEqual({});
});

test("unchanged_rows_keep_their_map", () => {
  const { setCell } = useEdits.getState();
  setCell("t", "run-1", 0, 2, "a", "x");
  const first = editsOf()?.changes.get(0);

  setCell("t", "run-1", 1, 2, "b", "x");

  // 바뀌지 않은 행의 Map은 그대로라 그 행은 다시 그리지 않는다.
  expect(editsOf()?.changes.get(0)).toBe(first);
});

/** 결과 행 4와 7(0부터)을 고치는 두 문장 */
const statements: UpdateStatement[] = [
  {
    row: 4,
    sql: "UPDATE a SET b = 'x' WHERE id = 5 RETURNING b;",
    attnums: [2],
  },
  {
    row: 7,
    sql: "UPDATE a SET b = 'y' WHERE id = 8 RETURNING b;",
    attnums: [2],
  },
];

/** 탭 t의 run-1에서 행 4와 7을 고치고, runsStore.applyEdits가 `answer`로 답하게 한다. */
function changedAndAnswering(
  answer: ApplyResult | Promise<ApplyResult | null>,
) {
  useEdits.getState().setCell("t", "run-1", 4, 2, "x", "old");
  useEdits.getState().setCell("t", "run-1", 7, 2, "y", "old");
  const applyEdits = vi.fn(() => Promise.resolve(answer));
  useRuns.setState({ applyEdits });
  return applyEdits;
}

const serverError = {
  code: "22001",
  message: "value too long for type character varying(3)",
  detail: null,
  hint: null,
  position: null,
};

test("applied_clears_changes_and_toasts", async () => {
  const applyEdits = changedAndAnswering({
    outcome: "applied",
    tx: "idle",
    rows: [["x"], ["y"]],
  });

  await expect(useEdits.getState().apply("t", statements)).resolves.toBe(
    "Updated 2 rows",
  );

  expect(applyEdits).toHaveBeenCalledWith("t", "run-1", statements);
  expect(editsOf()).toBeUndefined();
  expect(useEdits.getState().failure.t).toBeUndefined();
  expect(useEdits.getState().applying.t).toBeUndefined();
});

test("not_found_keeps_the_changes_and_names_the_row", async () => {
  changedAndAnswering({
    outcome: "wrong_row_count",
    index: 1,
    rows: 0,
    tx: "idle",
  });

  await expect(useEdits.getState().apply("t", statements)).resolves.toBeNull();

  expect(useEdits.getState().failure.t).toBe(
    "Row 8 was not found. It may have been deleted or its key changed. Nothing was applied.",
  );
  expect(changedCount(editsOf())).toBe(2);
});

test("matched_many_names_the_row_and_count", async () => {
  changedAndAnswering({
    outcome: "wrong_row_count",
    index: 0,
    rows: 1200,
    tx: "idle",
  });

  await useEdits.getState().apply("t", statements);

  expect(useEdits.getState().failure.t).toBe(
    "Row 5 matched 1,200 rows. Nothing was applied.",
  );
  expect(changedCount(editsOf())).toBe(2);
});

test("server_error_names_the_row", async () => {
  changedAndAnswering({
    outcome: "failed",
    index: 0,
    error: serverError,
    tx: "idle",
  });

  await useEdits.getState().apply("t", statements);

  expect(useEdits.getState().failure.t).toBe(
    "Row 5: value too long for type character varying(3). Nothing was applied.",
  );
  expect(changedCount(editsOf())).toBe(2);
});

test("commit_error_has_no_row", async () => {
  changedAndAnswering({
    outcome: "failed",
    index: null,
    error: { ...serverError, message: "could not serialize access" },
    tx: "idle",
  });

  await useEdits.getState().apply("t", statements);

  expect(useEdits.getState().failure.t).toBe(
    "could not serialize access. Nothing was applied.",
  );
});

test("transaction_failed_is_explained", async () => {
  changedAndAnswering({ outcome: "transaction_failed", tx: "failed" });

  await useEdits.getState().apply("t", statements);

  expect(useEdits.getState().failure.t).toBe(
    "Roll back the failed transaction first.",
  );
  expect(changedCount(editsOf())).toBe(2);
});

test("busy_keeps_the_changes_with_a_note", async () => {
  changedAndAnswering({ outcome: "busy", tx: null });

  await useEdits.getState().apply("t", statements);

  expect(useEdits.getState().failure.t).toBe(
    "Another query is still running on this session. Nothing was applied.",
  );
  expect(changedCount(editsOf())).toBe(2);
});

test("not_sent_without_a_session_explains_it", async () => {
  changedAndAnswering(Promise.resolve(null));

  await expect(useEdits.getState().apply("t", statements)).resolves.toBeNull();

  expect(useEdits.getState().failure.t).toBe(
    "This tab has no open session. Run the query again, then edit. Nothing was applied.",
  );
  expect(changedCount(editsOf())).toBe(2);
});

test("not_sent_while_running_or_ending_has_no_note", async () => {
  changedAndAnswering(Promise.resolve(null));
  useRuns.setState({ runs: { t: { status: "connecting" } } });

  await useEdits.getState().apply("t", statements);
  expect(useEdits.getState().failure.t).toBeUndefined();

  useRuns.setState({ runs: {}, ending: { t: {} } });
  await useEdits.getState().apply("t", statements);
  expect(useEdits.getState().failure.t).toBeUndefined();
  expect(changedCount(editsOf())).toBe(2);
});

test("the_old_failure_stays_until_the_answer", async () => {
  changedAndAnswering({ outcome: "transaction_failed", tx: "failed" });
  await useEdits.getState().apply("t", statements);
  const answer = deferred<ApplyResult | null>();
  useRuns.setState({ applyEdits: vi.fn(() => answer.promise) });

  const applying = useEdits.getState().apply("t", statements);
  expect(useEdits.getState().failure.t).toBe(
    "Roll back the failed transaction first.",
  );

  answer.resolve({ outcome: "applied", tx: "idle", rows: [["x"], ["y"]] });
  await applying;
  expect(useEdits.getState().failure.t).toBeUndefined();
});

test("a_cell_edited_during_apply_stays_changed", async () => {
  const answer = deferred<ApplyResult | null>();
  changedAndAnswering(answer.promise);

  const applying = useEdits.getState().apply("t", statements);
  useEdits.getState().setCell("t", "run-1", 4, 3, "new", "old");
  answer.resolve({ outcome: "applied", tx: "idle", rows: [["x"], ["y"]] });

  await expect(applying).resolves.toBe("Updated 2 rows");
  expect(editsOf()?.changes).toEqual(new Map([[4, new Map([[3, "new"]])]]));
});

test("a_sent_cell_edited_again_during_apply_keeps_the_new_value", async () => {
  const answer = deferred<ApplyResult | null>();
  changedAndAnswering(answer.promise);

  const applying = useEdits.getState().apply("t", statements);
  useEdits.getState().setCell("t", "run-1", 7, 2, "y2", "old");
  answer.resolve({ outcome: "applied", tx: "idle", rows: [["x"], ["y"]] });

  await applying;
  expect(editsOf()?.changes).toEqual(new Map([[7, new Map([[2, "y2"]])]]));
});

test("revert_during_apply_loses_nothing", async () => {
  const answer = deferred<ApplyResult | null>();
  changedAndAnswering(answer.promise);

  const applying = useEdits.getState().apply("t", statements);
  useEdits.getState().revertAll("t");
  answer.resolve({ outcome: "applied", tx: "idle", rows: [["x"], ["y"]] });

  await expect(applying).resolves.toBeNull();
  expect(editsOf()).toBeUndefined();
  expect(useEdits.getState().applying.t).toBeUndefined();
});

test("apply_is_ignored_while_applying", async () => {
  const answer = deferred<ApplyResult | null>();
  const applyEdits = changedAndAnswering(answer.promise);

  const first = useEdits.getState().apply("t", statements);
  expect(useEdits.getState().applying.t).toBe(true);
  await expect(useEdits.getState().apply("t", statements)).resolves.toBeNull();
  expect(applyEdits).toHaveBeenCalledTimes(1);

  answer.resolve({ outcome: "applied", tx: "idle", rows: [["x"], ["y"]] });
  await expect(first).resolves.toBe("Updated 2 rows");
  expect(useEdits.getState().applying.t).toBeUndefined();
});

test("a_new_apply_or_edit_clears_the_failure", async () => {
  changedAndAnswering({ outcome: "transaction_failed", tx: "failed" });
  await useEdits.getState().apply("t", statements);
  expect(useEdits.getState().failure.t).toBeDefined();

  useEdits.getState().setCell("t", "run-1", 4, 2, "z", "old");
  expect(useEdits.getState().failure.t).toBeUndefined();

  await useEdits.getState().apply("t", statements);
  useEdits.getState().drop("t");
  expect(useEdits.getState().failure.t).toBeUndefined();
});

test("apply_without_changes_sends_nothing", async () => {
  const applyEdits = vi.fn();
  useRuns.setState({ applyEdits });

  await expect(useEdits.getState().apply("t", statements)).resolves.toBeNull();

  expect(applyEdits).not.toHaveBeenCalled();
});
