import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("./shared/api/commands");
vi.mock("./shared/api/events", () => ({
  onTunnelEvent: vi.fn(() => Promise.resolve(() => {})),
  onQuitRequested: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("./shared/api/dialog");
vi.mock("./shared/api/path");

import App from "./App";
import { resetStores } from "./test/resetStores";
import {
  listSqlFiles,
  loadSettings,
  openProject,
  recentProjects,
} from "./shared/api/commands";
import { homeDir } from "./shared/api/path";
import { ask } from "./shared/ui/dialogs";
import { useSettings } from "./features/settings/settingsStore";
import { deferred } from "./test/deferred";
import { settingsFixture } from "./test/fixtures";
import type { Settings } from "./shared/api/types";

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  vi.mocked(homeDir).mockResolvedValue("/Users/jo");
  vi.mocked(loadSettings).mockResolvedValue(settingsFixture());
  vi.mocked(recentProjects).mockResolvedValue([]);
});

/** 가장 최근 프로젝트가 `/p`다. */
function recentIsP() {
  vi.mocked(recentProjects).mockResolvedValue([
    { dir: "/p", name: "demo", openedAt: 1_700_000_000 },
  ]);
}

test("프로젝트가 열리면 작업 화면을 보여 준다", async () => {
  recentIsP();
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

test("waits for settings before the project", async () => {
  recentIsP();
  vi.mocked(openProject).mockRejectedValue(new Error("not reached"));
  const settings = deferred<Settings>();
  vi.mocked(loadSettings).mockReturnValue(settings.promise);

  render(<App />);

  await act(() => Promise.resolve());
  expect(openProject).not.toHaveBeenCalled();
  expect(screen.queryByRole("button")).toBeNull();

  vi.mocked(openProject).mockResolvedValue({
    name: "demo",
    dir: "/p",
    connections: [],
  });
  vi.mocked(listSqlFiles).mockResolvedValue([]);
  await act(async () => settings.resolve(settingsFixture({ language: "ko" })));

  expect(
    await screen.findByRole("button", { name: "프로젝트 바꾸기" }),
  ).toHaveTextContent("demo");
  expect(openProject).toHaveBeenCalledWith("/p");
});

test("shows settings errors in a dialog", async () => {
  vi.mocked(loadSettings).mockResolvedValue(
    settingsFixture({
      error: "config.toml: TOML parse error at line 1\n  |\n1 | x =\n  |    ^",
      storeError: "database is locked",
    }),
  );

  render(<App />);

  const first = await screen.findByRole("alertdialog", {
    name: "Settings were not applied",
  });
  expect(first).toHaveTextContent("TOML parse error at line 1");
  expect(screen.getByText(/TOML parse error/)).toHaveClass(
    "whitespace-pre-wrap",
  );
  fireEvent.click(screen.getByRole("button", { name: "OK" }));

  const second = await screen.findByRole("alertdialog", {
    name: "Recent projects and unsaved tabs are not kept",
  });
  expect(second).toHaveTextContent("database is locked");
  expect(useSettings.getState().errors).not.toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "OK" }));

  await vi.waitFor(() => expect(useSettings.getState().errors).toEqual([]));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Open Project…" }),
  ).toBeInTheDocument();
});
