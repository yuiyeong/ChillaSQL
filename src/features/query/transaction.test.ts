import { describe, expect, it } from "vitest";
import { emptyResult, type RunState } from "./runReducer";
import { canEndTransaction, nextTx } from "./transaction";

describe("nextTx", () => {
  it("counts completed statements while the transaction stays open", () => {
    const opened = nextTx(null, "in_transaction", "completed", "manual", 100);
    expect(opened).toEqual({ status: "open", statements: 1, openedAt: 100 });
    expect(
      nextTx(opened, "in_transaction", "completed", "manual", 200),
    ).toEqual({ status: "open", statements: 2, openedAt: 100 });
  });

  it("does not count the BEGIN that opened it in Auto mode", () => {
    expect(nextTx(null, "in_transaction", "completed", "auto", 100)).toEqual({
      status: "open",
      statements: 0,
      openedAt: 100,
    });
  });

  it("counts statements after the BEGIN in Auto mode", () => {
    const open = { status: "open", statements: 0, openedAt: 100 } as const;
    expect(nextTx(open, "in_transaction", "completed", "auto", 200)).toEqual({
      status: "open",
      statements: 1,
      openedAt: 100,
    });
  });

  it("keeps the count when the transaction fails", () => {
    const open = { status: "open", statements: 2, openedAt: 100 } as const;
    expect(nextTx(open, "failed", "failed", "manual", 300)).toEqual({
      status: "failed",
      statements: 2,
      openedAt: 100,
    });
  });

  it("does not count a cancelled or expired statement", () => {
    const open = { status: "open", statements: 2, openedAt: 100 } as const;
    expect(nextTx(open, "in_transaction", "expired", "manual", 300)).toEqual(
      open,
    );
    expect(nextTx(open, "failed", "cancelled", "manual", 300)).toEqual({
      status: "failed",
      statements: 2,
      openedAt: 100,
    });
  });

  it("opens a failed transaction when the first Manual statement fails", () => {
    expect(nextTx(null, "failed", "failed", "manual", 100)).toEqual({
      status: "failed",
      statements: 0,
      openedAt: 100,
    });
  });

  it("clears on idle or a lost connection", () => {
    const open = { status: "open", statements: 2, openedAt: 100 } as const;
    expect(nextTx(open, "idle", "completed", "manual", 300)).toBeNull();
    expect(nextTx(open, null, "connection_lost", "manual", 300)).toBeNull();
  });
});

describe("canEndTransaction", () => {
  const result = emptyResult("SELECT 1", { line: 1, column: 1 }, 0);
  const running = (fetch: "none" | "ready" | "fetching"): RunState => ({
    status: "running",
    result: { ...result, fetch },
  });

  it("allows it when the tab is not reading a result", () => {
    expect(canEndTransaction(undefined)).toBe(true);
    expect(canEndTransaction({ status: "idle" })).toBe(true);
    expect(
      canEndTransaction({
        status: "finished",
        result,
        outcome: { outcome: "completed", rows: 0 },
      }),
    ).toBe(true);
    expect(
      canEndTransaction({
        status: "rejected",
        rejection: { title: "x", detail: null },
      }),
    ).toBe(true);
    expect(canEndTransaction(running("ready"))).toBe(true);
  });

  it("forbids it while connecting or reading", () => {
    expect(canEndTransaction({ status: "connecting" })).toBe(false);
    expect(canEndTransaction(running("none"))).toBe(false);
    expect(canEndTransaction(running("fetching"))).toBe(false);
  });
});
