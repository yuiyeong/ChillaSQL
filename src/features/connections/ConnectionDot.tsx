import { connectionColor } from "./colors";

/**
 * 접속의 8px 색 dot. `color`는 접속의 color 이름이다. 정하지 않았으면(null) line-2,
 * 접속이 없으면(undefined) 속이 빈 원이다.
 */
export function ConnectionDot({
  color,
  testId,
}: {
  color: string | null | undefined;
  testId?: string;
}) {
  if (color === undefined) {
    return (
      <span
        aria-hidden="true"
        data-testid={testId}
        className="border-fg-3 size-2 shrink-0 rounded-full border-[1.5px]"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      className="size-2 shrink-0 rounded-full"
      style={{ background: connectionColor(color) }}
    />
  );
}
