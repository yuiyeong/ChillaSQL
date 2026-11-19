import { expect, test } from "vitest";
import type { ConnectionColor } from "../../shared/api/types";
import { connection } from "../../test/fixtures";
import { colorOf, connectionColor } from "./colors";

test("정해 둔 색 이름은 token 변수가 된다", () => {
  const names: ConnectionColor[] = ["green", "yellow", "red", "blue", "purple"];
  for (const name of names) {
    expect(connectionColor(name)).toBe(`var(--color-conn-${name})`);
  }
});

test("null은 line-2다", () => {
  expect(connectionColor(null)).toBe("var(--color-line-2)");
});

test("colorOf는 접속이 없으면 undefined, color가 없거나 모르는 접속이면 null이다", () => {
  const connections = [
    connection("staging", { color: "yellow" }),
    connection("local"),
  ];
  expect(colorOf(connections, "staging")).toBe("yellow");
  expect(colorOf(connections, "local")).toBeNull();
  expect(colorOf(connections, "gone")).toBeNull();
  expect(colorOf(connections, null)).toBeUndefined();
});
