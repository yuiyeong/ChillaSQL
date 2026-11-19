import type { Outcome, TxMode, TxStatus } from "../../shared/api/types";
import { t, tc } from "../../shared/i18n/t";
import type { RunState } from "./runReducer";

/** 탭의 열린 트랜잭션. 트랜잭션 밖이면 없다. */
export interface TxInfo {
  status: "open" | "failed";
  /** 세는 규칙은 계획의 "문장 수" */
  statements: number;
  /** 트랜잭션을 연 실행의 startedAt */
  openedAt: number;
}

/**
 * 실행이 끝난 뒤의 트랜잭션. `tx`가 열린 채로 `completed`된 실행만 센다. 트랜잭션을 연 실행은
 * Manual이면 앱이 `BEGIN`을 붙인 사용자 문장이라 세고, Auto면 사용자가 쓴 `BEGIN`이라 세지 않는다.
 */
export function nextTx(
  previous: TxInfo | null,
  tx: TxStatus | null,
  outcome: Outcome["outcome"],
  mode: TxMode,
  startedAt: number,
): TxInfo | null {
  if (tx === null || tx === "idle") return null;
  const status = tx === "failed" ? "failed" : "open";
  const counted = tx === "in_transaction" && outcome === "completed";
  if (previous === null) {
    return {
      status,
      statements: counted && mode === "manual" ? 1 : 0,
      openedAt: startedAt,
    };
  }
  return {
    status,
    statements: previous.statements + (counted ? 1 : 0),
    openedAt: previous.openedAt,
  };
}

/** `2 statements`. 문장이 없으면 사용자가 직접 BEGIN한 트랜잭션이다(Auto 모드). */
export function statementsLabel(statements: number): string {
  return statements === 0
    ? t("tx.manualBegin")
    : tc("tx.statements", statements);
}

/** Commit, Rollback, 모드 전환이 가능한지(계획의 "가능한 때"). 쿼리를 읽는 동안은 먼저 Cancel해야 한다. */
export function canEndTransaction(run: RunState | undefined): boolean {
  switch (run?.status) {
    case "connecting":
      return false;
    case "running":
      return run.result.fetch === "ready";
    default:
      return true;
  }
}

/** 경과 시간 표시. `m:ss`, 한 시간이 넘으면 `h:mm:ss`. 시계가 거꾸로 갔으면 0이다. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = String(total % 60).padStart(2, "0");
  if (hours === 0) return `${minutes}:${seconds}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}
