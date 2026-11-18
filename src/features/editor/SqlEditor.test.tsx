import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  closeDocument,
  documentSelection,
  documentText,
  openDocument,
} from "./documents";
import { useEditorStatus } from "./editorStatus";
import { SqlEditor } from "./SqlEditor";

beforeEach(() => {
  useEditorStatus.setState(useEditorStatus.getInitialState(), true);
  openDocument("a", "SELECT 1");
  openDocument("b", "SELECT 2");
});

afterEach(() => {
  closeDocument("a");
  closeDocument("b");
});

function editorView(container: HTMLElement): EditorView {
  const dom = container.querySelector<HTMLElement>(".cm-editor");
  if (dom === null) throw new Error(".cm-editor가 없습니다");
  const view = EditorView.findFromDOM(dom);
  if (view === null) throw new Error("EditorView가 없습니다");
  return view;
}

test("tab의 문서를 그린다", () => {
  const { container } = render(<SqlEditor tabId="a" onDocChange={vi.fn()} />);

  expect(container.querySelector(".cm-content")?.textContent).toContain(
    "SELECT 1",
  );
});

test("고치면 documents가 따라가고 onDocChange를 부른다", () => {
  const onDocChange = vi.fn();
  const { container } = render(
    <SqlEditor tabId="a" onDocChange={onDocChange} />,
  );
  const view = editorView(container);

  view.dispatch({ changes: { from: 0, insert: "-- " } });

  expect(documentText("a")).toBe("-- SELECT 1");
  expect(onDocChange).toHaveBeenCalledTimes(1);
  expect(onDocChange).toHaveBeenCalledWith("a");

  view.dispatch({ selection: { anchor: 2, head: 5 } });

  expect(onDocChange).toHaveBeenCalledTimes(1);
  expect(documentSelection("a")).toEqual({ from: 2, to: 5, head: 5 });
});

test("tab을 바꿨다 돌아와도 내용과 undo 기록이 남는다", () => {
  const onDocChange = vi.fn();
  const { container, rerender } = render(
    <SqlEditor tabId="a" onDocChange={onDocChange} />,
  );
  const view = editorView(container);
  view.dispatch({ changes: { from: 0, insert: "-- " } });

  rerender(<SqlEditor tabId="b" onDocChange={onDocChange} />);
  expect(view.state.doc.toString()).toBe("SELECT 2");
  expect(view.hasFocus).toBe(true);

  rerender(<SqlEditor tabId="a" onDocChange={onDocChange} />);
  expect(view.state.doc.toString()).toBe("-- SELECT 1");
  expect(documentText("a")).toBe("-- SELECT 1");

  undo(view);

  expect(view.state.doc.toString()).toBe("SELECT 1");
  expect(documentText("a")).toBe("SELECT 1");
  expect(documentText("b")).toBe("SELECT 2");
});

test("StrictMode에서도 EditorView는 하나다", () => {
  const onDocChange = vi.fn();
  const { container } = render(
    <StrictMode>
      <SqlEditor tabId="a" onDocChange={onDocChange} />
    </StrictMode>,
  );

  expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
  editorView(container).dispatch({ changes: { from: 0, insert: "-- " } });
  expect(documentText("a")).toBe("-- SELECT 1");
  expect(onDocChange).toHaveBeenCalledTimes(1);
});

test("커서를 옮기면 editorStatus가 바뀐다", () => {
  openDocument("c", "SELECT 2\nFROM t");
  const { container } = render(<SqlEditor tabId="c" onDocChange={vi.fn()} />);
  expect(useEditorStatus.getState()).toMatchObject({
    tabId: "c",
    line: 1,
    column: 1,
  });

  editorView(container).dispatch({ selection: { anchor: 11, head: 13 } });

  expect(useEditorStatus.getState()).toMatchObject({
    tabId: "c",
    line: 2,
    column: 5,
    hasSelection: true,
  });
  closeDocument("c");
});

test("탭을 바꾸면 그 탭의 위치를 보여 준다", () => {
  const { container, rerender } = render(
    <SqlEditor tabId="a" onDocChange={vi.fn()} />,
  );
  editorView(container).dispatch({ selection: { anchor: 4 } });
  expect(useEditorStatus.getState()).toMatchObject({ tabId: "a", column: 5 });

  rerender(<SqlEditor tabId="b" onDocChange={vi.fn()} />);
  expect(useEditorStatus.getState()).toMatchObject({
    tabId: "b",
    line: 1,
    column: 1,
  });

  rerender(<SqlEditor tabId="a" onDocChange={vi.fn()} />);
  expect(useEditorStatus.getState()).toMatchObject({ tabId: "a", column: 5 });
});
