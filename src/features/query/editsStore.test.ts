import { beforeEach, expect, test } from "vitest";
import { changedCount, useEdits } from "./editsStore";

function editsOf(tabId = "t") {
  return useEdits.getState().edits[tabId];
}

beforeEach(() => {
  useEdits.getState().reset();
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
