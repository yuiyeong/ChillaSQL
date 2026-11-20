import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import { inspectStatement } from "../../shared/api/commands";
import type { Danger } from "../../shared/api/types";
import { answerDialog, textOf } from "../../test/dialogs";
import { setTabMode } from "../../test/fixtures";
import { resetStores } from "../../test/resetStores";
import { useDialogs } from "../../shared/ui/dialogs";
import type { RunRequest } from "../query/runReducer";
import { useRuns } from "../query/runsStore";
import { confirmDanger } from "./dangerPrompt";

const TAB = "t1";

function request(sql: string): RunRequest {
  return {
    connection: "staging",
    sql,
    from: 0,
    origin: { line: 1, column: 1 },
  };
}

const deleteAll: Danger = { kind: "delete_without_where", table: "sessions" };

beforeEach(async () => {
  await resetStores();
  vi.resetAllMocks();
  vi.mocked(inspectStatement).mockResolvedValue(null);
});

/** 위험으로 판정되는 문장을 확인하고, 뜬 dialog에 `id`로 답한 뒤 spec과 결과를 돌려준다. */
async function confirmWith(
  danger: Danger,
  id = "cancel",
  sql = "DELETE FROM sessions;",
) {
  vi.mocked(inspectStatement).mockResolvedValue(danger);
  const confirming = confirmDanger(TAB, request(sql));
  const spec = await answerDialog(id);
  return { spec, allowed: await confirming };
}

test("safe_statements_run_without_asking", async () => {
  await expect(confirmDanger(TAB, request("SELECT 1"))).resolves.toBe(true);

  expect(inspectStatement).toHaveBeenCalledWith("SELECT 1");
  expect(useDialogs.getState().current).toBeNull();
});

test("manual_mode_says_it_can_be_rolled_back", async () => {
  setTabMode(TAB, "manual");

  const { spec } = await confirmWith(deleteAll);

  expect(textOf(spec.title)).toBe("Run DELETE without WHERE?");
  expect(textOf(spec.body)).toBe(
    "This deletes every row in sessions on staging. You're inside an open transaction, so you can roll it back until you commit.",
  );
  expect(spec.sql).toBe("DELETE FROM sessions;");
  expect(spec.icon).toBe("warning");
  expect(spec.actions).toMatchObject([
    { id: "cancel", label: "Cancel" },
    { id: "run", label: "Run", variant: "danger" },
  ]);
});

test("auto_mode_says_it_cannot_be_undone", async () => {
  const { spec } = await confirmWith(deleteAll);

  expect(textOf(spec.body)).toBe(
    "This deletes every row in sessions on staging. Auto mode commits it immediately, and it can't be undone.",
  );
});

test("auto_with_an_open_transaction_says_it_can_be_rolled_back", async () => {
  useRuns.setState({
    transactions: {
      [TAB]: { status: "open", statements: 1, openedAt: 0, openedBy: "app" },
    },
  });

  const { spec } = await confirmWith(deleteAll);

  expect(textOf(spec.body)).toContain("You're inside an open transaction");
  expect(textOf(spec.body)).not.toContain("can't be undone");
});

test("update_names_the_table", async () => {
  const { spec } = await confirmWith({
    kind: "update_without_where",
    table: "users",
  });

  expect(textOf(spec.title)).toBe("Run UPDATE without WHERE?");
  expect(textOf(spec.body)).toMatch(
    /^This updates every row in users on staging\./,
  );
});

test("drop_title_uses_the_object_kind", async () => {
  const { spec } = await confirmWith({
    kind: "drop",
    object: "TABLE",
    names: ["a", "b.c"],
  });

  expect(textOf(spec.title)).toBe("Run DROP TABLE?");
  expect(textOf(spec.body)).toMatch(/^This drops a, b\.c on staging\./);
});

test("drop_owned_says_it_drops_what_the_roles_own", async () => {
  const { spec } = await confirmWith({
    kind: "drop",
    object: "OWNED",
    names: ["alice", "bob"],
  });

  expect(textOf(spec.title)).toBe("Run DROP OWNED?");
  expect(textOf(spec.body)).toMatch(
    /^This drops every object owned by alice, bob on staging\./,
  );
});

test("unknown_drop_kind_says_drop", async () => {
  const { spec } = await confirmWith({
    kind: "drop",
    object: "",
    names: ["x"],
  });

  expect(textOf(spec.title)).toBe("Run DROP?");
});

test("truncate_lists_the_tables", async () => {
  const { spec } = await confirmWith({
    kind: "truncate",
    tables: ["a", "b"],
  });

  expect(textOf(spec.title)).toBe("Run TRUNCATE?");
  expect(textOf(spec.body)).toMatch(
    /^This deletes every row in a, b on staging\./,
  );
});

test("cancel_returns_false", async () => {
  const { allowed } = await confirmWith(deleteAll, "cancel");

  expect(allowed).toBe(false);
});

test("run_returns_true", async () => {
  const { allowed } = await confirmWith(deleteAll, "run");

  expect(allowed).toBe(true);
});

test("an_inspection_error_runs_without_asking", async () => {
  vi.mocked(inspectStatement).mockRejectedValue(new Error("boom"));

  await expect(confirmDanger(TAB, request("DELETE FROM a"))).resolves.toBe(
    true,
  );

  expect(useDialogs.getState().current).toBeNull();
});
