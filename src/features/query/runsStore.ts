import { create } from "zustand";
import {
  cancelQuery,
  closeSession,
  executeQuery,
  fetchMore,
  openSession,
} from "../../shared/api/commands";
import {
  CommandError,
  isCommandError,
  messageOf,
} from "../../shared/api/errors";
import type { QueryEvent } from "../../shared/api/types";
import { clearGridViews, dropGridView } from "./gridViews";
import {
  emptyResult,
  reduce,
  requestFetch,
  type Rejection,
  type RunRequest,
  type RunState,
} from "./runReducer";

export type { RunRequest };

/** 실행할 것을 정한다. 실행하지 않을 이유가 있으면 그 Rejection을 돌려준다. */
export type Prepare = () =>
  Promise<RunRequest | Rejection> | RunRequest | Rejection;

function rejectionOf(error: unknown): Rejection {
  return { title: messageOf(error), detail: null };
}

/** 세션을 열지 못한 이유. 터널 오류면 stderr와 같은 실행을 다시 할 요청을 남긴다. */
function openRejection(error: unknown, request: RunRequest): Rejection {
  const rejection = rejectionOf(error);
  if (!(error instanceof CommandError) || !error.kind.startsWith("tunnel_")) {
    return rejection;
  }
  return error.output === null
    ? { ...rejection, retry: request }
    : { ...rejection, output: error.output, retry: request };
}

/** 탭에 띄우는 알림. `reconnected`는 끊긴 세션을 새 세션이 대신했다는 것이다. */
export type RunNotice = "reconnected";

interface RunsState {
  /** tab id → 상태. 없으면 idle로 본다. */
  runs: Record<string, RunState>;
  /** tab id → 알림. 그 탭의 다음 실행이 시작하거나 `dismissNotice`가 지운다. */
  notices: Record<string, RunNotice>;
  /** 그 접속을 쓰는 탭의 세션이 끊겼다(터널이 다시 시작됨). 다음 실행이 새 세션을 먼저 연 뒤 닫는다. */
  markStale(connection: string): void;
  dismissNotice(tabId: string): void;
  /**
   * `prepare`가 끝나기 전에 같은 탭의 다음 동작이 오면 실행하지 않는다. `prepare`가 Rejection을
   * 돌려주면 rejected로 두는데, 그 탭이 연결 중이거나 실행 중이면 아무것도 바꾸지 않는다.
   */
  run(tabId: string, prepare: Prepare): Promise<void>;
  cancel(tabId: string): Promise<void>;
  /**
   * 실행 중인 결과의 다음 batch를 요청한다. 앞 요청의 batch가 오기 전이거나 끝난 결과면
   * 보내지 않는다. 실패는 무시한다. 끝은 `finished`로 온다.
   */
  fetchMore(tabId: string): Promise<void>;
  /** 탭을 닫거나 접속을 바꿀 때. 상태와 결과 표의 view는 바로 지우고 세션을 닫는다. */
  release(tabId: string): Promise<void>;
  /** 모든 탭을 release한다. 프로젝트를 바꿀 때 */
  reset(): Promise<void>;
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

  function setNotice(tabId: string, notice: RunNotice | null): void {
    set((s) => {
      if (notice === null && !(tabId in s.notices)) return s;
      const notices = { ...s.notices };
      if (notice === null) delete notices[tabId];
      else notices[tabId] = notice;
      return { notices };
    });
  }

  /** 그 탭의 세션이 아직 `slot`이면 잊는다. 잊었으면 true. */
  function forget(tabId: string, slot: SessionSlot): boolean {
    if (sessions.get(tabId) !== slot) return false;
    sessions.delete(tabId);
    return true;
  }

