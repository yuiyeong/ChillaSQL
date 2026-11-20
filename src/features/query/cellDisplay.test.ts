import { expect, test } from "vitest";
import type { TypeInfo } from "../../shared/api/types";
import { cellText, valueKind } from "./cellDisplay";

function type(name: string, category: string): TypeInfo {
  return { oid: 1, modifier: -1, name, category };
}

test("numeric_category_is_a_number", () => {
  expect(valueKind(type("bigint", "N"))).toBe("number");
  expect(valueKind(type("numeric(10,2)", "N"))).toBe("number");
  // 숫자의 배열은 category가 A라 숫자가 아니다.
  expect(valueKind(type("integer[]", "A"))).toBe("text");
});

test("json_and_jsonb_are_json", () => {
  expect(valueKind(type("json", "U"))).toBe("json");
  expect(valueKind(type("jsonb", "U"))).toBe("json");
});

test("vector_and_halfvec_are_vectors", () => {
  expect(valueKind(type("vector(1536)", "U"))).toBe("vector");
  expect(valueKind(type("halfvec(3072)", "U"))).toBe("vector");
  expect(valueKind(type("vector", "U"))).toBe("vector");
});

test("unknown_type_is_text", () => {
  expect(valueKind(undefined)).toBe("text");
  expect(valueKind(type("text", "S"))).toBe("text");
  expect(valueKind(type("timestamp with time zone", "D"))).toBe("text");
});

test("json_collapses_nested_values", () => {
  expect(
    cellText(
      '{"plan":"pro","billing":{"cycle":"yearly"},"tags":["a"]}',
      "json",
    ),
  ).toEqual({
    text: '{"plan": "pro", "billing": {…}, "tags": […]}',
    dim: null,
  });
  // 서버가 jsonb를 이미 이렇게 쓴다. 줄바꿈이 있는 json도 한 줄이 된다.
  expect(
    cellText('{\n  "a": [1, 2],\n  "b": {"c": {"d": 1}}\n}', "json").text,
  ).toBe('{"a": […], "b": {…}}');
  expect(cellText('[{"a": 1}, 2, [3]]', "json").text).toBe("[{…}, 2, […]]");
  // 비어 있는 것은 접을 것이 없다.
  expect(cellText('{"a": {}, "b": []}', "json").text).toBe(
    '{"a": {}, "b": []}',
  );
});

test("json_keeps_scalars_and_string_contents", () => {
  expect(
    cellText('{"a": "x, {y}: [z]", "n": 1.50, "t": true}', "json").text,
  ).toBe('{"a": "x, {y}: [z]", "n": 1.50, "t": true}');
  expect(cellText('{"q": "a\\"{"}', "json").text).toBe('{"q": "a\\"{"}');
  expect(cellText('{"a": {"b": "}"}, "c": 1}', "json").text).toBe(
    '{"a": {…}, "c": 1}',
  );
});

test("json_scalar_and_invalid_stay", () => {
  expect(cellText('"x"', "json")).toEqual({ text: '"x"', dim: null });
  expect(cellText("42", "json").text).toBe("42");
  expect(cellText("{bad", "json")).toEqual({ text: "{bad", dim: null });
});

test("vector_shows_three_values_and_the_count", () => {
  expect(cellText("[0.0213,-0.114,0.0871,0.5]", "vector")).toEqual({
    text: "[0.0213, -0.114, 0.0871, …",
    dim: "4 values",
  });
  const long = `[${Array.from({ length: 1536 }, (_, i) => i / 10).join(",")}]`;
  expect(cellText(long, "vector").dim).toBe("1,536 values");
});

test("short_vector_stays", () => {
  expect(cellText("[1,2,3]", "vector")).toEqual({
    text: "[1,2,3]",
    dim: null,
  });
  expect(cellText("not a vector", "vector").dim).toBeNull();
});

test("null_and_empty_string_are_unchanged", () => {
  for (const kind of ["number", "json", "vector", "text"] as const) {
    expect(cellText(null, kind)).toEqual({ text: "NULL", dim: null });
    expect(cellText("", kind)).toEqual({ text: "''", dim: null });
  }
});

test("text_and_number_are_as_is", () => {
  expect(cellText("{a,b}", "text")).toEqual({ text: "{a,b}", dim: null });
  expect(cellText("10482", "number")).toEqual({ text: "10482", dim: null });
});

test("huge_json_is_not_collapsed", () => {
  const huge = `{"a": {"b": "${"x".repeat(100_000)}"}}`;
  expect(cellText(huge, "json").text).toBe(huge);
});
