import type {
  Cell,
  Outcome,
  QueryEvent,
  ResultColumn,
} from "../../shared/api/types";
import type { UpdateStatement } from "./editSql";
import type { Rewrite } from "./rewrite";

/** 보낸 text가 문서에서 시작한 곳. 1부터 센다. */
export interface Origin {
  line: number;
  column: number;
}

/** 다음 batch를 요청할 수 있는지. rows가 오면 ready, 요청하면 fetching, 끝나면 none이다. */
export type FetchState = "none" | "ready" | "fetching";

/** 실행할 문장 하나와 그것이 문서에서 시작한 곳. */
export interface ScriptStep {
  /** 서버에 보낼 text. `rewrite`가 있으면 문서의 문장을 고친 것이다. */
  sql: string;
  /** 문서의 문장을 고쳐 보낼 때만 있다(파라미터 값, `EXPLAIN ANALYZE `). 바꾼 것이 없으면 없다. */
  rewrite?: Rewrite;
  /**
   * 문서 offset. 실행한 뒤의 편집은 문서가 따라 옮긴다(`anchorOf`). 문서에 그 자리가 없으면(지워진
   * 자리의 text를 다시 실행) null이고, 오류 밑줄과 Go to error를 쓰지 않는다.
   */
  from: number | null;
  /** 실행한 때의 줄과 칸. 문서가 그 자리를 지웠을 때만 쓴다. */
  origin: Origin;
}

/** 실행할 것. 탭의 접속과 차례로 보낼 문장. 문장 하나면 steps 길이 1이다. */
export interface RunRequest {
  connection: string;
  steps: ScriptStep[];
}

/** 다시 할 수 있는 실행. 문장마다 그 실행의 runKey를 두어 문서가 옮긴 자리에서 다시 한다. */
export interface Retry extends RunRequest {
  runKeys: string[];
}

/** 실행하지 못한 이유. title은 한 줄, detail은 덧붙일 설명이다. */
export interface Rejection {
  title: string;
  detail: string | null;
  /** 터널 명령의 stderr. 터널을 열지 못했을 때만 있다. */
  output?: string;
  /** 같은 실행을 다시 할 수 있으면 그 요청(터널 오류의 Try again). */
  retry?: Retry;
}

export interface ResultData {
  /** 서버에 보낸 text */
  sql: string;
  /** 보낸 text를 문서의 문장에서 고쳤으면 그 대응. 없으면 보낸 text가 문서의 문장이다. */
  rewrite?: Rewrite;
  /** 실행을 가리키는 key. 에디터 문서가 그 실행의 현재 위치를 이 key로 둔다. */
  runKey: string;
  /** 실행할 때의 문서 offset. 지금 위치는 `anchorOf(tabId, runKey)`다. 문서에 자리가 없으면 null */
  from: number | null;
  origin: Origin;
  columns: ResultColumn[] | null;
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

/**
 * Apply가 돌려준 `RETURNING` 값(`returned`)으로 바꾼 결과. 문장마다 `attnums`의 순서로 값이 오고,
 * 같은 attnum의 결과 열은 모두 바꾼다. 표에 남지 않은(버린) 행은 건너뛴다.
 */
export function withReturnedRows(
  result: ResultData,
  statements: readonly UpdateStatement[],
  returned: Cell[][],
): ResultData {
  const attnums = result.columns?.map((column) => column.columnNumber);
  const rows = [...result.rows];
  statements.forEach((statement, index) => {
    const row = rows[statement.row - result.firstRow];
    if (row === undefined) return;
    rows[statement.row - result.firstRow] = row.map((cell, column) => {
      const at = statement.attnums.indexOf(attnums?.[column] ?? 0);
      return at === -1 ? cell : returned[index][at];
    });
  });
  return { ...result, rows };
}

export type RunState =
  | { status: "idle" }
  | { status: "connecting" }
  | { status: "running"; result: ResultData }
  | { status: "finished"; result: ResultData; outcome: Outcome }
  | { status: "rejected"; rejection: Rejection };

/**
 * 표에 있는 행이 결과의 일부인지. 받는 중, `cancelled`, `expired`, 앞 행을 버림(`firstRow > 0`),
 * 첫 batch만 받은 여러 문장의 앞 문장이면 true다. 정렬과 내보내기의 안내가 같은 판단을 쓴다.
 */
export function isPartialResult(state: RunState): boolean {
  if (state.status === "running") return true;
  if (state.status !== "finished") return false;
  const { result, outcome } = state;
  switch (outcome.outcome) {
    case "cancelled":
    case "expired":
      return true;
    case "completed":
      return result.firstRow > 0 || receivedRows(result) < outcome.rows;
    default:
      return result.firstRow > 0;
  }
}

export function emptyResult(
  { sql, rewrite, from, origin }: ScriptStep,
  runKey: string,
  startedAt: number,
): ResultData {
  return {
    sql,
    ...(rewrite !== undefined && { rewrite }),
    runKey,
    from,
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
        result: { ...result, columns: event.columns },
      };
    case "rows": {
      const kept = result.rows.length;
      const base = kept === 0 ? event.firstRow : result.firstRow;
      const drop = Math.max(0, event.retainedFrom - base);
      // batch마다 행 배열을 한 번만 복사한다.
      const rows =
        drop >= kept
          ? event.rows.slice(drop - kept)
          : (drop === 0 ? result.rows : result.rows.slice(drop)).concat(
              event.rows,
            );
      return {
        status: "running",
        result: {
          ...result,
          firstRow: base + drop,
          rows,
          elapsedMicros: event.elapsedMicros,
          fetch: "ready",
        },
      };
    }
    case "finished":
      // 끝난 결과는 더 가져오지 않는다.
      return {
        status: "finished",
        result: {
          ...result,
          elapsedMicros: event.elapsedMicros,
          fetch: "none",
        },
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
    case "expired":
      return { outcome: event.outcome };
    case "connection_lost":
    case "client_error":
      return { outcome: event.outcome, message: event.message };
  }
}
