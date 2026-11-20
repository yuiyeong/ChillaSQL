/**
 * 접속마다 catalog에 묻는 중인 key. `typesStore`와 `editTargetStore`의 cache가 같은 key를 두 번 묻지
 * 않게 하고, 묻는 사이 `forget`이나 `clear`가 있었으면 답을 버린다.
 */
export function pendingAsks<K>() {
  const pending = new Map<string, Set<K>>();

  return {
    isAsking(connection: string, key: K): boolean {
      return pending.get(connection)?.has(key) ?? false;
    },

    /**
     * `keys`를 묻는 중으로 두고 `ask`를 부른다. 그 사이 `forget`이나 `clear`가 없었을 때만 답을
     * `apply`에 넘긴다. 실패는 무시한다(다음 결과가 다시 묻는다).
     */
    async ask<T>(
      connection: string,
      keys: readonly K[],
      ask: () => Promise<T>,
      apply: (answer: T) => void,
    ): Promise<void> {
      const asking = pending.get(connection) ?? new Set<K>();
      for (const key of keys) asking.add(key);
      pending.set(connection, asking);
      try {
        const answer = await ask();
        if (pending.get(connection) === asking) apply(answer);
      } catch {
        // 답이 없을 뿐이다. 다음 결과가 다시 묻는다.
      } finally {
        if (pending.get(connection) === asking) {
          for (const key of keys) asking.delete(key);
        }
      }
    },

    forget(connection: string): void {
      pending.delete(connection);
    },

    clear(): void {
      pending.clear();
    },
  };
}
