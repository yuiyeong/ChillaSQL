import type {
  CatalogColumn,
  Relation,
  TableDetails,
} from "../../shared/api/types";
import { isView, relationsOf } from "../../shared/sql/catalog";
import { nodeKey, type SchemaEntry } from "./schemaStore";

export type SchemaRow =
  | { kind: "schema"; key: string; depth: 0; name: string; expanded: boolean }
  | {
      kind: "group";
      key: string;
      depth: number;
      group: "tables" | "views" | "columns" | "indexes" | "constraints";
      expanded: boolean;
    }
  | {
      kind: "relation";
      key: string;
      depth: 2;
      relation: Relation;
      expanded: boolean;
    }
  | { kind: "column"; key: string; depth: 4; column: CatalogColumn }
  | {
      kind: "index";
      key: string;
      depth: 4;
      index: TableDetails["indexes"][number];
    }
  | {
      kind: "constraint";
      key: string;
      depth: 4;
      constraint: TableDetails["constraints"][number];
    }
  | {
      kind: "loading" | "empty" | "failed";
      key: string;
      depth: number;
      error: string | null;
    };

/** 접힌 node 안은 건너뛰고 보이는 줄만 순서대로 편다. */
export function schemaRows({
  catalog,
  expanded,
  details,
}: SchemaEntry): SchemaRow[] {
  if (catalog === null) return [];
  const rows: SchemaRow[] = [];
  const open = (path: string[]) => expanded.has(nodeKey(path));
  const note = (
    kind: "loading" | "empty" | "failed",
    path: string[],
    depth: number,
    error: string | null = null,
  ) => rows.push({ kind, key: nodeKey([...path, `:${kind}`]), depth, error });
  const group = (
    path: string[],
    depth: number,
    name: Extract<SchemaRow, { kind: "group" }>["group"],
  ) => {
    rows.push({
      kind: "group",
      key: nodeKey(path),
      depth,
      group: name,
      expanded: open(path),
    });
    return open(path);
  };

  for (const schema of catalog.schemas) {
    const schemaPath = [schema];
    rows.push({
      kind: "schema",
      key: nodeKey(schemaPath),
      depth: 0,
      name: schema,
      expanded: open(schemaPath),
    });
    if (!open(schemaPath)) continue;
    const relations = relationsOf(catalog, schema);
    if (relations.length === 0) note("empty", schemaPath, 1);

    for (const name of ["tables", "views"] as const) {
      const members = relations.filter((r) => isView(r) === (name === "views"));
      if (members.length === 0 || !group([schema, name], 1, name)) continue;
      for (const relation of members) {
        relationRows([schema, name, relation.name], relation);
      }
    }
  }
  return rows;

  function relationRows(path: string[], relation: Relation) {
    rows.push({
      kind: "relation",
      key: nodeKey(path),
      depth: 2,
      relation,
      expanded: open(path),
    });
    if (!open(path)) return;

    const columnsPath = [...path, "columns"];
    if (group(columnsPath, 3, "columns")) {
      for (const column of relation.columns) {
        rows.push({
          kind: "column",
          key: nodeKey([...columnsPath, column.name]),
          depth: 4,
          column,
        });
      }
    }

    const loaded = details[relation.oid];
    for (const name of ["indexes", "constraints"] as const) {
      const groupPath = [...path, name];
      if (!group(groupPath, 3, name)) continue;
      if (loaded === undefined || loaded.status === "loading") {
        note("loading", groupPath, 4);
      } else if (loaded.status === "failed" || loaded.details === null) {
        note("failed", groupPath, 4, loaded.error);
      } else if (loaded.details[name].length === 0) {
        note("empty", groupPath, 4);
      } else if (name === "indexes") {
        for (const index of loaded.details.indexes) {
          rows.push({
            kind: "index",
            key: nodeKey([...groupPath, index.name]),
            depth: 4,
            index,
          });
        }
      } else {
        for (const constraint of loaded.details.constraints) {
          rows.push({
            kind: "constraint",
            key: nodeKey([...groupPath, constraint.name]),
            depth: 4,
            constraint,
          });
        }
      }
    }
  }
}
