import {
  loadWorkspace,
  readSqlFile,
  saveWorkspace,
} from "../../shared/api/commands";
import type { TxMode } from "../../shared/api/types";
import { tc } from "../../shared/i18n/t";
import { documentFileText, findDocument } from "../editor/documents";
import { useTabs, type RestoredTab, type TabsState } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { useSettings } from "../settings/settingsStore";

export interface TabSnapshot {
  title: string;
  path: string | null;
  stamp: string | null;
  connection: string | null;
  mode: TxMode;
  /** 저장하지 않은 변경이 있거나 파일이 없는 탭의 text. 아니면 null */
  text: string | null;
}

export interface WorkspaceSnapshot {
  version: 1;
  active: number | null;
  tabs: TabSnapshot[];
}

/** 마지막 변경에서 저장까지 기다리는 ms */
const DELAY_MS = 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
/** 차례로 하는 저장의 끝. 저장은 실패해도 resolve한다. */
let saving: Promise<void> = Promise.resolve();
/**
 * 보관한 탭을 읽어 되살린 프로젝트의 dir. 이 프로젝트가 열려 있을 때만 저장한다. 새 프로젝트를 연 뒤
 * 되살리기 전의 탭(빈 탭)을 저장해 보관한 탭을 덮어쓰지 않게 한다.
 */
let readyDir: string | null = null;
let subscription: (() => void) | null = null;

export function snapshotOf(state: TabsState): WorkspaceSnapshot {
  const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
  return {
    version: 1,
    active: index < 0 ? null : index,
    tabs: state.tabs.map((tab) => ({
      title: tab.title,
      path: tab.path,
      stamp: tab.stamp,
      connection: tab.connection,
      mode: tab.mode,
      // 줄 끝은 파일의 것으로 둔다. 되살릴 때 CRLF 문서로 다시 열린다.
      text:
        (tab.dirty || tab.path === null) && findDocument(tab.id) !== undefined
          ? documentFileText(tab.id)
          : null,
    })),
  };
}

/** 지금 탭을 열린 프로젝트에 저장한다. 실패는 무시한다. 다음 변경이 다시 저장한다. */
async function saveNow(): Promise<void> {
  const dir = useProject.getState().project?.dir;
  if (dir === undefined || dir !== readyDir) return;
  // dir과 snapshot을 같은 때에 읽는다. 그 사이 프로젝트가 바뀌면 Rust가 project_changed로 거절한다.
  const text = JSON.stringify(snapshotOf(useTabs.getState()));
  try {
    await saveWorkspace(dir, text);
  } catch {
    // 저장하지 못해도 화면의 탭은 그대로다.
  }
}

function save(): Promise<void> {
  saving = saving.then(saveNow);
  return saving;
}

function cancelTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function schedule(): void {
  cancelTimer();
  timer = setTimeout(() => {
    timer = null;
    void save();
  }, DELAY_MS);
}

/** 보이는 탭의 문서가 바뀌었다. 1초 뒤 저장한다. */
export function documentChanged(): void {
  schedule();
}

/** tabsStore와 문서 변경을 구독해 1초 뒤 저장한다. */
export function startAutosave(): () => void {
  subscription?.();
  const unsubscribe = useTabs.subscribe((state, prev) => {
    if (state.tabs !== prev.tabs || state.activeId !== prev.activeId) {
      schedule();
    }
  });
  subscription = unsubscribe;
  return () => {
    if (subscription !== unsubscribe) return;
    unsubscribe();
    subscription = null;
    void flushAutosave();
  };
}

/** 기다리는 저장을 바로 한다. 하고 있는 저장이 끝날 때까지 기다린다. */
export function flushAutosave(): Promise<void> {
  if (timer === null) return saving;
  cancelTimer();
  return save();
}

/** test가 앞 test의 저장 상태를 지운다. */
export function resetAutosave(): void {
  cancelTimer();
  subscription?.();
  subscription = null;
  saving = Promise.resolve();
  readyDir = null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isTabSnapshot(value: unknown): value is TabSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const tab = value as Record<string, unknown>;
  return (
    typeof tab.title === "string" &&
    isNullableString(tab.path) &&
    isNullableString(tab.stamp) &&
    isNullableString(tab.connection) &&
    (tab.mode === "auto" || tab.mode === "manual") &&
    isNullableString(tab.text)
  );
}

