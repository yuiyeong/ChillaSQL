import { EditorSelection } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { format } from "sql-formatter";
import { documentState, setDocumentState, viewShowing } from "./documents";

const OPTIONS = {
  language: "postgresql",
  keywordCase: "preserve",
  tabWidth: 2,
} as const;

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/y;

/**
 * text가 sql-formatter에 맡기면 SQL이 바뀌는 모양이면 그 이유. 아니면 null이다. 닫히지 않은
 * block comment, 문자열, 식별자, dollar-quote 본문은 sql-formatter가 throw하지 않고 `/ * abc`
 * 처럼 바꾸는 경우가 있어 먼저 알아본다. PostgreSQL의 block comment는 중첩되고, 문자열(`'`, `E'`),
 * 식별자(`"`), `--` 주석, dollar-quote 안의 `/*`는 주석을 열지 않는다.
 */
export function unclosedReason(text: string): string | null {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (depth > 0) {
      if (two === "/*") {
        depth++;
        i += 2;
      } else if (two === "*/") {
        depth--;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    const char = text[i];
    if (two === "/*") {
      depth++;
      i += 2;
    } else if (two === "--") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end + 1;
    } else if (char === "'") {
      const escaped =
        /[eE]/.test(text[i - 1] ?? "") && !IDENT_CHAR.test(text[i - 2] ?? "");
      i = closingQuote(text, i, escaped);
      if (i === -1) return "unclosed string";
    } else if (char === '"') {
      i = closingQuote(text, i, false);
      if (i === -1) return "unclosed quoted identifier";
    } else if (char === "$" && !IDENT_CHAR.test(text[i - 1] ?? "")) {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(text)?.[0];
      if (tag === undefined) {
        i++;
      } else {
        const end = text.indexOf(tag, i + tag.length);
        if (end === -1) return "unclosed dollar-quoted string";
        i = end + tag.length;
      }
    } else {
      i++;
    }
  }
  return depth > 0 ? "unclosed block comment" : null;
}

/** `start`의 여는 quote 뒤 닫는 quote 다음 위치. 닫히지 않으면 -1이다. `''`는 quote 둘로 읽어도 같다. */
function closingQuote(text: string, start: number, escaped: boolean): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (escaped && text[i] === "\\") i++;
    else if (text[i] === quote) return i + 1;
  }
  return -1;
}

/** 공백이 아닌 글자가 `count`개 나온 직후의 위치 */
function offsetAfterSolid(text: string, count: number): number {
  if (count === 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\S/.test(text[i])) seen++;
    if (seen === count) return i + 1;
  }
  return text.length;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}

/** 선택 영역이 있으면 그것만, 없으면 문서 전체. 바꾸지 못하면 그 이유. */
export function reformatDocument(
  tabId: string,
): { ok: true } | { ok: false; reason: string } {
  const state = documentState(tabId);
  const { from: selFrom, to: selTo, head } = state.selection.main;
  const whole = selFrom === selTo;
  const from = whole ? 0 : selFrom;
  const to = whole ? state.doc.length : selTo;
  const original = state.sliceDoc(from, to);
  if (original.trim() === "") return { ok: true };

  const unclosed = unclosedReason(original);
  if (unclosed !== null) return { ok: false, reason: unclosed };
  let formatted: string;
  try {
    // sql-formatter는 앞뒤 공백을 지우므로 범위의 것을 다시 붙인다. 선택 밖 줄과 파일 끝 줄바꿈이 남는다.
    formatted =
      /^\s*/.exec(original)![0] +
      format(original, OPTIONS) +
      /\s*$/.exec(original)![0];
  } catch (error) {
    return { ok: false, reason: firstLine(error) };
  }
  if (formatted === original) return { ok: true };

  // 선택 영역은 새 text를 감싼다. 전체는 cursor를 같은 token 자리에 둔다.
  const selection = whole
    ? EditorSelection.cursor(
        offsetAfterSolid(
          formatted,
          state.sliceDoc(0, head).replace(/\s/g, "").length,
        ),
      )
    : EditorSelection.single(from, from + formatted.length);
  const spec = {
    changes: { from, to, insert: formatted },
    selection,
    scrollIntoView: true,
    // 앞뒤 입력과 한 undo 단위로 묶이지 않고, 한 번으로 돌아간다.
    annotations: isolateHistory.of("full"),
  };
  const view = viewShowing(tabId);
  if (view !== null) {
    // SqlEditor의 dispatchTransactions가 documents, 상태 표시줄, dirty를 따라가게 한다.
    view.dispatch(spec);
  } else {
    setDocumentState(tabId, state.update(spec).state);
  }
  return { ok: true };
}
