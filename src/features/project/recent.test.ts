import { afterEach, expect, test } from "vitest";
import { setLanguage } from "../../shared/i18n/t";
import { openedWhen } from "./recent";

test("opened_when_buckets", () => {
  // 지역 시각 기준이다. 2026-11-20 14:00.
  const now = new Date(2026, 10, 20, 14, 0, 0).getTime();
  const at = (date: Date) => date.getTime();

  expect(openedWhen(now - 59_000, now, "en")).toBe("Just now");
  expect(openedWhen(now - 60_000, now, "en")).toBe("Today");
  expect(openedWhen(at(new Date(2026, 10, 20, 8, 30)), now, "en")).toBe(
    "Today",
  );
  expect(openedWhen(at(new Date(2026, 10, 19, 23, 59)), now, "en")).toBe(
    "Yesterday",
  );
  expect(openedWhen(at(new Date(2026, 10, 9, 10, 0)), now, "en")).toBe("Nov 9");
  expect(openedWhen(at(new Date(2026, 10, 9, 10, 0)), now, "ko")).toBe(
    "11월 9일",
  );
});

afterEach(() => setLanguage("en"));

test("opened_when_in_korean_uses_korean_words", () => {
  setLanguage("ko");
  const now = new Date(2026, 10, 20, 14, 0, 0).getTime();
  expect(openedWhen(now - 1_000, now, "ko")).toBe("방금");
  expect(openedWhen(new Date(2026, 10, 20, 8).getTime(), now, "ko")).toBe(
    "오늘",
  );
  expect(openedWhen(new Date(2026, 10, 19, 8).getTime(), now, "ko")).toBe(
    "어제",
  );
});
