import { create } from "zustand";
import type { ApplyResult, Cell } from "../../shared/api/types";
import { formatCount, t, tc } from "../../shared/i18n/t";
import type { Changes, UpdateStatement } from "./editSql";
import { applyBlocked, useRuns, withEntry } from "./runsStore";

/** 탭의 보이는 결과(`runKey`)에서 고친 셀. Apply하기 전까지 `result.rows`는 그대로다. */
export interface TabEdits {
  runKey: string;
  changes: Changes;
}

interface EditsState {
  /** tab id → 고친 셀. 고친 셀이 없으면 그 탭은 없다. */
  edits: Record<string, TabEdits>;
  /** Apply의 답을 기다리는 탭 */
  applying: Record<string, true>;
  /** tab id → Apply하지 못한 이유(note 문구). 그 탭의 다음 Apply의 답이나 편집이 지운다. */
  failure: Record<string, string>;
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
  /**
   * 그 탭의 고친 셀을 `statements`(미리 보기의 UPDATE 문)로 반영한다. 반영했으면 보낸 셀 가운데
   * 보낸 값 그대로인 것만 지우고(답을 기다리는 동안 고친 셀은 남는다) toast 문구(`Updated 2 rows`)를
   * 돌려준다. 반영하지 못했으면 고친 셀을 두고 이유를 `failure`에 둔다. 세션이 없어 보내지 못한 것도
   * 이유를 둔다(실행 중이거나 끝내기를 기다려 보내지 않았으면 두지 않는다). 고친 셀이 없거나 Apply를
   * 기다리는 중이면 보내지 않는다.
   */
  apply(tabId: string, statements: UpdateStatement[]): Promise<string | null>;
  reset(): void;
}

/** 탭의 고친 셀을 `changes`로 바꾼다. 비면 그 탭을 지운다. 바뀌지 않은 행의 Map은 그대로 둔다. */
function withChanges(
  edits: Record<string, TabEdits>,
  tabId: string,
  runKey: string,
  changes: Changes,
): Record<string, TabEdits> {
  return withEntry(
    edits,
    tabId,
    changes.size === 0 ? undefined : { runKey, changes },
  );
}

/** record에서 key를 지운다. 없으면 같은 object를 돌려준다. */
function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  return withEntry(record, key, undefined);
}

/** 반영하지 못한 Apply의 note 문구. `{row}`는 1부터 센 결과 행 번호다. */
function failureText(
  result: Exclude<ApplyResult, { outcome: "applied" }>,
  statements: UpdateStatement[],
): string {
  const rowOf = (index: number) => statements[index].row + 1;
  switch (result.outcome) {
    case "wrong_row_count":
      return result.rows === 0
        ? t("edit.notFound", { row: rowOf(result.index) })
        : t("edit.matchedMany", {
            row: rowOf(result.index),
            count: formatCount(result.rows),
          });
    case "failed":
      return result.index === null
        ? t("edit.failedCommit", { message: result.error.message })
        : t("edit.failedRow", {
            row: rowOf(result.index),
            message: result.error.message,
          });
    case "transaction_failed":
      return t("edit.txFailed");
    case "busy":
      return t("edit.busy");
    case "connection_lost":
    case "client_error":
      return t("edit.failedCommit", { message: result.message });
  }
}

/**
 * Apply가 반영한 셀을 지운 Changes. `statements`의 셀 가운데 지금 값이 보낸 값(`sent`)과 같은 것만
 * 지운다. 답을 기다리는 동안 다시 고친 셀과 보내지 않은 셀은 남는다.
 */
function withoutApplied(
  changes: Changes,
  sent: Changes,
  statements: UpdateStatement[],
): Changes {
  // 바깥 Map은 한 번만 복사한다. 지운 셀이 없는 행의 Map은 그대로 둔다.
  let next: Changes | null = null;
  for (const { row, attnums } of statements) {
    const current = (next ?? changes).get(row);
    const sentCells = sent.get(row);
    if (current === undefined || sentCells === undefined) continue;
    let cells: Map<number, Cell> | null = null;
    for (const attnum of attnums) {
      const value = sentCells.get(attnum);
      if (value !== undefined && current.get(attnum) === value) {
        (cells ??= new Map(current)).delete(attnum);
      }
    }
    if (cells === null) continue;
    next ??= new Map(changes);
    if (cells.size === 0) next.delete(row);
    else next.set(row, cells);
  }
  return next ?? changes;
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

export const useEdits = create<EditsState>()((set, get) => ({
  edits: {},
  applying: {},
  failure: {},

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
      return {
        edits: withChanges(state.edits, tabId, runKey, changes),
        failure: without(state.failure, tabId),
      };
    });
  },

  revertCell(tabId, row, attnum) {
    set((state) => {
      const current = state.edits[tabId];
      if (current === undefined) return state;
      const changes = changed(current.changes, row, attnum, undefined);
      return {
        edits: withChanges(state.edits, tabId, current.runKey, changes),
        failure: without(state.failure, tabId),
      };
    });
  },

  revertAll(tabId) {
    useEdits.getState().drop(tabId);
  },

  drop(tabId) {
    set((state) => {
      const edits = without(state.edits, tabId);
      const failure = without(state.failure, tabId);
      return edits === state.edits && failure === state.failure
        ? state
        : { edits, failure };
    });
  },

  async apply(tabId, statements) {
    const current = get().edits[tabId];
    if (current === undefined || get().applying[tabId]) return null;
    // 앞 Apply의 이유는 답이 올 때까지 둔다.
    set((state) => ({ applying: withEntry(state.applying, tabId, true) }));
    let result: ApplyResult | null;
    try {
      result = await useRuns
        .getState()
        .applyEdits(tabId, current.runKey, statements);
    } finally {
      set((state) => ({ applying: without(state.applying, tabId) }));
    }
    // 그 사이 다시 실행했거나 release해서(Revert도) 고친 셀이 이 결과의 것이 아니면 건드리지 않는다.
    if (get().edits[tabId]?.runKey !== current.runKey) return null;
    if (result?.outcome === "applied") {
      set((state) => {
        const latest = state.edits[tabId]!;
        const changes = withoutApplied(
          latest.changes,
          current.changes,
          statements,
        );
        return {
          edits: withChanges(state.edits, tabId, latest.runKey, changes),
          failure: without(state.failure, tabId),
        };
      });
      return tc("edit.updated", statements.length);
    }
    // 실행 중이거나 끝내기를 기다려 보내지 않은 것은 버튼이 막으므로 이유를 두지 않는다. 그 밖의 null은 세션이 없다.
    if (result === null && applyBlocked(useRuns.getState(), tabId)) {
      return null;
    }
    const text =
      result === null ? t("edit.noSession") : failureText(result, statements);
    set((state) => ({ failure: { ...state.failure, [tabId]: text } }));
    return null;
  },

  reset() {
    set({ edits: {}, applying: {}, failure: {} });
  },
}));

/** 고친 셀 수 */
export function changedCount(edits: TabEdits | undefined): number {
  let count = 0;
  for (const cells of edits?.changes.values() ?? []) count += cells.size;
  return count;
}
