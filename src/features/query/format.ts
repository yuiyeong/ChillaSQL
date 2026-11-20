import { lineColumn } from "../editor/statementAt";
import { t, tc } from "../../shared/i18n/t";
import { sourceOffset, sourceText } from "./rewrite";
import type { Origin, ResultData } from "./runReducer";

/** 1 ms 밑은 소수 둘째 자리 ms, 1 s 밑은 정수 ms, 그 위는 소수 둘째 자리 s. 반올림한 값으로 단위를 고른다. */
export function formatElapsed(micros: number): string {
  if (micros < 1_000) return `${(micros / 1_000).toFixed(2)} ms`;
  const millis = Math.round(micros / 1_000);
  if (millis < 1_000) return `${millis} ms`;
  return `${(micros / 1_000_000).toFixed(2)} s`;
}

/**
 * 서버가 준 오류 위치(보낸 text의 UTF-16 offset)를 문서의 줄과 칸으로 바꾼다. 고쳐 보냈으면 문서의 문장
 * text 기준으로 센다. `origin`은 문서의 문장이 지금 문서에서 시작하는 곳이다. 편집을 따라 옮긴 값을
 * 넘기고, 없으면 실행한 때의 값을 쓴다.
 */
export function errorLocation(
  result: ResultData,
  position: number,
  origin: Origin = result.origin,
): { line: number; column: number } {
  const { line, column } = lineColumn(
    sourceText(result),
    sourceOffset(result.rewrite, position),
  );
  return line === 1
    ? { line: origin.line, column: origin.column + column - 1 }
    : { line: origin.line + line - 1, column };
}

/** 실행 중 경과 시간. 소수 첫째 자리 초다. */
export function formatLive(millis: number): string {
  return `${(millis / 1_000).toFixed(1)} s`;
}

const AFFECTED_KEYS = {
  INSERT: "result.inserted",
  UPDATE: "result.updated",
  DELETE: "result.deleted",
  MERGE: "result.merged",
} as const;

/** 열이 없는 결과의 문구. INSERT/UPDATE/DELETE/MERGE는 행 수를 쓰고 나머지는 Done이다. WITH는 본 문장으로 본다. */
export function affectedText(sql: string, rows: number): string {
  const { word } = statementOf(sql);
  return word in AFFECTED_KEYS
    ? tc(AFFECTED_KEYS[word as keyof typeof AFFECTED_KEYS], rows)
    : t("result.done");
}

/**
 * label과 문구를 정하는 데 쓰는 SQL token. 공백, 주석, 문자열(`'…'`, `E'…'`, `$tag$…$tag$`)은
 * token이 아니다. 문자열은 그 자리를 지키도록 `literal` 하나로 남긴다. `depth`는 그 token을 감싼 괄호 수다.
 */
interface Token {
  kind: "word" | "quoted" | "symbol" | "literal";
  text: string;
  depth: number;
}

const WORD = /[\p{L}_][\p{L}\p{N}_$]*/uy;
const NUMBER = /\p{N}[\p{L}\p{N}_.]*/uy;
const DOLLAR_TAG = /\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/uy;

function matchAt(pattern: RegExp, sql: string, at: number): string | null {
  pattern.lastIndex = at;
  return pattern.exec(sql)?.[0] ?? null;
}

/** `'`에서 시작한 문자열의 끝 다음 위치. `backslash`면 `\'`도 건너뛴다. 닫히지 않으면 text의 끝이다. */
function quoteEnd(sql: string, from: number, backslash: boolean): number {
  let i = from + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (backslash && c === "\\") {
      i += 2;
    } else if (c === "'") {
      if (sql[i + 1] !== "'") return i + 1;
      i += 2;
    } else {
      i += 1;
    }
  }
  return sql.length;
}

/** `/*`에서 시작한 주석의 끝 다음 위치. PostgreSQL처럼 겹친 주석을 센다. */
function blockCommentEnd(sql: string, from: number): number {
  let depth = 0;
  let i = from;
  while (i < sql.length) {
    if (sql.startsWith("/*", i)) {
      depth += 1;
      i += 2;
    } else if (sql.startsWith("*/", i)) {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return sql.length;
}

/** 앞에서부터 필요한 만큼만 읽는다. 긴 INSERT도 앞 몇 token에서 끝난다. */
function* tokensOf(sql: string): Generator<Token> {
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
    } else if (sql.startsWith("/*", i)) {
      i = blockCommentEnd(sql, i);
    } else if (c === "'") {
      i = quoteEnd(sql, i, false);
      yield { kind: "literal", text: "", depth };
    } else if (c === '"') {
      let end = i + 1;
      for (;;) {
        end = sql.indexOf('"', end);
        if (end === -1 || sql[end + 1] !== '"') break;
        end += 2;
      }
      end = end === -1 ? sql.length : end + 1;
      yield { kind: "quoted", text: sql.slice(i, end), depth };
      i = end;
    } else {
      yield otherToken();
    }
  }

  /** 문자열, 이름, 숫자, 기호 하나를 읽는다. */
  function otherToken(): Token {
    const c = sql[i];
    const tag = c === "$" ? matchAt(DOLLAR_TAG, sql, i) : null;
    if (tag !== null) {
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      return { kind: "literal", text: "", depth };
    }
    const word = matchAt(WORD, sql, i);
    if (word !== null) {
      i += word.length;
      // E'…'는 backslash escape를 쓰는 문자열이다.
      if ((word === "E" || word === "e") && sql[i] === "'") {
        i = quoteEnd(sql, i, true);
        return { kind: "literal", text: "", depth };
      }
      return { kind: "word", text: word, depth };
    }
    const number = matchAt(NUMBER, sql, i);
    if (number !== null) {
      i += number.length;
      return { kind: "literal", text: "", depth };
    }
    if (c === ")") depth = Math.max(0, depth - 1);
    const symbol: Token = { kind: "symbol", text: c, depth };
    if (c === "(") depth += 1;
    i += 1;
    return symbol;
  }
}

