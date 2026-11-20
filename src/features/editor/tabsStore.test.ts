import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/dialog");

import { readSqlFile } from "../../shared/api/commands";
import { CommandError } from "../../shared/api/errors";
import { documentText } from "./documents";
import { useTabs, type RestoredTab } from "./tabsStore";

beforeEach(() => {
  vi.resetAllMocks();
  useTabs.getState().reset();
});

function ids(): string[] {
  return useTabs.getState().tabs.map((tab) => tab.id);
}

test("새 탭은 번호가 오르는 제목과 빈 문서로 활성이 된다", () => {
  const first = useTabs.getState().newTab();
  const second = useTabs.getState().newTab();

  const { tabs, activeId } = useTabs.getState();
  expect(tabs.map((tab) => tab.title)).toEqual(["Query 1", "Query 2"]);
  expect(activeId).toBe(second);
  expect(first).not.toBe(second);
  expect(documentText(first)).toBe("");
  expect(documentText(second)).toBe("");
  expect(tabs[0]).toMatchObject({ path: null, stamp: null, dirty: false });
});

test("새 탭은 활성 탭의 접속을 물려받고 탭이 없으면 접속이 없다", () => {
  const first = useTabs.getState().newTab();
  expect(useTabs.getState().tabs[0].connection).toBeNull();

  useTabs.getState().setConnection(first, "local");
  useTabs.getState().newTab();

  expect(useTabs.getState().tabs[1].connection).toBe("local");
});

test("파일을 열면 내용과 stamp를 가진 탭이 된다", async () => {
  vi.mocked(readSqlFile).mockResolvedValue({
    text: "SELECT * FROM users",
    stamp: "s1",
  });

  await useTabs.getState().openFile("queries/users.sql");

  const { tabs, activeId } = useTabs.getState();
  expect(readSqlFile).toHaveBeenCalledWith("queries/users.sql");
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toMatchObject({
    title: "users.sql",
    path: "queries/users.sql",
    stamp: "s1",
    dirty: false,
  });
  expect(activeId).toBe(tabs[0].id);
  expect(documentText(tabs[0].id)).toBe("SELECT * FROM users");
});

test("이미 연 파일은 그 탭을 활성으로 할 뿐이다", async () => {
  vi.mocked(readSqlFile).mockResolvedValue({ text: "SELECT 1", stamp: "s1" });
  await useTabs.getState().openFile("queries/a.sql");
  const fileTab = useTabs.getState().activeId;
  useTabs.getState().newTab();
  expect(useTabs.getState().activeId).not.toBe(fileTab);

  await useTabs.getState().openFile("queries/a.sql");

  expect(readSqlFile).toHaveBeenCalledTimes(1);
  expect(useTabs.getState().activeId).toBe(fileTab);
  expect(useTabs.getState().tabs).toHaveLength(2);
});

test("파일을 못 열면 error를 두고 탭을 만들지 않는다", async () => {
  vi.mocked(readSqlFile).mockRejectedValue(
    new CommandError("file_too_large", "파일이 너무 큽니다"),
  );

  await useTabs.getState().openFile("queries/huge.sql");

  const { tabs, activeId, error } = useTabs.getState();
  expect(error).toBe("파일이 너무 큽니다");
  expect(tabs).toEqual([]);
  expect(activeId).toBeNull();
});

test("활성 탭을 닫으면 오른쪽, 없으면 왼쪽 탭이 활성이다", () => {
  const a = useTabs.getState().newTab();
  const b = useTabs.getState().newTab();
  const c = useTabs.getState().newTab();

  useTabs.getState().activate(b);
  useTabs.getState().close(b);
  expect(useTabs.getState().activeId).toBe(c);

  useTabs.getState().close(c);
  expect(useTabs.getState().activeId).toBe(a);

  useTabs.getState().close(a);
  expect(useTabs.getState().activeId).toBeNull();
  expect(ids()).toEqual([]);
});

test("활성이 아닌 탭을 닫아도 활성은 그대로다", () => {
  const a = useTabs.getState().newTab();
  const b = useTabs.getState().newTab();

  useTabs.getState().close(a);

  expect(useTabs.getState().activeId).toBe(b);
  expect(ids()).toEqual([b]);
});

test("닫은 탭의 문서는 지운다", () => {
  const a = useTabs.getState().newTab();
  useTabs.getState().newTab();

  useTabs.getState().close(a);

  expect(() => documentText(a)).toThrow();
});

test("next와 prev는 끝에서 돈다", () => {
  const a = useTabs.getState().newTab();
  const b = useTabs.getState().newTab();
  const c = useTabs.getState().newTab();

  useTabs.getState().next();
  expect(useTabs.getState().activeId).toBe(a);
  useTabs.getState().prev();
  expect(useTabs.getState().activeId).toBe(c);
  useTabs.getState().prev();
  expect(useTabs.getState().activeId).toBe(b);
});

