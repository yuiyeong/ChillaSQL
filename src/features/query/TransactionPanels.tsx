import { t, tc } from "../../shared/i18n/t";
import { Button } from "../../shared/ui/Button";
import { WarningIcon } from "../../shared/ui/icons";
import { Kbd } from "../../shared/ui/Kbd";
import { shortcutKeys, shortcutLabel } from "../workspace/shortcuts";
import { Banner } from "./MessageBlock";

/**
 * 실패한 트랜잭션의 오류 위에 두는 제목 줄. Rollback 전까지 모든 문장이 거부된다고 알린다.
 * Rollback은 toolbar와 같은 규칙(`endable`)으로 disabled다.
 */
export function TransactionFailedHeader({
  disabled,
  onRollback,
}: {
  disabled: boolean;
  onRollback(): void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-body text-fg flex-1 font-medium">
        {t("tx.failedTitle")}
      </span>
      <Button
        size="kbd"
        disabled={disabled}
        aria-keyshortcuts={shortcutKeys("rollback")}
        onClick={onRollback}
      >
        {t("tx.rollback")}
        <Kbd>{shortcutLabel("rollback")}</Kbd>
      </Button>
    </div>
  );
}

/** 트랜잭션을 실패로 만든 것이 앞 문장이면(25P02) 앞 오류라고, 이 문장이면 이 오류라고 알린다. */
export function failedHintOf(sqlstate: string): string {
  return sqlstate === "25P02" ? t("tx.failedHint") : t("tx.failedHintThis");
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
    <Banner
      role="alert"
      icon={<WarningIcon size={16} className="text-fg mt-px shrink-0" />}
      title={t("tx.lostTitle")}
      detail={tc("tx.lostBody", statements)}
      action={
        <Button size="small" onClick={onClose}>
          {t("common.ok")}
        </Button>
      }
    />
  );
}
