import { EditorState } from "@codemirror/state";
import { editorExtensions } from "./extensions";

// 문서 text는 여기의 EditorState에만 둔다. Zustand와 React state에 넣지 않는다.
const documents = new Map<string, EditorState>();
/**
 * CRLF로 읽은 문서. 저장할 때 줄 끝을 CRLF로 돌린다. EditorState는 줄 끝을 \n으로 맞춘
 * 채로 둔다. `EditorState.lineSeparator`를 "\r\n"으로 두면 붙여 넣은 \n text가 줄로
 * 나뉘지 않기 때문이다.
 */
const crlfDocuments = new Set<string>();

export function openDocument(tabId: string, text: string): void {
  documents.set(
    tabId,
    EditorState.create({ doc: text, extensions: editorExtensions() }),
  );
  if (text.includes("\r\n")) crlfDocuments.add(tabId);
  else crlfDocuments.delete(tabId);
}

/** 닫은 문서는 undefined */
export function findDocument(tabId: string): EditorState | undefined {
  return documents.get(tabId);
}

export function documentState(tabId: string): EditorState {
  const state = findDocument(tabId);
  if (state === undefined) throw new Error(`No open document: ${tabId}`);
  return state;
}

/** 열려 있는 문서만 바꾼다. 닫은 문서는 mounted editor가 다음 transaction에서 부르더라도 다시 열리지 않는다. */
export function setDocumentState(tabId: string, state: EditorState): void {
  if (documents.has(tabId)) documents.set(tabId, state);
}

/** 줄 끝이 \n인 text. offset이 CodeMirror의 위치와 같다. 실행 경로가 쓴다. */
export function documentText(tabId: string): string {
  return documentState(tabId).doc.toString();
}

/** 디스크에 쓸 text. 줄 끝은 읽은 파일의 것(CRLF 또는 \n)이다. */
export function documentFileText(tabId: string): string {
  const { doc } = documentState(tabId);
  return doc.sliceString(
    0,
    doc.length,
    documentLineEnding(tabId) === "CRLF" ? "\r\n" : "\n",
  );
}

/** status bar에 보일 줄 끝. 읽은 파일의 것이다. */
export function documentLineEnding(tabId: string): "LF" | "CRLF" {
  return crlfDocuments.has(tabId) ? "CRLF" : "LF";
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
  crlfDocuments.delete(tabId);
}
