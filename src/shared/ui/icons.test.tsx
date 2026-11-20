import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import * as icons from "./icons";

test("모든 icon은 aria-hidden이고 currentColor를 쓴다", () => {
  const all = Object.entries(icons);
  expect(all.length).toBe(25);
  for (const [name, Icon] of all) {
    const { container, unmount } = render(<Icon />);
    const svg = container.querySelector("svg");
    expect(svg, name).toHaveAttribute("aria-hidden", "true");
    expect(svg?.outerHTML, name).toContain("currentColor");
    expect(svg?.outerHTML, name).not.toMatch(/#[0-9a-f]{3,6}/i);
    unmount();
  }
});
