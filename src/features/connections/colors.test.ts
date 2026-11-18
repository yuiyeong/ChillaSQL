import { expect, test } from "vitest";
import { connectionColor } from "./colors";

test("정해 둔 색 이름은 token 변수가 된다", () => {
  for (const name of ["green", "yellow", "red", "blue", "purple"]) {
    expect(connectionColor(name)).toBe(`var(--color-conn-${name})`);
  }
});

test("모르는 이름과 null은 null이다", () => {
  expect(connectionColor("orange")).toBeNull();
  expect(connectionColor(null)).toBeNull();
});
