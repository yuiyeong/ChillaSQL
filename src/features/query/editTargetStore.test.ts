import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

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

test("asks_only_unknown_oids", async () => {
  vi.mocked(describeTables).mockResolvedValueOnce([users]);
  await useEditTableCache.getState().ensure("local", [100]);

  vi.mocked(describeTables).mockResolvedValueOnce([orders]);
  await useEditTableCache.getState().ensure("local", [100, 200]);

  expect(describeTables).toHaveBeenCalledTimes(2);
  expect(describeTables).toHaveBeenLastCalledWith("local", [200]);
  expect(tablesOf()).toEqual({ 100: users, 200: orders });
});

test("an_oid_without_an_answer_is_a_gone_table", async () => {
  vi.mocked(describeTables).mockResolvedValueOnce([]);
  await useEditTableCache.getState().ensure("local", [100]);

  expect(tablesOf()).toEqual({ 100: null });
  await useEditTableCache.getState().ensure("local", [100]);
  expect(describeTables).toHaveBeenCalledTimes(1);
});

test("does_not_ask_twice_while_pending", async () => {
  const answer = deferred<EditTable[]>();
  vi.mocked(describeTables).mockReturnValueOnce(answer.promise);

  const first = useEditTableCache.getState().ensure("local", [100]);
  await useEditTableCache.getState().ensure("local", [100]);
  expect(describeTables).toHaveBeenCalledTimes(1);

  answer.resolve([users]);
  await first;
  expect(tablesOf()).toEqual({ 100: users });
});

test("failure_is_ignored", async () => {
  vi.mocked(describeTables).mockRejectedValueOnce(new Error("boom"));
  await expect(
    useEditTableCache.getState().ensure("local", [100]),
  ).resolves.toBeUndefined();
  expect(tablesOf()).toBeUndefined();

  vi.mocked(describeTables).mockResolvedValueOnce([users]);
  await useEditTableCache.getState().ensure("local", [100]);
  expect(tablesOf()).toEqual({ 100: users });
});

test("forget_discards_an_answer_in_flight", async () => {
  const answer = deferred<EditTable[]>();
  vi.mocked(describeTables).mockReturnValueOnce(answer.promise);
  const asking = useEditTableCache.getState().ensure("local", [100]);

  useEditTableCache.getState().forget("local");
  answer.resolve([users]);
  await asking;

  expect(tablesOf()).toBeUndefined();
  vi.mocked(describeTables).mockResolvedValueOnce([users]);
  await useEditTableCache.getState().ensure("local", [100]);
  expect(describeTables).toHaveBeenCalledTimes(2);
});

test("reset_drops_every_connection_and_late_answers", async () => {
  const answer = deferred<EditTable[]>();
  vi.mocked(describeTables).mockReturnValueOnce(answer.promise);
  const asking = useEditTableCache.getState().ensure("local", [100]);

  useEditTableCache.getState().reset();
  answer.resolve([users]);
  await asking;

  expect(useEditTableCache.getState().tables).toEqual({});
});

test("hook_asks_and_waits_for_every_table_of_the_result", async () => {
  const answer = deferred<EditTable[]>();
  vi.mocked(describeTables).mockReturnValueOnce(answer.promise);
  const columns = [column("id", 100), column("n", 0), column("o", 200)];

  const { result } = renderHook(() => useEditTables("local", columns));

  expect(result.current).toBeUndefined();
  expect(describeTables).toHaveBeenCalledWith("local", [100, 200]);

  // 200은 답에 없어 없어진 테이블이다. 아는 테이블만 돌려준다.
  await act(async () => answer.resolve([users]));
  expect(result.current).toEqual([users]);
});

test("hook_does_not_ask_without_table_columns_or_connection", () => {
  const { result } = renderHook(() => useEditTables("local", [column("n", 0)]));
  renderHook(() => useEditTables(null, [column("id", 100)]));

  expect(result.current).toEqual([]);
  expect(describeTables).not.toHaveBeenCalled();
});
