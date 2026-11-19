import { writeSqlFile } from "../../shared/api/commands";
import { isCommandError, messageOf } from "../../shared/api/errors";
import { useProject } from "../project/projectStore";
import { documentFileText, documentState, findDocument } from "./documents";
import { useTabs } from "./tabsStore";
import { mono, rt } from "../../shared/i18n/rich";
import { t } from "../../shared/i18n/t";
import { ask } from "../../shared/ui/dialogs";

export type SaveResult = "saved" | "needs_name" | "cancelled" | "failed";

/** 앞뒤 공백을 빼고, `.sql`로 끝나지 않으면(대소문자 구분 없이) 붙인다. */
export function normalizeNewPath(input: string): string {
  const path = input.trim();
  return path.toLowerCase().endsWith(".sql") ? path : `${path}.sql`;
}

// 저장 중인 tab id. 같은 stamp로 두 번 쓰면 두 번째가 "파일이 바뀌었다"고 묻게 된다.
const inFlight = new Set<string>();

/**
 * 새 파일로 쓰거나(newPath) 연 파일에 덮어쓴다. 이름이 필요하면 묻는다.
 * 그 탭의 저장이 진행 중이거나 newPath가 공백뿐이면 아무것도 하지 않는다.
 */
export async function saveTab(
  tabId: string,
  newPath?: string,
): Promise<SaveResult> {
  if (newPath?.trim() === "" || inFlight.has(tabId)) return "cancelled";
  inFlight.add(tabId);
  try {
    return await save(tabId, newPath);
  } finally {
    inFlight.delete(tabId);
  }
}

async function save(tabId: string, newPath?: string): Promise<SaveResult> {
  const tabs = useTabs.getState();
  const tab = tabs.tabs.find((t) => t.id === tabId);
  if (tab === undefined) return "failed";

  if (tab.path === null && newPath === undefined) {
    tabs.requestName(tabId);
    return "needs_name";
  }

  const doc = documentState(tabId).doc;
  const text = documentFileText(tabId);
  /** 쓰는 동안 더 입력했으면 dirty로 남긴다. 탭이 닫혔으면 markSaved가 아무것도 하지 않는다. */
  const recordSaved = (path: string, stamp: string) =>
    tabs.markSaved(
      tabId,
      path,
      stamp,
      !(findDocument(tabId)?.doc.eq(doc) ?? true),
    );
  try {
    if (newPath !== undefined) {
      const path = normalizeNewPath(newPath);
      const stamp = await writeSqlFile(path, text, { mode: "create" });
      recordSaved(path, stamp);
      void useProject.getState().refreshFiles();
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
      const deleted = isCommandError(error, "file_not_found");
      if (!deleted && !isCommandError(error, "file_changed")) throw error;
      const [question, confirmId] = deleted
        ? (["dialog.fileDeleted", "recreate"] as const)
        : (["dialog.fileChanged", "overwrite"] as const);
      const choice = await ask({
        title: rt(`${question}.title`, { path: mono(path) }),
        body: t(`${question}.body`),
        actions: [
          { id: "cancel", label: t("common.cancel") },
          { id: confirmId, label: t(`${question}.confirm`) },
        ],
      });
      if (choice === "cancel") return "cancelled";
      // overwrite는 파일이 없으면 부모 디렉토리까지 만든다.
      stamp = await writeSqlFile(path, text, { mode: "overwrite" });
      if (deleted) void useProject.getState().refreshFiles();
    }
    recordSaved(path, stamp);
    return "saved";
  } catch (error) {
    tabs.setError(messageOf(error));
    return "failed";
  }
}
