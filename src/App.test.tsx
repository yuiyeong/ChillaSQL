import { render, screen } from "@testing-library/react";
import App from "./App";

test("앱 이름을 보여 주고 template의 greet 입력란은 없다", () => {
  render(<App />);
  expect(
    screen.getByRole("heading", { name: "ChillaSQL" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("textbox")).toBeNull();
});
