import type { Cell } from "../../shared/api/types";
import type { EditTarget } from "./editTarget";

/** 결과 행 번호 → attnum → 새 값 */
export type Changes = Map<number, Map<number, Cell>>;

export interface UpdateStatement {
  /** 결과 행 번호 */
  row: number;
  sql: string;
  /** SET에 쓴 attnum(오름차순). RETURNING의 순서와 같다. */
  attnums: number[];
}

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * 값을 SQL literal로 쓴다. type은 붙이지 않는다(서버가 unknown literal을 컬럼 type으로 바꾼다).
 * `category`는 컬럼 type의 `pg_type.typcategory`다.
 */
export function sqlLiteral(value: Cell, category: string | undefined): string {
  if (value === null) return "NULL";
  if (category === "N" && PLAIN_NUMBER.test(value)) return value;
  const quoted = value.replace(/'/g, "''");
  if (!value.includes("\\")) return `'${quoted}'`;
  return `E'${quoted.replace(/\\/g, "\\\\")}'`;
}

/**
 * 바뀐 행마다 UPDATE 한 문장을 행 번호 순으로 만든다. SET과 RETURNING은 attnum 순이고
 * WHERE는 `rowAt`이 주는 원래 행의 PK 값을 쓴다. `categories`는 결과 열마다의 type category다.
 */
export function buildUpdates(
  target: EditTarget,
  changes: Changes,
  rowAt: (row: number) => Cell[],
  categories: (string | undefined)[],
): UpdateStatement[] {
  /** attnum의 category는 그 attnum의 첫 결과 열에서 읽는다. */
  const categoryOf = (attnum: number) => {
    const index = target.columns.findIndex(
      (entry) => "column" in entry && entry.column.number === attnum,
    );
    return categories[index];
  };

  const statements: UpdateStatement[] = [];
  for (const row of [...changes.keys()].sort((a, b) => a - b)) {
    const cells = changes.get(row)!;
    const columns = target.table.columns.filter((column) =>
      cells.has(column.number),
    );
    if (columns.length === 0) continue;

    const set = columns
      .map(
        (column) =>
          `${column.quotedName} = ${sqlLiteral(cells.get(column.number)!, categoryOf(column.number))}`,
      )
      .join(", ");
    const original = rowAt(row);
    const where = target.keyColumns
      .map(
        ({ column, index }) =>
          `${column.quotedName} = ${sqlLiteral(original[index], categories[index])}`,
      )
      .join(" AND ");
    const returning = columns.map((column) => column.quotedName).join(", ");
    statements.push({
      row,
      attnums: columns.map((column) => column.number),
      sql: `UPDATE ${target.table.qualifiedName} SET ${set} WHERE ${where} RETURNING ${returning};`,
    });
  }
  return statements;
}
