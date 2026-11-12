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
