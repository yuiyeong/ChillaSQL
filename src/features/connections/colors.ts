import type { Connection, ConnectionColor } from "../../shared/api/types";

/** 고를 수 있는 접속 color. 순서가 swatch의 순서다. */
export const CONNECTION_COLORS: readonly ConnectionColor[] = [
  "green",
  "yellow",
  "red",
  "blue",
  "purple",
];

/**
 * 접속의 color 이름에 맞는 token 변수. 정하지 않았으면 line-2다. 모르는 이름은 Rust가 프로젝트를
 * 읽을 때와 접속을 저장할 때 거절하므로 오지 않는다.
 */
export function connectionColor(color: ConnectionColor | null): string {
  return color === null ? "var(--color-line-2)" : `var(--color-conn-${color})`;
}

/**
 * 이름이 `name`인 접속의 color 이름. 접속이 없으면(null) undefined, 그 접속이 color를 정하지
 * 않았거나 목록에 없으면 null이다. `ConnectionDot`의 `color`로 그대로 넘긴다.
 */
export function colorOf(
  connections: readonly Connection[] | undefined,
  name: string | null,
): ConnectionColor | null | undefined {
  if (name === null) return undefined;
  return connections?.find((c) => c.name === name)?.color ?? null;
}
