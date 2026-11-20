import {
  cancelTunnel,
  restartTunnel,
  splitStatements,
} from "../../shared/api/commands";
import { pickDirectory } from "../../shared/api/dialog";
import { isCommandError, messageOf } from "../../shared/api/errors";
import type {
  Connection,
  Project,
  Relation,
  TxEnd,
} from "../../shared/api/types";
import { quoteIdent } from "../../shared/sql/identifiers";
import { targetChanged } from "../connections/connectionValues";
import { isTunnelStarting, useTunnels } from "../connections/tunnelsStore";
import { documentSelection, documentText } from "../editor/documents";
import { saveTab } from "../editor/saveTab";
import { lineColumn, statementAt } from "../editor/statementAt";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import type { Origin, Rejection, RunRequest } from "../query/runReducer";
import { endable, useRuns } from "../query/runsStore";
import { useTypes } from "../query/typesStore";
import { useSchema } from "../schema/schemaStore";
import { mono, rt } from "../../shared/i18n/rich";
import { t, tc } from "../../shared/i18n/t";
import { ask } from "../../shared/ui/dialogs";
import { confirmDanger } from "./dangerPrompt";
import {
  applySettlement,
  chooseSettlement,
  settleTransactions,
} from "./transactionPrompts";

export type CommandId =
  | "run"
  | "cancel"
  | "save"
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "commit"
  | "rollback";

function findTab(tabId: string) {
  return useTabs.getState().tabs.find((tab) => tab.id === tabId);
}

/** 선택 영역이 있으면 그것을, 없으면 커서가 가리키는 문장을 고른다. */
async function statementToRun(
  tabId: string,
): Promise<{ sql: string; origin: Origin } | Rejection> {
  const text = documentText(tabId);
  const { from, to, head } = documentSelection(tabId);
  if (from !== to) {
    const sql = text.slice(from, to);
    if (sql.trim() === "") {
      return { title: t("run.emptySelection"), detail: null };
    }
    return { sql, origin: lineColumn(text, from) };
  }

  let spans;
  try {
    spans = await splitStatements(text);
  } catch (error) {
    if (isCommandError(error, "split_failed")) {
      return {
        title: t("run.splitFailed.title"),
        detail: t("run.splitFailed.detail"),
      };
    }
    return { title: messageOf(error), detail: null };
  }
  const span = statementAt(text, spans, head);
  if (span === null) {
    return { title: t("run.noStatementAtCursor"), detail: null };
  }
  return {
    sql: text.slice(span.start, span.end),
    origin: lineColumn(text, span.start),
  };
}

function noConnection(): Rejection {
  return { title: t("run.noConnection"), detail: null };
}

/** 탭의 지금 접속으로 `sql`을 실행할 요청. 접속이 없으면 Rejection이다. */
function requestFor(
  tabId: string,
  sql: string,
  origin: Origin,
): RunRequest | Rejection {
  const connection = findTab(tabId)?.connection ?? null;
  return connection === null ? noConnection() : { connection, sql, origin };
}

/** 요청이 위험한 문장이면 묻는다. 그만두게 했으면 null이다. Rejection은 그대로 돌려준다. */
async function confirmed(
  tabId: string,
  request: RunRequest | Rejection,
): Promise<RunRequest | Rejection | null> {
  if ("title" in request) return request;
  return (await confirmDanger(tabId, request)) ? request : null;
}

/** 탭에서 실행할 것을 정한다. 위험한 문장이면 묻는다. store를 바꾸지 않는다. */
async function prepareRun(
  tabId: string,
): Promise<RunRequest | Rejection | null> {
  // 접속이 없으면 문장을 나누지 않는다.
  if (findTab(tabId)?.connection == null) return noConnection();
  const statement = await statementToRun(tabId);
  if ("title" in statement) return statement;
  return confirmed(tabId, requestFor(tabId, statement.sql, statement.origin));
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
      return cancelRun(tabId);
    case "save":
      await saveTab(tabId);
      return;
    case "closeTab":
      return closeTab(tabId);
    case "commit":
    case "rollback":
      await endActiveTransaction(tabId, command);
      return;
  }
}

/** 탭의 트랜잭션을 Commit이나 Rollback한다. 지금 그렇게 끝낼 수 없으면(`endable`) 아무것도 하지 않는다. */
async function endActiveTransaction(tabId: string, end: TxEnd): Promise<void> {
  const runs = useRuns.getState();
  if (endable(runs, tabId, end)) await runs.endTransaction(tabId, end);
}

/**
 * 탭의 실행을 멈춘다. 연결 중이고 그 접속의 터널이 시작 중이면 터널 시작을 멈춘다(같은 터널을
 * 기다리던 다른 탭의 실행도 멈춘다).
 */
