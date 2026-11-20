import type { ReactNode } from "react";
import { LockIcon } from "../../shared/ui/icons";

/**
 * result header 아래의 note(캔버스 Tools M10의 `.note`). 자물쇠 icon과 문장이고, 색이나 배경으로
 * 구분하지 않는다. 편집할 수 없는 이유와 Apply하지 못한 이유를 알린다.
 */
export function ResultNote({ children }: { children: ReactNode }) {
  return (
    <div className="shrink-0 px-3 pt-3">
      <div
        role="status"
        className="border-line-2 text-small text-fg flex items-start gap-2.5 rounded-lg border px-3 py-2.5 leading-normal"
      >
        <LockIcon className="mt-px shrink-0" />
        <span className="min-w-0">{children}</span>
      </div>
    </div>
  );
}
