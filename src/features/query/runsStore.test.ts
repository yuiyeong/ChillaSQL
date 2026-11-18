import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import {
  cancelQuery,
  closeSession,
  executeQuery,
  fetchMore,
  openSession,
} from "../../shared/api/commands";
import { CommandError } from "../../shared/api/errors";
import type { QueryEvent, Session } from "../../shared/api/types";
import type { Rejection } from "./runReducer";
import { useRuns, type Prepare, type RunRequest } from "./runsStore";
import { deferred } from "../../test/deferred";

function session(id: number, connection = "local"): Session {
  return { id, connection, backendPid: 100 + id };
}

/** 바로 이 문장을 실행하게 하는 prepare. */
function prepared(sql = "SELECT 1", connection = "local"): Prepare {
  return () => ({ connection, sql, origin: { line: 1, column: 1 } });
}

const origin = { line: 1, column: 1 };

function runOf(tabId: string) {
  return useRuns.getState().runs[tabId];
}

/** n번째(0부터) executeQuery 호출에 넘긴 onEvent. */
function onEventOf(call: number): (event: QueryEvent) => void {
  return vi.mocked(executeQuery).mock.calls[call][2];
}

const rowsEvent: QueryEvent = {
  type: "rows",
  firstRow: 0,
  rows: [["1"]],
  retainedFrom: 0,
  elapsedMicros: 10,
};

beforeEach(async () => {
  // 앞 test의 세션을 닫는 호출이 mock 기록을 지우기 전에 끝나게 한다.
  await useRuns.getState().reset();
  vi.resetAllMocks();
  vi.mocked(openSession).mockResolvedValue(session(3));
  vi.mocked(executeQuery).mockResolvedValue(7);
  vi.mocked(closeSession).mockResolvedValue();
  vi.mocked(cancelQuery).mockResolvedValue();
  vi.mocked(fetchMore).mockResolvedValue();
});

test("첫 실행은 세션을 열고 그 세션으로 실행한다", async () => {
  await useRuns.getState().run("t", prepared("SELECT 1"));

  expect(openSession).toHaveBeenCalledTimes(1);
  expect(openSession).toHaveBeenCalledWith("local");
  expect(executeQuery).toHaveBeenCalledWith(
    3,
    "SELECT 1",
    expect.any(Function),
  );
  expect(runOf("t")).toEqual({
    status: "running",
    result: {
      sql: "SELECT 1",
      origin: { line: 1, column: 1 },
      columns: null,
      firstRow: 0,
      rows: [],
      elapsedMicros: null,
      fetch: "none",
      startedAt: expect.any(Number),
    },
  });
});

test("같은 탭의 다음 실행은 세션을 다시 쓴다", async () => {
  await useRuns.getState().run("t", prepared("SELECT 1"));
  await useRuns.getState().run("t", prepared("SELECT 2"));

  expect(openSession).toHaveBeenCalledTimes(1);
  expect(executeQuery).toHaveBeenCalledTimes(2);
  expect(executeQuery).toHaveBeenLastCalledWith(
    3,
    "SELECT 2",
    expect.any(Function),
  );
});

test("연결 중에 한 번 더 실행해도 세션은 하나다", async () => {
  const opening = deferred<Session>();
  vi.mocked(openSession).mockReturnValue(opening.promise);

  const first = useRuns.getState().run("t", prepared("SELECT 1"));
  const second = useRuns.getState().run("t", prepared("SELECT 2"));

  expect(openSession).toHaveBeenCalledTimes(1);
  expect(runOf("t")).toEqual({ status: "connecting" });

  opening.resolve(session(3));
  await Promise.all([first, second]);

  expect(openSession).toHaveBeenCalledTimes(1);
  expect(executeQuery).toHaveBeenCalledTimes(1);
  expect(executeQuery).toHaveBeenCalledWith(
    3,
    "SELECT 2",
    expect.any(Function),
  );
  const state = runOf("t");
  expect(state.status === "running" && state.result.sql).toBe("SELECT 2");
});