export async function cancelRun(tabId: string): Promise<void> {
  const connection = findTab(tabId)?.connection ?? null;
  const connecting = useRuns.getState().runs[tabId]?.status === "connecting";
  if (
    connecting &&
    connection !== null &&
    isTunnelStarting(useTunnels.getState().tunnels, connection)
  ) {
    try {
      await cancelTunnel(connection);
    } catch {
      // 그 사이 터널이 열렸거나 프로젝트가 바뀌었다. 실행의 결과가 상태를 정한다.
    }
    return;
  }
  return useRuns.getState().cancel(tabId);
}

/** 다시 실행하다 멈춘 그 접속의 터널을 처음부터 다시 시작한다. */
export async function retryTunnel(connection: string): Promise<void> {
  try {
    await restartTunnel(connection);
  } catch {
    // 그 사이 프로젝트가 바뀌었다. 터널 상태는 event로 온다.
  }
}

/** 탭의 지금 접속으로 `sql`을 실행한다. 위험한 문장이면 묻는다. */
function runSql(tabId: string, sql: string, origin: Origin): Promise<void> {
  return useRuns
    .getState()
    .run(tabId, () => confirmed(tabId, requestFor(tabId, sql, origin)));
}

/** 그 탭의 결과에 쓴 SQL을 탭의 지금 접속으로 다시 실행한다. 결과가 없으면 아무것도 하지 않는다. */
export async function runAgain(tabId: string): Promise<void> {
  const state = useRuns.getState().runs[tabId];
  if (state?.status !== "running" && state?.status !== "finished") return;
  const { sql, origin } = state.result;
  return runSql(tabId, sql, origin);
}

/** Select first rows가 읽는 행 수. batch 하나다. */
const FIRST_ROWS = 500;

/**
 * 활성 탭의 접속으로 새 탭을 열어 relation의 앞 행을 조회한다. 지금 탭의 받다 만 결과와
 * 트랜잭션을 건드리지 않으려고 새 탭에서 한다.
 */
export async function selectFirstRows(
  relation: Relation,
  reservedWords: ReadonlySet<string>,
): Promise<void> {
  const name = `${quoteIdent(relation.schema, reservedWords)}.${quoteIdent(relation.name, reservedWords)}`;
  const sql = `SELECT * FROM ${name} LIMIT ${FIRST_ROWS}`;
  const tabId = useTabs.getState().newTab({ text: sql });
  return runSql(tabId, sql, { line: 1, column: 1 });
}

/**
 * 열린 트랜잭션이 있으면 어떻게 끝낼지, 저장하지 않은 변경이 있으면 저장할지 차례로 묻고,
 * 저장까지 끝난 뒤에 고른 대로 트랜잭션을 끝내고 세션을 놓은 뒤 탭을 닫는다. 저장 확인을
 * Cancel하거나 저장하지 못하면 트랜잭션을 끝내지 않는다.
 */
export async function closeTab(tabId: string): Promise<void> {
  if (findTab(tabId) === undefined) return;
  const settlement = await chooseSettlement([tabId], "close");
  if (settlement === null) return;
  const tab = findTab(tabId);
  if (tab === undefined) return;
  if (tab.dirty) {
    const choice = await ask({
      title: rt("dialog.closeTab.title", { title: mono(tab.title) }),
      body: t("dialog.closeTab.body"),
      actions: [
        {
          id: "discard",
          label: t("dialog.closeTab.discard"),
          variant: "ghost",
        },
        { id: "cancel", label: t("common.cancel"), spaceBefore: true },
        { id: "save", label: t("common.save"), variant: "primary" },
      ],
    });
    if (choice === "cancel") return;
    if (choice === "save") {
      // 이름 dialog는 활성 탭에만 그려지므로 저장하기 전에 이 탭을 활성으로 한다.
      useTabs.getState().activate(tabId);
      // 저장하지 못했으면(이름을 묻거나 실패했으면) 닫지 않는다.
      if ((await saveTab(tabId)) !== "saved") return;
    }
  }
  if (!(await applySettlement(settlement))) return;
  // release는 store에서 세션을 바로 떼어 낸다. 세션을 닫는 응답은 탭을 닫은 뒤에 기다린다.
  const released = useRuns.getState().release(tabId);
  useTabs.getState().close(tabId);
  await released;
}

/**
 * 지금 세션을 놓고 탭의 접속을 바꾼다. 다음 실행이 새 접속으로 세션을 연다. 모드는 그대로다.
 * 열린 트랜잭션이 있으면 먼저 묻는다. 같은 접속을 고르면 아무것도 하지 않는다.
 */
export async function changeConnection(
  tabId: string,
  connection: string | null,
): Promise<void> {
  const tab = findTab(tabId);
  if (tab === undefined || tab.connection === connection) return;
  const settled = await settleTransactions([tabId], "switchConnection", {
    target: connection ?? undefined,
  });
  if (!settled) return;
  const released = useRuns.getState().release(tabId);
  useTabs.getState().setConnection(tabId, connection);
  await released;
}

/** 탭의 세션이 쓰는 그 이름의 접속. Commit이 실패해 반영하지 못한 저장이 있으면 그 앞의 값이다. */
export function connectionInUse(name: string): Connection | undefined {
  const { project, unapplied } = useProject.getState();
  return unapplied[name] ?? project?.connections.find((c) => c.name === name);
}

