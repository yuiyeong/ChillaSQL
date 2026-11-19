import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/dialog");

import {
  cancelQuery,
  cancelTunnel,
  closeSession,
  executeQuery,
  listSqlFiles,
  openProject,
  openSession,
  splitStatements,
  writeSqlFile,
} from "../../shared/api/commands";
import { pickDirectory } from "../../shared/api/dialog";
import { CommandError } from "../../shared/api/errors";
import type { Project, QueryEvent, Session } from "../../shared/api/types";
import {
  documentState,
  openDocument,
  setDocumentState,
} from "../editor/documents";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { useRuns } from "../query/runsStore";
import {
  applySavedProject,
  changeConnection,
  closeTab,
  execute,
  cancelRun,
  runAgain,
  switchProject,
} from "./commands";
import { useTunnels } from "../connections/tunnelsStore";
import { useDialogs } from "../../shared/ui/dialogs";
import { answerDialog, textOf } from "../../test/dialogs";
import { deferred } from "../../test/deferred";
import { connection } from "../../test/fixtures";
import { resetStores } from "../../test/resetStores";

const project: Project = { name: "demo", dir: "/p", connections: [] };

function session(id: number): Session {
  return { id, connection: "local", backendPid: 100 + id };
}

/** 새 탭을 만들고 text와 접속을 둔다. 활성 탭이 된다. */
function tabWith(text: string, connection: string | null = "local"): string {
  const id = useTabs.getState().newTab();
  openDocument(id, text);
  useTabs.getState().setConnection(id, connection);
  return id;
}

function select(tabId: string, anchor: number, head = anchor): void {
  setDocumentState(
    tabId,
    documentState(tabId).update({ selection: { anchor, head } }).state,
  );
}

function tabOf(id: string) {
  return useTabs.getState().tabs.find((tab) => tab.id === id);
}

/** n번째(0부터) executeQuery 호출에 넘긴 onEvent. */
function onEventOf(call: number): (event: QueryEvent) => void {
  return vi.mocked(executeQuery).mock.calls[call][3];
}

function runOf(tabId: string) {
  return useRuns.getState().runs[tabId];
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetStores();
  vi.resetAllMocks();
  useProject.setState({ status: "ready", project });
  vi.mocked(openSession).mockResolvedValue(session(3));
  vi.mocked(executeQuery).mockResolvedValue(7);
  vi.mocked(closeSession).mockResolvedValue();
  vi.mocked(cancelQuery).mockResolvedValue();
  vi.mocked(listSqlFiles).mockResolvedValue([]);
});

test("접속이 없으면 Choose a connection으로 거절한다", async () => {
  const id = tabWith("SELECT 1", null);

  await execute("run");

  expect(runOf(id)).toEqual({
    status: "rejected",
    rejection: { title: "Choose a connection to run queries.", detail: null },
  });
  expect(splitStatements).not.toHaveBeenCalled();
  expect(openSession).not.toHaveBeenCalled();
});

test("선택 영역은 고른 그대로 실행한다", async () => {
  const id = tabWith("SELECT 1;\n  SELECT 2  ;");
  select(id, 11, 21);

  await execute("run");

  expect(openSession).toHaveBeenCalledWith("local");
  expect(executeQuery).toHaveBeenCalledWith(
    3,
    " SELECT 2 ",
    "auto",
    expect.any(Function),
  );
  expect(runOf(id)).toMatchObject({
    status: "running",
    result: { sql: " SELECT 2 ", origin: { line: 2, column: 2 } },
  });
  expect(splitStatements).not.toHaveBeenCalled();
});

test("공백뿐인 선택 영역은 실행하지 않는다", async () => {
  const id = tabWith("SELECT 1;\n   \nSELECT 2");
  select(id, 10, 13);

  await execute("run");

  expect(runOf(id)).toEqual({
    status: "rejected",
    rejection: { title: "Nothing to run", detail: null },
  });
  expect(splitStatements).not.toHaveBeenCalled();
  expect(executeQuery).not.toHaveBeenCalled();
});

