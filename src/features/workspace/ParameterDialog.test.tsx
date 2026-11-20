import { act, fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, expect, test } from "vitest";
import { change } from "../../test/change";
import { click } from "../../test/click";
import { attachView, detachView } from "../editor/documents";
import { useTabs } from "../editor/tabsStore";
import { resetStores } from "../../test/resetStores";
import { ParameterDialog } from "./ParameterDialog";
import { askParameters } from "./parameterPrompt";

let views: EditorView[] = [];

beforeEach(async () => {
  await resetStores();
});

afterEach(() => {
  for (const view of views) {
    detachView(view);
    view.destroy();
  }
  views = [];
});

/** 활성 탭을 만들고 그 문서를 보여 주는 에디터를 붙인다. */
function editorForActiveTab(): { tabId: string; view: EditorView } {
  const tabId = useTabs.getState().newTab();
  const view = new EditorView({ doc: "SELECT :id", parent: document.body });
  views.push(view);
  attachView(view, tabId);
  return { tabId, view };
}

/** 물음을 열고 그린다. 답은 돌려준 promise로 받는다. */
function open(names: string[], tabId = "t1") {
  render(<ParameterDialog />);
  let answer!: Promise<Record<string, string> | null>;
  act(() => {
    answer = askParameters(tabId, names);
  });
  return answer;
}

/** 입력란에 값을 쓴다. */
function type(name: string, value: string) {
  change(screen.getByLabelText(`:${name}`), value);
}

const runButton = () => screen.getByRole("button", { name: /^Run/ });

