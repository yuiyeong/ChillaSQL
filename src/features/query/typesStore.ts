import { useMemo } from "react";
import { create } from "zustand";
import { describeTypes } from "../../shared/api/commands";
import type { ResultColumn, TypeInfo } from "../../shared/api/types";
import { pendingAsks } from "./pendingAsks";

/** cache의 key. OID와 typmod가 같으면 같은 type이다. */
export function typeKey(oid: number, modifier: number): string {
  return `${oid}:${modifier}`;
}

interface TypesState {
  /** connection → typeKey → TypeInfo */
  types: Record<string, Record<string, TypeInfo>>;
  /** cache에 없고 묻는 중이 아닌 것만 묻는다. 실패는 무시한다(다음 결과가 다시 묻는다). */
  ensure(connection: string, columns: readonly ResultColumn[]): Promise<void>;
  /** 그 접속의 cache를 버린다. 묻는 중인 답도 버린다. */
  forget(connection: string): void;
  reset(): void;
}

export const useTypes = create<TypesState>()((set, get) => {
  // 접속마다 묻는 중인 typeKey. forget과 reset은 지운다.
  const pending = pendingAsks<string>();

  return {
    types: {},

    async ensure(connection, columns) {
      const known = get().types[connection] ?? {};
      const wanted = new Map<string, { oid: number; modifier: number }>();
      for (const { typeOid: oid, typeModifier: modifier } of columns) {
        const key = typeKey(oid, modifier);
        // OID 0은 서버도 모르는 type이다.
        if (
          oid === 0 ||
          key in known ||
          pending.isAsking(connection, key) ||
          wanted.has(key)
        ) {
          continue;
        }
        wanted.set(key, { oid, modifier });
      }
      if (wanted.size === 0) return;

      // 실패하면 header에 type이 없을 뿐이다.
      await pending.ask(
        connection,
        [...wanted.keys()],
        () => describeTypes(connection, [...wanted.values()]),
        (infos) =>
          set((state) => {
            const entry = { ...state.types[connection] };
            for (const info of infos) {
              entry[typeKey(info.oid, info.modifier)] = info;
            }
            return { types: { ...state.types, [connection]: entry } };
          }),
      );
    },

    forget(connection) {
      pending.forget(connection);
      set((state) => {
        const types = { ...state.types };
        delete types[connection];
        return { types };
      });
    },

    reset() {
      pending.clear();
      set({ types: {} });
    },
  };
});

/**
 * 그 접속에서 알아낸 컬럼마다의 type. 아직 모르면(묻는 중, 실패, OID 0) undefined다. 그 접속의 type
 * cache가 바뀔 때만 새 배열이다.
 */
export function useColumnTypes(
  connection: string | null,
  columns: readonly ResultColumn[],
): (TypeInfo | undefined)[] {
  const known = useTypes((state) =>
    connection === null ? undefined : state.types[connection],
  );
  return useMemo(
    () =>
      columns.map(
        (column) => known?.[typeKey(column.typeOid, column.typeModifier)],
      ),
    [known, columns],
  );
}
