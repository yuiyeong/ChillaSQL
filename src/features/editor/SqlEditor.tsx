import { EditorView } from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { Catalog } from "../../shared/api/types";
import { catalogField, setCatalog } from "./completion";
import { documentState, setDocumentState } from "./documents";
import { useEditorStatus } from "./editorStatus";

interface SqlEditorProps {
  tabId: string;
  /** 자동완성에 쓸 활성 탭 접속의 catalog. 없으면 keyword만 나온다. */
  catalog: Catalog | null;
  onDocChange(tabId: string): void;
}

/** EditorView 하나를 갖고, tabId가 바뀌면 그 tab의 EditorState로 바꾼다. */
export function SqlEditor({ tabId, catalog, onDocChange }: SqlEditorProps) {
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
    const initial = documentState(shownTabRef.current);
    useEditorStatus.getState().update(shownTabRef.current, initial);
    const view = new EditorView({
      state: initial,
      parent,
      dispatchTransactions(trs, view) {
        view.update(trs);
        const shownTab = shownTabRef.current;
        setDocumentState(shownTab, view.state);
        if (trs.some((tr) => tr.docChanged || tr.selection !== undefined)) {
          useEditorStatus.getState().update(shownTab, view.state);
        }
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
    // 문서가 없어 throw하면 view가 보이는 탭을 바꾸지 않는다.
    const state = documentState(tabId);
    shownTabRef.current = tabId;
    view.setState(state);
    useEditorStatus.getState().update(tabId, state);
    view.focus();
  }, [tabId]);

  // 탭을 바꾼 effect 뒤에 돈다. 바뀐 문서에도 지금 catalog를 넣는다.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    if (view.state.field(catalogField, false) === catalog) return;
    view.dispatch({ effects: setCatalog.of(catalog) });
  }, [catalog, tabId]);

  return <div ref={parentRef} className="h-full" />;
}
