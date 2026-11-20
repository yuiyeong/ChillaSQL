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
  const result = emptyResult(
    { sql: "SELECT *\nFROM nope", from: 0, origin: { line: 3, column: 5 } },
    "run-0",
    0,
  );

  expect(errorLocation(result, 0)).toEqual({ line: 3, column: 5 });
  expect(errorLocation(result, 7)).toEqual({ line: 3, column: 12 });
  expect(errorLocation(result, 14)).toEqual({ line: 4, column: 6 });
  // 문서에서 옮겨진 시작을 따른다.
  expect(errorLocation(result, 14, { line: 5, column: 1 })).toEqual({
    line: 6,
    column: 6,
  });
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

test("resultLabel은 앞의 괄호를 건너뛰고, 첫 단어가 없으면 Result다", () => {
  expect(resultLabel("(SELECT 1) UNION (SELECT 2)")).toBe("SELECT");
  expect(resultLabel("((select * from t)) union (select * from u)")).toBe(
    "SELECT t",
  );
  expect(resultLabel("")).toBe("Result");
  expect(resultLabel("-- 주석만\n")).toBe("Result");
  expect(resultLabel("'x'")).toBe("Result");
});

test("resultLabel은 문자열과 주석 안의 FROM을 보지 않는다", () => {
  expect(resultLabel("SELECT 'from x' AS a")).toBe("SELECT");
  expect(resultLabel("SELECT 'it''s from x' AS a FROM t")).toBe("SELECT t");
  expect(resultLabel(String.raw`SELECT E'\' from x' AS a`)).toBe("SELECT");
  expect(resultLabel("SELECT $$ from x $$ AS a")).toBe("SELECT");
  expect(resultLabel("SELECT $q$ from 'x' $$ $q$ AS a FROM t")).toBe(
    "SELECT t",
  );
  expect(resultLabel("SELECT 1 /* from x /* from y */ */ -- from z\n")).toBe(
    "SELECT",
  );
  // 함수 안의 FROM은 가려내지 않는다.
  expect(resultLabel("SELECT extract(year FROM ts)")).toBe("SELECT ts");
});

test("resultLabel은 IF NOT EXISTS, IF EXISTS, ONLY 뒤의 이름을 쓴다", () => {
  expect(resultLabel("CREATE TABLE IF NOT EXISTS foo (id int)")).toBe(
    "CREATE foo",
  );
  expect(resultLabel("drop table if exists public.foo")).toBe(
    "DROP public.foo",
  );
  expect(resultLabel("DELETE FROM ONLY t")).toBe("DELETE t");
  expect(resultLabel("UPDATE ONLY t SET a = 1")).toBe("UPDATE t");
});

test("WITH 문장은 CTE 목록 뒤의 본 문장으로 label과 문구를 정한다", () => {
  const update =
    "WITH x AS (SELECT 1 FROM a) UPDATE t SET a = 1 WHERE id IN (SELECT * FROM x)";
  expect(affectedText(update, 42)).toBe("42 rows updated");
  expect(resultLabel(update)).toBe("UPDATE t");

  const select =
    "with d as (delete from a returning *), e(x) as materialized (select 1) select * from d";
  expect(affectedText(select, 3)).toBe("Done");
  expect(resultLabel(select)).toBe("SELECT d");

  expect(
    affectedText(
      "WITH RECURSIVE r AS (SELECT ')' UNION ALL SELECT 1) /* ( */ INSERT INTO t SELECT * FROM r",
      2,
    ),
  ).toBe("2 rows inserted");
  expect(resultLabel("WITH x AS (SELECT 1)")).toBe("WITH");
});
