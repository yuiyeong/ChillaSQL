import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { click } from "../../test/click";
import {
  connection,
  openProjectWith,
  resultColumns,
} from "../../test/fixtures";
import { resetStores } from "../../test/resetStores";

vi.mock("./commands", () => ({
  changeConnection: vi.fn(),
  execute: vi.fn(),
}));

import { useEditorStatus } from "../editor/editorStatus";
import { useTabs } from "../editor/tabsStore";
import { emptyResult, type RunState } from "../query/runReducer";
import { useRuns } from "../query/runsStore";
import { useTunnels } from "../connections/tunnelsStore";
import { changeConnection, execute } from "./commands";
import { Toolbar } from "./Toolbar";

function tabWith(connectionName: string | null): string {
  let id = "";
  act(() => {
    id = useTabs.getState().newTab();
    useTabs.getState().setConnection(id, connectionName);
  });
  return id;
}

function setRun(tabId: string, run: RunState) {
  act(() => useRuns.setState({ runs: { [tabId]: run } }));
}

/** 접속 menu의 열림은 Workspace가 갖는다. test에서는 이 wrapper가 갖는다. */
function ControlledToolbar({ onAddConnection }: { onAddConnection(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <Toolbar
      onAddConnection={onAddConnection}
      connectionMenuOpen={open}
      onConnectionMenuChange={setOpen}
    />
  );
}

function renderToolbar(onAddConnection: () => void = vi.fn()) {
  render(<ControlledToolbar onAddConnection={onAddConnection} />);
}

const ORIGIN = { line: 1, column: 1 };
const chip = () =>
  screen.getByRole("button", { name: "Change this tab's connection" });
/** 단축키 표시(Kbd)는 읽어 주지 않으므로 이름은 label 그대로다. */
const runButton = (name: string) => screen.getByRole("button", { name });
const progress = () => screen.queryByTestId("progress-bar");

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
});

test("접속 chip은 탭의 접속 이름과 database를 보여 준다", () => {
  openProjectWith([connection("local", { database: "chilla_test" })]);
  tabWith("local");
  renderToolbar();

  expect(chip()).toHaveTextContent("local");
  expect(chip()).toHaveTextContent("chilla_test");
  expect(chip()).toHaveAttribute("aria-haspopup", "menu");
  expect(chip()).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});

test("접속이 없는 탭은 Choose connection이고 실행 버튼이 disabled다", () => {
  openProjectWith([connection("local")]);
  tabWith(null);
  renderToolbar();

  expect(chip()).toHaveTextContent("Choose connection");
  expect(chip()).toBeEnabled();
  expect(runButton("Run statement")).toBeDisabled();
  expect(runButton("Choose what to run")).toBeDisabled();
});

test("탭이 없으면 chip과 실행 버튼이 disabled다", () => {
  openProjectWith([connection("local")]);
  renderToolbar();

  expect(chip()).toBeDisabled();
  expect(runButton("Run statement")).toBeDisabled();
});

test("chip을 누르면 접속 menu가 열리고 고르면 접속을 바꾼다", async () => {
  openProjectWith([
    connection("local", { database: "chilla_test" }),
    connection("staging", { host: "10.0.0.2", port: 6432, tunnel: "bastion" }),
  ]);
  const id = tabWith("local");
  renderToolbar();

  await click(chip());

  expect(chip()).toHaveAttribute("aria-expanded", "true");
  const menu = screen.getByRole("menu", { name: "Connections" });
  const items = within(menu).getAllByRole("menuitemradio");
  expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
    "true",
    "false",
  ]);
  expect(items[0]).toHaveTextContent("localhost:5432/chilla_test");
  expect(items[1]).toHaveTextContent("10.0.0.2:6432/app");

  await click(items[1]);

  expect(changeConnection).toHaveBeenCalledWith(id, "staging");
  expect(screen.queryByRole("menu")).toBeNull();
});

