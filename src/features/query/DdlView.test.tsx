import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/clipboard");
vi.mock("../workspace/commands", () => ({
  runAgain: vi.fn(),
  cancelRun: vi.fn(),
  retryRun: vi.fn(),
  retryTunnel: vi.fn(),
}));

import { copyText } from "../../shared/api/clipboard";
import { click } from "../../test/click";
import {
  connection,
  openProjectWith,
  resultColumns,
} from "../../test/fixtures";
import { resetStores } from "../../test/resetStores";
import { stubLayout } from "../../test/layout";
import { documentState } from "../editor/documents";
import { useTabs } from "../editor/tabsStore";
import { useDdl } from "./ddlStore";
import { DdlView } from "./DdlView";
import { ResultPane } from "./ResultPane";
import { emptyResult } from "./runReducer";
import { useRuns } from "./runsStore";

const TEXT = "CREATE TABLE public.users (\n  id bigint NOT NULL\n);";

beforeEach(async () => {
  stubLayout({ width: 800, height: 400 });
  await resetStores();
  vi.resetAllMocks();
  vi.mocked(copyText).mockResolvedValue(undefined);
  openProjectWith([connection("local"), connection("other")]);
});

test("draws_the_tab_and_the_colored_text", () => {
  render(
    <DdlView
      tabId="t"
      view={{ name: "public.users", status: "ready", text: TEXT }}
    />,
  );

  expect(
    screen.getByRole("tab", { name: "DDL public.users" }),
  ).toBeInTheDocument();
  const pre = screen.getByTestId("ddl-text");
  expect(pre.textContent).toBe(TEXT);
  expect(pre.className).toContain("bg-bg-1");
  expect(screen.getByText("CREATE")).toHaveClass("text-syntax-keyword");
});

test("loading_and_failed_show_a_message_and_disable_the_actions", () => {
  const { rerender } = render(
    <DdlView tabId="t" view={{ name: "public.users", status: "loading" }} />,
  );
  expect(screen.getByText("Loading DDL…")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();

  rerender(
    <DdlView
      tabId="t"
      view={{ name: "public.users", status: "failed", message: "boom" }}
    />,
  );
  expect(screen.getByText("boom")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Open in new tab" }),
  ).toBeDisabled();
});

test("copy_shows_a_toast", async () => {
  render(
    <DdlView
      tabId="t"
      view={{ name: "public.users", status: "ready", text: TEXT }}
    />,
  );

  await click(screen.getByRole("button", { name: "Copy" }));

  expect(copyText).toHaveBeenCalledWith(TEXT);
  expect(screen.getByText("Copied DDL")).toBeInTheDocument();
});

test("a_failed_copy_shows_no_toast", async () => {
  vi.mocked(copyText).mockRejectedValue(new Error("denied"));
  render(
    <DdlView
      tabId="t"
      view={{ name: "public.users", status: "ready", text: TEXT }}
    />,
  );

  await click(screen.getByRole("button", { name: "Copy" }));

  expect(screen.queryByText("Copied DDL")).toBeNull();
});

test("open_in_new_tab_uses_the_same_connection", async () => {
  const id = useTabs.getState().newTab();
  useTabs.getState().setConnection(id, "other");
  render(
    <DdlView
      tabId={id}
      view={{ name: "public.users", status: "ready", text: TEXT }}
    />,
  );

  await click(screen.getByRole("button", { name: "Open in new tab" }));

  const { tabs, activeId } = useTabs.getState();
  expect(tabs).toHaveLength(2);
  expect(activeId).not.toBe(id);
  const opened = tabs.find((tab) => tab.id === activeId)!;
  expect(opened.connection).toBe("other");
  expect(documentState(opened.id)?.doc.toString()).toBe(TEXT);
});

test("close_returns_to_the_result", async () => {
  const id = useTabs.getState().newTab();
  useTabs.getState().setConnection(id, "local");
  act(() => {
    useRuns.setState({
      runs: {
        [id]: {
          status: "finished",
          result: {
            ...emptyResult(
              {
                sql: "SELECT 1 AS n",
                from: 0,
                origin: { line: 1, column: 1 },
              },
              "run-0",
              0,
            ),
            columns: resultColumns("n"),
            rows: [["1"]],
          },
          outcome: { outcome: "completed", rows: 1 },
        },
      },
    });
    useDdl.setState({
      views: {
        [id]: { name: "public.users", status: "ready", text: TEXT },
      },
    });
  });
  render(<ResultPane tabId={id} hasConnection connection="local" />);

  expect(screen.getByTestId("ddl-text")).toBeInTheDocument();
  expect(screen.queryByRole("grid")).toBeNull();

  await click(screen.getByRole("button", { name: "Close" }));

  expect(screen.queryByTestId("ddl-text")).toBeNull();
  expect(screen.getByRole("grid")).toBeInTheDocument();
  expect(useDdl.getState().views[id]).toBeUndefined();
});
