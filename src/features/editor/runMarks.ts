import {
  MapMode,
  StateEffect,
  StateField,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { useRuns } from "../query/runsStore";
import { dispatchToDocument, findDocument, viewShowing } from "./documents";

export interface RunMarks {
  /** runKey → 그 실행의 text가 시작한 문서 offset */
  anchors: Record<string, number>;
  /** 서버가 알려 준 오류 자리의 밑줄 */
  error: { from: number; to: number } | null;
}

/** 실행한 문장의 시작을 문서 offset으로 두고 변경을 따라 옮긴다. runKey는 runsStore의 실행 하나(여러 문장이면 문장마다). */
export const setRunAnchor = StateEffect.define<{
  runKey: string;
  from: number;
}>();

/** 밑줄을 긋는다. null이면 지운다. */
export const setErrorMark = StateEffect.define<{
  from: number;
  to: number;
} | null>();

/** 지난 실행의 anchor를 모두 지운다. 새 실행의 anchor를 두기 전에 보낸다. */
export const clearRunAnchors = StateEffect.define<null>();

function touches(
  mark: { from: number; to: number },
  fromA: number,
  toA: number,
): boolean {
  // 끼워 넣기는 밑줄 안이나 끝(단어가 늘어남)이어야 건드린 것이다. 시작 앞은 건드리지 않는다.
  if (fromA === toA) return mark.from < fromA && fromA <= mark.to;
  return fromA < mark.to && toA > mark.from;
}

export const runMarksField = StateField.define<RunMarks>({
  create: () => ({ anchors: {}, error: null }),
  update(value, tr) {
    let { anchors, error } = value;
    if (tr.docChanged) {
      // 문장 앞에서 입력하면 문장이 밀린다. 그 자리를 지웠으면 anchor를 버린다.
      const moved: Record<string, number> = {};
      for (const [key, pos] of Object.entries(anchors)) {
        const next = tr.changes.mapPos(pos, 1, MapMode.TrackDel);
        if (next !== null) moved[key] = next;
      }
      anchors = moved;
      if (error !== null) {
        const mark = error;
        let hit = false;
        tr.changes.iterChangedRanges((fromA, toA) => {
          if (touches(mark, fromA, toA)) hit = true;
        });
        error = hit
          ? null
          : {
              from: tr.changes.mapPos(mark.from, 1),
              to: tr.changes.mapPos(mark.to, -1),
            };
      }
    }
    for (const effect of tr.effects) {
      if (effect.is(clearRunAnchors)) {
        anchors = {};
      } else if (effect.is(setRunAnchor)) {
        anchors = { ...anchors, [effect.value.runKey]: effect.value.from };
      } else if (effect.is(setErrorMark)) {
        error = effect.value;
      }
    }
    return anchors === value.anchors && error === value.error
      ? value
      : { anchors, error };
  },
  provide: (field) =>
    EditorView.decorations.from(field, ({ error }) =>
      error === null || error.from >= error.to
        ? Decoration.none
        : Decoration.set([
            Decoration.mark({ class: "cm-errorMark" }).range(
              error.from,
              error.to,
            ),
          ]),
    ),
});

/** 그 실행의 지금 문서 offset. 문서가 그 자리를 지웠으면 null. */
export function anchorOf(tabId: string, runKey: string): number | null {
  return (
    findDocument(tabId)?.field(runMarksField, false)?.anchors[runKey] ?? null
  );
}

/** 그 실행의 text가 지금 문서에서 시작하는 줄과 칸(1부터). anchor가 없으면 null. */
export function anchorLocation(
  tabId: string,
  runKey: string,
): { line: number; column: number } | null {
  const anchor = anchorOf(tabId, runKey);
  const doc = findDocument(tabId)?.doc;
  if (anchor === null || doc === undefined) return null;
  const line = doc.lineAt(Math.min(anchor, doc.length));
  return { line: line.number, column: anchor - line.from + 1 };
}

const WORD_CHAR = /[\p{L}\p{N}_$]/u;

/** 오류 위치(보낸 text의 UTF-16 offset)의 밑줄 범위: 그 자리의 단어 끝까지, 단어가 아니면 한 글자. */
export function errorRange(
  doc: Text,
  at: number,
): { from: number; to: number } {
  const pos = Math.max(0, Math.min(at, doc.length));
  const line = doc.lineAt(pos);
  if (pos === line.to) {
    // 줄 끝(문장 끝)을 가리키면 그 앞 글자에 긋는다. 줄바꿈에는 밑줄이 보이지 않는다.
    if (pos === line.from) return { from: pos, to: pos };
    const previous = line.text.codePointAt(pos - line.from - 1)!;
    const lowSurrogate = previous >= 0xdc00 && previous <= 0xdfff;
    return { from: pos - (lowSurrogate ? 2 : 1), to: pos };
  }
  const rest = line.text.slice(pos - line.from);
  const first = rest.codePointAt(0)!;
  const firstLength = first > 0xffff ? 2 : 1;
  if (!WORD_CHAR.test(String.fromCodePoint(first))) {
    return { from: pos, to: pos + firstLength };
  }
  let end = 0;
  for (const char of rest) {
    if (!WORD_CHAR.test(char)) break;
    end += char.length;
  }
  return { from: pos, to: pos + end };
}

/**
 * 실행을 시작했다. 그 탭 문서에 이번 실행의 시작 offset을 두고 지난 실행의 anchor와 오류 밑줄을 지운다.
 * 한 요청이 여러 문장이면 문장마다 넘긴다.
 */
export function markRunStart(
  tabId: string,
  steps: { runKey: string; from: number }[],
): void {
  dispatchToDocument(tabId, {
    effects: [
      clearRunAnchors.of(null),
      ...steps.map((step) => setRunAnchor.of(step)),
      setErrorMark.of(null),
    ],
  });
}

/** 서버 오류의 `position`(보낸 text 기준)에 밑줄을 긋는다. 그 실행의 anchor가 없으면 긋지 않는다. */
export function markServerError(
  tabId: string,
  runKey: string,
  position: number,
): void {
  const anchor = anchorOf(tabId, runKey);
  const doc = findDocument(tabId)?.doc;
  if (anchor === null || doc === undefined) return;
  dispatchToDocument(tabId, {
    effects: setErrorMark.of(errorRange(doc, anchor + position)),
  });
}

/** 오류 화면의 Go to error. 오류 자리에 커서를 두고 에디터에 focus한다. */
export function goToError(tabId: string): void {
  const state = useRuns.getState().runs[tabId];
  if (state?.status !== "finished" || state.outcome.outcome !== "failed") {
    return;
  }
  const { position } = state.outcome.error;
  const anchor = anchorOf(tabId, state.result.runKey);
  const doc = findDocument(tabId)?.doc;
  if (position === null || anchor === null || doc === undefined) return;
  const spec: TransactionSpec = {
    selection: { anchor: Math.min(anchor + position, doc.length) },
    scrollIntoView: true,
  };
  dispatchToDocument(tabId, spec);
  viewShowing(tabId)?.focus();
}
