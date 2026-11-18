import { describe, expect, test } from "vitest";
import { en } from "./en";
import { formatCount, t, tc } from "./t";

describe("t", () => {
  test("param을 채운다", () => {
    expect(t("tabs.close", { title: "first.sql" })).toBe("Close first.sql");
  });

  test("number param은 주어진 그대로 쓴다", () => {
    expect(t("result.dropped", { end: 24500 })).toBe(
      "Rows 1–24500 were dropped · run again to see them",
    );
    expect(t("result.dropped", { end: formatCount(24500) })).toBe(
      "Rows 1–24,500 were dropped · run again to see them",
    );
  });

  test("없는 param은 {name} 그대로 둔다", () => {
    expect(t("tabs.close")).toBe("Close {title}");
  });

  test("tc는 1이면 one을 고른다", () => {
    expect(tc("toast.copiedRows", 1)).toBe("Copied 1 row (tab-separated)");
    expect(tc("toast.copiedRows", 2)).toBe("Copied 2 rows (tab-separated)");
  });

  test("tc는 count를 묶어 쓴다", () => {
    expect(tc("toast.copiedRows", 12000)).toBe(
      "Copied 12,000 rows (tab-separated)",
    );
  });

  test("formatCount", () => {
    expect(formatCount(1000000)).toBe("1,000,000");
  });
});

test("복수형 key는 one과 other가 짝이다", () => {
  const keys = Object.keys(en);
  for (const key of keys.filter((k) => k.endsWith(".one"))) {
    expect(keys).toContain(`${key.slice(0, -4)}.other`);
  }
});
