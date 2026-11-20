import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import {
  closeCatalog,
  loadCatalog,
  loadTableDetails,
} from "../../shared/api/commands";
import { CommandError } from "../../shared/api/errors";
import type { Catalog, TableDetails } from "../../shared/api/types";
import { deferred } from "../../test/deferred";
import { catalogFixture, relation } from "../../test/fixtures";
import { useTypes } from "../query/typesStore";
import { nodeKey, useSchema } from "./schemaStore";

const details: TableDetails = {
  indexes: [
    {
      name: "users_pkey",
      definition:
        "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
      unique: true,
      primary: true,
    },
  ],
  constraints: [],
};

function entry(connection = "local") {
  return useSchema.getState().entries[connection];
}

const integer = { oid: 23, modifier: -1, name: "integer", category: "N" };

/** 두 접속이 type을 cache에 갖게 한다. */
function seedTypes() {
  useTypes.setState({
    types: { local: { "23:-1": integer }, other: { "23:-1": integer } },
  });
}

beforeEach(() => {
  useSchema.getState().reset();
  useTypes.getState().reset();
  vi.resetAllMocks();
});

test("ensure_loads_once", async () => {
  vi.mocked(loadCatalog).mockResolvedValue(catalogFixture());

  await Promise.all([
    useSchema.getState().ensure("local"),
    useSchema.getState().ensure("local"),
  ]);
  await useSchema.getState().ensure("local");

  expect(loadCatalog).toHaveBeenCalledTimes(1);
  expect(entry()?.status).toBe("ready");
  expect(entry()?.catalog).toEqual(catalogFixture());
});

test("ensure_retries_a_failed_catalog", async () => {
  vi.mocked(loadCatalog).mockRejectedValueOnce(
    new CommandError("catalog_failed", "Could not read the schema: boom", null),
  );
  await useSchema.getState().ensure("local");
  expect(entry()?.status).toBe("failed");
  expect(entry()?.error).toBe("Could not read the schema: boom");

  vi.mocked(loadCatalog).mockResolvedValueOnce(catalogFixture());
  await useSchema.getState().ensure("local");
  expect(loadCatalog).toHaveBeenCalledTimes(2);
  expect(entry()?.status).toBe("ready");
  expect(entry()?.error).toBeNull();
});

test("first_load_expands_the_default_schema_and_its_tables", async () => {
  vi.mocked(loadCatalog).mockResolvedValue(catalogFixture());
  await useSchema.getState().ensure("local");
  expect([...(entry()?.expanded ?? [])]).toEqual([
    nodeKey(["public"]),
    nodeKey(["public", "tables"]),
  ]);
});

test("toggle_flips_a_node", async () => {
  vi.mocked(loadCatalog).mockResolvedValue(catalogFixture());
  await useSchema.getState().ensure("local");
  const key = nodeKey(["billing"]);
  useSchema.getState().toggle("local", key);
  expect(entry()?.expanded.has(key)).toBe(true);
  useSchema.getState().toggle("local", key);
  expect(entry()?.expanded.has(key)).toBe(false);
});

test("refresh_keeps_the_old_catalog_while_loading", async () => {
  vi.mocked(loadCatalog).mockResolvedValueOnce(catalogFixture());
  await useSchema.getState().ensure("local");
  const pending = deferred<Catalog>();
  vi.mocked(loadCatalog).mockReturnValueOnce(pending.promise);

  const refreshing = useSchema.getState().refresh("local");
  expect(entry()?.status).toBe("loading");
  expect(entry()?.catalog).toEqual(catalogFixture());

  pending.resolve(catalogFixture({ schemas: ["public"] }));
  await refreshing;
  expect(entry()?.catalog?.schemas).toEqual(["public"]);
});

test("refresh_reloads_expanded_details_by_name", async () => {
  vi.mocked(loadCatalog).mockResolvedValueOnce(catalogFixture());
  vi.mocked(loadTableDetails).mockResolvedValue(details);
  await useSchema.getState().ensure("local");
  useSchema
    .getState()
    .toggle("local", nodeKey(["public", "tables", "users", "indexes"]));
  await useSchema.getState().loadDetails("local", 1);
  expect(entry()?.details[1]?.status).toBe("ready");

  // 새로고침 뒤 users는 OID 11이다. orders는 접혀 있다.
  const reloaded = catalogFixture({
    relations: [
      relation(12, "public", "orders"),
      relation(11, "public", "users", [["id", "bigint", true]]),
    ],
  });
  vi.mocked(loadCatalog).mockResolvedValueOnce(reloaded);
  vi.mocked(loadTableDetails).mockClear();
  await useSchema.getState().refresh("local");

  expect(loadTableDetails).toHaveBeenCalledTimes(1);
  expect(loadTableDetails).toHaveBeenCalledWith("local", 11);
  expect(entry()?.details[1]).toBeUndefined();
  await vi.waitFor(() => expect(entry()?.details[11]?.status).toBe("ready"));
});

