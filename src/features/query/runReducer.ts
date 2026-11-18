import type { Cell, Outcome, QueryEvent } from "../../shared/api/types";

/** 보낸 text가 문서에서 시작한 곳. 1부터 센다. */
export interface Origin {
  line: number;
  column: number;
}

/** 다음 batch를 요청할 수 있는지. rows가 오면 ready, 요청하면 fetching이다. */
export type FetchState = "none" | "ready" | "fetching";

/** 실행하지 못한 이유. title은 한 줄, detail은 덧붙일 설명이다. */
export interface Rejection {
  title: string;
  detail: string | null;
}

export interface ResultData {
  /** 서버에 보낸 text */
  sql: string;
  origin: Origin;
  columns: string[] | null;
  /** rows[0]의 행 번호 */
  firstRow: number;
  rows: Cell[][];
  elapsedMicros: number | null;
  fetch: FetchState;
  /** 실행을 시작한 시각(`Date.now()`) */
  startedAt: number;
}

/** 지금까지 받은 행 수. 버린 앞 행(`firstRow`개)도 센다. */
export function receivedRows(result: ResultData): number {
  return result.firstRow + result.rows.length;
}

export type RunState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "running"; result: ResultData }
  | { status: "finished"; result: ResultData; outcome: Outcome }
  | { status: "rejected"; rejection: Rejection };

export function emptyResult(
  sql: string,
  origin: Origin,
  startedAt: number,
): ResultData {
  return {
    sql,
    origin,
    columns: null,
    firstRow: 0,
    rows: [],
    elapsedMicros: null,
    fetch: "none",
    startedAt,
  };
}

/** running이고 ready일 때만 fetching으로 바꾼다. 아니면 같은 object를 돌려준다. */
export function requestFetch(state: RunState): RunState {
  if (state.status !== "running" || state.result.fetch !== "ready") {
    return state;
  }
  return { status: "running", result: { ...state.result, fetch: "fetching" } };
}

/** running이 아닌 state는 그대로 돌려준다. */
export function reduce(state: RunState, event: QueryEvent): RunState {
  if (state.status !== "running") return state;
  const { result } = state;
  switch (event.type) {
    case "columns":
      return {
        status: "running",
        result: { ...result, columns: event.columns.map((c) => c.name) },
      };
    case "rows": {
      const base = result.rows.length === 0 ? event.firstRow : result.firstRow;
      const rows = [...result.rows, ...event.rows];
      const drop = Math.max(0, event.retainedFrom - base);
      return {
        status: "running",
        result: {
          ...result,
          firstRow: base + drop,
          rows: drop === 0 ? rows : rows.slice(drop),
          elapsedMicros: event.elapsedMicros,
          fetch: "ready",
        },
      };
    }
    case "finished":
      return {
        status: "finished",
        result: { ...result, elapsedMicros: event.elapsedMicros },
        outcome: outcomeOf(event),
      };
  }
}

function outcomeOf(event: Extract<QueryEvent, { type: "finished" }>): Outcome {
  switch (event.outcome) {
    case "completed":
      return { outcome: "completed", rows: event.rows };
    case "failed":
      return { outcome: "failed", error: event.error };
    case "cancelled":
    case "discarded":
      return { outcome: event.outcome };
    case "connection_lost":
    case "client_error":
      return { outcome: event.outcome, message: event.message };
  }
}
