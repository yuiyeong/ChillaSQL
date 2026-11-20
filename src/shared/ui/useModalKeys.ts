import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = "button:not(:disabled)";

/**
 * modal이 떠 있는 동안 window의 capture 단계에서 Escape와 Tab을 잡는다. Escape는 `onEscape`를 부르고,
 * Tab은 `panel` 안에 머문다(끝에서 넘어가면 반대쪽 끝으로 돌리고, focus가 밖에 있으면 안으로 데려온다).
 * focus가 막이나 body에 있어도 동작한다. 닫히면 열 때 focus가 있던 곳으로 돌려 준다.
 * `skip`이 true를 주면 그 key는 건드리지 않는다(위에 확인 dialog가 떠 있을 때).
 */
export function useModalKeys(
  panel: RefObject<HTMLElement | null>,
  onEscape: () => void,
  skip?: () => boolean,
): void {
  // listener를 다시 달지 않고 지금 값을 읽는다.
  const latest = useRef({ onEscape, skip });
  useEffect(() => {
    latest.current = { onEscape, skip };
  });

  useEffect(() => {
    const before = document.activeElement;
    function onKeyDown(event: KeyboardEvent) {
      if (latest.current.skip?.()) return;
      // 한글 입력 중에는 key가 "Process"라서 code로 판별한다.
      if (event.code === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        latest.current.onEscape();
      } else if (event.code === "Tab") {
        keepFocusInside(event, panel.current);
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, [panel]);
}

/** Tab이 panel 밖으로 나가지 않게 한다. 끝에서 넘어가면 반대쪽 끝으로 돌린다. */
function keepFocusInside(event: KeyboardEvent, panel: HTMLElement | null) {
  const buttons = Array.from(
    panel?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
  );
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  if (first === undefined || last === undefined) return;
  const focused = document.activeElement;
  const outside = !(focused instanceof Node && panel?.contains(focused));
  if (outside || (event.shiftKey ? focused === first : focused === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
