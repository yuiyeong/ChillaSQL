import { render } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/dialog");

import { useTabs } from "../editor/tabsStore";
import { useRuns } from "../query/runsStore";
import { resetStores } from "../../test/resetStores";
import { answerParameters, askParameters } from "./parameterPrompt";
import {
  type Binding,
  commandFor,
  DEFAULT_KEYMAP,
  setKeymap,
  shortcutKeys,
  shortcutLabel,
  shortcutText,
  useShortcuts,
} from "./shortcuts";

function key(
  code: string,
  modifiers: KeyboardEventInit = {},
  init: KeyboardEventInit = {},
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    code,
    bubbles: true,
    cancelable: true,
    ...modifiers,
    ...init,
  });
}

test("단축키 표시와 aria-keyshortcuts는 keymap에서 만든다", () => {
  expect(shortcutLabel("run")).toBe("⌘↵");
  expect(shortcutLabel("cancel")).toBe("⌘F2");
  expect(shortcutLabel("newTab")).toBe("⇧⌘L");
  expect(shortcutLabel("nextTab")).toBe("⇧⌘]");
  expect(shortcutKeys("run")).toBe("Meta+Enter");
  expect(shortcutKeys("cancel")).toBe("Meta+F2");
  expect(shortcutKeys("newTab")).toBe("Shift+Meta+L");
  expect(shortcutKeys("prevTab")).toBe("Shift+Meta+[");
  expect(shortcutLabel("commit")).toBe("⌥⇧⌘↵");
  expect(shortcutLabel("rollback")).toBe("⌥⇧⌘Z");
  expect(shortcutKeys("commit")).toBe("Alt+Shift+Meta+Enter");
  expect(shortcutKeys("rollback")).toBe("Alt+Shift+Meta+Z");
});

const cmd = { metaKey: true };
const shiftCmd = { metaKey: true, shiftKey: true };
const optShiftCmd = { metaKey: true, shiftKey: true, altKey: true };

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
});

test("표의 key마다 command를 고른다", () => {
  expect(commandFor(key("Enter", cmd))).toBe("run");
  expect(commandFor(key("F2", cmd))).toBe("cancel");
  expect(commandFor(key("KeyS", cmd))).toBe("save");
  expect(commandFor(key("KeyL", shiftCmd))).toBe("newTab");
  expect(commandFor(key("KeyW", cmd))).toBe("closeTab");
  expect(commandFor(key("BracketRight", shiftCmd))).toBe("nextTab");
  expect(commandFor(key("BracketLeft", shiftCmd))).toBe("prevTab");
  expect(commandFor(key("Enter", optShiftCmd))).toBe("commit");
  expect(commandFor(key("KeyZ", optShiftCmd))).toBe("rollback");
});

test("cmd_o_is_open_project", () => {
  expect(commandFor(key("KeyO", cmd))).toBe("openProject");
  expect(commandFor(key("KeyO", cmd, { key: "ㅐ" }))).toBe("openProject");
  expect(commandFor(key("KeyO", shiftCmd))).toBeNull();
  expect(commandFor(key("KeyO", { metaKey: true, altKey: true }))).toBeNull();
  expect(commandFor(key("KeyO"))).toBeNull();
  expect(shortcutLabel("openProject")).toBe("⌘O");
  expect(shortcutKeys("openProject")).toBe("Meta+O");
});

test("한글 입력 상태에서도 code로 command를 고른다", () => {
  expect(commandFor(key("KeyS", cmd, { key: "ㄴ" }))).toBe("save");
  expect(commandFor(key("KeyW", cmd, { key: "ㅈ" }))).toBe("closeTab");
});

