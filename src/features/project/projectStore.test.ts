import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/dialog");

import {
  createProject,
  listSqlFiles,
  openProject,
} from "../../shared/api/commands";
import { CommandError } from "../../shared/api/errors";
import type { Project } from "../../shared/api/types";
import { LAST_PROJECT_KEY, useProject } from "./projectStore";
import { deferred } from "../../test/deferred";
import { connection } from "../../test/fixtures";

function project(dir: string, name = "demo"): Project {
  return { name, dir, connections: [] };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  localStorage.clear();
  useProject.setState(useProject.getInitialState(), true);
  vi.mocked(listSqlFiles).mockResolvedValue([]);
});

test("boot는 마지막 디렉토리를 연다", async () => {
  localStorage.setItem(LAST_PROJECT_KEY, "/p");
  vi.mocked(openProject).mockResolvedValue(project("/p"));

  await useProject.getState().boot();

  expect(openProject).toHaveBeenCalledWith("/p");
  expect(useProject.getState().status).toBe("ready");
  expect(useProject.getState().project?.dir).toBe("/p");
});

test("마지막 디렉토리가 없으면 none이다", async () => {
  await useProject.getState().boot();

  expect(openProject).not.toHaveBeenCalled();
  expect(useProject.getState().status).toBe("none");
  expect(useProject.getState().error).toBeNull();
});

test("boot가 실패하면 none이고 error가 있다", async () => {
  localStorage.setItem(LAST_PROJECT_KEY, "/gone");
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );

  await useProject.getState().boot();

  const state = useProject.getState();
  expect(state.status).toBe("none");
  expect(state.error).toBe("chilla.toml이 없습니다");
  expect(state.missingDir).toBeNull();
});

test("파일 목록을 기다리지 않고 ready가 된다", async () => {
  const list = deferred<string[]>();
  vi.mocked(openProject).mockResolvedValue(project("/p"));
  vi.mocked(listSqlFiles).mockReturnValue(list.promise);

  const opened = await useProject.getState().open("/p");

  expect(opened).toBe(true);
  expect(useProject.getState().status).toBe("ready");
  expect(useProject.getState().files).toEqual([]);

  list.resolve(["a.sql"]);
  await vi.waitFor(() =>
    expect(useProject.getState().files).toEqual(["a.sql"]),
  );
});

test("연 디렉토리를 localStorage에 쓴다", async () => {
  vi.mocked(openProject).mockResolvedValue(project("/private/p"));

  await useProject.getState().open("/p");

  expect(localStorage.getItem(LAST_PROJECT_KEY)).toBe("/private/p");
});

test("chilla.toml이 없으면 missing이고 create로 만든다", async () => {
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );
  vi.mocked(createProject).mockResolvedValue(project("/new", "new"));

  const opened = await useProject.getState().open("/new");

  expect(opened).toBe(false);
  expect(useProject.getState().status).toBe("missing");
  expect(useProject.getState().missingDir).toBe("/new");

  const created = await useProject.getState().create("/new");

  expect(created).toBe(true);
  expect(createProject).toHaveBeenCalledWith("/new");
  expect(useProject.getState().status).toBe("ready");
  expect(useProject.getState().project?.name).toBe("new");
  expect(useProject.getState().error).toBeNull();
  expect(localStorage.getItem(LAST_PROJECT_KEY)).toBe("/new");
});

test("여는 데 실패해도 열려 있던 프로젝트는 그대로다", async () => {
  vi.mocked(openProject).mockResolvedValueOnce(project("/p"));
  await useProject.getState().open("/p");
  const before = useProject.getState().project;

  vi.mocked(openProject).mockRejectedValueOnce(
    new CommandError("project_invalid", "chilla.toml이 올바르지 않습니다"),
  );
  const opened = await useProject.getState().open("/bad");

  expect(opened).toBe(false);
  expect(useProject.getState().project).toBe(before);
  expect(useProject.getState().status).toBe("ready");
  expect(useProject.getState().error).toBe("chilla.toml이 올바르지 않습니다");
  expect(localStorage.getItem(LAST_PROJECT_KEY)).toBe("/p");
});