test("앞 실행의 늦은 event는 새 실행의 상태를 바꾸지 않는다", async () => {
  await useRuns.getState().run("t", prepared("SELECT 1"));
  const lateA = onEventOf(0);
  await useRuns.getState().run("t", prepared("SELECT 2"));
  const stateB = runOf("t");
  expect(stateB.status === "running" && stateB.result.sql).toBe("SELECT 2");

  lateA(rowsEvent);
  lateA({ type: "finished", elapsedMicros: 5, outcome: "discarded" });

  expect(runOf("t")).toBe(stateB);
});

test("event는 execute가 query id를 돌려주기 전에도 반영된다", async () => {
  const execution = deferred<number>();
  vi.mocked(executeQuery).mockReturnValue(execution.promise);

  const running = useRuns.getState().run("t", prepared());
  await vi.waitFor(() => expect(executeQuery).toHaveBeenCalled());
  const onEvent = onEventOf(0);
  onEvent({ type: "columns", columns: [{ name: "id" }] });
  onEvent(rowsEvent);

  const state = runOf("t");
  expect(state.status).toBe("running");
  if (state.status !== "running") return;
  expect(state.result.columns).toEqual(["id"]);
  expect(state.result.rows).toEqual([["1"]]);

  execution.resolve(7);
  await running;
});

test("접속 실패는 rejected이고 다음 실행에서 다시 연다", async () => {
  vi.mocked(openSession).mockRejectedValueOnce(
    new CommandError("unreachable", "서버에 닿지 못했습니다"),
  );

  await useRuns.getState().run("t", prepared());

  expect(runOf("t")).toEqual({
    status: "rejected",
    rejection: { title: "서버에 닿지 못했습니다", detail: null },
  });
  expect(executeQuery).not.toHaveBeenCalled();

  await useRuns.getState().run("t", prepared());

  expect(openSession).toHaveBeenCalledTimes(2);
  expect(runOf("t").status).toBe("running");
});

test("execute가 거절되면 rejected다", async () => {
  vi.mocked(executeQuery).mockRejectedValueOnce(
    new CommandError("multiple_statements", "문장을 하나만 보낼 수 있습니다"),
  );

  await useRuns.getState().run("t", prepared("SELECT 1; SELECT 2"));

  expect(runOf("t")).toEqual({
    status: "rejected",
    rejection: { title: "문장을 하나만 보낼 수 있습니다", detail: null },
  });

  // 세션은 그대로 쓴다.
  await useRuns.getState().run("t", prepared());
  expect(openSession).toHaveBeenCalledTimes(1);
});

test("unknown_session으로 거절되면 세션을 버린다", async () => {
  vi.mocked(executeQuery).mockRejectedValueOnce(
    new CommandError("unknown_session", "세션이 없습니다"),
  );

  await useRuns.getState().run("t", prepared());
  expect(runOf("t")).toEqual({
    status: "rejected",
    rejection: { title: "세션이 없습니다", detail: null },
  });

  await useRuns.getState().run("t", prepared());
  expect(openSession).toHaveBeenCalledTimes(2);
});

test("connection_lost로 끝나면 세션을 닫고 버린다", async () => {
  await useRuns.getState().run("t", prepared());

  onEventOf(0)({
    type: "finished",
    elapsedMicros: 50,
    outcome: "connection_lost",
    message: "연결이 끊겼습니다",
  });

  const state = runOf("t");
  expect(state.status === "finished" && state.outcome).toEqual({
    outcome: "connection_lost",
    message: "연결이 끊겼습니다",
  });
  await vi.waitFor(() => expect(closeSession).toHaveBeenCalledWith(3));

  await useRuns.getState().run("t", prepared());
  expect(openSession).toHaveBeenCalledTimes(2);
});

test("앞 실행의 늦은 connection_lost도 세션을 닫고 버린다", async () => {
  await useRuns.getState().run("t", prepared("SELECT 1"));
  const lateA = onEventOf(0);
  await useRuns.getState().run("t", prepared("SELECT 2"));
  const stateB = runOf("t");

  lateA({
    type: "finished",
    elapsedMicros: 50,
    outcome: "connection_lost",
    message: "연결이 끊겼습니다",
  });

  expect(runOf("t")).toBe(stateB);
  await vi.waitFor(() => expect(closeSession).toHaveBeenCalledWith(3));

  await useRuns.getState().run("t", prepared("SELECT 3"));
  expect(openSession).toHaveBeenCalledTimes(2);
});

