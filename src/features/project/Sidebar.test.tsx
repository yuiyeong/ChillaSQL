import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { click } from "../../test/click";
import { connection, openProjectWith } from "../../test/fixtures";
import { resetStores } from "../../test/resetStores";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/dialog");
vi.mock("../../shared/api/path");

import { listSqlFiles } from "../../shared/api/commands";
import { homeDir } from "../../shared/api/path";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "./projectStore";
import { Sidebar } from "./Sidebar";

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  vi.mocked(homeDir).mockResolvedValue("/Users/jo");
  localStorage.clear();
  useProject.setState({
    status: "ready",
    project: {
      name: "chilla-demo",
      dir: "/Users/jo/work/chilla-demo",
      connections: [connection("local", { color: "green" })],
    },
    files: ["queries/users.sql", "queries/b.sql", "scratch.sql"],
  });
});

function handlers() {
  return {
    onOpenFile: vi.fn(),
    onAddConnection: vi.fn(),
    onEditConnection: vi.fn(),
    onSwitchProject: vi.fn(),
    onChooseConnection: vi.fn(),
  };
}

async function renderSidebar(h = handlers()) {
  await act(async () => {
    render(<Sidebar {...h} />);
  });
  return h;
}

test("프로젝트 버튼은 이니셜, 이름, 줄인 경로를 보여 주고 onSwitchProject를 부른다", async () => {
  const h = await renderSidebar();

  const button = screen.getByRole("button", { name: "Switch project" });
  expect(within(button).getByText("CD")).toBeInTheDocument();
  expect(within(button).getByText("chilla-demo")).toBeInTheDocument();
  expect(within(button).getByText("~/work/chilla-demo")).toBeInTheDocument();

  await click(button);
  expect(h.onSwitchProject).toHaveBeenCalledTimes(1);
});

