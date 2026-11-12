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

export function setDocumentState(tabId: string, state: EditorState): void {
  documents.set(tabId, state);
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
