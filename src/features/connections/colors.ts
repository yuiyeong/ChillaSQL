import type { ConnectionColor } from "../../shared/api/types";

/** 고를 수 있는 접속 color. 순서가 swatch의 순서다. */
export const CONNECTION_COLORS: readonly ConnectionColor[] = [
  "green",
  "yellow",
  "red",
  "blue",
  "purple",
];

/** 접속의 color 이름에 맞는 token 변수. 정하지 않았거나 모르는 이름이면 line-2다. */
export function connectionColor(color: ConnectionColor | null): string {
  if (
    color === null ||
    !(CONNECTION_COLORS as readonly string[]).includes(color)
  )
    return "var(--color-line-2)";
  return `var(--color-conn-${color})`;
}
