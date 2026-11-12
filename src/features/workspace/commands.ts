import { splitStatements } from "../../shared/api/commands";
import { confirm, pickDirectory } from "../../shared/api/dialog";
import { messageOf } from "../../shared/api/errors";
import type { Project } from "../../shared/api/types";
import { targetChanged } from "../connections/connectionValues";
import { documentSelection, documentText } from "../editor/documents";
import { saveTab } from "../editor/saveTab";
import { lineColumn, statementAt } from "../editor/statementAt";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import type { Origin } from "../query/runReducer";
import { useRuns, type RunRequest } from "../query/runsStore";

export type CommandId =
  "run" | "cancel" | "save" | "newTab" | "closeTab" | "nextTab" | "prevTab";

function findTab(tabId: string) {
  return useTabs.getState().tabs.find((tab) => tab.id === tabId);
}

/** 선택 영역이 있으면 그것을, 없으면 커서가 가리키는 문장을 고른다. */
async function statementToRun(
  tabId: string,
): Promise<{ sql: string; origin: Origin } | string> {
  const text = documentText(tabId);
  const { from, to, head } = documentSelection(tabId);
  if (from !== to) {
    const sql = text.slice(from, to);
    if (sql.trim() === "") return "실행할 문장이 없습니다";
    return { sql, origin: lineColumn(text, from) };
  }

  let spans;
  try {
    spans = await splitStatements(text);
  } catch (error) {
    return messageOf(error);
  }
  const span = statementAt(text, spans, head);
  if (span === null) return "커서 위치에 문장이 없습니다";
  return {
    sql: text.slice(span.start, span.end),
    origin: lineColumn(text, span.start),
  };
}

/** 탭에서 실행할 것을 정한다. store를 바꾸지 않는다. */
async function prepareRun(tabId: string): Promise<RunRequest | string> {
  const connection = findTab(tabId)?.connection ?? null;
  if (connection === null) return "접속을 먼저 고르세요";
  const statement = await statementToRun(tabId);
  return typeof statement === "string"
    ? statement
    : { connection, ...statement };
}

/** 활성 탭에 대해 command를 실행한다. */
export async function execute(command: CommandId): Promise<void> {
  const tabs = useTabs.getState();
  switch (command) {
    case "newTab":
      tabs.newTab();
      return;
    case "nextTab":
      tabs.next();
      return;
    case "prevTab":
      tabs.prev();
      return;
  }

  const tabId = tabs.activeId;
  if (tabId === null) return;
  switch (command) {
    case "run":
      // 문장을 나누는 동안 탭을 닫거나 접속을 바꾸면 release가 이 실행을 버린다.
      return useRuns.getState().run(tabId, () => prepareRun(tabId));
    case "cancel":
      return useRuns.getState().cancel(tabId);
    case "save":
      await saveTab(tabId);
      return;
    case "closeTab":
      return closeTab(tabId);
  }
}

/** 저장하지 않은 변경이 있으면 묻고, 세션을 놓은 뒤 탭을 닫는다. */
export async function closeTab(tabId: string): Promise<void> {
  const tab = findTab(tabId);
  if (tab === undefined) return;
  if (tab.dirty) {
    let discard: boolean;
    try {
      discard = await confirm(
        `'${tab.title}'의 저장하지 않은 변경을 버릴까요?`,
      );
    } catch (error) {
      // 묻지 못했으면 닫지 않는다.
      useTabs.getState().setError(messageOf(error));
      return;
    }
    if (!discard) return;
  }
  // release는 store에서 세션을 바로 떼어 낸다. 세션을 닫는 응답은 탭을 닫은 뒤에 기다린다.
  const released = useRuns.getState().release(tabId);
  useTabs.getState().close(tabId);
  await released;
}

/** 지금 세션을 놓고 탭의 접속을 바꾼다. 다음 실행이 새 접속으로 세션을 연다. */
export async function changeConnection(
  tabId: string,
  connection: string | null,
): Promise<void> {
  const released = useRuns.getState().release(tabId);
  useTabs.getState().setConnection(tabId, connection);
  await released;
}

/**
 * 접속을 저장한 뒤의 project를 반영한다. 연결 대상이 바뀐 접속을 쓰는 탭은 세션을 놓아서
 * 다음 실행이 새 대상으로 연다. 세션은 접속 이름이 같으면 다시 쓰이기 때문이다.
 */
export async function applySavedProject(project: Project): Promise<void> {
  const before = useProject.getState().project?.connections ?? [];
  const changed = new Set(
    project.connections
      .filter((connection) => {
        const previous = before.find((c) => c.name === connection.name);
        return previous !== undefined && targetChanged(connection, previous);
      })
      .map((connection) => connection.name),
  );
  const released = useTabs
    .getState()
    .tabs.filter(
      (tab) => tab.connection !== null && changed.has(tab.connection),
    )
    .map((tab) => useRuns.getState().release(tab.id));
  useProject.getState().applyProject(project);
  await Promise.all(released);
}

/** 다른 프로젝트를 연다. 열리면 탭과 실행 상태를 비운다. */
export async function switchProject(): Promise<void> {
  let dir: string | null;
  try {
    dir = await askProjectDir();
  } catch (error) {
    useProject.getState().showError(messageOf(error));
    return;
  }
  if (dir === null) return;
  if (!(await useProject.getState().open(dir))) return;

  // 옛 프로젝트의 세션은 Rust가 이미 닫았으므로 그 close는 실패하고 무시된다.
  // 바꾸는 동안 실행이 새로 연 세션은 여기서 닫힌다.
  const closing = useRuns.getState().reset();
  useTabs.getState().reset();
  await closing;
}

/** dirty 탭이 있으면 버릴지 묻고 디렉토리를 고르게 한다. 그만두면 null이다. */
async function askProjectDir(): Promise<string | null> {
  const dirty = useTabs.getState().tabs.filter((tab) => tab.dirty).length;
  if (
    dirty > 0 &&
    !(await confirm(
      `저장하지 않은 변경이 있는 탭이 ${dirty}개 있습니다. 버리고 다른 프로젝트를 열까요?`,
    ))
  ) {
    return null;
  }
  return pickDirectory();
}
