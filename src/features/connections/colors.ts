const NAMES = ["green", "yellow", "red", "blue", "purple"];

/** 접속의 color 이름에 맞는 token 변수. 정하지 않았거나 모르는 이름이면 line-2다. */
export function connectionColor(color: string | null): string {
  if (color === null || !NAMES.includes(color)) return "var(--color-line-2)";
  return `var(--color-conn-${color})`;
}
