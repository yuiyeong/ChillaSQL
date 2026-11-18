import type { Connection } from "../../shared/api/types";

/** 접속이 가리키는 곳. sidebar와 접속 menu에 쓴다. 예: `localhost:5432/app` */
export function connectionTarget(
  connection: Pick<Connection, "host" | "port" | "database">,
): string {
  return `${connection.host}:${connection.port}/${connection.database}`;
}
