import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/dialog");

import {
  listSqlFiles,
  readSqlFile,
  writeSqlFile,
} from "../../shared/api/commands";
import { confirm } from "../../shared/api/dialog";
import { CommandError } from "../../shared/api/errors";
import type { Project } from "../../shared/api/types";
import { useProject } from "../project/projectStore";
import { documentState, setDocumentState } from "./documents";
import { normalizeNewPath, saveTab } from "./saveTab";
import { useTabs } from "./tabsStore";

function type(tabId: string, text: string): void {
  setDocumentState(
    tabId,
    documentState(tabId).update({ changes: { from: 0, insert: text } }).state,
  );
}

function tabOf(id: string) {
  const tab = useTabs.getState().tabs.find((t) => t.id === id);
  if (tab === undefined) throw new Error("tab이 없습니다");
  return tab;
}

beforeEach(() => {
  vi.resetAllMocks();
  useTabs.getState().reset();
  const project: Project = { name: "demo", dir: "/p", connections: [] };
  useProject.setState({ ...useProject.getInitialState(), project }, true);
  vi.mocked(listSqlFiles).mockResolvedValue(["queries/a.sql"]);
});

test("normalizeNewPath는 .sql을 붙인다", () => {
  expect(normalizeNewPath(" queries/a ")).toBe("queries/a.sql");
  expect(normalizeNewPath("a.SQL")).toBe("a.SQL");
  expect(normalizeNewPath("queries/b.sql")).toBe("queries/b.sql");
});

test("이름 없는 탭은 이름을 묻는다", async () => {
  const id = useTabs.getState().newTab();
  type(id, "SELECT 1");

  const result = await saveTab(id);

  expect(result).toBe("needs_name");
  expect(useTabs.getState().naming).toBe(id);
  expect(writeSqlFile).not.toHaveBeenCalled();
});

test("이름을 주면 새 파일로 쓰고 파일 목록을 새로 읽는다", async () => {
  vi.mocked(writeSqlFile).mockResolvedValue("s1");
  const id = useTabs.getState().newTab();
  type(id, "SELECT 1");
  useTabs.getState().markDirty(id);
  useTabs.getState().requestName(id);

  const result = await saveTab(id, "queries/a");

  expect(result).toBe("saved");
  expect(writeSqlFile).toHaveBeenCalledWith("queries/a.sql", "SELECT 1", {
    mode: "create",
  });
  expect(listSqlFiles).toHaveBeenCalled();
  expect(tabOf(id)).toMatchObject({
    path: "queries/a.sql",
    stamp: "s1",
    title: "a.sql",
    dirty: false,
  });
  expect(useTabs.getState().naming).toBeNull();
  await vi.waitFor(() =>
    expect(useProject.getState().files).toEqual(["queries/a.sql"]),
  );
});

test("있는 파일 이름이면 실패하고 탭은 그대로다", async () => {
  vi.mocked(writeSqlFile).mockRejectedValue(
    new CommandError("file_exists", "이미 있는 파일입니다"),
  );
  const id = useTabs.getState().newTab();
  type(id, "SELECT 1");
  useTabs.getState().markDirty(id);

  const result = await saveTab(id, "queries/a");

  expect(result).toBe("failed");
  expect(useTabs.getState().error).toBe("이미 있는 파일입니다");
  expect(tabOf(id)).toMatchObject({ path: null, dirty: true });
  expect(listSqlFiles).not.toHaveBeenCalled();
});

test("연 파일은 읽을 때의 stamp로 쓰고 새 stamp를 갖는다", async () => {
  vi.mocked(readSqlFile).mockResolvedValue({ text: "SELECT 1", stamp: "s1" });
  vi.mocked(writeSqlFile).mockResolvedValue("s2");
  await useTabs.getState().openFile("queries/a.sql");
  const id = useTabs.getState().tabs[0].id;
  type(id, "-- ");
  useTabs.getState().markDirty(id);

  const result = await saveTab(id);

  expect(result).toBe("saved");
  expect(writeSqlFile).toHaveBeenCalledWith("queries/a.sql", "-- SELECT 1", {
    mode: "replace",
    stamp: "s1",
  });
  expect(tabOf(id)).toMatchObject({ stamp: "s2", dirty: false });
});

test("밖에서 바뀐 파일은 물어본 뒤에만 덮어쓴다", async () => {
  vi.mocked(readSqlFile).mockResolvedValue({ text: "SELECT 1", stamp: "s1" });
  vi.mocked(writeSqlFile).mockRejectedValueOnce(
    new CommandError("file_changed", "바뀌었습니다"),
  );
  await useTabs.getState().openFile("queries/a.sql");
  const id = useTabs.getState().tabs[0].id;
  type(id, "-- ");
  useTabs.getState().markDirty(id);

  vi.mocked(confirm).mockResolvedValueOnce(false);
  expect(await saveTab(id)).toBe("cancelled");
  expect(confirm).toHaveBeenCalledWith(
    "queries/a.sql 파일이 밖에서 바뀌었습니다. 덮어쓸까요?",
  );
  expect(writeSqlFile).toHaveBeenCalledTimes(1);
  expect(tabOf(id)).toMatchObject({ dirty: true, stamp: "s1" });
  expect(useTabs.getState().error).toBeNull();

  vi.mocked(writeSqlFile).mockReset();
  vi.mocked(writeSqlFile)
    .mockRejectedValueOnce(new CommandError("file_changed", "바뀌었습니다"))
    .mockResolvedValueOnce("s3");
  vi.mocked(confirm).mockResolvedValueOnce(true);

  expect(await saveTab(id)).toBe("saved");
  expect(writeSqlFile).toHaveBeenCalledTimes(2);
  expect(writeSqlFile).toHaveBeenLastCalledWith(
    "queries/a.sql",
    "-- SELECT 1",
    {
      mode: "overwrite",
    },
  );
  expect(tabOf(id)).toMatchObject({ dirty: false, stamp: "s3" });
});

test("덮어쓰기가 실패하면 error를 두고 failed다", async () => {
  vi.mocked(readSqlFile).mockResolvedValue({ text: "SELECT 1", stamp: "s1" });
  vi.mocked(writeSqlFile)
    .mockRejectedValueOnce(new CommandError("file_changed", "바뀌었습니다"))
    .mockRejectedValueOnce(new CommandError("io", "쓸 수 없습니다"));
  vi.mocked(confirm).mockResolvedValue(true);
  await useTabs.getState().openFile("queries/a.sql");
  const id = useTabs.getState().tabs[0].id;
  useTabs.getState().markDirty(id);

  expect(await saveTab(id)).toBe("failed");
  expect(useTabs.getState().error).toBe("쓸 수 없습니다");
  expect(tabOf(id).dirty).toBe(true);
});

test("그 밖의 실패는 error를 두고 dirty인 채로 둔다", async () => {
  vi.mocked(readSqlFile).mockResolvedValue({ text: "SELECT 1", stamp: "s1" });
  vi.mocked(writeSqlFile).mockRejectedValue(
    new CommandError("io", "쓸 수 없습니다"),
  );
  await useTabs.getState().openFile("queries/a.sql");
  const id = useTabs.getState().tabs[0].id;
  useTabs.getState().markDirty(id);

  expect(await saveTab(id)).toBe("failed");
  expect(confirm).not.toHaveBeenCalled();
  expect(useTabs.getState().error).toBe("쓸 수 없습니다");
  expect(tabOf(id).dirty).toBe(true);
});
