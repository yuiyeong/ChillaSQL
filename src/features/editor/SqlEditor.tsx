import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { documentState, setDocumentState } from "./documents";

interface SqlEditorProps {
  tabId: string;
  onDocChange(tabId: string): void;
}

/** EditorView 하나를 갖고, tabId가 바뀌면 그 tab의 EditorState로 바꾼다. */
export function SqlEditor({ tabId, onDocChange }: SqlEditorProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // view가 들고 있는 state의 tab. dispatchTransactions가 이 값을 본다.
  const shownTabRef = useRef(tabId);
  const onDocChangeRef = useRef(onDocChange);

  useEffect(() => {
    onDocChangeRef.current = onDocChange;
  });

  useEffect(() => {
    const parent = parentRef.current;
    if (parent === null) return;
    const view = new EditorView({
      state: documentState(shownTabRef.current),
      parent,
      dispatchTransactions(trs, view) {
        view.update(trs);
        const shownTab = shownTabRef.current;
        setDocumentState(shownTab, view.state);
        if (trs.some((tr) => tr.docChanged)) onDocChangeRef.current(shownTab);
      },
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null || shownTabRef.current === tabId) return;
    shownTabRef.current = tabId;
    view.setState(documentState(tabId));
    view.focus();
  }, [tabId]);

  return <div ref={parentRef} className="h-full" />;
}
