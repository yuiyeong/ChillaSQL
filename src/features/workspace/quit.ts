import { useEffect } from "react";
import { quitApp } from "../../shared/api/commands";
import { onQuitRequested } from "../../shared/api/events";
import { ask } from "../../shared/ui/dialogs";
import { useRuns } from "../query/runsStore";
import { useTabs } from "../editor/tabsStore";
import { manyTabsSpec, openTabs } from "./transactionPrompts";

/** 묻는 중이면 true. 그 사이 온 종료 요청은 dialog를 쌓지 않고 버린다. */
let asking = false;

/**
 * 앱 종료를 요청받았을 때 끝낸다. 열린 트랜잭션이 있으면 목록으로 묻고, Cancel이면 그대로 둔다.
 * Rollback은 보내지 않는다. 세션이 닫히면 서버가 되돌린다.
 */
export async function requestQuit(): Promise<void> {
  if (asking) return;
  asking = true;
  try {
    const { transactions } = useRuns.getState();
    const tabs = openTabs(
      useTabs
        .getState()
        .tabs.map((tab) => tab.id)
        .filter((id) => transactions[id] !== undefined),
    );
    if (
      tabs.length > 0 &&
      (await ask(manyTabsSpec(tabs, "quit"))) !== "rollback"
    ) {
      return;
    }
    await quitApp();
  } finally {
    asking = false;
  }
}

/** Rust가 보내는 종료 요청을 받는다. 프로젝트가 열리기 전에도 받아야 하므로 App에서 한 번 쓴다. */
export function useQuitRequests(): void {
  useEffect(() => {
    const subscribed = onQuitRequested(() => void requestQuit());
    return () => {
      void subscribed.then((stop) => stop());
    };
  }, []);
}
