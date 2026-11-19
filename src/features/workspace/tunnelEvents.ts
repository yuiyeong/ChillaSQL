import { onTunnelEvent } from "../../shared/api/events";
import { useTunnels } from "../connections/tunnelsStore";
import { useRuns } from "../query/runsStore";

/**
 * 터널 상태 event를 store에 넣는다. 터널이 다시 실행되기 시작하면 그 접속을 쓰는 탭의 세션은
 * 끊겼으므로 stale로 둔다(다음 실행이 새 세션으로 바꾼다). 돌려준 함수를 부르면 그만 받는다.
 */
export function subscribeTunnelEvents(): Promise<() => void> {
  return onTunnelEvent((event) => {
    useTunnels.getState().apply(event);
    if (event.state.status === "starting" && event.state.attempt >= 1) {
      useRuns.getState().markStale(event.connection);
    }
  });
}
