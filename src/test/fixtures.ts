import type {
  Catalog,
  Connection,
  Project,
  Relation,
  RelationKind,
  TxMode,
} from "../shared/api/types";
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

/** test용 relation. 컬럼은 `[이름, type, pk]`다. */
export function relation(
  oid: number,
  schema: string,
  name: string,
  columns: [string, string, boolean?][] = [],
  kind: RelationKind = "table",
): Relation {
  return {
    oid,
    schema,
    name,
    kind,
    columns: columns.map(([column, type, primaryKey = false]) => ({
      name: column,
      type,
      primaryKey,
    })),
  };
}

/** test용 catalog: `public.users`(1), `public.orders`(2), `billing.invoices`(3). 바꿀 값만 `patch`로 준다. */
export function catalogFixture(patch: Partial<Catalog> = {}): Catalog {
  return {
    searchPath: ["public"],
    schemas: ["billing", "public"],
    relations: [
      relation(3, "billing", "invoices", [
        ["id", "bigint", true],
        ["amount", "numeric"],
      ]),
      relation(2, "public", "orders", [
        ["id", "bigint", true],
        ["user_id", "bigint"],
      ]),
      relation(1, "public", "users", [
        ["id", "bigint", true],
        ["email", "text"],
        ["email_verified_at", "timestamp with time zone"],
      ]),
    ],
    functions: [
      { schema: "pg_catalog", name: "date_trunc" },
      { schema: "public", name: "add_one" },
    ],
    reservedWords: ["select", "user"],
    ...patch,
  };
}
