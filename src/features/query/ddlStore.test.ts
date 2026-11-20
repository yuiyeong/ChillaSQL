import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import { loadDdl } from "../../shared/api/commands";
import { CommandError } from "../../shared/api/errors";
import { deferred } from "../../test/deferred";
import { connection, openProjectWith, relation } from "../../test/fixtures";
import { resetStores } from "../../test/resetStores";
import { useTabs } from "../editor/tabsStore";
import { closeDdl, showDdl, useDdl } from "./ddlStore";

const users = relation(1, "public", "users");

function activeTab(connectionName: string | null = "local"): string {
  const id = useTabs.getState().newTab();
  useTabs.getState().setConnection(id, connectionName);
  return id;
}

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  openProjectWith([connection("local")]);
});

test("shows_loading_then_text", async () => {
  const id = activeTab();
  const answer = deferred<string>();
  vi.mocked(loadDdl).mockReturnValue(answer.promise);

  const done = showDdl(users);
  expect(useDdl.getState().views[id]).toEqual({
    name: "public.users",
    status: "loading",
  });
  expect(loadDdl).toHaveBeenCalledWith("local", 1);

  answer.resolve("CREATE TABLE public.users ();");
  await done;
  expect(useDdl.getState().views[id]).toEqual({
    name: "public.users",
    status: "ready",
    text: "CREATE TABLE public.users ();",
  });
});

test("failure_keeps_the_message", async () => {
  const id = activeTab();
  vi.mocked(loadDdl).mockRejectedValue(
    new CommandError("relation_gone", "gone"),
  );

  await showDdl(users);
  expect(useDdl.getState().views[id]).toEqual({
    name: "public.users",
    status: "failed",
    message: "The table or view no longer exists. Refresh the schema",
  });
});

test("a_stale_answer_is_dropped", async () => {
  const id = activeTab();
  const first = deferred<string>();
  const second = deferred<string>();
  vi.mocked(loadDdl)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  const one = showDdl(users);
  const two = showDdl(relation(2, "public", "orders"));
  second.resolve("orders ddl");
  await two;
  first.resolve("users ddl");
  await one;

  expect(useDdl.getState().views[id]).toEqual({
    name: "public.orders",
    status: "ready",
    text: "orders ddl",
  });
});

test("close_removes_it", async () => {
  const id = activeTab();
  vi.mocked(loadDdl).mockResolvedValue("x");
  await showDdl(users);

  closeDdl(id);
  expect(useDdl.getState().views[id]).toBeUndefined();
});

test("an_answer_after_close_is_dropped", async () => {
  const id = activeTab();
  const answer = deferred<string>();
  vi.mocked(loadDdl).mockReturnValue(answer.promise);

  const done = showDdl(users);
  closeDdl(id);
  answer.resolve("late");
  await done;

  expect(useDdl.getState().views[id]).toBeUndefined();
});

test("without_a_tab_or_connection_it_does_nothing", async () => {
  await showDdl(users);
  activeTab(null);
  await showDdl(users);

  expect(loadDdl).not.toHaveBeenCalled();
  expect(useDdl.getState().views).toEqual({});
});
