import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/ui/dialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/ui/dialogs")>()),
  ask: vi.fn(),
}));

import type { TxEnd } from "../../shared/api/types";
import { ask, type DialogSpec } from "../../shared/ui/dialogs";
import { modeOf, useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { useRuns } from "../query/runsStore";
import type { TxInfo } from "../query/transaction";
import { textOf } from "../../test/dialogs";
import { connection } from "../../test/fixtures";
import { resetStores } from "../../test/resetStores";
import { settleTransactions, switchMode } from "./transactionPrompts";

const NOW = 1_000_000_000;

let endTransaction: ReturnType<
  typeof vi.fn<(tabId: string, end: TxEnd) => Promise<boolean>>
>;

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  useProject.setState({
    status: "ready",
    project: {
      name: "demo",
      dir: "/p",
      connections: [
        connection("staging", { color: "yellow" }),
        connection("local"),
      ],
    },
  });
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  endTransaction = vi.fn(async () => true);
  useRuns.setState({ endTransaction });
});

/** 새 탭을 만들고 접속을 둔다. 활성 탭이 된다. */
function tab(connection = "staging"): string {
  const id = useTabs.getState().newTab();
  useTabs.getState().setConnection(id, connection);
  return id;
}

/** 그 탭에 `elapsedSecs`초 전에 열린 트랜잭션을 둔다. 기본은 사용자가 쓴 BEGIN으로 연 것이다. */
function open(
  tabId: string,
  statements: number,
  elapsedSecs = 192,
  status: TxInfo["status"] = "open",
  openedBy: TxInfo["openedBy"] = "user",
): void {
  useRuns.setState((s) => ({
    transactions: {
      ...s.transactions,
      [tabId]: {
        status,
        statements,
        openedAt: NOW - elapsedSecs * 1000,
        openedBy,
      },
    },
  }));
}

/** 다음 ask의 답을 `id`로 한다. */
function answer(id: string): void {
  vi.mocked(ask).mockResolvedValueOnce(id);
}

function asked(call = 0): DialogSpec {
  return vi.mocked(ask).mock.calls[call][0];
}

function actionsOf(spec: DialogSpec) {
  return spec.actions.map(({ id, label, spaceBefore }) => [
    id,
    label,
    spaceBefore ?? false,
  ]);
}

test("does_not_ask_without_a_transaction", async () => {
  const id = tab();

  expect(await settleTransactions([id], "close")).toBe(true);

  expect(ask).not.toHaveBeenCalled();
  expect(endTransaction).not.toHaveBeenCalled();
});

test("commit_and_close_commits_then_proceeds", async () => {
  const id = tab();
  open(id, 2);
  answer("commit");

  expect(await settleTransactions([id], "close")).toBe(true);

  const spec = asked();
  expect(textOf(spec.title)).toBe("This tab has an open transaction");
  expect(textOf(spec.body)).toBe(
    "Closing Query 1 closes the staging session. What should happen to the 2 uncommitted statements?",
  );
  expect(actionsOf(spec)).toEqual([
    ["cancel", "Cancel", false],
    ["rollback", "Roll back and close", true],
    ["commit", "Commit and close", false],
  ]);
  expect(spec.icon).toBeUndefined();
  expect(endTransaction).toHaveBeenCalledExactlyOnceWith(id, "commit");
});

test("roll_back_and_close_rolls_back_then_proceeds", async () => {
  const id = tab();
  open(id, 1);
  answer("rollback");

  expect(await settleTransactions([id], "close")).toBe(true);

  expect(textOf(asked().body)).toBe(
    "Closing Query 1 closes the staging session. What should happen to the 1 uncommitted statement?",
  );
  expect(endTransaction).toHaveBeenCalledExactlyOnceWith(id, "rollback");
});

test("names_are_bold", async () => {
  const id = tab();
  open(id, 2);
  answer("cancel");

  await settleTransactions([id], "switchConnection", { target: "local" });

  const holder = document.createElement("div");
  holder.innerHTML = renderToStaticMarkup(asked().body);
  expect([...holder.querySelectorAll("b")].map((b) => b.textContent)).toEqual([
    "local",
    "staging",
  ]);
});

