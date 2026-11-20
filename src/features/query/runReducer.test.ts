import { expect, test } from "vitest";
import type { Outcome, QueryEvent } from "../../shared/api/types";
import { resultColumns } from "../../test/fixtures";
import {
  emptyResult,
  isPartialResult,
  reduce,
  requestFetch,
  type RunState,
} from "./runReducer";

const origin = { line: 1, column: 1 };

function running(): RunState {
  return {
    status: "running",
    result: emptyResult({ sql: "SELECT 1", from: 0, origin }, "run-0", 1000),
  };
}

test("columns_keep_their_types", () => {
  const state = reduce(running(), {
    type: "columns",
    columns: [
      {
        name: "id",
        typeOid: 23,
        typeModifier: -1,
        tableOid: 0,
        columnNumber: 0,
      },
      {
        name: "name",
        typeOid: 1043,
        typeModifier: 259,
        tableOid: 0,
        columnNumber: 0,
      },
    ],
  });
  expect(state).toMatchObject({
    result: {
      columns: [
        {
          name: "id",
          typeOid: 23,
          typeModifier: -1,
          tableOid: 0,
          columnNumber: 0,
        },
        {
          name: "name",
          typeOid: 1043,
          typeModifier: 259,
          tableOid: 0,
          columnNumber: 0,
        },
      ],
    },
  });
});

test("columns, rows, finished를 차례로 쌓는다", () => {
  let state = running();
  state = reduce(state, {
    type: "columns",
    columns: resultColumns("id", "name"),
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
    tx: "idle",
    elapsedMicros: 300,
    outcome: "completed",
    rows: 2,
  });

  expect(state).toEqual({
    status: "finished",
    result: {
      sql: "SELECT 1",
      runKey: "run-0",
      from: 0,
      origin,
      columns: resultColumns("id", "name"),
      firstRow: 0,
      rows: [
        ["1", "a"],
        ["2", null],
      ],
      elapsedMicros: 300,
      fetch: "none",
      startedAt: 1000,
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

test("버릴 행이 보관한 행보다 많으면 새 batch의 앞도 버린다", () => {
  let state = reduce(running(), {
    type: "rows",
    firstRow: 0,
    rows: [["a"], ["b"]],
    retainedFrom: 0,
    elapsedMicros: 10,
  });
  state = reduce(state, {
    type: "rows",
    firstRow: 2,
    rows: [["c"], ["d"], ["e"]],
    retainedFrom: 3,
    elapsedMicros: 20,
  });

  expect(state.status === "running" && state.result).toMatchObject({
    firstRow: 3,
    rows: [["d"], ["e"]],
  });
});

test("앞 행을 버리지 않으면 받은 행을 뒤에 붙인다", () => {
  const first = reduce(running(), {
    type: "rows",
    firstRow: 0,
    rows: [["a"]],
    retainedFrom: 0,
    elapsedMicros: 10,
  });
  const second = reduce(first, {
    type: "rows",
    firstRow: 1,
    rows: [["b"]],
    retainedFrom: 0,
    elapsedMicros: 20,
  });

  expect(second.status === "running" && second.result.rows).toEqual([
    ["a"],
    ["b"],
  ]);
  // 앞 state의 배열은 그대로다.
  expect(first.status === "running" && first.result.rows).toEqual([["a"]]);
});

test("끝나면 가져오는 중이었어도 fetch가 none이다", () => {
  const fetching = requestFetch(reduce(running(), rowsEvent));
  const state = reduce(fetching, {
    type: "finished",
    tx: "idle",
    elapsedMicros: 2,
    outcome: "cancelled",
  });

  expect(state.status).toBe("finished");
  expect(state.status === "finished" && state.result.fetch).toBe("none");
});

test("expired면 받은 행을 남기고 더 가져오지 않는다", () => {
  const state = reduce(reduce(running(), rowsEvent), {
    type: "finished",
    tx: "in_transaction",
    elapsedMicros: 2,
    outcome: "expired",
  });

  expect(state).toEqual({
    status: "finished",
    result: {
      ...emptyResult({ sql: "SELECT 1", from: 0, origin }, "run-0", 1000),
      rows: [["a"]],
      elapsedMicros: 2,
      fetch: "none",
    },
    outcome: { outcome: "expired" },
  });
});

test("running이 아닌 상태는 event를 무시한다", () => {
  const idle: RunState = { status: "idle" };
  const finished: RunState = {
    status: "finished",
    result: emptyResult({ sql: "SELECT 1", from: 0, origin }, "run-0", 1000),
    outcome: { outcome: "discarded" },
  };
  const rejected: RunState = {
    status: "rejected",
    rejection: { title: "거절", detail: null },
  };
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
        tx: "idle",
        elapsedMicros: 2,
        outcome: "cancelled",
      }),
    ).toBe(state);
  }
});

const rowsEvent: QueryEvent = {
  type: "rows",
  firstRow: 0,
  rows: [["a"]],
  retainedFrom: 0,
  elapsedMicros: 1,
};

test("emptyResult는 fetch none과 startedAt을 갖는다", () => {
  expect(
    emptyResult({ sql: "SELECT 1", from: 0, origin }, "run-0", 42),
  ).toMatchObject({
    fetch: "none",
    startedAt: 42,
  });
});

test("rows event는 fetch를 ready로 둔다", () => {
  const state = reduce(running(), rowsEvent);

  expect(state.status === "running" && state.result.fetch).toBe("ready");
});

test("requestFetch는 ready일 때만 fetching으로 바꾼다", () => {
  const ready = reduce(running(), rowsEvent);
  const fetching = requestFetch(ready);
  expect(fetching).not.toBe(ready);
  expect(fetching.status === "running" && fetching.result.fetch).toBe(
    "fetching",
  );

  // 이미 fetching이거나 none이거나 끝난 state는 같은 object다.
  expect(requestFetch(fetching)).toBe(fetching);
  const none = running();
  expect(requestFetch(none)).toBe(none);
  const finished = reduce(ready, {
    type: "finished",
    tx: "idle",
    elapsedMicros: 2,
    outcome: "completed",
    rows: 1,
  });
  expect(requestFetch(finished)).toBe(finished);
});

test("rows가 오면 fetching에서 ready로 돌아간다", () => {
  const fetching = requestFetch(reduce(running(), rowsEvent));
  const state = reduce(fetching, { ...rowsEvent, firstRow: 1 });

  expect(state.status === "running" && state.result.fetch).toBe("ready");
});

test("partial_result_is_running_stopped_dropped_or_drained", () => {
  const result = emptyResult({ sql: "SELECT 1", from: 0, origin }, "r", 1);
  const rows = [["1"], ["2"]];
  const done = (outcome: Outcome, patch: Partial<typeof result> = {}) =>
    isPartialResult({
      status: "finished",
      result: { ...result, rows, ...patch },
      outcome,
    });

  expect(isPartialResult({ status: "running", result })).toBe(true);
  expect(done({ outcome: "cancelled" })).toBe(true);
  expect(done({ outcome: "expired" })).toBe(true);
  // 끝까지 받았지만 앞 행을 버렸다.
  expect(done({ outcome: "completed", rows: 5 }, { firstRow: 3 })).toBe(true);
  // 여러 문장의 앞 문장은 첫 batch만 받는다.
  expect(done({ outcome: "completed", rows: 900 })).toBe(true);
  expect(done({ outcome: "completed", rows: 2 })).toBe(false);
  expect(isPartialResult({ status: "idle" })).toBe(false);
});
