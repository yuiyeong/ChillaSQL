import { listen } from "@tauri-apps/api/event";
import type { TunnelEvent } from "./types";

/** Rust가 보내는 터널 상태 event를 받는다. 돌려준 함수를 부르면 그만 받는다. */
export function onTunnelEvent(
  handler: (event: TunnelEvent) => void,
): Promise<() => void> {
  return listen<TunnelEvent>("tunnel", (event) => handler(event.payload));
}
