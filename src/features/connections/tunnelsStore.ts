import { create } from "zustand";
import type { TunnelEvent, TunnelState } from "../../shared/api/types";

export interface TunnelView {
  state: Exclude<TunnelState, { status: "stopped" }>;
  /** 이 상태를 받은 시각(`Date.now()`). 같은 상태가 다시 오면 그대로다 */
  since: number;
  /** 다시 실행(attempt ≥ 1) 중이거나 그 끝에 온 상태면 true. 처음 시작이나 ready에서 false로 돌아간다 */
  afterRestart: boolean;
}

interface TunnelsState {
  /** 접속 이름 → 터널 상태. 없으면 터널이 없거나 꺼졌다. */
  tunnels: Record<string, TunnelView>;
  apply(event: TunnelEvent, now?: number): void;
  /** 프로젝트를 바꿀 때 */
  reset(): void;
}

function sameState(a: TunnelState, b: TunnelState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function afterRestart(
  state: TunnelView["state"],
  previous: TunnelView | undefined,
): boolean {
  switch (state.status) {
    case "starting":
      return state.attempt >= 1;
    case "failed":
      return previous?.afterRestart ?? false;
    case "ready":
    case "external":
      return false;
  }
}

export const useTunnels = create<TunnelsState>()((set) => ({
  tunnels: {},

  apply({ connection, state }, now = Date.now()) {
    set((s) => {
      const tunnels = { ...s.tunnels };
      if (state.status === "stopped") {
        delete tunnels[connection];
        return { tunnels };
      }
      const previous = s.tunnels[connection];
      tunnels[connection] = {
        state,
        since:
          previous !== undefined && sameState(previous.state, state)
            ? previous.since
            : now,
        afterRestart: afterRestart(state, previous),
      };
      return { tunnels };
    });
  },

  reset() {
    set({ tunnels: {} });
  },
}));
