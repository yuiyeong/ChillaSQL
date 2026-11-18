import { EditorSelection, EditorState } from "@codemirror/state";
import { beforeEach, expect, test } from "vitest";
import { useEditorStatus } from "./editorStatus";

beforeEach(() => {
  useEditorStatus.setState(useEditorStatus.getInitialState(), true);
});

test("update는 두 번째 줄 세 번째 칸의 커서를 line 2, column 3으로 기록한다", () => {
  const state = EditorState.create({
    doc: "SELECT 1\nFROM t",
    selection: { anchor: 11 },
  });

  useEditorStatus.getState().update("a", state);

  expect(useEditorStatus.getState()).toMatchObject({
    tabId: "a",
    line: 2,
    column: 3,
    hasSelection: false,
  });
});

test("선택이 있으면 hasSelection이다", () => {
  const state = EditorState.create({
    doc: "SELECT 1",
    selection: EditorSelection.range(0, 6),
  });

  useEditorStatus.getState().update("a", state);

  expect(useEditorStatus.getState().hasSelection).toBe(true);
});

test("column은 UTF-16 단위로 센다", () => {
  const state = EditorState.create({ doc: "😀x", selection: { anchor: 2 } });

  useEditorStatus.getState().update("a", state);

  expect(useEditorStatus.getState().column).toBe(3);
});