test("Add connection은 onAddConnection을 부른다", async () => {
  openProjectWith([connection("local")]);
  tabWith("local");
  const onAddConnection = vi.fn();
  renderToolbar(onAddConnection);

  await click(chip());
  await click(screen.getByRole("menuitem", { name: "Add connection…" }));

  expect(onAddConnection).toHaveBeenCalledOnce();
  expect(changeConnection).not.toHaveBeenCalled();
});

test("Run statement를 누르면 실행한다", async () => {
  openProjectWith([connection("local")]);
  tabWith("local");
  renderToolbar();

  expect(runButton("Run statement")).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Enter",
  );
  await click(runButton("Run statement"));

  expect(execute).toHaveBeenCalledWith("run");
});

test("선택이 있으면 Run selection이다", () => {
  openProjectWith([connection("local")]);
  const id = tabWith("local");
  renderToolbar();

  act(() => useEditorStatus.setState({ tabId: id, hasSelection: true }));

  expect(runButton("Run selection")).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Run statement" })).toBeNull();
});

test("다른 탭의 선택은 Run selection으로 보이지 않는다", () => {
  openProjectWith([connection("local")]);
  tabWith("local");
  renderToolbar();

  act(() => useEditorStatus.setState({ tabId: "other", hasSelection: true }));

  expect(runButton("Run statement")).toBeEnabled();
});

