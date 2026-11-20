import { render } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/dialog");

import { useTabs } from "../editor/tabsStore";
import { useRuns } from "../query/runsStore";
import { resetStores } from "../../test/resetStores";
import {
  commandFor,
  shortcutKeys,
  shortcutLabel,
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
