import type { Cell } from "../../shared/api/types";
import { formatCount } from "../../shared/i18n/t";
import { cellText, type ValueKind } from "./cellDisplay";
import type { FetchState } from "./runReducer";

export const ROW_HEIGHT = 26;
export const HEADER_HEIGHT = 32;
/** 버린 구간 안내 줄의 높이 */
export const GAP_HEIGHT = 40;
export const FOOTER_HEIGHT = 30;
/** 마지막으로 보이는 행이 보관한 행의 끝에서 이만큼 안에 들면 다음 batch를 요청한다. */
const FETCH_AHEAD = 100;
/** D2Coding 13px 반각 글자의 advance. 값과 행 번호를 이것으로 센다. */
const HALF_WIDTH = 6.5;
/**
 * canvas로 잴 수 없을 때(jsdom) header 이름의 반각 한 칸 너비. header는 system font 13px semibold라
 * 글자 평균이 7~8.7px이다(`amount` 7.96, `name` 8.65). 넉넉히 잡는다.
 */
const HEADER_HALF_WIDTH = 9;
/** header에서 이름과 type 사이의 간격(`gap-1.5`) */
const HEADER_GAP = 6;
/** header의 type(D2Coding 12px) 반각 한 칸 */
const TYPE_HALF_WIDTH = 6;
/** 칸 좌우의 padding(`px-2.5`) */
const CELL_PADDING = 20;
/** 칸의 `border-r`. box-sizing이 border-box라 칸 너비 안에 든다. */
const CELL_BORDER = 1;
const MIN_FIT = 64;
const MAX_FIT = 480;
export const MIN_DRAG = 48;
const MIN_ROW_NUMBER_WIDTH = 52;
/** 자동 너비는 앞 이만큼의 값만 보고 정한다. */
const FIT_SAMPLE = 2000;
/** 열 너비를 맞출 때 이보다 긴 JSON은 접지 않는다. 2000개를 한꺼번에 parse하지 않기 위해서다. */
const FIT_JSON_LIMIT = 4000;
/** 이보다 긴 값은 앞부분만 그리고 센다. */
const CELL_LIMIT = 300;

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
  // 대부분의 값은 ASCII라 범위를 훑지 않는다.
  if (codePoint < 0x1100) return false;
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

/** 글자의 그려진 너비(px) */
type MeasureText = (text: string) => number;

export function estimateHeaderWidth(text: string): number {
  return displayColumns(text) * HEADER_HALF_WIDTH;
}

/**
 * header 이름(system font, `text-small`, semibold)의 너비를 canvas로 재는 함수를 만든다. 글꼴은 index.css의 token에서 읽는다.
 * canvas나 token이 없으면(jsdom) `estimateHeaderWidth`다.
 */
export function createHeaderMeasure(): MeasureText {
  const context =
    typeof OffscreenCanvas === "undefined"
      ? null
      : new OffscreenCanvas(1, 1).getContext("2d");
  const style = getComputedStyle(document.documentElement);
  const font = ["--font-weight-semibold", "--text-small", "--font-sans"].map(
    (name) => style.getPropertyValue(name).trim(),
  );
  if (context === null || font.some((part) => part === "")) {
    return estimateHeaderWidth;
  }
  context.font = font.join(" ");
  return (text) => context.measureText(text).width;
}

let headerMeasureCache: MeasureText | null = null;

/** `createHeaderMeasure`의 결과. 처음 부를 때 한 번 만든다. */
export function headerMeasure(): MeasureText {
  headerMeasureCache ??= createHeaderMeasure();
  return headerMeasureCache;
}

/** 열 하나의 type 표시. 모르는 type이면 둘 다 비운다. */
export interface FitColumn {
  /** header에 이름 옆에 쓰는 type 이름 */
  type?: string;
  kind?: ValueKind;
}

/**
 * header(이름과 type)와 앞 `FIT_SAMPLE`개 값 중 가장 넓은 것에 맞춘 열 너비(px).
 * 값은 표에 그리는 대로(`kind`에 맞게 줄인 것) D2Coding 반각으로 세고, header 이름은 `measureHeader`로 잰다.
 */
export function fitWidth(
  header: string,
  values: Iterable<Cell>,
  measureHeader: MeasureText = estimateHeaderWidth,
  { type, kind = "text" }: FitColumn = {},
): number {
  let widest = 0;
  let seen = 0;
  for (const value of values) {
    if (seen++ === FIT_SAMPLE) break;
    widest = Math.max(widest, valueColumns(value, kind));
  }
  const headerWidth =
    measureHeader(header) +
    (type === undefined
      ? 0
      : HEADER_GAP + displayColumns(type) * TYPE_HALF_WIDTH);
  const content = Math.max(headerWidth, widest * HALF_WIDTH);
  const width = content + CELL_PADDING + CELL_BORDER;
  return Math.ceil(Math.min(MAX_FIT, Math.max(MIN_FIT, width)));
}

