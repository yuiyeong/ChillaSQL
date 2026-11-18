import { en, type MessageKey, type PluralKey } from "./en";

type Params = Record<string, string | number>;

const numberFormat = new Intl.NumberFormat("en-US");

/** 1000 단위를 쉼표로 묶는다. 124500 -> "124,500" */
export function formatCount(n: number): string {
  return numberFormat.format(n);
}

/** `{name}`을 params로 바꾼다. number는 `formatCount`로 쓰고, 없는 param은 `{name}` 그대로 둔다. */
export function t(key: MessageKey, params?: Params): string {
  return en[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params?.[name];
    if (value === undefined) return placeholder;
    return typeof value === "number" ? formatCount(value) : value;
  });
}

/** `count`가 1이면 `<key>.one`, 아니면 `<key>.other`다. `{count}`도 채운다. */
export function tc(key: PluralKey, count: number, params?: Params): string {
  const form = count === 1 ? "one" : "other";
  return t(`${key}.${form}`, { ...params, count });
}
