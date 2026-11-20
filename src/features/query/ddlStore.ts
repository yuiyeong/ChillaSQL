import { create } from "zustand";
import { loadDdl } from "../../shared/api/commands";
import { messageOf } from "../../shared/api/errors";
import type { Relation } from "../../shared/api/types";
import { selectActiveConnection, useTabs } from "../editor/tabsStore";

/** 탭의 결과 panel에 보이는 DDL. `name`은 화면에 보이는 `schema.name`(quote 없이)이다. */
export type DdlView =
  | { name: string; status: "loading" }
  | { name: string; status: "ready"; text: string }
  | { name: string; status: "failed"; message: string };

interface DdlState {
  /** 탭 id → 그 탭이 보이는 DDL */
  views: Record<string, DdlView>;
}

export const useDdl = create<DdlState>()(() => ({ views: {} }));

/** 탭마다 가장 나중에 보낸 요청. 늦게 온 앞 요청의 답은 이것과 달라서 버린다. */
const latest = new Map<string, symbol>();

function setView(tabId: string, view: DdlView | undefined): void {
  useDdl.setState((s) => {
    const views = { ...s.views };
    if (view === undefined) delete views[tabId];
    else views[tabId] = view;
    return { views };
  });
}

/** 활성 탭의 결과 panel에 relation의 DDL을 보인다. 탭이나 접속이 없으면 아무것도 하지 않는다. */
export async function showDdl(relation: Relation): Promise<void> {
  const tabs = useTabs.getState();
  const tabId = tabs.activeId;
  const connection = selectActiveConnection(tabs);
  if (tabId === null || connection === null) return;

  const name = `${relation.schema}.${relation.name}`;
  const request = Symbol(name);
  latest.set(tabId, request);
  setView(tabId, { name, status: "loading" });
  try {
    const text = await loadDdl(connection, relation.oid);
    if (latest.get(tabId) === request) {
      setView(tabId, { name, status: "ready", text });
    }
  } catch (error) {
    if (latest.get(tabId) === request) {
      setView(tabId, { name, status: "failed", message: messageOf(error) });
    }
  }
}

/** 그 탭의 DDL을 지운다. 아직 오지 않은 답도 버린다. */
export function closeDdl(tabId: string): void {
  latest.delete(tabId);
  setView(tabId, undefined);
}

/** 모든 탭의 DDL을 지운다(test와 프로젝트 전환용). */
export function resetDdl(): void {
  latest.clear();
  useDdl.setState({ views: {} });
}