function valueColumns(value: Cell, kind: ValueKind): number {
  if (kind === "text" || value === null) return displayColumns(value ?? "NULL");
  // 큰 JSON은 접는 비용이 크다. 열 너비는 넓은 값으로 보고 원문 앞부분의 칸 수로 센다.
  if (kind === "json" && value.length > FIT_JSON_LIMIT) {
    return displayColumns(value);
  }
  const { text, dim } = cellText(value, kind);
  return displayColumns(dim === null ? text : `${text} ${dim}`);
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

/** 표의 한 칸. `kind`에 맞게 줄인 text를 `CELL_LIMIT`자로 자른다. */
export function cellDisplay(
  value: Cell,
  kind: ValueKind = "text",
): {
  text: string;
  /** fg-3로 그릴 꼬리 */
  dim: string | null;
  muted: boolean;
  italic: boolean;
} {
  const { text, dim } = cellText(value, kind);
  if (value === null) return { text, dim, muted: true, italic: true };
  if (value === "") return { text, dim, muted: true, italic: false };
  if (text.length <= CELL_LIMIT)
    return { text, dim, muted: false, italic: false };
  // surrogate pair를 가르지 않는다.
  const end = isHighSurrogate(text.charCodeAt(CELL_LIMIT - 1))
    ? CELL_LIMIT - 1
    : CELL_LIMIT;
  return { text: `${text.slice(0, end)}…`, dim, muted: false, italic: false };
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

export type Selection =
  | { kind: "cell"; row: number; column: number }
  | { kind: "rows"; anchor: number; focus: number }
  | null;

/** 행의 보이는 순서. 정렬이 없으면 둘 다 null이고 rows index가 곧 보이는 위치다. */
export interface RowView {
  /** 보이는 위치 → rows index */
  order: Int32Array | null;
  /** rows index → 보이는 위치 */
  position: Int32Array | null;
}

/** 정렬하지 않은 결과 순서 */
export const RESULT_ORDER: RowView = { order: null, position: null };

/** `order`(보이는 위치 → rows index)의 view. 정렬이 없으면 `RESULT_ORDER`다. */
export function rowViewOf(order: Int32Array | null): RowView {
  if (order === null) return RESULT_ORDER;
  const position = new Int32Array(order.length);
  order.forEach((index, at) => {
    position[index] = at;
  });
  return { order, position };
}

/**
 * 행 선택의 위아래 끝을 보이는 위치(둘 다 포함)로 센다. 선택은 결과 행 번호 그대로다.
 * 결과 순서면 버린 끝을 보관한 행 안으로 줄이고, 정렬한 view에서 끝 행이 버려졌으면 범위를 셀 수 없어 null이다.
 * 보관한 행에 걸치지 않거나 행 선택이 아니어도 null이다.
 */
export function viewSpan(
  selection: Selection,
  firstRow: number,
  retained: number,
  view: RowView,
): [number, number] | null {
  if (selection?.kind !== "rows") return null;
  const anchor = selection.anchor - firstRow;
  const focus = selection.focus - firstRow;
  const { position } = view;
  if (position === null) {
    const from = Math.max(Math.min(anchor, focus), 0);
    const to = Math.min(Math.max(anchor, focus), retained - 1);
    return from <= to ? [from, to] : null;
  }
  const inside = (index: number) => index >= 0 && index < retained;
  if (!inside(anchor) || !inside(focus)) return null;
  const [a, b] = [position[anchor], position[focus]];
  return [Math.min(a, b), Math.max(a, b)];
}

/** 행 선택 범위 중 보관한 행만, 보이는 순서로 돌려준다. 행 선택이 아니면 빈 배열이다. */
export function selectedRows(
  selection: Selection,
  firstRow: number,
  rows: readonly Cell[][],
  view: RowView,
): Cell[][] {
  const span = viewSpan(selection, firstRow, rows.length, view);
  if (span === null) return [];
  const { order } = view;
  if (order === null) return rows.slice(span[0], span[1] + 1);
  return Array.from(
    order.subarray(span[0], span[1] + 1),
    (index) => rows[index],
  );
}

/** 선택 중 보관한 행(`firstRow`부터 `retained`개)에 남은 것이 있는지. 행을 복사하지 않고 범위만 본다. */
export function selectionRetained(
  selection: Selection,
  firstRow: number,
  retained: number,
  view: RowView,
): boolean {
  if (selection === null) return false;
  if (selection.kind === "cell") {
    return selection.row >= firstRow && selection.row < firstRow + retained;
  }
  return viewSpan(selection, firstRow, retained, view) !== null;
}
