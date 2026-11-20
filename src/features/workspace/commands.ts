import type { EditorState } from "@codemirror/state";
import {
  cancelTunnel,
  restartTunnel,
  splitStatements,
} from "../../shared/api/commands";
import { pickDirectory } from "../../shared/api/dialog";
import { isCommandError, messageOf } from "../../shared/api/errors";
import type {
  Project,
  Relation,
  StatementSpan,
  TxEnd,
} from "../../shared/api/types";
import { quoteIdent } from "../../shared/sql/identifiers";
import { sessionChanged } from "../connections/connectionValues";
import { isTunnelStarting, useTunnels } from "../connections/tunnelsStore";
import { documentState } from "../editor/documents";
import { showEditorNotice } from "../editor/editorNotice";
import { reformatDocument } from "../editor/reformat";
import { saveTab } from "../editor/saveTab";
import { anchorLocation, anchorOf } from "../editor/runMarks";
import { lineColumn, statementAt } from "../editor/statementAt";
import { statementSpansField } from "../editor/statementSpans";
import { useTabs } from "../editor/tabsStore";
import { connectionInUse, useProject } from "../project/projectStore";
import type {
  Rejection,
  Retry,
  RunRequest,
  ScriptStep,
} from "../query/runReducer";
import { endable, useRuns, type ConfirmStep } from "../query/runsStore";
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
  | "runFile"
  | "cancel"
  | "save"
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "commit"
  | "rollback"
  | "reformat";

function findTab(tabId: string) {
  return useTabs.getState().tabs.find((tab) => tab.id === tabId);
}

function splitRejection(error: unknown): Rejection {
  if (isCommandError(error, "split_failed")) {
    return {
      title: t("run.splitFailed.title"),
      detail: t("run.splitFailed.detail"),
    };
  }
  return { title: messageOf(error), detail: null };
}

/** 문서 전체의 문장 span. 문서에 둔 span이 지금 문서에 맞으면 다시 나누지 않는다. */
async function documentSpans(
  state: EditorState,
  text: string,
): Promise<StatementSpan[]> {
  const cached = state.field(statementSpansField, false);
  if (cached?.fresh && cached.spans !== null) return cached.spans;
  return splitStatements(text);
}

/** 문서 text에서 span의 문장 */
function stepOf(text: string, span: StatementSpan): ScriptStep {
  return {
    sql: text.slice(span.start, span.end),
    from: span.start,
    origin: lineColumn(text, span.start),
  };
}

/**
 * 선택 영역의 문장. 둘 이상으로 나뉘면 문장마다 step이고, 하나이거나 나눌 수 없으면 고른 그대로
 * 한 step이다.
 */
async function selectionSteps(
  docText: string,
  from: number,
  to: number,
): Promise<ScriptStep[] | Rejection> {
  const sql = docText.slice(from, to);
  if (sql.trim() === "") {
    return { title: t("run.emptySelection"), detail: null };
  }
  const whole = [{ sql, from, origin: lineColumn(docText, from) }];
  let spans: StatementSpan[];
  try {
    spans = await splitStatements(sql);
  } catch (error) {
    if (isCommandError(error, "split_failed")) return whole;
    return { title: messageOf(error), detail: null };
  }
  if (spans.length < 2) return whole;
  // span은 선택 영역의 text 기준이다.
  return spans.map((span) =>
    stepOf(docText, { start: from + span.start, end: from + span.end }),
  );
}

/** 선택 영역이 있으면 그것을, 없으면 커서가 가리키는 문장을 고른다. */
async function statementsToRun(
  tabId: string,
): Promise<ScriptStep[] | Rejection> {
  // 나누는 동안 문서가 바뀌거나 닫혀도 text, span, 커서가 한 snapshot에서 나오게 한 번만 읽는다.
  const state = documentState(tabId);
  const text = state.doc.toString();
  const { from, to, head } = state.selection.main;
  if (from !== to) return selectionSteps(text, from, to);

  let spans;
  try {
    spans = await documentSpans(state, text);
  } catch (error) {
    return splitRejection(error);
  }
  const span = statementAt(state.doc, spans, head);
  if (span === null) {
    return { title: t("run.noStatementAtCursor"), detail: null };
  }
  return [stepOf(text, span)];
}

/** 문서의 모든 문장. 문장이 없으면 Nothing to run이다. */
async function fileToRun(tabId: string): Promise<ScriptStep[] | Rejection> {
  const state = documentState(tabId);
  const text = state.doc.toString();
  let spans;
  try {
    spans = await documentSpans(state, text);
  } catch (error) {
    return splitRejection(error);
  }
  if (spans.length === 0) {
    return { title: t("run.emptyFile"), detail: null };
  }
  return spans.map((span) => stepOf(text, span));
}

function noConnection(): Rejection {
  return { title: t("run.noConnection"), detail: null };
}

