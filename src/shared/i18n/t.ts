import { en, type MessageKey, type PluralKey } from "./en";
import { ko } from "./ko";

type Params = Record<string, string | number>;

export type Language = "en" | "ko";

const dictionaries: Record<Language, Record<MessageKey, string>> = { en, ko };
let dictionary = dictionaries.en;

/** `t`, `tc`, `rt`가 쓸 dictionary를 고른다. 앱을 시작할 때 설정을 읽고 한 번 부른다. */
export function setLanguage(language: Language): void {
  dictionary = dictionaries[language];
}

/** 고른 언어의 문구 그대로(`{name}`을 채우지 않은 것). */
export function template(key: MessageKey): string {
  return dictionary[key];
}

/** 모든 언어의 문구 그대로. 다른 언어로 저장된 값을 알아볼 때 쓴다. */
export function templates(key: MessageKey): string[] {
  return Object.values(dictionaries).map((dictionary) => dictionary[key]);
}

/** dictionary에 있는 key인가. Rust 오류의 `error.<kind>`처럼 밖에서 만든 key를 고를 때 쓴다. */
export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(dictionary, key);
}

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
  return dictionary[key].replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params?.[name];
    return value === undefined ? placeholder : String(value);
  });
}

/** `count`에 맞는 복수형 key. 0이고 `<key>.none`이 있으면 그것, 1이면 `<key>.one`, 아니면 `<key>.other`다. */
export function pluralKey(key: PluralKey, count: number): MessageKey {
  const none = `${key}.none`;
  if (count === 0 && isMessageKey(none)) return none;
  return count === 1 ? `${key}.one` : `${key}.other`;
}

/** `pluralKey`로 고른 문구. `{count}`는 `formatCount`로 채운다. */
export function tc(key: PluralKey, count: number, params?: Params): string {
  return t(pluralKey(key, count), { ...params, count: formatCount(count) });
}