test("선택이 없으면 커서 문장을 실행한다", async () => {
  vi.mocked(splitStatements).mockResolvedValue([
    { start: 0, end: 8 },
    { start: 10, end: 18 },
  ]);
  const id = tabWith("SELECT 1;\nSELECT 2");
  select(id, 12);

  await execute("run");

  expect(splitStatements).toHaveBeenCalledWith("SELECT 1;\nSELECT 2");
  expect(executeQuery).toHaveBeenCalledWith(
    3,
    "SELECT 2",
    "auto",
    expect.any(Function),
  );
  expect(runOf(id)).toMatchObject({
    status: "running",
    result: { sql: "SELECT 2", origin: { line: 2, column: 1 } },
  });
});

test("split_failed는 Couldn't find a statement로 거절한다", async () => {
  vi.mocked(splitStatements).mockRejectedValue(
    new CommandError("split_failed", "문장을 나눌 수 없습니다"),
  );
  const id = tabWith("SELECT 'a");

  await execute("run");

  expect(runOf(id)).toEqual({
    status: "rejected",
    rejection: {
      title: "Couldn't find a statement",
      detail:
        "An unclosed quote keeps the text from being split into statements. Select what to run and it is sent as is.",
    },
  });
  expect(openSession).not.toHaveBeenCalled();
  expect(executeQuery).not.toHaveBeenCalled();
});

test("커서 위치에 문장이 없으면 실행하지 않는다", async () => {
  vi.mocked(splitStatements).mockResolvedValue([
    { start: 0, end: 8 },
    { start: 11, end: 19 },
  ]);
  const id = tabWith("SELECT 1;\n\nSELECT 2");
  select(id, 10);

  await execute("run");

  expect(runOf(id)).toEqual({
    status: "rejected",
    rejection: { title: "No statement at the cursor", detail: null },
  });
  expect(executeQuery).not.toHaveBeenCalled();
});

test("문장을 나누는 동안 탭을 닫으면 실행하지 않는다", async () => {
  const split = deferred<{ start: number; end: number }[]>();
  vi.mocked(splitStatements).mockReturnValue(split.promise);
  const id = tabWith("SELECT 1");

  const running = execute("run");
  await closeTab(id);
  split.resolve([{ start: 0, end: 8 }]);
  await running;

  expect(openSession).not.toHaveBeenCalled();
  expect(runOf(id)).toBeUndefined();
});

test("문장을 나누는 동안 접속을 바꾸면 실행하지 않는다", async () => {
  const split = deferred<{ start: number; end: number }[]>();
  vi.mocked(splitStatements).mockReturnValue(split.promise);
  const id = tabWith("SELECT 1");

  const running = execute("run");
  await changeConnection(id, "staging");
  split.resolve([{ start: 0, end: 8 }]);
  await running;

  expect(openSession).not.toHaveBeenCalled();
  expect(executeQuery).not.toHaveBeenCalled();
  expect(runOf(id)).toBeUndefined();
  expect(tabOf(id)?.connection).toBe("staging");
});

test("활성 탭이 없으면 command는 아무것도 하지 않는다", async () => {
  for (const command of ["run", "cancel", "save", "closeTab"] as const) {
    await execute(command);
  }

  expect(useRuns.getState().runs).toEqual({});
  expect(writeSqlFile).not.toHaveBeenCalled();
  expect(useDialogs.getState().current).toBeNull();
});

test("dirty 탭은 물어본 뒤에 닫는다", async () => {
  const id = tabWith("SELECT 1");
  await useRuns.getState().run(id, () => ({
    connection: "local",
    sql: "SELECT 1",
    origin: { line: 1, column: 1 },
  }));
  useTabs.getState().markDirty(id);
  // 처음 state object를 고치지 않게 새 object에 spy를 단다.
  useRuns.setState({ ...useRuns.getState() });
  const release = vi.spyOn(useRuns.getState(), "release");

  const cancelling = closeTab(id);
  const spec = await answerDialog("cancel");
  await cancelling;

  expect(textOf(spec.title)).toBe("Save changes to Query 1?");
  expect(textOf(spec.body)).toBe(
    "Your changes will be lost if you don't save them.",
  );
  expect(
    spec.actions.map(({ id, label, variant }) => [id, label, variant]),
  ).toEqual([
    ["discard", "Don't save", "ghost"],
    ["cancel", "Cancel", undefined],
    ["save", "Save", "primary"],
  ]);
  expect(tabOf(id)).toBeDefined();
  expect(release).not.toHaveBeenCalled();

  let openWhenReleased: boolean | undefined;
  release.mockImplementationOnce(async (tabId) => {
    openWhenReleased = tabOf(tabId) !== undefined;
    await useRuns.getInitialState().release(tabId);
  });

  const discarding = closeTab(id);
  await answerDialog("discard");
  await discarding;

  expect(release).toHaveBeenCalledWith(id);
  expect(openWhenReleased).toBe(true);
  expect(tabOf(id)).toBeUndefined();
  expect(closeSession).toHaveBeenCalledWith(3);
  expect(runOf(id)).toBeUndefined();
});

