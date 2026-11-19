import type {
  CatalogColumn,
  Relation,
  RelationKind,
  TableDetails,
} from "../../shared/api/types";
import { nodeKey, type SchemaEntry } from "./schemaStore";

export type RelationGroup = "tables" | "views";
export type DetailGroup = "columns" | "indexes" | "constraints";

export type SchemaRow =
  | { kind: "schema"; key: string; depth: 0; name: string; expanded: boolean }
  | {
      kind: "group";
      key: string;
      depth: number;
      group: RelationGroup | DetailGroup;
      expanded: boolean;
      /** Columns, Indexes, Constraints의 relation. Tables, Views는 null */
      relation: Relation | null;
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
      relation: Relation | null;
      error: string | null;
    };

const VIEW_KINDS: ReadonlySet<RelationKind> = new Set([
  "view",
  "materialized_view",
]);

export function relationGroup(relation: Relation): RelationGroup {
  return VIEW_KINDS.has(relation.kind) ? "views" : "tables";
}

/** 접힌 node 안은 건너뛰고 보이는 줄만 순서대로 편다. */
export function schemaRows(entry: SchemaEntry): SchemaRow[] {
  const { catalog, expanded } = entry;
  if (catalog === null) return [];
  const rows: SchemaRow[] = [];
  const open = (path: string[]) => expanded.has(nodeKey(path));
  const note = (
    kind: "loading" | "empty" | "failed",
    path: string[],
    depth: number,
    relation: Relation | null = null,
    error: string | null = null,
  ) =>
    rows.push({
      kind,
      key: nodeKey([...path, `:${kind}`]),
      depth,
      relation,
      error,
    });

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
    const relations = catalog.relations.filter((r) => r.schema === schema);
    if (relations.length === 0) note("empty", schemaPath, 1);

    for (const group of ["tables", "views"] as const) {
      const members = relations.filter((r) => relationGroup(r) === group);
      if (members.length === 0) continue;
      const groupPath = [schema, group];
      rows.push({
        kind: "group",
        key: nodeKey(groupPath),
        depth: 1,
        group,
        expanded: open(groupPath),
        relation: null,
      });
      if (!open(groupPath)) continue;
      for (const relation of members) {
        relationRows(rows, entry, [...groupPath, relation.name], relation);
      }
    }
  }
  return rows;

  function relationRows(
    out: SchemaRow[],
    { details }: SchemaEntry,
    path: string[],
    relation: Relation,
  ) {
    out.push({
      kind: "relation",
      key: nodeKey(path),
      depth: 2,
      relation,
      expanded: open(path),
    });
    if (!open(path)) return;
    for (const group of ["columns", "indexes", "constraints"] as const) {
      const groupPath = [...path, group];
      out.push({
        kind: "group",
        key: nodeKey(groupPath),
        depth: 3,
        group,
        expanded: open(groupPath),
        relation,
      });
      if (!open(groupPath)) continue;
      if (group === "columns") {
        for (const column of relation.columns) {
          out.push({
            kind: "column",
            key: nodeKey([...groupPath, column.name]),
            depth: 4,
            column,
          });
        }
        continue;
      }
      const loaded = details[relation.oid];
      if (loaded === undefined || loaded.status === "loading") {
        note("loading", groupPath, 4, relation);
      } else if (loaded.status === "failed" || loaded.details === null) {
        note("failed", groupPath, 4, relation, loaded.error);
      } else if (group === "indexes") {
        if (loaded.details.indexes.length === 0)
          note("empty", groupPath, 4, relation);
        for (const index of loaded.details.indexes) {
          out.push({
            kind: "index",
            key: nodeKey([...groupPath, index.name]),
            depth: 4,
            index,
          });
        }
      } else {
        if (loaded.details.constraints.length === 0)
          note("empty", groupPath, 4, relation);
        for (const constraint of loaded.details.constraints) {
          out.push({
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
