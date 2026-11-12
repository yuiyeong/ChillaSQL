import { create } from "zustand";
import {
  cancelQuery,
  closeSession,
  executeQuery,
  openSession,
} from "../../shared/api/commands";
import { isCommandError, messageOf } from "../../shared/api/errors";
import type { QueryEvent } from "../../shared/api/types";
import { emptyResult, reduce, type Origin, type RunState } from "./runReducer";

export interface RunRequest {
  connection: string;
  sql: string;
  origin: Origin;
}

/** 실행할 것을 정한다. 실행하지 않을 이유가 있으면 그 문구를 돌려준다. */
export type Prepare = () => Promise<RunRequest | string> | RunRequest | string;

export interface RunsState {
  /** tab id → 상태. 없으면 idle로 본다. */
  runs: Record<string, RunState>;
  /** `prepare`가 끝나기 전에 같은 탭의 다음 동작이 오면 실행하지 않는다. */
  run(tabId: string, prepare: Prepare): Promise<void>;
  cancel(tabId: string): Promise<void>;
  /** 탭을 닫거나 접속을 바꿀 때. 상태는 바로 지우고 세션을 닫는다. */
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
  // token은 탭마다 마지막 동작을 가리킨다. 번호를 다시 쓰지 않으므로 지우는 것도 token을 올리는 것이다.
  // 세션과 실행은 그 탭의 token이 있을 때만 생긴다.
  let lastToken = 0;
  const tokens = new Map<string, number>();
  const sessions = new Map<string, SessionSlot>();
  const executions = new Map<string, Execution>();

  function bump(tabId: string): number {
    lastToken += 1;
    tokens.set(tabId, lastToken);
    return lastToken;
  }

  function setRun(tabId: string, state: RunState): void {
    set((s) => ({ runs: { ...s.runs, [tabId]: state } }));
  }

  /** 그 탭의 세션이 아직 `slot`이면 잊는다. 잊었으면 true. */
  function forget(tabId: string, slot: SessionSlot): boolean {
    if (sessions.get(tabId) !== slot) return false;
    sessions.delete(tabId);
    return true;
  }

  /** 그 탭의 `connection` 세션. 없거나 접속이 다르면 앞 세션을 닫은 뒤 새로 연다. */
  function slotFor(tabId: string, connection: string): SessionSlot {
    const previous = sessions.get(tabId);
    if (previous?.connection === connection) return previous;
    const open = () => openSession(connection).then((session) => session.id);
    const opened =
      previous === undefined ? open() : closeSlot(previous).then(open);
    const slot: SessionSlot = {
      connection,
      id: null,
      opening: opened.then((id) => {
        slot.id = id;
        return id;
      }),
    };
    sessions.set(tabId, slot);
    return slot;
  }

  /** 그 탭의 token, 세션, 실행을 잊는다. 잊은 세션을 돌려준다. */
  function drop(tabId: string): SessionSlot | undefined {
    const slot = sessions.get(tabId);
    tokens.delete(tabId);
    sessions.delete(tabId);
    executions.delete(tabId);
    return slot;
  }

  return {
    runs: {},

    async run(tabId, prepare) {
      const token = bump(tabId);
      const current = () => tokens.get(tabId) === token;

      let request: RunRequest | string;
      try {
        // 바로 정해지면 기다리지 않는다. 같은 tick에 connecting이 보인다.
        const prepared = prepare();
        request = prepared instanceof Promise ? await prepared : prepared;
      } catch (error) {
        request = messageOf(error);
      }
      if (!current()) return;
      if (typeof request === "string") {
        setRun(tabId, { status: "rejected", message: request });
        return;
      }
      const { connection, sql, origin } = request;

      const slot = slotFor(tabId, connection);
      if (slot.id === null) setRun(tabId, { status: "connecting" });
      let sessionId: number;
      try {
        sessionId = await slot.opening;
      } catch (error) {
        forget(tabId, slot);
        if (current()) {
          setRun(tabId, { status: "rejected", message: messageOf(error) });
        }
        return;
      }
      if (!current()) return;

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
          forget(tabId, slot)
        ) {
          void closeSlot(slot);
        }
      };

      setRun(tabId, { status: "running", result: emptyResult(sql, origin) });
      const queryId = executeQuery(sessionId, sql, onEvent);
      executions.set(tabId, { sessionId, queryId });
      try {
        await queryId;
      } catch (error) {
        if (isCommandError(error, "unknown_session")) forget(tabId, slot);
        if (current()) {
          setRun(tabId, { status: "rejected", message: messageOf(error) });
        }
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
      set((s) => {
        const runs = { ...s.runs };
        delete runs[tabId];
        return { runs };
      });
      if (slot !== undefined) await closeSlot(slot);
    },

    async reset() {
      const slots = [...tokens.keys()]
        .map(drop)
        .filter((slot) => slot !== undefined);
      set({ runs: {} });
      await Promise.all(slots.map(closeSlot));
    },
  };
});
