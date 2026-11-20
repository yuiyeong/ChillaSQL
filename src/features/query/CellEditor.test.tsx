import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { change } from "../../test/change";
import { expectNoTextCorrection } from "../../test/textCorrection";
import { CellEditor } from "./CellEditor";

function setup(value = "old") {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <CellEditor
      label="Edit email"
      value={value}
      style={{ left: 10, top: 20, width: 120 }}
      onCommit={onCommit}
      onCancel={onCancel}
    />,
  );
  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Edit email",
  });
  return { editor, onCommit, onCancel };
}

test("enter_commits", () => {
  const { editor, onCommit, onCancel } = setup();
  change(editor, "new");

  fireEvent.keyDown(editor, { key: "Enter" });

  expect(onCommit).toHaveBeenCalledExactlyOnceWith("new");
  expect(onCancel).not.toHaveBeenCalled();
});

test("enter_while_composing_does_not_commit", () => {
  const { editor, onCommit } = setup();

  fireEvent.keyDown(editor, { key: "Enter", isComposing: true });

  expect(onCommit).not.toHaveBeenCalled();
});

test("enter_with_key_code_229_does_not_commit", () => {
  const { editor, onCommit } = setup();

  // WKWebView는 조합을 끝내는 Enter에 isComposing을 false로, keyCode를 229로 보낸다.
  fireEvent.keyDown(editor, { key: "Enter", keyCode: 229 });

  expect(onCommit).not.toHaveBeenCalled();
});

test("opt_enter_inserts_a_newline", () => {
  const { editor, onCommit } = setup("ab");
  editor.setSelectionRange(1, 1);

  const notPrevented = fireEvent.keyDown(editor, {
    key: "Enter",
    altKey: true,
  });

  expect(notPrevented).toBe(false);
  expect(editor.value).toBe("a\nb");
  expect(editor.selectionStart).toBe(2);
  expect(onCommit).not.toHaveBeenCalled();

  fireEvent.keyDown(editor, { key: "Enter" });
  expect(onCommit).toHaveBeenCalledExactlyOnceWith("a\nb");
});

test("escape_cancels", () => {
  const { editor, onCommit, onCancel } = setup();
  change(editor, "new");

  fireEvent.keyDown(editor, { key: "Escape" });
  // 취소한 뒤 focus가 표로 가며 오는 blur는 확정이 아니다.
  fireEvent.blur(editor);

  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onCommit).not.toHaveBeenCalled();
});

test("blur_commits", () => {
  const { editor, onCommit } = setup();
  change(editor, "new");

  fireEvent.blur(editor);
  fireEvent.blur(editor);

  expect(onCommit).toHaveBeenCalledExactlyOnceWith("new");
});

test("starts_with_the_full_value", () => {
  const long = "x".repeat(400) + "\nend";
  const { editor } = setup(long);

  expect(editor.value).toBe(long);
  expect(editor).toHaveFocus();
  expect(editor.style.left).toBe("10px");
  expect(editor.style.top).toBe("20px");
  expect(editor.style.width).toBe("120px");
  // 값은 쓴 그대로 남아야 한다.
  expectNoTextCorrection(editor);
});
