import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import {
  listSqlFiles,
  loadWorkspace,
  readSqlFile,
  saveWorkspace,
  writeSqlFile,
} from "../../shared/api/commands";
import { CommandError } from "../../shared/api/errors";
import { resetStores } from "../../test/resetStores";
import { documentText, openDocument } from "../editor/documents";
import { saveTab } from "../editor/saveTab";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { useSettings } from "../settings/settingsStore";
import {
  documentChanged,
  flushAutosave,
  reopenTabs,
  restore,
  snapshotOf,
  startAutosave,
  type TabSnapshot,
  type WorkspaceSnapshot,
} from "./autosave";

let stop: () => void = () => {};

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  useProject.setState({
    status: "ready",
    project: { name: "demo", dir: "/p", connections: [] },
  });
  vi.mocked(listSqlFiles).mockResolvedValue([]);
  vi.mocked(loadWorkspace).mockResolvedValue(null);
  vi.mocked(saveWorkspace).mockResolvedValue();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

function tab(patch: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    title: "Query 1",
    path: null,
    stamp: null,
    connection: null,
    mode: "auto",
    text: "",
    ...patch,
  };
}

function snapshot(
  tabs: TabSnapshot[],
  active: number | null = 0,
): WorkspaceSnapshot {
  return { version: 1, active, tabs };
}

/** 마지막으로 저장한 snapshot */
function lastSaved(): WorkspaceSnapshot {
  const [dir, text] = vi.mocked(saveWorkspace).mock.lastCall ?? [];
  expect(dir).toBe("/p");
  return JSON.parse(text as string) as WorkspaceSnapshot;
}

/** 보관한 탭이 없는 프로젝트를 열고 자동 보관을 켠다. */
async function started(): Promise<void> {
  await reopenTabs();
  stop = startAutosave();
}

test("saves_one_second_after_the_last_change", async () => {
  await started();
  vi.useFakeTimers();
  const id = useTabs.getState().newTab();
  await vi.advanceTimersByTimeAsync(600);
  openDocument(id, "SELECT 1");
  documentChanged();

  await vi.advanceTimersByTimeAsync(999);
  expect(saveWorkspace).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(saveWorkspace).toHaveBeenCalledTimes(1);
  expect(lastSaved().tabs[0].text).toBe("SELECT 1");
});

test("clean_file_tabs_store_no_text", async () => {
  vi.mocked(readSqlFile).mockResolvedValue({ text: "SELECT 1", stamp: "s1" });
  await useTabs.getState().openFile("q/a.sql");
  useTabs.getState().setConnection(useTabs.getState().tabs[0].id, "local");
  useTabs.getState().setMode(useTabs.getState().tabs[0].id, "manual");

  expect(snapshotOf(useTabs.getState())).toEqual({
    version: 1,
    active: 0,
    tabs: [
      {
        title: "a.sql",
        path: "q/a.sql",
        stamp: "s1",
        connection: "local",
        mode: "manual",
        text: null,
      },
    ],
  });
});

test("untitled_and_dirty_tabs_store_text", async () => {
  vi.mocked(readSqlFile).mockResolvedValue({ text: "a\r\nb", stamp: "s1" });
  await useTabs.getState().openFile("a.sql");
  const file = useTabs.getState().tabs[0].id;
  useTabs.getState().markDirty(file);
  useTabs.getState().newTab({ text: "SELECT 2" });
  useTabs.getState().activate(file);

  const saved = snapshotOf(useTabs.getState());

  expect(saved.active).toBe(0);
  // 줄 끝은 파일의 것 그대로 둔다.
  expect(saved.tabs.map((t) => t.text)).toEqual(["a\r\nb", "SELECT 2"]);
});

test("restores_tabs_in_order_with_the_active_tab", async () => {
  await restore(
    snapshot(
      [
        tab({ title: "Query 1", text: "SELECT 1", connection: "local" }),
        tab({ title: "Query 3", text: "", mode: "manual" }),
      ],
      1,
    ),
  );

  const { tabs, activeId } = useTabs.getState();
  expect(
    tabs.map(({ title, connection, mode, dirty }) => ({
      title,
      connection,
      mode,
      dirty,
    })),
  ).toEqual([
    { title: "Query 1", connection: "local", mode: "auto", dirty: true },
    { title: "Query 3", connection: null, mode: "manual", dirty: false },
  ]);
  expect(activeId).toBe(tabs[1].id);
  expect(documentText(tabs[0].id)).toBe("SELECT 1");
  // 새 탭 번호는 되살린 탭 다음이다.
  useTabs.getState().newTab();
  expect(useTabs.getState().tabs[2].title).toBe("Query 4");
});

