import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import {
  cancelQuery,
  closeSession,
  executeQuery,
  openSession,
} from "../../shared/api/commands";
import { CommandError } from "../../shared/api/errors";
import type { QueryEvent, Session } from "../../shared/api/types";
import { useRuns, type RunRequest } from "./runsStore";

function session(id: number, connection = "local"): Session {
  return { id, connection, backendPid: 100 + id };
}

function request(sql = "SELECT 1", connection = "local"): RunRequest {
  return { connection, sql, origin: { line: 1, column: 1 } };
}

/** 끝나는 시점을 test가 정하는 promise. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

beforeEach(() => {
  vi.resetAllMocks();
  useRuns.getState().reset();
  vi.mocked(openSession).mockResolvedValue(session(3));
  vi.mocked(executeQuery).mockResolvedValue(7);
  vi.mocked(closeSession).mockResolvedValue();
  vi.mocked(cancelQuery).mockResolvedValue();
});

test("첫 실행은 세션을 열고 그 세션으로 실행한다", async () => {
  await useRuns.getState().run("t", request("SELECT 1"));

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
    },
  });
});

test("같은 탭의 다음 실행은 세션을 다시 쓴다", async () => {
  await useRuns.getState().run("t", request("SELECT 1"));
  await useRuns.getState().run("t", request("SELECT 2"));

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

  const first = useRuns.getState().run("t", request("SELECT 1"));
  const second = useRuns.getState().run("t", request("SELECT 2"));

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
  await useRuns.getState().run("t", request("SELECT 1"));
  const lateA = onEventOf(0);
  await useRuns.getState().run("t", request("SELECT 2"));
  const stateB = runOf("t");
  expect(stateB.status === "running" && stateB.result.sql).toBe("SELECT 2");

  lateA(rowsEvent);
  lateA({ type: "finished", elapsedMicros: 5, outcome: "discarded" });

  expect(runOf("t")).toBe(stateB);
});

test("event는 execute가 query id를 돌려주기 전에도 반영된다", async () => {
  const execution = deferred<number>();
  vi.mocked(executeQuery).mockReturnValue(execution.promise);

  const running = useRuns.getState().run("t", request());
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

  await useRuns.getState().run("t", request());

  expect(runOf("t")).toEqual({
    status: "rejected",
    message: "서버에 닿지 못했습니다",
  });
  expect(executeQuery).not.toHaveBeenCalled();

  await useRuns.getState().run("t", request());

  expect(openSession).toHaveBeenCalledTimes(2);
  expect(runOf("t").status).toBe("running");
});

test("execute가 거절되면 rejected다", async () => {
  vi.mocked(executeQuery).mockRejectedValueOnce(
    new CommandError("multiple_statements", "문장을 하나만 보낼 수 있습니다"),
  );

  await useRuns.getState().run("t", request("SELECT 1; SELECT 2"));

  expect(runOf("t")).toEqual({
    status: "rejected",
    message: "문장을 하나만 보낼 수 있습니다",
  });

  // 세션은 그대로 쓴다.
  await useRuns.getState().run("t", request());
  expect(openSession).toHaveBeenCalledTimes(1);
});

test("unknown_session으로 거절되면 세션을 버린다", async () => {
  vi.mocked(executeQuery).mockRejectedValueOnce(
    new CommandError("unknown_session", "세션이 없습니다"),
  );

  await useRuns.getState().run("t", request());
  expect(runOf("t")).toEqual({
    status: "rejected",
    message: "세션이 없습니다",
  });

  await useRuns.getState().run("t", request());
  expect(openSession).toHaveBeenCalledTimes(2);
});

test("connection_lost로 끝나면 세션을 닫고 버린다", async () => {
  await useRuns.getState().run("t", request());

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
  expect(closeSession).toHaveBeenCalledWith(3);

  await useRuns.getState().run("t", request());
  expect(openSession).toHaveBeenCalledTimes(2);
});

test("cancel은 execute가 query id를 돌려준 뒤 보낸다", async () => {
  const execution = deferred<number>();
  vi.mocked(executeQuery).mockReturnValue(execution.promise);
  const running = useRuns.getState().run("t", request());
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
  const running = useRuns.getState().run("t", request());
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

  await useRuns.getState().run("t", request("SELECT 1", "local"));
  await useRuns.getState().run("t", request("SELECT 2", "staging"));

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
  await useRuns.getState().run("t", request());
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
  const running = useRuns.getState().run("t", request());

  const releasing = useRuns.getState().release("t");
  expect(closeSession).not.toHaveBeenCalled();

  opening.resolve(session(3));
  await Promise.all([running, releasing]);

  expect(closeSession).toHaveBeenCalledWith(3);
  expect(executeQuery).not.toHaveBeenCalled();
  expect(runOf("t")).toBeUndefined();
});

test("reset은 closeSession을 부르지 않고 모두 지운다", async () => {
  vi.mocked(openSession)
    .mockResolvedValueOnce(session(3))
    .mockResolvedValueOnce(session(4))
    .mockResolvedValueOnce(session(5));
  await useRuns.getState().run("a", request());
  await useRuns.getState().run("b", request());
  const lateA = onEventOf(0);

  useRuns.getState().reset();

  expect(closeSession).not.toHaveBeenCalled();
  expect(useRuns.getState().runs).toEqual({});

  lateA(rowsEvent);
  expect(useRuns.getState().runs).toEqual({});

  // 세션도 잊었다. 다음 실행은 새로 연다.
  await useRuns.getState().run("a", request());
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

  await useRuns.getState().run("a", request("SELECT 1"));
  await useRuns.getState().run("b", request("SELECT 2"));

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

test("reject는 그 탭을 rejected로 둔다", () => {
  useRuns.getState().reject("t", "접속을 고르세요");

  expect(runOf("t")).toEqual({
    status: "rejected",
    message: "접속을 고르세요",
  });
});
