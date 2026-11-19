import { createElement, type ReactNode } from "react";
import type { TxEnd, TxMode } from "../../shared/api/types";
import { bold, monoText, rt } from "../../shared/i18n/rich";
import { formatCount, t, tc } from "../../shared/i18n/t";
import {
  ask,
  type DialogAction,
  type DialogSpec,
} from "../../shared/ui/dialogs";
import { colorOf } from "../connections/colors";
import { ConnectionDot } from "../connections/ConnectionDot";
import { modeOf, useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { useRuns } from "../query/runsStore";
import {
  formatClock,
  statementsKey,
  statementsLabel,
  statementsText,
  type TxCount,
  type TxInfo,
} from "../query/transaction";

/** 열린 트랜잭션을 잃는 동작 */
export type TxAction =
  "close" | "switchMode" | "switchConnection" | "saveTarget" | "switchProject";

export interface TxContext {
  /** 세션이 닫히는 접속. 없으면 탭의 접속이다. */
  connection?: string;
  /** 바꿀 접속(`switchConnection`) */
  target?: string;
}

/** 고른 끝내기. 끝낼 트랜잭션이 없으면 `tabIds`가 비어 있다. */
export interface TxSettlement {
  end: TxEnd;
  tabIds: string[];
}

/** 버튼 문구의 동사. 앱 종료는 `TxAction`이 아니라 여러 탭 목록만 쓴다. */
type TxVerb = "close" | "switch" | "save";
type Verb = TxVerb | "quit";

const VERB: Record<TxAction, TxVerb> = {
  close: "close",
  switchMode: "switch",
  switchConnection: "switch",
  saveTarget: "save",
  switchProject: "switch",
};

export interface OpenTab {
  id: string;
  title: string;
  connection: string;
  tx: TxInfo;
}

/** `tabIds` 가운데 열린 트랜잭션이 있는 탭. 순서는 `tabIds`를 따른다. */
export function openTabs(tabIds: string[]): OpenTab[] {
  const { transactions } = useRuns.getState();
  const { tabs } = useTabs.getState();
  return tabIds.flatMap((id) => {
    const tx = transactions[id];
    const tab = tabs.find((candidate) => candidate.id === id);
    if (tx === undefined || tab === undefined) return [];
    return [{ id, title: tab.title, connection: tab.connection ?? "", tx }];
  });
}

/**
 * `{question}`. 사용자가 쓴 BEGIN으로 연 트랜잭션에 문장이 없으면 열린 트랜잭션을 묻는다. `title`을
 * 주면 그 탭을 이름으로 가리킨다.
 */
function question(tx: TxCount, title?: string): ReactNode {
  return title === undefined
    ? statementsText("dialog.tx.question", tx)
    : rt(statementsKey("dialog.tx.questionIn", tx), {
        title: bold(title),
        count: formatCount(tx.statements),
      });
}

function oneTabText(
  tab: OpenTab,
  action: TxAction,
  context: TxContext,
): Pick<DialogSpec, "title" | "body" | "icon"> {
  const connection = bold(context.connection ?? tab.connection);
  switch (action) {
    case "close":
      return {
        title: t("dialog.tx.oneTab.title"),
        body: rt("dialog.tx.close.body", {
          title: bold(tab.title),
          connection,
          question: question(tab.tx),
        }),
      };
    case "switchConnection":
      // Safety D. Dialogs M6의 다른 확인에는 icon이 없다.
      return {
        icon: "clock",
        title: t("dialog.tx.oneTab.title"),
        body: rt("dialog.tx.switchConnection.body", {
          target: bold(context.target ?? ""),
          connection,
          question: question(tab.tx),
        }),
      };
    case "switchMode":
      return {
        title: t("dialog.tx.switchMode.title"),
        body: question(tab.tx),
      };
    case "saveTarget":
      return {
        title: t("dialog.tx.saveTarget.title"),
        body: rt("dialog.tx.saveTarget.body", {
          connection,
          question: question(tab.tx, tab.title),
        }),
      };
    case "switchProject":
      return {
        title: t("dialog.tx.switchProject.title"),
        body: rt("dialog.tx.switchProject.body", {
          question: question(tab.tx, tab.title),
        }),
      };
  }
}

function cancel(): DialogAction {
  return { id: "cancel", label: t("common.cancel") };
}

/** 한 탭이면 Cancel, Rollback, Commit이다. */
function oneTabSpec(
  tab: OpenTab,
  action: TxAction,
  context: TxContext,
): DialogSpec {
  const verb = VERB[action];
  const actions: DialogAction[] = [
    cancel(),
    {
      id: "rollback",
      label: t(`dialog.tx.rollback.${verb}`),
      spaceBefore: true,
    },
  ];
  // 서버는 실패한 트랜잭션의 COMMIT을 ROLLBACK으로 처리하므로 Commit을 고르게 하지 않는다.
  if (tab.tx.status === "open") {
    actions.push({ id: "commit", label: t(`dialog.tx.commit.${verb}`) });
  }
  return { ...oneTabText(tab, action, context), actions };
}

/**
 * 탭 목록과 "Roll back all and …"만 둔다. 한꺼번에 Commit하지 않는다.
 * 여러 탭을 닫거나 바꿀 때와 앱 종료가 같이 쓴다.
 */
export function manyTabsSpec(tabs: OpenTab[], verb: Verb): DialogSpec {
  // 목록은 다시 그리지 않으므로 경과 시간은 물을 때 한 번 센다.
  const now = Date.now();
  const connections = useProject.getState().project?.connections ?? [];
  return {
    title: tc("dialog.tx.manyTabs.title", tabs.length),
    items: tabs.map((tab) => ({
      // 앱 종료의 목록처럼 줄마다 그 접속의 색 dot을 둔다.
      marker: createElement(ConnectionDot, {
        color: colorOf(connections, tab.connection),
      }),
      primary: tab.title,
      secondary: rt("dialog.tx.manyTabs.item", {
        connection: tab.connection,
        statements: statementsLabel(tab.tx),
        elapsed: monoText(formatClock(now - tab.tx.openedAt)),
      }),
    })),
    note: t("dialog.tx.manyTabs.note"),
    actions: [
      cancel(),
      {
        id: "rollback",
        label: t(`dialog.tx.rollbackAll.${verb}`),
        spaceBefore: true,
      },
    ],
  };
}

/**
 * 탭들의 열린 트랜잭션을 어떻게 끝낼지 묻는다. 끝내지는 않는다. 그만두면 null.
 * 트랜잭션이 없으면 묻지 않고 끝낼 것이 없는 settlement를 돌려준다.
 */
export async function chooseSettlement(
  tabIds: string[],
  action: TxAction,
  context: TxContext = {},
): Promise<TxSettlement | null> {
  const tabs = openTabs(tabIds);
  const [first, ...rest] = tabs;
  if (first === undefined) return { end: "rollback", tabIds: [] };
  const choice = await ask(
    rest.length === 0
      ? oneTabSpec(first, action, context)
      : manyTabsSpec(tabs, VERB[action]),
  );
  if (choice !== "commit" && choice !== "rollback") return null;
  return { end: choice, tabIds: tabs.map((tab) => tab.id) };
}

/**
 * 고른 대로 끝낸다. 진행해도 되면 true. Rollback은 실패해도 true다(세션이 닫히면 서버가 되돌린다).
 * Commit이 실패하면 false이고, 오류가 결과 panel에 남은 그 탭을 활성으로 한다.
 */
export async function applySettlement({
  end,
  tabIds,
}: TxSettlement): Promise<boolean> {
  const { endTransaction } = useRuns.getState();
  const ended = await Promise.all(tabIds.map((id) => endTransaction(id, end)));
  if (end === "rollback") return true;
  const failed = tabIds.find((_, index) => !ended[index]);
  if (failed === undefined) return true;
  useTabs.getState().activate(failed);
  return false;
}

/**
 * 탭들의 열린 트랜잭션을 어떻게 할지 묻고 고른 대로 끝낸다. 진행해도 되면 true.
 * 트랜잭션이 없으면 묻지 않고 true. Commit이 실패하면 false(오류는 결과 panel에 남음).
 * Rollback은 실패해도 true. 탭이 둘 이상이면 목록과 "Roll back all and …"만 둔다.
 */
export async function settleTransactions(
  tabIds: string[],
  action: TxAction,
  context: TxContext = {},
): Promise<boolean> {
  const settlement = await chooseSettlement(tabIds, action, context);
  return settlement !== null && applySettlement(settlement);
}

/** 탭의 모드를 바꾼다. Manual에서 Auto로 바꿀 때 열린 트랜잭션이 있으면 먼저 끝내게 한다. */
export async function switchMode(tabId: string, mode: TxMode): Promise<void> {
  const leavingManual =
    mode === "auto" && modeOf(useTabs.getState(), tabId) === "manual";
  if (leavingManual && !(await settleTransactions([tabId], "switchMode"))) {
    return;
  }
  useTabs.getState().setMode(tabId, mode);
}
