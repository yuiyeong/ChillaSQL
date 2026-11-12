import { create } from "zustand";
import {
  createProject,
  listSqlFiles,
  openProject,
} from "../../shared/api/commands";
import { isCommandError, messageOf } from "../../shared/api/errors";
import type { Project } from "../../shared/api/types";

export const LAST_PROJECT_KEY = "chilla.lastProjectDir";

export type ProjectStatus = "booting" | "none" | "missing" | "ready";

export interface ProjectState {
  status: ProjectStatus;
  project: Project | null;
  files: string[];
  error: string | null;
  /** status가 "missing"일 때 chilla.toml이 없던 디렉토리 */
  missingDir: string | null;
  /** 마지막 디렉토리를 연다 */
  boot(): Promise<void>;
  /** 열렸으면 true */
  open(dir: string): Promise<boolean>;
  create(dir: string): Promise<boolean>;
  /** 접속을 저장한 뒤 */
  applyProject(project: Project): void;
  refreshFiles(): Promise<void>;
  /** 프로젝트를 열기 전에 실패한 일(디렉토리 고르기)을 알린다. */
  showError(message: string): void;
  clearError(): void;
}

function readLastDir(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

function writeLastDir(dir: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, dir);
  } catch {
    // 기억하지 못할 뿐이다. 프로젝트는 열린다.
  }
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
        set({ status: "missing", missingDir, error: message });
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
    });
    writeLastDir(project.dir);
    void get().refreshFiles();
    return true;
  }

  return {
    status: "booting",
    project: null,
    files: [],
    error: null,
    missingDir: null,

    async boot() {
      const dir = readLastDir();
      if (dir === null) {
        set({ status: "none" });
        return;
      }
      if (!(await enter(() => openProject(dir)))) set({ status: "none" });
    },

    open: (dir) => enter(() => openProject(dir), dir),

    create: (dir) => enter(() => createProject(dir)),

    applyProject(project) {
      set({ project });
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
