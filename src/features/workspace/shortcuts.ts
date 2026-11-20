import { useEffect, useRef } from "react";
import { isDialogOpen } from "../../shared/ui/dialogs";
import type { CommandId, ShortcutBinding } from "../../shared/api/types";
import { execute } from "./commands";
import { isParameterPromptOpen } from "./parameterPrompt";

type Keys = Pick<
  KeyboardEvent,
  "code" | "metaKey" | "shiftKey" | "altKey" | "ctrlKey"
>;

export type Binding = ShortcutBinding;

/** 기획서 4.10의 기본값. Rust `default_keymap`과 같다. runFile, explain은 없다. */
export const DEFAULT_KEYMAP: readonly Binding[] = [
  { command: "run", code: "Enter", shift: false, alt: false, ctrl: false },
  { command: "cancel", code: "F2", shift: false, alt: false, ctrl: false },
  { command: "save", code: "KeyS", shift: false, alt: false, ctrl: false },
  { command: "newTab", code: "KeyL", shift: true, alt: false, ctrl: false },
  { command: "closeTab", code: "KeyW", shift: false, alt: false, ctrl: false },
  {
    command: "nextTab",
    code: "BracketRight",
    shift: true,
    alt: false,
    ctrl: false,
  },
  {
    command: "prevTab",
    code: "BracketLeft",
    shift: true,
    alt: false,
    ctrl: false,
  },
  { command: "commit", code: "Enter", shift: true, alt: true, ctrl: false },
  { command: "rollback", code: "KeyZ", shift: true, alt: true, ctrl: false },
  { command: "reformat", code: "KeyL", shift: false, alt: true, ctrl: false },
  {
    command: "openProject",
    code: "KeyO",
    shift: false,
    alt: false,
    ctrl: false,
  },
];

/**
 * 모두 Cmd를 쓴다. `code`로 고르므로 한글 입력 상태에서도 같은 key다.
 * 설정을 읽으면 `setKeymap`이 바꾸고, 화면은 설정을 읽은 뒤에 그리므로 표시도 바꾼 키를 따른다.
 */
let keymap: readonly Binding[] = DEFAULT_KEYMAP;

/** 전역 설정의 keymap으로 바꾼다. settingsStore.load가 부른다. */
export function setKeymap(bindings: readonly Binding[]): void {
  keymap = bindings;
}

/** 글자 하나로 보이는 key. 나머지는 `KeyX`가 `X`, `DigitN`이 `N`, F키와 Enter는 그대로다. */
const PUNCTUATION: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Backslash: "\\",
};

function bindingOf(command: CommandId) {
  const binding = keymap.find((key) => key.command === command);
  if (binding === undefined) throw new Error(`no shortcut: ${command}`);
  return binding;
}

function keyOf(code: string): string {
  return PUNCTUATION[code] ?? code.replace(/^(Key|Digit)(?=.$)/, "");
}

/** Ctrl, Opt, Shift, Cmd 순서로 쓰는 modifier의 표기 */
type Modifiers = readonly [
  ctrl: string,
  alt: string,
  shift: string,
  cmd: string,
];

/** 단축키를 modifier 순서(Ctrl, Opt, Shift, Cmd)대로 쓰고 key를 붙인다. */
function format(
  command: CommandId,
  [ctrlText, altText, shiftText, cmdText]: Modifiers,
  key: (code: string) => string = keyOf,
): string {
  const { code, shift, alt, ctrl } = bindingOf(command);
  return `${ctrl ? ctrlText : ""}${alt ? altText : ""}${shift ? shiftText : ""}${cmdText}${key(code)}`;
}

/** 화면에 보이는 단축키 표시. 예: `⌘↵`, `⇧⌘L`, `⌃⌥⇧⌘↵` */
export function shortcutLabel(command: CommandId): string {
  return format(command, ["⌃", "⌥", "⇧", "⌘"], (code) =>
    code === "Enter" ? "↵" : keyOf(code),
  );
}

/** `aria-keyshortcuts`의 값. 예: `Meta+Enter`, `Shift+Meta+L`, `Control+Alt+Shift+Meta+Enter` */
export function shortcutKeys(command: CommandId): string {
  return format(command, ["Control+", "Alt+", "Shift+", "Meta+"]);
}

/** 글자로 쓴 단축키. 설정 파일의 값과 같은 꼴이다. 예: `Opt+Shift+Cmd+Enter` */
export function shortcutText(command: CommandId): string {
  return format(command, ["Ctrl+", "Opt+", "Shift+", "Cmd+"]);
}

export function commandFor(event: Keys): CommandId | null {
  if (!event.metaKey) return null;
  const binding = keymap.find(
    (key) =>
      key.code === event.code &&
      key.shift === event.shiftKey &&
      key.alt === event.altKey &&
      key.ctrl === event.ctrlKey,
  );
  return binding?.command ?? null;
}

/**
 * window의 capture 단계에서 단축키를 잡는다. 잡은 key는 에디터에 닿지 않는다
 * (CodeMirror의 `Mod-Enter`가 빈 줄을 넣지 않게, Cmd+W가 webview에 가지 않게).
 * `enabled`가 false이거나 확인 dialog(DialogHost)나 파라미터 물음이 떠 있는 동안은 event를 건드리지 않는다.
 */
export function useShortcuts(enabled: boolean): void {
  // listener를 다시 달지 않고 지금 값을 읽는다.
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!enabledRef.current || isDialogOpen() || isParameterPromptOpen()) {
        return;
      }
      const command = commandFor(event);
      if (command === null) return;
      event.preventDefault();
      event.stopPropagation();
      void execute(command);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
