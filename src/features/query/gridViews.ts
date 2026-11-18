import type { ColumnSizingState } from "@tanstack/react-table";
import type { Selection } from "./grid";
import type { ResultData } from "./runReducer";

/** 결과 표를 떠날 때의 모습. 같은 실행을 다시 보여 주면 이것으로 이어 간다. */
export interface GridView {
  columnSizing: ColumnSizingState;
  selection: Selection;
  scrollTop: number;
  /** 저장할 때의 `firstRow`. 그 사이 앞 행이 버려졌으면 스크롤을 그만큼 당긴다. */
  firstRow: number;
}

/**
 * tab id → 그 탭의 결과 표 view. 탭마다 하나이고 `runKey`가 같은 실행에만 쓴다.
 * 화면이 그리지 않으므로 store가 아니라 module의 Map이다.
 */
const views = new Map<string, { runKey: string; view: GridView }>();

/** 실행 하나를 가리키는 값. 다시 실행하면 `startedAt`이 바뀐다. */
export function runKeyOf({
  startedAt,
  sql,
}: Pick<ResultData, "startedAt" | "sql">): string {
  return `${startedAt}:${sql}`;
}

export function savedGridView(
  tabId: string,
  runKey: string,
): GridView | undefined {
  const saved = views.get(tabId);
  return saved?.runKey === runKey ? saved.view : undefined;
}

export function saveGridView(
  tabId: string,
  runKey: string,
  view: GridView,
): void {
  views.set(tabId, { runKey, view });
}

/** 탭을 닫거나 접속을 바꿔 그 탭의 실행을 버릴 때 */
export function dropGridView(tabId: string): void {
  views.delete(tabId);
}

/** 프로젝트를 바꿀 때 */
export function clearGridViews(): void {
  views.clear();
}
