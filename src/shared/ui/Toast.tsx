import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { createToastStore } from "./toastStore";

/**
 * 잠깐 보이는 알림. message가 null이면 비어 있다.
 * 가장 가까운 positioned 조상(`relative`)의 아래 가운데에 붙는다.
 */
export function Toast({ message }: { message: string | null }) {
  return (
    <div
      role="status"
      className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2"
    >
      {message !== null && (
        <div className="text-small border-line-2 bg-bg-3 text-fg shadow-popover rounded-lg border px-3 py-1.5 whitespace-nowrap">
          {message}
        </div>
      )}
    </div>
  );
}

/** `show`를 부르면 2초 동안 message가 있다. 다시 부르면 2초를 새로 잰다. */
export function useToast(): { message: string | null; show(m: string): void } {
  const [toast] = useState(createToastStore);
  useEffect(() => toast.reset, [toast]);
  const message = useStore(toast.store, (state) => state.message);
  return { message, show: toast.show };
}
