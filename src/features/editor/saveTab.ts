import { writeSqlFile } from "../../shared/api/commands";
import { confirm } from "../../shared/api/dialog";
import { isCommandError, messageOf } from "../../shared/api/errors";
import { useProject } from "../project/projectStore";
import { documentText } from "./documents";
import { useTabs } from "./tabsStore";

export type SaveResult = "saved" | "needs_name" | "cancelled" | "failed";

/** 앞뒤 공백을 빼고, `.sql`로 끝나지 않으면(대소문자 구분 없이) 붙인다. */
export function normalizeNewPath(input: string): string {
  const path = input.trim();
  return path.toLowerCase().endsWith(".sql") ? path : `${path}.sql`;
}

/** 쓰는 동안 바뀐 text를 dirty로 남기며 저장을 기록한다. */
function recordSaved(
  tabId: string,
  path: string,
  stamp: string,
  savedText: string,
): void {
  const tabs = useTabs.getState();
  tabs.markSaved(tabId, path, stamp);
  // 쓰는 동안 탭이 닫혔거나 더 입력했을 수 있다.
  if (!useTabs.getState().tabs.some((tab) => tab.id === tabId)) return;
  if (documentText(tabId) !== savedText) tabs.markDirty(tabId);
}

/** 새 파일로 쓰거나(newPath) 연 파일에 덮어쓴다. 이름이 필요하면 묻는다. */
export async function saveTab(
  tabId: string,
  newPath?: string,
): Promise<SaveResult> {
  const tabs = useTabs.getState();
  const tab = tabs.tabs.find((t) => t.id === tabId);
  if (tab === undefined) return "failed";

  if (tab.path === null && newPath === undefined) {
    tabs.requestName(tabId);
    return "needs_name";
  }

  const text = documentText(tabId);
  try {
    if (newPath !== undefined) {
      const path = normalizeNewPath(newPath);
      const stamp = await writeSqlFile(path, text, { mode: "create" });
      recordSaved(tabId, path, stamp, text);
      await useProject.getState().refreshFiles();
      return "saved";
    }

    // newPath가 없고 path도 null인 경우는 위에서 걸렀다.
    const path = tab.path as string;
    let stamp: string;
    try {
      stamp = await writeSqlFile(path, text, {
        mode: "replace",
        stamp: tab.stamp ?? "",
      });
    } catch (error) {
      if (!isCommandError(error, "file_changed")) {
        throw error;
      }
      if (!(await confirm(`${path} 파일이 밖에서 바뀌었습니다. 덮어쓸까요?`))) {
        return "cancelled";
      }
      stamp = await writeSqlFile(path, text, { mode: "overwrite" });
    }
    recordSaved(tabId, path, stamp, text);
    return "saved";
  } catch (error) {
    tabs.setError(messageOf(error));
    return "failed";
  }
}
