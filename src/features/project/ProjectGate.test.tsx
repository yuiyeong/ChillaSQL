import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { click } from "../../test/click";
import { resetStores } from "../../test/resetStores";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/events", () => ({
  onTunnelEvent: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("../../shared/api/dialog");

import {
  createProject,
  listSqlFiles,
  loadWorkspace,
  openProject,
} from "../../shared/api/commands";
import { pickDirectory } from "../../shared/api/dialog";
import { CommandError } from "../../shared/api/errors";
import { useTabs } from "../editor/tabsStore";
import { LAST_PROJECT_KEY, useProject } from "./projectStore";
import { ProjectGate } from "./ProjectGate";

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(listSqlFiles).mockResolvedValue([]);
});

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

  expect(
    await screen.findByText("/new has no chilla.toml"),
  ).toBeInTheDocument();
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
  localStorage.setItem(LAST_PROJECT_KEY, "/p");
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
  localStorage.setItem(LAST_PROJECT_KEY, "/p");
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
  localStorage.setItem(LAST_PROJECT_KEY, "/p");
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