test("dirty가 아닌 탭은 묻지 않고 닫는다", async () => {
  const id = tabWith("SELECT 1");

  await execute("closeTab");

  expect(useDialogs.getState().current).toBeNull();
  expect(tabOf(id)).toBeUndefined();
});

test("활성이 아닌 이름 없는 탭의 Save는 그 탭을 활성으로 하고 이름을 묻는다", async () => {
  const untitled = tabWith("SELECT 1");
  useTabs.getState().markDirty(untitled);
  const other = tabWith("SELECT 2");
  expect(useTabs.getState().activeId).toBe(other);

  const closing = closeTab(untitled);
  await answerDialog("save");
  await closing;

  // 이름 dialog는 활성 탭에만 그려지므로 그 탭이 활성이어야 보인다.
  expect(useTabs.getState().activeId).toBe(untitled);
  expect(useTabs.getState().naming).toBe(untitled);
  expect(tabOf(untitled)).toBeDefined();
});

test("dirty 탭의 Save는 저장에 성공했을 때만 닫는다", async () => {
  // 이름이 없는 탭은 이름을 물으러 가므로 닫지 않는다.
  const untitled = tabWith("SELECT 1");
  useTabs.getState().markDirty(untitled);
  const naming = closeTab(untitled);
  await answerDialog("save");
  await naming;
  expect(tabOf(untitled)).toBeDefined();
  expect(useTabs.getState().naming).toBe(untitled);
  expect(writeSqlFile).not.toHaveBeenCalled();

  // 저장에 실패해도 닫지 않는다.
  const file = tabWith("SELECT 2");
  useTabs.getState().markSaved(file, "queries/b.sql", "s1");
  useTabs.getState().markDirty(file);
  vi.mocked(writeSqlFile).mockRejectedValueOnce(
    new CommandError("io", "쓸 수 없습니다"),
  );
  const failing = closeTab(file);
  await answerDialog("save");
  await failing;
  expect(tabOf(file)).toBeDefined();
  expect(useTabs.getState().error).toBe("쓸 수 없습니다");

  // 저장하면 닫는다.
  vi.mocked(writeSqlFile).mockResolvedValueOnce("s2");
  const saving = closeTab(file);
  await answerDialog("save");
  await saving;
  expect(writeSqlFile).toHaveBeenLastCalledWith("queries/b.sql", "SELECT 2", {
    mode: "replace",
    stamp: "s1",
  });
  expect(tabOf(file)).toBeUndefined();
});

test("접속을 바꾸면 세션을 놓는다", async () => {
  const id = tabWith("SELECT 1");
  await useRuns.getState().run(id, () => ({
    connection: "local",
    sql: "SELECT 1",
    origin: { line: 1, column: 1 },
  }));
  // 처음 state object를 고치지 않게 새 object에 spy를 단다.
  useRuns.setState({ ...useRuns.getState() });
  const release = vi.spyOn(useRuns.getState(), "release");
  let connectionWhenReleased: string | null | undefined;
  release.mockImplementationOnce(async (tabId) => {
    connectionWhenReleased = tabOf(tabId)?.connection;
    await useRuns.getInitialState().release(tabId);
  });

  await changeConnection(id, "staging");

  expect(connectionWhenReleased).toBe("local");
  expect(tabOf(id)?.connection).toBe("staging");
  expect(closeSession).toHaveBeenCalledWith(3);
  expect(runOf(id)).toBeUndefined();
});

