import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import { recordQuery, searchHistory } from "../../shared/api/commands";
import { CommandError } from "../../shared/api/errors";
import type { HistoryEntry } from "../../shared/api/types";
import { deferred } from "../../test/deferred";
import { openProjectWith } from "../../test/fixtures";
import { useHistory } from "./historyStore";

function entry(id: number, sql = `SELECT ${id}`): HistoryEntry {
  return {
    id,
    connection: "local",
    sql,
    executedAt: 1_000 + id,
    elapsedMicros: 5,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  useHistory.getState().reset();
  useHistory.setState({ open: false });
  openProjectWith();
});

afterEach(() => {
  useHistory.getState().reset();
  vi.useRealTimers();
});

test("search_waits_150ms", async () => {
  vi.mocked(searchHistory).mockResolvedValue([]);

  useHistory.getState().setQuery("users");
  await vi.advanceTimersByTimeAsync(149);
  expect(searchHistory).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  expect(searchHistory).toHaveBeenCalledTimes(1);
  expect(searchHistory).toHaveBeenCalledWith("/p", "users");
});

test("typing_again_restarts_the_wait", async () => {
  vi.mocked(searchHistory).mockResolvedValue([]);

  useHistory.getState().setQuery("u");
  await vi.advanceTimersByTimeAsync(100);
  useHistory.getState().setQuery("us");
  await vi.advanceTimersByTimeAsync(100);
  expect(searchHistory).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(50);

  expect(searchHistory).toHaveBeenCalledTimes(1);
  expect(searchHistory).toHaveBeenCalledWith("/p", "us");
});

test("a_stale_answer_is_dropped", async () => {
  const first = deferred<HistoryEntry[]>();
  const second = deferred<HistoryEntry[]>();
  vi.mocked(searchHistory)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  const a = useHistory.getState().load();
  const b = useHistory.getState().load();
  second.resolve([entry(2)]);
  await b;
  first.resolve([entry(1)]);
  await a;

  expect(useHistory.getState().entries).toEqual([entry(2)]);
  expect(useHistory.getState().status).toBe("ready");
});

test("selects_the_first_entry_after_load", async () => {
  vi.mocked(searchHistory).mockResolvedValue([entry(2), entry(1)]);
  await useHistory.getState().load();
  expect(useHistory.getState().selected).toBe(0);

  // 고른 항목이 새 목록에 없으면 처음 항목이다.
  useHistory.getState().select(1);
  vi.mocked(searchHistory).mockResolvedValue([entry(3), entry(2)]);
  await useHistory.getState().load();

  expect(useHistory.getState().selected).toBe(0);
});

test("reload_keeps_the_selected_entry_by_id", async () => {
  vi.mocked(searchHistory).mockResolvedValue([entry(2), entry(1)]);
  await useHistory.getState().load();
  useHistory.getState().select(1);

  // 새 기록이 앞에 붙어 index가 밀려도 같은 항목이 골라져 있다.
  vi.mocked(searchHistory).mockResolvedValue([entry(3), entry(2), entry(1)]);
  await useHistory.getState().load();

  expect(useHistory.getState().selected).toBe(2);
});

test("an_empty_list_selects_nothing", async () => {
  vi.mocked(searchHistory).mockResolvedValue([]);
  await useHistory.getState().load();

  expect(useHistory.getState().selected).toBeNull();
  useHistory.getState().move(1);
  expect(useHistory.getState().selected).toBeNull();
});

test("move_stops_at_the_ends", async () => {
  vi.mocked(searchHistory).mockResolvedValue([entry(3), entry(2), entry(1)]);
  await useHistory.getState().load();

  useHistory.getState().move(-1);
  expect(useHistory.getState().selected).toBe(0);
  useHistory.getState().move(1);
  useHistory.getState().move(1);
  useHistory.getState().move(1);
  expect(useHistory.getState().selected).toBe(2);
});

test("load_failure_keeps_the_message", async () => {
  vi.mocked(searchHistory).mockRejectedValue(
    new CommandError("store_unavailable", "no store"),
  );

  await useHistory.getState().load();

  const { status, error, entries } = useHistory.getState();
  expect(status).toBe("failed");
  expect(error).not.toBeNull();
  expect(entries).toEqual([]);
});

