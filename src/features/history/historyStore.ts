import { create } from "zustand";
import { recordQuery, searchHistory } from "../../shared/api/commands";
import { messageOf } from "../../shared/api/errors";
import type { HistoryEntry } from "../../shared/api/types";
import { useProject } from "../project/projectStore";

/** 입력이 멈추고 이만큼 지나면 찾는다. */
const SEARCH_WAIT_MS = 150;

export interface HistoryState {
  query: string;
  entries: HistoryEntry[];
  /** `entries`의 index. 목록이 비면 null */
  selected: number | null;
  status: "idle" | "loading" | "ready" | "failed";
  /** `failed`일 때 `messageOf`가 만든 문구 */
  error: string | null;
  /** History 화면이 그려져 있다. 기록을 더하면 목록을 다시 읽을지 정한다. */
  open: boolean;
  setOpen(open: boolean): void;
  /** 검색어를 바꾸고 150ms 동안 입력이 없으면 목록을 다시 읽는다. */
  setQuery(query: string): void;
  /** 열린 프로젝트의 기록을 `query`로 찾는다. 마지막 요청의 답만 반영한다. */
  load(): Promise<void>;
  move(delta: 1 | -1): void;
  select(index: number): void;
  /** 실행 하나를 기록한다. 실패는 무시한다. 화면이 열려 있으면 기록한 뒤 목록을 다시 읽는다. */
  record(entry: Omit<HistoryEntry, "id">): Promise<void>;
  /** 프로젝트를 바꿀 때. 검색어와 목록을 비우고 늦게 오는 답을 버린다. */
  reset(): void;
}

export const useHistory = create<HistoryState>()((set, get) => {
  // load를 부를 때마다 올린다. 다른 번호의 답은 버린다. reset도 올린다.
  let lastRequest = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function cancelTimer() {
    clearTimeout(timer);
    timer = undefined;
  }

  return {
    query: "",
    entries: [],
    selected: null,
    status: "idle",
    error: null,
    open: false,

    setOpen(open) {
      set({ open });
    },

    setQuery(query) {
      set({ query });
      cancelTimer();
      timer = setTimeout(() => {
        timer = undefined;
        void get().load();
      }, SEARCH_WAIT_MS);
    },

    async load() {
      const dir = useProject.getState().project?.dir;
      if (dir === undefined) return;
      cancelTimer();
      const request = ++lastRequest;
      set({ status: "loading" });
      try {
        const entries = await searchHistory(dir, get().query);
        if (request !== lastRequest) return;
        set({
          entries,
          selected: entries.length > 0 ? 0 : null,
          status: "ready",
          error: null,
        });
      } catch (error) {
        if (request !== lastRequest) return;
        set({
          entries: [],
          selected: null,
          status: "failed",
          error: messageOf(error),
        });
      }
    },

    move(delta) {
      const { entries, selected } = get();
      if (entries.length === 0) return;
      const next = Math.min(
        Math.max((selected ?? 0) + delta, 0),
        entries.length - 1,
      );
      set({ selected: next });
    },

    select(index) {
      if (index >= 0 && index < get().entries.length) set({ selected: index });
    },

    async record(entry) {
      const dir = useProject.getState().project?.dir;
      if (dir === undefined) return;
      try {
        await recordQuery(dir, entry);
      } catch {
        // 기록하지 못해도(저장소가 없음, 프로젝트가 바뀜) 실행에는 영향이 없다.
        return;
      }
      if (get().open) await get().load();
    },

    reset() {
      cancelTimer();
      lastRequest += 1;
      set({
        query: "",
        entries: [],
        selected: null,
        status: "idle",
        error: null,
      });
    },
  };
});
