import { useCallback, useEffect, useRef, useState } from "react";

const TOAST_MS = 2000;

/** 잠깐 보이는 알림. message가 null이면 비어 있다. */
export function Toast({ message }: { message: string | null }) {
  return (
    <div
      role="status"
      className="pointer-events-none fixed bottom-10 left-1/2 -translate-x-1/2"
    >
      {message !== null && (
        <div className="text-small border-line-2 bg-bg-3 text-fg rounded-lg border px-3 py-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.5)]">
          {message}
        </div>
      )}
    </div>
  );
}

/** `show`를 부르면 2초 동안 message가 있다. 다시 부르면 2초를 새로 잰다. */
export function useToast(): { message: string | null; show(m: string): void } {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const show = useCallback((next: string) => {
    clearTimeout(timer.current);
    setMessage(next);
    timer.current = setTimeout(() => setMessage(null), TOAST_MS);
  }, []);

  return { message, show };
}