/** 저장한 text의 snapshot. JSON이 아니거나 모르는 형식이면 null이다. */
function parseSnapshot(text: unknown): WorkspaceSnapshot | null {
  if (typeof text !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { version, active, tabs } = value as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(tabs) || !tabs.every(isTabSnapshot)) {
    return null;
  }
  if (
    active !== null &&
    !(Number.isInteger(active) && (active as number) >= 0)
  ) {
    return null;
  }
  return { version, active: active as number | null, tabs };
}

/** text가 없는 탭은 파일을 다시 읽는다. 읽지 못하면 null이다. */
async function reread(tab: TabSnapshot): Promise<RestoredTab | null> {
  const { text, ...rest } = tab;
  if (text !== null) {
    // 파일이 있는 탭은 저장하지 않은 변경이 있었다. 이름 없는 탭은 비어 있지 않으면 dirty다.
    return { ...rest, text, dirty: tab.path !== null || text !== "" };
  }
  if (tab.path === null) return { ...rest, text: "", dirty: false };
  try {
    const file = await readSqlFile(tab.path);
    return { ...rest, stamp: file.stamp, text: file.text, dirty: false };
  } catch {
    return null;
  }
}

/** 탭을 되살린다. 읽지 못한 파일의 탭은 빼고 그 경로들을 돌려준다. */
export async function restore(
  snapshot: WorkspaceSnapshot,
): Promise<{ skipped: string[] }> {
  const dir = useProject.getState().project?.dir;
  const read = await Promise.all(snapshot.tabs.map(reread));
  // 읽는 동안 다른 프로젝트가 열렸으면 되살리지 않는다.
  if (useProject.getState().project?.dir !== dir) return { skipped: [] };

  const kept: RestoredTab[] = [];
  const skipped: string[] = [];
  // 활성 탭이 빠지면 그 다음 탭, 없으면 마지막 탭이 활성이다.
  let active: number | null = null;
  read.forEach((tab, index) => {
    if (tab === null) {
      skipped.push(snapshot.tabs[index].path as string);
      return;
    }
    if (
      active === null &&
      snapshot.active !== null &&
      index >= snapshot.active
    ) {
      active = kept.length;
    }
    kept.push(tab);
  });
  if (active === null && snapshot.active !== null && kept.length > 0) {
    active = kept.length - 1;
  }
  useTabs.getState().restoreTabs(kept, active);
  return { skipped };
}

/**
 * 열린 프로젝트의 보관한 탭을 되살리고 그 프로젝트의 자동 보관을 켠다. 프로젝트를 연 뒤마다 부른다.
 * 앱 저장소가 없거나 읽지 못하면 되살리지도 저장하지도 않는다.
 */
export async function reopenTabs(): Promise<void> {
  const dir = useProject.getState().project?.dir;
  // 되살리기 전에는 이 프로젝트에 저장하지 않는다.
  readyDir = null;
  cancelTimer();
  if (dir === undefined || !useSettings.getState().storeAvailable) return;
  let text: string | null;
  try {
    text = await loadWorkspace(dir);
  } catch {
    // project_changed면 이미 다른 프로젝트다. 그 밖의 오류면 보관한 탭을 덮어쓰지 않게 저장도 하지 않는다.
    return;
  }
  if (useProject.getState().project?.dir !== dir) return;
  const snapshot = parseSnapshot(text);
  if (snapshot !== null) {
    const { skipped } = await restore(snapshot);
    if (useProject.getState().project?.dir !== dir) return;
    if (skipped.length > 0) {
      useTabs
        .getState()
        .setError(tc("autosave.skipped", skipped.length, { path: skipped[0] }));
    }
  }
  // 되살린 탭은 restoreTabs가 부른 저장이 1초 뒤 이 프로젝트에 저장한다.
  readyDir = dir;
}
