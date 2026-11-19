import type { ReactNode } from "react";
import { t } from "../../shared/i18n/t";

/** mono로 그대로 보여 주는 명령과 출력. */
export function Pre({ children }: { children: ReactNode }) {
  return (
    <pre className="bg-bg-1 border-line-1 text-small m-0 rounded-[8px] border px-3 py-2.5 font-mono leading-relaxed whitespace-pre-wrap">
      {children}
    </pre>
  );
}

/** 터널 명령의 stderr와 그 이름표. 비었으면 그리지 않는다. */
export function CommandOutput({ text }: { text: string | null | undefined }) {
  if (text === null || text === undefined || text === "") return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-label text-fg-2 font-semibold tracking-[0.04em]">
        {t("tunnel.output")}
      </span>
      <Pre>{text}</Pre>
    </div>
  );
}