  /** 세션이 끊겨 잊는다. 다음에 열리는 세션이 Reconnected를 알린다. */
  function forgetLost(tabId: string, slot: SessionSlot): boolean {
    if (!forget(tabId, slot)) return false;
    lost.add(tabId);
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
      opened = open().then(
        (id) => {
          void closeSlot(previous);
          return id;
        },
        (error: unknown) => {
          void closeSlot(previous);
          throw error;
        },
      );
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

  /** 그 탭의 attempt, token, 세션, 실행, 알림을 잊는다. 잊은 세션을 돌려준다. */
  function drop(tabId: string): SessionSlot | undefined {
    const slot = sessions.get(tabId);
    attempts.delete(tabId);
    tokens.delete(tabId);
    sessions.delete(tabId);
    executions.delete(tabId);
    lost.delete(tabId);
    return slot;
  }

  return {
    runs: {},
    notices: {},

    markStale(connection) {
      for (const slot of sessions.values()) {
        if (slot.connection === connection) slot.stale = true;
      }
    },

    dismissNotice(tabId) {
      setNotice(tabId, null);
    },

    async run(tabId, prepare) {
      const attempt = bump(attempts, tabId);
      setNotice(tabId, null);

      let request: RunRequest | Rejection;
      try {
        // 바로 정해지면 기다리지 않는다. 같은 tick에 connecting이 보인다.
        const prepared = prepare();
        request = prepared instanceof Promise ? await prepared : prepared;
      } catch (error) {
        request = rejectionOf(error);
      }
      // 그 사이 같은 탭에서 다시 실행했거나 release했다.
      if (attempts.get(tabId) !== attempt) return;
      if ("title" in request) {
        // 진행 중인 쿼리의 표시와 취소는 그대로 둔다.
        const status = get().runs[tabId]?.status;
        if (status === "connecting" || status === "running") return;
        bump(tokens, tabId);
        setRun(tabId, { status: "rejected", rejection: request });
        return;
      }
      const { connection, sql, origin } = request;

      const token = bump(tokens, tabId);
      const current = () => tokens.get(tabId) === token;

      const slot = slotFor(tabId, connection);
      if (slot.id === null) setRun(tabId, { status: "connecting" });
      let sessionId: number;
      try {
        sessionId = await slot.opening;
      } catch (error) {
        forget(tabId, slot);
        if (!current()) return;
        if (isCommandError(error, "tunnel_cancelled")) {
          setRun(tabId, { status: "idle" });
        } else {
          setRun(tabId, {
            status: "rejected",
            rejection: openRejection(error, request),
          });
        }
        return;
      }
      if (!current()) return;
      if (slot.replacesLost) {
        slot.replacesLost = false;
        setNotice(tabId, "reconnected");
      }

      const onEvent = (event: QueryEvent) => {
        if (current()) {
          set((s) => {
            const before = s.runs[tabId] ?? { status: "idle" };
            const after = reduce(before, event);
            return after === before
              ? s
              : { runs: { ...s.runs, [tabId]: after } };
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
      };

      setRun(tabId, {
        status: "running",
        result: emptyResult(sql, origin, Date.now()),
      });
      const queryId = executeQuery(sessionId, sql, onEvent);
      executions.set(tabId, { sessionId, queryId });
      try {
        await queryId;
      } catch (error) {
        if (isCommandError(error, "unknown_session")) forgetLost(tabId, slot);
        if (current()) {
          setRun(tabId, { status: "rejected", rejection: rejectionOf(error) });
        }
      }
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

    async release(tabId) {
      const slot = drop(tabId);
      dropGridView(tabId);
      set((s) => {
        const runs = { ...s.runs };
        delete runs[tabId];
        const notices = { ...s.notices };
        delete notices[tabId];
        return { runs, notices };
      });
      if (slot !== undefined) await closeSlot(slot);
    },

    async reset() {
      // token과 세션은 attempt가 있는 탭에만 있다.
      const slots = [...attempts.keys()]
        .map(drop)
        .filter((slot) => slot !== undefined);
      lost.clear();
      set({ runs: {}, notices: {} });
      clearGridViews();
      await Promise.all(slots.map(closeSlot));
    },
  };
});