/**
 * 접속을 저장한 뒤의 project를 반영한다. 연결 대상이 바뀐 접속을 쓰는 탭은 세션을 놓아서
 * 다음 실행이 새 대상으로 연다. 세션은 접속 이름이 같으면 다시 쓰이기 때문이다.
 * `saved`는 form에서 저장한 접속이다. 반영하지 못한 앞 접속은 그 접속만 비교한다. 다른 접속의
 * 탭은 저장하기 전에 묻지 않았으므로 놓지 않는다.
 */
export async function applySavedProject(
  project: Project,
  saved?: string,
): Promise<void> {
  const { project: before, unapplied } = useProject.getState();
  const changed = new Set(
    project.connections
      .filter((connection) => {
        const previous =
          connection.name === saved
            ? connectionInUse(connection.name)
            : before?.connections.find((c) => c.name === connection.name);
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
  const rest = Object.fromEntries(
    Object.entries(unapplied).filter(([name]) => name !== saved),
  );
  useProject.getState().applyProject(project, rest);
  // catalog도 새 대상으로 다시 읽는다. 쓰는 탭이 없는 접속은 닫기만 한다.
  const schema = useSchema.getState();
  const reloads = [...changed].map(async (name) => {
    await schema.forget(name);
    if (useTabs.getState().tabs.some((tab) => tab.connection === name)) {
      await useSchema.getState().ensure(name);
    }
  });
  await Promise.all([...released, ...reloads]);
}

/**
 * 대상을 바꿔 저장했지만 Commit이 실패했다. form이 파일의 값을 보이게 project는 반영하고, 탭의
 * 세션은 놓지 않는다. 탭의 세션이 쓰는 앞 접속을 남겨 두어 다음 저장이 그것과 비교해 묻고 놓는다.
 */
export function applySavedProjectKeepingSessions(project: Project): void {
  const unapplied = { ...useProject.getState().unapplied };
  for (const connection of project.connections) {
    const inUse = connectionInUse(connection.name);
    if (inUse !== undefined && targetChanged(connection, inUse)) {
      unapplied[connection.name] = inUse;
    } else {
      delete unapplied[connection.name];
    }
  }
  useProject.getState().applyProject(project, unapplied);
}

/**
 * 다른 프로젝트를 연다. 열리면 탭과 실행 상태를 비운다. 열린 트랜잭션을 묻고, 저장하지 않은 변경을
 * 묻고, 폴더를 고른 뒤에야 고른 대로 끝낸다. 폴더를 고르지 않으면 끝내지 않는다.
 *
 * Rollback은 보내지 않는다. 프로젝트가 열리면 Rust가 옛 세션을 닫아 서버가 되돌리고, 열지 못하면
 * 트랜잭션이 그대로 남는다. Commit은 세션이 닫히기 전, 열기 전에 보낸다. 그래서 Commit한 뒤에
 * 프로젝트를 열지 못하면 Commit만 된 채 남는다.
 */
export async function switchProject(): Promise<void> {
  const settlement = await chooseSettlement(
    useTabs.getState().tabs.map((tab) => tab.id),
    "switchProject",
  );
  if (settlement === null) return;
  let dir: string | null;
  try {
    dir = await askProjectDir();
  } catch (error) {
    useProject.getState().showError(messageOf(error));
    return;
  }
  if (dir === null) return;
  // 프로젝트를 열면 Rust가 옛 세션을 닫으므로 Commit은 그 전에 보낸다.
  if (settlement.end === "commit" && !(await applySettlement(settlement))) {
    return;
  }
  if (!(await useProject.getState().open(dir))) return;

  // 옛 프로젝트의 세션은 Rust가 이미 닫았으므로 그 close는 실패하고 무시된다.
  // 바꾸는 동안 실행이 새로 연 세션은 여기서 닫힌다.
  const closing = useRuns.getState().reset();
  useTabs.getState().reset();
  useTunnels.getState().reset();
  // 옛 프로젝트의 catalog 연결도 Rust가 이미 닫았다.
  useSchema.getState().reset();
  useTypes.getState().reset();
  await closing;
}

/** dirty 탭이 있으면 버릴지 묻고 디렉토리를 고르게 한다. 그만두면 null이다. */
async function askProjectDir(): Promise<string | null> {
  const dirty = useTabs.getState().tabs.filter((tab) => tab.dirty);
  if (dirty.length > 0) {
    const choice = await ask({
      title: tc("dialog.switchProject.title", dirty.length),
      items: dirty.map((tab) => ({ primary: tab.title, secondary: null })),
      note: t("dialog.switchProject.note"),
      actions: [
        { id: "cancel", label: t("common.cancel") },
        { id: "switch", label: t("dialog.switchProject.confirm") },
      ],
    });
    if (choice !== "switch") return null;
  }
  return pickDirectory();
}
