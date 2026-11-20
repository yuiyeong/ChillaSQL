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
  /** 문서나 선택이 바뀔 때마다 늘어난다. 편집을 따라 옮겨지는 위치(실행 anchor)를 다시 읽을 때 본다. */
  revision: number;
  update(tabId: string, state: EditorState): void;
}

/** status bar가 보여 주는 에디터의 cursor 위치. 문서 text는 담지 않는다. */
/** 화면은 값 하나씩(primitive) 고르므로 같은 값을 다시 넣어도 다시 그리지 않는다. */
export const useEditorStatus = create<EditorStatus>()((set) => ({
  tabId: null,
  hasSelection: false,
  line: 1,
  column: 1,
  revision: 0,
  update(tabId, state) {
    const { head, empty } = state.selection.main;
    const line = state.doc.lineAt(head);
    set((s) => ({
      revision: s.revision + 1,
      tabId,
      hasSelection: !empty,
      line: line.number,
      column: head - line.from + 1,
    }));
  },
}));
