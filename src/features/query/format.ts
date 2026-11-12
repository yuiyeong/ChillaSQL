import { lineColumn } from "../editor/statementAt";
import type { ResultData } from "./runReducer";

export function formatElapsed(micros: number): string {
  if (micros < 1_000) return `${(micros / 1_000).toFixed(2)} ms`;
  if (micros < 1_000_000) return `${Math.round(micros / 1_000)} ms`;
  return `${(micros / 1_000_000).toFixed(2)} s`;
}

/** 서버가 준 오류 위치(보낸 text의 UTF-16 offset)를 문서의 줄과 칸으로 바꾼다. */
export function errorLocation(
  result: ResultData,
  position: number,
): { line: number; column: number } {
  const { line, column } = lineColumn(result.sql, position);
  const { origin } = result;
  return line === 1
    ? { line: origin.line, column: origin.column + column - 1 }
    : { line: origin.line + line - 1, column };
}