test("여는 중인 세션에 합류한 실행도 connecting이다", async () => {
  const opening = deferred<Session>();
  vi.mocked(openSession).mockReturnValue(opening.promise);
  const first = useRuns.getState().run("t", prepared("SELECT 1"));
  await useRuns
    .getState()
    .run("t", () => ({ title: "커서 위치에 문장이 없습니다", detail: null }));

  const second = useRuns.getState().run("t", prepared("SELECT 2"));

  expect(runOf("t")).toEqual({ status: "connecting" });
  expect(openSession).toHaveBeenCalledTimes(1);

  opening.resolve(session(3));
  await Promise.all([first, second]);
  const state = runOf("t");
  expect(state.status === "running" && state.result.sql).toBe("SELECT 2");
});

test("첫 세션이 여는 중일 때 접속을 바꾸면 앞 세션을 닫은 뒤 새로 연다", async () => {
  const opening = deferred<Session>();
  vi.mocked(openSession)
    .mockReturnValueOnce(opening.promise)
    .mockResolvedValueOnce(session(4, "staging"));

  const first = useRuns.getState().run("t", prepared("SELECT 1", "local"));
  const second = useRuns.getState().run("t", prepared("SELECT 2", "staging"));
  expect(runOf("t")).toEqual({ status: "connecting" });
  expect(openSession).toHaveBeenCalledTimes(1);

  opening.resolve(session(3, "local"));
  await Promise.all([first, second]);

  expect(closeSession).toHaveBeenCalledTimes(1);
  expect(closeSession).toHaveBeenCalledWith(3);
  expect(openSession).toHaveBeenLastCalledWith("staging");
  expect(vi.mocked(closeSession).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(openSession).mock.invocationCallOrder[1],
  );
  expect(executeQuery).toHaveBeenCalledTimes(1);
  expect(executeQuery).toHaveBeenCalledWith(
    4,
    "SELECT 2",
    expect.any(Function),
  );
});

test("늦은 unknown_session은 새 세션을 건드리지 않는다", async () => {
  const execution = deferred<number>();
  vi.mocked(openSession)
    .mockResolvedValueOnce(session(3, "local"))
    .mockResolvedValueOnce(session(4, "staging"));
  vi.mocked(executeQuery).mockReturnValueOnce(execution.promise);

  const first = useRuns.getState().run("t", prepared("SELECT 1", "local"));
  await vi.waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(1));
  await useRuns.getState().run("t", prepared("SELECT 2", "staging"));
  const stateB = runOf("t");

  execution.reject(new CommandError("unknown_session", "세션이 없습니다"));
  await first;

  expect(runOf("t")).toBe(stateB);
  await useRuns.getState().run("t", prepared("SELECT 3", "staging"));
  expect(openSession).toHaveBeenCalledTimes(2);
  expect(executeQuery).toHaveBeenLastCalledWith(
    4,
    "SELECT 3",
    expect.any(Function),
  );
});

test("cancel은 execute가 query id를 돌려준 뒤 보낸다", async () => {
  const execution = deferred<number>();
  vi.mocked(executeQuery).mockReturnValue(execution.promise);
  const running = useRuns.getState().run("t", prepared());
  await vi.waitFor(() => expect(executeQuery).toHaveBeenCalled());

  const cancelling = useRuns.getState().cancel("t");
  await Promise.resolve();
  expect(cancelQuery).not.toHaveBeenCalled();

  execution.resolve(7);
  await cancelling;
  await running;

  expect(cancelQuery).toHaveBeenCalledTimes(1);
  expect(cancelQuery).toHaveBeenCalledWith(3, 7);
});

test("실행 중이 아니면 cancel은 아무것도 하지 않는다", async () => {
  // idle
  await useRuns.getState().cancel("t");

  // connecting
  const opening = deferred<Session>();
  vi.mocked(openSession).mockReturnValue(opening.promise);
  const running = useRuns.getState().run("t", prepared());
  expect(runOf("t").status).toBe("connecting");
  await useRuns.getState().cancel("t");

  // finished
  opening.resolve(session(3));
  await running;
  onEventOf(0)({
    type: "finished",
    elapsedMicros: 1,
    outcome: "completed",
    rows: 0,
  });
  expect(runOf("t").status).toBe("finished");
  await useRuns.getState().cancel("t");

  expect(cancelQuery).not.toHaveBeenCalled();
});