test("프로젝트가 열려 있으면 project_not_found여도 status를 바꾸지 않는다", async () => {
  vi.mocked(openProject).mockResolvedValueOnce(project("/p"));
  await useProject.getState().open("/p");

  vi.mocked(openProject).mockRejectedValueOnce(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );
  const opened = await useProject.getState().open("/other");

  expect(opened).toBe(false);
  expect(useProject.getState().status).toBe("ready");
  expect(useProject.getState().project?.dir).toBe("/p");
  expect(useProject.getState().missingDir).toBeNull();
  expect(useProject.getState().error).toBe("chilla.toml이 없습니다");
});

test("create가 실패하면 error만 두고 missing에 머문다", async () => {
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );
  await useProject.getState().open("/new");
  vi.mocked(createProject).mockRejectedValue(
    new CommandError("io", "쓸 수 없습니다"),
  );

  const created = await useProject.getState().create("/new");

  expect(created).toBe(false);
  expect(useProject.getState().status).toBe("missing");
  expect(useProject.getState().error).toBe("쓸 수 없습니다");
});

test("localStorage가 throw해도 열린다", async () => {
  vi.mocked(openProject).mockResolvedValue(project("/p"));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });

  const opened = await useProject.getState().open("/p");

  expect(opened).toBe(true);
  expect(useProject.getState().status).toBe("ready");
});

test("localStorage를 읽다 throw해도 boot는 none이다", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });

  await useProject.getState().boot();

  expect(useProject.getState().status).toBe("none");
});

test("프로젝트가 바뀐 뒤 끝난 파일 목록은 버린다", async () => {
  const first = deferred<string[]>();
  vi.mocked(openProject)
    .mockResolvedValueOnce(project("/a"))
    .mockResolvedValueOnce(project("/b"));
  vi.mocked(listSqlFiles)
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(["b.sql"]);

  await useProject.getState().open("/a");
  await useProject.getState().open("/b");
  await vi.waitFor(() =>
    expect(useProject.getState().files).toEqual(["b.sql"]),
  );

  first.resolve(["a.sql"]);
  await first.promise;
  await Promise.resolve();

  expect(useProject.getState().files).toEqual(["b.sql"]);
});

test("프로젝트가 바뀐 뒤 실패한 파일 목록 error도 버린다", async () => {
  const first = deferred<string[]>();
  vi.mocked(openProject)
    .mockResolvedValueOnce(project("/a"))
    .mockResolvedValueOnce(project("/b"));
  vi.mocked(listSqlFiles)
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce([]);

  await useProject.getState().open("/a");
  await useProject.getState().open("/b");
  await vi.waitFor(() => expect(listSqlFiles).toHaveBeenCalledTimes(2));

  first.reject(new CommandError("io", "목록 실패"));
  await new Promise((r) => setTimeout(r, 0));

  expect(useProject.getState().error).toBeNull();
});

test("refreshFiles가 실패하면 error를 두고 files는 그대로다", async () => {
  vi.mocked(openProject).mockResolvedValue(project("/p"));
  vi.mocked(listSqlFiles).mockResolvedValueOnce(["a.sql"]);
  await useProject.getState().open("/p");
  await vi.waitFor(() =>
    expect(useProject.getState().files).toEqual(["a.sql"]),
  );

  vi.mocked(listSqlFiles).mockRejectedValueOnce(
    new CommandError("io", "목록을 읽지 못했습니다"),
  );
  await useProject.getState().refreshFiles();

  expect(useProject.getState().files).toEqual(["a.sql"]);
  expect(useProject.getState().error).toBe("목록을 읽지 못했습니다");
});

test("applyProject는 project만 바꾸고 파일 목록 요청을 버리지 않는다", async () => {
  const list = deferred<string[]>();
  vi.mocked(openProject).mockResolvedValue(project("/p"));
  vi.mocked(listSqlFiles).mockReturnValue(list.promise);
  await useProject.getState().open("/p");

  const updated: Project = {
    ...project("/p"),
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
        tunnelTimeout: null,
        readOnly: false,
        statementTimeout: null,
        color: null,
      },
    ],
  };
  useProject.getState().applyProject(updated);
  list.resolve(["a.sql"]);

  await vi.waitFor(() =>
    expect(useProject.getState().files).toEqual(["a.sql"]),
  );
  expect(useProject.getState().project).toBe(updated);
});

test("프로젝트를 열면 반영하지 못한 접속을 잊는다", async () => {
  useProject.setState({ unapplied: { local: connection("local") } });
  vi.mocked(openProject).mockResolvedValue(project("/q"));

  await useProject.getState().open("/q");

  expect(useProject.getState().unapplied).toEqual({});
});