test("clean_tabs_reread_the_file", async () => {
  vi.mocked(readSqlFile).mockResolvedValue({ text: "SELECT 9", stamp: "s9" });

  await restore(
    snapshot([tab({ title: "a.sql", path: "a.sql", stamp: "s1", text: null })]),
  );

  expect(readSqlFile).toHaveBeenCalledWith("a.sql");
  const [restored] = useTabs.getState().tabs;
  expect(restored).toMatchObject({ path: "a.sql", stamp: "s9", dirty: false });
  expect(documentText(restored.id)).toBe("SELECT 9");
});

test("missing_files_are_skipped_and_reported", async () => {
  vi.mocked(readSqlFile).mockImplementation((path) =>
    path === "b.sql"
      ? Promise.resolve({ text: "B", stamp: "sb" })
      : Promise.reject(new CommandError("file_not_found", "gone")),
  );
  const saved = snapshot(
    [
      tab({ title: "a.sql", path: "a.sql", stamp: "s", text: null }),
      tab({ title: "b.sql", path: "b.sql", stamp: "s", text: null }),
      tab({ title: "c.sql", path: "c.sql", stamp: "s", text: null }),
    ],
    0,
  );

  const { skipped } = await restore(saved);

  expect(skipped).toEqual(["a.sql", "c.sql"]);
  const { tabs, activeId } = useTabs.getState();
  expect(tabs.map((t) => t.title)).toEqual(["b.sql"]);
  // 활성 탭이 빠지면 그 다음 탭이 활성이다.
  expect(activeId).toBe(tabs[0].id);

  // 열 때는 오류 하나로 알린다.
  useTabs.getState().reset();
  vi.mocked(loadWorkspace).mockResolvedValue(JSON.stringify(saved));
  await reopenTabs();
  expect(useTabs.getState().error).toBe("Couldn't reopen 2 files");

  useTabs.getState().reset();
  vi.mocked(loadWorkspace).mockResolvedValue(
    JSON.stringify(snapshot([saved.tabs[0], saved.tabs[1]])),
  );
  await reopenTabs();
  expect(useTabs.getState().error).toBe("Couldn't reopen a.sql");
});

test("restored_dirty_tab_keeps_its_stamp", async () => {
  vi.mocked(writeSqlFile).mockResolvedValue("s2");

  await restore(
    snapshot([tab({ title: "a.sql", path: "a.sql", stamp: "s1", text: "X" })]),
  );
  const [restored] = useTabs.getState().tabs;
  expect(restored.dirty).toBe(true);
  expect(readSqlFile).not.toHaveBeenCalled();

  expect(await saveTab(restored.id)).toBe("saved");
  expect(writeSqlFile).toHaveBeenCalledWith("a.sql", "X", {
    mode: "replace",
    stamp: "s1",
  });
});

test("a_bad_or_unknown_snapshot_is_ignored", async () => {
  for (const text of [
    "not json",
    JSON.stringify({ version: 2, active: 0, tabs: [tab()] }),
    JSON.stringify({ version: 1, active: 0, tabs: [{ title: 1 }] }),
  ]) {
    vi.mocked(loadWorkspace).mockResolvedValue(text);
    await reopenTabs();
    expect(useTabs.getState().tabs).toEqual([]);
    expect(useTabs.getState().error).toBeNull();
  }
  // 무시한 뒤에는 지금 탭을 저장한다.
  stop = startAutosave();
  useTabs.getState().newTab();
  await flushAutosave();
  expect(lastSaved().tabs).toHaveLength(1);
});

test("a_save_for_one_project_is_dropped_after_switching", async () => {
  await started();
  vi.useFakeTimers();
  useTabs.getState().newTab();
  // 다른 프로젝트가 열렸지만 아직 그 프로젝트의 탭을 읽기 전이다.
  useProject.setState({
    project: { name: "other", dir: "/q", connections: [] },
  });

  await vi.advanceTimersByTimeAsync(1000);
  await flushAutosave();

  expect(saveWorkspace).not.toHaveBeenCalled();
});

test("nothing_is_kept_without_the_app_store", async () => {
  useSettings.setState({ storeAvailable: false });
  await started();
  useTabs.getState().newTab();
  await flushAutosave();

  expect(loadWorkspace).not.toHaveBeenCalled();
  expect(saveWorkspace).not.toHaveBeenCalled();
});

test("a_failed_save_is_ignored", async () => {
  await started();
  vi.mocked(saveWorkspace).mockRejectedValue(
    new CommandError("store_failed", "boom"),
  );
  useTabs.getState().newTab();

  await expect(flushAutosave()).resolves.toBeUndefined();
  expect(saveWorkspace).toHaveBeenCalledTimes(1);
});