test("modifier가 다르면 고르지 않는다", () => {
  expect(commandFor(key("KeyS"))).toBeNull();
  expect(commandFor(key("KeyS", shiftCmd))).toBeNull();
  expect(commandFor(key("Enter", { metaKey: true, ctrlKey: true }))).toBeNull();
  expect(commandFor(key("KeyW", { metaKey: true, altKey: true }))).toBeNull();
  expect(commandFor(key("KeyL", cmd))).toBeNull();
  expect(commandFor(key("BracketRight", cmd))).toBeNull();
  // Commit과 Rollback은 Opt, Shift, Cmd가 모두 있어야 한다.
  expect(commandFor(key("KeyZ", shiftCmd))).toBeNull();
  expect(commandFor(key("Enter", { metaKey: true, altKey: true }))).toBeNull();
  expect(commandFor(key("KeyZ", { metaKey: true, altKey: true }))).toBeNull();
  expect(
    commandFor(key("Enter", { ...optShiftCmd, ctrlKey: true })),
  ).toBeNull();
  // 기존 key에 Opt가 더해지면 고르지 않는다.
  expect(commandFor(key("KeyL", optShiftCmd))).toBeNull();
  expect(commandFor(key("BracketRight", optShiftCmd))).toBeNull();
  expect(commandFor(key("KeyS", { metaKey: true, altKey: true }))).toBeNull();
});

function Shortcuts() {
  useShortcuts(true);
  return createElement("div", { "data-testid": "inner", tabIndex: 0 });
}

test("잡은 key는 기본 동작과 전파를 막고 command를 실행한다", async () => {
  const { getByTestId } = render(createElement(Shortcuts));
  const inner = getByTestId("inner");
  const bubble = vi.fn();
  inner.addEventListener("keydown", bubble);
  // 접속이 없는 탭에서 run은 rejected를 남긴다. execute("run")이 불렸다는 표시다.
  const tabId = useTabs.getState().newTab();

  const run = key("Enter", cmd);
  inner.dispatchEvent(run);

  expect(run.defaultPrevented).toBe(true);
  expect(bubble).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(useRuns.getState().runs[tabId]).toEqual({
      status: "rejected",
      rejection: { title: "Choose a connection to run queries.", detail: null },
    }),
  );

  const typing = key("KeyA", {}, { key: "a" });
  inner.dispatchEvent(typing);

  expect(typing.defaultPrevented).toBe(false);
  expect(bubble).toHaveBeenCalledTimes(1);
});

test("unmount하면 key를 잡지 않는다", () => {
  const { unmount } = render(createElement(Shortcuts));
  unmount();

  const run = key("Enter", cmd);
  window.dispatchEvent(run);

  expect(run.defaultPrevented).toBe(false);
});

test("opt_cmd_l_is_reformat", () => {
  expect(
    commandFor(key("KeyL", { metaKey: true, altKey: true }, { key: "ㅣ" })),
  ).toBe("reformat");
  // Shift가 붙은 Cmd+L은 새 탭이다.
  expect(commandFor(key("KeyL", shiftCmd))).toBe("newTab");
  expect(commandFor(key("KeyL", { altKey: true }))).toBeNull();
  expect(shortcutLabel("reformat")).toBe("⌥⌘L");
  expect(shortcutKeys("reformat")).toBe("Alt+Meta+L");
});

test("shortcuts_are_ignored_while_the_prompt_is_open", async () => {
  render(createElement(Shortcuts));
  const tabId = useTabs.getState().newTab();
  const pending = askParameters(tabId, ["id"]);

  const run = key("Enter", cmd);
  window.dispatchEvent(run);

  expect(run.defaultPrevented).toBe(false);
  expect(useRuns.getState().runs[tabId]).toBeUndefined();

  // 닫히면 다시 잡는다.
  answerParameters(null);
  await pending;
  const again = key("Enter", cmd);
  window.dispatchEvent(again);
  expect(again.defaultPrevented).toBe(true);
  await vi.waitFor(() =>
    expect(useRuns.getState().runs[tabId]?.status).toBe("rejected"),
  );
});

const NO_MODIFIERS = { shift: false, alt: false, ctrl: false };

/** 기본값에서 `command`의 key만 바꾼 keymap. */
function rebind(
  command: Binding["command"],
  binding: Omit<Binding, "command">,
) {
  return [
    ...DEFAULT_KEYMAP.filter((b) => b.command !== command),
    { command, ...binding },
  ];
}

