import { describe, expect, it } from "vitest";
import { emptyResult, type RunState } from "./runReducer";
import {
  canEndTransaction,
  formatClock,
  nextTx,
  statementsLabel,
  txAfterApply,
} from "./transaction";

/** Manual에서 두 문장을 실행한 열린 트랜잭션 */
const openTx = {
  status: "open",
  statements: 2,
  openedAt: 100,
  openedBy: "app",
} as const;

describe("nextTx", () => {
  it("counts completed statements while the transaction stays open", () => {
    const opened = nextTx(null, "in_transaction", "completed", "manual", 100);
    expect(opened).toEqual({
      status: "open",
      statements: 1,
      openedAt: 100,
      openedBy: "app",
    });
    expect(
      nextTx(opened, "in_transaction", "completed", "manual", 200),
    ).toEqual({
      status: "open",
      statements: 2,
      openedAt: 100,
      openedBy: "app",
    });
  });

  it("does not count the BEGIN that opened it in Auto mode", () => {
    expect(nextTx(null, "in_transaction", "completed", "auto", 100)).toEqual({
      status: "open",
      statements: 0,
      openedAt: 100,
      openedBy: "user",
    });
  });

  it("counts statements after the BEGIN in Auto mode", () => {
    const open = { ...openTx, statements: 0, openedBy: "user" } as const;
    expect(nextTx(open, "in_transaction", "completed", "auto", 200)).toEqual({
      ...open,
      statements: 1,
    });
  });

  it("keeps the count when the transaction fails", () => {
    expect(nextTx(openTx, "failed", "failed", "manual", 300)).toEqual({
      ...openTx,
      status: "failed",
    });
  });

  it("follows the status without counting when counts is false", () => {
    expect(
      nextTx(openTx, "in_transaction", "completed", "manual", 300, false),
    ).toBe(openTx);
    expect(
      nextTx(null, "in_transaction", "completed", "manual", 100, false),
    ).toEqual({
      status: "open",
      statements: 0,
      openedAt: 100,
      openedBy: "app",
    });
  });

  it("does not count a cancelled or expired statement", () => {
    expect(nextTx(openTx, "in_transaction", "expired", "manual", 300)).toBe(
      openTx,
    );
    // 트랜잭션 안에서 취소한 문장은 savepoint로 되돌려지고 트랜잭션은 열린 채다.
    expect(nextTx(openTx, "in_transaction", "cancelled", "manual", 300)).toBe(
      openTx,
    );
  });

  it("opens a failed transaction when the first Manual statement fails", () => {
    expect(nextTx(null, "failed", "failed", "manual", 100)).toEqual({
      status: "failed",
      statements: 0,
      openedAt: 100,
      openedBy: "app",
    });
  });

  it("keeps the transaction when a query that never started reports no state", () => {
    expect(nextTx(openTx, null, "cancelled", "manual", 300)).toBe(openTx);
    expect(nextTx(null, null, "cancelled", "manual", 300)).toBeNull();
  });

  it("clears on idle or a lost connection", () => {
    expect(nextTx(openTx, "idle", "completed", "manual", 300)).toBeNull();
    expect(nextTx(openTx, null, "connection_lost", "manual", 300)).toBeNull();
  });
});

describe("openedBy", () => {
  it("records whether the user's BEGIN or the app opened it", () => {
    const user = nextTx(null, "in_transaction", "completed", "auto", 100);
    expect(user?.openedBy).toBe("user");
    const app = nextTx(null, "failed", "failed", "manual", 100);
    expect(app?.openedBy).toBe("app");
    // 뒤의 실행이 다른 모드여도 연 쪽은 그대로다.
    expect(
      nextTx(user, "in_transaction", "completed", "manual", 200)?.openedBy,
    ).toBe("user");
  });
});

describe("statementsLabel", () => {
  it("says manual BEGIN only for a transaction the user's BEGIN opened", () => {
    expect(statementsLabel({ statements: 0, openedBy: "user" })).toBe(
      "manual BEGIN",
    );
    expect(statementsLabel({ statements: 0, openedBy: "app" })).toBe(
      "0 statements",
    );
    expect(statementsLabel({ statements: 1, openedBy: "app" })).toBe(
      "1 statement",
    );
    expect(statementsLabel({ statements: 2, openedBy: "user" })).toBe(
      "2 statements",
    );
  });
});

describe("canEndTransaction", () => {
  const result = emptyResult(
    { sql: "SELECT 1", from: 0, origin: { line: 1, column: 1 } },
    "run-0",
    0,
  );
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

describe("formatClock", () => {
  it("writes m:ss and h:mm:ss after an hour", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(999)).toBe("0:00");
    expect(formatClock(42_000)).toBe("0:42");
    expect(formatClock(192_000)).toBe("3:12");
    expect(formatClock(3_599_999)).toBe("59:59");
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });

  it("treats a clock that went backwards as zero", () => {
    expect(formatClock(-5_000)).toBe("0:00");
  });
});

describe("txAfterApply", () => {
  it("adds the applied statements to an open transaction", () => {
    expect(txAfterApply(openTx, "in_transaction", "auto", 500, 3)).toEqual({
      ...openTx,
      statements: 5,
    });
  });

  it("opens an app transaction in Manual outside a transaction", () => {
    expect(txAfterApply(null, "in_transaction", "manual", 500, 2)).toEqual({
      status: "open",
      statements: 2,
      openedAt: 500,
      openedBy: "app",
    });
  });

  it("a failed Apply in Manual outside a transaction opens it empty", () => {
    expect(txAfterApply(null, "in_transaction", "manual", 500, 0)).toEqual({
      status: "open",
      statements: 0,
      openedAt: 500,
      openedBy: "app",
    });
  });

  it("idle leaves no transaction", () => {
    expect(txAfterApply(null, "idle", "auto", 500, 2)).toBeNull();
    expect(txAfterApply(openTx, "idle", "auto", 500, 2)).toBeNull();
  });

  it("null keeps the previous transaction as it is", () => {
    expect(txAfterApply(openTx, null, "manual", 500, 0)).toBe(openTx);
    expect(txAfterApply(null, null, "manual", 500, 0)).toBeNull();
  });

  it("follows the status the server reports", () => {
    expect(txAfterApply(openTx, "failed", "manual", 500, 0)).toEqual({
      ...openTx,
      status: "failed",
    });
  });
});
