import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { click } from "../../test/click";
import { resetStores } from "../../test/resetStores";

vi.mock("../workspace/commands", () => ({ switchProject: vi.fn() }));

import { switchProject } from "../workspace/commands";
import { ProjectMenu } from "./ProjectMenu";
import { useProject } from "./projectStore";

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  useProject.setState({
    status: "ready",
    project: {
      name: "chilla-demo",
      dir: "/Users/jo/work/chilla-demo",
      connections: [],
    },
    recent: [
      { dir: "/Users/jo/work/chilla-demo", name: "chilla-demo", openedAt: 3 },
      { dir: "/Users/jo/work/billing", name: "billing", openedAt: 2 },
      { dir: "/Users/jo/Desktop/sandbox", name: "sandbox", openedAt: 1 },
    ],
  });
});

function renderMenu(onClose = vi.fn()) {
  const anchor = createRef<HTMLButtonElement>();
  render(
    <>
      <button ref={anchor} type="button">
        chilla-demo
      </button>
      <ProjectMenu anchor={anchor} onClose={onClose} />
    </>,
  );
  return onClose;
}

test("menu_lists_other_recent_projects", () => {
  renderMenu();

  const menu = screen.getByRole("menu", { name: "Projects" });
  expect(menu).toHaveTextContent("Recent");
  const items = screen.getAllByRole("menuitem");
  // 지금 프로젝트는 머리의 button이고 목록에는 없다.
  expect(items.map((item) => item.textContent)).toEqual([
    "billing",
    "sandbox",
    "Open Project…⌘O",
  ]);
  expect(
    screen.getByRole("menuitem", { name: "Open Project…" }),
  ).toHaveAttribute("aria-keyshortcuts", "Meta+O");
});

test("menu_without_other_recents_has_only_open_project", () => {
  useProject.setState({ recent: [] });
  renderMenu();

  expect(screen.queryByText("Recent")).not.toBeInTheDocument();
  expect(screen.getAllByRole("menuitem")).toHaveLength(1);
});

test("choosing_one_switches_project", async () => {
  const onClose = renderMenu();

  await click(screen.getByRole("menuitem", { name: "sandbox" }));

  expect(switchProject).toHaveBeenCalledWith("/Users/jo/Desktop/sandbox");
  expect(onClose).toHaveBeenCalled();
});

test("open_project_item_opens_the_picker", async () => {
  const onClose = renderMenu();

  await click(screen.getByRole("menuitem", { name: "Open Project…" }));

  expect(switchProject).toHaveBeenCalledTimes(1);
  expect(switchProject).toHaveBeenCalledWith();
  expect(onClose).toHaveBeenCalled();
});
