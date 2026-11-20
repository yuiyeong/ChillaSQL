import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/dialog");

import {
  cancelQuery,
  cancelTunnel,
  closeCatalog,
  closeSession,
  endTransaction,
  executeQuery,
  inspectStatement,
  listSqlFiles,
  loadCatalog,
  openProject,
  openSession,
  splitStatements,
  writeSqlFile,
} from "../../shared/api/commands";
import { pickDirectory } from "../../shared/api/dialog";
import { CommandError } from "../../shared/api/errors";
import type {
  Project,
  QueryEvent,
  Session,
  TxStatus,
} from "../../shared/api/types";
import {
  closeDocument,
  documentState,
  openDocument,
  setDocumentState,
} from "../editor/documents";
import { anchorOf, runMarksField } from "../editor/runMarks";
import { setStatementSpans } from "../editor/statementSpans";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { useRuns } from "../query/runsStore";
import { useTypes } from "../query/typesStore";
import {
  applySavedProject,
  applySavedProjectKeepingSessions,
  connectionInUse,
  changeConnection,
  closeTab,
  execute,
  cancelRun,
  retryRun,
  runAgain,
  selectFirstRows,
  switchProject,
} from "./commands";
import { switchMode } from "./transactionPrompts";
import { useTunnels } from "../connections/tunnelsStore";
import { useDialogs } from "../../shared/ui/dialogs";
import { answerDialog, textOf } from "../../test/dialogs";
import { deferred } from "../../test/deferred";
import { catalogFixture, connection, relation } from "../../test/fixtures";
import { useSchema } from "../schema/schemaStore";
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

function marksOf(tabId: string) {
  return documentState(tabId).field(runMarksField);
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
  vi.mocked(loadCatalog).mockResolvedValue(catalogFixture());
  vi.mocked(inspectStatement).mockResolvedValue(null);
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
  vi.mocked(splitStatements).mockResolvedValue([{ start: 1, end: 9 }]);
  const id = tabWith("SELECT 1;\n  SELECT 2  ;");
  select(id, 11, 21);

  await execute("run");

  expect(openSession).toHaveBeenCalledWith("local");
  expect(executeQuery).toHaveBeenCalledWith(
    3,
    " SELECT 2 ",
    "auto",
    expect.any(Function),
    { drain: false },
  );
  expect(runOf(id)).toMatchObject({
    status: "running",
    result: { sql: " SELECT 2 ", origin: { line: 2, column: 2 } },
  });
  // 문장이 하나면 나눈 span이 아니라 고른 그대로다.
  expect(splitStatements).toHaveBeenCalledWith(" SELECT 2 ");
  expect(useRuns.getState().scripts[id]).toBeUndefined();
});

test("selection_with_two_statements_runs_a_script", async () => {
  vi.mocked(splitStatements).mockResolvedValue([
    { start: 0, end: 8 },
    { start: 10, end: 18 },
  ]);
  const id = tabWith("SELECT 0;\nSELECT 1;\nSELECT 2;");
  select(id, 10, 28);

  await execute("run");

  expect(splitStatements).toHaveBeenCalledWith("SELECT 1;\nSELECT 2");
  expect(useRuns.getState().scripts[id]?.steps).toEqual([
    { sql: "SELECT 1", from: 10, origin: { line: 2, column: 1 } },
    { sql: "SELECT 2", from: 20, origin: { line: 3, column: 1 } },
  ]);
  expect(executeQuery).toHaveBeenCalledWith(
    3,
    "SELECT 1",
    "auto",
    expect.any(Function),
    { drain: true },
  );

  // 문장마다 anchor가 있어 오류 밑줄과 Go to error가 그 문장을 가리킨다.
  const first = runOf(id);
  const firstKey = first.status === "running" ? first.result.runKey : "";
  expect(anchorOf(id, firstKey)).toBe(10);
  onEventOf(0)({
    type: "finished",
    tx: "idle",
    elapsedMicros: 1,
    outcome: "completed",
    rows: 1,
  });
  await vi.waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(2));
  const second = runOf(id);
  expect(second).toMatchObject({ result: { sql: "SELECT 2", from: 20 } });
  const secondKey = second.status === "running" ? second.result.runKey : "";
  expect(anchorOf(id, secondKey)).toBe(20);
  onEventOf(1)({
    type: "finished",
    tx: "idle",
    elapsedMicros: 1,
    outcome: "failed",
    error: {
      code: "42601",
      message: "syntax error",
      detail: null,
      hint: null,
      position: 2,
    },
  });
  expect(marksOf(id).error).toEqual({ from: 22, to: 26 });
});

