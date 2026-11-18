import { useEffect, useRef } from "react";
import { execute, type CommandId } from "./commands";

type Keys = Pick<
  KeyboardEvent,
  "code" | "metaKey" | "shiftKey" | "altKey" | "ctrlKey"
>;

/** 모두 Cmd를 쓴다. `code`로 고르므로 한글 입력 상태에서도 같은 key다. */
const keymap: { code: string; shift: boolean; command: CommandId }[] = [
  { code: "Enter", shift: false, command: "run" },
  { code: "F2", shift: false, command: "cancel" },
  { code: "KeyS", shift: false, command: "save" },
  { code: "KeyL", shift: true, command: "newTab" },
  { code: "KeyW", shift: false, command: "closeTab" },
  { code: "BracketRight", shift: true, command: "nextTab" },
  { code: "BracketLeft", shift: true, command: "prevTab" },
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

/** 화면에 보이는 단축키 표시. 예: `⌘↵`, `⇧⌘L` */
export function shortcutLabel(command: CommandId): string {
  const { code, shift } = bindingOf(command);
  return `${shift ? "⇧" : ""}⌘${KEY_GLYPHS[code] ?? keyOf(code)}`;
}

/** `aria-keyshortcuts`의 값. 예: `Meta+Enter`, `Shift+Meta+L` */
export function shortcutKeys(command: CommandId): string {
  const { code, shift } = bindingOf(command);
  const key = code.startsWith("Bracket") ? KEY_GLYPHS[code] : keyOf(code);
  return `${shift ? "Shift+" : ""}Meta+${key}`;
}

export function commandFor(event: Keys): CommandId | null {
  if (!event.metaKey || event.altKey || event.ctrlKey) return null;
  const binding = keymap.find(
    (key) => key.code === event.code && key.shift === event.shiftKey,
  );
  return binding?.command ?? null;
}

/**
 * window의 capture 단계에서 단축키를 잡는다. 잡은 key는 에디터에 닿지 않는다
 * (CodeMirror의 `Mod-Enter`가 빈 줄을 넣지 않게, Cmd+W가 webview에 가지 않게).
 * `enabled`가 false인 동안은 event를 건드리지 않는다.
 */
export function useShortcuts(enabled: boolean): void {
  // listener를 다시 달지 않고 지금 값을 읽는다.
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!enabledRef.current) return;
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
