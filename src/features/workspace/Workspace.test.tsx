import { EditorView } from "@codemirror/view";
import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { change } from "../../test/change";
import { click } from "../../test/click";
import { deferred } from "../../test/deferred";
import { resetStores } from "../../test/resetStores";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/dialog");

import {
  cancelQuery,
  executeQuery,
  hasPassword,
  listSqlFiles,
  openSession,
  readSqlFile,
  saveConnection,
  splitStatements,
  writeSqlFile,
} from "../../shared/api/commands";
import type { Connection, Project, QueryEvent } from "../../shared/api/types";
import { openDocument } from "../editor/documents";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { Workspace } from "./Workspace";

function connection(name: string, host = "localhost"): Connection {
  return {
    name,
    host,
    port: 5432,
    database: "app",
    user: "chilla",
    sslmode: "disable",
    sslrootcert: null,
    tunnel: null,
    color: null,
  };
}

function openProjectWith(
  connections: Connection[] = [],
  files: string[] = [],
): Project {
  const project: Project = { name: "demo", dir: "/p", connections };
  useProject.setState(
    { ...useProject.getInitialState(), status: "ready", project, files },
    true,
  );
  return project;
}

/** 새 탭을 만들고 text와 접속을 둔다. */
function tabWith(text: string, connectionName: string | null): string {
  let id = "";
  act(() => {
    id = useTabs.getState().newTab();
    openDocument(id, text);
    useTabs.getState().setConnection(id, connectionName);
  });
  return id;
}

/** tabWith는 문서를 바꿔 끼우므로 그 뒤에 그린다. */
function renderWorkspace() {
  return render(<Workspace />);
}

function toolbarButton(name: string) {
  return within(screen.getByRole("toolbar")).getByRole("button", { name });
}

function connectionSelect() {
  return screen.getByRole("combobox", { name: "접속" });
}

function connectionForm() {
  const form = screen.getByLabelText("name").closest("form");
  if (form === null) throw new Error("접속 form이 없습니다");
  return form;
}

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  vi.mocked(listSqlFiles).mockResolvedValue([]);
  vi.mocked(hasPassword).mockResolvedValue(false);
});

test("탭이 없으면 새 탭 안내를 그리고 toolbar는 disabled다", () => {
  openProjectWith([connection("local")]);
  renderWorkspace();

  expect(screen.getByText("Shift+Cmd+L로 새 탭")).toBeInTheDocument();
  expect(connectionSelect()).toBeDisabled();
  expect(toolbarButton("실행")).toBeDisabled();
  expect(toolbarButton("취소")).toBeDisabled();
  expect(toolbarButton("저장")).toBeDisabled();
});

test("실행 중일 때만 취소 버튼이 enabled다", async () => {
  openProjectWith([connection("local")]);
  vi.mocked(splitStatements).mockResolvedValue([{ start: 0, end: 8 }]);
  vi.mocked(openSession).mockResolvedValue({
    id: 3,
    connection: "local",
    backendPid: 100,
  });
  vi.mocked(executeQuery).mockResolvedValue(7);
  vi.mocked(cancelQuery).mockResolvedValue();
  tabWith("SELECT 1", "local");
  renderWorkspace();

  expect(toolbarButton("실행")).toBeEnabled();
  expect(toolbarButton("취소")).toBeDisabled();

  await click(toolbarButton("실행"));

  await vi.waitFor(() => expect(toolbarButton("취소")).toBeEnabled());
  expect(executeQuery).toHaveBeenCalledWith(
    3,
    "SELECT 1",
    expect.any(Function),
  );

  await click(toolbarButton("취소"));
  expect(cancelQuery).toHaveBeenCalledWith(3, 7);

  const onEvent = vi.mocked(executeQuery).mock.calls[0][2];
  const finished: QueryEvent = {
    type: "finished",
    elapsedMicros: 10,
    outcome: "cancelled",
  };
  act(() => onEvent(finished));

  expect(toolbarButton("취소")).toBeDisabled();
});

