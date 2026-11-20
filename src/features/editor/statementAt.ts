import type { StatementSpan } from "../../shared/api/types";

/** CodeMirror의 `Text`가 만족하는 부분. 전체 문서를 string으로 만들지 않고 필요한 구간만 읽는다. */
export interface TextLike {
  length: number;
  sliceString(from: number, to?: number): string;
}

/**
 * 커서가 가리키는 문장을 고른다. spans는 start 오름차순이고 end는 포함하지 않으며 `;`를 담지 않는다.
 *
 * 1. 커서가 문장 안이나 끝에 있으면 그 문장.
 * 2. 아니면 같은 줄에서 커서 앞에 끝난 마지막 문장.
 * 3. 아니면 같은 줄에서 커서 뒤에 시작하는 첫 문장.
 */
export function statementAt(
  text: TextLike,
  spans: StatementSpan[],
  cursor: number,
): StatementSpan | null {
  const inside = spans.find((s) => s.start <= cursor && cursor <= s.end);
  if (inside !== undefined) return inside;

  let before: StatementSpan | undefined;
  for (const s of spans) {
    if (s.end < cursor) before = s;
  }
  if (
    before !== undefined &&
    !text.sliceString(before.end, cursor).includes("\n")
  ) {
    return before;
  }

  const after = spans.find((s) => s.start > cursor);
  if (
    after !== undefined &&
    !text.sliceString(cursor, after.start).includes("\n")
  ) {
    return after;
  }

  return null;
}

/** 1부터 세는 줄과 칸(UTF-16 code unit). */
export function lineColumn(
  text: string,
  offset: number,
): { line: number; column: number } {
  const prefix = text.slice(0, offset);
  const lines = prefix.split("\n");
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}