test("a_selection_that_cannot_be_split_runs_as_one_statement", async () => {
  vi.mocked(splitStatements).mockRejectedValue(
    new CommandError("split_failed", "문장을 나눌 수 없습니다"),
  );
  const id = tabWith("SELECT 'a; SELECT 2");
  select(id, 0, 19);

  await execute("run");

  expect(executeQuery).toHaveBeenCalledWith(
    3,
    "SELECT 'a; SELECT 2",
    "auto",
    expect.any(Function),
    { drain: false },
  );
  expect(useRuns.getState().scripts[id]).toBeUndefined();
});

test("run_file_runs_every_statement", async () => {
  vi.mocked(splitStatements).mockResolvedValue([
    { start: 0, end: 8 },
    { start: 10, end: 18 },
  ]);
  const id = tabWith("SELECT 1;\nSELECT 2");
  // 커서와 선택 영역은 보지 않는다.
  select(id, 0, 3);

  await execute("runFile");

  expect(splitStatements).toHaveBeenCalledWith("SELECT 1;\nSELECT 2");
  expect(useRuns.getState().scripts[id]?.steps).toEqual([
    { sql: "SELECT 1", from: 0, origin: { line: 1, column: 1 } },
    { sql: "SELECT 2", from: 10, origin: { line: 2, column: 1 } },
  ]);
  expect(executeQuery).toHaveBeenCalledTimes(1);
});

test("run_file_with_one_statement_runs_it_alone", async () => {
  const id = tabWith("SELECT 1;");
  setDocumentState(
    id,
    documentState(id).update({
      effects: setStatementSpans.of([{ start: 0, end: 8 }]),
    }).state,
  );

  await execute("runFile");

  expect(splitStatements).not.toHaveBeenCalled();
  expect(useRuns.getState().scripts[id]).toBeUndefined();
  expect(runOf(id)).toMatchObject({ result: { sql: "SELECT 1" } });
});

test("run_file_on_an_empty_document_is_rejected", async () => {
  vi.mocked(splitStatements).mockResolvedValue([]);
  const id = tabWith("  \n-- note\n");

  await execute("runFile");

  expect(runOf(id)).toEqual({
    status: "rejected",
    rejection: { title: "Nothing to run", detail: null },
  });
  expect(openSession).not.toHaveBeenCalled();
});

