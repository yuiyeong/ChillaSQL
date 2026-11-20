import { expect, test } from "vitest";
import type { ParameterSpan } from "../../shared/api/types";
import { prepend, sourceOffset, sourceText, substitute } from "./rewrite";
import type { ScriptStep } from "./runReducer";

const origin = { line: 1, column: 1 };

function stepOf(sql: string): ScriptStep {
  return { sql, from: 0, origin };
}

/** `:name`의 span을 sql에서 찾는다. 테스트용이라 문자열 안은 가리지 않는다. */
function spansOf(sql: string): ParameterSpan[] {
  return [...sql.matchAll(/:([a-z_]+)/g)]
    .filter((m) => sql[m.index - 1] !== ":" && sql[m.index + 1] !== ":")
    .map((m) => ({
      name: m[1],
      start: m.index,
      end: m.index + m[0].length,
    }));
}

const SQL = "WHERE id = :id AND d > :since::date";
const VALUES = { id: "10482", since: "'2026-11-01'" };

test("substitutes_values_from_the_end", () => {
  const step = substitute(stepOf(SQL), spansOf(SQL), VALUES);

  expect(step.sql).toBe("WHERE id = 10482 AND d > '2026-11-01'::date");
  expect(sourceText(step)).toBe(SQL);
  expect(step.rewrite?.edits).toEqual([
    { sentFrom: 11, sentTo: 16, sourceFrom: 11, sourceTo: 14 },
    { sentFrom: 25, sentTo: 37, sourceFrom: 23, sourceTo: 29 },
  ]);
  expect(step.from).toBe(0);
});

test("substitute_repeats_a_name_and_keeps_a_step_without_parameters", () => {
  const sql = "SELECT :a, :a";
  const step = substitute(stepOf(sql), spansOf(sql), { a: "1" });
  expect(step.sql).toBe("SELECT 1, 1");

  const plain = stepOf("SELECT 1");
  expect(substitute(plain, [], {})).toBe(plain);
  expect("rewrite" in plain).toBe(false);
});

test("substitute_throws_for_a_missing_value", () => {
  expect(() => substitute(stepOf(SQL), spansOf(SQL), { id: "1" })).toThrow();
});

test("position_after_a_value_maps_back", () => {
  const step = substitute(stepOf(SQL), spansOf(SQL), VALUES);
  const sent = step.sql;

  // ` AND` 앞의 공백, `::date`의 첫 `:`, 끝
  expect(sourceOffset(step.rewrite, sent.indexOf(" AND"))).toBe(
    SQL.indexOf(" AND"),
  );
  expect(sourceOffset(step.rewrite, sent.indexOf("::date"))).toBe(
    SQL.indexOf("::date"),
  );
  expect(sourceOffset(step.rewrite, sent.length)).toBe(SQL.length);
  // 값 바로 뒤는 `:name` 뒤의 글자다.
  expect(sourceOffset(step.rewrite, 16)).toBe(14);
  // 값 앞은 그대로다.
  expect(sourceOffset(step.rewrite, 6)).toBe(6);
});

test("position_inside_a_value_points_at_the_parameter", () => {
  const sql = "SELECT * FROM t WHERE name = :name";
  const step = substitute(stepOf(sql), spansOf(sql), { name: "'kim'" });
  const at = step.sql.indexOf("'kim'");

  expect(sourceOffset(step.rewrite, at)).toBe(sql.indexOf(":name"));
  expect(sourceOffset(step.rewrite, at + 2)).toBe(sql.indexOf(":name"));
  expect(sourceOffset(step.rewrite, at + 4)).toBe(sql.indexOf(":name"));
  expect(sourceOffset(step.rewrite, at + 5)).toBe(sql.length);
});

test("prepend_shifts_existing_edits", () => {
  const prefix = "EXPLAIN ANALYZE ";
  const step = prepend(substitute(stepOf(SQL), spansOf(SQL), VALUES), prefix);
  const n = prefix.length;

  expect(step.sql).toBe(`${prefix}WHERE id = 10482 AND d > '2026-11-01'::date`);
  expect(sourceText(step)).toBe(SQL);
  // 앞부분 안
  expect(sourceOffset(step.rewrite, 0)).toBe(0);
  expect(sourceOffset(step.rewrite, n - 1)).toBe(0);
  // 앞부분 바로 뒤는 문장의 처음이다.
  expect(sourceOffset(step.rewrite, n)).toBe(0);
  // 첫 값 안과 뒤
  expect(sourceOffset(step.rewrite, n + 11)).toBe(11);
  expect(sourceOffset(step.rewrite, n + 13)).toBe(11);
  expect(sourceOffset(step.rewrite, n + 16)).toBe(14);
  // 둘째 값 안과 뒤
  expect(sourceOffset(step.rewrite, n + 25 + 3)).toBe(23);
  expect(sourceOffset(step.rewrite, step.sql.indexOf("::date"))).toBe(
    SQL.indexOf("::date"),
  );
});

test("prepend_alone_maps_the_prefix_to_zero", () => {
  const step = prepend(stepOf("SELECT x"), "EXPLAIN ");

  expect(step.sql).toBe("EXPLAIN SELECT x");
  expect(sourceText(step)).toBe("SELECT x");
  expect(sourceOffset(step.rewrite, 3)).toBe(0);
  expect(sourceOffset(step.rewrite, 8)).toBe(0);
  expect(sourceOffset(step.rewrite, 15)).toBe(7);
});

test("no_rewrite_is_identity", () => {
  const step = stepOf("SELECT 1");

  expect(sourceOffset(undefined, 5)).toBe(5);
  expect(sourceText(step)).toBe("SELECT 1");
  expect(prepend(step, "")).toBe(step);
});
