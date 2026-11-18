import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("./shared/api/commands");
vi.mock("./shared/api/dialog");

import App from "./App";
import { LAST_PROJECT_KEY, useProject } from "./features/project/projectStore";
import { listSqlFiles, openProject } from "./shared/api/commands";

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  useProject.setState(useProject.getInitialState(), true);
});

test("프로젝트가 열리면 작업 화면을 보여 준다", async () => {
  localStorage.setItem(LAST_PROJECT_KEY, "/p");
  vi.mocked(openProject).mockResolvedValue({
    name: "demo",
    dir: "/p",
    connections: [],
  });
  vi.mocked(listSqlFiles).mockResolvedValue([]);

  render(<App />);

  expect(await screen.findAllByText("New tab")).not.toHaveLength(0);
  expect(screen.getByRole("heading", { name: "demo" })).toBeInTheDocument();
});

test("프로젝트가 없으면 프로젝트 열기 버튼을 보여 준다", async () => {
  render(<App />);

  expect(
    await screen.findByRole("button", { name: "Open Project…" }),
  ).toBeInTheDocument();
});
