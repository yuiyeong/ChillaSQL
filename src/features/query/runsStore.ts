import { create } from "zustand";
import {
  cancelQuery,
  closeSession,
  executeQuery,
  openSession,
} from "../../shared/api/commands";
import { CommandError } from "../../shared/api/errors";
import type { QueryEvent } from "../../shared/api/types";
import { emptyResult, reduce, type Origin, type RunState } from "./runReducer";

export interface RunRequest {
  connection: string;
  sql: string;
  origin: Origin;
}

export interface RunsState {
  /** tab id → 상태. 없으면 idle로 본다. */
  runs: Record<string, RunState>;
  run(tabId: string, request: RunRequest): Promise<void>;
  reject(tabId: string, message: string): void;
  cancel(tabId: string): Promise<void>;
  /** 탭을 닫거나 접속을 바꿀 때 */
  release(tabId: string): Promise<void>;
  /** 프로젝트를 바꾼 뒤. 세션은 Rust가 이미 닫았다. */
  reset(): void;
}

/** 탭의 세션. `opening`은 세션 id로 끝난다(이미 열렸으면 끝난 promise). */
interface SessionSlot {
  connection: string;
  opening: Promise<number>;
}

interface Execution {
  sessionId: number;
  queryId: Promise<number>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  function openSlot(
    tabId: string,
    connection: string,
    previous: SessionSlot | undefined,
  ): SessionSlot {
    const open = () => openSession(connection).then((session) => session.id);
    const slot = {
      connection,
      opening: previous === undefined ? open() : closeSlot(previous).then(open),
    };
    sessions.set(tabId, slot);
    return slot;
  }

  return {
    runs: {},

    async run(tabId, { connection, sql, origin }) {
      const token = bump(tabId);
      const current = () => tokens.get(tabId) === token;

      let slot = sessions.get(tabId);
      if (slot === undefined || slot.connection !== connection) {
        setRun(tabId, { status: "connecting" });
        slot = openSlot(tabId, connection, slot);
      }
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

      const opened = slot;
      const onEvent = (event: QueryEvent) => {
        if (!current()) return;
        set((s) => {
          const before = s.runs[tabId] ?? { status: "idle" };
          const after = reduce(before, event);
          return after === before ? s : { runs: { ...s.runs, [tabId]: after } };
        });
        if (
          event.type === "finished" &&
          event.outcome === "connection_lost" &&
          forget(tabId, opened)
        ) {
          closeSession(sessionId).catch(() => {});
        }
      };

      setRun(tabId, { status: "running", result: emptyResult(sql, origin) });
      const queryId = executeQuery(sessionId, sql, onEvent);
      executions.set(tabId, { sessionId, queryId });
      try {
        await queryId;
      } catch (error) {
        if (error instanceof CommandError && error.kind === "unknown_session") {
          forget(tabId, opened);
        }
        if (current()) {
          setRun(tabId, { status: "rejected", message: messageOf(error) });
        }
      }
    },

    reject(tabId, message) {
      bump(tabId);
      setRun(tabId, { status: "rejected", message });
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
      const slot = sessions.get(tabId);
      tokens.delete(tabId);
      sessions.delete(tabId);
      executions.delete(tabId);
      set((s) => {
        const runs = { ...s.runs };
        delete runs[tabId];
        return { runs };
      });
      if (slot !== undefined) await closeSlot(slot);
    },

    reset() {
      tokens.clear();
      sessions.clear();
      executions.clear();
      set({ runs: {} });
    },
  };
});
