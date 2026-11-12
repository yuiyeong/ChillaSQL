import { Channel, invoke } from "@tauri-apps/api/core";
import { toCommandError } from "./errors";
import type {
  Connection,
  Project,
  QueryEvent,
  Session,
  SqlFile,
  StatementSpan,
  WriteMode,
} from "./types";

/** invoke가 reject하면 CommandError로 바꿔 다시 던진다. */
async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return args === undefined
      ? await invoke<T>(command)
      : await invoke<T>(command, args);
  } catch (error) {
    throw toCommandError(error);
  }
}

export function openProject(path: string): Promise<Project> {
  return call("open_project", { path });
}

export function createProject(path: string): Promise<Project> {
  return call("create_project", { path });
}

export function saveConnection(
  connection: Connection,
  password: string | null,
): Promise<Project> {
  return call("save_connection", { connection, password });
}

export function hasPassword(connection: string): Promise<boolean> {
  return call("has_password", { connection });
}

export function testConnection(
  connection: Connection,
  password: string | null,
): Promise<void> {
  return call("test_connection", { connection, password });
}

export function openSession(connection: string): Promise<Session> {
  return call("open_session", { connection });
}

export function closeSession(sessionId: number): Promise<void> {
  return call("close_session", { sessionId });
}

export function splitStatements(sql: string): Promise<StatementSpan[]> {
  return call("split_statements", { sql });
}

/** query id를 돌려준다. event는 이 promise가 끝나기 전에도 `onEvent`로 온다. */
export function executeQuery(
  sessionId: number,
  sql: string,
  onEvent: (event: QueryEvent) => void,
): Promise<number> {
  const channel = new Channel<QueryEvent>();
  channel.onmessage = onEvent;
  return call("execute_query", { sessionId, sql, onEvent: channel });
}

export function cancelQuery(sessionId: number, queryId: number): Promise<void> {
  return call("cancel_query", { sessionId, queryId });
}

export function listSqlFiles(): Promise<string[]> {
  return call("list_sql_files");
}

export function readSqlFile(path: string): Promise<SqlFile> {
  return call("read_sql_file", { path });
}

/** 쓴 뒤의 stamp를 돌려준다. */
export function writeSqlFile(
  path: string,
  text: string,
  mode: WriteMode,
): Promise<string> {
  return call("write_sql_file", { path, text, mode });
}
