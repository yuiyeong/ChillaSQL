import { beforeEach, expect, test } from "vitest";
import {
  answerParameters,
  askParameters,
  isParameterPromptOpen,
  resetParameterPrompt,
  useParameterPrompt,
} from "./parameterPrompt";

beforeEach(() => {
  resetParameterPrompt();
});

test("remembers_values_per_tab", async () => {
  const first = askParameters("t1", ["id", "since"]);
  expect(useParameterPrompt.getState().request).toEqual({
    tabId: "t1",
    names: ["id", "since"],
    values: { id: "", since: "" },
  });
  expect(isParameterPromptOpen()).toBe(true);
  answerParameters({ id: "10", since: "'2026-11-01'" });
  await expect(first).resolves.toEqual({ id: "10", since: "'2026-11-01'" });
  expect(isParameterPromptOpen()).toBe(false);

  // 같은 탭은 이름마다 앞의 값으로 시작하고, 새 이름은 비어 있다. 다른 탭은 모른다.
  void askParameters("t1", ["since", "other"]);
  expect(useParameterPrompt.getState().request?.values).toEqual({
    since: "'2026-11-01'",
    other: "",
  });
  answerParameters(null);
  void askParameters("t2", ["id"]);
  expect(useParameterPrompt.getState().request?.values).toEqual({ id: "" });
});

test("cancel_resolves_null_and_forgets_nothing", async () => {
  void askParameters("t1", ["id"]);
  answerParameters({ id: "1" });
  const second = askParameters("t1", ["id"]);
  answerParameters(null);
  await expect(second).resolves.toBeNull();
  expect(isParameterPromptOpen()).toBe(false);
  void askParameters("t1", ["id"]);
  expect(useParameterPrompt.getState().request?.values).toEqual({ id: "1" });
});

test("a_second_ask_cancels_the_first", async () => {
  const first = askParameters("t1", ["id"]);
  const second = askParameters("t2", ["name"]);

  await expect(first).resolves.toBeNull();
  expect(useParameterPrompt.getState().request?.tabId).toBe("t2");
  answerParameters({ name: "'x'" });
  await expect(second).resolves.toEqual({ name: "'x'" });
});

test("reset_forgets_values", async () => {
  const pending = askParameters("t1", ["id"]);
  answerParameters({ id: "1" });
  await pending;
  const open = askParameters("t1", ["id"]);

  resetParameterPrompt();

  await expect(open).resolves.toBeNull();
  expect(isParameterPromptOpen()).toBe(false);
  void askParameters("t1", ["id"]);
  expect(useParameterPrompt.getState().request?.values).toEqual({ id: "" });
});
