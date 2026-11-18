import type { ReactNode } from "react";

/** 단축키 표시. 글자는 호출하는 쪽이 정한다. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="text-label bg-bg-3 text-fg-2 shrink-0 rounded-[4px] px-[5px] py-px font-sans font-medium">
      {children}
    </kbd>
  );
}
