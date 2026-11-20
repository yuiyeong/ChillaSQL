import { highlightCode, tagHighlighter, tags } from "@lezer/highlight";
import { sqlParser } from "./extensions";

export interface HighlightedPiece {
  text: string;
  /** `text-syntax-*` class. 색이 없는 조각은 "" */
  className: string;
}

// 에디터의 `syntaxStyle`과 같은 tag다. HighlightStyle의 CSS는 편집기 밖에 mount되지 않아서 tag를 class로 옮긴다.
const highlighter = tagHighlighter([
  { tag: tags.keyword, class: "text-syntax-keyword" },
  { tag: tags.string, class: "text-syntax-string" },
  { tag: tags.number, class: "text-syntax-number" },
  { tag: tags.comment, class: "text-syntax-comment italic" },
  { tag: tags.operator, class: "text-syntax-operator" },
  { tag: tags.typeName, class: "text-syntax-type" },
  { tag: tags.name, class: "text-syntax-identifier" },
  {
    tag: [tags.function(tags.variableName), tags.standard(tags.name)],
    class: "text-syntax-function",
  },
]);

const IDENTIFIER = "text-syntax-identifier";
const FUNCTION = "text-syntax-function";

/**
 * 에디터와 같은 색으로 칠하되, 바로 `(`가 따르는 이름(`now()`)은 함수 색으로 칠한다.
 * parser는 내장 함수 몇 개만 키워드로 알아서 `now`, `gen_random_uuid`는 이름으로만 읽는다.
 */
function markCalls(lines: HighlightedPiece[][]): void {
  for (const line of lines) {
    line.forEach((piece, index) => {
      if (
        piece.className === IDENTIFIER &&
        line[index + 1]?.text.startsWith("(")
      ) {
        piece.className = FUNCTION;
      }
    });
  }
}

/** SQL을 에디터와 같은 색으로 칠할 조각으로 나눈다. 줄마다 조각 목록이고 조각을 이으면 원문이다. */
export function highlightSql(text: string): HighlightedPiece[][] {
  const lines: HighlightedPiece[][] = [[]];
  highlightCode(
    text,
    sqlParser.parse(text),
    highlighter,
    (piece, className) =>
      lines[lines.length - 1].push({ text: piece, className }),
    () => lines.push([]),
  );
  markCalls(lines);
  return lines;
}