test("a_transaction_without_statements_asks_about_the_open_transaction", async () => {
  const id = tab();
  open(id, 0);
  answer("cancel");

  await settleTransactions([id], "switchConnection", { target: "local" });

  expect(textOf(asked().title)).toBe("This tab has an open transaction");
  expect(textOf(asked().body)).toBe(
    "Switching to local closes the staging session. What should happen to the open transaction?",
  );
  // Safety D는 접속 바꾸기에 시계 icon을 둔다. Dialogs M6의 다른 확인에는 icon이 없다.
  expect(asked().icon).toBe("clock");
  expect(actionsOf(asked())).toEqual([
    ["cancel", "Cancel", false],
    ["rollback", "Roll back and switch", true],
    ["commit", "Commit and switch", false],
  ]);
});

test("a_failed_commit_keeps_the_tab_open", async () => {
  const id = tab();
  open(id, 2);
  answer("commit");
  endTransaction.mockResolvedValue(false);

  expect(await settleTransactions([id], "close")).toBe(false);
});

test("a_failed_commit_activates_the_tab_that_shows_the_error", async () => {
  const id = tab();
  open(id, 2);
  tab();
  answer("commit");
  endTransaction.mockResolvedValue(false);

  expect(await settleTransactions([id], "switchProject")).toBe(false);

  expect(useTabs.getState().activeId).toBe(id);
});

test("a_failed_rollback_still_proceeds", async () => {
  const id = tab();
  open(id, 2);
  answer("rollback");
  endTransaction.mockResolvedValue(false);

  expect(await settleTransactions([id], "close")).toBe(true);
});

test("a_failed_transaction_offers_no_commit", async () => {
  const id = tab();
  open(id, 2, 10, "failed");
  answer("rollback");

  expect(await settleTransactions([id], "close")).toBe(true);

  expect(textOf(asked().body)).toBe(
    "Closing Query 1 closes the staging session. What should happen to the 2 uncommitted statements?",
  );
  expect(asked().actions.map((action) => action.id)).toEqual([
    "cancel",
    "rollback",
  ]);
  expect(endTransaction).toHaveBeenCalledExactlyOnceWith(id, "rollback");
});

test("switch_mode_and_one_tab_wordings", async () => {
  const id = tab();
  open(id, 2);
  answer("cancel");
  answer("cancel");
  answer("cancel");

  await settleTransactions([id], "switchMode");
  await settleTransactions([id], "saveTarget", { connection: "staging" });
  await settleTransactions([id], "switchProject");

  expect(asked(0).icon).toBeUndefined();
  expect(asked(1).icon).toBeUndefined();
  expect(asked(2).icon).toBeUndefined();
  expect(textOf(asked(0).title)).toBe(
    "End the transaction before switching to Auto",
  );
  expect(textOf(asked(0).body)).toBe(
    "What should happen to the 2 uncommitted statements?",
  );
  expect(actionsOf(asked(0))).toEqual([
    ["cancel", "Cancel", false],
    ["rollback", "Roll back and switch", true],
    ["commit", "Commit and switch", false],
  ]);

  expect(textOf(asked(1).title)).toBe(
    "A tab using this connection has an open transaction",
  );
  expect(textOf(asked(1).body)).toBe(
    "Saving a new target closes the sessions of tabs using staging. What should happen to the 2 uncommitted statements in Query 1?",
  );
  expect(actionsOf(asked(1))).toEqual([
    ["cancel", "Cancel", false],
    ["rollback", "Roll back and save", true],
    ["commit", "Commit and save", false],
  ]);

  expect(textOf(asked(2).title)).toBe("A tab has an open transaction");
  expect(textOf(asked(2).body)).toBe(
    "Switching projects closes every tab's session. What should happen to the 2 uncommitted statements in Query 1?",
  );
  expect(actionsOf(asked(2))).toEqual([
    ["cancel", "Cancel", false],
    ["rollback", "Roll back and switch", true],
    ["commit", "Commit and switch", false],
  ]);
});

