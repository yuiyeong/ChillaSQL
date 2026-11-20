import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import { describeTables } from "../../shared/api/commands";
import type { EditTable, ResultColumn } from "../../shared/api/types";
import { deferred } from "../../test/deferred";
import { useEditTableCache, useEditTables } from "./editTargetStore";

function table(oid: number, name: string): EditTable {
  return {
    oid,
    qualifiedName: `public.${name}`,
    name,
    kind: "table",
    columns: [
      {
        number: 1,
        name: "id",
        quotedName: "id",
        primaryKey: true,
        updatable: true,
      },
    ],
  };
}

const users = table(100, "users");
const orders = table(200, "orders");

function column(name: string, tableOid: number): ResultColumn {
  return {
    name,
    typeOid: 23,
    typeModifier: -1,
    tableOid,
    columnNumber: tableOid === 0 ? 0 : 1,
  };
}

function tablesOf(connection = "local") {
  return useEditTableCache.getState().tables[connection];
}

beforeEach(() => {
  useEditTableCache.getState().reset();
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 지금 시각(`Date.now`)을 정한다. 묻는 때가 이 값으로 남는다. */
function setNow(ms: number) {
  vi.spyOn(Date, "now").mockReturnValue(ms);
}

test("asks_only_unknown_oids", async () => {
  vi.mocked(describeTables).mockResolvedValueOnce([users]);
  await useEditTableCache.getState().ensure("local", [100], 0);

  vi.mocked(describeTables).mockResolvedValueOnce([orders]);
  await useEditTableCache.getState().ensure("local", [100, 200], 0);

  expect(describeTables).toHaveBeenCalledTimes(2);
  expect(describeTables).toHaveBeenLastCalledWith("local", [200]);
  expect(tablesOf()).toEqual({ 100: users, 200: orders });
});

test("an_oid_without_an_answer_is_a_gone_table", async () => {
  vi.mocked(describeTables).mockResolvedValueOnce([]);
  await useEditTableCache.getState().ensure("local", [100], 0);

  expect(tablesOf()).toEqual({ 100: null });
  await useEditTableCache.getState().ensure("local", [100], 0);
  expect(describeTables).toHaveBeenCalledTimes(1);
});

test("does_not_ask_twice_while_pending", async () => {
  const answer = deferred<EditTable[]>();
  vi.mocked(describeTables).mockReturnValueOnce(answer.promise);

  const first = useEditTableCache.getState().ensure("local", [100], 0);
  await useEditTableCache.getState().ensure("local", [100], 0);
  expect(describeTables).toHaveBeenCalledTimes(1);

  answer.resolve([users]);
  await first;
  expect(tablesOf()).toEqual({ 100: users });
});

test("failure_is_ignored", async () => {
  vi.mocked(describeTables).mockRejectedValueOnce(new Error("boom"));
  await expect(
    useEditTableCache.getState().ensure("local", [100], 0),
  ).resolves.toBeUndefined();
  expect(tablesOf()).toBeUndefined();

  vi.mocked(describeTables).mockResolvedValueOnce([users]);
  await useEditTableCache.getState().ensure("local", [100], 0);
  expect(tablesOf()).toEqual({ 100: users });
});

test("forget_discards_an_answer_in_flight", async () => {
  const answer = deferred<EditTable[]>();
  vi.mocked(describeTables).mockReturnValueOnce(answer.promise);
  const asking = useEditTableCache.getState().ensure("local", [100], 0);

  useEditTableCache.getState().forget("local");
  answer.resolve([users]);
  await asking;

  expect(tablesOf()).toBeUndefined();
  vi.mocked(describeTables).mockResolvedValueOnce([users]);
  await useEditTableCache.getState().ensure("local", [100], 0);
  expect(describeTables).toHaveBeenCalledTimes(2);
});

test("reset_drops_every_connection_and_late_answers", async () => {
  const answer = deferred<EditTable[]>();
  vi.mocked(describeTables).mockReturnValueOnce(answer.promise);
  const asking = useEditTableCache.getState().ensure("local", [100], 0);

  useEditTableCache.getState().reset();
  answer.resolve([users]);
  await asking;

  expect(useEditTableCache.getState().tables).toEqual({});
});

test("hook_asks_and_waits_for_every_table_of_the_result", async () => {
  const answer = deferred<EditTable[]>();
  vi.mocked(describeTables).mockReturnValueOnce(answer.promise);
  const columns = [column("id", 100), column("n", 0), column("o", 200)];

  const { result } = renderHook(() => useEditTables("local", columns, 0));

  expect(result.current).toBeUndefined();
  expect(describeTables).toHaveBeenCalledWith("local", [100, 200]);

  // 200은 답에 없어 없어진 테이블이다. 아는 테이블만 돌려준다.
  await act(async () => answer.resolve([users]));
  expect(result.current).toEqual([users]);
});

test("hook_does_not_ask_without_table_columns_or_connection", () => {
  const { result } = renderHook(() =>
    useEditTables("local", [column("n", 0)], 0),
  );
  renderHook(() => useEditTables(null, [column("id", 100)], 0));

  expect(result.current).toEqual([]);
  expect(describeTables).not.toHaveBeenCalled();
});

test("an_answer_asked_before_the_result_started_is_asked_again", async () => {
  setNow(1500);
  vi.mocked(describeTables).mockResolvedValueOnce([users]);
  await useEditTableCache.getState().ensure("local", [100], 1000);

  // 다음 결과는 1500에 물은 답을 쓰지 않는다(그 사이 이름이 바뀌었을 수 있다).
  setNow(2500);
  const renamed = {
    ...users,
    name: "members",
    qualifiedName: "public.members",
  };
  vi.mocked(describeTables).mockResolvedValueOnce([renamed]);
  await useEditTableCache.getState().ensure("local", [100], 2000);

  expect(describeTables).toHaveBeenCalledTimes(2);
  expect(tablesOf()).toEqual({ 100: renamed });
});

test("an_older_answer_arriving_late_does_not_replace_a_newer_one", async () => {
  setNow(1500);
  const older = deferred<EditTable[]>();
  vi.mocked(describeTables).mockReturnValueOnce(older.promise);
  const first = useEditTableCache.getState().ensure("local", [100], 1000);

  // 1500에 묻는 중인 답은 2000에 시작한 결과에 쓸 수 없으니 다시 묻는다.
  setNow(2500);
  const renamed = {
    ...users,
    name: "members",
    qualifiedName: "public.members",
  };
  vi.mocked(describeTables).mockResolvedValueOnce([renamed]);
  await useEditTableCache.getState().ensure("local", [100], 2000);
  expect(describeTables).toHaveBeenCalledTimes(2);

  older.resolve([users]);
  await first;
  expect(tablesOf()).toEqual({ 100: renamed });
});

test("hook_asks_again_for_a_later_result_with_the_same_tables", async () => {
  const columns = [column("id", 100)];
  setNow(1500);
  vi.mocked(describeTables).mockResolvedValueOnce([users]);
  const { result, rerender } = renderHook(
    ({ startedAt }) => useEditTables("local", columns, startedAt),
    { initialProps: { startedAt: 1000 } },
  );
  await act(async () => {});
  expect(result.current).toEqual([users]);

  setNow(2500);
  const answer = deferred<EditTable[]>();
  vi.mocked(describeTables).mockReturnValueOnce(answer.promise);
  rerender({ startedAt: 2000 });

  // 새 결과는 지난 결과의 답으로 편집할 수 있다고 정하지 않는다.
  expect(result.current).toBeUndefined();
  expect(describeTables).toHaveBeenCalledTimes(2);
  const renamed = {
    ...users,
    name: "members",
    qualifiedName: "public.members",
  };
  await act(async () => answer.resolve([renamed]));
  expect(result.current).toEqual([renamed]);
});

test("hook_reuses_the_answer_for_the_same_result", async () => {
  const columns = [column("id", 100)];
  setNow(1500);
  vi.mocked(describeTables).mockResolvedValueOnce([users]);
  const first = renderHook(() => useEditTables("local", columns, 1000));
  await act(async () => {});
  first.unmount();

  // 탭을 바꿨다 돌아와 같은 결과를 다시 그리면 묻지 않고 바로 안다.
  setNow(9000);
  const { result } = renderHook(() => useEditTables("local", columns, 1000));
  expect(result.current).toEqual([users]);
  expect(describeTables).toHaveBeenCalledTimes(1);
});