test("renders nothing without a request", () => {
  render(<ParameterDialog />);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("one_row_per_name_in_order", () => {
  void open(["id", "since"]);

  const dialog = screen.getByRole("dialog", { name: "Parameter values" });
  const inputs = screen.getAllByRole("textbox");
  expect(inputs).toHaveLength(2);
  expect(screen.getByLabelText(":id")).toBe(inputs[0]);
  expect(screen.getByLabelText(":since")).toBe(inputs[1]);
  // 안내 문구의 `::date`는 inline code다.
  expect(dialog.textContent).toContain("Quote strings.");
  expect(dialog.querySelector("code")?.textContent).toBe("::date");
  expect(runButton().textContent).toContain("⌘↵");
});

test("run_is_disabled_while_a_value_is_empty", () => {
  void open(["id", "since"]);
  expect(runButton()).toBeDisabled();

  type("id", "1");
  expect(runButton()).toBeDisabled();
  type("since", "   ");
  expect(runButton()).toBeDisabled();
  type("since", "2");
  expect(runButton()).toBeEnabled();
});

test("enter_and_cmd_enter_run", async () => {
  const first = open(["id"]);
  type("id", "7");
  fireEvent.keyDown(screen.getByLabelText(":id"), { code: "Enter" });
  await expect(first).resolves.toEqual({ id: "7" });
  expect(screen.queryByRole("dialog")).toBeNull();

  // 두 번째 물음은 앞의 값으로 시작한다. Cmd+Enter도 같다.
  let second!: Promise<Record<string, string> | null>;
  act(() => {
    second = askParameters("t1", ["id"]);
  });
  const input = screen.getByLabelText(":id");
  expect(input).toHaveValue("7");
  fireEvent.keyDown(input, { code: "Enter", metaKey: true });
  await expect(second).resolves.toEqual({ id: "7" });
});

test("enter_does_nothing_while_a_value_is_empty_or_composing", async () => {
  const pending = open(["id"]);
  const input = screen.getByLabelText(":id");
  fireEvent.keyDown(input, { code: "Enter" });
  expect(screen.getByRole("dialog")).toBeInTheDocument();

  // 한글 조합 중의 Enter는 조합을 끝낼 뿐이다.
  type("id", "ㄱ");
  fireEvent.keyDown(input, { code: "Enter", isComposing: true });
  expect(screen.getByRole("dialog")).toBeInTheDocument();

  fireEvent.keyDown(input, { code: "Enter" });
  await expect(pending).resolves.toEqual({ id: "ㄱ" });
});

test("escape_cancels", async () => {
  const answer = open(["id"]);

  fireEvent.keyDown(screen.getByLabelText(":id"), { code: "Escape" });

  await expect(answer).resolves.toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("cancel_button_cancels", async () => {
  const answer = open(["id"]);

  await click(screen.getByRole("button", { name: "Cancel" }));

  await expect(answer).resolves.toBeNull();
});

test("focuses_the_first_empty_input", async () => {
  const first = open(["id", "since"]);
  expect(screen.getByLabelText(":id")).toHaveFocus();

  type("id", "1");
  type("since", "2");
  await click(runButton());
  await first;

  // 앞의 값이 있는 이름은 건너뛰고 비어 있는 첫 입력란에 둔다.
  act(() => {
    void askParameters("t1", ["id", "other"]);
  });
  expect(screen.getByLabelText(":id")).toHaveValue("1");
  expect(screen.getByLabelText(":other")).toHaveFocus();
});

test("focus_returns_to_the_editor_after_run_and_after_cancel", async () => {
  const { tabId, view } = editorForActiveTab();
  const run = open(["id"], tabId);
  expect(screen.getByLabelText(":id")).toHaveFocus();
  type("id", "1");
  fireEvent.keyDown(screen.getByLabelText(":id"), { code: "Enter" });
  await run;
  expect(view.hasFocus).toBe(true);

  view.contentDOM.blur();
  let cancel!: Promise<unknown>;
  act(() => {
    cancel = askParameters(tabId, ["id"]);
  });
  await click(screen.getByRole("button", { name: "Cancel" }));
  await cancel;
  expect(view.hasFocus).toBe(true);
});

test("focus_does_not_move_when_the_asking_tab_is_not_active", async () => {
  const { tabId, view } = editorForActiveTab();
  const answer = open(["id"], tabId);
  act(() => {
    useTabs.getState().newTab();
  });

  fireEvent.keyDown(screen.getByLabelText(":id"), { code: "Escape" });
  await answer;

  expect(view.hasFocus).toBe(false);
});

test("escape_and_cmd_enter_work_when_focus_is_in_the_editor", async () => {
  const { tabId, view } = editorForActiveTab();
  const cancelled = open(["id"], tabId);
  view.focus();

  fireEvent.keyDown(view.contentDOM, { code: "Escape" });
  await expect(cancelled).resolves.toBeNull();

  let run!: Promise<Record<string, string> | null>;
  act(() => {
    run = askParameters(tabId, ["id"]);
  });
  view.focus();
  // 값이 비어 있으면 Cmd+Enter는 아무것도 하지 않는다.
  fireEvent.keyDown(view.contentDOM, { code: "Enter", metaKey: true });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  type("id", "5");
  fireEvent.keyDown(view.contentDOM, { code: "Enter", metaKey: true });
  await expect(run).resolves.toEqual({ id: "5" });
});

test("plain_enter_in_the_editor_does_not_submit", () => {
  const { tabId, view } = editorForActiveTab();
  void open(["id"], tabId);
  type("id", "5");
  view.focus();

  const enter = new KeyboardEvent("keydown", {
    code: "Enter",
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(enter);

  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(enter.defaultPrevented).toBe(false);
});

test("enter_with_keycode_229_does_not_submit", () => {
  void open(["id"]);
  type("id", "ㄱ");
  const input = screen.getByLabelText(":id");

  fireEvent.keyDown(input, { code: "Enter", keyCode: 229 });
  fireEvent.keyDown(input, { code: "Enter", metaKey: true, keyCode: 229 });
  fireEvent.keyDown(input, { code: "Escape", keyCode: 229 });

  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

test("enter_on_the_cancel_button_cancels_and_does_not_run", async () => {
  const answer = open(["id"]);
  type("id", "5");
  const cancel = screen.getByRole("button", { name: "Cancel" });
  cancel.focus();

  // Enter가 button에서는 submit이 아니다. 브라우저가 button을 누르는 것(click)만 한다.
  const enter = new KeyboardEvent("keydown", {
    code: "Enter",
    bubbles: true,
    cancelable: true,
  });
  cancel.dispatchEvent(enter);
  expect(enter.defaultPrevented).toBe(false);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await click(cancel);

  await expect(answer).resolves.toBeNull();
});
