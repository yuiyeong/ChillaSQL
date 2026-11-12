import { memo, type ReactNode } from "react";
import type { Cell, Outcome } from "../../shared/api/types";
import { errorLocation, formatElapsed } from "./format";
import type { ResultData } from "./runReducer";
import { useRuns } from "./runsStore";

/** 이보다 긴 값은 앞부분만 그린다. */
const CELL_LIMIT = 300;

// running과 finished가 같은 자리에 같은 component로 표를 그린다. 끝나도 표가 다시 mount되지 않는다.
export const ResultPane = memo(function ResultPane({
  tabId,
}: {
  tabId: string | null;
}) {
  const state = useRuns((s) => (tabId === null ? undefined : s.runs[tabId]));

  switch (state?.status) {
    case undefined:
    case "idle":
      return <Message>Cmd+Enter로 실행</Message>;
    case "connecting":
      return <Message>연결 중…</Message>;
    case "running":
      if (state.result.rows.length === 0) return <Message>실행 중…</Message>;
      return (
        <Pane>
          <ResultTable result={state.result} />
          <Status>{state.result.rows.length}행 표시 · 더 있음</Status>
        </Pane>
      );
    case "finished":
      return finishedView(state.result, state.outcome);
    case "rejected":
      return <Message error>{state.message}</Message>;
  }
});

/** component가 아닌 함수다. 돌려준 element가 ResultPane의 자리에 바로 놓인다. */
function finishedView(result: ResultData, outcome: Outcome): ReactNode {
  const elapsed = formatElapsed(result.elapsedMicros ?? 0);
  switch (outcome.outcome) {
    case "completed":
      if (result.columns === null) {
        return (
          <Message>
            {outcome.rows}행 영향 · {elapsed}
          </Message>
        );
      }
      return (
        <Pane>
          <ResultTable result={result} />
          <Status>
            {outcome.rows}행 · {elapsed}
          </Status>
        </Pane>
      );
    case "failed": {
      const { error } = outcome;
      const location =
        error.position === null ? null : errorLocation(result, error.position);
      return (
        <Pane>
          <div className="space-y-1 p-3 text-sm">
            <p className="text-red-400">{error.message}</p>
            {error.detail !== null && (
              <p className="text-zinc-300">{error.detail}</p>
            )}
            {error.hint !== null && (
              <p className="text-zinc-400">{error.hint}</p>
            )}
            <p className="flex gap-3 text-xs text-zinc-500">
              {location !== null && (
                <span>
                  줄 {location.line}:{location.column}
                </span>
              )}
              <span>{error.code}</span>
            </p>
          </div>
        </Pane>
      );
    }
    case "cancelled":
      return (
        <Pane>
          {result.rows.length > 0 && <ResultTable result={result} />}
          <Status>취소됨 · {elapsed}</Status>
        </Pane>
      );
    case "discarded":
      return <Message>결과를 버렸습니다</Message>;
    case "connection_lost":
      return (
        <Pane>
          <div className="space-y-1 p-3 text-sm">
            <p className="text-red-400">연결이 끊겼습니다: {outcome.message}</p>
            <p className="text-zinc-400">다음 실행에서 새 세션을 엽니다</p>
          </div>
        </Pane>
      );
    case "client_error":
      return <Message error>{outcome.message}</Message>;
  }
}

function Pane({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950 text-zinc-200">
      {children}
    </div>
  );
}

function Message({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <Pane>
      <p className={`p-3 text-sm ${error ? "text-red-400" : "text-zinc-500"}`}>
        {children}
      </p>
    </Pane>
  );
}

function Status({ children }: { children: ReactNode }) {
  return (
    <p className="shrink-0 border-t border-zinc-800 px-3 py-1 text-xs text-zinc-400">
      {children}
    </p>
  );
}

function ResultTable({ result }: { result: ResultData }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="border-collapse font-mono text-xs">
        {result.columns !== null && (
          <thead className="sticky top-0 bg-zinc-900">
            <tr>
              {result.columns.map((name, index) => (
                <th
                  key={index}
                  className="border border-zinc-800 px-2 py-1 text-left font-medium whitespace-nowrap text-zinc-300"
                >
                  {name}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {result.rows.map((row, index) => (
            <tr key={result.firstRow + index}>
              {row.map((cell, column) => (
                <td
                  key={column}
                  className="border border-zinc-800 px-2 py-0.5 whitespace-pre"
                >
                  <CellText value={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function CellText({ value }: { value: Cell }) {
  if (value === null) return <span className="text-zinc-600">NULL</span>;
  if (value.length <= CELL_LIMIT) return value;
  // surrogate pair를 가르지 않는다.
  const end = isHighSurrogate(value.charCodeAt(CELL_LIMIT - 1))
    ? CELL_LIMIT - 1
    : CELL_LIMIT;
  return `${value.slice(0, end)}…`;
}
