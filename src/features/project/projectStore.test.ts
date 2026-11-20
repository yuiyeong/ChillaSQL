import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/dialog");

import {
  createProject,
  listSqlFiles,
  openProject,
  recentProjects,
} from "../../shared/api/commands";
import { CommandError } from "../../shared/api/errors";
import type { Project, RecentProject } from "../../shared/api/types";
import { useProject } from "./projectStore";
import { deferred } from "../../test/deferred";
import { connection } from "../../test/fixtures";

function project(dir: string, name = "demo"): Project {
  return { name, dir, connections: [] };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  useProject.setState(useProject.getInitialState(), true);
  vi.mocked(listSqlFiles).mockResolvedValue([]);
  vi.mocked(recentProjects).mockResolvedValue([]);
});

function recentOf(...dirs: string[]): RecentProject[] {
  return dirs.map((dir, index) => ({
    dir,
    name: dir.split("/").pop() ?? dir,
    openedAt: 1_700_000_000 - index,
  }));
}

test("boot_opens_the_most_recent_project", async () => {
  vi.mocked(recentProjects).mockResolvedValue(recentOf("/p", "/q"));
  vi.mocked(openProject).mockResolvedValue(project("/p"));

  const opened = await useProject.getState().boot();

  expect(opened).toBe(true);
  expect(openProject).toHaveBeenCalledTimes(1);
  expect(openProject).toHaveBeenCalledWith("/p");
  expect(useProject.getState().status).toBe("ready");
  expect(useProject.getState().project?.dir).toBe("/p");
});

test("boot_without_recents_shows_welcome", async () => {
  const opened = await useProject.getState().boot();

  expect(opened).toBe(false);
  expect(openProject).not.toHaveBeenCalled();
  expect(useProject.getState().status).toBe("none");
  expect(useProject.getState().error).toBeNull();
  expect(useProject.getState().recent).toEqual([]);
});

test("boot_shows_welcome_when_it_fails", async () => {
  vi.mocked(recentProjects).mockResolvedValue(recentOf("/gone", "/q"));
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );

  const opened = await useProject.getState().boot();

  const state = useProject.getState();
  expect(opened).toBe(false);
  expect(state.status).toBe("none");
  expect(state.error).toBe("chilla.toml이 없습니다");
  expect(state.missingDir).toBeNull();
  // 없는 디렉토리도 목록에 남는다.
  expect(state.recent.map((r) => r.dir)).toEqual(["/gone", "/q"]);
});

test("boot_treats_an_unavailable_store_as_no_recents", async () => {
  vi.mocked(recentProjects).mockRejectedValue(
    new CommandError("store_unavailable", "앱 저장소를 열 수 없습니다"),
  );

  await useProject.getState().boot();

  expect(useProject.getState().status).toBe("none");
  expect(useProject.getState().recent).toEqual([]);
  expect(useProject.getState().error).toBeNull();
});

test("opening_or_creating_a_project_refreshes_the_recent_list", async () => {
  vi.mocked(openProject).mockResolvedValue(project("/p"));
  vi.mocked(createProject).mockResolvedValue(project("/new", "new"));
  vi.mocked(recentProjects)
    .mockResolvedValueOnce(recentOf("/p"))
    .mockResolvedValueOnce(recentOf("/new", "/p"));

  await useProject.getState().open("/p");
  await vi.waitFor(() =>
    expect(useProject.getState().recent.map((r) => r.dir)).toEqual(["/p"]),
  );
  await useProject.getState().create("/new");
  await vi.waitFor(() =>
    expect(useProject.getState().recent.map((r) => r.dir)).toEqual([
      "/new",
      "/p",
    ]),
  );
});

test("a_failed_open_keeps_the_recent_list", async () => {
  vi.mocked(recentProjects).mockResolvedValue(recentOf("/gone"));
  await useProject.getState().refreshRecent();
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );

  // 목록에서 연 것은 chilla.toml이 없어도 만들지 묻지 않고 오류를 보인다.
  const opened = await useProject.getState().open("/gone", false);

  expect(opened).toBe(false);
  expect(useProject.getState().status).toBe("booting");
  expect(useProject.getState().missingDir).toBeNull();
  expect(useProject.getState().error).toBe("chilla.toml이 없습니다");
  expect(useProject.getState().recent.map((r) => r.dir)).toEqual(["/gone"]);
});

test("local_storage_is_not_used", async () => {
  const get = vi.spyOn(Storage.prototype, "getItem");
  const set = vi.spyOn(Storage.prototype, "setItem");
  vi.mocked(recentProjects).mockResolvedValue(recentOf("/p"));
  vi.mocked(openProject).mockResolvedValue(project("/p"));

  await useProject.getState().boot();
  await useProject.getState().open("/p");

  expect(get).not.toHaveBeenCalled();
  expect(set).not.toHaveBeenCalled();
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

test("chilla.toml이 없으면 missing이고 create로 만든다", async () => {
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );
  vi.mocked(createProject).mockResolvedValue(project("/new", "new"));

  const opened = await useProject.getState().open("/new");

  expect(opened).toBe(false);
  expect(useProject.getState().status).toBe("missing");
  expect(useProject.getState().missingDir).toBe("/new");
  // 오류는 만들기가 실패했을 때만 보인다.
  expect(useProject.getState().error).toBeNull();

  const created = await useProject.getState().create("/new");

  expect(created).toBe(true);
  expect(createProject).toHaveBeenCalledWith("/new");
  expect(useProject.getState().status).toBe("ready");
  expect(useProject.getState().project?.name).toBe("new");
  expect(useProject.getState().error).toBeNull();
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

test("dismissMissing_returns_to_welcome", async () => {
  vi.mocked(openProject).mockRejectedValue(
    new CommandError("project_not_found", "chilla.toml이 없습니다"),
  );
  await useProject.getState().open("/new");

  useProject.getState().dismissMissing();

  expect(useProject.getState().status).toBe("none");
  expect(useProject.getState().missingDir).toBeNull();
  expect(createProject).not.toHaveBeenCalled();
});
