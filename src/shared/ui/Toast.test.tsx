import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Toast, useToast } from "./Toast";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("message가 없으면 비어 있고 있으면 보인다", () => {
  const { rerender } = render(<Toast message={null} />);
  expect(screen.getByRole("status")).toBeEmptyDOMElement();
  rerender(<Toast message="Copied" />);
  expect(screen.getByRole("status")).toHaveTextContent("Copied");
});

test("show 뒤 2초가 지나면 사라진다", () => {
  const { result } = renderHook(() => useToast());
  act(() => result.current.show("Copied"));
  expect(result.current.message).toBe("Copied");
  act(() => vi.advanceTimersByTime(1999));
  expect(result.current.message).toBe("Copied");
  act(() => vi.advanceTimersByTime(1));
  expect(result.current.message).toBeNull();
});

test("다시 show하면 2초를 새로 잰다", () => {
  const { result } = renderHook(() => useToast());
  act(() => result.current.show("one"));
  act(() => vi.advanceTimersByTime(1500));
  act(() => result.current.show("two"));
  act(() => vi.advanceTimersByTime(1500));
  expect(result.current.message).toBe("two");
  act(() => vi.advanceTimersByTime(500));
  expect(result.current.message).toBeNull();
});
