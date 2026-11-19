import { Channel, invoke } from "@tauri-apps/api/core";
import { toCommandError } from "./errors";
import type {
  Connection,
  Danger,
  EndResult,
  Project,
  QueryEvent,
  Session,
  SqlFile,
  StatementSpan,
  TxEnd,
  TxMode,
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

/** 문장 하나의 첫 위험을 돌려준다. 위험이 없거나 문장을 읽을 수 없으면 null이다. */
export function inspectStatement(sql: string): Promise<Danger | null> {
  return call("inspect_statement", { sql });
}

/** query id를 돌려준다. event는 이 promise가 끝나기 전에도 `onEvent`로 온다. */
export function executeQuery(
  sessionId: number,
  sql: string,
  mode: TxMode,
  onEvent: (event: QueryEvent) => void,
): Promise<number> {
  const channel = new Channel<QueryEvent>();
  channel.onmessage = onEvent;
  return call("execute_query", { sessionId, sql, mode, onEvent: channel });
}

/** 트랜잭션을 Commit하거나 Rollback한다. 실행 중인 쿼리가 있으면 Rust가 버린 뒤에 끝낸다. */
export function endTransaction(
  sessionId: number,
  end: TxEnd,
): Promise<EndResult> {
  return call("end_transaction", { sessionId, end });
}

/** 그 접속의 터널이 시작 중이면 멈춘다. 기다리던 세션 열기는 `tunnel_cancelled`로 끝난다. */
export function cancelTunnel(connection: string): Promise<void> {
  return call("cancel_tunnel", { connection });
}

/** 다시 실행하다 멈춘 그 접속의 터널을 처음부터 다시 시작한다. */
export function restartTunnel(connection: string): Promise<void> {
  return call("restart_tunnel", { connection });
}

export function cancelQuery(sessionId: number, queryId: number): Promise<void> {
  return call("cancel_query", { sessionId, queryId });
}

/** 다음 batch를 보내라고 Rust에 알린다. 결과가 끝났는지는 `finished` event로 안다. */
export function fetchMore(sessionId: number, queryId: number): Promise<void> {
  return call("fetch_more", { sessionId, queryId });
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

/** 앱을 끝낸다. 열린 세션은 닫히고 서버가 열린 트랜잭션을 되돌린다. */
export function quitApp(): Promise<void> {
  return call("quit_app");
}
