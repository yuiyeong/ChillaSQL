import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { click } from "../../test/click";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/dialog");

import { listSqlFiles } from "../../shared/api/commands";
import { useProject } from "./projectStore";
import { Sidebar } from "./Sidebar";

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  useProject.setState(useProject.getInitialState(), true);
  useProject.setState({
    status: "ready",
    project: {
      name: "demo",
      dir: "/p",
      connections: [
        {
          name: "local",
          host: "localhost",
          port: 5432,
          database: "app",
          user: "me",
          sslmode: "disable",
          sslrootcert: null,
          tunnel: null,
          color: null,
        },
      ],
    },
    files: ["queries/users.sql"],
  });
});

function handlers() {
  return {
    onOpenFile: vi.fn(),
    onAddConnection: vi.fn(),
    onEditConnection: vi.fn(),
    onSwitchProject: vi.fn(),
  };
}

test("접속과 SQL 파일을 나열한다", () => {
  render(<Sidebar {...handlers()} />);

  expect(screen.getByText("demo")).toBeInTheDocument();
  expect(screen.getByText("local")).toBeInTheDocument();
  expect(screen.getByText("localhost:5432/app")).toBeInTheDocument();
  expect(screen.getByText("queries/users.sql")).toBeInTheDocument();
});

test("파일, 수정, 접속 추가, 다른 프로젝트, 새로고침이 각 handler를 부른다", async () => {
  const h = handlers();
  vi.mocked(listSqlFiles).mockResolvedValue(["queries/users.sql", "new.sql"]);
  render(<Sidebar {...h} />);

  await click(screen.getByRole("button", { name: "queries/users.sql" }));
  expect(h.onOpenFile).toHaveBeenCalledWith("queries/users.sql");

  await click(screen.getByRole("button", { name: "수정" }));
  expect(h.onEditConnection).toHaveBeenCalledWith("local");

  await click(screen.getByRole("button", { name: "접속 추가" }));
  expect(h.onAddConnection).toHaveBeenCalledTimes(1);

  await click(screen.getByRole("button", { name: "다른 프로젝트" }));
  expect(h.onSwitchProject).toHaveBeenCalledTimes(1);

  await click(screen.getByRole("button", { name: "새로고침" }));
  expect(listSqlFiles).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("new.sql")).toBeInTheDocument();
});

test("접속이 없으면 접속 추가만 보인다", () => {
  useProject.setState({
    project: { name: "demo", dir: "/p", connections: [] },
    files: [],
  });
  render(<Sidebar {...handlers()} />);

  expect(
    screen.queryByRole("button", { name: "수정" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "접속 추가" })).toBeInTheDocument();
});
