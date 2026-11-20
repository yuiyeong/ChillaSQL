import type {
  EditColumn,
  EditTable,
  ResultColumn,
} from "../../shared/api/types";
import { t } from "../../shared/i18n/t";

export type NotEditable =
  | { reason: "readOnly" | "running" | "noTable" | "gone" }
  | { reason: "manyTables"; names: string[] }
  | { reason: "notTable" | "noPrimaryKey"; name: string }
  | { reason: "primaryKeyMissing"; columns: string[] };

/** 결과 열 하나를 고칠 수 없는 이유. 그 열만 고칠 수 없고 나머지는 편집할 수 있다. */
export type NotEditableColumn = {
  reason: "computed" | "generated";
  name: string;
};

export interface EditTarget {
  table: EditTable;
  /** 결과 열 index → 그 테이블 컬럼. 고칠 수 없는 열은 그 이유 */
  columns: ({ column: EditColumn } | NotEditableColumn)[];
  /** PK 컬럼마다 그 값을 읽을 결과 열 index(같은 attnum의 첫 열) */
  keyColumns: { column: EditColumn; index: number }[];
}

/** 이름은 이만큼만 문구에 쓰고 그 뒤는 `…`로 줄인다. */
const NAMES_SHOWN = 3;

/**
 * 결과를 UPDATE로 고칠 수 있는지 판단한다. 고칠 수 있으면 `EditTarget`, 없으면 그 이유다.
 * `tables`는 `describeTables`의 답이다. 아직 모르면 undefined를 넘기고 null(판단을 미룸)을 받는다.
 */
export function editTargetOf(
  columns: ResultColumn[],
  tables: EditTable[] | undefined,
  readOnly: boolean,
  running: boolean,
): EditTarget | NotEditable | null {
  if (readOnly) return { reason: "readOnly" };
  if (running) return { reason: "running" };

  const oids = [
    ...new Set(columns.map((column) => column.tableOid).filter((oid) => oid)),
  ];
  if (oids.length === 0) return { reason: "noTable" };
  if (tables === undefined) return null;

  if (oids.length > 1) {
    const names = oids.flatMap((oid) => {
      const found = tables.find((table) => table.oid === oid);
      return found ? [found.name] : [];
    });
    return { reason: "manyTables", names };
  }

  const table = tables.find((candidate) => candidate.oid === oids[0]);
  if (!table) return { reason: "gone" };
  if (table.kind !== "table" && table.kind !== "partitioned_table") {
    return { reason: "notTable", name: table.name };
  }
  const primaryKey = table.columns.filter((column) => column.primaryKey);
  if (primaryKey.length === 0) {
    return { reason: "noPrimaryKey", name: table.name };
  }

  const keyColumns: EditTarget["keyColumns"] = [];
  const missing: string[] = [];
  for (const column of primaryKey) {
    const index = columns.findIndex(
      (result) =>
        result.tableOid === table.oid && result.columnNumber === column.number,
    );
    if (index < 0) missing.push(column.name);
    else keyColumns.push({ column, index });
  }
  if (missing.length > 0) {
    return { reason: "primaryKeyMissing", columns: missing };
  }

  return {
    table,
    columns: columns.map((result): EditTarget["columns"][number] => {
      const column =
        result.tableOid === table.oid
          ? table.columns.find((c) => c.number === result.columnNumber)
          : undefined;
      if (!column) return { reason: "computed", name: result.name };
      if (!column.updatable) return { reason: "generated", name: result.name };
      return { column };
    }),
    keyColumns,
  };
}

/** 편집할 수 없는 이유를 result header 아래 note의 문구로 쓴다. */
export function notEditableText(
  reason: NotEditable | NotEditableColumn,
): string {
  switch (reason.reason) {
    case "readOnly":
      return t("edit.notEditable.readOnly");
    case "running":
      return t("edit.notEditable.running");
    case "noTable":
      return t("edit.notEditable.noTable");
    case "gone":
      return t("edit.notEditable.gone");
    case "manyTables": {
      const shown = reason.names.slice(0, NAMES_SHOWN).join(", ");
      return t("edit.notEditable.manyTables", {
        count: reason.names.length,
        names: reason.names.length > NAMES_SHOWN ? `${shown}, …` : shown,
      });
    }
    case "notTable":
      return t("edit.notEditable.notTable", { name: reason.name });
    case "noPrimaryKey":
      return t("edit.notEditable.noPrimaryKey", { name: reason.name });
    case "primaryKeyMissing":
      return t("edit.notEditable.primaryKeyMissing", {
        columns: reason.columns.join(", "),
      });
    case "computed":
      return t("edit.notEditable.computed", { name: reason.name });
    case "generated":
      return t("edit.notEditable.generated", { name: reason.name });
  }
}
