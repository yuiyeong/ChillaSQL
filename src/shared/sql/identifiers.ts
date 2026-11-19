import type { Catalog } from "../api/types";

const PLAIN = /^[a-z_][a-z0-9_$]*$/;

/**
 * PostgreSQL `quote_ident`와 같다. 소문자, 숫자, `_`, `$`로만 되어 있고 숫자로 시작하지 않고
 * reserved keyword가 아니면 그대로, 아니면 `"`로 감싸고 안의 `"`는 두 번 쓴다.
 */
export function quoteIdent(
  name: string,
  reservedWords: ReadonlySet<string>,
): string {
  if (PLAIN.test(name) && !reservedWords.has(name)) return name;
  return `"${name.replace(/"/g, '""')}"`;
}

const reservedSets = new WeakMap<Catalog, ReadonlySet<string>>();

/** catalog의 reserved keyword 집합. catalog마다 한 번 만든다. */
export function reservedSet(catalog: Catalog): ReadonlySet<string> {
  let found = reservedSets.get(catalog);
  if (found === undefined) {
    found = new Set(catalog.reservedWords);
    reservedSets.set(catalog, found);
  }
  return found;
}
