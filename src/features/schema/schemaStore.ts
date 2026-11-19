import { create } from "zustand";
import {
  closeCatalog,
  loadCatalog,
  loadTableDetails,
} from "../../shared/api/commands";
import { messageOf } from "../../shared/api/errors";
import type { Catalog, TableDetails } from "../../shared/api/types";

export interface DetailsEntry {
  status: "loading" | "ready" | "failed";
  details: TableDetails | null;
  error: string | null;
}

export interface SchemaEntry {
  status: "loading" | "ready" | "failed";
  /** 마지막으로 받은 catalog. 새로고침하는 동안에도 남는다. */
  catalog: Catalog | null;
  error: string | null;
  /** relation OID별 인덱스와 제약조건 */
  details: Record<number, DetailsEntry>;
  /** 펼친 node의 key(`nodeKey`) */
  expanded: ReadonlySet<string>;
}

export interface SchemaState {
  /** 접속 이름별 */
  entries: Record<string, SchemaEntry>;
  /** entry가 없거나 failed면 불러온다. */
  ensure(connection: string): Promise<void>;
  /** catalog를 다시 읽고, 받아 둔 인덱스와 제약조건을 버린 뒤 펼쳐 있는 것만 다시 읽는다. */
  refresh(connection: string): Promise<void>;
  /** 그 OID의 인덱스와 제약조건이 없거나 failed면 불러온다. */
  loadDetails(connection: string, relation: number): Promise<void>;
  toggle(connection: string, key: string): void;
  /** Rust의 catalog connection을 닫고 entry를 지운다. */
  forget(connection: string): Promise<void>;
  /** Rust를 부르지 않고 비운다. 프로젝트를 바꿀 때 */
  reset(): void;
}

/**
 * node의 key. path는 [schema], [schema, "tables"|"views"], [schema, group, name],
 * [schema, group, name, "columns"|"indexes"|"constraints"]이다. 이름이 바뀌지 않으면 새로고침해도
 * 같은 key라 펼친 상태가 남는다.
 */
export function nodeKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

const DETAIL_GROUPS = new Set(["indexes", "constraints"]);

/** 펼쳐 있는 Indexes, Constraints group의 relation OID. 지금 catalog에 없는 이름은 뺀다. */
function expandedDetails(entry: SchemaEntry, catalog: Catalog): Set<number> {
  const oids = new Set<number>();
  for (const key of entry.expanded) {
    const path = JSON.parse(key) as string[];
    if (path.length !== 4 || !DETAIL_GROUPS.has(path[3])) continue;
    const [schema, , name] = path;
    const found = catalog.relations.find(
      (r) => r.schema === schema && r.name === name,
    );
    if (found !== undefined) oids.add(found.oid);
  }
  return oids;
}

function emptyEntry(): SchemaEntry {
  return {
    status: "loading",
    catalog: null,
    error: null,
    details: {},
    expanded: new Set(),
  };
}

export const useSchema = create<SchemaState>()((set, get) => {
  // 접속마다 마지막으로 보낸 catalog 요청의 번호. 다른 번호의 응답은 버린다.
  // forget과 reset은 지운다. 그 뒤에 온 응답도 버린다.
  let lastRequest = 0;
  const latest = new Map<string, number>();

  function update(
    connection: string,
    patch: (entry: SchemaEntry) => Partial<SchemaEntry>,
  ): void {
    set((state) => {
      const entry = state.entries[connection];
      if (entry === undefined) return state;
      return {
        entries: {
          ...state.entries,
          [connection]: { ...entry, ...patch(entry) },
        },
      };
    });
  }

  async function load(connection: string): Promise<void> {
    const request = ++lastRequest;
    latest.set(connection, request);
    set((state) => ({
      entries: {
        ...state.entries,
        [connection]: {
          ...(state.entries[connection] ?? emptyEntry()),
          status: "loading",
        },
      },
    }));

    let catalog: Catalog;
    try {
      catalog = await loadCatalog(connection);
    } catch (error) {
      if (latest.get(connection) === request) {
        update(connection, () => ({
          status: "failed",
          error: messageOf(error),
        }));
      }
      return;
    }
    if (latest.get(connection) !== request) return;

    const before = get().entries[connection];
    if (before === undefined) return;
    const reload =
      before.catalog === null
        ? new Set<number>()
        : expandedDetails(before, catalog);
    const first = before.catalog === null && before.expanded.size === 0;
    const schema = catalog.searchPath[0];
    update(connection, () => ({
      status: "ready",
      catalog,
      error: null,
      details: {},
      ...(first && schema !== undefined
        ? {
            expanded: new Set([nodeKey([schema]), nodeKey([schema, "tables"])]),
          }
        : {}),
    }));
    for (const oid of reload) void get().loadDetails(connection, oid);
  }

  return {
    entries: {},

    async ensure(connection) {
      const entry = get().entries[connection];
      if (entry !== undefined && entry.status !== "failed") return;
      await load(connection);
    },

    refresh: load,

    async loadDetails(connection, relation) {
      const entry = get().entries[connection];
      if (entry === undefined) return;
      const current = entry.details[relation];
      if (current !== undefined && current.status !== "failed") return;
      // 이 사이 새로고침이나 forget이 있었으면 응답을 버린다.
      const request = latest.get(connection);
      const put = (next: DetailsEntry) => {
        if (latest.get(connection) !== request) return;
        update(connection, (e) => ({
          details: { ...e.details, [relation]: next },
        }));
      };
      put({ status: "loading", details: null, error: null });
      try {
        const details = await loadTableDetails(connection, relation);
        put({ status: "ready", details, error: null });
      } catch (error) {
        put({ status: "failed", details: null, error: messageOf(error) });
      }
    },

    toggle(connection, key) {
      update(connection, (entry) => {
        const expanded = new Set(entry.expanded);
        if (!expanded.delete(key)) expanded.add(key);
        return { expanded };
      });
    },

    async forget(connection) {
      latest.delete(connection);
      set((state) => {
        const entries = { ...state.entries };
        delete entries[connection];
        return { entries };
      });
      try {
        await closeCatalog(connection);
      } catch {
        // 프로젝트가 바뀌었으면 Rust가 이미 닫았다.
      }
    },

    reset() {
      latest.clear();
      set({ entries: {} });
    },
  };
});
