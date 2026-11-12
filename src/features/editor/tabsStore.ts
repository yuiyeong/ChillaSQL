import { create } from "zustand";
import { readSqlFile } from "../../shared/api/commands";
import { closeDocument, openDocument } from "./documents";

export interface Tab {
  id: string;
  title: string;
  /** 저장한 적 없는 탭은 null */
  path: string | null;
  stamp: string | null;
  dirty: boolean;
  connection: string | null;
}

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  /** 파일 이름을 묻는 중인 tab id */
  naming: string | null;
  error: string | null;
  newTab(): string;
  openFile(path: string): Promise<void>;
  activate(id: string): void;
  /** 탭과 문서만 닫는다. 저장 확인과 세션 해제는 호출한 쪽이 한다. */
  close(id: string): void;
  next(): void;
  prev(): void;
  setConnection(id: string, connection: string | null): void;
  markDirty(id: string): void;
  markSaved(id: string, path: string, stamp: string): void;
  requestName(id: string | null): void;
  setError(message: string | null): void;
  reset(): void;
}

function lastComponent(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

    newTab() {
      const { tabs, activeId } = get();
      const id = crypto.randomUUID();
      const connection = tabs.find((tab) => tab.id === activeId)?.connection;
      add(
        {
          id,
          title: `쿼리 ${counter}`,
          path: null,
          stamp: null,
          dirty: false,
          connection: connection ?? null,
        },
        "",
      );
      counter += 1;
      return id;
    },

    async openFile(path) {
      const existing = get().tabs.find((tab) => tab.path === path);
      if (existing !== undefined) {
        set({ activeId: existing.id });
        return;
      }
      let file;
      try {
        file = await readSqlFile(path);
      } catch (error) {
        set({ error: messageOf(error) });
        return;
      }
      // 읽는 동안 같은 파일이 다른 경로로 열렸을 수 있다.
      const opened = get().tabs.find((tab) => tab.path === path);
      if (opened !== undefined) {
        set({ activeId: opened.id });
        return;
      }
      const { tabs, activeId } = get();
      add(
        {
          id: crypto.randomUUID(),
          title: lastComponent(path),
          path,
          stamp: file.stamp,
          dirty: false,
          connection:
            tabs.find((tab) => tab.id === activeId)?.connection ?? null,
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
      set({ tabs: rest, activeId: nextActive });
      closeDocument(id);
    },

    next: () => step(1),
    prev: () => step(-1),

    setConnection(id, connection) {
      set((state) => ({ tabs: updateTab(state.tabs, id, { connection }) }));
    },

    markDirty(id) {
      const tab = get().tabs.find((t) => t.id === id);
      if (tab === undefined || tab.dirty) return;
      set((state) => ({ tabs: updateTab(state.tabs, id, { dirty: true }) }));
    },

    markSaved(id, path, stamp) {
      set((state) => ({
        tabs: updateTab(state.tabs, id, {
          path,
          stamp,
          dirty: false,
          title: lastComponent(path),
        }),
        naming: null,
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
