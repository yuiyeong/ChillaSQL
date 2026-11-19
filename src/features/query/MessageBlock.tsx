import type { ReactNode } from "react";
import type { ErrorIcon } from "../../shared/ui/icons";

/** 16px icon과 그 옆의 내용. 오류와 실행하지 못한 이유에 쓴다. */
export function MessageBlock({
  icon: Icon,
  children,
}: {
  icon: typeof ErrorIcon;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3 p-4">
      <Icon size={16} className="text-fg mt-px shrink-0" />
      {children}
    </div>
  );
}
