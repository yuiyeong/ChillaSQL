import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { click } from "../../test/click";
import { resetStores } from "../../test/resetStores";

vi.mock("./commands", () => ({
  changeConnection: vi.fn(),
  execute: vi.fn(),
}));

import type { Connection } from "../../shared/api/types";
import { useEditorStatus } from "../editor/editorStatus";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { emptyResult, type RunState } from "../query/runReducer";
import { useRuns } from "../query/runsStore";
import { changeConnection, execute } from "./commands";
import { Toolbar } from "./Toolbar";

function connection(name: string, extra: Partial<Connection> = {}): Connection {
  return {
    name,
    host: "localhost",
    port: 5432,
    database: "app",
    user: "chilla",
    sslmode: "disable",
    sslrootcert: null,
    tunnel: null,
    color: null,
    ...extra,
  };
}

function openProjectWith(connections: Connection[]) {
  useProject.setState(
    {
      ...useProject.getInitialState(),
      status: "ready",
      project: { name: "demo", dir: "/p", connections },
      files: [],
    },
    true,
  );
}

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

const ORIGIN = { line: 1, column: 1 };
const chip = () =>
  screen.getByRole("button", { name: "Change this tab's connection" });
/** 실행 버튼의 이름은 label 뒤에 단축키가 붙는다. */
const runButton = (name: string) =>
  screen.getByRole("button", { name: new RegExp(`^${name}`) });
const progress = () => screen.queryByTestId("progress-bar");

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  useEditorStatus.setState(useEditorStatus.getInitialState(), true);
});

test("접속 chip은 탭의 접속 이름과 database를 보여 준다", () => {
  openProjectWith([connection("local", { database: "chilla_test" })]);
  tabWith("local");
  render(<Toolbar onAddConnection={vi.fn()} />);

  expect(chip()).toHaveTextContent("local");
  expect(chip()).toHaveTextContent("chilla_test");
  expect(chip()).toHaveAttribute("aria-haspopup", "menu");
  expect(chip()).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});

test("접속이 없는 탭은 Choose connection이고 실행 버튼이 disabled다", () => {
  openProjectWith([connection("local")]);
  tabWith(null);
  render(<Toolbar onAddConnection={vi.fn()} />);

  expect(chip()).toHaveTextContent("Choose connection");
  expect(chip()).toBeEnabled();
  expect(runButton("Run statement")).toBeDisabled();
  expect(runButton("Choose what to run")).toBeDisabled();
});

test("탭이 없으면 chip과 실행 버튼이 disabled다", () => {
  openProjectWith([connection("local")]);
  render(<Toolbar onAddConnection={vi.fn()} />);

  expect(chip()).toBeDisabled();
  expect(runButton("Run statement")).toBeDisabled();
});

test("chip을 누르면 접속 menu가 열리고 고르면 접속을 바꾼다", async () => {
  openProjectWith([
    connection("local", { database: "chilla_test" }),
    connection("staging", { host: "10.0.0.2", port: 6432, tunnel: "bastion" }),
  ]);
  const id = tabWith("local");
  render(<Toolbar onAddConnection={vi.fn()} />);

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
  render(<Toolbar onAddConnection={onAddConnection} />);

  await click(chip());
  await click(screen.getByRole("menuitem", { name: "Add connection…" }));

  expect(onAddConnection).toHaveBeenCalledOnce();
  expect(changeConnection).not.toHaveBeenCalled();
});

test("Run statement를 누르면 실행한다", async () => {
  openProjectWith([connection("local")]);
  tabWith("local");
  render(<Toolbar onAddConnection={vi.fn()} />);

  await click(runButton("Run statement"));

  expect(execute).toHaveBeenCalledWith("run");
});

test("선택이 있으면 Run selection이다", () => {
  openProjectWith([connection("local")]);
  const id = tabWith("local");
  render(<Toolbar onAddConnection={vi.fn()} />);

  act(() => useEditorStatus.setState({ tabId: id, hasSelection: true }));

  expect(runButton("Run selection")).toBeEnabled();
  expect(screen.queryByRole("button", { name: /^Run statement/ })).toBeNull();
});

test("다른 탭의 선택은 Run selection으로 보이지 않는다", () => {
  openProjectWith([connection("local")]);
  tabWith("local");
  render(<Toolbar onAddConnection={vi.fn()} />);

  act(() => useEditorStatus.setState({ tabId: "other", hasSelection: true }));

  expect(runButton("Run statement")).toBeEnabled();
});

