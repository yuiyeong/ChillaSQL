import { create } from "zustand";
import {
  cancelQuery,
  closeSession,
  endTransaction as sendEnd,
  executeQuery,
  fetchMore,
  openSession,
} from "../../shared/api/commands";
import {
  CommandError,
  isCommandError,
  messageOf,
} from "../../shared/api/errors";
import type {
  EndResult,
  QueryEvent,
  TxEnd,
  TxStatus,
} from "../../shared/api/types";
import { t } from "../../shared/i18n/t";
import { modeOf, useTabs } from "../editor/tabsStore";
import { markRunStart, markServerError } from "../editor/runAnchors";
import { useHistory } from "../history/historyStore";
import { useProject } from "../project/projectStore";
import { closeDdl } from "./ddlStore";
import { clearGridViews, dropGridView } from "./gridViews";
import { sourceOffset, type Rewrite } from "./rewrite";
import {
  emptyResult,
  reduce,
  requestFetch,
  type Rejection,
  type Retry,
  type RunRequest,
  type RunState,
  type ScriptStep,
} from "./runReducer";
import {
  canEndTransaction,
  nextTx,
  type TxCount,
  type TxInfo,
} from "./transaction";
import { useTypes } from "./typesStore";

/**
 * 실행할 것을 정한다. 실행하지 않을 이유가 있으면 그 Rejection을, 사용자가 그만두게 했으면(위험 쿼리
 * 확인에서 Cancel) null을 돌려준다. null이면 실행하지 않고 상태도 바꾸지 않는다.
 */
export type Prepare = () =>
  Promise<RunRequest | Rejection | null> | RunRequest | Rejection | null;

function rejectionOf(error: unknown): Rejection {
  return { title: messageOf(error), detail: null };
}

/** 세션을 열지 못한 이유. 터널 오류면 stderr와 같은 실행을 다시 할 요청을 남긴다. */
function openRejection(error: unknown, request: Retry): Rejection {
  const rejection = rejectionOf(error);
  if (!(error instanceof CommandError) || !error.kind.startsWith("tunnel_")) {
    return rejection;
  }
  return error.output === null
    ? { ...rejection, retry: request }
    : { ...rejection, output: error.output, retry: request };
}

/**
 * 문장이 둘 이상인 실행. 문장을 하나씩 보내고, 문장이 `completed`가 아니게 끝나면 거기서 멈춘다.
 * 지금 문장의 상태는 `runs[tabId]`에 두어 fetch, cancel, 트랜잭션 계산은 문장 하나의 실행과 같다.
 */
export interface ScriptRun {
  steps: ScriptStep[];
  /** 끝난 앞 문장의 고정된 결과. index는 문장 번호 - 1 */
  done: RunState[];
  /** runs[tabId]가 보이는 문장 */
  current: number;
  /** 결과 탭에서 고른 문장 */
  selected: number;
  /** 멈췄으면 그 문장. 끝까지 갔으면 null */
  stoppedAt: number | null;
}

/** 그 문장 차례에 보낼지 묻는다(위험한 문장 확인). false면 그 문장부터 보내지 않는다. */
export type ConfirmStep = (step: ScriptStep) => Promise<boolean>;

/**
 * 탭에 띄우는 알림. `reconnected`는 끊긴 세션을 새 세션이 대신했다는 것이고, `transactionLost`는
 * 열린 트랜잭션이 있던 세션이 끊겨 그 트랜잭션을 잃었다는 것이다.
 */
export type RunNotice =
  { kind: "reconnected" } | ({ kind: "transactionLost" } & TxCount);

