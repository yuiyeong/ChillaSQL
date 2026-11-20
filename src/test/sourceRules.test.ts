import ts from "typescript";
import { expect, test } from "vitest";

const HANGUL = /[ㄱ-ㆎ가-힣]/;
// 색은 index.css의 token으로만 쓴다. white와 black도 기본 palette라서 함께 막는다.
const DEFAULT_PALETTE_CLASS =
  /\b(?:bg|text|border|outline|ring|divide|fill|stroke)-(?:(?:zinc|gray|slate|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|white|black)\b/;
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;

// 테스트와 test helper는 뺀다. vite가 파일 내용을 문자열로 넘겨 준다.
const sources = import.meta.glob<string>(
  ["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../test/**"],
  { query: "?raw", import: "default", eager: true },
);

// string literal, template 조각, JSX text 가운데 predicate를 만족하는 것의 위치를 모은다.
function literalsMatching(
  path: string,
  text: string,
  matches: (literal: string) => boolean,
  includeJsxText = false,
): string[] {
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
      (includeJsxText && ts.isJsxText(node));
    if (isText && matches(node.getText(source))) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${path.slice(3)}:${line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function offendersOf(
  matches: (literal: string) => boolean,
  includeJsxText = false,
): string[] {
  expect(Object.keys(sources).length).toBeGreaterThan(10);
  return Object.entries(sources).flatMap(([path, text]) =>
    literalsMatching(path, text, matches, includeJsxText),
  );
}

test("화면 code에 한글 문구가 없다", () => {
  // ko.ts는 한국어 dictionary라서 뺀다.
  const offenders = offendersOf((literal) => HANGUL.test(literal), true);
  expect(
    offenders.filter((place) => !place.startsWith("shared/i18n/ko.ts:")),
  ).toEqual([]);
});

test("기본 palette class를 쓰지 않는다", () => {
  expect(offendersOf((literal) => DEFAULT_PALETTE_CLASS.test(literal))).toEqual(
    [],
  );
});

test("색 literal을 쓰지 않는다", () => {
  expect(offendersOf((literal) => COLOR_LITERAL.test(literal))).toEqual([]);
});
