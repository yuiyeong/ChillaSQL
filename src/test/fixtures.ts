import type { Connection, Project, TxMode } from "../shared/api/types";
import { useTabs, type Tab } from "../features/editor/tabsStore";
import { useProject } from "../features/project/projectStore";

/** test용 접속. 바꿀 값만 `patch`로 준다. */
export function connection(
  name: string,
  patch: Partial<Connection> = {},
): Connection {
  return {
    name,
    host: "localhost",
    port: 5432,
    database: "app",
    user: "chilla",
    sslmode: "disable",
    sslrootcert: null,
    tunnel: null,
    tunnelTimeout: null,
    color: null,
    ...patch,
  };
}

/** test용 탭. 문서는 열지 않는다. 바꿀 값만 `patch`로 준다. */
export function testTab(id: string, patch: Partial<Tab> = {}): Tab {
  return {
    id,
    title: id,
    path: null,
    stamp: null,
    dirty: false,
    connection: null,
    mode: "auto",
    ...patch,
  };
}

/** 그 탭의 트랜잭션 모드를 정한다. 탭 store에 그 탭이 없으면 `testTab`으로 먼저 둔다. */
export function setTabMode(id: string, mode: TxMode): void {
  if (!useTabs.getState().tabs.some((tab) => tab.id === id)) {
    useTabs.setState((s) => ({ tabs: [...s.tabs, testTab(id)] }));
  }
  useTabs.getState().setMode(id, mode);
}

/** `demo` 프로젝트(`/p`)가 열린 상태로 project store를 바꾼다. */
export function openProjectWith(
  connections: Connection[] = [],
  files: string[] = [],
): Project {
  const project: Project = { name: "demo", dir: "/p", connections };
  useProject.setState(
    { ...useProject.getInitialState(), status: "ready", project, files },
    true,
  );
  return project;
}