test("접속이 바뀐 탭은 앞 세션을 닫고 새로 연다", async () => {
  vi.mocked(openSession)
    .mockResolvedValueOnce(session(3, "local"))
    .mockResolvedValueOnce(session(4, "staging"));

  await useRuns.getState().run("t", prepared("SELECT 1", "local"));
  await useRuns.getState().run("t", prepared("SELECT 2", "staging"));

  expect(closeSession).toHaveBeenCalledTimes(1);
  expect(closeSession).toHaveBeenCalledWith(3);
  expect(openSession).toHaveBeenLastCalledWith("staging");
  expect(vi.mocked(closeSession).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(openSession).mock.invocationCallOrder[1],
  );
  expect(executeQuery).toHaveBeenLastCalledWith(
    4,
    "SELECT 2",
    expect.any(Function),
  );
});

test("release는 세션을 닫고 그 뒤의 event를 무시한다", async () => {
  await useRuns.getState().run("t", prepared());
  const onEvent = onEventOf(0);

  await useRuns.getState().release("t");

  expect(closeSession).toHaveBeenCalledWith(3);
  expect(runOf("t")).toBeUndefined();

  onEvent(rowsEvent);
  onEvent({ type: "finished", elapsedMicros: 5, outcome: "cancelled" });
  expect(runOf("t")).toBeUndefined();
});

test("release는 여는 중인 세션을 연 뒤에 닫고 실행하지 않는다", async () => {
  const opening = deferred<Session>();
  vi.mocked(openSession).mockReturnValue(opening.promise);
  const running = useRuns.getState().run("t", prepared());

  const releasing = useRuns.getState().release("t");
  expect(closeSession).not.toHaveBeenCalled();

  opening.resolve(session(3));
  await Promise.all([running, releasing]);

  expect(closeSession).toHaveBeenCalledWith(3);
  expect(executeQuery).not.toHaveBeenCalled();
  expect(runOf("t")).toBeUndefined();
});

test("reset은 열린 세션을 모두 닫는다", async () => {
  vi.mocked(openSession)
    .mockResolvedValueOnce(session(3))
    .mockResolvedValueOnce(session(4))
    .mockResolvedValueOnce(session(5));
  await useRuns.getState().run("a", prepared());
  await useRuns.getState().run("b", prepared());
  const lateA = onEventOf(0);

  const resetting = useRuns.getState().reset();
  // state는 닫기를 기다리기 전에 비운다.
  expect(useRuns.getState().runs).toEqual({});
  await resetting;

  expect(closeSession).toHaveBeenCalledTimes(2);
  expect(closeSession).toHaveBeenCalledWith(3);
  expect(closeSession).toHaveBeenCalledWith(4);

  lateA(rowsEvent);
  expect(useRuns.getState().runs).toEqual({});

  // 세션도 잊었다. 다음 실행은 새로 연다.
  await useRuns.getState().run("a", prepared());
  expect(openSession).toHaveBeenCalledTimes(3);
  expect(executeQuery).toHaveBeenLastCalledWith(
    5,
    "SELECT 1",
    expect.any(Function),
  );
});

test("탭마다 세션이 따로다", async () => {
  vi.mocked(openSession)
    .mockResolvedValueOnce(session(3))
    .mockResolvedValueOnce(session(4));

  await useRuns.getState().run("a", prepared("SELECT 1"));
  await useRuns.getState().run("b", prepared("SELECT 2"));

  expect(openSession).toHaveBeenCalledTimes(2);
  expect(executeQuery).toHaveBeenNthCalledWith(
    1,
    3,
    "SELECT 1",
    expect.any(Function),
  );
  expect(executeQuery).toHaveBeenNthCalledWith(
    2,
    4,
    "SELECT 2",
    expect.any(Function),
  );
  expect(runOf("a").status).toBe("running");
  expect(runOf("b").status).toBe("running");
});