test("load_without_a_project_does_nothing", async () => {
  useHistory.getState().reset();
  const { useProject } = await import("../project/projectStore");
  useProject.setState(useProject.getInitialState(), true);

  await useHistory.getState().load();

  expect(searchHistory).not.toHaveBeenCalled();
});

test("record_failure_is_ignored", async () => {
  vi.mocked(recordQuery).mockRejectedValue(
    new CommandError("store_unavailable", "no store"),
  );
  useHistory.setState({ open: true });

  await expect(
    useHistory.getState().record("/p", {
      connection: "local",
      sql: "SELECT 1",
      executedAt: 1,
      elapsedMicros: 2,
    }),
  ).resolves.toBeUndefined();

  expect(searchHistory).not.toHaveBeenCalled();
});

test("record_reloads_only_while_the_view_is_open", async () => {
  vi.mocked(recordQuery).mockResolvedValue();
  vi.mocked(searchHistory).mockResolvedValue([entry(1)]);
  const row = {
    connection: "local",
    sql: "SELECT 1",
    executedAt: 1,
    elapsedMicros: 2,
  };

  await useHistory.getState().record("/p", row);
  expect(recordQuery).toHaveBeenCalledWith("/p", row);
  await vi.advanceTimersByTimeAsync(200);
  expect(searchHistory).not.toHaveBeenCalled();

  useHistory.setState({ open: true });
  await useHistory.getState().record("/p", row);
  await vi.advanceTimersByTimeAsync(200);
  expect(searchHistory).toHaveBeenCalledTimes(1);
});

test("a_burst_of_records_reloads_once", async () => {
  vi.mocked(recordQuery).mockResolvedValue();
  vi.mocked(searchHistory).mockResolvedValue([entry(1)]);
  useHistory.setState({ open: true });
  const row = {
    connection: "local",
    sql: "SELECT 1",
    executedAt: 1,
    elapsedMicros: 2,
  };

  for (let i = 0; i < 5; i++) {
    await useHistory.getState().record("/p", row);
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(searchHistory).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(150);

  expect(searchHistory).toHaveBeenCalledTimes(1);
});

test("a_record_reload_keeps_the_selected_entry", async () => {
  vi.mocked(recordQuery).mockResolvedValue();
  vi.mocked(searchHistory).mockResolvedValue([entry(2), entry(1)]);
  await useHistory.getState().load();
  useHistory.setState({ open: true });
  useHistory.getState().select(1);

  vi.mocked(searchHistory).mockResolvedValue([entry(3), entry(2), entry(1)]);
  await useHistory.getState().record("/p", {
    connection: "local",
    sql: "SELECT 3",
    executedAt: 3,
    elapsedMicros: 2,
  });
  await vi.advanceTimersByTimeAsync(200);

  expect(useHistory.getState().selected).toBe(2);
});

test("record_for_another_project_does_nothing", async () => {
  await useHistory.getState().record("/other", {
    connection: "local",
    sql: "SELECT 1",
    executedAt: 1,
    elapsedMicros: 2,
  });
  await useHistory.getState().record(null, {
    connection: "local",
    sql: "SELECT 1",
    executedAt: 1,
    elapsedMicros: 2,
  });

  expect(recordQuery).not.toHaveBeenCalled();
});

test("record_without_a_project_does_nothing", async () => {
  const { useProject } = await import("../project/projectStore");
  useProject.setState(useProject.getInitialState(), true);

  await useHistory.getState().record("/p", {
    connection: "local",
    sql: "SELECT 1",
    executedAt: 1,
    elapsedMicros: 2,
  });

  expect(recordQuery).not.toHaveBeenCalled();
});

test("reset_drops_a_pending_search_and_a_late_answer", async () => {
  const late = deferred<HistoryEntry[]>();
  vi.mocked(searchHistory).mockReturnValue(late.promise);
  const loading = useHistory.getState().load();
  useHistory.getState().setQuery("x");

  useHistory.getState().reset();
  late.resolve([entry(1)]);
  await loading;
  await vi.advanceTimersByTimeAsync(500);

  expect(useHistory.getState().entries).toEqual([]);
  expect(useHistory.getState().query).toBe("");
  expect(useHistory.getState().status).toBe("idle");
  expect(searchHistory).toHaveBeenCalledTimes(1);
});
