import type { ColumnSizingState } from "@tanstack/react-table";
import type { Selection } from "./grid";
import type { ResultData } from "./runReducer";
import type { SortState } from "./sortRows";

/** 결과 표를 떠날 때의 모습. 같은 실행을 다시 보여 주면 이것으로 이어 간다. */
export interface GridView {
  columnSizing: ColumnSizingState;
  selection: Selection;
  sort: SortState;
  scrollTop: number;
  /** 저장할 때의 `firstRow`. 그 사이 앞 행이 버려졌으면 스크롤을 그만큼 당긴다. */
  firstRow: number;
}

/**
 * tab id → (실행 key → 그 결과 표의 view). 여러 문장의 실행은 문장마다 key가 달라 결과 탭마다 view가
 * 따로다. 새 실행이 시작하면 지난 실행의 view를 버린다(`dropGridView`).
 * 화면이 그리지 않으므로 store가 아니라 module의 Map이다.
 */
const views = new Map<string, Map<string, GridView>>();

/**
 * 결과 하나를 가리키는 값. 다시 실행하면 `startedAt`이 바뀌고, 여러 문장의 실행은 문장마다 `runKey`가
 * 다르다(같은 SQL을 같은 때에 보낸 문장도 따로다).
 */
export function runKeyOf({
  runKey,
  startedAt,
  sql,
}: Pick<ResultData, "runKey" | "startedAt" | "sql">): string {
  return `${runKey}:${startedAt}:${sql}`;
}

export function savedGridView(
  tabId: string,
  runKey: string,
): GridView | undefined {
  return views.get(tabId)?.get(runKey);
}

export function saveGridView(
  tabId: string,
  runKey: string,
  view: GridView,
): void {
  const saved = views.get(tabId) ?? new Map<string, GridView>();
  saved.set(runKey, view);
  views.set(tabId, saved);
}

/** 탭을 닫거나 접속을 바꾸거나 새로 실행해 그 탭의 실행을 버릴 때 */
export function dropGridView(tabId: string): void {
  views.delete(tabId);
}

/** 프로젝트를 바꿀 때 */
export function clearGridViews(): void {
  views.clear();
}