test("실행 중에는 Cancel이고 누르면 취소한다", async () => {
  openProjectWith([connection("local")]);
  const id = tabWith("local");
  renderToolbar();

  setRun(id, {
    status: "running",
    result: emptyResult(
      { sql: "SELECT 1", from: 0, origin: ORIGIN },
      "run-0",
      0,
    ),
  });

  expect(screen.queryByRole("button", { name: "Run statement" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Choose what to run" }),
  ).toBeNull();
  expect(runButton("Cancel")).toHaveAttribute("aria-keyshortcuts", "Meta+F2");
  await click(runButton("Cancel"));
  expect(execute).toHaveBeenCalledWith("cancel");
});

test("연결 중에는 Cancel이 disabled이고 실행 중에는 enabled다", () => {
  openProjectWith([connection("local")]);
  const id = tabWith("local");
  renderToolbar();

  setRun(id, { status: "connecting" });
  expect(runButton("Cancel")).toBeDisabled();

  setRun(id, {
    status: "running",
    result: emptyResult(
      { sql: "SELECT 1", from: 0, origin: ORIGIN },
      "run-0",
      0,
    ),
  });
  expect(runButton("Cancel")).toBeEnabled();
});

test("진행 막대는 accent 색 그대로이고 pointer를 받지 않는다", () => {
  openProjectWith([connection("local")]);
  const id = tabWith("local");
  renderToolbar();

  setRun(id, { status: "connecting" });

  const bar = screen.getByTestId("progress-bar");
  const fill = bar.firstElementChild as HTMLElement;
  expect(fill).toHaveClass("bg-accent", "w-[28%]");
  expect(fill).not.toHaveClass("bg-accent/28");
  expect(bar).toHaveClass("pointer-events-none");
});

test("실행 menu에서 항목을 고르거나 Escape를 누르면 focus가 chevron button으로 돌아온다", async () => {
  openProjectWith([connection("local")]);
  tabWith("local");
  renderToolbar();

  await click(runButton("Choose what to run"));
  await click(screen.getByRole("menuitem", { name: "Run statement" }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(runButton("Choose what to run")).toHaveFocus();

  await click(runButton("Choose what to run"));
  fireEvent.keyDown(screen.getByRole("menu", { name: "What to run" }), {
    key: "Escape",
  });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(runButton("Choose what to run")).toHaveFocus();
});

test("실행 menu를 연 채 실행이 시작되면 닫히고 실행이 끝나도 다시 열리지 않는다", async () => {
  openProjectWith([connection("local")]);
  const id = tabWith("local");
  renderToolbar();

  await click(runButton("Choose what to run"));
  expect(screen.getByRole("menu", { name: "What to run" })).toBeInTheDocument();

  setRun(id, {
    status: "running",
    result: emptyResult(
      { sql: "SELECT 1", from: 0, origin: ORIGIN },
      "run-0",
      0,
    ),
  });
  expect(screen.queryByRole("menu")).toBeNull();

  setRun(id, { status: "idle" });
  expect(runButton("Choose what to run")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(screen.queryByRole("menu")).toBeNull();
});

test("실행 menu를 연 채 왼쪽 실행 button을 누르면 menu가 닫힌다", () => {
  openProjectWith([connection("local")]);
  tabWith("local");
  renderToolbar();

  fireEvent.click(runButton("Choose what to run"));
  fireEvent.pointerDown(runButton("Run statement"));

  expect(screen.queryByRole("menu")).toBeNull();
});

test("실행 menu의 Run statement는 단축키를 보이고 실행한다", async () => {
  openProjectWith([connection("local")]);
  tabWith("local");
  renderToolbar();

  await click(runButton("Choose what to run"));

  const menu = screen.getByRole("menu", { name: "What to run" });
  const run = within(menu).getByRole("menuitem", { name: "Run statement" });
  expect(run).toHaveAttribute("aria-keyshortcuts", "Meta+Enter");
  await click(run);
  expect(execute).toHaveBeenCalledWith("run");
});

test("run_file_is_enabled", async () => {
  openProjectWith([connection("local")]);
  tabWith("local");
  renderToolbar();

  await click(runButton("Choose what to run"));

  const menu = screen.getByRole("menu", { name: "What to run" });
  const runFile = within(menu).getByRole("menuitem", { name: "Run file" });
  expect(runFile).toBeEnabled();
  // Run file에는 단축키가 없다.
  expect(runFile).not.toHaveAttribute("aria-keyshortcuts");
  await click(runFile);
  expect(execute).toHaveBeenCalledWith("runFile");
});

test("실행 menu의 첫 항목 label은 선택 여부를 따른다", async () => {
  openProjectWith([connection("local")]);
  const id = tabWith("local");
  renderToolbar();
  act(() => useEditorStatus.setState({ tabId: id, hasSelection: true }));

  await click(runButton("Choose what to run"));

  const menu = screen.getByRole("menu", { name: "What to run" });
  expect(
    within(menu).getByRole("menuitem", { name: "Run selection" }),
  ).toBeInTheDocument();
});

test("연결 중과 첫 행을 기다리는 동안 진행 막대가 있다", () => {
  openProjectWith([connection("local")]);
  const id = tabWith("local");
  renderToolbar();
  expect(progress()).toBeNull();

  setRun(id, { status: "connecting" });
  expect(progress()).toHaveAttribute("aria-hidden", "true");

  setRun(id, {
    status: "running",
    result: emptyResult(
      { sql: "SELECT 1", from: 0, origin: ORIGIN },
      "run-0",
      0,
    ),
  });
  expect(progress()).not.toBeNull();

  setRun(id, {
    status: "running",
    result: {
      ...emptyResult({ sql: "SELECT 1", from: 0, origin: ORIGIN }, "run-0", 0),
      columns: resultColumns("a"),
      rows: [["1"]],
    },
  });
  expect(progress()).toBeNull();

  setRun(id, { status: "idle" });
  expect(progress()).toBeNull();
});

test("실행 버튼 너비는 label이 바뀌어도 같다", () => {
  openProjectWith([connection("local")]);
  const id = tabWith("local");
  renderToolbar();

  expect(runButton("Run statement")).toHaveStyle({ width: "200px" });
  act(() => useEditorStatus.setState({ tabId: id, hasSelection: true }));
  expect(runButton("Run selection")).toHaveStyle({ width: "200px" });
  expect(runButton("Choose what to run")).toHaveStyle({ width: "26px" });

  setRun(id, { status: "connecting" });
  expect(runButton("Cancel")).toHaveStyle({ width: "227px" });
});

test("프로젝트가 없어도 그린다", () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  renderToolbar();

  expect(chip()).toBeDisabled();
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

test("터널이 시작 중인 연결 중에는 Cancel이 enabled이고 chip에 상태를 보여 준다", () => {
  openProjectWith([connection("staging", { tunnel: "ssh" })]);
  const id = tabWith("staging");
  renderToolbar();

  setRun(id, { status: "connecting" });
  expect(runButton("Cancel")).toBeDisabled();

  act(() =>
    useTunnels.getState().apply({
      connection: "staging",
      state: { status: "starting", attempt: 0, timeoutSecs: 20 },
    }),
  );
  expect(runButton("Cancel")).toBeEnabled();
  expect(chip()).toHaveTextContent("Starting tunnel");
});

test("connection_menu_open_is_controlled", async () => {
  tabWith("local");
  const onChange = vi.fn();
  const { rerender } = render(
    <Toolbar
      onAddConnection={vi.fn()}
      connectionMenuOpen
      onConnectionMenuChange={onChange}
    />,
  );
  expect(screen.getByRole("menu", { name: "Connections" })).toBeInTheDocument();
  expect(chip()).toHaveAttribute("aria-expanded", "true");

  await click(chip());
  expect(onChange).toHaveBeenCalledWith(false);

  rerender(
    <Toolbar
      onAddConnection={vi.fn()}
      connectionMenuOpen={false}
      onConnectionMenuChange={onChange}
    />,
  );
  expect(screen.queryByRole("menu", { name: "Connections" })).toBeNull();
});

test("reformat_button_runs_the_command", async () => {
  openProjectWith([connection("local")]);
  tabWith("local");
  renderToolbar();

  const button = screen.getByRole("button", { name: "Reformat (Opt+Cmd+L)" });
  expect(button).toHaveAttribute("aria-keyshortcuts", "Alt+Meta+L");
  await click(button);

  expect(execute).toHaveBeenCalledWith("reformat");
});

test("탭이 없으면 Reformat이 disabled다", () => {
  renderToolbar();

  expect(
    screen.getByRole("button", { name: "Reformat (Opt+Cmd+L)" }),
  ).toBeDisabled();
});

test("explain_button_runs_explain", async () => {
  openProjectWith([connection("local")]);
  tabWith("local");
  renderToolbar();

  const button = screen.getByRole("button", {
    name: "Explain plan (EXPLAIN ANALYZE)",
  });
  expect(button).not.toHaveAttribute("aria-keyshortcuts");
  await click(button);

  expect(execute).toHaveBeenCalledWith("explain");
});

test("explain_follows_reformat_in_the_toolbar", () => {
  openProjectWith([connection("local")]);
  tabWith("local");
  renderToolbar();

  const names = within(screen.getByRole("toolbar"))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));
  const reformat = names.indexOf("Reformat (Opt+Cmd+L)");
  expect(names[reformat + 1]).toBe("Explain plan (EXPLAIN ANALYZE)");
});

test("explain_is_disabled_without_a_connection", () => {
  openProjectWith([connection("local")]);
  tabWith(null);
  renderToolbar();

  expect(
    screen.getByRole("button", { name: "Explain plan (EXPLAIN ANALYZE)" }),
  ).toBeDisabled();
});

test("explain_is_disabled_without_a_tab", () => {
  renderToolbar();

  expect(
    screen.getByRole("button", { name: "Explain plan (EXPLAIN ANALYZE)" }),
  ).toBeDisabled();
});

test("read_only_connections_show_the_lock", async () => {
  openProjectWith([connection("dev"), connection("prod", { readOnly: true })]);
  tabWith("prod");
  renderToolbar();

  expect(within(chip()).getByRole("img", { name: "Read-only" })).toBeVisible();

  await click(chip());
  const [dev, prod] = within(
    screen.getByRole("menu", { name: "Connections" }),
  ).getAllByRole("menuitemradio");
  expect(within(dev).queryByRole("img", { name: "Read-only" })).toBeNull();
  expect(within(prod).getByRole("img", { name: "Read-only" })).toBeVisible();
});

test("a_writable_connection_shows_no_lock_on_the_chip", () => {
  openProjectWith([connection("dev")]);
  tabWith("dev");
  renderToolbar();

  expect(within(chip()).queryByRole("img", { name: "Read-only" })).toBeNull();
});
