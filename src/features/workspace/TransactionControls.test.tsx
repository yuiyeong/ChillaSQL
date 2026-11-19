import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { click } from "../../test/click";
import { resetStores } from "../../test/resetStores";

vi.mock("./commands", () => ({ execute: vi.fn() }));
vi.mock("./transactionPrompts", () => ({ switchMode: vi.fn() }));

import { emptyResult, type RunState } from "../query/runReducer";
import { useRuns } from "../query/runsStore";
import type { TxInfo } from "../query/transaction";
import { execute } from "./commands";
import { shortcutKeys } from "./shortcuts";
import { switchMode } from "./transactionPrompts";
import { TransactionControls } from "./TransactionControls";

const NOW = 1_000_000_000;
const ORIGIN = { line: 1, column: 1 };

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

/** `elapsedSecs`초 전에 열린 트랜잭션 */
function open(
  statements: number,
  elapsedSecs: number,
  status: TxInfo["status"] = "open",
) {
  act(() =>
    useRuns.setState({
      transactions: {
        t1: { status, statements, openedAt: Date.now() - elapsedSecs * 1000 },
      },
    }),
  );
}

function setRun(run: RunState) {
  act(() => useRuns.setState({ runs: { t1: run } }));
}

/** 상태 문구. 시간이 D2Coding span으로 나뉘므로 그 span의 textContent로 찾는다. */
const status = (text: string) =>
  screen.getByText(
    (_, el) => el?.tagName === "SPAN" && el.textContent === text,
  );
const radiogroup = () =>
  screen.getByRole("radiogroup", { name: "Transaction mode" });
const radio = (name: string) =>
  within(radiogroup()).getByRole("radio", { name });
const commit = () => screen.getByRole("button", { name: "Commit" });
const rollback = () => screen.getByRole("button", { name: "Rollback" });

test("shows_the_mode_radiogroup", async () => {
  render(<TransactionControls tabId="t1" />);

  expect(radio("Auto")).toHaveAttribute("aria-checked", "true");
  expect(radio("Manual")).toHaveAttribute("aria-checked", "false");

  await click(radio("Manual"));
  expect(switchMode).toHaveBeenCalledWith("t1", "manual");
});

test("the checked radio follows the tab mode", () => {
  act(() => useRuns.setState({ modes: { t1: "manual" } }));
  render(<TransactionControls tabId="t1" />);

  expect(radio("Auto")).toHaveAttribute("aria-checked", "false");
  expect(radio("Manual")).toHaveAttribute("aria-checked", "true");
});

test("shows_status_and_buttons_only_when_open", () => {
  render(<TransactionControls tabId="t1" />);
  expect(screen.queryByText(/statement/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Commit" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Rollback" })).toBeNull();

  open(2, 192);
  expect(status("Open · 2 statements · 3:12")).toBeInTheDocument();
  const buttons = screen.getAllByRole("button").map((b) => b.textContent);
  expect(buttons.indexOf("Rollback")).toBeLessThan(buttons.indexOf("Commit"));
  expect(commit()).toBeEnabled();
  expect(rollback()).toBeEnabled();
});

test("a single statement is singular", () => {
  render(<TransactionControls tabId="t1" />);
  open(1, 5);
  expect(status("Open · 1 statement · 0:05")).toBeInTheDocument();
});

test("auto_with_manual_begin_says_so", () => {
  render(<TransactionControls tabId="t1" />);
  open(0, 42);

  expect(radio("Auto")).toHaveAttribute("aria-checked", "true");
  expect(status("Open · manual BEGIN · 0:42")).toBeInTheDocument();
});

test("the elapsed time ticks every second", () => {
  render(<TransactionControls tabId="t1" />);
  open(2, 192);

  act(() => vi.advanceTimersByTime(3000));
  expect(status("Open · 2 statements · 3:15")).toBeInTheDocument();
});

test("a transaction opened after mounting starts from its own time", () => {
  render(<TransactionControls tabId="t1" />);
  act(() => vi.advanceTimersByTime(3_600_000));
  open(1, 7);

  expect(status("Open · 1 statement · 0:07")).toBeInTheDocument();
});

test("failed_disables_commit", () => {
  render(<TransactionControls tabId="t1" />);
  open(2, 192, "failed");

  expect(status("Failed · 2 statements · 3:12")).toBeInTheDocument();
  expect(commit()).toBeDisabled();
  expect(rollback()).toBeEnabled();
});

test("disabled_while_reading", () => {
  render(<TransactionControls tabId="t1" />);
  open(2, 10);
  setRun({
    status: "running",
    result: emptyResult("SELECT 1", ORIGIN, NOW),
  });

  expect(commit()).toBeDisabled();
  expect(rollback()).toBeDisabled();
  expect(radio("Auto")).toBeDisabled();
  expect(radio("Manual")).toBeDisabled();

  // 행을 받았고 다음 batch를 요청할 수 있으면 다시 누를 수 있다.
  setRun({
    status: "running",
    result: { ...emptyResult("SELECT 1", ORIGIN, NOW), fetch: "ready" },
  });
  expect(commit()).toBeEnabled();
  expect(radio("Manual")).toBeEnabled();
});

test("disabled_while_connecting", () => {
  render(<TransactionControls tabId="t1" />);
  open(2, 10);
  setRun({ status: "connecting" });

  expect(commit()).toBeDisabled();
  expect(radio("Manual")).toBeDisabled();
});

test("disabled_while_ending", () => {
  render(<TransactionControls tabId="t1" />);
  open(2, 10);
  act(() => useRuns.setState({ ending: { t1: true } }));

  expect(commit()).toBeDisabled();
  expect(rollback()).toBeDisabled();
  expect(radio("Auto")).toBeDisabled();
  expect(radio("Manual")).toBeDisabled();
});

test("the radiogroup is disabled without a tab", () => {
  render(<TransactionControls tabId={null} />);

  expect(radio("Auto")).toBeDisabled();
  expect(radio("Manual")).toBeDisabled();
});

test("the buttons run the commands and advertise their shortcuts", async () => {
  render(<TransactionControls tabId="t1" />);
  open(2, 10);

  expect(commit()).toHaveAttribute("aria-keyshortcuts", shortcutKeys("commit"));
  expect(rollback()).toHaveAttribute(
    "aria-keyshortcuts",
    shortcutKeys("rollback"),
  );
  expect(shortcutKeys("commit")).toBe("Alt+Shift+Meta+Enter");

  await click(commit());
  expect(execute).toHaveBeenCalledWith("commit");
  await click(rollback());
  expect(execute).toHaveBeenCalledWith("rollback");
});
