import type { Cell, ResultColumn, TypeInfo } from "../../shared/api/types";
import { valueKind } from "./cellDisplay";
import type { RowView } from "./grid";

/** 내보낼 것. ResultGrid가 보관한 행을 보이는 순서로, 서버 값 그대로 준다. */
export interface ExportRows {
  columns: ResultColumn[];
  rows: Cell[][];
  types: (TypeInfo | undefined)[];
}

/** ResultPane header의 Export가 부른다. */
export type ExportSource = () => ExportRows;

/** 보관한 행을 보이는 순서(정렬 반영)로 돌려준다. */
export function rowsInView(rows: readonly Cell[][], view: RowView): Cell[][] {
  const { order } = view;
  if (order === null) return rows.slice();
  return Array.from(order, (index) => rows[index]);
}

function csvField(value: Cell): string {
  if (value === null) return "";
  return value === "" || /[,"\r\n]/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/**
 * PostgreSQL `COPY … CSV HEADER`와 같은 규칙의 CSV. 첫 줄은 컬럼 이름이고 줄마다 LF로 끝난다.
 * `,` `"` CR LF가 있거나 빈 문자열이면 `"`로 감싸고 `"`는 두 번 쓴다. NULL은 감싸지 않은 빈 칸이다.
 */
export function toCsv(
  columns: ResultColumn[],
  rows: readonly Cell[][],
): string {
  const line = (cells: readonly Cell[]) => `${cells.map(csvField).join(",")}\n`;
  return line(columns.map((column) => column.name)) + rows.map(line).join("");
}

/** JSON 수 문법. `NaN`, `Infinity`, `$1.00`(money)은 맞지 않는다. */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** 값 하나의 JSON text. type이 문자열로 둘 수 없다고 알려 줄 때만 서버 text를 그대로 쓴다. */
function jsonValue(value: Cell, type: TypeInfo | undefined): string {
  if (value === null) return "null";
  const kind = valueKind(type);
  if (kind === "number" && JSON_NUMBER.test(value)) return value;
  if (kind === "json") return value;
  if (type?.name === "boolean" && (value === "t" || value === "f")) {
    return value === "t" ? "true" : "false";
  }
  return JSON.stringify(value);
}

/** 컬럼 이름이 또 나오면 `_2`, `_3`을 붙인다. 붙인 이름도 이미 있으면 다음 수다. */
function uniqueKeys(columns: ResultColumn[]): string[] {
  const used = new Set<string>();
  return columns.map(({ name }) => {
    let key = name;
    for (let n = 2; used.has(key); n++) key = `${name}_${n}`;
    used.add(key);
    return key;
  });
}

/**
 * object의 배열인 JSON. 한 줄에 행 하나(`[\n{…},\n{…}\n]`)이고 행이 없으면 `[]`다.
 * key는 컬럼 이름이다. 수(category `N`), boolean, json/jsonb는 그 JSON 값이고 그 밖과 type을 모르는 열은 문자열이다.
 */
export function toJson(
  columns: ResultColumn[],
  rows: readonly Cell[][],
  types: (TypeInfo | undefined)[],
): string {
  if (rows.length === 0) return "[]";
  const keys = uniqueKeys(columns).map((key) => JSON.stringify(key));
  const objects = rows.map(
    (row) =>
      `{${keys.map((key, i) => `${key}:${jsonValue(row[i], types[i])}`).join(",")}}`,
  );
  return `[\n${objects.join(",\n")}\n]`;
}
