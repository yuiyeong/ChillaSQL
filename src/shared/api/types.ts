// src-tauri/src/commands.rs의 DTO가 화면으로 보내는 JSON과 같은 모양이다.
// 키는 camelCase, 구분 값(`outcome`, `type`, `mode`)은 snake_case다.

import type { Language } from "../i18n/t";

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
  /** 세션을 읽기 전용으로 연다. 서버가 쓰기를 거절한다. */
  readOnly: boolean;
  /** 세션의 statement_timeout 초(1~86400). 없으면 서버 기본값이다. */
  statementTimeout: number | null;
}

/** 접속 test가 알아낸 서버의 정보. */
export interface ServerInfo {
  /** server_version의 첫 단어("18.6"). */
  version: string;
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

/** 셀 편집 대상이 될 수 있는 relation의 컬럼 하나. */
export interface EditColumn {
  /** `pg_attribute.attnum`. 결과 열의 `columnNumber`와 맞춘다. */
  number: number;
  name: string;
  /** `quote_ident(attname)`. SQL에 쓴다. */
  quotedName: string;
  primaryKey: boolean;
  /** generated 컬럼과 `GENERATED ALWAYS` identity 컬럼은 false */
  updatable: boolean;
}

/** 셀 편집 대상이 될 수 있는 relation 하나. 결과 열의 `tableOid`로 찾는다. */
export interface EditTable {
  oid: number;
  /** `quote_ident(schema) || '.' || quote_ident(relname)`. SQL에 쓴다. */
  qualifiedName: string;
  /** relname 그대로. 화면 문구에 쓴다. */
  name: string;
  kind: RelationKind;
  /** attnum 순. 지운 컬럼은 없다. */
  columns: EditColumn[];
}

/** 결과 컬럼 type 하나의 이름과 category. `oid`와 `modifier`는 `ResultColumn`의 것이다. */
export interface TypeInfo {
  oid: number;
  modifier: number;
  /** `format_type`이 만든 이름(`character varying(255)`, `timestamp with time zone` 등) */
  name: string;
  /** `pg_type.typcategory`, 한 글자(`N`은 숫자, `S`는 문자열, `D`는 날짜·시간, `A`는 배열 등) */
  category: string;
}

/** 문장의 위치. `start`와 `end`는 JS 문자열의 UTF-16 code unit offset이다. */
export interface StatementSpan {
  start: number;
  end: number;
}

/** `:name` 파라미터의 위치. `start`는 `:`, `end`는 이름 끝이고 UTF-16 code unit offset이다. */
export interface ParameterSpan {
  name: string;
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

/**
 * 결과의 열 하나. type은 서버 RowDescription의 OID와 typmod다(OID 0은 모름, typmod -1은 없음).
 * `tableOid`와 `columnNumber`도 RowDescription의 값이며, 테이블 컬럼이 아니면(식, UNION) 0이다.
 */
export interface ResultColumn {
  name: string;
  typeOid: number;
  typeModifier: number;
  tableOid: number;
  columnNumber: number;
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

/** 시작할 때 읽은 전역 설정(`~/.config/chilla/config.toml`). `error`가 있으면 기본값이고 그 이유다. */
export interface Settings {
  language: Language;
  editor: { font: string; fontSize: number };
  /** 받다 만 결과를 닫는 초 */
  idleTimeoutSecs: number;
  error: string | null;
  /** 앱 내부 저장소를 열지 못한 이유. 있으면 최근 프로젝트와 탭 복원이 없다. */
  storeError: string | null;
}

/** 저장된 쿼리 기록 하나. */
export interface HistoryEntry {
  id: number;
  /** 접속 이름 */
  connection: string;
  sql: string;
  /** Unix ms. 실행을 시작한 때 */
  executedAt: number;
  elapsedMicros: number;
}

/** 최근에 연 프로젝트. */
export interface RecentProject {
  dir: string;
  name: string;
  /** Unix 초 */
  openedAt: number;
}
