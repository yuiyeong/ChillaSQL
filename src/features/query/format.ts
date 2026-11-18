import { lineColumn } from "../editor/statementAt";
import { t, tc } from "../../shared/i18n/t";
import type { ResultData } from "./runReducer";

/** 1 ms 밑은 소수 둘째 자리 ms, 1 s 밑은 정수 ms, 그 위는 소수 둘째 자리 s. 반올림한 값으로 단위를 고른다. */
export function formatElapsed(micros: number): string {
  if (micros < 1_000) return `${(micros / 1_000).toFixed(2)} ms`;
  const millis = Math.round(micros / 1_000);
  if (millis < 1_000) return `${millis} ms`;
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

/** 실행 중 경과 시간. 소수 첫째 자리 초다. */
export function formatLive(millis: number): string {
  return `${(millis / 1_000).toFixed(1)} s`;
}

const AFFECTED_KEYS = {
  INSERT: "result.inserted",
  UPDATE: "result.updated",
  DELETE: "result.deleted",
  MERGE: "result.merged",
} as const;

/** 열이 없는 결과의 문구. INSERT/UPDATE/DELETE/MERGE는 행 수를 쓰고 나머지는 Done이다. */
export function affectedText(sql: string, rows: number): string {
  const word = firstWord(sql);
  return word in AFFECTED_KEYS
    ? tc(AFFECTED_KEYS[word as keyof typeof AFFECTED_KEYS], rows)
    : t("result.done");
}

/** 앞의 공백과 `--`, `/* *\/` 주석을 건너뛴 나머지 */
function skipLeading(sql: string): string {
  let rest = sql;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith("--")) {
      const end = rest.indexOf("\n");
      if (end === -1) return "";
      rest = rest.slice(end + 1);
    } else if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      if (end === -1) return "";
      rest = rest.slice(end + 2);
    } else {
      return rest;
    }
  }
}

/** 주석을 건너뛴 첫 단어(대문자). 없으면 빈 문자열이다. */
function firstWord(sql: string): string {
  return /^[\p{L}_]+/u.exec(skipLeading(sql))?.[0].toUpperCase() ?? "";
}

const NAME = String.raw`(?:"(?:[^"]|"")*"|[\p{L}_][\p{L}\p{N}_$]*)`;
const TARGET = new RegExp(
  String.raw`\b(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+(${NAME}(?:\.${NAME})?)`,
  "iu",
);
const LABEL_LIMIT = 32;

/** 결과 tab 이름. 첫 단어와 대상 이름이다. 예: `SELECT users` */
export function resultLabel(sql: string): string {
  const body = skipLeading(sql);
  const word = firstWord(sql);
  const target = TARGET.exec(body)?.[1];
  const label = target === undefined ? word : `${word} ${target}`;
  if ([...label].length <= LABEL_LIMIT) return label;
  return `${[...label].slice(0, LABEL_LIMIT - 1).join("")}…`;
}
