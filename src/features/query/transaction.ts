import type { Outcome, TxMode, TxStatus } from "../../shared/api/types";
import type { MessageKey } from "../../shared/i18n/en";
import { formatCount, pluralKey, t } from "../../shared/i18n/t";
import type { RunState } from "./runReducer";

/** 탭의 열린 트랜잭션. 트랜잭션 밖이면 없다. */
export interface TxInfo {
  status: "open" | "failed";
  /** 세는 규칙은 계획의 "문장 수" */
  statements: number;
  /** 트랜잭션을 연 실행의 startedAt */
  openedAt: number;
  /** Auto에서 사용자가 쓴 `BEGIN`이 열었으면 `user`, Manual에서 앱이 `BEGIN`을 붙여 열었으면 `app` */
  openedBy: "user" | "app";
}

/** 문장 수 문구가 보는 값 */
export type TxCount = Pick<TxInfo, "statements" | "openedBy">;

/** 문장 수를 쓰는 복수형 문구 */
export type StatementsKey =
  | "tx.statements"
  | "dialog.tx.question"
  | "dialog.tx.questionIn"
  | "tx.lostBody";

/**
 * 실행이 끝난 뒤의 트랜잭션. `tx`가 열린 채로 `completed`된 실행만 센다. 트랜잭션을 연 실행은
 * Manual이면 앱이 `BEGIN`을 붙인 사용자 문장이라 세고, Auto면 사용자가 쓴 `BEGIN`이라 세지 않는다.
 * `tx`가 null이면 서버에 보내지 않은 쿼리라 앞의 트랜잭션을 그대로 두고, `connection_lost`일 때만
 * 트랜잭션이 없어진 것으로 본다. `counts`가 false면 상태만 바꾸고 세지 않는다.
 */
export function nextTx(
  previous: TxInfo | null,
  tx: TxStatus | null,
  outcome: Outcome["outcome"],
  mode: TxMode,
  startedAt: number,
  counts = true,
): TxInfo | null {
  if (tx === null) return outcome === "connection_lost" ? null : previous;
  const counted = counts && tx === "in_transaction" && outcome === "completed";
  const count = counted && (previous !== null || mode === "manual") ? 1 : 0;
  return advanceTx(previous, tx, mode, startedAt, count);
}

/**
 * Apply 뒤. Manual이나 트랜잭션 안이면 문장 수에 count를 더한다(실패한 Apply는 0). Auto의 트랜잭션
 * 밖이면 Apply가 Commit까지 하므로 `idle`이 온다. Manual의 트랜잭션 밖이면 앱이 연 트랜잭션이 남는다.
 * `tx`가 null이면(보내지 않았음) 앞 트랜잭션을 그대로 둔다.
 */
export function txAfterApply(
  previous: TxInfo | null,
  tx: TxStatus | null,
  mode: TxMode,
  startedAt: number,
  count: number,
): TxInfo | null {
  if (tx === null) return previous;
  return advanceTx(previous, tx, mode, startedAt, count);
}

/** 서버가 알려 준 `tx`로 상태를 바꾸고 문장 수에 `count`를 더한다. `idle`이면 트랜잭션이 없다. */
function advanceTx(
  previous: TxInfo | null,
  tx: TxStatus,
  mode: TxMode,
  startedAt: number,
  count: number,
): TxInfo | null {
  if (tx === "idle") return null;
  const status = tx === "failed" ? "failed" : "open";
  if (previous === null) {
    return {
      status,
      statements: count,
      openedAt: startedAt,
      openedBy: mode === "manual" ? "app" : "user",
    };
  }
  // 바뀐 것이 없으면 같은 object를 돌려주어 구독한 화면을 다시 그리지 않는다.
  if (status === previous.status && count === 0) return previous;
  return { ...previous, status, statements: previous.statements + count };
}

/**
 * 문장 수 문구의 key. `.none`(`manual BEGIN`)은 사용자가 쓴 `BEGIN`으로 연 트랜잭션에만 쓴다. 앱이 연
 * 트랜잭션은 문장이 0개여도(첫 문장이 실패) `.other`다.
 */
export function statementsKey(key: StatementsKey, tx: TxCount): MessageKey {
  if (tx.statements === 0 && tx.openedBy === "app") return `${key}.other`;
  return pluralKey(key, tx.statements);
}

/** `statementsKey`로 고른 문구. `{count}`는 `formatCount`로 채운다. */
export function statementsText(key: StatementsKey, tx: TxCount): string {
  return t(statementsKey(key, tx), { count: formatCount(tx.statements) });
}

/** `2 statements`. 사용자가 쓴 BEGIN으로 연 트랜잭션에 문장이 없으면 `manual BEGIN`이다. */
export function statementsLabel(tx: TxCount): string {
  return statementsText("tx.statements", tx);
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
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = String(total % 60).padStart(2, "0");
  if (hours === 0) return `${minutes}:${seconds}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}