test("default_keymap_matches_the_spec", () => {
  expect(DEFAULT_KEYMAP).toEqual([
    { command: "run", code: "Enter", ...NO_MODIFIERS },
    { command: "cancel", code: "F2", ...NO_MODIFIERS },
    { command: "save", code: "KeyS", ...NO_MODIFIERS },
    { command: "newTab", code: "KeyL", ...NO_MODIFIERS, shift: true },
    { command: "closeTab", code: "KeyW", ...NO_MODIFIERS },
    { command: "nextTab", code: "BracketRight", ...NO_MODIFIERS, shift: true },
    { command: "prevTab", code: "BracketLeft", ...NO_MODIFIERS, shift: true },
    { command: "commit", code: "Enter", ctrl: false, shift: true, alt: true },
    { command: "rollback", code: "KeyZ", ctrl: false, shift: true, alt: true },
    { command: "reformat", code: "KeyL", ...NO_MODIFIERS, alt: true },
    { command: "openProject", code: "KeyO", ...NO_MODIFIERS },
  ]);
  expect(shortcutText("commit")).toBe("Opt+Shift+Cmd+Enter");
  expect(shortcutText("reformat")).toBe("Opt+Cmd+L");
  expect(shortcutText("newTab")).toBe("Shift+Cmd+L");
});

test("set_keymap_changes_dispatch_and_labels", () => {
  setKeymap(rebind("reformat", { code: "KeyF", ...NO_MODIFIERS, shift: true }));

  expect(commandFor(key("KeyF", shiftCmd))).toBe("reformat");
  expect(commandFor(key("KeyL", { metaKey: true, altKey: true }))).toBeNull();
  expect(shortcutLabel("reformat")).toBe("⇧⌘F");
  expect(shortcutKeys("reformat")).toBe("Shift+Meta+F");
  expect(shortcutText("reformat")).toBe("Shift+Cmd+F");
  // 나머지는 그대로다.
  expect(commandFor(key("Enter", cmd))).toBe("run");

  setKeymap(DEFAULT_KEYMAP);
  expect(commandFor(key("KeyF", shiftCmd))).toBeNull();
  expect(shortcutLabel("reformat")).toBe("⌥⌘L");
});

test("ctrl_bindings_need_ctrl", () => {
  const ctrlCmd = { metaKey: true, ctrlKey: true };
  setKeymap(rebind("run", { code: "Enter", ...NO_MODIFIERS, ctrl: true }));

  expect(commandFor(key("Enter", ctrlCmd))).toBe("run");
  expect(commandFor(key("Enter", cmd))).toBeNull();
  expect(shortcutLabel("run")).toBe("⌃⌘↵");
  expect(shortcutKeys("run")).toBe("Control+Meta+Enter");
  expect(shortcutText("run")).toBe("Ctrl+Cmd+Enter");

  setKeymap(
    rebind("commit", { code: "Enter", ctrl: true, shift: true, alt: true }),
  );
  expect(commandFor(key("Enter", { ...optShiftCmd, ctrlKey: true }))).toBe(
    "commit",
  );
  expect(commandFor(key("Enter", optShiftCmd))).toBeNull();
  expect(shortcutLabel("commit")).toBe("⌃⌥⇧⌘↵");
  expect(shortcutKeys("commit")).toBe("Control+Alt+Shift+Meta+Enter");
});

test("digit_and_function_key_labels", () => {
  const cases: [string, string, string, string][] = [
    ["Digit1", "⌘1", "Meta+1", "Cmd+1"],
    ["F12", "⌘F12", "Meta+F12", "Cmd+F12"],
    ["Comma", "⌘,", "Meta+,", "Cmd+,"],
    ["Period", "⌘.", "Meta+.", "Cmd+."],
    ["Slash", "⌘/", "Meta+/", "Cmd+/"],
    ["Semicolon", "⌘;", "Meta+;", "Cmd+;"],
    ["Quote", "⌘'", "Meta+'", "Cmd+'"],
    ["Minus", "⌘-", "Meta+-", "Cmd+-"],
    ["Equal", "⌘=", "Meta+=", "Cmd+="],
    ["Backquote", "⌘`", "Meta+`", "Cmd+`"],
    ["Backslash", "⌘\\", "Meta+\\", "Cmd+\\"],
    ["BracketLeft", "⌘[", "Meta+[", "Cmd+["],
  ];
  for (const [code, label, keys, text] of cases) {
    setKeymap(rebind("explain", { code, ...NO_MODIFIERS }));
    expect(shortcutLabel("explain"), code).toBe(label);
    expect(shortcutKeys("explain"), code).toBe(keys);
    expect(shortcutText("explain"), code).toBe(text);
    expect(commandFor(key(code, cmd)), code).toBe("explain");
  }
});
