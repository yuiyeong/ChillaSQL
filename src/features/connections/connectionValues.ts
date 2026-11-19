import type {
  Connection,
  ConnectionColor,
  SslMode,
} from "../../shared/api/types";
import { t } from "../../shared/i18n/t";

/** form의 입력값. 숫자도 입력 중에는 문자열이다. */
export interface FormValues {
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  sslmode: SslMode;
  sslrootcert: string;
  tunnel: string;
  /** 초. 비우면 기본값(20초)이다 */
  tunnelTimeout: string;
  color: ConnectionColor | null;
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
      tunnel: "",
      tunnelTimeout: "",
      color: null,
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
    tunnel: original.tunnel ?? "",
    tunnelTimeout:
      original.tunnelTimeout === null ? "" : String(original.tunnelTimeout),
    color: original.color,
  };
}

/** Rust의 `MAX_TUNNEL_TIMEOUT_SECS`와 같다. */
const MAX_TUNNEL_TIMEOUT = 300;

const required = ["name", "host", "database", "user"] as const;

/** `taken`은 프로젝트에 이미 있는 접속 이름이다. 새 접속이 그 이름이면 덮어쓰지 않게 거절한다. */
export function toConnection(
  values: FormValues,
  original: Connection | null,
  taken: readonly string[],
): { connection: Connection } | { error: string } {
  const trimmed = {
    name: values.name.trim(),
    host: values.host.trim(),
    database: values.database.trim(),
    user: values.user.trim(),
  };
  // 수정에서는 name을 original에서 가져오므로 form의 name은 검사하지 않는다.
  for (const key of required) {
    if (key === "name" && original !== null) continue;
    if (trimmed[key] === "")
      return { error: t("connectionForm.required", { field: key }) };
  }
  if (original === null && taken.includes(trimmed.name)) {
    return { error: t("connectionForm.nameTaken") };
  }

  const portText = values.port.trim();
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: t("connectionForm.portRange") };
  }

  const sslrootcert = values.sslrootcert.trim();
  const tunnel = values.tunnel.trim();
  let tunnelTimeout: number | null = null;
  const timeoutText = values.tunnelTimeout.trim();
  if (tunnel !== "" && timeoutText !== "") {
    tunnelTimeout = /^\d+$/.test(timeoutText) ? Number(timeoutText) : 0;
    if (tunnelTimeout < 1 || tunnelTimeout > MAX_TUNNEL_TIMEOUT) {
      return { error: t("connectionForm.tunnelTimeoutRange") };
    }
  }
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
      tunnel: tunnel === "" ? null : tunnel,
      tunnelTimeout,
      color: values.color,
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
