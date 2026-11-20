import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import { describeTypes } from "../../shared/api/commands";
import type { ResultColumn, TypeInfo } from "../../shared/api/types";
import { deferred } from "../../test/deferred";
import { typeKey, useTypes } from "./typesStore";

const integer: TypeInfo = {
  oid: 23,
  modifier: -1,
  name: "integer",
  category: "N",
};
const varchar: TypeInfo = {
  oid: 1043,
  modifier: 259,
  name: "character varying(255)",
  category: "S",
};

function column(name: string, info: TypeInfo): ResultColumn {
  return { name, typeOid: info.oid, typeModifier: info.modifier };
}

function typesOf(connection = "local") {
  return useTypes.getState().types[connection];
}

beforeEach(() => {
  useTypes.getState().reset();
  vi.resetAllMocks();
});

test("type_key_joins_oid_and_modifier", () => {
  expect(typeKey(23, -1)).toBe("23:-1");
});

test("asks_only_unknown_types", async () => {
  vi.mocked(describeTypes).mockResolvedValueOnce([integer]);
  await useTypes.getState().ensure("local", [column("id", integer)]);
  expect(typesOf()).toEqual({ "23:-1": integer });

  vi.mocked(describeTypes).mockResolvedValueOnce([varchar]);
  await useTypes
    .getState()
    .ensure("local", [
      column("id", integer),
      column("name", varchar),
      column("nick", varchar),
    ]);

  expect(describeTypes).toHaveBeenCalledTimes(2);
  expect(describeTypes).toHaveBeenLastCalledWith("local", [
    { oid: 1043, modifier: 259 },
  ]);
  expect(typesOf()).toEqual({ "23:-1": integer, "1043:259": varchar });

  await useTypes.getState().ensure("local", [column("id", integer)]);
  expect(describeTypes).toHaveBeenCalledTimes(2);
});

test("skips_columns_of_unknown_oid", async () => {
  await useTypes
    .getState()
    .ensure("local", [{ name: "x", typeOid: 0, typeModifier: -1 }]);

  expect(describeTypes).not.toHaveBeenCalled();
});

test("does_not_ask_twice_while_pending", async () => {
  const answer = deferred<TypeInfo[]>();
  vi.mocked(describeTypes).mockReturnValueOnce(answer.promise);

  const first = useTypes.getState().ensure("local", [column("id", integer)]);
  // 같은 type은 묻는 중이라 건너뛰고, 새 type만 묻는다.
  vi.mocked(describeTypes).mockResolvedValueOnce([varchar]);
  await useTypes
    .getState()
    .ensure("local", [column("id", integer), column("name", varchar)]);

  expect(describeTypes).toHaveBeenCalledTimes(2);
  expect(describeTypes).toHaveBeenLastCalledWith("local", [
    { oid: 1043, modifier: 259 },
  ]);

  answer.resolve([integer]);
  await first;
  expect(typesOf()).toEqual({ "23:-1": integer, "1043:259": varchar });
});

test("failure_is_ignored", async () => {
  vi.mocked(describeTypes).mockRejectedValueOnce(new Error("boom"));
  await expect(
    useTypes.getState().ensure("local", [column("id", integer)]),
  ).resolves.toBeUndefined();
  expect(typesOf()).toBeUndefined();

  // 실패한 type은 다음 결과가 다시 묻는다.
  vi.mocked(describeTypes).mockResolvedValueOnce([integer]);
  await useTypes.getState().ensure("local", [column("id", integer)]);
  expect(describeTypes).toHaveBeenCalledTimes(2);
  expect(typesOf()).toEqual({ "23:-1": integer });
});

test("forget_drops_the_connection", async () => {
  vi.mocked(describeTypes).mockResolvedValue([integer]);
  await useTypes.getState().ensure("local", [column("id", integer)]);
  await useTypes.getState().ensure("other", [column("id", integer)]);

  useTypes.getState().forget("local");

  expect(typesOf("local")).toBeUndefined();
  expect(typesOf("other")).toEqual({ "23:-1": integer });
});

test("forget_discards_an_answer_in_flight", async () => {
  const answer = deferred<TypeInfo[]>();
  vi.mocked(describeTypes).mockReturnValueOnce(answer.promise);
  const asking = useTypes.getState().ensure("local", [column("id", integer)]);

  useTypes.getState().forget("local");
  answer.resolve([integer]);
  await asking;

  expect(typesOf()).toBeUndefined();
  // 묻는 중이던 표시도 지워져 다시 묻는다.
  vi.mocked(describeTypes).mockResolvedValueOnce([integer]);
  await useTypes.getState().ensure("local", [column("id", integer)]);
  expect(describeTypes).toHaveBeenCalledTimes(2);
});

test("reset_drops_every_connection", async () => {
  vi.mocked(describeTypes).mockResolvedValue([integer]);
  await useTypes.getState().ensure("local", [column("id", integer)]);

  useTypes.getState().reset();

  expect(useTypes.getState().types).toEqual({});
});
