import { useEffect, useRef } from "react";
import { isDialogOpen } from "../../shared/ui/dialogs";
import { execute, type CommandId } from "./commands";

type Keys = Pick<
  KeyboardEvent,
  "code" | "metaKey" | "shiftKey" | "altKey" | "ctrlKey"
>;

/** 모두 Cmd를 쓴다. `code`로 고르므로 한글 입력 상태에서도 같은 key다. */
const keymap: {
  code: string;
  shift: boolean;
  alt: boolean;
  command: CommandId;
}[] = [
  { code: "Enter", shift: false, alt: false, command: "run" },
  { code: "F2", shift: false, alt: false, command: "cancel" },
  { code: "KeyS", shift: false, alt: false, command: "save" },
  { code: "KeyL", shift: true, alt: false, command: "newTab" },
  { code: "KeyW", shift: false, alt: false, command: "closeTab" },
  { code: "BracketRight", shift: true, alt: false, command: "nextTab" },
  { code: "BracketLeft", shift: true, alt: false, command: "prevTab" },
  { code: "Enter", shift: true, alt: true, command: "commit" },
  { code: "KeyZ", shift: true, alt: true, command: "rollback" },
  { code: "KeyL", shift: false, alt: true, command: "reformat" },
  { code: "KeyO", shift: false, alt: false, command: "openProject" },
];

/** 화면에 쓰지 않는 key의 이름. 나머지 `KeyX`는 `X`다. */
const KEY_GLYPHS: Record<string, string> = {
  Enter: "↵",
  BracketRight: "]",
  BracketLeft: "[",
};

function bindingOf(command: CommandId) {
  const binding = keymap.find((key) => key.command === command);
  if (binding === undefined) throw new Error(`no shortcut: ${command}`);
  return binding;
}

function keyOf(code: string): string {
  return code.startsWith("Key") ? code.slice(3) : code;
}

/** 화면에 보이는 단축키 표시. 예: `⌘↵`, `⇧⌘L`, `⌥⇧⌘↵` */
export function shortcutLabel(command: CommandId): string {
  const { code, shift, alt } = bindingOf(command);
  return `${alt ? "⌥" : ""}${shift ? "⇧" : ""}⌘${KEY_GLYPHS[code] ?? keyOf(code)}`;
}

/** `aria-keyshortcuts`의 값. 예: `Meta+Enter`, `Shift+Meta+L`, `Alt+Shift+Meta+Enter` */
export function shortcutKeys(command: CommandId): string {
  const { code, shift, alt } = bindingOf(command);
  const key = code.startsWith("Bracket") ? KEY_GLYPHS[code] : keyOf(code);
  return `${alt ? "Alt+" : ""}${shift ? "Shift+" : ""}Meta+${key}`;
}

export function commandFor(event: Keys): CommandId | null {
  if (!event.metaKey || event.ctrlKey) return null;
  const binding = keymap.find(
    (key) =>
      key.code === event.code &&
      key.shift === event.shiftKey &&
      key.alt === event.altKey,
  );
  return binding?.command ?? null;
}

/**
 * window의 capture 단계에서 단축키를 잡는다. 잡은 key는 에디터에 닿지 않는다
 * (CodeMirror의 `Mod-Enter`가 빈 줄을 넣지 않게, Cmd+W가 webview에 가지 않게).
 * `enabled`가 false이거나 확인 dialog(DialogHost)가 떠 있는 동안은 event를 건드리지 않는다.
 */
export function useShortcuts(enabled: boolean): void {
  // listener를 다시 달지 않고 지금 값을 읽는다.
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!enabledRef.current || isDialogOpen()) return;
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
