import { useNow } from "../../shared/ui/useNow";
import { formatClock } from "./transaction";

/**
 * `openedAt`부터 지금까지의 경과 시간(`m:ss`). 1초마다 다시 그린다. 트랜잭션이 있을 때만 쓰는
 * component에서 불러야 시계가 트랜잭션이 있는 동안만 돈다.
 */
export function useElapsed(openedAt: number): string {
  return formatClock(useNow(1000) - openedAt);
}
