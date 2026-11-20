import { beforeEach, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
  },
}));

import { invoke, Channel } from "@tauri-apps/api/core";
import {
  cancelQuery,
  closeSession,
  createProject,
  endTransaction,
  executeQuery,
  fetchMore,
  hasPassword,
  inspectStatement,
  listSqlFiles,
  loadWorkspace,
  recentProjects,
  recordQuery,
  searchHistory,
  saveWorkspace,
  openProject,
  openSession,
  readSqlFile,
  saveConnection,
  findParameters,
  splitStatements,
  testConnection,
  writeSqlFile,
  cancelTunnel,
  closeCatalog,
  describeTables,
  describeTypes,
  loadCatalog,
  loadDdl,
  loadSettings,
  loadTableDetails,
  quitApp,
  restartTunnel,
} from "./commands";
import { CommandError } from "./errors";
import type { Connection, EndResult, QueryEvent } from "./types";

const invokeMock = vi.mocked(invoke);

const conn: Connection = {
  name: "local",
  host: "127.0.0.1",
  port: 5432,
  database: "app",
  user: "chilla",
  sslmode: "disable",
  sslrootcert: null,
  tunnel: null,
  tunnelTimeout: null,
  color: null,
  readOnly: false,
  statementTimeout: null,
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

test("command 이름과 인자 key를 그대로 보낸다", async () => {
  await openProject("/p");
  expect(invokeMock).toHaveBeenLastCalledWith("open_project", { path: "/p" });

  await createProject("/p");
  expect(invokeMock).toHaveBeenLastCalledWith("create_project", { path: "/p" });

  await saveConnection(conn, "pw");
  expect(invokeMock).toHaveBeenLastCalledWith("save_connection", {
    connection: conn,
    password: "pw",
  });

  await hasPassword("local");
  expect(invokeMock).toHaveBeenLastCalledWith("has_password", {
    connection: "local",
  });

  await testConnection(conn, null);
  expect(invokeMock).toHaveBeenLastCalledWith("test_connection", {
    connection: conn,
    password: null,
  });

  await loadCatalog("local");
  expect(invokeMock).toHaveBeenLastCalledWith("load_catalog", {
    connection: "local",
  });

  await loadTableDetails("local", 16385);
  expect(invokeMock).toHaveBeenLastCalledWith("load_table_details", {
    connection: "local",
    relation: 16385,
  });

  await loadDdl("local", 16385);
  expect(invokeMock).toHaveBeenLastCalledWith("load_ddl", {
    connection: "local",
    relation: 16385,
  });

  await describeTypes("local", [{ oid: 1043, modifier: 259 }]);
  expect(invokeMock).toHaveBeenLastCalledWith("describe_types", {
    connection: "local",
    types: [{ oid: 1043, modifier: 259 }],
  });

  await describeTables("local", [16385, 16390]);
  expect(invokeMock).toHaveBeenLastCalledWith("describe_tables", {
    connection: "local",
    oids: [16385, 16390],
  });

  await closeCatalog("local");
  expect(invokeMock).toHaveBeenLastCalledWith("close_catalog", {
    connection: "local",
  });

  await openSession("local");
  expect(invokeMock).toHaveBeenLastCalledWith("open_session", {
    connection: "local",
  });

  await closeSession(3);
  expect(invokeMock).toHaveBeenLastCalledWith("close_session", {
    sessionId: 3,
  });

  await splitStatements("a; b");
  expect(invokeMock).toHaveBeenLastCalledWith("split_statements", {
    sql: "a; b",
  });

  await findParameters("a = :id");
  expect(invokeMock).toHaveBeenLastCalledWith("find_parameters", {
    sql: "a = :id",
  });

  await inspectStatement("delete from s");
  expect(invokeMock).toHaveBeenLastCalledWith("inspect_statement", {
    sql: "delete from s",
  });

  await cancelQuery(3, 7);
  expect(invokeMock).toHaveBeenLastCalledWith("cancel_query", {
    sessionId: 3,
    queryId: 7,
  });

  await fetchMore(3, 7);
  expect(invokeMock).toHaveBeenLastCalledWith("fetch_more", {
    sessionId: 3,
    queryId: 7,
  });

  await listSqlFiles();
  expect(invokeMock).toHaveBeenLastCalledWith("list_sql_files");

  await readSqlFile("a.sql");
  expect(invokeMock).toHaveBeenLastCalledWith("read_sql_file", {
    path: "a.sql",
  });

  await writeSqlFile("a.sql", "x", { mode: "replace", stamp: "s" });
  expect(invokeMock).toHaveBeenLastCalledWith("write_sql_file", {
    path: "a.sql",
    text: "x",
    mode: { mode: "replace", stamp: "s" },
  });
});

test("executeQuery는 Channel의 message를 onEvent로 넘긴다", async () => {
  invokeMock.mockResolvedValue(7);
  const onEvent = vi.fn();

  const queryId = await executeQuery(3, "SELECT 1", "manual", onEvent);

  expect(invokeMock).toHaveBeenCalledTimes(1);
  const [name, args] = invokeMock.mock.calls[0]!;
  expect(name).toBe("execute_query");
  expect(args).toEqual({
    sessionId: 3,
    sql: "SELECT 1",
    mode: "manual",
    drain: false,
    onEvent: expect.any(Channel),
  });
  const channel = (args as { onEvent: Channel<QueryEvent> }).onEvent;
  const event: QueryEvent = {
    type: "columns",
    columns: [
      {
        name: "id",
        typeOid: 23,
        typeModifier: -1,
        tableOid: 0,
        columnNumber: 0,
      },
    ],
  };
  channel.onmessage(event);
  expect(onEvent).toHaveBeenCalledWith(event);
  expect(queryId).toBe(7);
});

test("executeQuery는 drain 옵션을 넘긴다", async () => {
  invokeMock.mockResolvedValue(7);

  await executeQuery(3, "SELECT 1", "auto", vi.fn(), { drain: true });

  expect(invokeMock).toHaveBeenLastCalledWith(
    "execute_query",
    expect.objectContaining({ drain: true }),
  );
});

test("endTransaction은 끝내는 방법을 넘기고 결과를 그대로 돌려준다", async () => {
  const result: EndResult = { outcome: "ended", tx: "idle" };
  invokeMock.mockResolvedValue(result);

  await expect(endTransaction(3, "commit")).resolves.toEqual(result);
  expect(invokeMock).toHaveBeenCalledWith("end_transaction", {
    sessionId: 3,
    end: "commit",
  });
});

test("Rust의 오류 object는 CommandError가 된다", async () => {
  invokeMock.mockRejectedValueOnce({ kind: "unreachable", message: "m" });
  const error = await openProject("/p").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(CommandError);
  expect((error as CommandError).kind).toBe("unreachable");
  expect((error as CommandError).message).toBe("m");

  invokeMock.mockRejectedValueOnce("command not found");
  const other = await openProject("/p").catch((e: unknown) => e);
  expect(other).toBeInstanceOf(CommandError);
  expect((other as CommandError).kind).toBe("internal");
  expect((other as CommandError).message).toContain("command not found");
});

test("터널 오류의 output은 CommandError에 남고 없으면 null이다", async () => {
  invokeMock.mockRejectedValueOnce({
    kind: "tunnel_timeout",
    message: "localhost:25432 didn't open within 20 seconds",
    output: "Unauthorized",
  });
  const tunnel = await openProject("/p").catch((e: unknown) => e);
  expect((tunnel as CommandError).output).toBe("Unauthorized");

  invokeMock.mockRejectedValueOnce({ kind: "unreachable", message: "m" });
  const plain = await openProject("/p").catch((e: unknown) => e);
  expect((plain as CommandError).output).toBeNull();
});

test("cancelTunnel과 restartTunnel은 접속 이름을 보낸다", async () => {
  invokeMock.mockResolvedValue(undefined);
  await cancelTunnel("staging");
  expect(invokeMock).toHaveBeenLastCalledWith("cancel_tunnel", {
    connection: "staging",
  });
  await restartTunnel("staging");
  expect(invokeMock).toHaveBeenLastCalledWith("restart_tunnel", {
    connection: "staging",
  });
});

test("quitApp은 인자 없이 quit_app을 부른다", async () => {
  await quitApp();
  expect(invokeMock).toHaveBeenLastCalledWith("quit_app");
});

test("loadSettings는 인자 없이 load_settings를 부른다", async () => {
  await loadSettings();
  expect(invokeMock).toHaveBeenLastCalledWith("load_settings");
});

test("recentProjects는 인자 없이 부른다", async () => {
  await recentProjects();
  expect(invokeMock).toHaveBeenLastCalledWith("recent_projects");
});

test("loadWorkspace는 프로젝트 dir을 보낸다", async () => {
  await loadWorkspace("/p");
  expect(invokeMock).toHaveBeenLastCalledWith("load_workspace", { dir: "/p" });
});

test("saveWorkspace는 프로젝트 dir과 snapshot text를 그대로 보낸다", async () => {
  await saveWorkspace("/p", '{"tabs":[]}');
  expect(invokeMock).toHaveBeenLastCalledWith("save_workspace", {
    dir: "/p",
    snapshot: '{"tabs":[]}',
  });
});

test("recordQuery는 프로젝트 dir과 camelCase 항목을 보낸다", async () => {
  const entry = {
    connection: "local",
    sql: "select 1",
    executedAt: 1700000000000,
    elapsedMicros: 42,
  };
  await recordQuery("/p", entry);
  expect(invokeMock).toHaveBeenLastCalledWith("record_query", {
    dir: "/p",
    entry,
  });
});

test("searchHistory는 프로젝트 dir과 검색어를 보낸다", async () => {
  await searchHistory("/p", "users email");
  expect(invokeMock).toHaveBeenLastCalledWith("search_history", {
    dir: "/p",
    query: "users email",
  });
});
