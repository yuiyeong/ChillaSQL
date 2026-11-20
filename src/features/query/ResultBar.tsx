import type { ReactNode } from "react";
import { t } from "../../shared/i18n/t";

const TAB_CLASS =
  "text-small bg-bg-3 text-fg inline-flex h-6 shrink-0 cursor-default items-center rounded-[6px] border-0 px-2.5 font-medium";

/** 결과 panel 위의 header 줄(캔버스 Tools의 `.rhead`). 높이 36px, 아래 line. */
export function ResultBar({ children }: { children: ReactNode }) {
  return (
    <div className="border-line-1 flex h-9 shrink-0 items-center gap-3 border-b px-3">
      {children}
    </div>
  );
}

/** 하나뿐인 결과 탭(캔버스 Tools의 `.rtab`) */
export function SingleTab({ children }: { children: ReactNode }) {
  return (
    <div role="tablist" aria-label={t("result.tabs")} className="flex gap-0.5">
      <button
        type="button"
        role="tab"
        aria-selected="true"
        className={TAB_CLASS}
      >
        {children}
      </button>
    </div>
  );
}
