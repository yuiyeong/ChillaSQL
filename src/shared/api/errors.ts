/**
 * Rust의 `CommandError { kind, message, params }`. 화면은 `kind`로 다음 행동을 고르고,
 * `params`로 `kind`의 문구를 번역한다. 번역이 없으면 `message`를 보여 준다.
 */
export class CommandError extends Error {
  readonly kind: string;
  /** 터널 명령의 stderr. 명령이 실행된 터널 오류에만 있다. */
  readonly output: string | null;
  /** message의 변하는 부분. 이름은 `errorKinds.json`에 있다. */
  readonly params: Record<string, string>;

  constructor(
    kind: string,
    message: string,
    output: string | null = null,
    params: Record<string, string> = {},
  ) {
    super(message);
    this.name = "CommandError";
    this.kind = kind;
    this.output = output;
    this.params = params;
  }
}

function isErrorPayload(value: unknown): value is {
  kind: string;
  message: string;
  output?: unknown;
  params?: unknown;
} {
  if (typeof value !== "object" || value === null) return false;
  const { kind, message } = value as Record<string, unknown>;
  return typeof kind === "string" && typeof message === "string";
}

/** 문자열 값만 남긴다. object가 아니면 빈 object다. */
function toParams(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  const params: Record<string, string> = {};
  for (const [key, param] of Object.entries(value)) {
    if (typeof param === "string") params[key] = param;
  }
  return params;
}

/** invoke가 reject한 값을 CommandError로 바꾼다. `{ kind, message }` object가 아니면 kind는 "internal"이다. */
export function toCommandError(value: unknown): CommandError {
  if (value instanceof CommandError) return value;
  if (isErrorPayload(value)) {
    const output = typeof value.output === "string" ? value.output : null;
    return new CommandError(
      value.kind,
      value.message,
      output,
      toParams(value.params),
    );
  }
  return new CommandError("internal", messageOf(value));
}

/** 사용자에게 보일 문구. Error면 그 message, 아니면 문자열로 바꾼 값이다. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `kind`의 CommandError인가 */
export function isCommandError(error: unknown, kind: string): boolean {
  return error instanceof CommandError && error.kind === kind;
}
