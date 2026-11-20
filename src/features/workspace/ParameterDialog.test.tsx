import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { change } from "../../test/change";
import { click } from "../../test/click";
import { resetStores } from "../../test/resetStores";
import { ParameterDialog } from "./ParameterDialog";
import { askParameters } from "./parameterPrompt";

beforeEach(async () => {
  await resetStores();
});

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
