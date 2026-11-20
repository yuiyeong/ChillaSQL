import { expect, test } from "vitest";
import { en, type MessageKey } from "./en";
import errorKinds from "./errorKinds.json";
import { ko } from "./ko";

/** 문구의 `{name}` 이름 집합. 정렬해 비교한다. */
function placeholders(text: string): string[] {
  const names = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  return [...new Set(names)].sort();
}

test("every error kind has a message", () => {
  for (const [kind, params] of Object.entries(errorKinds)) {
    const key = `error.${kind}`;
    for (const dictionary of [en, ko] as Record<string, string>[]) {
      expect(dictionary, key).toHaveProperty([key]);
      expect(placeholders(dictionary[key]), key).toEqual([...params].sort());
    }
  }
});

test("placeholders match en", () => {
  for (const key of Object.keys(en) as MessageKey[]) {
    expect(placeholders(ko[key]), key).toEqual(placeholders(en[key]));
  }
});
