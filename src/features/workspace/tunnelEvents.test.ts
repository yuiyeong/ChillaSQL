import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/events");
vi.mock("../../shared/api/commands");

import { onTunnelEvent } from "../../shared/api/events";
import type { TunnelEvent } from "../../shared/api/types";
import { useTunnels } from "../connections/tunnelsStore";
import { useRuns } from "../query/runsStore";
import { subscribeTunnelEvents } from "./tunnelEvents";

let handler: (event: TunnelEvent) => void = () => {};
const unlisten = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  useTunnels.getState().reset();
  vi.mocked(onTunnelEvent).mockImplementation(async (h) => {
    handler = h;
    return unlisten;
  });
});

test("event를 store에 넣고 재실행이 시작되면 그 접속의 세션을 stale로 둔다", async () => {
  const markStale = vi.spyOn(useRuns.getState(), "markStale");
  const stop = await subscribeTunnelEvents();

  handler({
    connection: "staging",
    state: { status: "starting", attempt: 0, timeoutSecs: 20 },
  });
  expect(useTunnels.getState().tunnels.staging?.state.status).toBe("starting");
  expect(markStale).not.toHaveBeenCalled();

  handler({
    connection: "staging",
    state: { status: "starting", attempt: 1, timeoutSecs: 20 },
  });
  expect(markStale).toHaveBeenCalledWith("staging");

  stop();
  expect(unlisten).toHaveBeenCalled();
  markStale.mockRestore();
});
