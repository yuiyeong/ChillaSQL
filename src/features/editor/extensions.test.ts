import { PostgreSQL } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { expect, test } from "vitest";
import { editorExtensions } from "./extensions";

interface ParsedNode {
  name: string;
  from: number;
  to: number;
  text: string;
}

function parseNodes(sql: string): ParsedNode[] {
  const nodes: ParsedNode[] = [];
  PostgreSQL.language.parser.parse(sql).iterate({
    enter(node) {
      nodes.push({
        name: node.name,
        from: node.from,
        to: node.to,
        text: sql.slice(node.from, node.to),
      });
    },
  });
  return nodes;
}

function texts(nodes: ParsedNode[], name: string): string[] {
  return nodes.filter((n) => n.name === name).map((n) => n.text);
}

function hasError(nodes: ParsedNode[]): boolean {
  return nodes.some((n) => n.name === "⚠");
}

test("$$ 블록은 String node 하나다", () => {
  const dollar = parseNodes("DO $$ BEGIN PERFORM 1; END $$; SELECT 2");
  expect(texts(dollar, "String")).toContain("$$ BEGIN PERFORM 1; END $$");
  expect(hasError(dollar)).toBe(false);

  const tagged = parseNodes("SELECT $tag$ it's; $tag$");
  expect(texts(tagged, "String")).toContain("$tag$ it's; $tag$");
  expect(hasError(tagged)).toBe(false);
});

test(":: 캐스팅은 오류 없이 type을 칠한다", () => {
  const nodes = parseNodes("SELECT a::int");
  expect(hasError(nodes)).toBe(false);
  expect(texts(nodes, "Type")).toContain("int");
});

test("JSONB 연산자는 Operator node다", () => {
  const nodes = parseNodes(
    "SELECT d->>'k', d->'a', d #>> '{a}', d @> '{}', d ? 'k', d ?| array['a'], d || '{}', d #- '{a}', d @? '$.a'",
  );
  const operators = texts(nodes, "Operator");
  for (const op of ["->>", "->", "#>>", "@>", "?", "?|", "||", "#-", "@?"]) {
    expect(operators).toContain(op);
  }
  expect(hasError(nodes)).toBe(false);
});

test("extension으로 문서를 만들 수 있다", () => {
  const state = EditorState.create({
    doc: "SELECT 1",
    extensions: editorExtensions(),
  });
  expect(state.doc.toString()).toBe("SELECT 1");
});
