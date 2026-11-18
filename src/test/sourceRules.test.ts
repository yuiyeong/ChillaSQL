import ts from "typescript";
import { expect, test } from "vitest";

const HANGUL = /[ㄱ-ㆎ가-힣]/;

// 테스트와 test helper는 뺀다. vite가 파일 내용을 문자열로 넘겨 준다.
const sources = import.meta.glob<string>(
  ["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../test/**"],
  { query: "?raw", import: "default", eager: true },
);

function hangulLiterals(path: string, text: string): string[] {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    // 주석은 AST 노드가 아니라서 여기에 오지 않는다.
    // JSX attribute의 string은 StringLiteral로 온다.
    const isText =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node);
    if (isText && HANGUL.test(node.getText(source))) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${path.slice(3)}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test("화면 code에 한글 문구가 없다", () => {
  expect(Object.keys(sources).length).toBeGreaterThan(10);
  const offenders = Object.entries(sources).flatMap(([path, text]) =>
    hangulLiterals(path, text),
  );
  expect(offenders).toEqual([]);
});
