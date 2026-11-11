import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import App from "./App";

test("앱 이름을 보여 준다", () => {
  render(<App />);
  expect(
    screen.getByRole("heading", { name: "ChillaSQL" }),
  ).toBeInTheDocument();
});
