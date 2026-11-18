import { expect, test } from "vitest";
import {
  affectedText,
  errorLocation,
  formatElapsed,
  formatLive,
  resultLabel,
} from "./format";
import { emptyResult } from "./runReducer";

test("formatElapsed", () => {
  expect(formatElapsed(420)).toBe("0.42 ms");
  expect(formatElapsed(123456)).toBe("123 ms");
  expect(formatElapsed(1234567)).toBe("1.23 s");
});

test("formatElapsed는 반올림한 뒤에 단위를 고른다", () => {
  expect(formatElapsed(999)).toBe("1.00 ms");
  expect(formatElapsed(999_600)).toBe("1.00 s");
});

test("errorLocation은 보낸 text의 위치를 문서의 줄과 칸으로 바꾼다", () => {
  const result = emptyResult("SELECT *\nFROM nope", { line: 3, column: 5 }, 0);

  expect(errorLocation(result, 0)).toEqual({ line: 3, column: 5 });
  expect(errorLocation(result, 7)).toEqual({ line: 3, column: 12 });
  expect(errorLocation(result, 14)).toEqual({ line: 4, column: 6 });
});

test("formatLive는 소수 한 자리 초로 쓴다", () => {
  expect(formatLive(4230)).toBe("4.2 s");
  expect(formatLive(0)).toBe("0.0 s");
});

test("affectedText", () => {
  expect(affectedText("update users set a=1", 12)).toBe("12 rows updated");
  expect(affectedText("delete from t", 1)).toBe("1 row deleted");
  expect(affectedText("-- c\ninsert into t values (1)", 1)).toBe(
    "1 row inserted",
  );
  expect(affectedText("merge into t using s on true", 3)).toBe("3 rows merged");
  expect(affectedText("create table t()", 0)).toBe("Done");
});

test("resultLabel", () => {
  expect(resultLabel("-- 최근\nselect * from users u")).toBe("SELECT users");
  expect(resultLabel("UPDATE public.users SET a = 1")).toBe(
    "UPDATE public.users",
  );
  expect(resultLabel('insert into "Order" values (1)')).toBe('INSERT "Order"');
  expect(resultLabel("select pg_sleep(1)")).toBe("SELECT");
});

test("resultLabel은 주석을 건너뛰고 긴 label을 자른다", () => {
  expect(resultLabel("/* a */ -- b\n  delete from t")).toBe("DELETE t");
  const label = resultLabel(`select * from ${"a".repeat(60)}`);
  expect(label).toBe(`SELECT ${"a".repeat(24)}…`);
  expect([...label]).toHaveLength(32);
});
