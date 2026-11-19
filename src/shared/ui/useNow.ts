import { useEffect, useState } from "react";

/** 지금 시각(`Date.now()`). `intervalMs`마다 다시 그린다. `intervalMs`가 null이면 멈춘다. */
export function useNow(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