test("several_tabs_offer_only_roll_back_all", async () => {
  const a = tab("staging");
  const b = tab("local");
  const quiet = tab("local");
  open(a, 2, 192);
  open(b, 1, 42);
  answer("rollback");

  expect(await settleTransactions([a, b, quiet], "switchProject")).toBe(true);

  const spec = asked();
  expect(spec.icon).toBeUndefined();
  // 앱 종료의 목록처럼 줄마다 그 접속의 색 dot을 둔다.
  expect(spec.items?.map((item) => renderToStaticMarkup(item.marker))).toEqual([
    expect.stringContaining("var(--color-conn-yellow)"),
    expect.stringContaining("var(--color-line-2)"),
  ]);
  expect(textOf(spec.title)).toBe("2 tabs have open transactions");
  expect(spec.body).toBeUndefined();
  expect(
    spec.items?.map((item) => [item.primary, textOf(item.secondary)]),
  ).toEqual([
    ["Query 1", "staging · 2 statements · 3:12"],
    ["Query 2", "local · 1 statement · 0:42"],
  ]);
  expect(textOf(spec.note)).toBe(
    "To decide tab by tab, cancel and use Commit or Rollback in each tab.",
  );
  expect(actionsOf(spec)).toEqual([
    ["cancel", "Cancel", false],
    ["rollback", "Roll back all and switch", true],
  ]);
  expect(endTransaction).toHaveBeenCalledTimes(2);
  expect(endTransaction).toHaveBeenCalledWith(a, "rollback");
  expect(endTransaction).toHaveBeenCalledWith(b, "rollback");
});

test("several_tabs_saving_a_target_say_save", async () => {
  const a = tab();
  const b = tab();
  open(a, 0);
  open(b, 3);
  answer("cancel");

  await settleTransactions([a, b], "saveTarget", { connection: "staging" });

  expect(asked().items?.map((item) => textOf(item.secondary))).toEqual([
    "staging · manual BEGIN · 3:12",
    "staging · 3 statements · 3:12",
  ]);
  expect(asked().actions.map((action) => action.label)).toEqual([
    "Cancel",
    "Roll back all and save",
  ]);
});

test("an_app_opened_transaction_without_statements_counts_0_statements", async () => {
  const a = tab();
  const b = tab();
  open(a, 0, 192, "failed", "app");
  open(b, 3);
  answer("cancel");
  answer("cancel");
  answer("cancel");

  await settleTransactions([a], "close");
  await settleTransactions([a], "switchProject");
  await settleTransactions([a, b], "saveTarget", { connection: "staging" });

  expect(textOf(asked(0).body)).toBe(
    "Closing Query 1 closes the staging session. What should happen to the 0 uncommitted statements?",
  );
  expect(textOf(asked(1).body)).toBe(
    "Switching projects closes every tab's session. What should happen to the 0 uncommitted statements in Query 1?",
  );
  expect(asked(2).items?.map((item) => textOf(item.secondary))).toEqual([
    "staging · 0 statements · 3:12",
    "staging · 3 statements · 3:12",
  ]);
});

test("cancel_does_nothing", async () => {
  const id = tab();
  open(id, 2);
  answer("cancel");

  expect(await settleTransactions([id], "close")).toBe(false);

  expect(endTransaction).not.toHaveBeenCalled();
  expect(useRuns.getState().transactions[id]).toBeDefined();
});

test("switch_mode_to_manual_does_not_ask", async () => {
  const id = tab();
  open(id, 0);

  await switchMode(id, "manual");

  expect(ask).not.toHaveBeenCalled();
  expect(modeOf(useTabs.getState(), id)).toBe("manual");
});

test("switch_mode_to_auto_asks_only_with_a_transaction", async () => {
  const id = tab();
  useTabs.getState().setMode(id, "manual");

  await switchMode(id, "auto");
  expect(ask).not.toHaveBeenCalled();
  expect(modeOf(useTabs.getState(), id)).toBe("auto");

  useTabs.getState().setMode(id, "manual");
  open(id, 2);
  answer("cancel");
  await switchMode(id, "auto");
  expect(modeOf(useTabs.getState(), id)).toBe("manual");

  answer("rollback");
  await switchMode(id, "auto");
  expect(endTransaction).toHaveBeenCalledWith(id, "rollback");
  expect(modeOf(useTabs.getState(), id)).toBe("auto");
});

test("switch_mode_stays_manual_when_the_commit_fails", async () => {
  const id = tab();
  useTabs.getState().setMode(id, "manual");
  open(id, 2);
  answer("commit");
  endTransaction.mockResolvedValue(false);

  await switchMode(id, "auto");

  expect(modeOf(useTabs.getState(), id)).toBe("manual");
});
