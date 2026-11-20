import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { click } from "../../test/click";
import { resetStores } from "../../test/resetStores";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/events", () => ({
  onTunnelEvent: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../../shared/api/dialog");
vi.mock("../../shared/api/path");

import {
  createProject,
  listSqlFiles,
  loadWorkspace,
  openProject,
  recentProjects,
} from "../../shared/api/commands";
import { pickDirectory } from "../../shared/api/dialog";
import { CommandError } from "../../shared/api/errors";
import { homeDir } from "../../shared/api/path";
import type { RecentProject } from "../../shared/api/types";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "./projectStore";
import { ProjectGate } from "./ProjectGate";

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  vi.mocked(listSqlFiles).mockResolvedValue([]);
  vi.mocked(recentProjects).mockResolvedValue([]);
  vi.mocked(homeDir).mockResolvedValue("/Users/jo");
});

afterEach(() => {
  vi.useRealTimers();
});

/** 가장 최근 프로젝트를 `dir`로 두고 Rust가 주는 목록을 만든다. */
function recents(...dirs: string[]): RecentProject[] {
  return dirs.map((dir, index) => ({
    dir,
    name: dir.split("/").pop() ?? dir,
    openedAt: 1_700_000_000 - index,
  }));
}

function renderGate() {
  return render(
    <ProjectGate>
      <p>작업 화면</p>
    </ProjectGate>,
  );
}

test("프로젝트가 없으면 여는 버튼을 보여 주고 고른 디렉토리를 연다", async () => {
  vi.mocked(openProject).mockResolvedValue({
    name: "demo",
    dir: "/p",
    connections: [],
  });
  renderGate();

  const button = await screen.findByRole("button", { name: "Open Project…" });
  expect(screen.queryByText("작업 화면")).not.toBeInTheDocument();

  vi.mocked(pickDirectory).mockResolvedValueOnce(null);
  await click(button);
  expect(pickDirectory).toHaveBeenCalledTimes(1);
  expect(openProject).not.toHaveBeenCalled();
  expect(screen.queryByText("작업 화면")).not.toBeInTheDocument();

  vi.mocked(pickDirectory).mockResolvedValueOnce("/p");
  await click(button);
  expect(await screen.findByText("작업 화면")).toBeInTheDocument();
  expect(openProject).toHaveBeenCalledWith("/p");
  await waitFor(() => expect(loadWorkspace).toHaveBeenCalledWith("/p"));
});

test("열지 못하면 error를 보여 준다", async () => {
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_invalid", "chilla.toml이 올바르지 않습니다"),
  );
  vi.mocked(pickDirectory).mockResolvedValue("/bad");
  renderGate();

  await click(await screen.findByRole("button", { name: "Open Project…" }));

  expect(
    await screen.findByText("chilla.toml이 올바르지 않습니다"),
  ).toBeInTheDocument();
  expect(screen.queryByText("작업 화면")).not.toBeInTheDocument();
});

test("chilla.toml이 없는 디렉토리는 만들 수 있다", async () => {
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );
  vi.mocked(createProject).mockResolvedValue({
    name: "new",
    dir: "/new",
    connections: [],
  });
  vi.mocked(pickDirectory).mockResolvedValue("/new");
  renderGate();

  await click(await screen.findByRole("button", { name: "Open Project…" }));

  expect(await screen.findByRole("alertdialog")).toHaveTextContent(
    "/new has no chilla.toml",
  );
  expect(
    screen.getByRole("button", { name: "Choose another folder…" }),
  ).toBeInTheDocument();

  await click(screen.getByRole("button", { name: "Create chilla.toml" }));

  expect(await screen.findByText("작업 화면")).toBeInTheDocument();
  expect(createProject).toHaveBeenCalledWith("/new");
});

test("다른 디렉토리 열기는 고른 디렉토리를 연다", async () => {
  vi.mocked(openProject)
    .mockRejectedValueOnce(new CommandError("project_not_found", "없음"))
    .mockResolvedValueOnce({ name: "other", dir: "/other", connections: [] });
  vi.mocked(pickDirectory)
    .mockResolvedValueOnce("/new")
    .mockResolvedValueOnce("/other");
  renderGate();
  await click(await screen.findByRole("button", { name: "Open Project…" }));

  await click(
    await screen.findByRole("button", { name: "Choose another folder…" }),
  );

  expect(await screen.findByText("작업 화면")).toBeInTheDocument();
  expect(openProject).toHaveBeenLastCalledWith("/other");
});