/** token을 몇 개 앞까지 볼 수 있는 iterator */
class Cursor {
  private readonly ahead: Token[] = [];
  constructor(private readonly tokens: Iterator<Token>) {}

  peek(offset = 0): Token | undefined {
    while (this.ahead.length <= offset) {
      const next = this.tokens.next();
      if (next.done === true) return undefined;
      this.ahead.push(next.value);
    }
    return this.ahead[offset];
  }

  next(): Token | undefined {
    const token = this.peek();
    this.ahead.shift();
    return token;
  }
}

function isWord(token: Token | undefined, ...words: string[]): boolean {
  return token?.kind === "word" && words.includes(token.text.toUpperCase());
}

/** WITH 뒤의 본 문장이 될 수 있는 단어 */
const MAIN_WORDS = ["INSERT", "UPDATE", "DELETE", "MERGE", "SELECT"];

/**
 * 문장의 첫 단어(대문자)와 그 단어부터 읽는 cursor. 앞의 `(`는 건너뛴다.
 * WITH면 CTE 목록 뒤의 본 문장(WITH와 같은 괄호 깊이의 첫 `MAIN_WORDS`)이고, 찾지 못하면 WITH다.
 * 첫 token이 단어가 아니면 빈 문자열이다.
 */
function statementOf(sql: string): { word: string; cursor: Cursor } {
  const cursor = new Cursor(tokensOf(sql));
  while (cursor.peek()?.kind === "symbol" && cursor.peek()!.text === "(") {
    cursor.next();
  }
  const first = cursor.peek();
  if (first?.kind !== "word") return { word: "", cursor };
  const word = first.text.toUpperCase();
  if (word !== "WITH") return { word, cursor };
  cursor.next();
  for (let token = cursor.peek(); token !== undefined; token = cursor.peek()) {
    if (token.depth === first.depth && isWord(token, ...MAIN_WORDS)) {
      return { word: token.text.toUpperCase(), cursor };
    }
    cursor.next();
  }
  return { word, cursor };
}

/** 이 단어 뒤의 이름이 label의 대상이다. */
const TARGET_WORDS = ["FROM", "INTO", "UPDATE", "TABLE", "JOIN"];

function isName(token: Token | undefined): boolean {
  return token?.kind === "word" || token?.kind === "quoted";
}

/**
 * cursor 자리부터 `TARGET_WORDS` 뒤의 첫 이름(`schema.name`까지). `IF NOT EXISTS`, `IF EXISTS`, `ONLY`는 건너뛴다.
 * 함수 안의 FROM(`extract(year FROM ts)`)은 가려내지 않아 `ts`가 대상이 된다.
 */
function targetOf(cursor: Cursor): string | undefined {
  for (let token = cursor.next(); token !== undefined; token = cursor.next()) {
    if (!isWord(token, ...TARGET_WORDS)) continue;
    if (isWord(cursor.peek(), "IF")) {
      const skip = isWord(cursor.peek(1), "EXISTS")
        ? 2
        : isWord(cursor.peek(1), "NOT") && isWord(cursor.peek(2), "EXISTS")
          ? 3
          : 0;
      for (let i = 0; i < skip; i += 1) cursor.next();
    } else if (isWord(cursor.peek(), "ONLY")) {
      cursor.next();
    }
    if (!isName(cursor.peek())) continue;
    let name = cursor.next()!.text;
    const dot = cursor.peek();
    if (dot?.kind === "symbol" && dot.text === "." && isName(cursor.peek(1))) {
      cursor.next();
      name += `.${cursor.next()!.text}`;
    }
    return name;
  }
  return undefined;
}

const LABEL_LIMIT = 32;

/** 결과 tab 이름. 첫 단어와 대상 이름이다. 예: `SELECT users`. 둘 다 없으면 Result다. */
export function resultLabel(sql: string): string {
  const { word, cursor } = statementOf(sql);
  const target = targetOf(cursor);
  const label =
    [word, target].filter((part) => part).join(" ") || t("result.label");
  if ([...label].length <= LABEL_LIMIT) return label;
  return `${[...label].slice(0, LABEL_LIMIT - 1).join("")}…`;
}