test("프로젝트를 바꾸면 탭과 실행 상태를 비운다", async () => {
  const other: Project = { name: "other", dir: "/q", connections: [] };
  const id = tabWith("SELECT 1");
  await useRuns.getState().run(id, () => ({
    connection: "local",
    sql: "SELECT 1",
    origin: { line: 1, column: 1 },
  }));

  // 폴더를 고르지 않으면 아무것도 하지 않는다.
  vi.mocked(pickDirectory).mockResolvedValue(null);
  await switchProject();
  expect(openProject).not.toHaveBeenCalled();
  expect(tabOf(id)).toBeDefined();
  expect(runOf(id)?.status).toBe("running");

  // 열지 못하면 열려 있던 프로젝트와 탭이 그대로다.
  vi.mocked(pickDirectory).mockResolvedValue("/empty");
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );
  await switchProject();
  expect(useProject.getState().project).toEqual(project);
  expect(useProject.getState().error).toBe("chilla.toml이 없습니다");
  expect(tabOf(id)).toBeDefined();
  expect(runOf(id)?.status).toBe("running");
  expect(closeSession).not.toHaveBeenCalled();

  // 열면 탭과 실행 상태를 비우고 세션을 놓는다.
  vi.mocked(pickDirectory).mockResolvedValue("/q");
  vi.mocked(openProject).mockResolvedValue(other);
  await switchProject();
  expect(openProject).toHaveBeenLastCalledWith("/q");
  expect(useProject.getState().project).toEqual(other);
  expect(useTabs.getState().tabs).toEqual([]);
  expect(useTabs.getState().activeId).toBeNull();
  expect(useRuns.getState().runs).toEqual({});
  expect(closeSession).toHaveBeenCalledWith(3);
});

test("세션을 닫지 못해도 프로젝트를 바꾼다", async () => {
  vi.mocked(closeSession).mockRejectedValue(
    new CommandError("unknown_session", "세션이 없습니다"),
  );
  const id = tabWith("SELECT 1");
  await useRuns.getState().run(id, () => ({
    connection: "local",
    sql: "SELECT 1",
    origin: { line: 1, column: 1 },
  }));
  vi.mocked(pickDirectory).mockResolvedValue("/q");
  vi.mocked(openProject).mockResolvedValue({ ...project, dir: "/q" });

  await switchProject();

  expect(useTabs.getState().tabs).toEqual([]);
  expect(useRuns.getState().runs).toEqual({});
});

test("dirty 탭이 있으면 프로젝트를 바꾸기 전에 묻는다", async () => {
  const a = tabWith("SELECT 1");
  const b = tabWith("SELECT 2");
  tabWith("SELECT 3");
  useTabs.getState().markDirty(a);
  useTabs.getState().markDirty(b);

  const switching = switchProject();
  const spec = await answerDialog("cancel");
  await switching;

  expect(textOf(spec.title)).toBe("2 tabs have unsaved changes");
  expect(spec.items?.map((item) => item.primary)).toEqual([
    "Query 1",
    "Query 2",
  ]);
  expect(textOf(spec.note)).toBe(
    "Switching projects discards these changes and closes every tab's session.",
  );
  expect(spec.actions.map(({ id, label }) => [id, label])).toEqual([
    ["cancel", "Cancel"],
    ["switch", "Switch without saving"],
  ]);
  expect(pickDirectory).not.toHaveBeenCalled();
  expect(useTabs.getState().tabs).toHaveLength(3);
});

test("dirty 탭이 하나면 단수 제목으로 묻고 바꾸겠다고 하면 폴더를 고른다", async () => {
  const a = tabWith("SELECT 1");
  useTabs.getState().markDirty(a);
  vi.mocked(pickDirectory).mockResolvedValue(null);

  const switching = switchProject();
  const spec = await answerDialog("switch");
  await switching;

  expect(textOf(spec.title)).toBe("1 tab has unsaved changes");
  expect(pickDirectory).toHaveBeenCalledTimes(1);
});

