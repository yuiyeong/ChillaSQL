import { Channel, invoke } from "@tauri-apps/api/core";
import { toCommandError } from "./errors";
import type {
  ApplyResult,
  Catalog,
  Connection,
  Danger,
  EditTable,
  EndResult,
  Project,
  QueryEvent,
  HistoryEntry,
  RecentProject,
  ServerInfo,
  Settings,
  Session,
  SqlFile,
  ParameterSpan,
  StatementSpan,
  TableDetails,
  TxEnd,
  TxMode,
  TypeInfo,
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
): Promise<ServerInfo> {
  return call("test_connection", { connection, password });
}

export function openSession(connection: string): Promise<Session> {
  return call("open_session", { connection });
}

export function closeSession(sessionId: number): Promise<void> {
  return call("close_session", { sessionId });
}

/** 그 접속의 catalog. Rust가 접속마다 따로 연 연결로 읽는다(터널을 함께 씀). */
export function loadCatalog(connection: string): Promise<Catalog> {
  return call("load_catalog", { connection });
}

export function loadTableDetails(
  connection: string,
  relation: number,
): Promise<TableDetails> {
  return call("load_table_details", { connection, relation });
}

/**
 * 테이블이나 view 하나의 생성문(DDL). 그 접속의 catalog 연결이 읽어 Rust가 조립한다.
 * 지워졌으면 `relation_gone` 오류다.
 */
export function loadDdl(connection: string, relation: number): Promise<string> {
  return call("load_ddl", { connection, relation });
}

/**
 * 결과 컬럼의 type 이름과 category를 그 접속의 catalog 연결이 답한다. 모르는 OID는 답에 없다.
 * 답은 받은 순서대로다.
 */
export function describeTypes(
  connection: string,
  types: { oid: number; modifier: number }[],
): Promise<TypeInfo[]> {
  return call("describe_types", { connection, types });
}

/**
 * 결과 열의 table OID마다 이름, 종류, 컬럼(attnum, PK, 고칠 수 있는지)을 그 접속의 catalog 연결이
 * 답한다. 없는 OID와 table이 아닌 relation(인덱스, sequence 등)은 답에 없다.
 */
export function describeTables(
  connection: string,
  oids: number[],
): Promise<EditTable[]> {
  return call("describe_tables", { connection, oids });
}

/** 그 접속의 catalog 연결을 닫는다. 그 접속을 쓰는 탭이 없어졌을 때 부른다. */
export function closeCatalog(connection: string): Promise<void> {
  return call("close_catalog", { connection });
}

export function splitStatements(sql: string): Promise<StatementSpan[]> {
  return call("split_statements", { sql });
}

/** 문장 안의 `:name` 파라미터를 start 오름차순으로 돌려준다. 나눌 수 없는 text면 거부한다. */
export function findParameters(sql: string): Promise<ParameterSpan[]> {
  return call("find_parameters", { sql });
}

/** 문장 하나의 첫 위험을 돌려준다. 위험이 없거나 문장을 읽을 수 없으면 null이다. */
export function inspectStatement(sql: string): Promise<Danger | null> {
  return call("inspect_statement", { sql });
}

/**
 * query id를 돌려준다. event는 이 promise가 끝나기 전에도 `onEvent`로 온다.
 * `drain`이면 Columns와 첫 batch만 보내고 나머지 행은 Rust가 끝까지 읽어서 버린다.
 */
export function executeQuery(
  sessionId: number,
  sql: string,
  mode: TxMode,
  onEvent: (event: QueryEvent) => void,
  options?: { drain?: boolean },
): Promise<number> {
  const channel = new Channel<QueryEvent>();
  channel.onmessage = onEvent;
  const drain = options?.drain ?? false;
  return call("execute_query", {
    sessionId,
    sql,
    mode,
    drain,
    onEvent: channel,
  });
}

/** 트랜잭션을 Commit하거나 Rollback한다. 실행 중인 쿼리가 있으면 Rust가 버린 뒤에 끝낸다. */
export function endTransaction(
  sessionId: number,
  end: TxEnd,
): Promise<EndResult> {
  return call("end_transaction", { sessionId, end });
}

/**
 * 셀 편집의 UPDATE를 한 단위로 보낸다. 문장마다 바뀐 행이 정확히 하나여야 하고 아니면 Rust가 모두
 * 되돌린다. 그 세션에 열린 쿼리가 있거나 트랜잭션이 실패했으면 보내지 않는다.
 */
export function applyEdits(
  sessionId: number,
  statements: string[],
  mode: TxMode,
): Promise<ApplyResult> {
  return call("apply_edits", { sessionId, statements, mode });
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

/** 내보낸 결과 text를 `path`에 쓴다. 있으면 덮어쓴다. 실패는 `export_failed`다. */
export function writeExport(path: string, text: string): Promise<void> {
  return call("write_export", { path, text });
}

/** 앱을 끝낸다. 열린 세션은 닫히고 서버가 열린 트랜잭션을 되돌린다. */
export function quitApp(): Promise<void> {
  return call("quit_app");
}

/** 앱을 시작할 때 읽은 전역 설정. 파일을 고쳐도 앱을 다시 시작해야 바뀐다. */
export function loadSettings(): Promise<Settings> {
  return call("load_settings");
}

/** 최근에 연 프로젝트. 최근 것부터 최대 10개다. */
export function recentProjects(): Promise<RecentProject[]> {
  return call("recent_projects");
}

/**
 * `dir` 프로젝트의 탭 snapshot(화면이 만든 JSON text). 저장한 적이 없으면 null이다.
 * `dir`은 열린 프로젝트의 `dir`이어야 하고 아니면 `project_changed`다.
 */
export function loadWorkspace(dir: string): Promise<string | null> {
  return call("load_workspace", { dir });
}

/** `dir`이 열린 프로젝트가 아니면 저장하지 않고 `project_changed`로 reject한다. */
export function saveWorkspace(dir: string, snapshot: string): Promise<void> {
  return call("save_workspace", { dir, snapshot });
}

/**
 * `dir` 프로젝트의 쿼리 기록에 더한다. `dir`이 열린 프로젝트가 아니면 `project_changed`로
 * reject한다.
 */
export function recordQuery(
  dir: string,
  entry: Omit<HistoryEntry, "id">,
): Promise<void> {
  return call("record_query", { dir, entry });
}

/**
 * 검색어를 공백으로 나눈 단어가 모두 SQL에 든 기록을 최근 것부터 200개. 검색어가 비면 최근
 * 기록이다. `dir`이 열린 프로젝트가 아니면 `project_changed`로 reject한다.
 */
export function searchHistory(
  dir: string,
  query: string,
): Promise<HistoryEntry[]> {
  return call("search_history", { dir, query });
}
