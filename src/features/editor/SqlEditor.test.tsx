import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { act, render } from "@testing-library/react";
import { startCompletion } from "@codemirror/autocomplete";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
vi.mock("../../shared/api/commands");

import { splitStatements } from "../../shared/api/commands";
import type { StatementSpan } from "../../shared/api/types";
import { deferred } from "../../test/deferred";
import { statementSpansField } from "./statementSpans";
import {
  closeDocument,
  documentSelection,
  documentText,
  openDocument,
} from "./documents";
import { useEditorStatus } from "./editorStatus";
import { SqlEditor } from "./SqlEditor";
import { catalogField } from "./completion";
import { documentState } from "./documents";
import { catalogFixture } from "../../test/fixtures";

beforeEach(() => {
  vi.mocked(splitStatements).mockReset();
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
  const { container } = render(
    <SqlEditor tabId="a" catalog={null} onDocChange={vi.fn()} />,
  );

  expect(container.querySelector(".cm-content")?.textContent).toContain(
    "SELECT 1",
  );
});

test("고치면 documents가 따라가고 onDocChange를 부른다", () => {
  const onDocChange = vi.fn();
  const { container } = render(
    <SqlEditor tabId="a" catalog={null} onDocChange={onDocChange} />,
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
    <SqlEditor tabId="a" catalog={null} onDocChange={onDocChange} />,
  );
  const view = editorView(container);
  view.dispatch({ changes: { from: 0, insert: "-- " } });

  rerender(<SqlEditor tabId="b" catalog={null} onDocChange={onDocChange} />);
  expect(view.state.doc.toString()).toBe("SELECT 2");
  expect(view.hasFocus).toBe(true);

  rerender(<SqlEditor tabId="a" catalog={null} onDocChange={onDocChange} />);
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
      <SqlEditor tabId="a" catalog={null} onDocChange={onDocChange} />
    </StrictMode>,
  );

  expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
  editorView(container).dispatch({ changes: { from: 0, insert: "-- " } });
  expect(documentText("a")).toBe("-- SELECT 1");
  expect(onDocChange).toHaveBeenCalledTimes(1);
});

test("커서를 옮기면 editorStatus가 바뀐다", () => {
  openDocument("c", "SELECT 2\nFROM t");
  const { container } = render(
    <SqlEditor tabId="c" catalog={null} onDocChange={vi.fn()} />,
  );
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
    <SqlEditor tabId="a" catalog={null} onDocChange={vi.fn()} />,
  );
  editorView(container).dispatch({ selection: { anchor: 4 } });
  expect(useEditorStatus.getState()).toMatchObject({ tabId: "a", column: 5 });

  rerender(<SqlEditor tabId="b" catalog={null} onDocChange={vi.fn()} />);
  expect(useEditorStatus.getState()).toMatchObject({
    tabId: "b",
    line: 1,
    column: 1,
  });

  rerender(<SqlEditor tabId="a" catalog={null} onDocChange={vi.fn()} />);
  expect(useEditorStatus.getState()).toMatchObject({ tabId: "a", column: 5 });
});

test("the_catalog_reaches_the_document", () => {
  const catalog = catalogFixture();
  const { rerender } = render(
    <SqlEditor tabId="a" catalog={catalog} onDocChange={vi.fn()} />,
  );
  expect(documentState("a").field(catalogField)).toBe(catalog);

  const other = catalogFixture({ schemas: ["public"] });
  rerender(<SqlEditor tabId="b" catalog={other} onDocChange={vi.fn()} />);
  expect(documentState("b").field(catalogField)).toBe(other);
  expect(documentState("a").field(catalogField)).toBe(catalog);
});

test("popup_has_kind_letters_and_footer", async () => {
  openDocument("c", "SELECT u.em FROM users u");
  const { container } = render(
    <SqlEditor tabId="c" catalog={catalogFixture()} onDocChange={vi.fn()} />,
  );
  const view = editorView(container);
  act(() => {
    view.dispatch({ selection: { anchor: "SELECT u.em".length } });
    startCompletion(view);
  });

  await vi.waitFor(() =>
    expect(container.querySelector(".cm-tooltip-autocomplete")).not.toBeNull(),
  );
  const popup = container.querySelector<HTMLElement>(
    ".cm-tooltip-autocomplete",
  )!;
  const first = popup.querySelector("li")!;
  expect(first.querySelector(".cm-completionKind")?.textContent).toBe("c");
  expect(first.textContent).toContain("email");
  expect(first.textContent).toContain("users · text");
  await vi.waitFor(() =>
    expect(popup.querySelector(".cm-completionFooter")).not.toBeNull(),
  );
  const footer = popup.querySelector(".cm-completionFooter")!.textContent;
  expect(footer).toContain("Insert");
  expect(footer).toContain("Close");
  expect(footer).toContain(
    "s schema · c column · t table · f function · k keyword",
  );
  closeDocument("c");
});

test("footer_stays_below_the_list_when_options_change", async () => {
  openDocument("d", "SELECT u.e FROM users u");
  const { container } = render(
    <SqlEditor tabId="d" catalog={catalogFixture()} onDocChange={vi.fn()} />,
  );
  const view = editorView(container);
  const at = "SELECT u.e".length;
  act(() => {
    view.dispatch({ selection: { anchor: at } });
    startCompletion(view);
  });
  const popup = () =>
    container.querySelector<HTMLElement>(".cm-tooltip-autocomplete");
  await vi.waitFor(() =>
    expect(
      popup()?.querySelector(".cm-completionFooter") ?? null,
    ).not.toBeNull(),
  );
  const firstList = popup()!.querySelector("ul");

  // 글자를 더 치면 option이 바뀌어 목록이 다시 그려진다.
  act(() => {
    view.dispatch({
      changes: { from: at, insert: "mail_" },
      selection: { anchor: at + 5 },
      userEvent: "input.type",
    });
  });
  await vi.waitFor(() =>
    expect(popup()!.querySelector("ul")).not.toBe(firstList),
  );
  await vi.waitFor(() =>
    expect(popup()!.lastElementChild?.className).toBe("cm-completionFooter"),
  );
  expect(popup()!.querySelectorAll(".cm-completionFooter")).toHaveLength(1);
  closeDocument("d");
});

test("나누는 동안 탭을 바꾸면 그 결과는 버리고 새로 보이는 탭을 나눈다", async () => {
  const late = deferred<StatementSpan[]>();
  vi.mocked(splitStatements).mockReturnValueOnce(late.promise);
  vi.mocked(splitStatements).mockResolvedValue([{ start: 0, end: 8 }]);
  const { container, rerender } = render(
    <SqlEditor tabId="a" catalog={null} onDocChange={vi.fn()} />,
  );
  const view = editorView(container);

  await act(async () => {
    rerender(<SqlEditor tabId="b" catalog={null} onDocChange={vi.fn()} />);
  });
  await act(async () => {
    late.resolve([{ start: 0, end: 1 }]);
  });

  expect(splitStatements).toHaveBeenLastCalledWith("SELECT 2");
  expect(view.state.field(statementSpansField)).toEqual({
    spans: [{ start: 0, end: 8 }],
    fresh: true,
  });
  expect(documentState("a").field(statementSpansField).fresh).toBe(false);
});
