import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { describeTables } from "../../shared/api/commands";
import type { EditTable, ResultColumn } from "../../shared/api/types";
import { tableOids } from "./editTarget";
import { pendingAsks } from "./pendingAsks";

interface EditTablesState {
  /** connection → table OID → 테이블. 물었는데 답에 없으면(없어진 테이블) null이다. */
  tables: Record<string, Record<number, EditTable | null>>;
  /** connection → table OID → 그 답을 물은 때(`Date.now`). */
  askedAt: Record<string, Record<number, number>>;
  /**
   * `since` 뒤에 물은 답이 없고 그런 물음이 묻는 중도 아닌 OID만 묻는다. `since`는 결과가 시작한 때라,
   * 결과가 쓰는 답은 그 결과가 시작한 뒤에 물은 것이다(그 전에 테이블 이름이 바뀌었을 수 있다).
   * 실패는 무시한다(다음 결과가 다시 묻는다).
   */
  ensure(
    connection: string,
    oids: readonly number[],
    since: number,
  ): Promise<void>;
  /** 그 접속의 cache를 버린다. 묻는 중인 답도 버린다. schema를 새로 읽을 때 부른다. */
  forget(connection: string): void;
  reset(): void;
}

/** 그 OID의 답을 `since` 뒤에 물었는지 */
function askedSince(
  askedAt: Record<number, number> | undefined,
  oid: number,
  since: number,
): boolean {
  const at = askedAt?.[oid];
  return at !== undefined && at >= since;
}

/** 셀 편집이 쓰는 테이블의 catalog cache. `typesStore`와 같은 모양이다(묻는 중인 key는 `pendingAsks`). */
export const useEditTableCache = create<EditTablesState>()((set, get) => {
  // 접속마다 묻는 중인 OID. forget과 reset은 지운다.
  const pending = pendingAsks<number>();
  // 접속마다 OID를 마지막으로 물은 때. 묻는 중인 물음이 `since` 뒤의 것인지 본다.
  const lastAsked = new Map<string, Map<number, number>>();

  return {
    tables: {},
    askedAt: {},

    async ensure(connection, oids, since) {
      const answered = get().askedAt[connection];
      const asked = lastAsked.get(connection);
      const wanted = [
        ...new Set(
          oids.filter(
            (oid) =>
              oid !== 0 &&
              !askedSince(answered, oid, since) &&
              !(
                pending.isAsking(connection, oid) &&
                (asked?.get(oid) ?? -Infinity) >= since
              ),
          ),
        ),
      ];
      if (wanted.length === 0) return;

      const now = Date.now();
      const times = asked ?? new Map<number, number>();
      for (const oid of wanted) times.set(oid, now);
      lastAsked.set(connection, times);

      // 실패하면 편집할 수 있는지 판단을 미룰 뿐이다.
      await pending.ask(
        connection,
        wanted,
        () => describeTables(connection, wanted),
        (found) =>
          set((state) => {
            const entry = { ...state.tables[connection] };
            const at = { ...state.askedAt[connection] };
            for (const oid of wanted) {
              // 늦게 온 지난 물음의 답이 새 답을 덮지 않는다.
              if ((at[oid] ?? -Infinity) > now) continue;
              entry[oid] = found.find((table) => table.oid === oid) ?? null;
              at[oid] = now;
            }
            return {
              tables: { ...state.tables, [connection]: entry },
              askedAt: { ...state.askedAt, [connection]: at },
            };
          }),
      );
    },

    forget(connection) {
      pending.forget(connection);
      lastAsked.delete(connection);
      set((state) => {
        const tables = { ...state.tables };
        const askedAt = { ...state.askedAt };
        delete tables[connection];
        delete askedAt[connection];
        return { tables, askedAt };
      });
    },

    reset() {
      pending.clear();
      lastAsked.clear();
      set({ tables: {}, askedAt: {} });
    },
  };
});

/**
 * 결과 열이 가리키는 테이블. 하나라도 아직 모르면(묻는 중, 실패, 결과가 시작하기 전에 물은 답뿐) undefined이고,
 * 답에 없던(없어진) 테이블은 빠진다. 모르는 테이블은 이 hook이 묻는다. `startedAt`은 결과가 시작한 때다.
 * `editTargetOf`의 `tables`로 넘긴다.
 */
export function useEditTables(
  connection: string | null,
  columns: readonly ResultColumn[],
  startedAt: number,
): EditTable[] | undefined {
  const oids = useMemo(() => tableOids(columns), [columns]);
  const known = useEditTableCache((state) =>
    connection === null ? undefined : state.tables[connection],
  );
  const askedAt = useEditTableCache((state) =>
    connection === null ? undefined : state.askedAt[connection],
  );

  useEffect(() => {
    if (connection !== null && oids.length > 0) {
      void useEditTableCache.getState().ensure(connection, oids, startedAt);
    }
  }, [connection, oids, startedAt]);

  return useMemo(() => {
    if (oids.length === 0) return [];
    if (
      known === undefined ||
      oids.some((oid) => !askedSince(askedAt, oid, startedAt))
    ) {
      return undefined;
    }
    return oids.flatMap((oid) => {
      const table = known[oid];
      return table ? [table] : [];
    });
  }, [known, askedAt, oids, startedAt]);
}