/** record에서 key의 값을 바꾼다. `undefined`면 지운다. 바뀌지 않으면 같은 object를 돌려준다. */
function withEntry<T>(
  record: Record<string, T>,
  key: string,
  value: T | undefined,
): Record<string, T> {
  if (value !== undefined) {
    return record[key] === value ? record : { ...record, [key]: value };
  }
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** 끝내기 뒤의 트랜잭션. 끝내지 못했으면 상태만 서버가 알려 준 것으로 바꾼다. */
function txAfterEnd(
  current: TxInfo | undefined,
  tx: TxStatus | null,
): TxInfo | undefined {
  if (current === undefined || tx === null || tx === "idle") return undefined;
  return { ...current, status: tx === "failed" ? "failed" : "open" };
}

function endFailedTitle(end: TxEnd): string {
  return end === "commit" ? t("tx.commitFailed") : t("tx.rollbackFailed");
}

/** 끝내지 못한 이유를 결과 panel에 그릴 Rejection. 끝났거나 연결이 끊겼으면 null. */
function endRejection(result: EndResult, end: TxEnd): Rejection | null {
  const title = endFailedTitle(end);
  switch (result.outcome) {
    case "ended":
    case "connection_lost":
      return null;
    case "transaction_failed":
      return { title: t("tx.commitRefused"), detail: null };
    case "server_error":
      return {
        title,
        detail: `${result.error.message} · ${t("result.sqlstate", { code: result.error.code })}`,
      };
    case "client_error":
      return { title, detail: result.message };
  }
}

interface RunsState {
  /** tab id → 상태. 없으면 idle로 본다. 여러 문장의 실행이면 지금 문장의 상태다. */
  runs: Record<string, RunState>;
  /** tab id → 여러 문장의 실행. 문장이 둘 이상인 실행만 있다. */
  scripts: Record<string, ScriptRun>;
  /** tab id → 알림. 그 탭의 다음 실행이 시작하거나 `dismissNotice`가 지운다. */
  notices: Record<string, RunNotice>;
  /**
   * tab id → 지금 실행의 discarded가 Commit이나 Rollback 때문이다. 행을 받다 만 결과를 두고 끝내기를
   * 보낼 때 표시하고, 그 탭의 다음 실행이 시작하면 지운다.
   */
  discardedByEnd: Record<string, true>;
  /** tab id → 열린 트랜잭션. 트랜잭션이 열린 탭만 있다. */
  transactions: Record<string, TxInfo>;
  /**
   * Commit이나 Rollback을 보내고 답을 기다리는 탭 → 그 끝내기의 token. 늦게 끝난 끝내기는 token이
   * 같을 때만 지우므로 release 뒤의 다른 끝내기를 지우지 않는다.
   */
  ending: Record<string, object>;
  /**
   * 그 접속을 쓰는 탭의 세션이 끊겼다(터널이 다시 시작됨). 다음 실행이 새 세션을 먼저 연 뒤 닫는다.
   * 열린 트랜잭션은 바로 잃은 것으로 알린다.
   */
  markStale(connection: string): void;
  dismissNotice(tabId: string): void;
  /**
   * 그 탭의 트랜잭션을 Commit이나 Rollback한다. 끝났으면 true. 끝내지 못했으면 이유를 결과 panel에
   * 두고(연결이 끊겼으면 Transaction lost를 알리고) false. 세션이나 트랜잭션이 없으면 보내지 않고
   * true. 같은 탭의 끝내기가 답을 기다리는 중이면 보내지 않고 false. 사용자가 누르는 Commit과
   * Rollback이 지금 가능한지는 `endable`이 정한다.
   */
  endTransaction(tabId: string, end: TxEnd): Promise<boolean>;
  /**
   * 그 탭의 끝내기가 답을 기다리는 중이면 아무것도 하지 않는다. `prepare`가 끝나기 전에 같은 탭의
   * 다음 동작이 오면 실행하지 않는다. `prepare`가 Rejection을
   * 돌려주면 rejected로 두는데, 그 탭이 연결 중이거나 실행 중이면 아무것도 바꾸지 않는다.
   * null이면 아무것도 바꾸지 않는다.
   *
   * 문장이 둘 이상이면 한 세션에서 차례로 보낸다. 마지막이 아닌 문장은 끝까지 읽고 첫 batch만 받는다
   * (`drain`). 앞 문장이 `completed`로 끝나야 다음 문장을 보내고, 그 전에 `confirmStep`으로 묻는다.
   * 첫 문장은 `prepare`가 확인한다. 같은 탭에서 다시 실행하거나 release하면 다음 문장을 보내지 않는다.
   * promise는 첫 문장을 보내면 끝난다.
   */
  run(
    tabId: string,
    prepare: Prepare,
    confirmStep?: ConfirmStep,
  ): Promise<void>;
  /** 결과 탭에서 문장을 고른다. 결과가 있는 문장(지금 문장까지)만 고를 수 있다. */
  selectStep(tabId: string, index: number): void;
  cancel(tabId: string): Promise<void>;
  /**
   * 실행 중인 결과의 다음 batch를 요청한다. 앞 요청의 batch가 오기 전이거나 끝난 결과면
   * 보내지 않는다. 실패는 무시한다. 끝은 `finished`로 온다.
   */
  fetchMore(tabId: string): Promise<void>;
  /** 탭을 닫거나 접속을 바꿀 때. 상태, 여러 문장의 실행, 트랜잭션과 결과 표의 view는 바로 지우고 세션을 닫는다. */
  release(tabId: string): Promise<void>;
  /** 모든 탭을 release한다. 프로젝트를 바꿀 때 */
  reset(): Promise<void>;
}

/** 탭마다 값을 하나씩 두는 record 가운데 `setEntry`로 바꾸는 것과 그 값 */
interface Entries {
  scripts: ScriptRun;
  notices: RunNotice;
  discardedByEnd: true;
  transactions: TxInfo;
  ending: object;
}

/** 탭의 세션. `opening`은 세션 id로 끝난다(이미 열렸으면 끝난 promise). */
interface SessionSlot {
  connection: string;
  /** 열린 세션의 id. 여는 중이면 null */
  id: number | null;
  opening: Promise<number>;
  /** 터널이 다시 시작되어 이 세션은 끊겼다. 다음 실행이 새 세션으로 바꾼다. */
  stale: boolean;
  /** 끊긴 세션을 대신하려고 연 세션이다. 열리면 Reconnected를 알린다. */
  replacesLost: boolean;
}

interface Execution {
  sessionId: number;
  queryId: Promise<number>;
}

/**
 * 사용자가 그 탭의 트랜잭션을 지금 `end`로 끝낼 수 있는지(계획의 "가능한 때"). 트랜잭션이 있고,
 * 끝내기가 답을 기다리는 중이 아니고, 쿼리를 읽는 중이 아니어야 한다. 실패한 트랜잭션은 Rollback만
 * 된다. 단축키, toolbar 버튼, 결과 panel의 Rollback이 같이 쓴다.
 */
export function endable(
  state: Pick<RunsState, "runs" | "transactions" | "ending">,
  tabId: string,
  end: TxEnd,
): boolean {
  const tx = state.transactions[tabId];
  if (tx === undefined || state.ending[tabId] !== undefined) return false;
  if (end === "commit" && tx.status === "failed") return false;
  return canEndTransaction(state.runs[tabId]);
}

/**
 * 끝까지 읽는 문장(`drain`)의 실행 중 상태는 이어서 가져올 수 없다. Rust가 아직 읽는 중이므로
 * Commit과 Rollback도 처음 batch 전처럼 기다린다.
 */
function frozen(state: RunState, drain: boolean): RunState {
  if (!drain || state.status !== "running" || state.result.fetch === "none") {
    return state;
  }
  return { status: "running", result: { ...state.result, fetch: "none" } };
}

/** 세션이 열리면 닫는다. 열기와 닫기의 실패는 무시한다. */
async function closeSlot(slot: SessionSlot): Promise<void> {
  try {
    await closeSession(await slot.opening);
  } catch {
    // 열지 못했거나 이미 없는 세션이다.
  }
}

export const useRuns = create<RunsState>()((set, get) => {
  // 아래 값은 화면이 그리지 않으므로 store 밖에 둔다.
  // 번호는 탭마다 둘이다. attempt는 마지막으로 누른 실행을, token은 마지막으로 시작한 실행을
  // 가리킨다. event는 token이 같을 때만 반영하므로, 시작하지 못한 실행은 진행 중인 쿼리를
  // 화면에서 떼어 내지 않는다. 번호를 다시 쓰지 않으므로 지우는 것도 무효로 하는 것이다.
  // 세션과 실행은 그 탭의 token이 있을 때만 생긴다.
  let lastNumber = 0;
  const attempts = new Map<string, number>();
  const tokens = new Map<string, number>();
  const sessions = new Map<string, SessionSlot>();
  const executions = new Map<string, Execution>();
  // 탭의 트랜잭션에 null이 아닌 tx를 마지막으로 반영한 실행의 token.
  const txReads = new Map<string, number>();
  // 탭마다 마지막으로 보낸 Commit이나 Rollback의 번호. 여러 문장의 실행은 그 사이 끝내기가 있었으면
  // 다음 문장을 보내지 않는다.
  const ends = new Map<string, number>();
  // 세션이 끊겨(connection_lost, unknown_session) 잊은 탭. 다음 세션이 열리면 Reconnected를 알린다.
  const lost = new Set<string>();

  function bump(numbers: Map<string, number>, tabId: string): number {
    lastNumber += 1;
    numbers.set(tabId, lastNumber);
    return lastNumber;
  }

  function setRun(tabId: string, state: RunState): void {
    set((s) => ({ runs: { ...s.runs, [tabId]: state } }));
  }

  /** 탭을 `state`로 두고 여러 문장 실행의 상태는 치운다. */
  function settle(tabId: string, state: RunState): void {
    set((s) => ({
      runs: { ...s.runs, [tabId]: state },
      scripts: withEntry(s.scripts, tabId, undefined),
    }));
  }

  /** 실행하지 못한 이유를 보인다. 여러 문장의 실행이었으면 결과 탭 없이 이유만 보인다. */
  function reject(tabId: string, rejection: Rejection): void {
    settle(tabId, { status: "rejected", rejection });
  }

  /** 그 탭의 여러 문장 실행을 바꾼다. 없거나 바뀌지 않으면 state를 그대로 둔다. */
  function updateScript(
    tabId: string,
    change: (script: ScriptRun) => ScriptRun,
  ): void {
    set((s) => {
      const script = s.scripts[tabId];
      if (script === undefined) return s;
      const next = change(script);
      return next === script ? s : { scripts: { ...s.scripts, [tabId]: next } };
    });
  }

  /**
   * 여러 문장의 실행을 `index` 문장에서 멈춘다. 그 뒤 문장은 보내지 않는다. 마지막 문장이면 남은 문장이
   * 없으므로 끝까지 간 것이다.
   */
  function stopScript(tabId: string, index: number): void {
    updateScript(tabId, (script) => ({
      ...script,
      selected: index,
      stoppedAt: index < script.steps.length - 1 ? index : null,
    }));
  }

  /** 탭마다의 record에서 그 탭의 값을 바꾼다. `undefined`면 지운다. 바뀌지 않으면 state를 그대로 둔다. */
  function setEntry<K extends keyof Entries>(
    key: K,
    tabId: string,
    value: Entries[K] | undefined,
  ): void {
    set((s) => {
      const record = s[key] as Record<string, Entries[K]>;
      const next = withEntry(record, tabId, value);
      return next === record ? s : ({ [key]: next } as Partial<RunsState>);
    });
  }

  function setNotice(tabId: string, notice: RunNotice | null): void {
    setEntry("notices", tabId, notice ?? undefined);
  }

  function setTx(tabId: string, tx: TxInfo | undefined): void {
    setEntry("transactions", tabId, tx);
  }

  /** 세션이 끊겨 그 탭의 트랜잭션을 잃었다. 열려 있었으면 Transaction lost를 알린다. */
  function loseTransaction(tabId: string): void {
    const tx = get().transactions[tabId];
    if (tx === undefined) return;
    setTx(tabId, undefined);
    setNotice(tabId, {
      kind: "transactionLost",
      statements: tx.statements,
      openedBy: tx.openedBy,
    });
  }

  /** 그 탭의 세션이 아직 `slot`이면 잊는다. 잊었으면 true. */
  function forget(tabId: string, slot: SessionSlot): boolean {
    if (sessions.get(tabId) !== slot) return false;
    sessions.delete(tabId);
    return true;
  }

  /** 세션이 끊겨 잊는다. 다음에 열리는 세션이 Reconnected를 알린다. 열린 트랜잭션은 잃는다. */
  function forgetLost(tabId: string, slot: SessionSlot): boolean {
    if (!forget(tabId, slot)) return false;
    lost.add(tabId);
    loseTransaction(tabId);
    return true;
  }

  /**
   * 그 탭의 `connection` 세션. 없거나 접속이 다르면 앞 세션을 닫은 뒤 새로 연다. 앞 세션이 stale이면
   * 새 세션을 *먼저* 연 뒤 닫는다. 먼저 닫으면 그 접속의 터널을 쓰는 세션이 없어져 막 살린 터널이 꺼진다.
   */
  function slotFor(tabId: string, connection: string): SessionSlot {
    const previous = sessions.get(tabId);
    if (previous?.connection === connection && !previous.stale) return previous;
    const open = () => openSession(connection).then((session) => session.id);
    let opened: Promise<number>;
    if (previous === undefined) {
      opened = open();
    } else if (previous.stale) {
      opened = open().finally(() => void closeSlot(previous));
    } else {
      opened = closeSlot(previous).then(open);
    }
    const slot: SessionSlot = {
      connection,
      id: null,
      stale: false,
      replacesLost:
        (previous?.stale === true && previous.connection === connection) ||
        lost.has(tabId),
      opening: opened.then((id) => {
        slot.id = id;
        return id;
      }),
    };
    lost.delete(tabId);
    sessions.set(tabId, slot);
    return slot;
  }

  /** 그 탭의 attempt, token, 세션, 실행을 잊는다. 잊은 세션을 돌려준다. */
  function drop(tabId: string): SessionSlot | undefined {
    const slot = sessions.get(tabId);
    attempts.delete(tabId);
    tokens.delete(tabId);
    sessions.delete(tabId);
    executions.delete(tabId);
    txReads.delete(tabId);
    ends.delete(tabId);
    lost.delete(tabId);
    return slot;
  }

  return {
    runs: {},
    scripts: {},
    notices: {},
    discardedByEnd: {},
    transactions: {},
    ending: {},

    markStale(connection) {
      // 여는 중인 세션은 다시 시작된 터널로 붙으므로 그대로 둔다.
      for (const [tabId, slot] of sessions) {
        if (slot.connection === connection && slot.id !== null) {
          slot.stale = true;
          loseTransaction(tabId);
        }
      }
    },

    dismissNotice(tabId) {
      setNotice(tabId, null);
    },

    async run(tabId, prepare, confirmStep) {
      // Commit이나 Rollback의 답을 기다리는 동안은 그 세션에 쿼리를 보내지 않는다.
      if (get().ending[tabId]) return;
      // 기록은 실행을 시작한 프로젝트에 남긴다. 프로젝트를 바꾼 뒤 옛 실행의 늦은 event가 와도 새 프로젝트에 쓰지 않는다.
      const projectDir = useProject.getState().project?.dir ?? null;
      const attempt = bump(attempts, tabId);

      let request: RunRequest | Rejection | null;
      try {
        // 바로 정해지면 기다리지 않는다. 같은 tick에 connecting이 보인다.
        const prepared = prepare();
        request = prepared instanceof Promise ? await prepared : prepared;
      } catch (error) {
        request = rejectionOf(error);
      }
      // 그 사이 같은 탭에서 다시 실행했거나 release했다.
      if (attempts.get(tabId) !== attempt) return;
      if (request === null) return;
      // 보낼 실행이 정해졌다. 결과 panel을 덮고 있던 DDL을 닫아 이 실행의 결과가 보이게 한다.
      closeDdl(tabId);
      setNotice(tabId, null);
      setEntry("discardedByEnd", tabId, undefined);
      if ("title" in request) {
        // 진행 중인 쿼리의 표시와 취소는 그대로 둔다.
        const status = get().runs[tabId]?.status;
        if (status === "connecting" || status === "running") return;
        bump(tokens, tabId);
        reject(tabId, request);
        return;
      }
      const { connection, steps } = request;

      const token = bump(tokens, tabId);
      // 문장마다 key를 두어 오류 밑줄, Go to error, 결과 표의 view가 그 문장을 가리킨다.
      const runKeys = steps.map((_, index) => `run-${token}-${index}`);
      // 이 실행의 문장이 문서에서 시작한 곳을 문서에 두고, 지난 실행의 오류 밑줄을 지운다. 세션을 여는
      // 동안의 편집도 따라 옮긴다. 문서에 자리가 없는 문장은 두지 않는다.
      markRunStart(
        tabId,
        steps.flatMap(({ from }, index) =>
          from === null ? [] : [{ runKey: runKeys[index], from }],
        ),
      );
      dropGridView(tabId);
      setEntry(
        "scripts",
        tabId,
        steps.length > 1
          ? { steps, done: [], current: 0, selected: 0, stoppedAt: null }
          : undefined,
      );
      const current = () => tokens.get(tabId) === token;
      const endBefore = ends.get(tabId);

      const slot = slotFor(tabId, connection);
      if (slot.id === null) setRun(tabId, { status: "connecting" });
      let sessionId: number;
      try {
        sessionId = await slot.opening;
      } catch (error) {
        forget(tabId, slot);
        if (!current()) return;
        if (isCommandError(error, "tunnel_cancelled")) {
          settle(tabId, { status: "idle" });
        } else {
          reject(tabId, openRejection(error, { connection, steps, runKeys }));
        }
        return;
      }
      if (!current()) return;
      if (slot.replacesLost) {
        slot.replacesLost = false;
        setNotice(tabId, { kind: "reconnected" });
      }

      // 문장 수는 보낸 모드로 센다. 실행 중에 탭의 모드가 바뀌어도 이 실행은 이 모드다.
      const mode = modeOf(useTabs.getState(), tabId);
      /**
       * 끝난 실행의 tx를 탭의 트랜잭션에 반영할지. actor는 tx를 문장이 끝나고(버린 문장은 되돌린 뒤)
       * 다음 문장 전에 읽으므로, 이 탭의 세션에서 온 null이 아닌 tx는 그때의 상태다. 다만
       * - stale 세션은 이미 트랜잭션을 잃은 것으로 알렸으므로 늦은 finished가 그 트랜잭션을 되살리지 않는다.
       * - 밀려난 실행은 그 세션이 아직 이 탭의 것일 때만 반영한다.
       * - 뒤에 시작한 실행이 이미 tx를 알렸으면 늦게 온 앞 실행의 tx는 지난 값이다.
       * - Commit이나 Rollback이 버린 쿼리의 tx는 끝내기 앞의 값이므로 끝내기의 결과가 정한다.
       */
      const appliesTx = (
        s: RunsState,
        event: Extract<QueryEvent, { type: "finished" }>,
        fresh: boolean,
      ): boolean => {
        if (slot.stale) return false;
        if (!fresh && sessions.get(tabId) !== slot) return false;
        if (token < (txReads.get(tabId) ?? 0)) return false;
        return !(
          event.outcome === "discarded" &&
          (s.ending[tabId] !== undefined || s.discardedByEnd[tabId])
        );
      };

      /** `index` 문장을 보낸다. 앞 문장의 끝난 결과는 고정해 둔다. */
      const sendStep = async (index: number): Promise<void> => {
        const step = steps[index];
        const runKey = runKeys[index];
        // 마지막이 아닌 문장은 Rust가 끝까지 읽고 첫 batch만 보낸다. 버리면 cancel이 되어 변경이 되돌려진다.
        const drain = index < steps.length - 1;
        // 문장마다 따로 센다. 트랜잭션을 연 문장의 시각이 트랜잭션의 시작이다.
        const startedAt = Date.now();
        // 실행 하나는 첫 rows나 버리지 않은 finished에서 한 번 기록한다.
        let recorded = false;

        const onEvent = (sent: QueryEvent) => {
          const event = inSource(sent, step.rewrite);
          // 서버에 가서 답이 온 실행은 화면이 밀려난 것이어도 기록한다. 버린 실행(discarded)은 답이
          // 아니므로 기록하지 않는다.
          if (
            !recorded &&
            (event.type === "rows" ||
              (event.type === "finished" && event.outcome !== "discarded"))
          ) {
            recorded = true;
            void useHistory.getState().record(projectDir, {
              connection,
              sql: step.sql,
              executedAt: startedAt,
              elapsedMicros: event.elapsedMicros,
            });
          }
          // 세션이 죽었다. 늦은 event여도 그 세션이 아직 이 탭의 것이면 버린다.
          if (
            event.type === "finished" &&
            event.outcome === "connection_lost" &&
            forgetLost(tabId, slot)
          ) {
            void closeSlot(slot);
          }
          const fresh = current();
          if (!fresh && event.type !== "finished") return;
          if (
            fresh &&
            event.type === "finished" &&
            event.outcome === "failed" &&
            event.error.position !== null
          ) {
            markServerError(tabId, runKey, event.error.position);
          }
          // header의 type 이름은 접속의 catalog connection이 답한다. 밀려난 실행이 묻으면 이미 닫은
          // catalog connection(과 터널)을 다시 연다.
          if (event.type === "columns") {
            void useTypes.getState().ensure(connection, event.columns);
          }
          set((s) => {
            const before = s.runs[tabId] ?? { status: "idle" };
            const after = fresh ? frozen(reduce(before, event), drain) : before;
            const runs =
              after === before ? s.runs : { ...s.runs, [tabId]: after };
            if (event.type !== "finished" || !appliesTx(s, event, fresh)) {
              return runs === s.runs ? s : { runs };
            }
            // 밀려난 실행은 화면에 결과가 남지 않으므로 세지 않고 상태만 따른다.
            const tx = nextTx(
              s.transactions[tabId] ?? null,
              event.tx,
              event.outcome,
              mode,
              startedAt,
              fresh,
            );
            if (event.tx !== null) txReads.set(tabId, token);
            const transactions = withEntry(
              s.transactions,
              tabId,
              tx ?? undefined,
            );
            return runs === s.runs && transactions === s.transactions
              ? s
              : { runs, transactions };
          });
          if (fresh && event.type === "finished" && tabId in get().scripts) {
            if (event.outcome !== "completed") {
              stopScript(tabId, index);
            } else if (drain) {
              void nextStep(index + 1);
            }
          }
        };

        set((s) => {
          const running: RunState = {
            status: "running",
            result: emptyResult(step, runKey, startedAt),
          };
          const runs = { ...s.runs, [tabId]: running };
          const script = s.scripts[tabId];
          if (script === undefined) return { runs };
          // 앞 문장의 결과는 `runs`에서 `done`으로 옮긴다. 결과 탭은 지금 문장을 따라간다.
          const previous = s.runs[tabId];
          const done =
            index === 0 || previous === undefined
              ? script.done
              : [...script.done, previous];
          return {
            runs,
            scripts: {
              ...s.scripts,
              [tabId]: { ...script, done, current: index, selected: index },
            },
          };
        });
        const queryId = executeQuery(sessionId, step.sql, mode, onEvent, {
          drain,
        });
        executions.set(tabId, { sessionId, queryId });
        try {
          await queryId;
        } catch (error) {
          if (isCommandError(error, "unknown_session")) forgetLost(tabId, slot);
          if (!current()) return;
          if (tabId in get().scripts) {
            // 앞 문장의 결과(Auto면 이미 Commit됨)는 남기고 이 문장의 결과로 이유를 보인다.
            setRun(tabId, {
              status: "rejected",
              rejection: rejectionOf(error),
            });
            stopScript(tabId, index);
          } else {
            reject(tabId, rejectionOf(error));
          }
        }
      };

      /** 앞 문장이 끝났다. `index` 문장의 차례에 묻고 보낸다. 보내지 않으면 앞 문장에서 멈춘다. */
      const nextStep = async (index: number): Promise<void> => {
        let confirmed = true;
        if (confirmStep !== undefined) {
          try {
            confirmed = await confirmStep(steps[index]);
          } catch {
            confirmed = false;
          }
        }
        if (!current()) return;
        // 실행을 시작한 뒤 Commit이나 Rollback을 보냈거나(끝났어도) 세션이 끊겼으면 다음 문장을 보내지 않는다.
        if (
          !confirmed ||
          ends.get(tabId) !== endBefore ||
          sessions.get(tabId) !== slot ||
          slot.stale
        ) {
          stopScript(tabId, index - 1);
          return;
        }
        await sendStep(index);
      };

      await sendStep(0);
    },

    selectStep(tabId, index) {
      updateScript(tabId, (script) =>
        index < 0 || index > script.current || index === script.selected
          ? script
          : { ...script, selected: index },
      );
    },

    async fetchMore(tabId) {
      const execution = executions.get(tabId);
      const before = get().runs[tabId] ?? { status: "idle" };
      const after = requestFetch(before);
      if (after === before || execution === undefined) return;
      setRun(tabId, after);
      try {
        await fetchMore(execution.sessionId, await execution.queryId);
      } catch {
        // 끝은 finished event로 온다.
      }
    },

    async cancel(tabId) {
      const execution = executions.get(tabId);
      if (get().runs[tabId]?.status !== "running" || execution === undefined) {
        return;
      }
      try {
        await cancelQuery(execution.sessionId, await execution.queryId);
      } catch {
        // 쿼리의 결과는 event로 온다.
      }
    },

    async endTransaction(tabId, end) {
      if (get().ending[tabId]) return false;
      const slot = sessions.get(tabId);
      const sessionId = slot?.id ?? null;
      if (slot === undefined || sessionId === null) return true;
      if (!(tabId in get().transactions)) return true;
      const call = {};
      setEntry("ending", tabId, call);
      bump(ends, tabId);
      // 행을 받다 만 쿼리는 끝내기가 버린다. 그 discarded는 다음 쿼리가 아니라 끝내기 때문이다.
      if (get().runs[tabId]?.status === "running") {
        setEntry("discardedByEnd", tabId, true);
      }
      // 이 token이 그대로면 끝내기를 보낸 뒤 시작한 실행이 없다.
      const token = tokens.get(tabId);
      const owns = () => sessions.get(tabId) === slot;

      let result: EndResult | null = null;
      let rejection: Rejection | null = null;
      try {
        result = await sendEnd(sessionId, end);
      } catch (error) {
        if (isCommandError(error, "unknown_session")) {
          forgetLost(tabId, slot);
        } else {
          rejection = { title: endFailedTitle(end), detail: messageOf(error) };
        }
      } finally {
        if (get().ending[tabId] === call) {
          setEntry("ending", tabId, undefined);
          // 끝내지 못했으면 그 결과의 discarded는 끝내기 때문이 아니다.
          if (result?.outcome !== "ended") {
            setEntry("discardedByEnd", tabId, undefined);
          }
        }
      }

      if (result?.outcome === "connection_lost") {
        if (forgetLost(tabId, slot)) void closeSlot(slot);
        return false;
      }
      // release했거나 세션이 바뀌었으면 이 탭의 상태를 건드리지 않는다.
      if (!owns()) return result?.outcome === "ended";
      if (result !== null) {
        setTx(tabId, txAfterEnd(get().transactions[tabId], result.tx));
        rejection = endRejection(result, end);
      }
      if (rejection !== null && tokens.get(tabId) === token) {
        // 끝내기 앞에서 버려진 쿼리의 늦은 event가 이 표시를 덮지 않게 한다.
        bump(tokens, tabId);
        reject(tabId, rejection);
      }
      return result?.outcome === "ended";
    },

    async release(tabId) {
      closeDdl(tabId);
      const slot = drop(tabId);
      dropGridView(tabId);
      set((s) => ({
        runs: withEntry(s.runs, tabId, undefined),
        scripts: withEntry(s.scripts, tabId, undefined),
        notices: withEntry(s.notices, tabId, undefined),
        discardedByEnd: withEntry(s.discardedByEnd, tabId, undefined),
        transactions: withEntry(s.transactions, tabId, undefined),
        ending: withEntry(s.ending, tabId, undefined),
      }));
      if (slot !== undefined) await closeSlot(slot);
    },

    async reset() {
      // token과 세션은 attempt가 있는 탭에만 있다.
      const slots = [...attempts.keys()]
        .map(drop)
        .filter((slot) => slot !== undefined);
      lost.clear();
      set({
        runs: {},
        scripts: {},
        notices: {},
        discardedByEnd: {},
        transactions: {},
        ending: {},
      });
      clearGridViews();
      await Promise.all(slots.map(closeSlot));
    },
  };
});

/**
 * 실패한 문장의 오류 위치를 보낸 text의 offset에서 문서 문장 text의 offset으로 옮긴다. 저장한 결과의
 * position은 언제나 문서 문장 기준이라 밑줄, Ln/Col, Go to error가 따로 옮기지 않는다.
 */
function inSource(event: QueryEvent, rewrite: Rewrite | undefined): QueryEvent {
  if (
    rewrite === undefined ||
    event.type !== "finished" ||
    event.outcome !== "failed" ||
    event.error.position === null
  ) {
    return event;
  }
  return {
    ...event,
    error: {
      ...event.error,
      position: sourceOffset(rewrite, event.error.position),
    },
  };
}
