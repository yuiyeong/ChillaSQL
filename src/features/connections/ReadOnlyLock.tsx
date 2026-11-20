import { t } from "../../shared/i18n/t";
import { LockIcon } from "../../shared/ui/icons";

/** read-only 접속의 표시. 캔버스는 12px, 선 굵기 1.5의 자물쇠다. 글자 색을 따른다. */
export function ReadOnlyLock({ size = 12 }: { size?: number }) {
  return (
    <LockIcon
      size={size}
      strokeWidth={1.5}
      role="img"
      aria-hidden={undefined}
      aria-label={t("common.readOnly")}
      className="text-fg-2 shrink-0"
    />
  );
}