test("prepare가 문구를 돌려주면 rejected다", async () => {
  await useRuns
    .getState()
    .run("t", () => ({ title: "접속을 고르세요", detail: null }));

  expect(runOf("t")).toEqual({
    status: "rejected",
    rejection: { title: "접속을 고르세요", detail: null },
  });
  expect(openSession).not.toHaveBeenCalled();
});

test("prepare가 throw하면 그 message로 rejected다", async () => {
  await useRuns.getState().run("t", () => {
    throw new Error("문서가 없습니다");
  });
  expect(runOf("t")).toEqual({
    status: "rejected",
    rejection: { title: "문서가 없습니다", detail: null },
  });

  await useRuns
    .getState()
    .run("t", () =>
      Promise.reject(new CommandError("split_failed", "나눌 수 없습니다")),
    );
  expect(runOf("t")).toEqual({
    status: "rejected",
    rejection: { title: "나눌 수 없습니다", detail: null },
  });
  expect(openSession).not.toHaveBeenCalled();
});

test("prepare가 끝나기 전에 release하면 실행하지 않는다", async () => {
  const preparing = deferred<Rejection | RunRequest>();
  const running = useRuns.getState().run("t", () => preparing.promise);

  await useRuns.getState().release("t");
  preparing.resolve({ connection: "local", sql: "SELECT 1", origin });
  await running;

  expect(openSession).not.toHaveBeenCalled();
  expect(executeQuery).not.toHaveBeenCalled();
  expect(runOf("t")).toBeUndefined();
});

test("prepare가 늦게 끝난 앞 실행은 뒤 실행을 덮지 않는다", async () => {
  const preparingA = deferred<Rejection | RunRequest>();
  const runningA = useRuns.getState().run("t", () => preparingA.promise);

  await useRuns.getState().run("t", prepared("SELECT B"));
  const stateB = runOf("t");
  preparingA.resolve({ connection: "local", sql: "SELECT A", origin });
  await runningA;

  expect(executeQuery).toHaveBeenCalledTimes(1);
  expect(executeQuery).toHaveBeenCalledWith(
    3,
    "SELECT B",
    expect.any(Function),
  );
  expect(runOf("t")).toBe(stateB);
});

test("실행 중에 거절된 실행은 진행 중인 쿼리를 건드리지 않는다", async () => {
  await useRuns.getState().run("t", prepared("UPDATE big_table SET note = ''"));
  const running = runOf("t");
  const onEvent = onEventOf(0);

  await useRuns
    .getState()
    .run("t", () => ({ title: "커서 위치에 문장이 없습니다", detail: null }));
  await useRuns.getState().run("t", () => {
    throw new Error("문서가 없습니다");
  });

  expect(runOf("t")).toBe(running);
  onEvent({ type: "columns", columns: [{ name: "id" }] });
  onEvent(rowsEvent);
  const state = runOf("t");
  expect(state.status === "running" && state.result.rows).toEqual([["1"]]);

  await useRuns.getState().cancel("t");
  expect(cancelQuery).toHaveBeenCalledWith(3, 7);

  onEvent({ type: "finished", elapsedMicros: 5, outcome: "cancelled" });
  expect(runOf("t").status).toBe("finished");
  expect(executeQuery).toHaveBeenCalledTimes(1);
});

test("prepare를 기다리는 동안에도 앞 쿼리의 event가 반영된다", async () => {
  await useRuns.getState().run("t", prepared("SELECT A"));
  const lateA = onEventOf(0);
  const preparing = deferred<Rejection | RunRequest>();
  const runningB = useRuns.getState().run("t", () => preparing.promise);

  lateA({ type: "columns", columns: [{ name: "id" }] });
  lateA(rowsEvent);
  const stateA = runOf("t");
  expect(stateA.status === "running" && stateA.result.rows).toEqual([["1"]]);

  preparing.resolve({ connection: "local", sql: "SELECT B", origin });
  await runningB;
  expect(executeQuery).toHaveBeenLastCalledWith(
    3,
    "SELECT B",
    expect.any(Function),
  );
  const stateB = runOf("t");
  expect(stateB.status === "running" && stateB.result.sql).toBe("SELECT B");

  // 새 실행이 시작된 뒤에는 앞 쿼리의 event를 버린다.
  lateA({ type: "finished", elapsedMicros: 5, outcome: "discarded" });
  expect(runOf("t")).toBe(stateB);
});

