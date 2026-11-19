import type { ServerError } from "../../shared/api/types";
import { t, tc } from "../../shared/i18n/t";
import { Button } from "../../shared/ui/Button";
import { WarningIcon } from "../../shared/ui/icons";
import { Kbd } from "../../shared/ui/Kbd";
import { shortcutKeys, shortcutLabel } from "../workspace/shortcuts";
import { MessageBlock } from "./MessageBlock";

/**
 * 실패한 트랜잭션 안의 실패한 문장. 서버 메시지와 SQLSTATE를 그대로 보이고, Rollback 전까지 모든 문장이
 * 거부된다고 알린다. Rollback은 toolbar와 같은 규칙으로 답을 기다리는 동안 disabled다.
 */
export function TransactionFailed({
  error,
  ending,
  onRollback,
}: {
  error: ServerError;
  ending: boolean;
  onRollback(): void;
}) {
  return (
    <MessageBlock icon={WarningIcon}>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex items-center gap-3">
          <span className="text-body text-fg flex-1 font-medium">
            {t("tx.failedTitle")}
          </span>
          <Button
            size="kbd"
            disabled={ending}
            aria-keyshortcuts={shortcutKeys("rollback")}
            onClick={onRollback}
          >
            {t("tx.rollback")}
            <Kbd>{shortcutLabel("rollback")}</Kbd>
          </Button>
        </div>
        <p className="text-body font-mono break-words">{error.message}</p>
        {error.detail !== null && (
          <p className="text-small text-fg">{error.detail}</p>
        )}
        {error.hint !== null && (
          <p className="text-small text-fg-2">{error.hint}</p>
        )}
        <p className="text-small text-fg-2">
          <span>{t("result.sqlstate", { code: error.code })}</span> ·{" "}
          <span>{t("tx.failedHint")}</span>
        </p>
      </div>
    </MessageBlock>
  );
}

/** 끊긴 세션에 열린 트랜잭션이 있었다는 알림. 결과 위의 banner이고 OK로 닫는다. */
export function TransactionLostBanner({
  statements,
  onClose,
}: {
  statements: number;
  onClose(): void;
}) {
  return (
    <div
      role="alert"
      className="border-line-1 bg-bg-1 flex shrink-0 items-start gap-3 border-b px-3.5 py-3"
    >
      <WarningIcon size={16} className="text-fg mt-px shrink-0" />
      <div className="flex flex-1 flex-col gap-1">
        <span className="text-body font-medium">{t("tx.lostTitle")}</span>
        <span className="text-small text-fg-2">
          {statements === 0
            ? t("tx.lostBody.none")
            : tc("tx.lostBody", statements)}
        </span>
      </div>
      <Button size="small" onClick={onClose}>
        {t("common.ok")}
      </Button>
    </div>
  );
}