test("booting 동안에는 children을 그리지 않는다", async () => {
  vi.mocked(recentProjects).mockResolvedValue(recents("/p"));
  vi.mocked(openProject).mockReturnValue(new Promise(() => {}));
  renderGate();

  await waitFor(() => expect(openProject).toHaveBeenCalledWith("/p"));
  expect(useProject.getState().status).toBe("booting");
  expect(screen.queryByText("작업 화면")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Open Project…" }),
  ).not.toBeInTheDocument();
});

test("mount 때 boot를 한 번만 부른다", async () => {
  vi.mocked(recentProjects).mockResolvedValue(recents("/p"));
  vi.mocked(openProject).mockResolvedValue({
    name: "demo",
    dir: "/p",
    connections: [],
  });

  // StrictMode는 effect를 두 번 돌린다.
  const { rerender } = render(
    <StrictMode>
      <ProjectGate>
        <p>작업 화면</p>
      </ProjectGate>
    </StrictMode>,
  );
  rerender(
    <StrictMode>
      <ProjectGate>
        <p>작업 화면</p>
      </ProjectGate>
    </StrictMode>,
  );

  expect(await screen.findByText("작업 화면")).toBeInTheDocument();
  expect(openProject).toHaveBeenCalledTimes(1);
});

test("디렉토리 고르기가 실패하면 오류를 보여 준다", async () => {
  vi.mocked(pickDirectory).mockRejectedValue(new Error("창을 열 수 없습니다"));
  renderGate();

  await click(await screen.findByRole("button", { name: "Open Project…" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "창을 열 수 없습니다",
  );
  expect(openProject).not.toHaveBeenCalled();
});

test("the_first_opened_project_restores_its_tabs_once", async () => {
  vi.mocked(recentProjects).mockResolvedValue(recents("/p"));
  vi.mocked(openProject).mockResolvedValue({
    name: "demo",
    dir: "/p",
    connections: [],
  });
  vi.mocked(loadWorkspace).mockResolvedValue(
    JSON.stringify({
      version: 1,
      active: 0,
      tabs: [
        {
          title: "Query 2",
          path: null,
          stamp: null,
          connection: null,
          mode: "auto",
          text: "SELECT 2",
        },
      ],
    }),
  );

  render(
    <StrictMode>
      <ProjectGate>
        <p>작업 화면</p>
      </ProjectGate>
    </StrictMode>,
  );

  await waitFor(() =>
    expect(useTabs.getState().tabs.map((tab) => tab.title)).toEqual([
      "Query 2",
    ]),
  );
  expect(loadWorkspace).toHaveBeenCalledTimes(1);
  expect(loadWorkspace).toHaveBeenCalledWith("/p");
});

const home = "/Users/jo";

/** 목록의 첫 프로젝트가 열리지 않아 Welcome이 보이게 한다. */
async function renderWelcome(list: RecentProject[]) {
  vi.mocked(recentProjects).mockResolvedValue(list);
  vi.mocked(openProject).mockRejectedValueOnce(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );
  renderGate();
  await screen.findByRole("heading", { name: "Recent Projects" });
}

test("welcome_lists_recent_projects", async () => {
  // 지역 시각 2026-11-20 14:00
  const now = new Date(2026, 10, 20, 14, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const at = (date: Date) => Math.floor(date.getTime() / 1000);
  await renderWelcome([
    {
      dir: `${home}/work/chilla-demo`,
      name: "chilla-demo",
      openedAt: at(new Date(now.getTime() - 5_000)),
    },
    {
      dir: `${home}/work/billing`,
      name: "billing",
      openedAt: at(new Date(2026, 10, 19, 9)),
    },
    {
      dir: `${home}/work/billing-migration`,
      name: "billing-migration",
      openedAt: at(new Date(2026, 10, 9, 9)),
    },
    {
      dir: `${home}/Desktop/sandbox`,
      name: "sandbox",
      openedAt: at(new Date(2026, 10, 20, 8)),
    },
  ]);

  // 열지 못한 이유와 Open Project…
  expect(screen.getByRole("alert")).toHaveTextContent("chilla.toml이 없습니다");
  expect(screen.getByRole("button", { name: "Open Project…" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Open Project…" })).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+O",
  );

  const items = screen.getAllByRole("button", { name: /\/work\/|sandbox/ });
  expect(items.map((item) => item.textContent)).toEqual([
    "CDchilla-demo~/work/chilla-demoJust now",
    "BIbilling~/work/billingYesterday",
    "BMbilling-migration~/work/billing-migrationNov 9",
    "SAsandbox~/Desktop/sandboxToday",
  ]);
});

test("welcome_without_recents_has_only_the_open_button", async () => {
  renderGate();

  await screen.findByRole("button", { name: "Open Project…" });
  expect(
    screen.queryByRole("heading", { name: "Recent Projects" }),
  ).not.toBeInTheDocument();
});

test("clicking_a_recent_opens_it", async () => {
  await renderWelcome(
    recents(`${home}/work/chilla-demo`, `${home}/work/billing`),
  );
  vi.mocked(openProject).mockResolvedValue({
    name: "billing",
    dir: `${home}/work/billing`,
    connections: [],
  });

  await click(screen.getByRole("button", { name: /billing/ }));

  expect(await screen.findByText("작업 화면")).toBeInTheDocument();
  expect(openProject).toHaveBeenLastCalledWith(`${home}/work/billing`);
  expect(pickDirectory).not.toHaveBeenCalled();
});

test("a_missing_recent_shows_an_error_and_stays_in_the_list", async () => {
  await renderWelcome(recents(`${home}/work/gone`, `${home}/work/billing`));
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );

  await click(screen.getByRole("button", { name: /gone/ }));

  // 만들지 묻는 sheet가 아니라 오류다.
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("chilla.toml이 없습니다");
  expect(screen.getByRole("button", { name: /gone/ })).toBeInTheDocument();
});

test("missing_chilla_toml_asks_in_a_sheet", async () => {
  await renderWelcome(recents(`${home}/work/billing`));
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );
  vi.mocked(pickDirectory).mockResolvedValue(`${home}/work/new-app`);

  await click(screen.getByRole("button", { name: "Open Project…" }));

  const sheet = await screen.findByRole("alertdialog");
  expect(sheet).toHaveTextContent("~/work/new-app has no chilla.toml");
  expect(sheet).toHaveTextContent(
    "Create a chilla.toml with only [project] and open the folder as a project. Add connections after it opens.",
  );
  expect(
    within(sheet).getByRole("button", { name: "Choose another folder…" }),
  ).toBeVisible();
  expect(
    within(sheet).getByRole("button", { name: "Create chilla.toml" }),
  ).toHaveFocus();
  // 처음 오류는 sheet에 보이지 않는다.
  expect(within(sheet).queryByRole("alert")).not.toBeInTheDocument();

  await click(within(sheet).getByRole("button", { name: "Cancel" }));

  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(createProject).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Open Project…" })).toBeVisible();
  expect(useProject.getState().status).toBe("none");
});

test("escape_closes_the_sheet", async () => {
  await renderWelcome(recents(`${home}/work/billing`));
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );
  vi.mocked(pickDirectory).mockResolvedValue("/new");
  await click(screen.getByRole("button", { name: "Open Project…" }));
  await screen.findByRole("alertdialog");

  fireEvent.keyDown(
    screen.getByRole("button", { name: "Create chilla.toml" }),
    {
      code: "Escape",
    },
  );

  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

test("a_failed_create_shows_its_error_in_the_sheet", async () => {
  await renderWelcome(recents(`${home}/work/billing`));
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );
  vi.mocked(createProject).mockRejectedValue(
    new CommandError("io", "쓸 수 없습니다"),
  );
  vi.mocked(pickDirectory).mockResolvedValue("/new");
  await click(screen.getByRole("button", { name: "Open Project…" }));
  const sheet = await screen.findByRole("alertdialog");

  await click(
    within(sheet).getByRole("button", { name: "Create chilla.toml" }),
  );

  expect(await within(sheet).findByRole("alert")).toHaveTextContent(
    "쓸 수 없습니다",
  );
});

test("cmd_o_on_welcome_opens_the_folder_picker", async () => {
  await renderWelcome(recents(`${home}/work/billing`));
  vi.mocked(pickDirectory).mockResolvedValue(null);

  const event = new KeyboardEvent("keydown", {
    code: "KeyO",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  await waitFor(() => expect(pickDirectory).toHaveBeenCalledTimes(1));
});
