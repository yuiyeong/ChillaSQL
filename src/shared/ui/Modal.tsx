import type { MouseEvent, ReactNode } from "react";

/** 452px modal 판. 확인 dialog와 파일 이름 dialog가 같이 쓴다. */
export const MODAL_PANEL =
  "border-line-2 bg-bg-2 shadow-dialog flex w-[452px] flex-col gap-3.5 rounded-xl border p-5";

/**
 * modal 뒤의 막. 판은 위에서 84px 아래 가운데에 둔다. 확인 dialog(DialogHost)는 `top`으로 다른
 * modal 위에 뜬다.
 */
export function Scrim({
  top = false,
  onMouseDown,
  children,
}: {
  top?: boolean;
  onMouseDown?(event: MouseEvent<HTMLDivElement>): void;
  children: ReactNode;
}) {
  return (
    <div
      className={`bg-scrim fixed inset-0 flex items-start justify-center pt-[84px] ${top ? "z-50" : "z-10"}`}
      onMouseDown={onMouseDown}
    >
      {children}
    </div>
  );
}
