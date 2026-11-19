import { useRuns } from "../query/runsStore";
import { canEndTransaction, type TxInfo } from "../query/transaction";
import { useElapsed } from "../query/useElapsed";
import { Button } from "../../shared/ui/Button";
import { execute } from "./commands";
import { shortcutKeys } from "./shortcuts";
import { t, tc } from "../../shared/i18n/t";
import type { TxMode } from "../../shared/api/types";

const MODES: { mode: TxMode; label: "tx.auto" | "tx.manual" }[] = [
  { mode: "auto", label: "tx.auto" },
  { mode: "manual", label: "tx.manual" },
];

/**
 * toolbar의 트랜잭션 조작. 모드 segmented, 열린 트랜잭션의 상태 문구, 빈 칸, Rollback과 Commit.
 * 쿼리의 행을 읽는 동안과 Commit이나 Rollback의 답을 기다리는 동안은 모두 disabled다.
 */
export function TransactionControls({ tabId }: { tabId: string | null }) {
  const mode = useRuns((s) => (tabId === null ? undefined : s.modes[tabId]));
  const tx = useRuns((s) =>
    tabId === null ? undefined : s.transactions[tabId],
  );
  const settled = useRuns(
    (s) =>
      tabId !== null && !s.ending[tabId] && canEndTransaction(s.runs[tabId]),
  );
  const setMode = useRuns((s) => s.setMode);

  return (
    <>
      <div
        role="radiogroup"
        aria-label={t("tx.mode")}
        className="border-line-2 bg-bg-2 flex shrink-0 gap-0.5 rounded-[7px] border p-0.5"
      >
        {MODES.map(({ mode: value, label }) => {
          const checked = (mode ?? "auto") === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={!settled}
              className={[
                "text-small focus-visible:outline-accent h-[22px] cursor-pointer rounded-[5px] border-0 px-2.5 font-medium focus-visible:outline-2 disabled:cursor-default disabled:opacity-50",
                checked ? "bg-bg-3 text-fg" : "text-fg-2 bg-transparent",
              ].join(" ")}
              onClick={() => {
                if (tabId !== null) setMode(tabId, value);
              }}
            >
              {t(label)}
            </button>
          );
        })}
      </div>
      {tx !== undefined && <TransactionStatus tx={tx} />}
      <div className="flex-1" />
      {tx !== undefined && (
        <>
          <Button
            disabled={!settled}
            aria-keyshortcuts={shortcutKeys("rollback")}
            onClick={() => void execute("rollback")}
          >
            {t("tx.rollback")}
          </Button>
          <Button
            disabled={!settled || tx.status === "failed"}
            aria-keyshortcuts={shortcutKeys("commit")}
            onClick={() => void execute("commit")}
          >
            {t("tx.commit")}
          </Button>
        </>
      )}
    </>
  );
}

/** `Open · 2 statements · 3:12`. 트랜잭션이 있을 때만 그려서 시계도 그때만 돈다. */
function TransactionStatus({ tx }: { tx: TxInfo }) {
  const elapsed = useElapsed(tx.openedAt);
  // 문장이 없으면 사용자가 직접 BEGIN한 트랜잭션이다(Auto 모드).
  const statements =
    tx.statements === 0
      ? t("tx.manualBegin")
      : tc("tx.statements", tx.statements);
  return (
    <span className="text-small text-fg-2 whitespace-nowrap">
      {tx.status === "failed" ? t("tx.failed") : t("tx.open")} · {statements} ·{" "}
      <span className="font-mono">{elapsed}</span>
    </span>
  );
}
