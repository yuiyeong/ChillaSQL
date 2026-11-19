import { PostgreSQL } from "@codemirror/lang-sql";
import { highlightingFor } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { tags } from "@lezer/highlight";
import { expect, test } from "vitest";
import { sqlCompletionSources } from "./completion";
import { AUTOCOMPLETION, editorExtensions, syntaxStyle } from "./extensions";

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

test("문법 색은 token을 쓴다", () => {
  const state = EditorState.create({ extensions: editorExtensions() });
  const rules = syntaxStyle.module?.getRules() ?? "";
  const expected: [string, Parameters<typeof highlightingFor>[1], string][] = [
    ["keyword", [tags.keyword], "keyword"],
    ["string", [tags.string], "string"],
    ["number", [tags.number], "number"],
    ["comment", [tags.comment], "comment"],
    ["operator", [tags.operator], "operator"],
    ["typeName", [tags.typeName], "type"],
    ["function", [tags.function(tags.variableName)], "function"],
    ["standard", [tags.standard(tags.name)], "function"],
    ["name", [tags.name], "identifier"],
  ];
  for (const [label, tagList, token] of expected) {
    const cls = highlightingFor(state, tagList);
    expect(cls, label).toBeTruthy();
    expect(rules, label).toContain(
      `.${cls} {color: var(--color-syntax-${token})`,
    );
  }
  expect(rules).toContain("font-style: italic");
});

test("문법 색에 hex literal이 없다(oneDark 등 외부 theme을 쓰지 않는다)", () => {
  expect(syntaxStyle.module?.getRules()).not.toMatch(/#[0-9a-f]{3,6}/i);
});

test("autocompletion_is_on_without_typing_delay", () => {
  expect(AUTOCOMPLETION.activateOnTypingDelay).toBe(0);
  expect(AUTOCOMPLETION.icons).toBe(false);
  expect(AUTOCOMPLETION.override).toEqual([...sqlCompletionSources()]);
});
