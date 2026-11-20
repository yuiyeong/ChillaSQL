import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { click } from "../../test/click";
import { connection, openProjectWith } from "../../test/fixtures";
import { resetStores } from "../../test/resetStores";

vi.mock("../../shared/api/commands");

import { searchHistory } from "../../shared/api/commands";
import { CommandError } from "../../shared/api/errors";
import type { HistoryEntry } from "../../shared/api/types";
import { documentState } from "../editor/documents";
import { useTabs } from "../editor/tabsStore";
import { useHistory } from "./historyStore";
import { HistoryView } from "./HistoryView";

const NOW = new Date(2026, 10, 20, 12, 0);

function entry(
  id: number,
  sql: string,
  connectionName: string,
  at: Date,
  elapsedMicros = 38_000,
): HistoryEntry {
  return {
    id,
    connection: connectionName,
    sql,
    executedAt: at.getTime(),
    elapsedMicros,
  };
}

const entries = [
  entry(4, "SELECT 1", "local", new Date(2026, 10, 20, 9, 41)),
  entry(3, "SELECT 2", "staging", new Date(2026, 10, 20, 9, 12), 9_000),
  entry(2, "SELECT 3", "gone", new Date(2026, 10, 19, 17, 3), 1_200_000),
  entry(1, "SELECT 4", "local", new Date(2026, 10, 9, 8, 0)),
];

async function renderView() {
  await act(async () => {
    render(<HistoryView />);
  });
}

const items = () => screen.getAllByRole("option");

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  await resetStores();
  vi.resetAllMocks();
  openProjectWith([
    connection("local", { color: "green" }),
    connection("staging", { color: "yellow" }),
  ]);
  vi.mocked(searchHistory).mockResolvedValue(entries);
});

afterEach(() => {
  vi.useRealTimers();
  useHistory.getState().reset();
});

test("groups_by_day", async () => {
  await renderView();

  const labels = screen
    .getAllByRole("group")
    .map((group) => group.getAttribute("aria-label"));
  expect(labels).toEqual(["Today", "Yesterday", "Nov 9"]);
  expect(items()).toHaveLength(4);
  expect(searchHistory).toHaveBeenCalledWith("/p", "");
  // SQL, 접속, 시각, 소요 시간
  expect(items()[0]).toHaveTextContent("SELECT 1");
  expect(items()[0]).toHaveTextContent("local · 09:41 · 38 ms");
  expect(items()[2]).toHaveTextContent("gone · 17:03 · 1.20 s");
});

test("shows_connection_dot_only_for_known_connections", async () => {
  await renderView();

  const dots = items().map((item) => within(item).queryByTestId("history-dot"));
  expect(dots[0]).not.toBeNull();
  expect(dots[1]).not.toBeNull();
  expect(dots[2]).toBeNull();
  expect(dots[0]?.style.background).toBe("var(--color-conn-green)");
  expect(dots[1]?.style.background).toBe("var(--color-conn-yellow)");
});

test("the_first_entry_is_selected", async () => {
  await renderView();

  expect(items()[0]).toHaveAttribute("aria-selected", "true");
  expect(items()[1]).toHaveAttribute("aria-selected", "false");
});

test("enter_opens_the_selected_entry_in_a_new_tab", async () => {
  await renderView();
  const search = screen.getByRole("searchbox", { name: "Search history" });

  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });

  const { tabs, activeId } = useTabs.getState();
  expect(tabs).toHaveLength(1);
  expect(activeId).toBe(tabs[0].id);
  expect(documentState(tabs[0].id).doc.toString()).toBe("SELECT 2");
  expect(tabs[0].connection).toBe("staging");
});

test("double_click_opens", async () => {
  await renderView();

  await act(async () => {
    fireEvent.doubleClick(items()[3]);
  });

  const [tab] = useTabs.getState().tabs;
  expect(documentState(tab.id).doc.toString()).toBe("SELECT 4");
  expect(tab.connection).toBe("local");
});

test("a_click_only_selects", async () => {
  await renderView();

  await click(items()[1]);

  expect(items()[1]).toHaveAttribute("aria-selected", "true");
  expect(useTabs.getState().tabs).toHaveLength(0);
});

test("unknown_connection_keeps_the_default", async () => {
  act(() => {
    const id = useTabs.getState().newTab();
    useTabs.getState().setConnection(id, "staging");
  });
  await renderView();

  await act(async () => {
    fireEvent.doubleClick(items()[2]);
  });

  const { tabs } = useTabs.getState();
  expect(tabs).toHaveLength(2);
  expect(documentState(tabs[1].id).doc.toString()).toBe("SELECT 3");
  expect(tabs[1].connection).toBe("staging");
});

test("arrow_keys_move_selection_from_the_search_field", async () => {
  await renderView();
  const search = screen.getByRole("searchbox", { name: "Search history" });

  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(items()[2]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(search, { key: "ArrowUp" });
  expect(items()[1]).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(search, { key: "ArrowUp" });
  fireEvent.keyDown(search, { key: "ArrowUp" });
  expect(items()[0]).toHaveAttribute("aria-selected", "true");
});

test("typing_searches_after_the_wait", async () => {
  await renderView();
  vi.mocked(searchHistory).mockClear();

  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "users" },
  });
  await vi.advanceTimersByTimeAsync(149);
  expect(searchHistory).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);

  expect(searchHistory).toHaveBeenCalledWith("/p", "users");
});

test("store_unavailable_shows_the_error", async () => {
  vi.mocked(searchHistory).mockRejectedValue(
    new CommandError("store_unavailable", "no store"),
  );
  await renderView();

  expect(screen.getByRole("alert")).toHaveTextContent(
    useHistory.getState().error ?? "missing",
  );
  expect(useHistory.getState().error).not.toBeNull();
  expect(screen.queryAllByRole("option")).toHaveLength(0);
});

test("empty_and_no_match_messages", async () => {
  vi.mocked(searchHistory).mockResolvedValue([]);
  await renderView();
  expect(screen.getByText("Queries you run appear here")).toBeInTheDocument();

  act(() => useHistory.setState({ query: "zzz" }));
  expect(screen.getByText("No queries match")).toBeInTheDocument();
});

test("the_footer_names_the_enter_key", async () => {
  await renderView();

  expect(screen.getByText("Open in editor")).toBeInTheDocument();
});

test("a_recorded_query_appears_while_the_view_is_open", async () => {
  await renderView();
  vi.mocked(searchHistory).mockResolvedValue([
    entry(5, "SELECT 5", "local", new Date(2026, 10, 20, 11, 59)),
    ...entries,
  ]);

  await act(async () => {
    await useHistory.getState().record({
      connection: "local",
      sql: "SELECT 5",
      executedAt: NOW.getTime(),
      elapsedMicros: 1,
    });
  });

  expect(items()[0]).toHaveTextContent("SELECT 5");
});
