import { create } from "zustand";
import { describeTypes } from "../../shared/api/commands";
import type { ResultColumn, TypeInfo } from "../../shared/api/types";

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
  const pending = new Map<string, Set<string>>();

  return {
    types: {},

    async ensure(connection, columns) {
      const known = get().types[connection] ?? {};
      const asking = pending.get(connection) ?? new Set<string>();
      const wanted = new Map<string, { oid: number; modifier: number }>();
      for (const { typeOid: oid, typeModifier: modifier } of columns) {
        const key = typeKey(oid, modifier);
        // OID 0은 서버도 모르는 type이다.
        if (oid === 0 || key in known || asking.has(key) || wanted.has(key)) {
          continue;
        }
        wanted.set(key, { oid, modifier });
      }
      if (wanted.size === 0) return;

      for (const key of wanted.keys()) asking.add(key);
      pending.set(connection, asking);
      try {
        const infos = await describeTypes(connection, [...wanted.values()]);
        // 묻는 사이 forget이나 reset이 있었으면 답을 버린다.
        if (pending.get(connection) !== asking) return;
        set((state) => {
          const entry = { ...state.types[connection] };
          for (const info of infos) {
            entry[typeKey(info.oid, info.modifier)] = info;
          }
          return { types: { ...state.types, [connection]: entry } };
        });
      } catch {
        // header에 type이 없을 뿐이다. 다음 결과가 다시 묻는다.
      } finally {
        if (pending.get(connection) === asking) {
          for (const key of wanted.keys()) asking.delete(key);
        }
      }
    },

    forget(connection) {
      pending.delete(connection);
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

/** 그 접속에서 알아낸 컬럼의 type. 아직 모르면(묻는 중, 실패, OID 0) undefined다. */
export function useColumnType(
  connection: string | null,
  column: ResultColumn,
): TypeInfo | undefined {
  return useTypes((state) =>
    connection === null
      ? undefined
      : state.types[connection]?.[typeKey(column.typeOid, column.typeModifier)],
  );
}
