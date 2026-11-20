import { expect, test } from "vitest";
import { highlightSql } from "./highlightSql";

const flat = (lines: ReturnType<typeof highlightSql>) =>
  lines.flat().filter((piece) => piece.text.trim() !== "");

test("keywords_types_and_functions_get_classes", () => {
  const pieces = flat(
    highlightSql(
      "CREATE TABLE users (id bigint, at timestamptz DEFAULT now())",
    ),
  );
  const classOf = (text: string) =>
    pieces.find((piece) => piece.text === text)?.className;

  expect(classOf("CREATE")).toBe("text-syntax-keyword");
  expect(classOf("TABLE")).toBe("text-syntax-keyword");
  expect(classOf("bigint")).toBe("text-syntax-type");
  expect(classOf("now")).toBe("text-syntax-function");
});

test("strings_numbers_and_comments_get_classes", () => {
  const pieces = flat(highlightSql("SELECT 'a', 42 -- note"));
  const classOf = (text: string) =>
    pieces.find((piece) => piece.text === text)?.className;

  expect(classOf("'a'")).toBe("text-syntax-string");
  expect(classOf("42")).toBe("text-syntax-number");
  expect(classOf("-- note")).toContain("text-syntax-comment");
});

test("keeps_every_character", () => {
  const text = [
    "CREATE TABLE public.users (",
    "  id bigint NOT NULL,",
    "  name text DEFAULT 'x'",
    ");",
    "",
    "CREATE INDEX i ON public.users USING btree (name);",
  ].join("\n");
  const lines = highlightSql(text);

  expect(lines).toHaveLength(6);
  const joined = lines
    .map((line) => line.map((piece) => piece.text).join(""))
    .join("\n");
  expect(joined).toBe(text);
});

test("empty_text_is_one_empty_line", () => {
  expect(highlightSql("")).toEqual([[]]);
});
