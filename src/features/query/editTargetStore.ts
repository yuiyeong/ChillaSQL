import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { describeTables } from "../../shared/api/commands";
import type { EditTable, ResultColumn } from "../../shared/api/types";

interface EditTablesState {
  /** connection → table OID → 테이블. 물었는데 답에 없으면(없어진 테이블) null이다. */
  tables: Record<string, Record<number, EditTable | null>>;
  /** cache에 없고 묻는 중이 아닌 OID만 묻는다. 실패는 무시한다(다음 결과가 다시 묻는다). */
  ensure(connection: string, oids: readonly number[]): Promise<void>;
  /** 그 접속의 cache를 버린다. 묻는 중인 답도 버린다. schema를 새로 읽을 때 부른다. */
  forget(connection: string): void;
  reset(): void;
}

/** 셀 편집이 쓰는 테이블의 catalog cache. `typesStore`와 같은 모양이다. */
export const useEditTableCache = create<EditTablesState>()((set, get) => {
  // 접속마다 묻는 중인 OID. forget과 reset은 지운다.
  const pending = new Map<string, Set<number>>();

  return {
    tables: {},

    async ensure(connection, oids) {
      const known = get().tables[connection] ?? {};
      const asking = pending.get(connection) ?? new Set<number>();
      const wanted = [
        ...new Set(
          oids.filter(
            (oid) => oid !== 0 && !(oid in known) && !asking.has(oid),
          ),
        ),
      ];
      if (wanted.length === 0) return;

      for (const oid of wanted) asking.add(oid);
      pending.set(connection, asking);
      try {
        const found = await describeTables(connection, wanted);
        // 묻는 사이 forget이나 reset이 있었으면 답을 버린다.
        if (pending.get(connection) !== asking) return;
        set((state) => {
          const entry = { ...state.tables[connection] };
          for (const oid of wanted) {
            entry[oid] = found.find((table) => table.oid === oid) ?? null;
          }
          return { tables: { ...state.tables, [connection]: entry } };
        });
      } catch {
        // 편집할 수 있는지 판단을 미룰 뿐이다. 다음 결과가 다시 묻는다.
      } finally {
        if (pending.get(connection) === asking) {
          for (const oid of wanted) asking.delete(oid);
        }
      }
    },

    forget(connection) {
      pending.delete(connection);
      set((state) => {
        const tables = { ...state.tables };
        delete tables[connection];
        return { tables };
      });
    },

    reset() {
      pending.clear();
      set({ tables: {} });
    },
  };
});

/** 결과 열의 table OID. 0(테이블이 아닌 열)은 뺀다. */
function tableOids(columns: readonly ResultColumn[]): number[] {
  return [
    ...new Set(columns.map((column) => column.tableOid).filter((oid) => oid)),
  ];
}

/**
 * 결과 열이 가리키는 테이블. 하나라도 아직 모르면(묻는 중, 실패) undefined이고, 답에 없던(없어진)
 * 테이블은 빠진다. 모르는 테이블은 이 hook이 묻는다. `editTargetOf`의 `tables`로 넘긴다.
 */
export function useEditTables(
  connection: string | null,
  columns: readonly ResultColumn[],
): EditTable[] | undefined {
  const oids = useMemo(() => tableOids(columns), [columns]);
  const known = useEditTableCache((state) =>
    connection === null ? undefined : state.tables[connection],
  );

  useEffect(() => {
    if (connection !== null && oids.length > 0) {
      void useEditTableCache.getState().ensure(connection, oids);
    }
  }, [connection, oids]);

  return useMemo(() => {
    if (oids.length === 0) return [];
    if (known === undefined || oids.some((oid) => !(oid in known))) {
      return undefined;
    }
    return oids.flatMap((oid) => {
      const table = known[oid];
      return table ? [table] : [];
    });
  }, [known, oids]);
}
