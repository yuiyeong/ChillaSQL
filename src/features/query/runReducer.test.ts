import { expect, test } from "vitest";
import type { QueryEvent } from "../../shared/api/types";
import { emptyResult, reduce, type RunState } from "./runReducer";

const origin = { line: 1, column: 1 };

function running(): RunState {
  return { status: "running", result: emptyResult("SELECT 1", origin) };
}

test("columns, rows, finished를 차례로 쌓는다", () => {
  let state = running();
  state = reduce(state, {
    type: "columns",
    columns: [{ name: "id" }, { name: "name" }],
  });
  state = reduce(state, {
    type: "rows",
    firstRow: 0,
    rows: [["1", "a"]],
    retainedFrom: 0,
    elapsedMicros: 100,
  });
  state = reduce(state, {
    type: "rows",
    firstRow: 1,
    rows: [["2", null]],
    retainedFrom: 0,
    elapsedMicros: 200,
  });
  state = reduce(state, {
    type: "finished",
    elapsedMicros: 300,
    outcome: "completed",
    rows: 2,
  });

  expect(state).toEqual({
    status: "finished",
    result: {
      sql: "SELECT 1",
      origin,
      columns: ["id", "name"],
      firstRow: 0,
      rows: [
        ["1", "a"],
        ["2", null],
      ],
      elapsedMicros: 300,
    },
    outcome: { outcome: "completed", rows: 2 },
  });
});

test("retainedFrom보다 앞의 행을 버린다", () => {
  let state = reduce(running(), {
    type: "rows",
    firstRow: 0,
    rows: [["a"], ["b"], ["c"]],
    retainedFrom: 0,
    elapsedMicros: 10,
  });
  state = reduce(state, {
    type: "rows",
    firstRow: 3,
    rows: [["d"]],
    retainedFrom: 2,
    elapsedMicros: 20,
  });

  expect(state.status).toBe("running");
  if (state.status !== "running") return;
  expect(state.result.rows).toEqual([["c"], ["d"]]);
  expect(state.result.firstRow).toBe(2);
  expect(state.result.elapsedMicros).toBe(20);
});

test("running이 아닌 상태는 event를 무시한다", () => {
  const idle: RunState = { status: "idle" };
  const finished: RunState = {
    status: "finished",
    result: emptyResult("SELECT 1", origin),
    outcome: { outcome: "discarded" },
  };
  const rejected: RunState = { status: "rejected", message: "거절" };
  const rows: QueryEvent = {
    type: "rows",
    firstRow: 0,
    rows: [["a"]],
    retainedFrom: 0,
    elapsedMicros: 1,
  };

  for (const state of [idle, finished, rejected]) {
    expect(reduce(state, rows)).toBe(state);
    expect(
      reduce(state, {
        type: "finished",
        elapsedMicros: 2,
        outcome: "cancelled",
      }),
    ).toBe(state);
  }
});
