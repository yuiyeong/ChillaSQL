import { beforeEach, expect, test } from "vitest";
import type { TunnelState } from "../../shared/api/types";
import { useTunnels } from "./tunnelsStore";

function apply(state: TunnelState, now: number, connection = "staging") {
  useTunnels.getState().apply({ connection, state }, now);
}

function view(connection = "staging") {
  return useTunnels.getState().tunnels[connection];
}

const starting = (attempt: number): TunnelState => ({
  status: "starting",
  attempt,
  timeoutSecs: 20,
});

beforeEach(() => {
  useTunnels.getState().reset();
});

test("마지막 상태와 그 상태를 받은 시각을 둔다", () => {
  apply(starting(0), 1000);
  expect(view()).toEqual({
    state: starting(0),
    since: 1000,
    afterRestart: false,
  });

  // 같은 상태가 다시 와도 시각은 그대로다.
  apply(starting(0), 2000);
  expect(view()?.since).toBe(1000);

  apply({ status: "ready" }, 3000);
  expect(view()).toEqual({
    state: { status: "ready" },
    since: 3000,
    afterRestart: false,
  });

  apply({ status: "stopped" }, 4000);
  expect(view()).toBeUndefined();

  apply({ status: "external" }, 5000, "other");
  useTunnels.getState().reset();
  expect(useTunnels.getState().tunnels).toEqual({});
});

test("재실행 중이거나 그 끝의 실패는 afterRestart다", () => {
  const failed: TunnelState = {
    status: "failed",
    reason: "exited",
    code: 1,
    output: "e3",
  };
  apply({ status: "ready" }, 0);
  apply(starting(1), 1);
  expect(view()?.afterRestart).toBe(true);
  apply(starting(3), 2);
  apply(failed, 3);
  expect(view()?.afterRestart).toBe(true);

  apply(starting(0), 4);
  expect(view()?.afterRestart).toBe(false);
  apply(failed, 5);
  expect(view()?.afterRestart).toBe(false);
});
