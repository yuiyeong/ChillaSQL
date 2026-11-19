import { en, type MessageKey, type PluralKey } from "./en";

type Params = Record<string, string | number>;

const numberFormat = new Intl.NumberFormat("en-US");

/** 1000 단위를 쉼표로 묶는다. 124500 -> "124,500" */
export function formatCount(n: number): string {
  return numberFormat.format(n);
}

/**
 * `{name}`을 params로 바꾼다. 값은 주어진 그대로 쓴다(number를 묶으려면 `formatCount`를 부른다).
 * 없는 param은 `{name}` 그대로 둔다.
 */
export function t(key: MessageKey, params?: Params): string {
  return en[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params?.[name];
    return value === undefined ? placeholder : String(value);
  });
}

/** `count`에 맞는 복수형 key. 0이고 `<key>.none`이 있으면 그것, 1이면 `<key>.one`, 아니면 `<key>.other`다. */
export function pluralKey(key: PluralKey, count: number): MessageKey {
  const none = `${key}.none`;
  if (count === 0 && none in en) return none as MessageKey;
  return count === 1 ? `${key}.one` : `${key}.other`;
}

/** `pluralKey`로 고른 문구. `{count}`는 `formatCount`로 채운다. */
export function tc(key: PluralKey, count: number, params?: Params): string {
  return t(pluralKey(key, count), { ...params, count: formatCount(count) });
}
