import { create } from "zustand";
import { readSqlFile } from "../../shared/api/commands";
import { messageOf } from "../../shared/api/errors";
import type { TxMode } from "../../shared/api/types";
import { closeDocument, openDocument } from "./documents";
import { t } from "../../shared/i18n/t";

export interface Tab {
  id: string;
  title: string;
  /** 저장한 적 없는 탭은 null */
  path: string | null;
  stamp: string | null;
  dirty: boolean;
  connection: string | null;
  /** 트랜잭션 모드. 새 탭은 auto다. 접속을 바꿔도 그대로다. */
  mode: TxMode;
}

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  /** 파일 이름을 묻는 중인 tab id */
  naming: string | null;
  error: string | null;
  /** `text`가 있으면 그 내용으로 시작한다. */
  newTab(options?: { text?: string }): string;
  openFile(path: string): Promise<void>;
  activate(id: string): void;
  /** 탭과 문서만 닫는다. 저장 확인과 세션 해제는 호출한 쪽이 한다. */
  close(id: string): void;
  next(): void;
  prev(): void;
  setConnection(id: string, connection: string | null): void;
  /** 다음 실행부터 그 모드로 보낸다. 확인은 부르는 쪽이 한다. */
  setMode(id: string, mode: TxMode): void;
  markDirty(id: string): void;
  /** 저장을 기록한다. 쓰는 동안 더 고쳤으면 `dirty`가 true다. */
  markSaved(id: string, path: string, stamp: string, dirty?: boolean): void;
  requestName(id: string | null): void;
  setError(message: string | null): void;
  reset(): void;
}

function lastComponent(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** 그 탭의 트랜잭션 모드. 탭이 없으면 auto다. */
export function modeOf(state: Pick<TabsState, "tabs">, id: string): TxMode {
  return state.tabs.find((tab) => tab.id === id)?.mode ?? "auto";
}

function updateTab(tabs: Tab[], id: string, patch: Partial<Tab>): Tab[] {
  return tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab));
}

export const useTabs = create<TabsState>()((set, get) => {
  // 새 탭 제목의 번호. reset에서 1로 돌아간다.
  let counter = 1;

  function add(tab: Tab, text: string): void {
    // 문서를 먼저 연다. 활성 탭이 되면 SqlEditor가 바로 그 문서를 읽는다.
    openDocument(tab.id, text);
    set((state) => ({ tabs: [...state.tabs, tab], activeId: tab.id }));
  }

  function activeConnection(): string | null {
    const { tabs, activeId } = get();
    return tabs.find((tab) => tab.id === activeId)?.connection ?? null;
  }

  /** `path`를 연 탭이 있으면 활성으로 한다. 있었으면 true. */
  function activatePath(path: string): boolean {
    const opened = get().tabs.find((tab) => tab.path === path);
    if (opened === undefined) return false;
    set({ activeId: opened.id, error: null });
    return true;
  }

  function step(delta: number): void {
    const { tabs, activeId } = get();
    if (tabs.length <= 1) return;
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const target = (index + delta + tabs.length) % tabs.length;
    set({ activeId: tabs[target].id });
  }

  return {
    tabs: [],
    activeId: null,
    naming: null,
    error: null,

    newTab(options) {
      const id = crypto.randomUUID();
      add(
        {
          id,
          title: t("tabs.defaultTitle", { n: counter }),
          path: null,
          stamp: null,
          dirty: false,
          connection: activeConnection(),
          mode: "auto",
        },
        options?.text ?? "",
      );
      counter += 1;
      return id;
    },

    async openFile(path) {
      if (activatePath(path)) return;
      let file;
      try {
        file = await readSqlFile(path);
      } catch (error) {
        set({ error: messageOf(error) });
        return;
      }
      // 읽는 동안 같은 파일이 다른 경로로 열렸을 수 있다.
      if (activatePath(path)) return;
      set({ error: null });
      add(
        {
          id: crypto.randomUUID(),
          title: lastComponent(path),
          path,
          stamp: file.stamp,
          dirty: false,
          connection: activeConnection(),
          mode: "auto",
        },
        file.text,
      );
    },

    activate(id) {
      if (get().tabs.some((tab) => tab.id === id)) set({ activeId: id });
    },

    close(id) {
      const { tabs, activeId } = get();
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return;
      const rest = tabs.filter((tab) => tab.id !== id);
      const nextActive =
        activeId !== id
          ? activeId
          : (rest[index]?.id ?? rest[index - 1]?.id ?? null);
      set((s) => ({
        tabs: rest,
        activeId: nextActive,
        naming: s.naming === id ? null : s.naming,
      }));
      closeDocument(id);
    },

    next: () => step(1),
    prev: () => step(-1),

    setConnection(id, connection) {
      set((state) => ({ tabs: updateTab(state.tabs, id, { connection }) }));
    },

    setMode(id, mode) {
      set((state) => ({ tabs: updateTab(state.tabs, id, { mode }) }));
    },

    markDirty(id) {
      const tab = get().tabs.find((t) => t.id === id);
      if (tab === undefined || tab.dirty) return;
      set((state) => ({ tabs: updateTab(state.tabs, id, { dirty: true }) }));
    },

    markSaved(id, path, stamp, dirty = false) {
      set((state) => ({
        tabs: updateTab(state.tabs, id, {
          path,
          stamp,
          dirty,
          title: lastComponent(path),
        }),
        naming: state.naming === id ? null : state.naming,
        error: null,
      }));
    },

    requestName(id) {
      set({ naming: id });
    },

    setError(message) {
      set({ error: message });
    },

    reset() {
      for (const tab of get().tabs) closeDocument(tab.id);
      counter = 1;
      set({ tabs: [], activeId: null, naming: null, error: null });
    },
  };
});