test("접속 select는 프로젝트의 접속을 나열하고 바꾸면 탭의 접속이 바뀐다", async () => {
  openProjectWith([connection("local"), connection("staging")]);
  const id = tabWith("SELECT 1", null);
  renderWorkspace();

  const select = connectionSelect();
  expect(
    within(select)
      .getAllByRole("option")
      .map((option) => option.textContent),
  ).toEqual(["접속 없음", "local", "staging"]);
  expect(select).toHaveValue("");

  await act(async () => change(select, "staging"));

  expect(useTabs.getState().tabs.find((t) => t.id === id)?.connection).toBe(
    "staging",
  );
  expect(select).toHaveValue("staging");

  await act(async () => change(select, ""));

  expect(
    useTabs.getState().tabs.find((t) => t.id === id)?.connection,
  ).toBeNull();
});

test("sidebar의 파일을 누르면 탭으로 열린다", async () => {
  openProjectWith([], ["queries/a.sql"]);
  vi.mocked(readSqlFile).mockResolvedValue({ text: "SELECT 42", stamp: "s1" });
  const { container } = renderWorkspace();

  await click(screen.getByRole("button", { name: "queries/a.sql" }));

  expect(readSqlFile).toHaveBeenCalledWith("queries/a.sql");
  expect(screen.getByRole("button", { name: "a.sql" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect(container.querySelector(".cm-content")?.textContent).toBe("SELECT 42");
  expect(screen.queryByText("Shift+Cmd+L로 새 탭")).not.toBeInTheDocument();
});

test("접속 추가를 누르면 form이 열리고 저장하면 접속 목록에 나타난다", async () => {
  openProjectWith();
  vi.mocked(saveConnection).mockResolvedValue({
    name: "demo",
    dir: "/p",
    connections: [connection("local")],
  });
  tabWith("", null);
  renderWorkspace();

  await click(screen.getByRole("button", { name: "접속 추가" }));
  const form = connectionForm();
  change(within(form).getByLabelText("name"), "local");
  change(within(form).getByLabelText("host"), "localhost");
  change(within(form).getByLabelText("database"), "app");
  change(within(form).getByLabelText("user"), "chilla");
  await click(within(form).getByRole("button", { name: "저장" }));

  expect(saveConnection).toHaveBeenCalled();
  expect(screen.queryByLabelText("name")).not.toBeInTheDocument();
  const sidebar = screen.getByRole("region", { name: "접속" });
  expect(within(sidebar).getByText("local")).toBeInTheDocument();
  expect(
    within(connectionSelect()).getByRole("option", { name: "local" }),
  ).toBeInTheDocument();
});

test("수정을 누르면 그 접속의 값으로 form을 연다", async () => {
  openProjectWith([connection("local"), connection("staging", "10.0.0.2")]);
  renderWorkspace();
  const sidebar = screen.getByRole("region", { name: "접속" });
  const [editLocal, editStaging] = within(sidebar).getAllByRole("button", {
    name: "수정",
  });

  await click(editLocal);
  expect(screen.getByLabelText("name")).toHaveValue("local");
  expect(screen.getByLabelText("host")).toHaveValue("localhost");

  await click(editStaging);
  expect(screen.getByLabelText("name")).toHaveValue("staging");
  expect(screen.getByLabelText("host")).toHaveValue("10.0.0.2");

  await click(within(connectionForm()).getByRole("button", { name: "취소" }));
  expect(screen.queryByLabelText("name")).not.toBeInTheDocument();
});

test("닫은 form의 저장이 늦게 끝나도 접속을 반영하고 새로 연 form은 그대로 둔다", async () => {
  openProjectWith();
  const saving = deferred<Project>();
  vi.mocked(saveConnection).mockReturnValue(saving.promise);
  renderWorkspace();

  await click(screen.getByRole("button", { name: "접속 추가" }));
  const form = connectionForm();
  change(within(form).getByLabelText("name"), "local");
  change(within(form).getByLabelText("host"), "localhost");
  change(within(form).getByLabelText("database"), "app");
  change(within(form).getByLabelText("user"), "chilla");
  await click(within(form).getByRole("button", { name: "저장" }));
  await click(within(form).getByRole("button", { name: "취소" }));
  expect(screen.queryByLabelText("name")).not.toBeInTheDocument();

  await click(screen.getByRole("button", { name: "접속 추가" }));
  await act(async () =>
    saving.resolve({
      name: "demo",
      dir: "/p",
      connections: [connection("local")],
    }),
  );

  const sidebar = screen.getByRole("region", { name: "접속" });
  expect(within(sidebar).getByText("local")).toBeInTheDocument();
  expect(screen.getByLabelText("name")).toHaveValue("");
});

test("탭 bar, 에디터, 이름 form이 탭을 움직인다", async () => {
  openProjectWith();
  vi.mocked(writeSqlFile).mockResolvedValue("s1");
  const { container } = renderWorkspace();

  await click(screen.getByRole("button", { name: "새 탭" }));
  expect(screen.getByRole("button", { name: "쿼리 1" })).toBeInTheDocument();

  const dom = container.querySelector<HTMLElement>(".cm-editor");
  const view = dom === null ? null : EditorView.findFromDOM(dom);
  if (view === null) throw new Error("EditorView가 없습니다");
  act(() => view.dispatch({ changes: { from: 0, insert: "SELECT 1" } }));
  expect(screen.getByLabelText("저장하지 않음")).toBeInTheDocument();

  await click(toolbarButton("저장"));
  const path = screen.getByLabelText("파일 경로");
  const submit = within(path.closest("form") as HTMLElement).getByRole(
    "button",
    { name: "저장" },
  );

  // 빈 이름은 무시한다.
  change(path, "  ");
  await click(submit);
  expect(writeSqlFile).not.toHaveBeenCalled();

  change(path, "queries/x");
  await click(submit);
  expect(writeSqlFile).toHaveBeenCalledWith("queries/x.sql", "SELECT 1", {
    mode: "create",
  });
  expect(screen.getByRole("button", { name: "x.sql" })).toBeInTheDocument();

  await click(screen.getByRole("button", { name: "x.sql 닫기" }));
  expect(screen.getByText("Shift+Cmd+L로 새 탭")).toBeInTheDocument();
});

test("프로젝트 오류를 보여 주고 누르면 지운다", async () => {
  openProjectWith();
  renderWorkspace();

  act(() => useProject.setState({ error: "chilla.toml이 없습니다" }));

  expect(screen.getByRole("alert")).toHaveTextContent("chilla.toml이 없습니다");
  await click(screen.getByRole("button", { name: "chilla.toml이 없습니다" }));
  expect(useProject.getState().error).toBeNull();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("접속 form이 열려 있으면 단축키가 동작하지 않는다", async () => {
  openProjectWith([connection("local")]);
  vi.mocked(splitStatements).mockResolvedValue([{ start: 0, end: 8 }]);
  const id = tabWith("SELECT 1", "local");
  renderWorkspace();
  const shortcut = (code: string) =>
    new KeyboardEvent("keydown", {
      code,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

  await click(screen.getByRole("button", { name: "접속 추가" }));
  const name = screen.getByLabelText("name");
  const run = shortcut("Enter");
  const close = shortcut("KeyW");
  await act(async () => {
    name.dispatchEvent(run);
    name.dispatchEvent(close);
  });

  expect(run.defaultPrevented).toBe(false);
  expect(close.defaultPrevented).toBe(false);
  expect(splitStatements).not.toHaveBeenCalled();
  expect(useTabs.getState().tabs.map((tab) => tab.id)).toEqual([id]);

  // form을 닫으면 다시 잡는다.
  await click(within(connectionForm()).getByRole("button", { name: "취소" }));
  const closeAgain = shortcut("KeyW");
  await act(async () => {
    window.dispatchEvent(closeAgain);
  });
  expect(closeAgain.defaultPrevented).toBe(true);
  expect(useTabs.getState().tabs).toEqual([]);
});
