import { onTestFinished, vi } from "vitest";

/**
 * jsdom은 layout이 없어 clientWidth와 clientHeight가 0이다. 모든 element가 이 크기라고 둔다.
 * test가 끝나면 되돌린다. test 안이나 `beforeEach`에서 부른다.
 */
export function stubLayout({
  width,
  height,
}: {
  width: number;
  height: number;
}): void {
  const spies = [
    vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(width),
    vi
      .spyOn(HTMLElement.prototype, "clientHeight", "get")
      .mockReturnValue(height),
  ];
  onTestFinished(() => spies.forEach((spy) => spy.mockRestore()));
}
