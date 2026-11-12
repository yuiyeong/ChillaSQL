import { EditorState } from "@codemirror/state";
import { editorExtensions } from "./extensions";

// 문서 text는 여기의 EditorState에만 둔다. Zustand와 React state에 넣지 않는다.
const documents = new Map<string, EditorState>();

export function openDocument(tabId: string, text: string): void {
  documents.set(
    tabId,
    EditorState.create({ doc: text, extensions: editorExtensions() }),
  );
}

export function documentState(tabId: string): EditorState {
  const state = documents.get(tabId);
  if (state === undefined) throw new Error(`열린 문서가 없습니다: ${tabId}`);
  return state;
}

/** 열려 있는 문서만 바꾼다. 닫은 문서는 mounted editor가 다음 transaction에서 부르더라도 다시 열리지 않는다. */
export function setDocumentState(tabId: string, state: EditorState): void {
  if (documents.has(tabId)) documents.set(tabId, state);
}

export function documentText(tabId: string): string {
  return documentState(tabId).doc.toString();
}

export function documentSelection(tabId: string): {
  from: number;
  to: number;
  head: number;
} {
  const { from, to, head } = documentState(tabId).selection.main;
  return { from, to, head };
}

export function closeDocument(tabId: string): void {
  documents.delete(tabId);
}
