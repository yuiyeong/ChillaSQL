import { create } from "zustand";
import {
  createProject,
  listSqlFiles,
  openProject,
  recentProjects,
} from "../../shared/api/commands";
import { isCommandError, messageOf } from "../../shared/api/errors";
import type {
  Connection,
  Project,
  RecentProject,
} from "../../shared/api/types";

export type ProjectStatus = "booting" | "none" | "missing" | "ready";

export interface ProjectState {
  status: ProjectStatus;
  project: Project | null;
  files: string[];
  error: string | null;
  /** status가 "missing"일 때 chilla.toml이 없던 디렉토리 */
  missingDir: string | null;
  /**
   * 대상을 바꿔 저장했지만 Commit이 실패해 탭의 세션이 아직 쓰는 앞 접속. 접속 이름별이다.
   * 프로젝트를 열면 비운다.
   */
  unapplied: Record<string, Connection>;
  /** 최근에 연 프로젝트. 최근 것부터 최대 10개다. 앱 저장소가 없으면 비어 있다. */
  recent: RecentProject[];
  /** Rust에서 최근 프로젝트를 다시 읽는다. 읽지 못하면(앱 저장소가 없으면) 비운다. */
  refreshRecent(): Promise<void>;
  /** 가장 최근 프로젝트를 연다. 열렸으면 true. 없거나 열지 못하면 "none"(Welcome)이고 true가 아니다. */
  boot(): Promise<boolean>;
  /**
   * 열렸으면 true. chilla.toml이 없고 열린 프로젝트도 없으면 `askToCreate`일 때 "missing"(만들지 묻는
   * sheet)이다. 목록에서 연 디렉토리는 `askToCreate`를 false로 두어 오류만 보인다.
   */
  open(dir: string, askToCreate?: boolean): Promise<boolean>;
  /** "missing"의 sheet를 닫고 Welcome으로 돌아간다. */
  dismissMissing(): void;
  create(dir: string): Promise<boolean>;
  /** 접속을 저장한 뒤. `unapplied`를 함께 바꾼다(없으면 비운다). */
  applyProject(project: Project, unapplied?: Record<string, Connection>): void;
  refreshFiles(): Promise<void>;
  /** 프로젝트를 열기 전에 실패한 일(디렉토리 고르기)을 알린다. */
  showError(message: string): void;
  clearError(): void;
}

export const useProject = create<ProjectState>()((set, get) => {
  // 프로젝트가 바뀔 때마다 올린다. 늦게 끝난 refreshFiles가 새 프로젝트를 덮어쓰지 않게 한다.
  let generation = 0;

  /** `missingDir`가 있으면 project_not_found를 "missing"으로 다룬다(열린 프로젝트가 없을 때만). */
  async function enter(
    load: () => Promise<Project>,
    missingDir?: string,
  ): Promise<boolean> {
    let project: Project;
    try {
      project = await load();
    } catch (error) {
      const message = messageOf(error);
      if (
        missingDir !== undefined &&
        get().project === null &&
        isCommandError(error, "project_not_found")
      ) {
        // 오류는 만들기가 실패했을 때만 sheet에 보인다.
        set({ status: "missing", missingDir, error: null });
      } else {
        set({ error: message });
      }
      return false;
    }
    generation += 1;
    set({
      status: "ready",
      project,
      files: [],
      error: null,
      missingDir: null,
      unapplied: {},
    });
    void get().refreshFiles();
    void get().refreshRecent();
    return true;
  }

  return {
    status: "booting",
    project: null,
    recent: [],
    files: [],
    error: null,
    missingDir: null,
    unapplied: {},

    async refreshRecent() {
      try {
        set({ recent: await recentProjects() });
      } catch {
        // 앱 저장소가 없다(store_unavailable). 최근 프로젝트 없이 쓴다.
        set({ recent: [] });
      }
    },

    async boot() {
      await get().refreshRecent();
      const latest = get().recent[0];
      if (latest === undefined) {
        set({ status: "none" });
        return false;
      }
      if (await enter(() => openProject(latest.dir))) return true;
      set({ status: "none" });
      return false;
    },

    open: (dir, askToCreate = true) =>
      enter(() => openProject(dir), askToCreate ? dir : undefined),

    dismissMissing() {
      set({ status: "none", missingDir: null, error: null });
    },

    create: (dir) => enter(() => createProject(dir)),

    applyProject(project, unapplied = {}) {
      set({ project, unapplied });
    },

    async refreshFiles() {
      if (get().project === null) return;
      const started = generation;
      try {
        const files = await listSqlFiles();
        if (generation === started) set({ files });
      } catch (error) {
        if (generation === started) set({ error: messageOf(error) });
      }
    },

    showError(message) {
      set({ error: message });
    },

    clearError() {
      set({ error: null });
    },
  };
});

/** 탭의 세션이 쓰는 그 이름의 접속. Commit이 실패해 반영하지 못한 저장이 있으면 그 앞의 값이다. */
export function connectionInUse(name: string): Connection | undefined {
  const { project, unapplied } = useProject.getState();
  return unapplied[name] ?? project?.connections.find((c) => c.name === name);
}

/** 열린 프로젝트의 그 이름의 접속. 없으면 undefined다. */
export function useConnection(name: string | null): Connection | undefined {
  return useProject((s) =>
    name === null
      ? undefined
      : s.project?.connections.find((c) => c.name === name),
  );
}
