import type { Cell } from "../../shared/api/types";
import { formatCount } from "../../shared/i18n/t";
import type { FetchState } from "./runReducer";

export const ROW_HEIGHT = 26;
export const HEADER_HEIGHT = 32;
/** 버린 구간 안내 줄의 높이 */
export const GAP_HEIGHT = 40;
export const FOOTER_HEIGHT = 30;
/** 마지막으로 보이는 행이 보관한 행의 끝에서 이만큼 안에 들면 다음 batch를 요청한다. */
export const FETCH_AHEAD = 100;
/** D2Coding 13px 반각 글자의 advance */
export const HALF_WIDTH = 6.5;
/** 칸 좌우의 padding(`px-2.5`) */
export const CELL_PADDING = 20;
/** 칸의 `border-r`. box-sizing이 border-box라 칸 너비 안에 든다. */
export const CELL_BORDER = 1;
export const MIN_FIT = 64;
export const MAX_FIT = 480;
export const MIN_DRAG = 48;
export const MIN_ROW_NUMBER_WIDTH = 52;
/** 자동 너비는 앞 이만큼의 값만 보고 정한다. */
export const FIT_SAMPLE = 2000;
/** 이보다 긴 값은 앞부분만 그리고 센다. */
export const CELL_LIMIT = 300;

const FULL_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];

function isFullWidth(codePoint: number): boolean {
  return FULL_WIDTH_RANGES.some(
    ([from, to]) => codePoint >= from && codePoint <= to,
  );
}

/** 전각은 2칸, 나머지는 1칸으로 센다. 앞 `CELL_LIMIT`자까지만 본다. */
export function displayColumns(text: string): number {
  let columns = 0;
  let chars = 0;
  for (const char of text) {
    if (chars++ === CELL_LIMIT) break;
    columns += isFullWidth(char.codePointAt(0)!) ? 2 : 1;
  }
  return columns;
}

/** header와 앞 `FIT_SAMPLE`개 값 중 가장 넓은 것에 맞춘 열 너비(px) */
export function fitWidth(header: string, values: Iterable<Cell>): number {
  let widest = displayColumns(header);
  let seen = 0;
  for (const value of values) {
    if (seen++ === FIT_SAMPLE) break;
    widest = Math.max(widest, displayColumns(value ?? "NULL"));
  }
  const width = widest * HALF_WIDTH + CELL_PADDING + CELL_BORDER;
  return Math.ceil(Math.min(MAX_FIT, Math.max(MIN_FIT, width)));
}

/** 행 번호 column의 너비(px). 가장 큰 행 번호(`lastRow`, 1부터 셈)가 잘리지 않는다. */
export function rowNumberWidth(lastRow: number): number {
  const width =
    formatCount(lastRow).length * HALF_WIDTH + CELL_PADDING + CELL_BORDER;
  return Math.max(MIN_ROW_NUMBER_WIDTH, Math.ceil(width));
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function cellDisplay(value: Cell): {
  text: string;
  muted: boolean;
  italic: boolean;
} {
  if (value === null) return { text: "NULL", muted: true, italic: true };
  if (value === "") return { text: "''", muted: true, italic: false };
  if (value.length <= CELL_LIMIT)
    return { text: value, muted: false, italic: false };
  // surrogate pair를 가르지 않는다.
  const end = isHighSurrogate(value.charCodeAt(CELL_LIMIT - 1))
    ? CELL_LIMIT - 1
    : CELL_LIMIT;
  return { text: `${value.slice(0, end)}…`, muted: false, italic: false };
}

export function copyCell(value: Cell): string {
  return value ?? "";
}

function tsvField(value: Cell): string {
  const text = copyCell(value);
  return /[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 칸은 tab, 행은 줄바꿈으로 잇는다. 끝에 줄바꿈은 없다. */
export function tsv(rows: readonly Cell[][]): string {
  return rows.map((row) => row.map(tsvField).join("\t")).join("\n");
}

/** `lastVisible`과 `retained`는 보관한 행 안의 index와 개수다. */
export function shouldFetch(
  lastVisible: number,
  retained: number,
  fetch: FetchState,
): boolean {
  return fetch === "ready" && lastVisible >= retained - FETCH_AHEAD;
}

/** 앞 행이 버려져 `firstRow`가 바뀔 때 `scrollTop`에 더할 값. 새 결과(`next < prev`)면 0이다. */
export function anchorShift(
  prevFirstRow: number,
  nextFirstRow: number,
): number {
  if (nextFirstRow < prevFirstRow) return 0;
  const gapAppears = prevFirstRow === 0 && nextFirstRow > 0 ? GAP_HEIGHT : 0;
  return gapAppears - (nextFirstRow - prevFirstRow) * ROW_HEIGHT;
}

/** 앞의 공백과 `--`, `/* *\/` 주석을 건너뛴 나머지 */
export function skipLeading(sql: string): string {
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
export function firstWord(sql: string): string {
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

export type Selection =
  | { kind: "cell"; row: number; column: number }
  | { kind: "rows"; anchor: number; focus: number }
  | null;

/** 행 선택 범위 중 보관한 행만, 위에서 아래 순서로 돌려준다. 행 선택이 아니면 빈 배열이다. */
export function selectedRows(
  selection: Selection,
  firstRow: number,
  rows: readonly Cell[][],
): Cell[][] {
  if (selection?.kind !== "rows") return [];
  const from = Math.max(
    Math.min(selection.anchor, selection.focus) - firstRow,
    0,
  );
  const to = Math.min(
    Math.max(selection.anchor, selection.focus) - firstRow,
    rows.length - 1,
  );
  return rows.slice(from, Math.max(to + 1, from));
}