test("쉬는 탭에서 거절되면 rejected다", async () => {
  await useRuns.getState().run("t", prepared());
  onEventOf(0)({
    type: "finished",
    elapsedMicros: 1,
    outcome: "completed",
    rows: 0,
  });
  expect(runOf("t").status).toBe("finished");

  await useRuns
    .getState()
    .run("t", () => ({ title: "커서 위치에 문장이 없습니다", detail: null }));
  expect(runOf("t")).toEqual({
    status: "rejected",
    rejection: { title: "커서 위치에 문장이 없습니다", detail: null },
  });

  await useRuns
    .getState()
    .run("t", () => ({ title: "실행할 문장이 없습니다", detail: null }));
  expect(runOf("t")).toEqual({
    status: "rejected",
    rejection: { title: "실행할 문장이 없습니다", detail: null },
  });
});

const lastRows: QueryEvent = { ...rowsEvent, firstRow: 1 };

test("batch 하나에 fetchMore는 한 번만 보낸다", async () => {
  await useRuns.getState().run("t", prepared());
  onEventOf(0)(rowsEvent);

  await Promise.all([
    useRuns.getState().fetchMore("t"),
    useRuns.getState().fetchMore("t"),
    useRuns.getState().fetchMore("t"),
  ]);
  expect(fetchMore).toHaveBeenCalledTimes(1);
  expect(fetchMore).toHaveBeenCalledWith(3, 7);

  onEventOf(0)(lastRows);
  await useRuns.getState().fetchMore("t");
  expect(fetchMore).toHaveBeenCalledTimes(2);
});

test("rows가 오기 전과 끝난 결과에는 fetchMore를 보내지 않는다", async () => {
  await useRuns.getState().run("t", prepared());
  await useRuns.getState().fetchMore("t");
  expect(fetchMore).not.toHaveBeenCalled();

  for (const outcome of ["completed", "cancelled"] as const) {
    await useRuns.getState().run("t", prepared());
    const onEvent = onEventOf(vi.mocked(executeQuery).mock.calls.length - 1);
    onEvent(rowsEvent);
    onEvent(
      outcome === "completed"
        ? { type: "finished", elapsedMicros: 5, outcome, rows: 1 }
        : { type: "finished", elapsedMicros: 5, outcome },
    );
    expect(runOf("t").status).toBe("finished");

    await useRuns.getState().fetchMore("t");
    expect(fetchMore).not.toHaveBeenCalled();
  }
});

test("fetchMore는 execute가 query id를 돌려준 뒤 보낸다", async () => {
  const execution = deferred<number>();
  vi.mocked(executeQuery).mockReturnValue(execution.promise);

  const running = useRuns.getState().run("t", prepared());
  await vi.waitFor(() => expect(executeQuery).toHaveBeenCalled());
  onEventOf(0)(rowsEvent);

  const fetching = useRuns.getState().fetchMore("t");
  await Promise.resolve();
  expect(fetchMore).not.toHaveBeenCalled();

  execution.resolve(9);
  await fetching;
  expect(fetchMore).toHaveBeenCalledWith(3, 9);
  await running;
});

test("fetchMore가 실패해도 state를 바꾸지 않는다", async () => {
  vi.mocked(fetchMore).mockRejectedValue(
    new CommandError("unknown_session", "세션이 없습니다"),
  );
  await useRuns.getState().run("t", prepared());
  onEventOf(0)(rowsEvent);

  await expect(useRuns.getState().fetchMore("t")).resolves.toBeUndefined();

  const state = runOf("t");
  expect(state.status === "running" && state.result.fetch).toBe("fetching");
});

test("거절은 title과 detail을 갖는다", async () => {
  await useRuns
    .getState()
    .run("t", () => ({ title: "Couldn't find", detail: "이유" }));

  expect(runOf("t")).toEqual({
    status: "rejected",
    rejection: { title: "Couldn't find", detail: "이유" },
  });
});
