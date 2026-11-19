/** Rust의 `CommandError { kind, message }`. 화면은 `kind`로 다음 행동을 고르고 `message`를 보여 준다. */
export class CommandError extends Error {
  readonly kind: string;
  /** 터널 명령의 stderr. 명령이 실행된 터널 오류에만 있다. */
  readonly output: string | null;

  constructor(kind: string, message: string, output: string | null = null) {
    super(message);
    this.name = "CommandError";
    this.kind = kind;
    this.output = output;
  }
}

function isErrorPayload(
  value: unknown,
): value is { kind: string; message: string; output?: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const { kind, message } = value as Record<string, unknown>;
  return typeof kind === "string" && typeof message === "string";
}

/** invoke가 reject한 값을 CommandError로 바꾼다. `{ kind, message }` object가 아니면 kind는 "internal"이다. */
export function toCommandError(value: unknown): CommandError {
  if (value instanceof CommandError) return value;
  if (isErrorPayload(value)) {
    const output = typeof value.output === "string" ? value.output : null;
    return new CommandError(value.kind, value.message, output);
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
