import { expect, test } from "vitest";
import { dayLabel, timeOfDay } from "./when";

const now = new Date(2026, 10, 20, 0, 5).getTime();

test("labels_today_yesterday_and_dates", () => {
  // 자정 직후: 방금 지난 자정 전은 어제다.
  expect(dayLabel(new Date(2026, 10, 20, 0, 0).getTime(), now)).toBe("Today");
  expect(dayLabel(new Date(2026, 10, 19, 23, 59, 59).getTime(), now)).toBe(
    "Yesterday",
  );
  expect(dayLabel(new Date(2026, 10, 19, 0, 0).getTime(), now)).toBe(
    "Yesterday",
  );
  expect(dayLabel(new Date(2026, 10, 18, 23, 59).getTime(), now)).toBe(
    "Nov 18",
  );
  expect(dayLabel(new Date(2026, 10, 9, 10, 0).getTime(), now)).toBe("Nov 9");
  // 자정 직전
  const late = new Date(2026, 10, 20, 23, 59).getTime();
  expect(dayLabel(new Date(2026, 10, 20, 0, 0).getTime(), late)).toBe("Today");
  expect(dayLabel(new Date(2026, 10, 19, 23, 59).getTime(), late)).toBe(
    "Yesterday",
  );
});

test("time_is_24_hour", () => {
  expect(timeOfDay(new Date(2026, 10, 20, 9, 41).getTime())).toBe("09:41");
  expect(timeOfDay(new Date(2026, 10, 20, 17, 3).getTime())).toBe("17:03");
  expect(timeOfDay(new Date(2026, 10, 20, 0, 0).getTime())).toBe("00:00");
  expect(timeOfDay(new Date(2026, 10, 20, 23, 59).getTime())).toBe("23:59");
});
