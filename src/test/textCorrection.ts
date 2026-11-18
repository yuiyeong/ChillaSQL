import { expect } from "vitest";

/** macOS WebKit의 자동 수정, 자동 대문자, 맞춤법 검사가 꺼져 있는지 본다. */
export function expectNoTextCorrection(element: Element): void {
  expect(element).toHaveAttribute("autocorrect", "off");
  expect(element).toHaveAttribute("autocapitalize", "off");
  expect(element).toHaveAttribute("spellcheck", "false");
}
