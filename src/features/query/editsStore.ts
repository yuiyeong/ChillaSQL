import { create } from "zustand";
import type { Cell } from "../../shared/api/types";
import type { Changes } from "./editSql";

/** 탭의 보이는 결과(`runKey`)에서 고친 셀. Apply하기 전까지 `result.rows`는 그대로다. */
export interface TabEdits {
  runKey: string;
  changes: Changes;
}

interface EditsState {
  /** tab id → 고친 셀. 고친 셀이 없으면 그 탭은 없다. */
  edits: Record<string, TabEdits>;
  /**
   * 셀 하나를 고친다. 다른 runKey의 변경은 버리고 시작한다. 원래 값과 같으면 그 변경을 지운다.
   * NULL인 셀을 빈 채 확정하면(`""`) NULL 그대로다.
   */
  setCell(
    tabId: string,
    runKey: string,
    row: number,
    attnum: number,
    value: Cell,
    original: Cell,
  ): void;
  revertCell(tabId: string, row: number, attnum: number): void;
  revertAll(tabId: string): void;
  /** 같은 탭의 다음 실행과 release가 묻지 않고 버린다. */
  drop(tabId: string): void;
  reset(): void;
}

/** 탭의 고친 셀을 `changes`로 바꾼다. 비면 그 탭을 지운다. 바뀌지 않은 행의 Map은 그대로 둔다. */
function withChanges(
  edits: Record<string, TabEdits>,
  tabId: string,
  runKey: string,
  changes: Changes,
): Record<string, TabEdits> {
  const next = { ...edits };
  if (changes.size === 0) delete next[tabId];
  else next[tabId] = { runKey, changes };
  return next;
}

/** `row`행의 `attnum`을 `value`로 두거나(undefined면 지운) 새 Changes. */
function changed(
  changes: Changes,
  row: number,
  attnum: number,
  value: Cell | undefined,
): Changes {
  const cells = new Map(changes.get(row));
  if (value === undefined) cells.delete(attnum);
  else cells.set(attnum, value);
  const next = new Map(changes);
  if (cells.size === 0) next.delete(row);
  else next.set(row, cells);
  return next;
}

export const useEdits = create<EditsState>()((set) => ({
  edits: {},

  setCell(tabId, runKey, row, attnum, value, original) {
    const stored = original === null && value === "" ? null : value;
    set((state) => {
      const current = state.edits[tabId];
      const base: Changes =
        current?.runKey === runKey ? current.changes : new Map();
      const changes = changed(
        base,
        row,
        attnum,
        stored === original ? undefined : stored,
      );
      return { edits: withChanges(state.edits, tabId, runKey, changes) };
    });
  },

  revertCell(tabId, row, attnum) {
    set((state) => {
      const current = state.edits[tabId];
      if (current === undefined) return state;
      const changes = changed(current.changes, row, attnum, undefined);
      return {
        edits: withChanges(state.edits, tabId, current.runKey, changes),
      };
    });
  },

  revertAll(tabId) {
    useEdits.getState().drop(tabId);
  },

  drop(tabId) {
    set((state) => {
      if (!(tabId in state.edits)) return state;
      const edits = { ...state.edits };
      delete edits[tabId];
      return { edits };
    });
  },

  reset() {
    set({ edits: {} });
  },
}));

/** 고친 셀 수 */
export function changedCount(edits: TabEdits | undefined): number {
  let count = 0;
  for (const cells of edits?.changes.values() ?? []) count += cells.size;
  return count;
}
