import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import {
  cancelQuery,
  closeSession,
  describeTypes,
  endTransaction,
  executeQuery,
  fetchMore,
  openSession,
  recordQuery,
} from "../../shared/api/commands";
import { CommandError } from "../../shared/api/errors";
import type {
  EndResult,
  QueryEvent,
  Session,
  TxStatus,
} from "../../shared/api/types";
import { t } from "../../shared/i18n/t";
import type { Rejection, RunRequest } from "./runReducer";
import { useRuns, type Prepare } from "./runsStore";
import { useTypes } from "./typesStore";
import { deferred } from "../../test/deferred";
import {
  openProjectWith,
  resultColumns,
  setTabMode,
} from "../../test/fixtures";
import { modeOf, useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";

function session(id: number, connection = "local"): Session {
  return { id, connection, backendPid: 100 + id };
}

/** 바로 이 문장을 실행하게 하는 prepare. */
function prepared(sql = "SELECT 1", connection = "local"): Prepare {
  return () => ({
    connection,
    steps: [{ sql, from: 0, origin: { line: 1, column: 1 } }],
  });
}

const origin = { line: 1, column: 1 };

function runOf(tabId: string) {
  return useRuns.getState().runs[tabId];
}

/** n번째(0부터) executeQuery 호출에 넘긴 onEvent. */
function onEventOf(call: number): (event: QueryEvent) => void {
  return vi.mocked(executeQuery).mock.calls[call][3];
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
  useProject.setState(useProject.getInitialState(), true);
  useTabs.getState().reset();
  useTypes.getState().reset();
  vi.resetAllMocks();
  vi.mocked(openSession).mockResolvedValue(session(3));
  vi.mocked(executeQuery).mockResolvedValue(7);
  vi.mocked(closeSession).mockResolvedValue();
  vi.mocked(cancelQuery).mockResolvedValue();
  vi.mocked(fetchMore).mockResolvedValue();
  vi.mocked(recordQuery).mockResolvedValue();
});

