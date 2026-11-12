import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("./shared/api/commands");
vi.mock("./shared/api/dialog");

import App from "./App";
import { useProject } from "./features/project/projectStore";

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  useProject.setState(useProject.getInitialState(), true);
});

test("프로젝트가 없으면 프로젝트 열기 버튼을 보여 준다", async () => {
  render(<App />);

  expect(
    await screen.findByRole("button", { name: "프로젝트 열기" }),
  ).toBeInTheDocument();
});
