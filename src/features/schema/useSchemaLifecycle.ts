import { useEffect } from "react";
import { useTabs } from "../editor/tabsStore";
import { useSchema } from "./schemaStore";

/**
 * catalog를 불러오는 때와 닫는 때. 활성 탭의 접속이 정해지면 그 catalog를 뒤에서 불러오고,
 * 어느 탭도 쓰지 않는 접속의 catalog는 닫는다(그래야 그 접속의 터널이 끝날 수 있다).
 */
export function useSchemaLifecycle(): void {
  const active = useTabs(
    (s) => s.tabs.find((tab) => tab.id === s.activeId)?.connection ?? null,
  );
  // 접속 이름을 정렬해 이어 붙인 값이라 탭이 바뀌어도 접속 집합이 같으면 effect가 돌지 않는다.
  const used = useTabs((s) =>
    [...new Set(s.tabs.flatMap((tab) => tab.connection ?? []))]
      .sort()
      .join("\n"),
  );

  useEffect(() => {
    if (active !== null) void useSchema.getState().ensure(active);
  }, [active]);

  useEffect(() => {
    const inUse = new Set(used === "" ? [] : used.split("\n"));
    for (const connection of Object.keys(useSchema.getState().entries)) {
      if (!inUse.has(connection)) void useSchema.getState().forget(connection);
    }
  }, [used]);
}