test("save, cancel, newTab, nextTab, prevTab은 활성 탭에 한다", async () => {
  const first = tabWith("SELECT 1");
  const second = tabWith("SELECT 2");
  useTabs.getState().markSaved(second, "queries/b.sql", "s1");
  useTabs.getState().markDirty(second);
  vi.mocked(writeSqlFile).mockResolvedValue("s2");

  await execute("save");

  expect(writeSqlFile).toHaveBeenCalledTimes(1);
  expect(writeSqlFile).toHaveBeenCalledWith("queries/b.sql", "SELECT 2", {
    mode: "replace",
    stamp: "s1",
  });
  expect(tabOf(second)?.dirty).toBe(false);

  await useRuns.getState().run(second, () => ({
    connection: "local",
    sql: "SELECT 2",
    origin: { line: 1, column: 1 },
  }));
  await execute("cancel");
  expect(cancelQuery).toHaveBeenCalledWith(3, 7);

  await execute("prevTab");
  expect(useTabs.getState().activeId).toBe(first);
  await execute("nextTab");
  expect(useTabs.getState().activeId).toBe(second);

  await execute("newTab");
  const { tabs, activeId } = useTabs.getState();
  expect(tabs).toHaveLength(3);
  expect(activeId).toBe(tabs[2].id);
  expect(tabs[2].connection).toBe("local");
});

test("저장이 끝나기 전에는 다시 저장하지 않는다", async () => {
  const id = tabWith("SELECT 1");
  useTabs.getState().markSaved(id, "queries/a.sql", "s1");
  useTabs.getState().markDirty(id);
  const write = deferred<string>();
  vi.mocked(writeSqlFile).mockReturnValueOnce(write.promise);

  const saving = execute("save");
  await execute("save");
  expect(writeSqlFile).toHaveBeenCalledTimes(1);

  write.resolve("s2");
  await saving;
  vi.mocked(writeSqlFile).mockResolvedValue("s3");
  useTabs.getState().markDirty(id);
  await execute("save");

  expect(writeSqlFile).toHaveBeenCalledTimes(2);
  expect(writeSqlFile).toHaveBeenLastCalledWith("queries/a.sql", "SELECT 1", {
    mode: "replace",
    stamp: "s2",
  });
});

/** 그 접속으로 실행한 탭. 세션이 열려 있다. */
async function ranTab(name: string, sessionId: number): Promise<string> {
  const id = tabWith("SELECT 1", name);
  vi.mocked(openSession).mockResolvedValueOnce({
    id: sessionId,
    connection: name,
    backendPid: 100 + sessionId,
  });
  await useRuns.getState().run(id, () => ({
    connection: name,
    sql: "SELECT 1",
    origin: { line: 1, column: 1 },
  }));
  return id;
}

test("대상이 바뀐 접속을 쓰는 탭의 세션을 놓는다", async () => {
  useProject.setState({
    project: {
      ...project,
      connections: [connection("local"), connection("staging")],
    },
  });
  const local = await ranTab("local", 3);
  const staging = await ranTab("staging", 4);
  const saved: Project = {
    ...project,
    connections: [
      connection("local", { host: "b.internal" }),
      connection("staging"),
    ],
  };

  await applySavedProject(saved);

  expect(useProject.getState().project).toEqual(saved);
  expect(closeSession).toHaveBeenCalledTimes(1);
  expect(closeSession).toHaveBeenCalledWith(3);
  expect(runOf(local)).toBeUndefined();
  expect(runOf(staging)?.status).toBe("running");

  vi.mocked(openSession).mockResolvedValueOnce(session(5));
  useTabs.getState().activate(local);
  select(local, 0, 8);
  await execute("run");
  expect(openSession).toHaveBeenCalledTimes(3);
  expect(openSession).toHaveBeenLastCalledWith("local");
});

test("대상이 그대로면 세션을 놓지 않는다", async () => {
  useProject.setState({
    project: { ...project, connections: [connection("local")] },
  });
  const id = await ranTab("local", 3);
  const saved: Project = {
    ...project,
    connections: [connection("local", { color: "red" })],
  };

  await applySavedProject(saved);

  expect(useProject.getState().project).toEqual(saved);
  expect(closeSession).not.toHaveBeenCalled();
  expect(runOf(id)?.status).toBe("running");
});

test("디렉토리 고르기가 실패하면 프로젝트 오류로 보여 준다", async () => {
  const id = tabWith("SELECT 1");
  await useRuns.getState().run(id, () => ({
    connection: "local",
    sql: "SELECT 1",
    origin: { line: 1, column: 1 },
  }));
  vi.mocked(pickDirectory).mockRejectedValue(new Error("창을 열지 못했습니다"));

  await switchProject();

  expect(useProject.getState().error).toBe("창을 열지 못했습니다");
  expect(useProject.getState().project).toEqual(project);
  expect(tabOf(id)).toBeDefined();
  expect(runOf(id)?.status).toBe("running");
});

