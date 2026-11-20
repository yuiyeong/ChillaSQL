import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import {
  loadWorkspace,
  quitApp,
  saveWorkspace,
} from "../../shared/api/commands";
import { useDialogs } from "../../shared/ui/dialogs";
import { answerDialog, textOf } from "../../test/dialogs";
import { connection } from "../../test/fixtures";
import { resetStores } from "../../test/resetStores";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { useRuns } from "../query/runsStore";
import type { TxInfo } from "../query/transaction";
import { reopenTabs, startAutosave } from "./autosave";
import { requestQuit } from "./quit";

const NOW = 1_000_000_000;

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  vi.mocked(quitApp).mockResolvedValue(undefined);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  useProject.setState({
    status: "ready",
    project: {
      name: "demo",
      dir: "/p",
      connections: [
        connection("staging", { color: "yellow" }),
        connection("local", { color: "green" }),
      ],
    },
  });
});

/** 새 탭을 만들고 접속과 열린 트랜잭션을 둔다. */
function openTab(
  connectionName: string,
  statements: number,
  elapsedSecs: number,
  status: TxInfo["status"] = "open",
): string {
  const id = useTabs.getState().newTab();
  useTabs.getState().setConnection(id, connectionName);
  useRuns.setState((s) => ({
    transactions: {
      ...s.transactions,
      [id]: {
        status,
        statements,
        openedAt: NOW - elapsedSecs * 1000,
        openedBy: "app",
      },
    },
  }));
  return id;
}

test("quits_at_once_without_open_transactions", async () => {
  await requestQuit();

  expect(quitApp).toHaveBeenCalledTimes(1);
  expect(useDialogs.getState().current).toBeNull();
});

test("quits_at_once_without_open_transactions_before_a_project_is_open", async () => {
  useProject.setState({ status: "booting", project: null });

  await requestQuit();

  expect(quitApp).toHaveBeenCalledTimes(1);
});

test("asks_and_quits_on_roll_back_all", async () => {
  openTab("staging", 2, 192);
  openTab("local", 1, 42, "failed");
  const endTransaction = vi.fn(async () => true);
  useRuns.setState({ endTransaction });

  const quitting = requestQuit();
  const spec = await answerDialog("rollback");
  await quitting;

  expect(textOf(spec.title)).toBe("2 tabs have open transactions");
  expect(
    spec.items?.map((item) => [textOf(item.primary), textOf(item.secondary)]),
  ).toEqual([
    ["Query 1", "staging · 2 statements · 3:12"],
    ["Query 2", "local · 1 statement · 0:42"],
  ]);
  expect(textOf(spec.note)).toBe(
    "To decide tab by tab, cancel and use Commit or Rollback in each tab.",
  );
  expect(spec.actions.map((action) => action.label)).toEqual([
    "Cancel",
    "Roll back all and quit",
  ]);
  expect(quitApp).toHaveBeenCalledTimes(1);
  // 세션이 닫히면 서버가 되돌리므로 Rollback은 따로 보내지 않는다.
  expect(endTransaction).not.toHaveBeenCalled();
});

test("one_tab_is_listed_with_the_singular_title", async () => {
  openTab("staging", 1, 5);

  const quitting = requestQuit();
  const spec = await answerDialog("rollback");
  await quitting;

  expect(textOf(spec.title)).toBe("1 tab has an open transaction");
  expect(spec.items).toHaveLength(1);
  expect(quitApp).toHaveBeenCalledTimes(1);
});

test("cancel_keeps_the_app_open", async () => {
  openTab("staging", 2, 192);

  const quitting = requestQuit();
  await answerDialog("cancel");
  await quitting;

  expect(quitApp).not.toHaveBeenCalled();
});

test("a_second_quit_request_while_asking_is_ignored", async () => {
  openTab("staging", 2, 192);

  const first = requestQuit();
  await vi.waitFor(() => {
    expect(useDialogs.getState().current).not.toBeNull();
  });
  await requestQuit();

  await answerDialog("cancel");
  await first;
  // 두 번째 요청은 dialog를 쌓지 않았다.
  expect(useDialogs.getState().current).toBeNull();
  expect(quitApp).not.toHaveBeenCalled();

  // 답한 뒤에는 다시 물을 수 있다.
  const again = requestQuit();
  await answerDialog("rollback");
  await again;
  expect(quitApp).toHaveBeenCalledTimes(1);
});

test("flushes_before_quit", async () => {
  vi.mocked(loadWorkspace).mockResolvedValue(null);
  vi.mocked(saveWorkspace).mockResolvedValue();
  await reopenTabs();
  const stop = startAutosave();
  useTabs.getState().newTab({ text: "SELECT 1" });

  await requestQuit();
  stop();

  expect(saveWorkspace).toHaveBeenCalledTimes(1);
  expect(vi.mocked(saveWorkspace).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(quitApp).mock.invocationCallOrder[0],
  );
});