test("run_file_without_a_connection_is_rejected", async () => {
  const id = tabWith("SELECT 1", null);

  await execute("runFile");

  expect(runOf(id)).toMatchObject({
    rejection: { title: "Choose a connection to run queries." },
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
    { drain: false },
  );
  expect(runOf(id)).toMatchObject({
    status: "running",
    result: { sql: "SELECT 2", origin: { line: 2, column: 1 } },
  });
});

test("run_uses_fresh_spans_without_splitting", async () => {
  const id = tabWith("SELECT 1;\nSELECT 2");
  select(id, 12);
  setDocumentState(
    id,
    documentState(id).update({
      effects: setStatementSpans.of([
        { start: 0, end: 8 },
        { start: 10, end: 18 },
      ]),
    }).state,
  );

  await execute("run");

  expect(splitStatements).not.toHaveBeenCalled();
  expect(runOf(id)).toMatchObject({
    status: "running",
    result: { sql: "SELECT 2", origin: { line: 2, column: 1 } },
  });
});

test("run_splits_when_the_cached_spans_are_stale", async () => {
  vi.mocked(splitStatements).mockResolvedValue([{ start: 0, end: 9 }]);
  const id = tabWith("SELECT 1");
  setDocumentState(
    id,
    documentState(id).update({
      effects: setStatementSpans.of([{ start: 0, end: 8 }]),
    }).state,
  );
  setDocumentState(
    id,
    documentState(id).update({ changes: { from: 8, insert: "0" } }).state,
  );

  await execute("run");

  expect(splitStatements).toHaveBeenCalledWith("SELECT 10");
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

test("문장을 나누는 동안 문서가 닫혀도 문서를 다시 읽지 않는다", async () => {
  const split = deferred<{ start: number; end: number }[]>();
  vi.mocked(splitStatements).mockReturnValue(split.promise);
  const id = tabWith("SELECT 1");

  const running = execute("run");
  closeDocument(id);
  split.resolve([{ start: 0, end: 8 }]);
  await running;

  // 탭을 닫는 경로는 release가 실행을 버린다. 여기서는 문서를 다시 읽다 던지지 않는지만 본다.
  expect(runOf(id)).not.toMatchObject({
    rejection: { title: expect.stringContaining("No open document") },
  });
});

test("문장을 나누는 동안 문서를 고쳐도 나누기 전 문서로 고른다", async () => {
  const split = deferred<{ start: number; end: number }[]>();
  vi.mocked(splitStatements).mockReturnValue(split.promise);
  const id = tabWith("SELECT 1");

  const running = execute("run");
  setDocumentState(
    id,
    documentState(id).update({ changes: { from: 0, insert: "-- c\n" } }).state,
  );
  split.resolve([{ start: 0, end: 8 }]);
  await running;

  expect(executeQuery).toHaveBeenCalledWith(
    expect.anything(),
    "SELECT 1",
    "auto",
    expect.any(Function),
    { drain: false },
  );
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
    steps: [{ sql: "SELECT 1", from: 0, origin: { line: 1, column: 1 } }],
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
    steps: [{ sql: "SELECT 1", from: 0, origin: { line: 1, column: 1 } }],
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

test("접속을 바꿔도 탭의 모드는 남는다", async () => {
  const id = tabWith("SELECT 1");
  useTabs.getState().setMode(id, "manual");

  await changeConnection(id, "staging");

  expect(tabOf(id)?.mode).toBe("manual");
});

test("프로젝트를 바꾸면 탭과 실행 상태를 비운다", async () => {
  const other: Project = { name: "other", dir: "/q", connections: [] };
  const id = tabWith("SELECT 1");
  await useRuns.getState().run(id, () => ({
    connection: "local",
    steps: [{ sql: "SELECT 1", from: 0, origin: { line: 1, column: 1 } }],
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
    steps: [{ sql: "SELECT 1", from: 0, origin: { line: 1, column: 1 } }],
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
    steps: [{ sql: "SELECT 2", from: 0, origin: { line: 1, column: 1 } }],
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
    steps: [{ sql: "SELECT 1", from: 0, origin: { line: 1, column: 1 } }],
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
  vi.mocked(splitStatements).mockResolvedValue([{ start: 0, end: 8 }]);
  useTabs.getState().activate(local);
  select(local, 0, 8);
  await execute("run");
  expect(openSession).toHaveBeenCalledTimes(3);
  expect(openSession).toHaveBeenLastCalledWith("local");
});

test("대상이 바뀐 접속의 세션을 놓아도 탭의 모드는 남는다", async () => {
  useProject.setState({
    project: { ...project, connections: [connection("local")] },
  });
  const id = await ranTab("local", 3);
  useTabs.getState().setMode(id, "manual");

  await applySavedProject({
    ...project,
    connections: [connection("local", { host: "b.internal" })],
  });

  expect(closeSession).toHaveBeenCalledWith(3);
  expect(tabOf(id)?.mode).toBe("manual");
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

test("Commit이 실패한 저장은 project만 반영하고 그 접속을 다시 저장할 때 세션을 놓는다", async () => {
  const local = connection("local");
  useProject.setState({
    project: { ...project, connections: [local, connection("staging")] },
  });
  await ranTab("local", 3);
  await ranTab("staging", 4);
  const moved: Project = {
    ...project,
    connections: [
      connection("local", { host: "b.internal" }),
      connection("staging"),
    ],
  };

  applySavedProjectKeepingSessions(moved);

  expect(useProject.getState().project).toEqual(moved);
  expect(connectionInUse("local")).toEqual(local);
  expect(closeSession).not.toHaveBeenCalled();

  // 다른 접속을 저장해도 그 탭의 세션은 놓지 않는다. 묻지 않았기 때문이다.
  const recolored: Project = {
    ...moved,
    connections: [
      moved.connections[0],
      connection("staging", { color: "red" }),
    ],
  };
  await applySavedProject(recolored, "staging");
  expect(closeSession).not.toHaveBeenCalled();
  expect(connectionInUse("local")).toEqual(local);

  await applySavedProject(recolored, "local");
  expect(closeSession).toHaveBeenCalledExactlyOnceWith(3);
  expect(connectionInUse("local")).toEqual(moved.connections[0]);
});

test("디렉토리 고르기가 실패하면 프로젝트 오류로 보여 준다", async () => {
  const id = tabWith("SELECT 1");
  await useRuns.getState().run(id, () => ({
    connection: "local",
    steps: [{ sql: "SELECT 1", from: 0, origin: { line: 1, column: 1 } }],
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
    { drain: false },
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
    { drain: false },
  );
  expect(runOf(id)).toMatchObject({
    status: "running",
    result: { sql: "SELECT 2", origin: { line: 2, column: 1 } },
  });
});

test("run_again_uses_the_moved_position", async () => {
  vi.mocked(splitStatements).mockResolvedValue([{ start: 10, end: 18 }]);
  const id = tabWith("SELECT 1;\nSELECT 2");
  select(id, 12);
  await execute("run");
  const first = runOf(id);
  expect(first).toMatchObject({
    result: { from: 10, origin: { line: 2, column: 1 } },
  });
  const firstKey = first.status === "running" ? first.result.runKey : "";
  expect(anchorOf(id, firstKey)).toBe(10);

  // 위에 줄을 넣으면 같은 text가 옮겨진 자리에서 다시 실행된다.
  setDocumentState(
    id,
    documentState(id).update({ changes: { from: 0, insert: "\n\n" } }).state,
  );
  await runAgain(id);

  expect(executeQuery).toHaveBeenLastCalledWith(
    3,
    "SELECT 2",
    "auto",
    expect.any(Function),
    { drain: false },
  );
  const again = runOf(id);
  expect(again).toMatchObject({
    status: "running",
    result: { sql: "SELECT 2", from: 12, origin: { line: 4, column: 1 } },
  });
  const key = again.status === "running" ? again.result.runKey : "";
  expect(key).not.toBe(firstKey);
  expect(anchorOf(id, key)).toBe(12);
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
    steps: [{ sql: "SELECT 1", from: 0, origin: { line: 1, column: 1 } }],
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

/** 활성 탭에서 `sql`을 실행하고 끝난 뒤의 트랜잭션 상태를 `tx`로 한다. */
async function runInTransaction(
  tabId: string,
  tx: TxStatus,
  call = 0,
): Promise<void> {
  await useRuns.getState().run(tabId, () => ({
    connection: "local",
    steps: [
      { sql: "UPDATE a SET b = 1", from: 0, origin: { line: 1, column: 1 } },
    ],
  }));
  onEventOf(call)({
    type: "finished",
    tx,
    elapsedMicros: 1,
    outcome: "completed",
    rows: 0,
  });
}

test("commit_shortcut_ends_the_active_transaction", async () => {
  const id = tabWith("UPDATE a SET b = 1");
  await runInTransaction(id, "in_transaction");
  vi.mocked(endTransaction).mockResolvedValue({ outcome: "ended", tx: "idle" });

  await execute("commit");

  expect(endTransaction).toHaveBeenCalledWith(3, "commit");
  expect(useRuns.getState().transactions[id]).toBeUndefined();

  await runInTransaction(id, "in_transaction", 1);
  await execute("rollback");
  expect(endTransaction).toHaveBeenLastCalledWith(3, "rollback");
});

test("commit_does_nothing_when_failed", async () => {
  const id = tabWith("UPDATE a SET b = 1");
  await runInTransaction(id, "failed");

  await execute("commit");

  expect(endTransaction).not.toHaveBeenCalled();
  expect(useRuns.getState().transactions[id]?.status).toBe("failed");

  // 실패한 트랜잭션도 Rollback은 할 수 있다.
  vi.mocked(endTransaction).mockResolvedValue({ outcome: "ended", tx: "idle" });
  await execute("rollback");
  expect(endTransaction).toHaveBeenCalledWith(3, "rollback");
});

test("commit does nothing without a transaction or while a query is being read", async () => {
  const id = tabWith("SELECT 1");
  await execute("commit");
  expect(endTransaction).not.toHaveBeenCalled();

  await runInTransaction(id, "in_transaction");
  await useRuns.getState().run(id, () => ({
    connection: "local",
    steps: [
      { sql: "SELECT * FROM big", from: 0, origin: { line: 1, column: 1 } },
    ],
  }));
  // 앞 줄을 받는 중이면 먼저 Cancel해야 한다.
  expect(runOf(id).status).toBe("running");
  await execute("rollback");
  expect(endTransaction).not.toHaveBeenCalled();
});

test("closing_a_tab_with_a_transaction_asks_before_the_unsaved_prompt", async () => {
  const id = tabWith("UPDATE a SET b = 1");
  // Manual 모드라 앱이 BEGIN을 붙인 이 문장도 센다.
  useTabs.getState().setMode(id, "manual");
  await runInTransaction(id, "in_transaction");
  useTabs.getState().markDirty(id);
  let dialogWhenEnded: unknown;
  vi.mocked(endTransaction).mockImplementation(async () => {
    dialogWhenEnded = useDialogs.getState().current;
    return { outcome: "ended", tx: "idle" };
  });

  const closing = closeTab(id);
  const first = await answerDialog("rollback");
  // 저장하지 않은 변경을 묻는 동안은 아직 Rollback을 보내지 않는다.
  await vi.waitFor(() => expect(useDialogs.getState().current).not.toBeNull());
  expect(endTransaction).not.toHaveBeenCalled();
  const second = await answerDialog("discard");
  await closing;

  expect(endTransaction).toHaveBeenCalledExactlyOnceWith(3, "rollback");
  expect(dialogWhenEnded).toBeNull();

  expect(textOf(first.title)).toBe("This tab has an open transaction");
  expect(textOf(first.body)).toBe(
    "Closing Query 1 closes the local session. What should happen to the 1 uncommitted statement?",
  );
  expect(textOf(second.title)).toBe("Save changes to Query 1?");
  expect(tabOf(id)).toBeUndefined();
});

test("cancelling the unsaved prompt after choosing rollback keeps the transaction", async () => {
  const id = tabWith("UPDATE a SET b = 1");
  await runInTransaction(id, "in_transaction");
  useTabs.getState().markDirty(id);
  vi.mocked(endTransaction).mockResolvedValue({ outcome: "ended", tx: "idle" });

  const closing = closeTab(id);
  await answerDialog("rollback");
  await answerDialog("cancel");
  await closing;

  expect(endTransaction).not.toHaveBeenCalled();
  expect(tabOf(id)).toBeDefined();
  expect(useRuns.getState().transactions[id]).toBeDefined();
});

test("a save that does not finish before closing does not end the transaction", async () => {
  vi.mocked(endTransaction).mockResolvedValue({ outcome: "ended", tx: "idle" });
  // 이름 없는 탭은 이름을 물으러 간다.
  const untitled = tabWith("UPDATE a SET b = 1");
  await runInTransaction(untitled, "in_transaction");
  useTabs.getState().markDirty(untitled);
  const naming = closeTab(untitled);
  await answerDialog("commit");
  await answerDialog("save");
  await naming;
  expect(useTabs.getState().naming).toBe(untitled);

  // 저장에 실패한다.
  const file = tabWith("UPDATE a SET b = 2");
  await runInTransaction(file, "in_transaction", 1);
  useTabs.getState().markSaved(file, "queries/b.sql", "s1");
  useTabs.getState().markDirty(file);
  vi.mocked(writeSqlFile).mockRejectedValueOnce(
    new CommandError("io", "쓸 수 없습니다"),
  );
  const failing = closeTab(file);
  await answerDialog("rollback");
  await answerDialog("save");
  await failing;

  expect(endTransaction).not.toHaveBeenCalled();
  expect(tabOf(untitled)).toBeDefined();
  expect(tabOf(file)).toBeDefined();
  expect(useRuns.getState().transactions[untitled]).toBeDefined();
  expect(useRuns.getState().transactions[file]).toBeDefined();
});

test("cancelling the transaction prompt keeps the tab and skips the unsaved prompt", async () => {
  const id = tabWith("UPDATE a SET b = 1");
  await runInTransaction(id, "in_transaction");
  useTabs.getState().markDirty(id);

  const closing = closeTab(id);
  await answerDialog("cancel");
  await closing;

  expect(useDialogs.getState().current).toBeNull();
  expect(endTransaction).not.toHaveBeenCalled();
  expect(tabOf(id)).toBeDefined();
  expect(useRuns.getState().transactions[id]).toBeDefined();
});

test("a failed commit keeps the tab open with the error in its result panel", async () => {
  const id = tabWith("UPDATE a SET b = 1");
  await runInTransaction(id, "in_transaction");
  vi.mocked(endTransaction).mockResolvedValue({
    outcome: "server_error",
    tx: "idle",
    error: {
      code: "23503",
      message: "violates foreign key",
      detail: null,
      hint: null,
      position: null,
    },
  });

  const closing = closeTab(id);
  await answerDialog("commit");
  await closing;

  expect(tabOf(id)).toBeDefined();
  expect(runOf(id)?.status).toBe("rejected");
  expect(closeSession).not.toHaveBeenCalled();
});

test("switch_project_commits_only_after_a_folder_is_chosen", async () => {
  const id = tabWith("UPDATE a SET b = 1");
  await runInTransaction(id, "in_transaction");
  useTabs.getState().markDirty(id);
  vi.mocked(endTransaction).mockResolvedValue({ outcome: "ended", tx: "idle" });

  // 폴더를 고르지 않으면 Commit하지 않는다.
  vi.mocked(pickDirectory).mockResolvedValue(null);
  let switching = switchProject();
  const first = await answerDialog("commit");
  const second = await answerDialog("switch");
  await switching;
  expect(textOf(first.title)).toBe("A tab has an open transaction");
  expect(textOf(first.body)).toBe(
    "Switching projects closes every tab's session. What should happen to the open transaction in Query 1?",
  );
  expect(textOf(second.title)).toBe("1 tab has unsaved changes");
  expect(pickDirectory).toHaveBeenCalledTimes(1);
  expect(endTransaction).not.toHaveBeenCalled();
  expect(useRuns.getState().transactions[id]).toBeDefined();

  // 고르면 Commit한 뒤에 연다.
  vi.mocked(pickDirectory).mockResolvedValue("/q");
  vi.mocked(openProject).mockResolvedValue({ ...project, dir: "/q" });
  switching = switchProject();
  await answerDialog("commit");
  await answerDialog("switch");
  await switching;
  expect(endTransaction).toHaveBeenCalledWith(3, "commit");
  expect(vi.mocked(endTransaction).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(openProject).mock.invocationCallOrder[0],
  );
  expect(useTabs.getState().tabs).toEqual([]);
});

test("a project that fails to open does not roll back", async () => {
  const id = tabWith("UPDATE a SET b = 1");
  await runInTransaction(id, "in_transaction");
  vi.mocked(endTransaction).mockResolvedValue({ outcome: "ended", tx: "idle" });
  vi.mocked(pickDirectory).mockResolvedValue("/q");
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );

  const switching = switchProject();
  await answerDialog("rollback");
  await switching;

  expect(openProject).toHaveBeenCalledWith("/q");
  expect(endTransaction).not.toHaveBeenCalled();
  expect(tabOf(id)).toBeDefined();
  expect(useRuns.getState().transactions[id]).toBeDefined();
});

test("rolling back to switch projects leaves it to closing the sessions", async () => {
  const id = tabWith("UPDATE a SET b = 1");
  await runInTransaction(id, "in_transaction");
  vi.mocked(pickDirectory).mockResolvedValue("/q");
  vi.mocked(openProject).mockResolvedValue({ ...project, dir: "/q" });

  const switching = switchProject();
  await answerDialog("rollback");
  await switching;

  // 프로젝트를 열면 Rust가 옛 세션을 닫고 서버가 되돌린다.
  expect(endTransaction).not.toHaveBeenCalled();
  expect(useTabs.getState().tabs).toEqual([]);
  expect(useRuns.getState().transactions).toEqual({});
});

test("a failed commit does not switch projects", async () => {
  const id = tabWith("UPDATE a SET b = 1");
  await runInTransaction(id, "in_transaction");
  vi.mocked(endTransaction).mockResolvedValue({
    outcome: "client_error",
    tx: "in_transaction",
    message: "boom",
  });
  vi.mocked(pickDirectory).mockResolvedValue("/q");

  const switching = switchProject();
  await answerDialog("commit");
  await switching;

  expect(openProject).not.toHaveBeenCalled();
  expect(tabOf(id)).toBeDefined();
});

test("switch_mode_to_auto_with_a_transaction_asks", async () => {
  const id = tabWith("UPDATE a SET b = 1");
  useTabs.getState().setMode(id, "manual");
  await runInTransaction(id, "in_transaction");
  vi.mocked(endTransaction).mockResolvedValue({ outcome: "ended", tx: "idle" });

  const switching = switchMode(id, "auto");
  const spec = await answerDialog("commit");
  await switching;

  expect(textOf(spec.title)).toBe(
    "End the transaction before switching to Auto",
  );
  expect(endTransaction).toHaveBeenCalledWith(3, "commit");
  expect(tabOf(id)?.mode).toBe("auto");
  expect(useRuns.getState().transactions[id]).toBeUndefined();
});

test("changing the connection of a tab with a transaction asks first", async () => {
  const id = tabWith("UPDATE a SET b = 1");
  await runInTransaction(id, "in_transaction");
  vi.mocked(endTransaction).mockResolvedValue({ outcome: "ended", tx: "idle" });

  let changing = changeConnection(id, "staging");
  const spec = await answerDialog("cancel");
  await changing;
  expect(textOf(spec.body)).toBe(
    "Switching to staging closes the local session. What should happen to the open transaction?",
  );
  expect(tabOf(id)?.connection).toBe("local");
  expect(closeSession).not.toHaveBeenCalled();

  changing = changeConnection(id, "staging");
  await answerDialog("rollback");
  await changing;
  expect(endTransaction).toHaveBeenCalledWith(3, "rollback");
  expect(tabOf(id)?.connection).toBe("staging");
  expect(closeSession).toHaveBeenCalledWith(3);
});

test("choosing the same connection keeps the session and its transaction", async () => {
  const id = tabWith("UPDATE a SET b = 1");
  await runInTransaction(id, "in_transaction");

  await changeConnection(id, "local");

  expect(useDialogs.getState().current).toBeNull();
  expect(closeSession).not.toHaveBeenCalled();
  expect(useRuns.getState().transactions[id]).toBeDefined();
});

const deleteAll = {
  kind: "delete_without_where",
  table: "sessions",
} as const;

test("run_asks_before_a_dangerous_statement_and_does_nothing_on_cancel", async () => {
  vi.mocked(splitStatements).mockResolvedValue([{ start: 0, end: 21 }]);
  vi.mocked(inspectStatement).mockResolvedValue(deleteAll);
  const id = tabWith("DELETE FROM sessions;");
  useTabs.getState().setMode(id, "manual");

  const running = execute("run");
  const spec = await answerDialog("cancel");
  await running;

  expect(inspectStatement).toHaveBeenCalledWith("DELETE FROM sessions;");
  expect(textOf(spec.title)).toBe("Run DELETE without WHERE?");
  expect(openSession).not.toHaveBeenCalled();
  expect(executeQuery).not.toHaveBeenCalled();
  expect(runOf(id)).toBeUndefined();

  // Run을 고르면 실행한다.
  const again = execute("run");
  await answerDialog("run");
  await again;
  expect(executeQuery).toHaveBeenCalledWith(
    3,
    "DELETE FROM sessions;",
    "manual",
    expect.any(Function),
    { drain: false },
  );
});

test("run_again_asks_too", async () => {
  vi.mocked(splitStatements).mockResolvedValue([{ start: 0, end: 8 }]);
  const id = tabWith("SELECT 1");
  await execute("run");
  expect(executeQuery).toHaveBeenCalledTimes(1);
  onEventOf(0)({
    type: "finished",
    outcome: "completed",
    elapsedMicros: 1,
    tx: null,
  } as QueryEvent);

  vi.mocked(inspectStatement).mockResolvedValue(deleteAll);
  const again = runAgain(id);
  await answerDialog("cancel");
  await again;

  expect(executeQuery).toHaveBeenCalledTimes(1);
  expect(runOf(id)).toMatchObject({ status: "finished" });
});

test("danger_is_confirmed_when_its_step_comes", async () => {
  vi.mocked(splitStatements).mockResolvedValue([
    { start: 0, end: 8 },
    { start: 10, end: 30 },
    { start: 32, end: 40 },
  ]);
  vi.mocked(inspectStatement).mockImplementation((sql) =>
    Promise.resolve(sql.startsWith("DELETE") ? deleteAll : null),
  );
  const id = tabWith("SELECT 1;\nDELETE FROM sessions;\nSELECT 3");

  await execute("runFile");
  // 앞 문장이 끝나기 전에는 묻지 않는다.
  expect(executeQuery).toHaveBeenCalledTimes(1);
  expect(useDialogs.getState().current).toBeNull();

  onEventOf(0)({
    type: "finished",
    tx: "idle",
    elapsedMicros: 1,
    outcome: "completed",
    rows: 1,
  });
  const spec = await answerDialog("cancel");

  expect(textOf(spec.title)).toBe("Run DELETE without WHERE?");
  expect(spec.sql).toBe("DELETE FROM sessions");
  await vi.waitFor(() =>
    expect(useRuns.getState().scripts[id]?.stoppedAt).toBe(0),
  );
  expect(executeQuery).toHaveBeenCalledTimes(1);

  // Run을 고르면 그 문장을 보낸다.
  await execute("runFile");
  onEventOf(1)({
    type: "finished",
    tx: "idle",
    elapsedMicros: 1,
    outcome: "completed",
    rows: 1,
  });
  await answerDialog("run");
  await vi.waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(3));
  expect(vi.mocked(executeQuery).mock.calls[2][1]).toBe("DELETE FROM sessions");
});

test("run_again_without_its_anchor_runs_without_one", async () => {
  vi.mocked(splitStatements).mockResolvedValue([{ start: 10, end: 18 }]);
  const id = tabWith("SELECT 1;\nSELECT 2");
  select(id, 12);
  await execute("run");

  // 실행한 text를 지우면 문서에 그 자리가 없다.
  setDocumentState(
    id,
    documentState(id).update({ changes: { from: 9, to: 18 } }).state,
  );
  await runAgain(id);

  expect(executeQuery).toHaveBeenLastCalledWith(
    3,
    "SELECT 2",
    "auto",
    expect.any(Function),
    { drain: false },
  );
  const again = runOf(id);
  expect(again).toMatchObject({
    status: "running",
    result: { sql: "SELECT 2", from: null, origin: { line: 2, column: 1 } },
  });
  const key = again.status === "running" ? again.result.runKey : "";
  expect(anchorOf(id, key)).toBeNull();
  expect(marksOf(id).anchors).toEqual({});
});

test("try_again_uses_the_moved_anchor", async () => {
  vi.mocked(splitStatements).mockResolvedValue([
    { start: 0, end: 8 },
    { start: 10, end: 18 },
  ]);
  vi.mocked(openSession).mockRejectedValueOnce(
    new CommandError("tunnel_timeout", "localhost:25432 didn't open"),
  );
  const id = tabWith("SELECT 1;\nSELECT 2");
  await execute("runFile");
  const failed = runOf(id);
  const retry = failed.status === "rejected" ? failed.rejection.retry : null;
  expect(retry).toMatchObject({ connection: "local" });

  setDocumentState(
    id,
    documentState(id).update({ changes: { from: 0, insert: "\n\n" } }).state,
  );
  await retryRun(id, retry!);

  expect(useRuns.getState().scripts[id]?.steps).toEqual([
    { sql: "SELECT 1", from: 2, origin: { line: 3, column: 1 } },
    { sql: "SELECT 2", from: 12, origin: { line: 4, column: 1 } },
  ]);
  expect(executeQuery).toHaveBeenCalledTimes(1);
});

test("saving_a_changed_target_reloads_its_catalog", async () => {
  useProject.setState({
    project: {
      ...project,
      connections: [connection("local"), connection("staging")],
    },
  });
  tabWith("SELECT 1", "local");
  vi.mocked(loadCatalog).mockResolvedValue(catalogFixture());
  await useSchema.getState().ensure("local");
  await useSchema.getState().ensure("other");
  vi.mocked(loadCatalog).mockClear();

  await applySavedProject({
    ...project,
    connections: [
      connection("local", { host: "b.internal" }),
      connection("staging", { host: "c.internal" }),
    ],
  });

  // staging은 entry도 쓰는 탭도 없다.
  expect(closeCatalog).toHaveBeenCalledTimes(2);
  expect(closeCatalog).toHaveBeenCalledWith("local");
  expect(closeCatalog).toHaveBeenCalledWith("staging");
  expect(loadCatalog).toHaveBeenCalledTimes(1);
  expect(loadCatalog).toHaveBeenCalledWith("local");
  expect(useSchema.getState().entries.other?.status).toBe("ready");
});

test("switching_projects_resets_schemas", async () => {
  vi.mocked(loadCatalog).mockResolvedValue(catalogFixture());
  await useSchema.getState().ensure("local");
  vi.mocked(pickDirectory).mockResolvedValue("/q");
  vi.mocked(openProject).mockResolvedValue({ ...project, dir: "/q" });

  await switchProject();

  expect(useSchema.getState().entries).toEqual({});
});

test("switching_projects_resets_cached_types", async () => {
  useTypes.setState({
    types: {
      local: {
        "23:-1": { oid: 23, modifier: -1, name: "integer", category: "N" },
      },
    },
  });
  vi.mocked(pickDirectory).mockResolvedValue("/q");
  vi.mocked(openProject).mockResolvedValue({ ...project, dir: "/q" });

  await switchProject();

  expect(useTypes.getState().types).toEqual({});
});

test("select_first_rows_quotes_names", async () => {
  const before = tabWith("SELECT 1", "local");
  useTabs.getState().setMode(before, "manual");

  await selectFirstRows(
    relation(9, "public", "Order Items"),
    new Set(["user"]),
  );

  const { activeId, tabs } = useTabs.getState();
  expect(activeId).not.toBe(before);
  const opened = tabs.find((tab) => tab.id === activeId);
  expect(opened?.connection).toBe("local");
  expect(opened?.mode).toBe("auto");
  const sql = 'SELECT * FROM public."Order Items" LIMIT 500';
  expect(documentState(activeId!).doc.toString()).toBe(sql);
  await vi.waitFor(() =>
    expect(executeQuery).toHaveBeenCalledWith(
      3,
      sql,
      "auto",
      expect.any(Function),
      { drain: false },
    ),
  );
});
