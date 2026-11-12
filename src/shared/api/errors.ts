/** Rust의 `CommandError { kind, message }`. 화면은 `kind`로 다음 행동을 고르고 `message`를 보여 준다. */
export class CommandError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "CommandError";
    this.kind = kind;
  }
}

function isErrorPayload(
  value: unknown,
): value is { kind: string; message: string } {
  if (typeof value !== "object" || value === null) return false;
  const { kind, message } = value as Record<string, unknown>;
  return typeof kind === "string" && typeof message === "string";
}

/** invoke가 reject한 값을 CommandError로 바꾼다. `{ kind, message }` object가 아니면 kind는 "internal"이다. */
export function toCommandError(value: unknown): CommandError {
  if (value instanceof CommandError) return value;
  if (isErrorPayload(value)) return new CommandError(value.kind, value.message);
  const message = value instanceof Error ? value.message : String(value);
  return new CommandError("internal", message);
}
