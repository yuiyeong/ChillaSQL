import { listen } from "@tauri-apps/api/event";
import type { TunnelEvent } from "./types";

/** Rust가 보내는 터널 상태 event를 받는다. 돌려준 함수를 부르면 그만 받는다. */
export function onTunnelEvent(
  handler: (event: TunnelEvent) => void,
): Promise<() => void> {
  return listen<TunnelEvent>("tunnel", (event) => handler(event.payload));
}

/** 앱을 끝내려는 요청(Cmd+Q, 창 닫기)을 받는다. 끝낼지는 화면이 묻고 `quitApp`으로 끝낸다. */
export function onQuitRequested(handler: () => void): Promise<() => void> {
  return listen("quit-requested", () => handler());
}
