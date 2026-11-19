import type { ReactNode } from "react";
import type { ErrorIcon } from "../../shared/ui/icons";

/** 결과 위의 알림 줄. 왼쪽 icon, 제목과 설명, 오른쪽의 닫는 버튼. */
export function Banner({
  role,
  icon,
  title,
  detail,
  action,
}: {
  role: "alert" | "status";
  icon: ReactNode;
  title: string;
  detail: string;
  action: ReactNode;
}) {
  return (
    <div
      role={role}
      className="border-line-1 bg-bg-1 flex shrink-0 items-start gap-3 border-b px-3.5 py-3"
    >
      {icon}
      <div className="flex flex-1 flex-col gap-1">
        <span className="text-body font-medium">{title}</span>
        <span className="text-small text-fg-2">{detail}</span>
      </div>
      {action}
    </div>
  );
}

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
