import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionStatus,
} from "@codemirror/autocomplete";
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
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { t } from "../../shared/i18n/t";
import { catalogCompletion, kindLetter } from "./completion";

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
    // 자동완성 popup. 캔버스 Tools의 M7 자동완성(.pop, .ac)을 따른다.
    ".cm-tooltip.cm-tooltip-autocomplete": {
      width: "340px",
      padding: "4px",
      boxSizing: "border-box",
      backgroundColor: color("bg-3"),
      border: `1px solid ${color("line-2")}`,
      borderRadius: "8px",
      boxShadow: "var(--shadow-popover)",
      color: color("fg"),
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul": {
      fontFamily: "inherit",
      maxHeight: "260px",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
      display: "flex",
      alignItems: "center",
      gap: "10px",
      height: "26px",
      padding: "0 8px",
      borderRadius: "5px",
      fontSize: "var(--text-small)",
      lineHeight: "26px",
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: `color-mix(in srgb, ${color("accent")} 16%, transparent)`,
      color: color("fg"),
    },
    ".cm-completionKind": {
      width: "16px",
      flexShrink: "0",
      textAlign: "center",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-tiny)",
      color: color("fg-3"),
    },
    ".cm-completionLabel": {
      fontFamily: "var(--font-mono)",
      overflow: "hidden",
      textOverflow: "ellipsis",
    },
    ".cm-completionMatchedText": {
      textDecoration: "none",
      fontWeight: "700",
    },
    ".cm-completionDetail": {
      marginLeft: "auto",
      paddingLeft: "8px",
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-label)",
      fontStyle: "normal",
      color: color("fg-2"),
      whiteSpace: "nowrap",
    },
    ".cm-completionFooter": {
      display: "flex",
      gap: "14px",
      marginTop: "4px",
      padding: "6px 8px 2px",
      borderTop: `1px solid ${color("line-2")}`,
      fontSize: "var(--text-label)",
      color: color("fg-2"),
      whiteSpace: "nowrap",
    },
    ".cm-completionLegend": { marginLeft: "auto" },
    ".cm-completionKbd": {
      fontFamily: "inherit",
      fontSize: "var(--text-label)",
      fontWeight: "500",
      padding: "1px 5px",
      borderRadius: "4px",
      backgroundColor: color("line-2"),
      color: color("fg-2"),
    },
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

/** `autocompletion`의 설정 type. package가 이름으로 export하지 않는다. */
type CompletionConfig = NonNullable<Parameters<typeof autocompletion>[0]>;

/** 자동완성 설정. 입력하면 바로 뜬다(기본 지연 100ms로는 0.05초를 못 맞춘다). */
export const AUTOCOMPLETION: CompletionConfig = {
  activateOnTypingDelay: 0,
  icons: false,
  addToOptions: [
    {
      render(completion) {
        const kind = document.createElement("span");
        kind.className = "cm-completionKind";
        kind.textContent = kindLetter(completion);
        return kind;
      },
      position: 20,
    },
  ],
};

/** popup 아래의 안내 줄: `↵ Insert`, `esc Close`, kind 글자의 뜻. */
function completionFooter(): HTMLElement {
  const footer = document.createElement("div");
  footer.className = "cm-completionFooter";
  const hint = (key: string, label: string) => {
    const item = document.createElement("span");
    const kbd = document.createElement("kbd");
    kbd.className = "cm-completionKbd";
    kbd.textContent = key;
    item.append(kbd, ` ${label}`);
    return item;
  };
  const legend = document.createElement("span");
  legend.className = "cm-completionLegend";
  legend.textContent = t("completion.legend");
  footer.append(
    hint("↵", t("completion.insert")),
    hint("esc", t("completion.close")),
    legend,
  );
  return footer;
}

/**
 * popup이 열려 있는 동안 끝에 안내 줄을 둔다. autocomplete는 option이 바뀔 때마다 목록을 떼었다가
 * popup 끝에 다시 붙이므로, 그때마다 안내 줄을 목록 뒤로 옮긴다. popup은 tooltip이 그린 뒤에
 * 있으므로 measure의 write에서 본다.
 */
const footerPlugin = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate) {
      if (completionStatus(update.state) !== "active") return;
      update.view.requestMeasure({
        key: footerPlugin,
        read: () => null,
        write: (_, view) => {
          const popup = view.dom.querySelector(".cm-tooltip-autocomplete");
          if (popup === null) return;
          const footer =
            popup.querySelector(":scope > .cm-completionFooter") ??
            completionFooter();
          if (popup.lastElementChild !== footer) popup.append(footer);
        },
      });
    }
  },
);

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
  // keyword는 대문자로 넣는다. catalog의 source는 catalogCompletion이 더한다.
  sql({ dialect: PostgreSQL, upperCaseKeywords: true }),
  catalogCompletion,
  autocompletion(AUTOCOMPLETION),
  footerPlugin,
  editorTheme,
  syntaxHighlighting(syntaxStyle),
];

/** SQL 편집기의 extension. 자동완성은 문서의 catalog(`setCatalog`)를 쓴다. */
export function editorExtensions(): Extension {
  return extensions;
}
