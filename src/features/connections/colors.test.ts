import { expect, test } from "vitest";
import type { ConnectionColor } from "../../shared/api/types";
import { connectionColor } from "./colors";

test("정해 둔 색 이름은 token 변수가 된다", () => {
  const names: ConnectionColor[] = ["green", "yellow", "red", "blue", "purple"];
  for (const name of names) {
    expect(connectionColor(name)).toBe(`var(--color-conn-${name})`);
  }
});

test("모르는 이름과 null은 line-2다", () => {
  expect(connectionColor("orange" as ConnectionColor)).toBe(
    "var(--color-line-2)",
  );
  expect(connectionColor(null)).toBe("var(--color-line-2)");
});