test("실행 중에는 Cancel이고 누르면 취소한다", async () => {
  openProjectWith([connection("local")]);
  const id = tabWith("local");
  render(<Toolbar onAddConnection={vi.fn()} />);

  setRun(id, { status: "running", result: emptyResult("SELECT 1", ORIGIN, 0) });

  expect(screen.queryByRole("button", { name: /^Run statement/ })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Choose what to run" }),
  ).toBeNull();
  await click(runButton("Cancel"));
  expect(execute).toHaveBeenCalledWith("cancel");
});

test("연결 중에는 Cancel이 disabled이고 실행 중에는 enabled다", () => {
  openProjectWith([connection("local")]);
  const id = tabWith("local");
  render(<Toolbar onAddConnection={vi.fn()} />);

  setRun(id, { status: "connecting" });
  expect(runButton("Cancel")).toBeDisabled();

  setRun(id, { status: "running", result: emptyResult("SELECT 1", ORIGIN, 0) });
  expect(runButton("Cancel")).toBeEnabled();
});

test("진행 막대는 accent 색 그대로이고 pointer를 받지 않는다", () => {
  openProjectWith([connection("local")]);
  const id = tabWith("local");
  render(<Toolbar onAddConnection={vi.fn()} />);

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
  render(<Toolbar onAddConnection={vi.fn()} />);

  await click(runButton("Choose what to run"));
  await click(screen.getByRole("menuitem", { name: /^Run statement/ }));
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
  render(<Toolbar onAddConnection={vi.fn()} />);

  await click(runButton("Choose what to run"));
  expect(screen.getByRole("menu", { name: "What to run" })).toBeInTheDocument();

  setRun(id, { status: "running", result: emptyResult("SELECT 1", ORIGIN, 0) });
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
  render(<Toolbar onAddConnection={vi.fn()} />);

  fireEvent.click(runButton("Choose what to run"));
  fireEvent.pointerDown(runButton("Run statement"));

  expect(screen.queryByRole("menu")).toBeNull();
});

test("실행 menu의 Run file은 disabled다", async () => {
  openProjectWith([connection("local")]);
  tabWith("local");
  render(<Toolbar onAddConnection={vi.fn()} />);

  await click(runButton("Choose what to run"));

  const menu = screen.getByRole("menu", { name: "What to run" });
  expect(
    within(menu).getByRole("menuitem", { name: "Run file" }),
  ).toBeDisabled();
  await click(within(menu).getByRole("menuitem", { name: /Run statement/ }));
  expect(execute).toHaveBeenCalledWith("run");
});

test("실행 menu의 첫 항목 label은 선택 여부를 따른다", async () => {
  openProjectWith([connection("local")]);
  const id = tabWith("local");
  render(<Toolbar onAddConnection={vi.fn()} />);
  act(() => useEditorStatus.setState({ tabId: id, hasSelection: true }));

  await click(runButton("Choose what to run"));

  const menu = screen.getByRole("menu", { name: "What to run" });
  expect(
    within(menu).getByRole("menuitem", { name: /Run selection/ }),
  ).toBeInTheDocument();
});

test("연결 중과 첫 행을 기다리는 동안 진행 막대가 있다", () => {
  openProjectWith([connection("local")]);
  const id = tabWith("local");
  render(<Toolbar onAddConnection={vi.fn()} />);
  expect(progress()).toBeNull();

  setRun(id, { status: "connecting" });
  expect(progress()).toHaveAttribute("aria-hidden", "true");

  setRun(id, { status: "running", result: emptyResult("SELECT 1", ORIGIN, 0) });
  expect(progress()).not.toBeNull();

  setRun(id, {
    status: "running",
    result: {
      ...emptyResult("SELECT 1", ORIGIN, 0),
      columns: ["a"],
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
  render(<Toolbar onAddConnection={vi.fn()} />);

  expect(runButton("Run statement")).toHaveStyle({ width: "200px" });
  act(() => useEditorStatus.setState({ tabId: id, hasSelection: true }));
  expect(runButton("Run selection")).toHaveStyle({ width: "200px" });
  expect(runButton("Choose what to run")).toHaveStyle({ width: "26px" });

  setRun(id, { status: "connecting" });
  expect(runButton("Cancel")).toHaveStyle({ width: "227px" });
});
