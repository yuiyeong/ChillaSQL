import type { ParameterSpan } from "../../shared/api/types";
import type { ScriptStep } from "./runReducer";

/** 보낸 text의 [sentFrom, sentTo)가 문서 문장 text의 [sourceFrom, sourceTo)를 대신한다. UTF-16 */
export interface SentEdit {
  sentFrom: number;
  sentTo: number;
  sourceFrom: number;
  sourceTo: number;
}

/**
 * 문서의 문장 text(`source`)를 고쳐 보낸 것. `edits`는 보낸 text 기준이고 sentFrom 오름차순이며
 * 겹치지 않는다.
 */
export interface Rewrite {
  source: string;
  edits: SentEdit[];
}

/**
 * `spans`(step.sql 기준)의 `:name`을 `values`의 text로 바꿔 보낼 step. 값이 없는 이름은 호출한 쪽의
 * 잘못이므로 던진다. 이미 `rewrite`가 있는 step은 받지 않는다.
 */
export function substitute(
  step: ScriptStep,
  spans: ParameterSpan[],
  values: Record<string, string>,
): ScriptStep {
  if (step.rewrite !== undefined) {
    throw new Error("cannot substitute into a step that already has a rewrite");
  }
  if (spans.length === 0) return step;
  let sql = "";
  let copied = 0;
  const edits: SentEdit[] = [];
  for (const { name, start, end } of spans) {
    if (!Object.prototype.hasOwnProperty.call(values, name)) {
      throw new Error(`no value for parameter :${name}`);
    }
    sql += step.sql.slice(copied, start);
    const sentFrom = sql.length;
    sql += values[name];
    edits.push({
      sentFrom,
      sentTo: sql.length,
      sourceFrom: start,
      sourceTo: end,
    });
    copied = end;
  }
  sql += step.sql.slice(copied);
  return { ...step, sql, rewrite: { source: step.sql, edits } };
}

/** 보낼 text 앞에 `prefix`를 붙인 step. 이미 있는 rewrite는 뒤로 밀어 이어 간다. */
export function prepend(step: ScriptStep, prefix: string): ScriptStep {
  if (prefix === "") return step;
  const shift = prefix.length;
  const edits: SentEdit[] = [
    { sentFrom: 0, sentTo: shift, sourceFrom: 0, sourceTo: 0 },
    ...(step.rewrite?.edits ?? []).map((edit) => ({
      ...edit,
      sentFrom: edit.sentFrom + shift,
      sentTo: edit.sentTo + shift,
    })),
  ];
  return {
    ...step,
    sql: prefix + step.sql,
    rewrite: { source: sourceText(step), edits },
  };
}

/**
 * 보낸 text의 offset을 문서 문장 text의 offset으로 바꾼다. 바꾼 자리 안(`sentFrom <= sent < sentTo`)이면
 * 그 자리의 sourceFrom이고, 바꾼 자리 바로 뒤(`sent === sentTo`)는 sourceTo다.
 */
export function sourceOffset(
  rewrite: Rewrite | undefined,
  sent: number,
): number {
  if (rewrite === undefined) return sent;
  // 앞 edit들이 보낸 text를 얼마나 늘렸는지(문서 text 기준 offset으로 바꿀 때 뺀다).
  let shift = 0;
  for (const edit of rewrite.edits) {
    if (sent < edit.sentFrom) break;
    if (sent < edit.sentTo) return edit.sourceFrom;
    shift = edit.sentTo - edit.sourceTo;
  }
  return sent - shift;
}

/** 문서의 문장 text. 바꾸지 않았으면 보낸 text 그대로다. */
export function sourceText(step: { sql: string; rewrite?: Rewrite }): string {
  return step.rewrite?.source ?? step.sql;
}
