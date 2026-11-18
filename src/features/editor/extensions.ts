import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import type { Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

const color = (name: string) => `var(--color-${name})`;

// 색은 src/index.css의 token이다. 캔버스(Main.dc.html)의 에디터를 따른다.
// 실행 범위 강조(active line)는 캔버스에 없어 넣지 않는다(M8).
const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: color("bg-1"),
      color: color("fg"),
    },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--font-mono)" },
    ".cm-content": {
      fontSize: "15px",
      lineHeight: "24px",
      fontVariantLigatures: "none",
      caretColor: color("fg"),
    },
    ".cm-line": { lineHeight: "24px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: color("fg") },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
      {
        backgroundColor: `color-mix(in srgb, ${color("accent")} 16%, transparent)`,
      },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: color("fg-3"),
      border: "none",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      boxSizing: "border-box",
      minWidth: "56px",
      padding: "0 12px 0 0",
      textAlign: "right",
    },
    ".cm-panels": { backgroundColor: color("bg-2"), color: color("fg") },
    ".cm-panels.cm-panels-bottom": {
      borderTop: `1px solid ${color("line-1")}`,
    },
  },
  { dark: true },
);

/** 문법 색. 테스트가 이 style의 rule을 읽는다. */
export const syntaxStyle = HighlightStyle.define([
  { tag: tags.keyword, color: color("syntax-keyword") },
  { tag: tags.string, color: color("syntax-string") },
  { tag: tags.number, color: color("syntax-number") },
  {
    tag: tags.comment,
    color: color("syntax-comment"),
    fontStyle: "italic",
  },
  { tag: tags.operator, color: color("syntax-operator") },
  { tag: tags.typeName, color: color("syntax-type") },
  { tag: tags.name, color: color("syntax-identifier") },
  {
    tag: [tags.function(tags.variableName), tags.standard(tags.name)],
    color: color("syntax-function"),
  },
]);

// 모든 문서가 같은 extension 값을 나눠 쓴다.
const extensions: Extension = [
  lineNumbers(),
  history(),
  drawSelection(),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...historyKeymap,
    ...searchKeymap,
    indentWithTab,
  ]),
  sql({ dialect: PostgreSQL }),
  editorTheme,
  syntaxHighlighting(syntaxStyle),
];

/** SQL 편집기의 extension. 자동 완성은 넣지 않는다. */
export function editorExtensions(): Extension {
  return extensions;
}
