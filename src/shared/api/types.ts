// src-tauri/src/commands.rs의 DTO가 화면으로 보내는 JSON과 같은 모양이다.
// 키는 camelCase, 구분 값(`outcome`, `type`, `mode`)은 snake_case다.

export type SslMode = "disable" | "require" | "verify-full";

export type ConnectionColor = "green" | "yellow" | "red" | "blue" | "purple";

export interface Connection {
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  sslmode: SslMode;
  sslrootcert: string | null;
  tunnel: string | null;
  /** 터널의 포트를 기다리는 초. 없으면 20초다. */
  tunnelTimeout: number | null;
  color: ConnectionColor | null;
}

export interface Project {
  name: string;
  dir: string;
  connections: Connection[];
}

export interface Session {
  id: number;
  connection: string;
  backendPid: number;
}

export type RelationKind =
  | "table"
  | "partitioned_table"
  | "foreign_table"
  | "view"
  | "materialized_view";

export interface CatalogColumn {
  name: string;
  /** `format_type`이 만든 이름(`timestamp with time zone` 등) */
  type: string;
  primaryKey: boolean;
}

/** 테이블이나 뷰 하나. 컬럼은 테이블에 정의된 순서다. */
export interface Relation {
  oid: number;
  schema: string;
  name: string;
  kind: RelationKind;
  columns: CatalogColumn[];
}

/** 접속 하나의 catalog. 목록은 모두 이름 오름차순이다(searchPath는 순서 그대로). */
export interface Catalog {
  /** `current_schemas(false)`. 자동완성의 기본 schema는 첫 값이다. */
  searchPath: string[];
  schemas: string[];
  relations: Relation[];
  functions: { schema: string; name: string }[];
  /** unreserved가 아닌 keyword. 이름을 따옴표로 감쌀지 정할 때 쓴다. */
  reservedWords: string[];
}

export type ConstraintKind =
  "primary_key" | "foreign_key" | "unique" | "check" | "exclusion";

/** 테이블 하나의 인덱스와 제약조건. 각각 이름 오름차순이다. */
export interface TableDetails {
  indexes: {
    name: string;
    definition: string;
    unique: boolean;
    primary: boolean;
  }[];
  constraints: { name: string; kind: ConstraintKind; definition: string }[];
}

/** 문장의 위치. `start`와 `end`는 JS 문자열의 UTF-16 code unit offset이다. */
export interface StatementSpan {
  start: number;
  end: number;
}

/**
 * 실행 전에 확인할 위험한 문장. 이름은 문장에 쓴 그대로다.
 * `drop`의 `object`는 SQL keyword("TABLE", "MATERIALIZED VIEW" 등)이고 그 밖의 object는 "".
 */
export type Danger =
  | { kind: "update_without_where" | "delete_without_where"; table: string }
  | { kind: "drop"; object: string; names: string[] }
  | { kind: "truncate"; tables: string[] };

export interface ServerError {
  code: string;
  message: string;
  detail: string | null;
  hint: string | null;
  /** 보낸 text에서의 UTF-16 code unit offset(0부터). 없으면 null. */
  position: number | null;
}

/** `null`은 NULL, 아니면 서버가 만든 text다. */
export type Cell = string | null;

/** 서버가 ReadyForQuery로 알려 주는 트랜잭션 상태. */
export type TxStatus = "idle" | "in_transaction" | "failed";

/** 실행의 트랜잭션 모드. `manual`이면 트랜잭션 밖일 때 Rust가 그 문장 전에 `BEGIN`을 보낸다. */
export type TxMode = "auto" | "manual";

export type TxEnd = "commit" | "rollback";

/** `endTransaction`의 결과. `tx`는 끝낸 뒤의 상태이고 연결이 끊겼으면 null. */
export type EndResult = {
  tx: TxStatus | null;
} & (
  | { outcome: "ended" }
  /** 실패한 트랜잭션의 Commit이라 보내지 않았다. */
  | { outcome: "transaction_failed" }
  | { outcome: "server_error"; error: ServerError }
  | { outcome: "connection_lost"; message: string }
  | { outcome: "client_error"; message: string }
);

export type Outcome =
  | { outcome: "completed"; rows: number }
  | { outcome: "failed"; error: ServerError }
  | { outcome: "cancelled" }
  | { outcome: "discarded" }
  /** batch를 보낸 뒤 10분 동안 더 가져오지 않아 닫았다. */
  | { outcome: "expired" }
  | { outcome: "connection_lost"; message: string }
  | { outcome: "client_error"; message: string };

/** 결과의 열 하나. type은 서버 RowDescription의 OID와 typmod다(OID 0은 모름, typmod -1은 없음). */
export interface ResultColumn {
  name: string;
  typeOid: number;
  typeModifier: number;
}

export type QueryEvent =
  | { type: "columns"; columns: ResultColumn[] }
  | {
      type: "rows";
      firstRow: number;
      rows: Cell[][];
      retainedFrom: number;
      elapsedMicros: number;
    }
  | ({
      type: "finished";
      elapsedMicros: number;
      /** 그 쿼리가 끝난 뒤 서버가 알려 준 상태. 연결이 끊겼거나 세션을 닫는 중이면 null. */
      tx: TxStatus | null;
    } & Outcome);

export interface SqlFile {
  text: string;
  stamp: string;
}

export type WriteMode =
  | { mode: "create" }
  | { mode: "replace"; stamp: string }
  | { mode: "overwrite" };

/** 터널이 실패한 이유. `reason`이 구분자다. */
export type TunnelFailure =
  | { reason: "spawn"; message: string }
  | { reason: "exited"; code: number | null; output: string }
  | { reason: "timeout"; secs: number; output: string }
  | { reason: "cancelled" };

/** 접속 하나의 터널 상태. `status`가 구분자다. `attempt`는 처음 시작이 0, 다시 실행이 1~3이다. */
export type TunnelState =
  | { status: "starting"; attempt: number; timeoutSecs: number }
  | { status: "ready" }
  | { status: "external" }
  | ({ status: "failed" } & TunnelFailure)
  | { status: "stopped" };

/** Rust가 보내는 event `tunnel`. */
export interface TunnelEvent {
  connection: string;
  state: TunnelState;
}