test("그 밖의 split 오류는 그 message를 title로 거절한다", async () => {
  vi.mocked(splitStatements).mockRejectedValue(new Error("boom"));
  const id = tabWith("SELECT 1");

  await execute("run");

  expect(runOf(id)).toEqual({
    status: "rejected",
    rejection: { title: "boom", detail: null },
  });
});

test("runAgain은 같은 SQL을 지금 접속으로 다시 실행한다", async () => {
  vi.mocked(splitStatements).mockResolvedValue([{ start: 10, end: 18 }]);
  const id = tabWith("SELECT 1;\nSELECT 2");
  select(id, 12);
  await execute("run");
  expect(executeQuery).toHaveBeenLastCalledWith(
    3,
    "SELECT 2",
    "auto",
    expect.any(Function),
  );

  // 커서를 옮기고 접속을 바꿔도 결과의 SQL을 그대로 보낸다.
  select(id, 0);
  useTabs.getState().setConnection(id, "other");
  vi.mocked(openSession).mockResolvedValue({
    ...session(4),
    connection: "other",
  });
  await runAgain(id);

  expect(openSession).toHaveBeenLastCalledWith("other");
  expect(executeQuery).toHaveBeenCalledTimes(2);
  expect(executeQuery).toHaveBeenLastCalledWith(
    4,
    "SELECT 2",
    "auto",
    expect.any(Function),
  );
  expect(runOf(id)).toMatchObject({
    status: "running",
    result: { sql: "SELECT 2", origin: { line: 2, column: 1 } },
  });
});

test("runAgain은 결과가 없으면 아무것도 하지 않는다", async () => {
  const id = tabWith("SELECT 1");

  await runAgain(id);

  expect(openSession).not.toHaveBeenCalled();
  expect(runOf(id)).toBeUndefined();
});

test("runAgain은 접속이 없으면 거절한다", async () => {
  vi.mocked(splitStatements).mockResolvedValue([{ start: 0, end: 8 }]);
  const id = tabWith("SELECT 1");
  await execute("run");
  onEventOf(0)({
    type: "finished",
    tx: "idle",
    elapsedMicros: 1,
    outcome: "completed",
    rows: 0,
  });
  useTabs.getState().setConnection(id, null);

  await runAgain(id);

  expect(runOf(id)).toMatchObject({
    status: "rejected",
    rejection: { title: "Choose a connection to run queries." },
  });
});

test("터널이 시작 중인 연결 중 탭의 취소는 터널 시작을 멈춘다", async () => {
  const id = tabWith("SELECT 1", "staging");
  const opening = deferred<Session>();
  vi.mocked(openSession).mockReturnValue(opening.promise);
  void useRuns.getState().run(id, () => ({
    connection: "staging",
    sql: "SELECT 1",
    origin: { line: 1, column: 1 },
  }));
  expect(runOf(id)?.status).toBe("connecting");
  useTunnels.getState().apply({
    connection: "staging",
    state: { status: "starting", attempt: 0, timeoutSecs: 20 },
  });
  const cancel = vi.spyOn(useRuns.getState(), "cancel");

  await cancelRun(id);
  expect(cancelTunnel).toHaveBeenCalledWith("staging");
  expect(cancel).not.toHaveBeenCalled();

  // 터널이 열렸으면 실행을 취소한다.
  useTunnels
    .getState()
    .apply({ connection: "staging", state: { status: "ready" } });
  await cancelRun(id);
  expect(cancel).toHaveBeenCalledWith(id);
  cancel.mockRestore();
  opening.resolve(session(3));
});

test("프로젝트를 바꾸면 터널 상태를 비운다", async () => {
  useTunnels
    .getState()
    .apply({ connection: "staging", state: { status: "ready" } });
  vi.mocked(pickDirectory).mockResolvedValue("/q");
  vi.mocked(openProject).mockResolvedValue({
    name: "q",
    dir: "/q",
    connections: [],
  });
  await switchProject();
  expect(useTunnels.getState().tunnels).toEqual({});
});
