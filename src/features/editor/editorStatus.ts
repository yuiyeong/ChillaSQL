import type { EditorState } from "@codemirror/state";
import { create } from "zustand";

interface EditorStatus {
  /** 아래 값이 가리키는 탭. 에디터가 아직 값을 보내지 않았으면 null */
  tabId: string | null;
  hasSelection: boolean;
  /** 1부터 */
  line: number;
  /** 1부터. UTF-16 code unit 기준 */
  column: number;
  update(tabId: string, state: EditorState): void;
}

/** status bar가 보여 주는 에디터의 cursor 위치. 문서 text는 담지 않는다. */
export const useEditorStatus = create<EditorStatus>()((set, get) => ({
  tabId: null,
  hasSelection: false,
  line: 1,
  column: 1,
  update(tabId, state) {
    const { head, empty } = state.selection.main;
    const line = state.doc.lineAt(head);
    const next = {
      tabId,
      hasSelection: !empty,
      line: line.number,
      column: head - line.from + 1,
    };
    const current = get();
    // 같은 값이면 구독한 화면을 다시 그리지 않는다.
    if (
      current.tabId === next.tabId &&
      current.hasSelection === next.hasSelection &&
      current.line === next.line &&
      current.column === next.column
    )
      return;
    set(next);
  },
}));
