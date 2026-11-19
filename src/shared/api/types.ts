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

/** 문장의 위치. `start`와 `end`는 JS 문자열의 UTF-16 code unit offset이다. */
export interface StatementSpan {
  start: number;
  end: number;
}

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

export type Outcome =
  | { outcome: "completed"; rows: number }
  | { outcome: "failed"; error: ServerError }
  | { outcome: "cancelled" }
  | { outcome: "discarded" }
  | { outcome: "connection_lost"; message: string }
  | { outcome: "client_error"; message: string };

export type QueryEvent =
  | { type: "columns"; columns: { name: string }[] }
  | {
      type: "rows";
      firstRow: number;
      rows: Cell[][];
      retainedFrom: number;
      elapsedMicros: number;
    }
  | ({ type: "finished"; elapsedMicros: number } & Outcome);

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
