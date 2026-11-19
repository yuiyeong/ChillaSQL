import type { Catalog, Relation } from "../api/types";

/** 뷰와 materialized view. 트리의 Views group과 자동완성의 `view` detail이 쓴다. */
export function isView(relation: Relation): boolean {
  return relation.kind === "view" || relation.kind === "materialized_view";
}

interface Index {
  byName: Map<string, Relation>;
  bySchema: Map<string, Relation[]>;
}

const indexes = new WeakMap<Catalog, Index>();

/** catalog마다 한 번 만드는 relation 색인. */
function indexOf(catalog: Catalog): Index {
  let index = indexes.get(catalog);
  if (index === undefined) {
    index = { byName: new Map(), bySchema: new Map() };
    for (const relation of catalog.relations) {
      index.byName.set(`${relation.schema}\0${relation.name}`, relation);
      const list = index.bySchema.get(relation.schema);
      if (list === undefined) index.bySchema.set(relation.schema, [relation]);
      else list.push(relation);
    }
    indexes.set(catalog, index);
  }
  return index;
}

export function relationNamed(
  catalog: Catalog,
  schema: string,
  name: string,
): Relation | undefined {
  return indexOf(catalog).byName.get(`${schema}\0${name}`);
}

const NONE: readonly Relation[] = [];

/** 그 schema의 relation, catalog 순서(이름 오름차순) 그대로. */
export function relationsOf(
  catalog: Catalog,
  schema: string,
): readonly Relation[] {
  return indexOf(catalog).bySchema.get(schema) ?? NONE;
}