test("탭이 1개 이하면 next와 prev는 아무것도 하지 않는다", () => {
  useTabs.getState().next();
  useTabs.getState().prev();
  expect(useTabs.getState().activeId).toBeNull();

  const a = useTabs.getState().newTab();
  const before = useTabs.getState();
  useTabs.getState().next();
  useTabs.getState().prev();

  expect(useTabs.getState()).toBe(before);
  expect(useTabs.getState().activeId).toBe(a);
});

test("markDirty는 이미 dirty면 state를 바꾸지 않는다", () => {
  const id = useTabs.getState().newTab();

  useTabs.getState().markDirty(id);
  const dirtyTabs = useTabs.getState().tabs;
  expect(dirtyTabs[0].dirty).toBe(true);

  useTabs.getState().markDirty(id);
  expect(useTabs.getState().tabs).toBe(dirtyTabs);
});

test("markSaved는 path, stamp, title을 바꾸고 naming을 비운다", () => {
  const id = useTabs.getState().newTab();
  useTabs.getState().markDirty(id);
  useTabs.getState().requestName(id);
  expect(useTabs.getState().naming).toBe(id);

  useTabs.getState().markSaved(id, "queries/sub/report.sql", "s9");

  expect(useTabs.getState().tabs[0]).toMatchObject({
    title: "report.sql",
    path: "queries/sub/report.sql",
    stamp: "s9",
    dirty: false,
  });
  expect(useTabs.getState().naming).toBeNull();
});

test("reset은 탭과 문서를 모두 지우고 번호를 처음으로 돌린다", () => {
  const a = useTabs.getState().newTab();
  const b = useTabs.getState().newTab();
  useTabs.getState().requestName(b);
  useTabs.getState().setError("x");

  useTabs.getState().reset();

  const { tabs, activeId, naming, error } = useTabs.getState();
  expect(tabs).toEqual([]);
  expect(activeId).toBeNull();
  expect(naming).toBeNull();
  expect(error).toBeNull();
  expect(() => documentText(a)).toThrow();
  expect(() => documentText(b)).toThrow();

  useTabs.getState().newTab();
  expect(useTabs.getState().tabs[0].title).toBe("Query 1");
});

test("파일을 열면 앞선 오류를 지운다", async () => {
  vi.mocked(readSqlFile).mockResolvedValue({ text: "SELECT 1", stamp: "s1" });
  useTabs.getState().setError("읽을 수 없습니다");

  await useTabs.getState().openFile("queries/a.sql");
  expect(useTabs.getState().error).toBeNull();

  useTabs.getState().setError("읽을 수 없습니다");
  await useTabs.getState().openFile("queries/a.sql");
  expect(useTabs.getState().error).toBeNull();
});

test("close는 그 탭의 이름을 묻고 있을 때만 naming을 비운다", () => {
  const a = useTabs.getState().newTab();
  const b = useTabs.getState().newTab();
  useTabs.getState().requestName(b);

  useTabs.getState().close(a);
  expect(useTabs.getState().naming).toBe(b);

  useTabs.getState().close(b);
  expect(useTabs.getState().naming).toBeNull();
});

test("new_tab_can_start_with_text", () => {
  const id = useTabs.getState().newTab({ text: "SELECT 1" });
  expect(documentText(id)).toBe("SELECT 1");
  expect(useTabs.getState().activeId).toBe(id);
});

function restored(patch: Partial<RestoredTab> = {}): RestoredTab {
  return {
    title: "Query 1",
    path: null,
    stamp: null,
    dirty: false,
    connection: null,
    mode: "auto",
    text: "",
    ...patch,
  };
}

test("restore_tabs_opens_each_document_and_activates_the_given_tab", () => {
  useTabs
    .getState()
    .restoreTabs(
      [
        restored({ title: "a.sql", path: "a.sql", stamp: "s1", text: "A" }),
        restored({ title: "Query 2", dirty: true, text: "B", mode: "manual" }),
      ],
      1,
    );

  const { tabs, activeId } = useTabs.getState();
  expect(tabs).toMatchObject([
    { title: "a.sql", path: "a.sql", stamp: "s1", dirty: false, mode: "auto" },
    { title: "Query 2", path: null, dirty: true, mode: "manual" },
  ]);
  expect(activeId).toBe(tabs[1].id);
  expect(tabs.map((tab) => documentText(tab.id))).toEqual(["A", "B"]);
});

test("restore_tabs_without_an_active_tab_activates_the_first", () => {
  useTabs.getState().restoreTabs([restored(), restored()], null);

  const { tabs, activeId } = useTabs.getState();
  expect(activeId).toBe(tabs[0].id);
});

test("new_tab_titles_continue_after_restored_untitled_tabs", () => {
  useTabs
    .getState()
    .restoreTabs(
      [
        restored({ title: "Query 7", path: "Query 9" }),
        restored({ title: "Query 3" }),
        restored({ title: "Query x" }),
      ],
      0,
    );

  useTabs.getState().newTab();

  expect(useTabs.getState().tabs[3].title).toBe("Query 4");
});