test("프로젝트 button의 설명에 이름과 경로가 들어 있다", async () => {
  await renderSidebar();

  expect(
    screen.getByRole("button", { name: "Switch project" }),
  ).toHaveAccessibleDescription("chilla-demo ~/work/chilla-demo");
  expect(screen.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
});

test("home을 알기 전에는 전체 경로를 보여 준다", () => {
  vi.mocked(homeDir).mockReturnValue(new Promise(() => {}));
  render(<Sidebar {...handlers()} />);

  expect(screen.getByText("/Users/jo/work/chilla-demo")).toBeInTheDocument();
});

test("home을 알 수 없어도 전체 경로로 그린다", async () => {
  vi.mocked(homeDir).mockRejectedValue(new Error("no home"));
  await renderSidebar();

  expect(screen.getByText("/Users/jo/work/chilla-demo")).toBeInTheDocument();
});

test("접속을 나열하고 누르면 수정한다", async () => {
  const h = await renderSidebar();

  const region = screen.getByRole("region", { name: "Connections" });
  expect(within(region).getByText("localhost:5432/app")).toBeInTheDocument();

  await click(
    within(region).getByRole("button", { name: /^Edit connection local/ }),
  );
  expect(h.onEditConnection).toHaveBeenCalledWith("local");

  await click(within(region).getByRole("button", { name: "Add connection" }));
  expect(h.onAddConnection).toHaveBeenCalledTimes(1);
});

test("접속이 없으면 접속 추가만 보인다", async () => {
  openProjectWith([]);
  await renderSidebar();

  expect(screen.queryByRole("button", { name: /^Edit connection/ })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Add connection" }),
  ).toBeInTheDocument();
});

test("터널이 있는 접속은 Tunnel icon을 갖는다", async () => {
  useProject.setState({
    project: {
      name: "demo",
      dir: "/p",
      connections: [
        connection("direct"),
        connection("staging", { tunnel: "bastion" }),
      ],
    },
  });
  await renderSidebar();

  const direct = screen.getByRole("button", {
    name: /^Edit connection direct/,
  });
  const staging = screen.getByRole("button", {
    name: /^Edit connection staging/,
  });
  expect(within(direct).queryByLabelText("Tunnel")).toBeNull();
  expect(within(staging).getByLabelText("Tunnel")).toBeInTheDocument();
});

test("파일 tree의 folder를 누르면 접고 다시 누르면 편다", async () => {
  const h = await renderSidebar();

  expect(screen.getByRole("button", { name: "users.sql" })).toBeInTheDocument();
  const folder = screen.getByRole("button", { name: "queries" });
  expect(folder).toHaveAttribute("aria-expanded", "true");

  await click(folder);
  expect(screen.queryByRole("button", { name: "users.sql" })).toBeNull();
  expect(screen.getByRole("button", { name: "queries" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  await click(screen.getByRole("button", { name: "queries" }));
  await click(screen.getByRole("button", { name: "users.sql" }));
  expect(h.onOpenFile).toHaveBeenCalledWith("queries/users.sql");
});

test("folder가 먼저 오고 file은 깊이마다 들여쓴다", async () => {
  await renderSidebar();

  const names = screen
    .getAllByRole("button")
    .map((b) => b.textContent)
    .filter((text) =>
      ["queries", "b.sql", "users.sql", "scratch.sql"].includes(text),
    );
  expect(names).toEqual(["queries", "b.sql", "users.sql", "scratch.sql"]);
  expect(screen.getByRole("button", { name: "b.sql" }).style.paddingLeft).toBe(
    "24px",
  );
  expect(
    screen.getByRole("button", { name: "scratch.sql" }).style.paddingLeft,
  ).toBe("8px");
});

test("활성 탭의 파일을 강조하고 dirty 파일에 Unsaved를 붙인다", async () => {
  await act(async () => {
    vi.mocked(listSqlFiles).mockResolvedValue([]);
  });
  useTabs.setState({
    tabs: [
      {
        id: "t1",
        title: "b.sql",
        path: "queries/b.sql",
        stamp: "s",
        dirty: false,
        connection: null,
        mode: "auto",
      },
      {
        id: "t2",
        title: "users.sql",
        path: "queries/users.sql",
        stamp: "s",
        dirty: true,
        connection: null,
        mode: "auto",
      },
    ],
    activeId: "t1",
  });
  await renderSidebar();

  const active = screen.getByRole("button", { name: "b.sql" });
  const dirty = screen.getByRole("button", { name: /^users\.sql/ });
  expect(active).toHaveAttribute("aria-current", "true");
  expect(dirty).not.toHaveAttribute("aria-current");
  expect(within(active).queryByLabelText("Unsaved")).toBeNull();
  expect(within(dirty).getByLabelText("Unsaved")).toBeInTheDocument();
  expect(
    within(
      screen.getByRole("button", { name: "scratch.sql" }),
    ).queryByLabelText("Unsaved"),
  ).toBeNull();
});

test("새로고침은 파일 목록을 다시 읽는다", async () => {
  vi.mocked(listSqlFiles).mockResolvedValue(["fresh.sql"]);
  await renderSidebar();

  await click(screen.getByRole("button", { name: "Refresh file list" }));

  expect(listSqlFiles).toHaveBeenCalledTimes(1);
  expect(
    await screen.findByRole("button", { name: "fresh.sql" }),
  ).toBeInTheDocument();
});

test("schema_segment_switches_the_view", async () => {
  const h = await renderSidebar();

  const list = screen.getByRole("tablist", { name: "Sidebar view" });
  const files = within(list).getByRole("tab", { name: "Files" });
  const schema = within(list).getByRole("tab", { name: "Schema" });
  const history = within(list).getByRole("tab", { name: "History" });
  expect(files).toHaveAttribute("aria-selected", "true");
  expect(schema).toHaveAttribute("aria-selected", "false");
  expect(history).toHaveAttribute("aria-disabled", "true");

  await click(schema);
  expect(schema).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("region", { name: "SQL Files" })).toBeNull();
  // 활성 탭이 없으니 접속이 없다.
  await click(screen.getByRole("button", { name: "Choose connection" }));
  expect(h.onChooseConnection).toHaveBeenCalledTimes(1);

  await click(history);
  expect(schema).toHaveAttribute("aria-selected", "true");

  await click(files);
  expect(screen.getByRole("region", { name: "SQL Files" })).toBeInTheDocument();
});

test("위 38px은 창을 끄는 빈 자리다", async () => {
  await renderSidebar();

  expect(screen.getByTestId("sidebar-drag")).toHaveAttribute(
    "data-tauri-drag-region",
  );
});
