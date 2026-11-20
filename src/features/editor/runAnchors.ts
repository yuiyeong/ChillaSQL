import type { Text, TransactionSpec } from "@codemirror/state";
import { sourceOffset } from "../query/rewrite";
import { useRuns } from "../query/runsStore";
import { dispatchToDocument, findDocument, viewShowing } from "./documents";
import {
  clearRunAnchors,
  errorRange,
  runMarksField,
  setErrorMark,
  setRunAnchor,
} from "./runMarks";

/** 그 실행의 지금 문서 offset과 그 문서. 문서가 그 자리를 지웠거나 닫았으면 null. */
function anchorIn(
  tabId: string,
  runKey: string,
): { offset: number; doc: Text } | null {
  const state = findDocument(tabId);
  const offset = state?.field(runMarksField, false)?.anchors[runKey];
  return state === undefined || offset === undefined
    ? null
    : { offset, doc: state.doc };
}

/** 그 실행의 지금 문서 offset. 문서가 그 자리를 지웠으면 null. */
export function anchorOf(tabId: string, runKey: string): number | null {
  return anchorIn(tabId, runKey)?.offset ?? null;
}

/** 그 실행의 text가 지금 문서에서 시작하는 줄과 칸(1부터). anchor가 없으면 null. */
export function anchorLocation(
  tabId: string,
  runKey: string,
): { line: number; column: number } | null {
  const anchor = anchorIn(tabId, runKey);
  if (anchor === null) return null;
  const line = anchor.doc.lineAt(Math.min(anchor.offset, anchor.doc.length));
  return { line: line.number, column: anchor.offset - line.from + 1 };
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

/** 문서 문장 text 기준 `position`에 밑줄을 긋는다. 그 실행의 anchor가 없으면 긋지 않는다. */
export function markServerError(
  tabId: string,
  runKey: string,
  position: number,
): void {
  const anchor = anchorIn(tabId, runKey);
  if (anchor === null) return;
  dispatchToDocument(tabId, {
    effects: setErrorMark.of(errorRange(anchor.doc, anchor.offset + position)),
  });
}

/** 오류 화면의 Go to error. 오류 자리에 커서를 두고 에디터에 focus한다. */
export function goToError(tabId: string): void {
  const state = useRuns.getState().runs[tabId];
  if (state?.status !== "finished" || state.outcome.outcome !== "failed") {
    return;
  }
  const { position } = state.outcome.error;
  const anchor = anchorIn(tabId, state.result.runKey);
  if (position === null || anchor === null) return;
  const spec: TransactionSpec = {
    selection: {
      anchor: Math.min(
        anchor.offset + sourceOffset(state.result.rewrite, position),
        anchor.doc.length,
      ),
    },
    scrollIntoView: true,
  };
  dispatchToDocument(tabId, spec);
  viewShowing(tabId)?.focus();
}