test("load_details_once_and_keeps_failures", async () => {
  vi.mocked(loadCatalog).mockResolvedValue(catalogFixture());
  await useSchema.getState().ensure("local");
  vi.mocked(loadTableDetails).mockRejectedValueOnce(
    new CommandError("catalog_failed", "no", null),
  );
  await useSchema.getState().loadDetails("local", 1);
  expect(entry()?.details[1]).toEqual({
    status: "failed",
    details: null,
    error: "no",
  });

  vi.mocked(loadTableDetails).mockResolvedValue(details);
  await useSchema.getState().loadDetails("local", 1);
  await useSchema.getState().loadDetails("local", 1);
  expect(loadTableDetails).toHaveBeenCalledTimes(2);
  expect(entry()?.details[1]).toEqual({
    status: "ready",
    details,
    error: null,
  });
});

test("a_late_response_does_not_overwrite_a_newer_refresh", async () => {
  const first = deferred<Catalog>();
  vi.mocked(loadCatalog)
    .mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(catalogFixture({ schemas: ["second"] }));

  const ensuring = useSchema.getState().ensure("local");
  await useSchema.getState().refresh("local");
  first.resolve(catalogFixture({ schemas: ["first"] }));
  await ensuring;

  expect(entry()?.catalog?.schemas).toEqual(["second"]);
  expect(entry()?.status).toBe("ready");
});

test("forget_closes_and_drops_the_entry", async () => {
  vi.mocked(loadCatalog).mockResolvedValue(catalogFixture());
  await useSchema.getState().ensure("local");

  await useSchema.getState().forget("local");

  expect(closeCatalog).toHaveBeenCalledWith("local");
  expect(entry()).toBeUndefined();
});

test("forget_drops_the_cached_types_of_that_connection", async () => {
  vi.mocked(loadCatalog).mockResolvedValue(catalogFixture());
  await useSchema.getState().ensure("local");
  seedTypes();

  await useSchema.getState().forget("local");

  expect(useTypes.getState().types).toEqual({ other: { "23:-1": integer } });
});

test("refresh_drops_the_cached_types_of_that_connection", async () => {
  vi.mocked(loadCatalog).mockResolvedValue(catalogFixture());
  await useSchema.getState().ensure("local");
  seedTypes();

  await useSchema.getState().refresh("local");

  expect(useTypes.getState().types).toEqual({ other: { "23:-1": integer } });
});

test("a_response_after_forget_is_ignored", async () => {
  const pending = deferred<Catalog>();
  vi.mocked(loadCatalog).mockReturnValueOnce(pending.promise);
  const ensuring = useSchema.getState().ensure("local");

  await useSchema.getState().forget("local");
  pending.resolve(catalogFixture());
  await ensuring;

  expect(entry()).toBeUndefined();
});

test("a_close_failure_is_ignored", async () => {
  vi.mocked(closeCatalog).mockRejectedValueOnce(
    new CommandError("no_project", "Open a project first", null),
  );
  await expect(useSchema.getState().forget("local")).resolves.toBeUndefined();
});

test("expanding_a_details_group_loads_it", async () => {
  vi.mocked(loadCatalog).mockResolvedValue(catalogFixture());
  vi.mocked(loadTableDetails).mockResolvedValue(details);
  await useSchema.getState().ensure("local");

  useSchema.getState().toggle("local", nodeKey(["public", "tables", "users"]));
  expect(loadTableDetails).not.toHaveBeenCalled();
  useSchema
    .getState()
    .toggle("local", nodeKey(["public", "tables", "users", "indexes"]));
  expect(loadTableDetails).toHaveBeenCalledWith("local", 1);

  // 접을 때는 불러오지 않는다.
  useSchema
    .getState()
    .toggle("local", nodeKey(["public", "tables", "users", "indexes"]));
  expect(loadTableDetails).toHaveBeenCalledTimes(1);
});