/** 탭의 지금 접속으로 `steps`를 실행할 요청. 접속이 없으면 Rejection이다. */
function requestFor(
  tabId: string,
  steps: ScriptStep[],
): RunRequest | Rejection {
  const connection = findTab(tabId)?.connection ?? null;
  return connection === null ? noConnection() : { connection, steps };
}

/** 첫 문장이 위험하면 묻는다. 그만두게 했으면 null이다. Rejection은 그대로 돌려준다. */
async function confirmed(
  tabId: string,
  request: RunRequest | Rejection,
): Promise<RunRequest | Rejection | null> {
  if ("title" in request) return request;
  const [first] = request.steps;
  return (await confirmDanger(tabId, {
    connection: request.connection,
    sql: first.sql,
  }))
    ? request
    : null;
}

/** 여러 문장의 실행에서 둘째 문장부터 그 차례에 위험한 문장인지 묻는다. */
function confirmStepOf(tabId: string, connection: string): ConfirmStep {
  return (step) => confirmDanger(tabId, { connection, sql: step.sql });
}

/**
 * 탭에서 `choose`가 고른 문장을 실행한다. 위험한 문장이면 그 차례에 묻는다. 접속이 없으면 문장을
 * 나누지 않는다.
 */
function runSteps(
  tabId: string,
  choose: (tabId: string) => Promise<ScriptStep[] | Rejection>,
): Promise<void> {
  const connection = findTab(tabId)?.connection ?? null;
  // 문장을 나누는 동안 탭을 닫거나 접속을 바꾸면 release가 이 실행을 버린다.
  return useRuns.getState().run(
    tabId,
    async () => {
      if (connection === null) return noConnection();
      const steps = await choose(tabId);
      if ("title" in steps) return steps;
      return confirmed(tabId, requestFor(tabId, steps));
    },
    connection === null ? undefined : confirmStepOf(tabId, connection),
  );
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
      return runSteps(tabId, statementsToRun);
    case "runFile":
      return runSteps(tabId, fileToRun);
    case "cancel":
      return cancelRun(tabId);
    case "save":
      await saveTab(tabId);
      return;
    case "closeTab":
      return closeTab(tabId);
    case "reformat": {
      const result = reformatDocument(tabId);
      if (!result.ok) {
        showEditorNotice(t("toast.reformatFailed", { reason: result.reason }));
      }
      return;
    }
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

/** 탭의 지금 접속으로 문장 하나를 실행한다. 위험한 문장이면 묻는다. */
function runStep(tabId: string, step: ScriptStep): Promise<void> {
  return useRuns
    .getState()
    .run(tabId, () => confirmed(tabId, requestFor(tabId, [step])));
}

/**
 * 실행한 문장을 지금 문서에서 다시 할 자리. 문서가 옮긴 자리에서 시작한 것으로 본다. 문서가 그 자리를
 * 지웠으면 anchor 없이(from이 null) 처음 줄과 칸으로 한다.
 */
function movedStep(
  tabId: string,
  runKey: string,
  { sql, origin }: Pick<ScriptStep, "sql" | "origin">,
): ScriptStep {
  return {
    sql,
    from: anchorOf(tabId, runKey),
    origin: anchorLocation(tabId, runKey) ?? origin,
  };
}

/**
 * 그 탭의 결과에 쓴 SQL을 탭의 지금 접속으로 다시 실행한다. 보낸 text 그대로, 문서에서 옮겨진 자리에서
 * 시작한 것으로 본다. 결과가 없으면 아무것도 하지 않는다.
 */
export async function runAgain(tabId: string): Promise<void> {
  const state = useRuns.getState().runs[tabId];
  if (state?.status !== "running" && state?.status !== "finished") return;
  return runStep(tabId, movedStep(tabId, state.result.runKey, state.result));
}

/**
 * 터널 오류로 시작하지 못한 실행을 같은 접속으로 다시 한다(Try again). 문장마다 문서가 옮긴 자리를 쓴다.
 * 첫 문장은 처음 실행할 때 확인했으므로 묻지 않고, 둘째 문장부터 그 차례에 묻는다.
 */
export function retryRun(tabId: string, retry: Retry): Promise<void> {
  const { connection, runKeys } = retry;
  return useRuns.getState().run(
    tabId,
    () => ({
      connection,
      steps: retry.steps.map((step, index) =>
        movedStep(tabId, runKeys[index], step),
      ),
    }),
    confirmStepOf(tabId, connection),
  );
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
  return runStep(tabId, { sql, from: 0, origin: { line: 1, column: 1 } });
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

/**
 * 접속을 저장한 뒤의 project를 반영한다. 연결 대상이나 세션 설정(read-only, statement_timeout)이
 * 바뀐 접속을 쓰는 탭은 세션을 놓아서 다음 실행이 새 설정으로 연다. 세션은 접속 이름이 같으면 다시 쓰이기 때문이다.
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
        return previous !== undefined && sessionChanged(connection, previous);
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
    if (inUse !== undefined && sessionChanged(connection, inUse)) {
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
