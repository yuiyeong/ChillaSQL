import type { Connection, SslMode } from "../../shared/api/types";

/** form의 입력값. 숫자도 입력 중에는 문자열이다. */
export interface FormValues {
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  sslmode: SslMode;
  sslrootcert: string;
}

export function initialValues(original: Connection | null): FormValues {
  if (original === null) {
    return {
      name: "",
      host: "",
      port: "5432",
      database: "",
      user: "",
      sslmode: "disable",
      sslrootcert: "",
    };
  }
  return {
    name: original.name,
    host: original.host,
    port: String(original.port),
    database: original.database,
    user: original.user,
    sslmode: original.sslmode,
    sslrootcert: original.sslrootcert ?? "",
  };
}

const required = [
  ["name", "name을"],
  ["host", "host를"],
  ["database", "database를"],
  ["user", "user를"],
] as const;

const portError = "port는 1~65535의 숫자여야 합니다";

export function toConnection(
  values: FormValues,
  original: Connection | null,
): { connection: Connection } | { error: string } {
  const trimmed = {
    name: values.name.trim(),
    host: values.host.trim(),
    database: values.database.trim(),
    user: values.user.trim(),
  };
  // 수정에서는 name을 original에서 가져오므로 form의 name은 검사하지 않는다.
  for (const [key, label] of required) {
    if (key === "name" && original !== null) continue;
    if (trimmed[key] === "") return { error: `${label} 입력하세요` };
  }

  const portText = values.port.trim();
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: portError };
  }

  const sslrootcert = values.sslrootcert.trim();
  return {
    connection: {
      name: original?.name ?? trimmed.name,
      host: trimmed.host,
      port,
      database: trimmed.database,
      user: trimmed.user,
      sslmode: values.sslmode,
      sslrootcert:
        values.sslmode === "verify-full" && sslrootcert !== ""
          ? sslrootcert
          : null,
      tunnel: original?.tunnel ?? null,
      color: original?.color ?? null,
    },
  };
}

/** color를 뺀 나머지가 하나라도 다르면 true다(Rust의 `same_target`과 같은 항목). */
export function targetChanged(
  connection: Connection,
  original: Connection,
): boolean {
  return (
    connection.name !== original.name ||
    connection.host !== original.host ||
    connection.port !== original.port ||
    connection.database !== original.database ||
    connection.user !== original.user ||
    connection.sslmode !== original.sslmode ||
    connection.sslrootcert !== original.sslrootcert ||
    connection.tunnel !== original.tunnel
  );
}