test("첫 실행은 세션을 열고 그 세션으로 실행한다", async () => {
  await useRuns.getState().run("t", prepared("SELECT 1"));

  expect(openSession).toHaveBeenCalledTimes(1);
  expect(openSession).toHaveBeenCalledWith("local");
  expect(executeQuery).toHaveBeenCalledWith(
    3,
    "SELECT 1",
    "auto",
    expect.any(Function),
    { drain: false },
  );
  expect(runOf("t")).toEqual({
    status: "running",
    result: {
      sql: "SELECT 1",
      runKey: expect.any(String),
      from: 0,
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
    "auto",
    expect.any(Function),
    { drain: false },
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
    "auto",
    expect.any(Function),
    { drain: false },
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
  lateA({
    type: "finished",
    tx: "idle",
    elapsedMicros: 5,
    outcome: "discarded",
  });

  expect(runOf("t")).toBe(stateB);
});

test("event는 execute가 query id를 돌려주기 전에도 반영된다", async () => {
  const execution = deferred<number>();
  vi.mocked(executeQuery).mockReturnValue(execution.promise);

  const running = useRuns.getState().run("t", prepared());
  await vi.waitFor(() => expect(executeQuery).toHaveBeenCalled());
  const onEvent = onEventOf(0);
  onEvent({ type: "columns", columns: resultColumns("id") });
  onEvent(rowsEvent);

  const state = runOf("t");
  expect(state.status).toBe("running");
  if (state.status !== "running") return;
  expect(state.result.columns).toEqual(resultColumns("id"));
  expect(state.result.rows).toEqual([["1"]]);

  execution.resolve(7);
  await running;
});

test("late_columns_from_a_superseded_run_do_not_ask_types", async () => {
  await useRuns.getState().run("t", prepared("SELECT 1", "staging"));
  const lateA = onEventOf(0);
  await useRuns.getState().run("t", prepared("SELECT 2", "staging"));

  lateA({
    type: "columns",
    columns: [{ name: "id", typeOid: 23, typeModifier: -1 }],
  });

  expect(describeTypes).not.toHaveBeenCalled();
});

test("columns event는 그 탭의 접속에 type 이름을 묻는다", async () => {
  const execution = deferred<number>();
  vi.mocked(executeQuery).mockReturnValue(execution.promise);
  const integer = { oid: 23, modifier: -1, name: "integer", category: "N" };
  vi.mocked(describeTypes).mockResolvedValue([integer]);

  const running = useRuns.getState().run("t", prepared("SELECT 1", "staging"));
  await vi.waitFor(() => expect(executeQuery).toHaveBeenCalled());
  onEventOf(0)({
    type: "columns",
    columns: [{ name: "id", typeOid: 23, typeModifier: -1 }],
  });

  expect(describeTypes).toHaveBeenCalledWith("staging", [
    { oid: 23, modifier: -1 },
  ]);
  await vi.waitFor(() =>
    expect(useTypes.getState().types.staging?.["23:-1"]).toEqual(integer),
  );

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
    tx: null,
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
    tx: null,
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
    "auto",
    expect.any(Function),
    { drain: false },
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
    "auto",
    expect.any(Function),
    { drain: false },
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
    tx: "idle",
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
    "auto",
    expect.any(Function),
    { drain: false },
  );
});

test("release는 세션을 닫고 그 뒤의 event를 무시한다", async () => {
  await useRuns.getState().run("t", prepared());
  const onEvent = onEventOf(0);

  await useRuns.getState().release("t");

  expect(closeSession).toHaveBeenCalledWith(3);
  expect(runOf("t")).toBeUndefined();

  onEvent(rowsEvent);
  onEvent({
    type: "finished",
    tx: "idle",
    elapsedMicros: 5,
    outcome: "cancelled",
  });
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
    "auto",
    expect.any(Function),
    { drain: false },
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
    "auto",
    expect.any(Function),
    { drain: false },
  );
  expect(executeQuery).toHaveBeenNthCalledWith(
    2,
    4,
    "SELECT 2",
    "auto",
    expect.any(Function),
    { drain: false },
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
  preparing.resolve({
    connection: "local",
    steps: [{ sql: "SELECT 1", from: 0, origin }],
  });
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
  preparingA.resolve({
    connection: "local",
    steps: [{ sql: "SELECT A", from: 0, origin }],
  });
  await runningA;

  expect(executeQuery).toHaveBeenCalledTimes(1);
  expect(executeQuery).toHaveBeenCalledWith(
    3,
    "SELECT B",
    "auto",
    expect.any(Function),
    { drain: false },
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
  onEvent({ type: "columns", columns: resultColumns("id") });
  onEvent(rowsEvent);
  const state = runOf("t");
  expect(state.status === "running" && state.result.rows).toEqual([["1"]]);

  await useRuns.getState().cancel("t");
  expect(cancelQuery).toHaveBeenCalledWith(3, 7);

  onEvent({
    type: "finished",
    tx: "idle",
    elapsedMicros: 5,
    outcome: "cancelled",
  });
  expect(runOf("t").status).toBe("finished");
  expect(executeQuery).toHaveBeenCalledTimes(1);
});

test("prepare를 기다리는 동안에도 앞 쿼리의 event가 반영된다", async () => {
  await useRuns.getState().run("t", prepared("SELECT A"));
  const lateA = onEventOf(0);
  const preparing = deferred<Rejection | RunRequest>();
  const runningB = useRuns.getState().run("t", () => preparing.promise);

  lateA({ type: "columns", columns: resultColumns("id") });
  lateA(rowsEvent);
  const stateA = runOf("t");
  expect(stateA.status === "running" && stateA.result.rows).toEqual([["1"]]);

  preparing.resolve({
    connection: "local",
    steps: [{ sql: "SELECT B", from: 0, origin }],
  });
  await runningB;
  expect(executeQuery).toHaveBeenLastCalledWith(
    3,
    "SELECT B",
    "auto",
    expect.any(Function),
    { drain: false },
  );
  const stateB = runOf("t");
  expect(stateB.status === "running" && stateB.result.sql).toBe("SELECT B");

  // 새 실행이 시작된 뒤에는 앞 쿼리의 event를 버린다.
  lateA({
    type: "finished",
    tx: "idle",
    elapsedMicros: 5,
    outcome: "discarded",
  });
  expect(runOf("t")).toBe(stateB);
});

test("쉬는 탭에서 거절되면 rejected다", async () => {
  await useRuns.getState().run("t", prepared());
  onEventOf(0)({
    type: "finished",
    tx: "idle",
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
        ? { type: "finished", tx: "idle", elapsedMicros: 5, outcome, rows: 1 }
        : { type: "finished", tx: "idle", elapsedMicros: 5, outcome },
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

test("stale 세션은 새 세션을 먼저 연 뒤 닫고 Reconnected를 알린다", async () => {
  vi.mocked(openSession)
    .mockResolvedValueOnce(session(3, "staging"))
    .mockResolvedValueOnce(session(4, "staging"));
  await useRuns.getState().run("t", prepared("SELECT 1", "staging"));
  expect(useRuns.getState().notices.t).toBeUndefined();

  useRuns.getState().markStale("staging");
  await useRuns.getState().run("t", prepared("SELECT 2", "staging"));

  const opened = vi.mocked(openSession).mock.invocationCallOrder[1];
  const closed = vi.mocked(closeSession).mock.invocationCallOrder[0];
  expect(opened).toBeLessThan(closed);
  expect(closeSession).toHaveBeenCalledWith(3);
  expect(vi.mocked(executeQuery).mock.calls[1][0]).toBe(4);
  expect(useRuns.getState().notices.t).toEqual({ kind: "reconnected" });
});

test("stale은 그 접속의 탭만 바꾼다", async () => {
  vi.mocked(openSession)
    .mockResolvedValueOnce(session(3, "local"))
    .mockResolvedValueOnce(session(4, "staging"));
  await useRuns.getState().run("a", prepared("SELECT 1", "local"));
  await useRuns.getState().run("b", prepared("SELECT 1", "staging"));

  useRuns.getState().markStale("staging");
  await useRuns.getState().run("a", prepared("SELECT 2", "local"));

  expect(openSession).toHaveBeenCalledTimes(2);
  expect(useRuns.getState().notices.a).toBeUndefined();
});

test("끊긴 세션을 다음 실행이 대신하면 Reconnected를 알리고 그다음 실행에서 지운다", async () => {
  vi.mocked(openSession)
    .mockResolvedValueOnce(session(3))
    .mockResolvedValueOnce(session(4));
  await useRuns.getState().run("t", prepared());
  onEventOf(0)({
    type: "finished",
    tx: null,
    outcome: "connection_lost",
    message: "gone",
    elapsedMicros: 1,
  });

  await useRuns.getState().run("t", prepared());
  expect(openSession).toHaveBeenCalledTimes(2);
  expect(useRuns.getState().notices.t).toEqual({ kind: "reconnected" });

  await useRuns.getState().run("t", prepared());
  expect(useRuns.getState().notices.t).toBeUndefined();
});

test("dismissNotice는 알림을 지운다", async () => {
  await useRuns.getState().run("t", prepared());
  useRuns.getState().markStale("local");
  vi.mocked(openSession).mockResolvedValueOnce(session(4));
  await useRuns.getState().run("t", prepared());
  expect(useRuns.getState().notices.t).toEqual({ kind: "reconnected" });

  useRuns.getState().dismissNotice("t");
  expect(useRuns.getState().notices.t).toBeUndefined();
});

test("터널 시작을 멈추면 탭은 빈 상태로 돌아간다", async () => {
  vi.mocked(openSession).mockRejectedValue(
    new CommandError("tunnel_cancelled", "The tunnel start was cancelled"),
  );
  await useRuns.getState().run("t", prepared());
  expect(runOf("t")).toEqual({ status: "idle" });
});

test("터널 오류는 output과 다시 실행할 요청을 남긴다", async () => {
  vi.mocked(openSession).mockRejectedValue(
    new CommandError(
      "tunnel_timeout",
      "localhost:25432 didn't open within 20 seconds",
      "Unauthorized",
    ),
  );
  await useRuns.getState().run("t", prepared("SELECT 1", "staging"));

  const expected: Rejection = {
    title: "localhost:25432 didn't open within 20 seconds",
    detail: null,
    output: "Unauthorized",
    retry: {
      connection: "staging",
      steps: [{ sql: "SELECT 1", from: 0, origin }],
      runKeys: [expect.any(String)],
    },
  };
  expect(runOf("t")).toEqual({ status: "rejected", rejection: expected });
});

test("여는 중인 세션은 stale로 두지 않는다", async () => {
  const opening = deferred<Session>();
  vi.mocked(openSession).mockReturnValueOnce(opening.promise);
  const first = useRuns.getState().run("t", prepared("SELECT 1", "staging"));

  useRuns.getState().markStale("staging");
  opening.resolve(session(3, "staging"));
  await first;
  await useRuns.getState().run("t", prepared("SELECT 2", "staging"));

  expect(openSession).toHaveBeenCalledTimes(1);
  expect(closeSession).not.toHaveBeenCalled();
  expect(useRuns.getState().notices.t).toBeUndefined();
});

/** n번째(0부터) 실행을 completed로 끝낸다. 끝난 뒤의 트랜잭션 상태는 `tx`다. */
function complete(call: number, tx: TxStatus | null): void {
  onEventOf(call)({
    type: "finished",
    tx,
    elapsedMicros: 1,
    outcome: "completed",
    rows: 0,
  });
}

function txOf(tabId: string) {
  return useRuns.getState().transactions[tabId];
}

/** 탭 t1에서 Manual로 두 문장을 실행해 트랜잭션을 연다. */
async function openTwoStatements(connection = "local"): Promise<void> {
  setTabMode("t1", "manual");
  await useRuns
    .getState()
    .run("t1", prepared("UPDATE a SET b = 1", connection));
  complete(0, "in_transaction");
  await useRuns
    .getState()
    .run("t1", prepared("UPDATE a SET b = 2", connection));
  complete(1, "in_transaction");
}

test("run_sends_the_tab_mode", async () => {
  setTabMode("t1", "manual");
  await useRuns.getState().run("t1", prepared("SELECT 1"));

  expect(executeQuery).toHaveBeenCalledWith(
    3,
    "SELECT 1",
    "manual",
    expect.any(Function),
    { drain: false },
  );
  // 다른 탭은 Auto다.
  await useRuns.getState().run("t2", prepared("SELECT 1"));
  expect(vi.mocked(executeQuery).mock.calls[1][2]).toBe("auto");
});

test("finished_updates_the_transaction", async () => {
  await useRuns.getState().run("t1", prepared("BEGIN"));
  const run = runOf("t1");
  const startedAt = run.status === "running" ? run.result.startedAt : -1;
  complete(0, "in_transaction");
  expect(txOf("t1")).toEqual({
    status: "open",
    statements: 0,
    openedAt: startedAt,
    openedBy: "user",
  });

  await useRuns.getState().run("t1", prepared("COMMIT"));
  complete(1, "idle");
  expect(txOf("t1")).toBeUndefined();
});

test("a run counts statements by the mode it started with", async () => {
  setTabMode("t1", "manual");
  await useRuns.getState().run("t1", prepared("UPDATE a SET b = 1"));
  setTabMode("t1", "auto");
  complete(0, "in_transaction");

  expect(txOf("t1")?.statements).toBe(1);
});

/** n번째(0부터) 실행을 `outcome`으로 끝낸다. 끝난 뒤의 트랜잭션 상태는 `tx`다. */
function finish(
  call: number,
  outcome: "discarded" | "cancelled",
  tx: TxStatus | null,
): void {
  onEventOf(call)({ type: "finished", tx, elapsedMicros: 1, outcome });
}

test("a discarded run reports the transaction it left open", async () => {
  setTabMode("t1", "manual");
  await useRuns.getState().run("t1", prepared("SELECT pg_sleep(5)"));
  const run = runOf("t1");
  const startedAt = run.status === "running" ? run.result.startedAt : -1;
  await useRuns.getState().run("t1", prepared("SELECT 1"));
  // 다음 실행은 서버에 보내기 전에 cancel되어 트랜잭션 상태를 싣지 않는다.
  finish(1, "cancelled", null);
  expect(txOf("t1")).toBeUndefined();

  finish(0, "discarded", "in_transaction");

  expect(txOf("t1")).toEqual({
    status: "open",
    statements: 0,
    openedAt: startedAt,
    openedBy: "app",
  });
});

test("a discarded run that ended the transaction clears it", async () => {
  await openTwoStatements();
  await useRuns.getState().run("t1", prepared("COMMIT"));
  await useRuns.getState().run("t1", prepared("SELECT 1"));
  finish(3, "cancelled", null);
  expect(txOf("t1")).toEqual(expect.objectContaining({ status: "open" }));

  finish(2, "discarded", "idle");

  expect(txOf("t1")).toBeUndefined();
});

test("a late finished event of an earlier run sets the status without counting", async () => {
  await openTwoStatements();
  await useRuns.getState().run("t1", prepared("UPDATE a SET b = 3"));
  await useRuns.getState().run("t1", prepared("SELECT 1"));

  complete(2, "in_transaction");
  expect(txOf("t1")).toEqual(
    expect.objectContaining({ status: "open", statements: 2 }),
  );
  onEventOf(2)({
    type: "finished",
    tx: "failed",
    elapsedMicros: 1,
    outcome: "failed",
    error: {
      code: "23505",
      message: "duplicate key value",
      detail: null,
      hint: null,
      position: null,
    },
  });
  expect(txOf("t1")).toEqual(
    expect.objectContaining({ status: "failed", statements: 2 }),
  );
});

test("a run discarded by an end does not reopen the ended transaction", async () => {
  await pausedSelect();
  vi.mocked(endTransaction).mockResolvedValue({ outcome: "ended", tx: "idle" });
  await useRuns.getState().endTransaction("t1", "rollback");
  expect(txOf("t1")).toBeUndefined();

  finish(2, "discarded", "in_transaction");

  expect(txOf("t1")).toBeUndefined();
});

test("a finished event of another session does not change the transaction", async () => {
  setTabMode("t1", "manual");
  vi.mocked(openSession)
    .mockResolvedValueOnce(session(3, "local"))
    .mockResolvedValueOnce(session(4, "staging"));
  await useRuns.getState().run("t1", prepared("SELECT pg_sleep(5)", "local"));
  await useRuns.getState().run("t1", prepared("SELECT 1", "staging"));

  finish(0, "discarded", "in_transaction");

  expect(txOf("t1")).toBeUndefined();
});

test("a late event of an earlier run does not change the transaction", async () => {
  await useRuns.getState().run("t1", prepared("SELECT 1"));
  const lateA = onEventOf(0);
  await useRuns.getState().run("t1", prepared("BEGIN"));
  complete(1, "in_transaction");

  lateA({
    type: "finished",
    tx: "idle",
    elapsedMicros: 1,
    outcome: "completed",
    rows: 0,
  });
  expect(txOf("t1")).toEqual(expect.objectContaining({ status: "open" }));
});

test("end_transaction_commits_and_clears", async () => {
  await openTwoStatements();
  const ending = deferred<{ outcome: "ended"; tx: TxStatus | null }>();
  vi.mocked(endTransaction).mockReturnValue(ending.promise);

  const committed = useRuns.getState().endTransaction("t1", "commit");
  expect(useRuns.getState().ending.t1).toBeDefined();
  expect(endTransaction).toHaveBeenCalledWith(3, "commit");

  ending.resolve({ outcome: "ended", tx: "idle" });
  await expect(committed).resolves.toBe(true);
  expect(txOf("t1")).toBeUndefined();
  expect(useRuns.getState().ending.t1).toBeUndefined();
});

test("a second end while one is in flight sends nothing and returns false", async () => {
  await openTwoStatements();
  const ending = deferred<{ outcome: "ended"; tx: TxStatus | null }>();
  vi.mocked(endTransaction).mockReturnValue(ending.promise);

  const committed = useRuns.getState().endTransaction("t1", "commit");
  await expect(
    useRuns.getState().endTransaction("t1", "rollback"),
  ).resolves.toBe(false);
  expect(endTransaction).toHaveBeenCalledTimes(1);

  ending.resolve({ outcome: "ended", tx: "idle" });
  await expect(committed).resolves.toBe(true);
});

test("ending without a session or a transaction sends nothing", async () => {
  await expect(useRuns.getState().endTransaction("t1", "commit")).resolves.toBe(
    true,
  );

  await useRuns.getState().run("t1", prepared("SELECT 1"));
  complete(0, "idle");
  await expect(
    useRuns.getState().endTransaction("t1", "rollback"),
  ).resolves.toBe(true);
  expect(endTransaction).not.toHaveBeenCalled();
  expect(useRuns.getState().ending.t1).toBeUndefined();
});

test("a_failed_commit_shows_the_server_error", async () => {
  await openTwoStatements();
  vi.mocked(endTransaction).mockResolvedValue({
    outcome: "server_error",
    tx: "idle",
    error: {
      code: "23503",
      message: "insert or update violates foreign key constraint",
      detail: null,
      hint: null,
      position: null,
    },
  });

  await expect(useRuns.getState().endTransaction("t1", "commit")).resolves.toBe(
    false,
  );

  const state = runOf("t1");
  expect(state.status).toBe("rejected");
  if (state.status !== "rejected") return;
  expect(state.rejection.title).toBe(t("tx.commitFailed"));
  expect(state.rejection.detail).toContain(
    "insert or update violates foreign key constraint",
  );
  expect(state.rejection.detail).toContain("SQLSTATE 23503");
  expect(txOf("t1")).toBeUndefined();
  expect(useRuns.getState().ending.t1).toBeUndefined();
});

test("a failed rollback that leaves the transaction keeps it", async () => {
  await openTwoStatements();
  vi.mocked(endTransaction).mockResolvedValue({
    outcome: "server_error",
    tx: "failed",
    error: {
      code: "XX000",
      message: "boom",
      detail: null,
      hint: null,
      position: null,
    },
  });

  await expect(
    useRuns.getState().endTransaction("t1", "rollback"),
  ).resolves.toBe(false);

  const state = runOf("t1");
  expect(state.status === "rejected" && state.rejection.title).toBe(
    t("tx.rollbackFailed"),
  );
  expect(txOf("t1")).toEqual(
    expect.objectContaining({ status: "failed", statements: 2 }),
  );
});

test("committing a failed transaction is refused", async () => {
  await openTwoStatements();
  vi.mocked(endTransaction).mockResolvedValue({
    outcome: "transaction_failed",
    tx: "failed",
  });

  await expect(useRuns.getState().endTransaction("t1", "commit")).resolves.toBe(
    false,
  );

  expect(runOf("t1")).toEqual({
    status: "rejected",
    rejection: { title: t("tx.commitRefused"), detail: null },
  });
  expect(txOf("t1")?.status).toBe("failed");
});

test("losing the connection while ending reports the transaction lost", async () => {
  await openTwoStatements();
  vi.mocked(endTransaction).mockResolvedValue({
    outcome: "connection_lost",
    tx: null,
    message: "server closed",
  });

  await expect(useRuns.getState().endTransaction("t1", "commit")).resolves.toBe(
    false,
  );

  expect(useRuns.getState().notices.t1).toEqual({
    kind: "transactionLost",
    statements: 2,
    openedBy: "app",
  });
  expect(txOf("t1")).toBeUndefined();
  await vi.waitFor(() => expect(closeSession).toHaveBeenCalledWith(3));
  vi.mocked(openSession).mockResolvedValueOnce(session(4));
  await useRuns.getState().run("t1", prepared());
  expect(openSession).toHaveBeenCalledTimes(2);
});

test("an unknown session while ending reports the transaction lost", async () => {
  await openTwoStatements();
  vi.mocked(endTransaction).mockRejectedValue(
    new CommandError("unknown_session", "세션이 없습니다"),
  );

  await expect(
    useRuns.getState().endTransaction("t1", "rollback"),
  ).resolves.toBe(false);

  expect(useRuns.getState().notices.t1).toEqual({
    kind: "transactionLost",
    statements: 2,
    openedBy: "app",
  });
  expect(txOf("t1")).toBeUndefined();
});

test("a_stale_session_with_an_open_transaction_reports_it_lost", async () => {
  vi.mocked(openSession)
    .mockResolvedValueOnce(session(3, "staging"))
    .mockResolvedValueOnce(session(4, "staging"));
  await openTwoStatements("staging");

  useRuns.getState().markStale("staging");
  expect(useRuns.getState().notices.t1).toEqual({
    kind: "transactionLost",
    statements: 2,
    openedBy: "app",
  });
  expect(txOf("t1")).toBeUndefined();

  await useRuns.getState().run("t1", prepared("SELECT 1", "staging"));
  expect(openSession).toHaveBeenCalledTimes(2);
  expect(closeSession).toHaveBeenCalledWith(3);
  expect(executeQuery).toHaveBeenLastCalledWith(
    4,
    "SELECT 1",
    "manual",
    expect.any(Function),
    { drain: false },
  );
});

test("connection_lost_with_an_open_transaction_reports_it_lost", async () => {
  await openTwoStatements();
  await useRuns.getState().run("t1", prepared("SELECT 3"));
  onEventOf(2)({
    type: "finished",
    tx: null,
    elapsedMicros: 1,
    outcome: "connection_lost",
    message: "server closed",
  });

  expect(useRuns.getState().notices.t1).toEqual({
    kind: "transactionLost",
    statements: 2,
    openedBy: "app",
  });
  expect(txOf("t1")).toBeUndefined();
});

test("a_lost_manual_transaction_notice_keeps_who_opened_it", async () => {
  await openTwoStatements();
  expect(txOf("t1")?.openedBy).toBe("app");
  await useRuns.getState().run("t1", prepared("SELECT 3"));
  onEventOf(2)({
    type: "finished",
    tx: null,
    elapsedMicros: 1,
    outcome: "connection_lost",
    message: "server closed",
  });

  expect(useRuns.getState().notices.t1).toEqual({
    kind: "transactionLost",
    statements: 2,
    openedBy: "app",
  });
});

test("a pending query cancelled without a state keeps the open transaction", async () => {
  await openTwoStatements();
  await useRuns.getState().run("t1", prepared("SELECT 3"));
  // 서버에 보내기 전에 끝난 쿼리는 트랜잭션 상태를 싣지 않는다.
  onEventOf(2)({
    type: "finished",
    tx: null,
    elapsedMicros: 0,
    outcome: "cancelled",
  });

  expect(txOf("t1")).toEqual(
    expect.objectContaining({ status: "open", statements: 2 }),
  );
  expect(useRuns.getState().notices.t1).toBeUndefined();
});

test("connection_lost without a transaction shows no notice", async () => {
  await useRuns.getState().run("t1", prepared());
  onEventOf(0)({
    type: "finished",
    tx: null,
    elapsedMicros: 1,
    outcome: "connection_lost",
    message: "server closed",
  });
  expect(useRuns.getState().notices.t1).toBeUndefined();
});

test("release_forgets_the_transaction", async () => {
  await openTwoStatements();
  const ending = deferred<EndResult>();
  vi.mocked(endTransaction).mockReturnValue(ending.promise);
  const ended = useRuns.getState().endTransaction("t1", "commit");

  await useRuns.getState().release("t1");

  expect(txOf("t1")).toBeUndefined();
  expect(useRuns.getState().ending.t1).toBeUndefined();

  // 늦게 온 끝내기의 결과는 아무것도 바꾸지 않는다. 오류 결과는 소유 확인이 없으면 결과 panel을 그린다.
  ending.resolve({
    outcome: "server_error",
    tx: "failed",
    error: {
      code: "23503",
      message: "violates foreign key constraint",
      detail: null,
      hint: null,
      position: null,
    },
  });
  await expect(ended).resolves.toBe(false);
  expect(runOf("t1")).toBeUndefined();
  expect(txOf("t1")).toBeUndefined();
  expect(useRuns.getState().notices.t1).toBeUndefined();
});

test("a_released_end_settling_late_keeps_the_new_end_ending", async () => {
  await openTwoStatements();
  const first = deferred<EndResult>();
  vi.mocked(endTransaction).mockReturnValueOnce(first.promise);
  const firstEnded = useRuns.getState().endTransaction("t1", "commit");
  await useRuns.getState().release("t1");

  // 새 세션에서 트랜잭션을 열고 다시 끝낸다.
  vi.mocked(openSession).mockResolvedValue(session(4));
  await useRuns.getState().run("t1", prepared("BEGIN"));
  complete(2, "in_transaction");
  const second = deferred<EndResult>();
  vi.mocked(endTransaction).mockReturnValueOnce(second.promise);
  const secondEnded = useRuns.getState().endTransaction("t1", "rollback");
  const secondCall = useRuns.getState().ending.t1;
  expect(secondCall).toBeDefined();

  first.resolve({ outcome: "ended", tx: "idle" });
  await firstEnded;
  expect(useRuns.getState().ending.t1).toBe(secondCall);
  expect(txOf("t1")).toBeDefined();

  second.resolve({ outcome: "ended", tx: "idle" });
  await expect(secondEnded).resolves.toBe(true);
  expect(useRuns.getState().ending.t1).toBeUndefined();
});

test("a_run_does_not_start_while_the_tab_is_ending", async () => {
  await openTwoStatements();
  const ending = deferred<EndResult>();
  vi.mocked(endTransaction).mockReturnValue(ending.promise);
  const ended = useRuns.getState().endTransaction("t1", "commit");
  const before = useRuns.getState();
  const prepare = vi.fn(prepared("SELECT 1"));

  await useRuns.getState().run("t1", prepare);

  expect(prepare).not.toHaveBeenCalled();
  expect(executeQuery).toHaveBeenCalledTimes(2);
  expect(useRuns.getState().runs).toBe(before.runs);
  expect(useRuns.getState().notices).toBe(before.notices);

  ending.resolve({ outcome: "ended", tx: "idle" });
  await ended;
  await useRuns.getState().run("t1", prepared("SELECT 1"));
  expect(executeQuery).toHaveBeenCalledTimes(3);
});

test("a_finished_event_of_a_stale_session_does_not_revive_the_transaction", async () => {
  vi.mocked(openSession)
    .mockResolvedValueOnce(session(3, "staging"))
    .mockResolvedValueOnce(session(4, "staging"));
  await openTwoStatements("staging");
  await useRuns.getState().run("t1", prepared("UPDATE a SET b = 3", "staging"));
  useRuns.getState().markStale("staging");
  expect(txOf("t1")).toBeUndefined();

  complete(2, "in_transaction");

  expect(txOf("t1")).toBeUndefined();
  expect(runOf("t1").status).toBe("finished");
});

test("release forgets the transaction and keeps the tab mode", async () => {
  await openTwoStatements();
  await useRuns.getState().release("t1");

  expect(txOf("t1")).toBeUndefined();
  expect(modeOf(useTabs.getState(), "t1")).toBe("manual");
});

test("reset forgets every transaction", async () => {
  await openTwoStatements();
  await useRuns.getState().reset();

  expect(useRuns.getState().transactions).toEqual({});
  expect(useRuns.getState().ending).toEqual({});
});

/** 두 문장 뒤에 행을 받다 만 SELECT가 running(ready)인 탭 t1. */
async function pausedSelect(): Promise<void> {
  await openTwoStatements();
  await useRuns.getState().run("t1", prepared("SELECT * FROM big"));
  onEventOf(2)(rowsEvent);
}

test("ending_a_paused_result_marks_the_discard_as_from_the_end", async () => {
  await pausedSelect();
  vi.mocked(endTransaction).mockResolvedValue({ outcome: "ended", tx: "idle" });

  await useRuns.getState().endTransaction("t1", "rollback");

  expect(useRuns.getState().discardedByEnd.t1).toBe(true);
});

test("ending_a_finished_result_does_not_mark_a_discard", async () => {
  await openTwoStatements();
  vi.mocked(endTransaction).mockResolvedValue({ outcome: "ended", tx: "idle" });

  await useRuns.getState().endTransaction("t1", "commit");

  expect(useRuns.getState().discardedByEnd.t1).toBeUndefined();
});

test("the_next_run_clears_the_discard_mark", async () => {
  await pausedSelect();
  vi.mocked(endTransaction).mockResolvedValue({ outcome: "ended", tx: "idle" });
  await useRuns.getState().endTransaction("t1", "rollback");

  await useRuns.getState().run("t1", prepared("SELECT 1"));

  expect(useRuns.getState().discardedByEnd.t1).toBeUndefined();
});

test("release_and_reset_forget_the_discard_mark", async () => {
  await pausedSelect();
  vi.mocked(endTransaction).mockResolvedValue({ outcome: "ended", tx: "idle" });
  await useRuns.getState().endTransaction("t1", "rollback");
  await useRuns.getState().release("t1");
  expect(useRuns.getState().discardedByEnd.t1).toBeUndefined();

  useRuns.setState({ discardedByEnd: { t1: true } });
  await useRuns.getState().reset();
  expect(useRuns.getState().discardedByEnd).toEqual({});
});

test("an_end_that_did_not_end_clears_the_discard_mark", async () => {
  await pausedSelect();
  vi.mocked(endTransaction).mockResolvedValue({
    outcome: "server_error",
    tx: "idle",
    error: {
      code: "23503",
      message: "violates foreign key constraint",
      detail: null,
      hint: null,
      position: null,
    },
  });

  await useRuns.getState().endTransaction("t1", "commit");

  expect(useRuns.getState().discardedByEnd.t1).toBeUndefined();
});

test("a_null_prepare_changes_nothing", async () => {
  await useRuns.getState().run("t", prepared("SELECT 1"));
  const before = useRuns.getState().runs.t;
  useRuns.setState({ notices: { t: { kind: "reconnected" } } });
  const state = useRuns.getState();

  await useRuns.getState().run("t", () => null);

  expect(useRuns.getState().runs.t).toBe(before);
  expect(useRuns.getState().notices).toBe(state.notices);
  expect(openSession).toHaveBeenCalledTimes(1);
  expect(executeQuery).toHaveBeenCalledTimes(1);
});

/** 문장마다 한 step인 실행. step의 from은 10씩 띄운다. */
function script(...sqls: string[]): Prepare {
  return () => ({
    connection: "local",
    steps: sqls.map((sql, index) => ({ sql, from: index * 10, origin })),
  });
}

function scriptOf(tabId: string) {
  return useRuns.getState().scripts[tabId];
}

/** n번째(0부터) 실행을 서버 오류로 끝낸다. */
function fail(call: number): void {
  onEventOf(call)({
    type: "finished",
    tx: "idle",
    elapsedMicros: 1,
    outcome: "failed",
    error: {
      code: "42P01",
      message: 'relation "order_items" does not exist',
      detail: null,
      hint: null,
      position: null,
    },
  });
}

/** executeQuery가 n번 불릴 때까지 기다린다. 다음 문장은 앞 문장의 finished 뒤에 보낸다. */
async function sent(count: number): Promise<void> {
  await vi.waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(count));
}

test("runs_steps_in_order_on_one_session", async () => {
  await useRuns.getState().run("t", script("SELECT 1", "SELECT 2", "SELECT 3"));
  expect(executeQuery).toHaveBeenCalledTimes(1);
  expect(scriptOf("t")).toMatchObject({
    current: 0,
    selected: 0,
    stoppedAt: null,
    done: [],
  });

  complete(0, "idle");
  await sent(2);
  complete(1, "idle");
  await sent(3);
  complete(2, "idle");

  expect(openSession).toHaveBeenCalledTimes(1);
  expect(
    vi
      .mocked(executeQuery)
      .mock.calls.map(([id, sql, mode, , options]) => [id, sql, mode, options]),
  ).toEqual([
    [3, "SELECT 1", "auto", { drain: true }],
    [3, "SELECT 2", "auto", { drain: true }],
    [3, "SELECT 3", "auto", { drain: false }],
  ]);
  const run = scriptOf("t");
  expect(run).toMatchObject({ current: 2, selected: 2, stoppedAt: null });
  expect(run.done.map((step) => step.status)).toEqual(["finished", "finished"]);
  expect(
    run.done.map((step) => step.status === "finished" && step.result.sql),
  ).toEqual(["SELECT 1", "SELECT 2"]);
  // 문장마다 runKey가 따로다.
  const keys = [
    ...run.done.map((step) => step.status === "finished" && step.result.runKey),
    (() => {
      const last = runOf("t");
      return last.status === "finished" && last.result.runKey;
    })(),
  ];
  expect(new Set(keys).size).toBe(3);
});

test("a_single_statement_has_no_script", async () => {
  await useRuns.getState().run("t", prepared("SELECT 1"));

  expect(scriptOf("t")).toBeUndefined();
  expect(vi.mocked(executeQuery).mock.calls[0][4]).toEqual({ drain: false });
});

test("stops_at_the_first_failure", async () => {
  await useRuns.getState().run("t", script("SELECT 1", "SELECT 2", "SELECT 3"));
  complete(0, "idle");
  await sent(2);

  fail(1);
  await Promise.resolve();

  expect(executeQuery).toHaveBeenCalledTimes(2);
  expect(scriptOf("t")).toMatchObject({
    current: 1,
    selected: 1,
    stoppedAt: 1,
  });
  expect(runOf("t")).toMatchObject({
    status: "finished",
    outcome: { outcome: "failed" },
  });
});

test("a_failure_in_the_last_statement_leaves_nothing_unrun", async () => {
  await useRuns.getState().run("t", script("SELECT 1", "SELECT 2"));
  complete(0, "idle");
  await sent(2);

  fail(1);

  expect(scriptOf("t")).toMatchObject({ current: 1, stoppedAt: null });
});

test("cancel_stops_the_script", async () => {
  vi.mocked(executeQuery).mockResolvedValueOnce(7).mockResolvedValueOnce(8);
  await useRuns.getState().run("t", script("SELECT 1", "SELECT 2", "SELECT 3"));
  complete(0, "idle");
  await sent(2);

  await useRuns.getState().cancel("t");
  expect(cancelQuery).toHaveBeenCalledWith(3, 8);
  finish(1, "cancelled", "idle");
  await Promise.resolve();

  expect(executeQuery).toHaveBeenCalledTimes(2);
  expect(scriptOf("t")).toMatchObject({ current: 1, stoppedAt: 1 });
});

test("a_cancelled_confirmation_stops_before_that_step", async () => {
  const confirmStep = vi.fn((step: { sql: string }) =>
    Promise.resolve(!step.sql.startsWith("DELETE")),
  );
  await useRuns
    .getState()
    .run(
      "t",
      script("SELECT 1", "SELECT 2", "DELETE FROM a", "SELECT 4"),
      confirmStep,
    );
  // 첫 문장은 prepare가 확인한다.
  expect(confirmStep).not.toHaveBeenCalled();

  complete(0, "idle");
  await sent(2);
  expect(confirmStep).toHaveBeenLastCalledWith({
    sql: "SELECT 2",
    from: 10,
    origin,
  });
  complete(1, "idle");
  await vi.waitFor(() => expect(confirmStep).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(scriptOf("t").stoppedAt).toBe(1));

  expect(executeQuery).toHaveBeenCalledTimes(2);
  expect(scriptOf("t")).toMatchObject({ current: 1, selected: 1 });
  expect(runOf("t")).toMatchObject({
    status: "finished",
    outcome: { outcome: "completed" },
  });
});

test("a_confirmation_answered_after_a_new_run_sends_nothing", async () => {
  const answer = deferred<boolean>();
  await useRuns
    .getState()
    .run("t", script("SELECT 1", "DELETE FROM a"), () => answer.promise);
  complete(0, "idle");
  await useRuns.getState().run("t", prepared("SELECT 9"));

  answer.resolve(true);
  await Promise.resolve();
  await Promise.resolve();

  expect(executeQuery).toHaveBeenCalledTimes(2);
  expect(vi.mocked(executeQuery).mock.calls[1][1]).toBe("SELECT 9");
});

test("each_step_counts_toward_the_transaction", async () => {
  setTabMode("t1", "manual");
  await useRuns
    .getState()
    .run(
      "t1",
      script("UPDATE a SET b = 1", "UPDATE a SET b = 2", "UPDATE a SET b = 3"),
    );
  complete(0, "in_transaction");
  await sent(2);
  complete(1, "in_transaction");
  await sent(3);
  complete(2, "in_transaction");

  expect(vi.mocked(executeQuery).mock.calls.map((call) => call[2])).toEqual([
    "manual",
    "manual",
    "manual",
  ]);
  expect(txOf("t1")).toEqual(
    expect.objectContaining({ status: "open", statements: 3, openedBy: "app" }),
  );
});

test("last_step_can_fetch_more", async () => {
  vi.mocked(executeQuery).mockResolvedValueOnce(7).mockResolvedValueOnce(8);
  await useRuns.getState().run("t", script("SELECT 1", "SELECT 2"));
  complete(0, "idle");
  await sent(2);
  onEventOf(1)(rowsEvent);

  await useRuns.getState().fetchMore("t");

  expect(fetchMore).toHaveBeenCalledWith(3, 8);
});

test("earlier_steps_are_frozen", async () => {
  await useRuns.getState().run("t", script("SELECT 1", "SELECT 2"));
  onEventOf(0)({ type: "columns", columns: resultColumns("id") });
  onEventOf(0)(rowsEvent);

  // 끝까지 읽는 문장은 이어서 가져오지 않는다. 읽는 중이라 Commit도 기다린다.
  const reading = runOf("t");
  expect(reading.status === "running" && reading.result.fetch).toBe("none");
  await useRuns.getState().fetchMore("t");
  expect(fetchMore).not.toHaveBeenCalled();

  onEventOf(0)({
    type: "finished",
    tx: "idle",
    elapsedMicros: 1,
    outcome: "completed",
    rows: 1200,
  });
  await sent(2);
  const [first] = scriptOf("t").done;
  expect(first).toMatchObject({
    status: "finished",
    result: { sql: "SELECT 1", rows: [["1"]], fetch: "none" },
    outcome: { outcome: "completed", rows: 1200 },
  });
  await useRuns.getState().fetchMore("t");
  expect(fetchMore).not.toHaveBeenCalled();
});

test("a_new_run_replaces_the_script", async () => {
  await useRuns.getState().run("t", script("SELECT 1", "SELECT 2", "SELECT 3"));
  await useRuns.getState().run("t", prepared("SELECT 9"));

  expect(scriptOf("t")).toBeUndefined();
  // 밀려난 문장의 늦은 finished는 다음 문장을 보내지 않는다.
  complete(0, "idle");
  await Promise.resolve();
  expect(executeQuery).toHaveBeenCalledTimes(2);

  await useRuns.getState().run("t", script("SELECT 4", "SELECT 5"));
  expect(scriptOf("t")).toMatchObject({ current: 0, done: [] });
  expect(scriptOf("t").steps.map((step) => step.sql)).toEqual([
    "SELECT 4",
    "SELECT 5",
  ]);
});

test("release_forgets_the_script", async () => {
  await useRuns.getState().run("t", script("SELECT 1", "SELECT 2"));
  await useRuns.getState().release("t");

  expect(scriptOf("t")).toBeUndefined();
  complete(0, "idle");
  await Promise.resolve();
  expect(executeQuery).toHaveBeenCalledTimes(1);
});

test("select_step_shows_a_step_that_has_a_result", async () => {
  await useRuns.getState().run("t", script("SELECT 1", "SELECT 2", "SELECT 3"));
  complete(0, "idle");
  await sent(2);
  fail(1);

  useRuns.getState().selectStep("t", 0);
  expect(scriptOf("t").selected).toBe(0);
  // 실행하지 않은 문장은 고르지 않는다.
  useRuns.getState().selectStep("t", 2);
  expect(scriptOf("t").selected).toBe(0);
  useRuns.getState().selectStep("t", 1);
  expect(scriptOf("t").selected).toBe(1);
});

test("a_rejected_step_keeps_the_earlier_results", async () => {
  vi.mocked(executeQuery)
    .mockResolvedValueOnce(7)
    .mockRejectedValueOnce(
      new CommandError("unknown_session", "세션이 없습니다"),
    );
  await useRuns.getState().run("t", script("SELECT 1", "SELECT 2", "SELECT 3"));
  complete(0, "idle");

  await vi.waitFor(() => expect(runOf("t").status).toBe("rejected"));
  expect(runOf("t")).toEqual({
    status: "rejected",
    rejection: { title: "세션이 없습니다", detail: null },
  });
  expect(scriptOf("t")).toMatchObject({
    current: 1,
    selected: 1,
    stoppedAt: 1,
  });
  expect(scriptOf("t").done).toHaveLength(1);
  expect(executeQuery).toHaveBeenCalledTimes(2);
});

test("an_end_between_statements_stops_the_script", async () => {
  vi.mocked(endTransaction).mockResolvedValue({ outcome: "ended", tx: "idle" });
  setTabMode("t1", "manual");
  const answer = deferred<boolean>();
  await useRuns
    .getState()
    .run(
      "t1",
      script("UPDATE a SET b = 1", "UPDATE a SET b = 2"),
      () => answer.promise,
    );
  complete(0, "in_transaction");

  // 다음 문장의 확인을 기다리는 동안 Commit이 끝났다.
  await expect(useRuns.getState().endTransaction("t1", "commit")).resolves.toBe(
    true,
  );
  answer.resolve(true);

  await vi.waitFor(() => expect(scriptOf("t1").stoppedAt).toBe(0));
  expect(executeQuery).toHaveBeenCalledTimes(1);
});

/** 서버가 `elapsedMicros`로 끝냈다는 finished event. */
function finishedEvent(
  elapsedMicros = 1,
  outcome: "completed" | "discarded" = "completed",
): QueryEvent {
  return outcome === "completed"
    ? { type: "finished", tx: "idle", elapsedMicros, outcome, rows: 1 }
    : { type: "finished", tx: "idle", elapsedMicros, outcome };
}

test("records_once_on_the_first_rows", async () => {
  openProjectWith();
  const before = Date.now();
  await useRuns.getState().run("t", prepared("SELECT 1", "staging"));
  const onEvent = onEventOf(0);

  onEvent({ ...rowsEvent, elapsedMicros: 10 });
  onEvent({ ...rowsEvent, elapsedMicros: 20 });
  onEvent(finishedEvent(30));

  expect(recordQuery).toHaveBeenCalledTimes(1);
  expect(recordQuery).toHaveBeenCalledWith("/p", {
    connection: "staging",
    sql: "SELECT 1",
    executedAt: expect.any(Number),
    elapsedMicros: 10,
  });
  const [, saved] = vi.mocked(recordQuery).mock.calls[0];
  expect(saved.executedAt).toBeGreaterThanOrEqual(before);
  expect(saved.executedAt).toBeLessThanOrEqual(Date.now());
});

test("records_a_statement_without_rows_on_finished", async () => {
  openProjectWith();
  await useRuns.getState().run("t", prepared("CREATE TABLE a ()"));

  onEventOf(0)(finishedEvent(7));

  expect(recordQuery).toHaveBeenCalledTimes(1);
  expect(recordQuery).toHaveBeenCalledWith(
    "/p",
    expect.objectContaining({ sql: "CREATE TABLE a ()", elapsedMicros: 7 }),
  );
});

test("records_a_failed_statement", async () => {
  openProjectWith();
  await useRuns.getState().run("t", prepared("SELECT * FROM nope"));

  fail(0);

  expect(recordQuery).toHaveBeenCalledTimes(1);
  expect(recordQuery).toHaveBeenCalledWith(
    "/p",
    expect.objectContaining({ sql: "SELECT * FROM nope", elapsedMicros: 1 }),
  );
});

test("does_not_record_a_discarded_first_event", async () => {
  openProjectWith();
  await useRuns.getState().run("t", prepared("SELECT 1"));

  onEventOf(0)(finishedEvent(3, "discarded"));

  expect(recordQuery).not.toHaveBeenCalled();
});

test("records_a_superseded_execution_too", async () => {
  openProjectWith();
  await useRuns.getState().run("t", prepared("SELECT 1"));
  const lateA = onEventOf(0);
  await useRuns.getState().run("t", prepared("SELECT 2"));

  lateA(rowsEvent);

  expect(recordQuery).toHaveBeenCalledTimes(1);
  expect(recordQuery).toHaveBeenCalledWith(
    "/p",
    expect.objectContaining({ sql: "SELECT 1" }),
  );
});

test("does_not_record_when_the_session_did_not_open", async () => {
  openProjectWith();
  vi.mocked(openSession).mockRejectedValue(
    new CommandError("connect_failed", "refused"),
  );

  await useRuns.getState().run("t", prepared("SELECT 1"));

  expect(executeQuery).not.toHaveBeenCalled();
  expect(recordQuery).not.toHaveBeenCalled();
});

test("records_each_statement_of_a_script", async () => {
  openProjectWith();
  const running = useRuns.getState().run("t", script("SELECT 1", "SELECT 2"));
  await sent(1);
  onEventOf(0)(rowsEvent);
  onEventOf(0)(finishedEvent(4));
  await sent(2);
  onEventOf(1)(finishedEvent(6));
  await running;

  expect(
    vi.mocked(recordQuery).mock.calls.map(([, entry]) => entry.sql),
  ).toEqual(["SELECT 1", "SELECT 2"]);
});

test("a_record_failure_does_not_disturb_the_run", async () => {
  openProjectWith();
  vi.mocked(recordQuery).mockRejectedValue(
    new CommandError("store_unavailable", "no store"),
  );
  await useRuns.getState().run("t", prepared("SELECT 1"));

  onEventOf(0)(rowsEvent);
  onEventOf(0)(finishedEvent(2));
  await Promise.resolve();

  expect(runOf("t").status).toBe("finished");
});
