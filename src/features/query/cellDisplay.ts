import type { Cell, TypeInfo } from "../../shared/api/types";
import { formatCount, t } from "../../shared/i18n/t";

export type ValueKind = "number" | "json" | "vector" | "text";

/** vector에서 앞 몇 개의 값을 보이는지. 값이 이보다 많을 때만 줄인다. */
const VECTOR_SHOWN = 3;

/** 결과 컬럼의 type이 값을 어떻게 그릴지 정한다. type을 모르면 text다. */
export function valueKind(type: TypeInfo | undefined): ValueKind {
  if (type === undefined) return "text";
  if (type.name === "json" || type.name === "jsonb") return "json";
  if (/^(vector|halfvec)(\(|$)/.test(type.name)) return "vector";
  return type.category === "N" ? "number" : "text";
}

/** 표의 한 줄 표시. dim은 fg-3로 그릴 꼬리(`1536 values`)다. */
export function cellText(
  value: Cell,
  kind: ValueKind,
): { text: string; dim: string | null } {
  if (value === null) return { text: "NULL", dim: null };
  if (value === "") return { text: "''", dim: null };
  if (kind === "json") return { text: collapseJson(value), dim: null };
  if (kind === "vector") return shortenVector(value);
  return { text: value, dim: null };
}

/** `[a,b,c,d]`의 앞 세 값과 개수. 세 값 이하이거나 모양이 다르면 그대로 둔다. */
function shortenVector(value: string): { text: string; dim: string | null } {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    return { text: value, dim: null };
  }
  const values = value.slice(1, -1).split(",");
  if (values.length <= VECTOR_SHOWN) return { text: value, dim: null };
  return {
    text: `[${values.slice(0, VECTOR_SHOWN).join(", ")}, …`,
    dim: t("result.vectorValues", { count: formatCount(values.length) }),
  };
}

/** 이보다 긴 JSON은 접지 않는다. 접으려면 통째로 parse해야 해서 표를 그릴 때마다 큰 값을 읽게 된다. */
const JSON_COLLAPSE_LIMIT = 100_000;

const WHITESPACE = /\s/;

/** `start`의 문자열 literal이 끝난 다음 index */
function endOfString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  return i + 1;
}

/** `start`의 `{`나 `[`가 닫힌 다음 index */
function endOfContainer(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      i = endOfString(text, i);
      continue;
    }
    if (char === "{" || char === "[") depth++;
    if (char === "}" || char === "]") depth--;
    i++;
    if (depth === 0) break;
  }
  return i;
}

/**
 * JSON을 한 줄로 쓰고 둘째 층부터의 object와 array를 `{…}`, `[…]`로 접는다. 값은 원문 그대로 옮겨
 * 숫자 표기와 key 순서가 바뀌지 않는다. JSON이 아니면 원문이다.
 */
function collapseJson(text: string): string {
  if (text.length > JSON_COLLAPSE_LIMIT) return text;
  try {
    JSON.parse(text);
  } catch {
    return text;
  }
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (WHITESPACE.test(char)) {
      i++;
    } else if (char === '"') {
      const end = endOfString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (char === "{" || char === "[") {
      if (depth === 0) {
        depth++;
        out += char;
        i++;
        continue;
      }
      const close = char === "{" ? "}" : "]";
      let next = i + 1;
      while (WHITESPACE.test(text[next])) next++;
      out += text[next] === close ? char + close : `${char}…${close}`;
      i = endOfContainer(text, i);
    } else if (char === "}" || char === "]") {
      depth--;
      out += char;
      i++;
    } else if (char === ",") {
      out += ", ";
      i++;
    } else if (char === ":") {
      out += ": ";
      i++;
    } else {
      // 숫자, true, false, null
      let end = i;
      while (end < text.length && !/[\s,:\]}]/.test(text[end])) end++;
      out += text.slice(i, end);
      i = end;
    }
  }
  return out;
}
