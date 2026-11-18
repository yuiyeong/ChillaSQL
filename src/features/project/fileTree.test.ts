import { expect, test } from "vitest";
import { buildTree, projectInitials, shortenHome } from "./fileTree";

test("folder가 먼저, 그 안은 이름 순서로 tree를 만든다", () => {
  const tree = buildTree([
    "scratch.sql",
    "queries/b.sql",
    "queries/a.sql",
    "reports/x/y.sql",
  ]);

  expect(tree).toEqual([
    {
      kind: "folder",
      name: "queries",
      path: "queries",
      children: [
        { kind: "file", name: "a.sql", path: "queries/a.sql" },
        { kind: "file", name: "b.sql", path: "queries/b.sql" },
      ],
    },
    {
      kind: "folder",
      name: "reports",
      path: "reports",
      children: [
        {
          kind: "folder",
          name: "x",
          path: "reports/x",
          children: [{ kind: "file", name: "y.sql", path: "reports/x/y.sql" }],
        },
      ],
    },
    { kind: "file", name: "scratch.sql", path: "scratch.sql" },
  ]);
});

test("파일이 없으면 tree도 비어 있다", () => {
  expect(buildTree([])).toEqual([]);
});

test("home으로 시작하는 경로는 ~로 줄인다", () => {
  expect(shortenHome("/Users/jo/work/a", "/Users/jo")).toBe("~/work/a");
  expect(shortenHome("/Users/jo", "/Users/jo")).toBe("~");
  expect(shortenHome("/opt/a", "/Users/jo")).toBe("/opt/a");
  expect(shortenHome("/Users/joe/a", "/Users/jo")).toBe("/Users/joe/a");
  expect(shortenHome("/Users/jo/a", null)).toBe("/Users/jo/a");
});

test("프로젝트 이니셜은 앞 두 낱말의 첫 글자, 낱말이 하나면 앞 두 글자다", () => {
  expect(projectInitials("chilla-demo")).toBe("CD");
  expect(projectInitials("my_cool.app x")).toBe("MC");
  expect(projectInitials("app")).toBe("AP");
  expect(projectInitials("a")).toBe("A");
  expect(projectInitials("--x--")).toBe("X");
});
