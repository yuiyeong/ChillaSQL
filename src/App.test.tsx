import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("./shared/api/commands");
vi.mock("./shared/api/events", () => ({
  onTunnelEvent: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("./shared/api/dialog");
vi.mock("./shared/api/path");

import App from "./App";
import { resetStores } from "./test/resetStores";
import { LAST_PROJECT_KEY } from "./features/project/projectStore";
import { listSqlFiles, openProject } from "./shared/api/commands";
import { homeDir } from "./shared/api/path";
import { ask } from "./shared/ui/dialogs";

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  vi.mocked(homeDir).mockResolvedValue("/Users/jo");
  localStorage.clear();
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
  expect(
    screen.getByRole("button", { name: "Switch project" }),
  ).toHaveTextContent("demo");
});

test("프로젝트가 없으면 프로젝트 열기 버튼을 보여 준다", async () => {
  render(<App />);

  expect(
    await screen.findByRole("button", { name: "Open Project…" }),
  ).toBeInTheDocument();
});

test("프로젝트를 열기 전에도 확인 dialog를 그린다", async () => {
  render(<App />);

  act(() => {
    void ask({
      title: "Any question?",
      actions: [{ id: "cancel", label: "Cancel" }],
    });
  });

  expect(
    screen.getByRole("alertdialog", { name: "Any question?" }),
  ).toBeInTheDocument();
});
