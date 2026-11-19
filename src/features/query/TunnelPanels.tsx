import { t } from "../../shared/i18n/t";
import { Button } from "../../shared/ui/Button";
import { ErrorIcon, ReconnectIcon } from "../../shared/ui/icons";
import { CommandOutput, Pre } from "../connections/CommandOutput";
import { useTunnelTarget } from "../connections/TunnelStatus";
import { useConnection } from "../project/projectStore";
import { MessageBlock } from "./MessageBlock";
import type { Rejection, RunRequest } from "./runReducer";

/** 터널이 열리기를 기다리는 동안의 결과 panel. 실행한 명령과 Cancel. */
export function TunnelStarting({
  connection,
  onCancel,
}: {
  connection: string;
  onCancel(): void;
}) {
  const target = useTunnelTarget(connection);
  const command = useConnection(connection)?.tunnel ?? null;
  return (
    <div className="flex flex-col gap-2.5 p-4">
      <p className="text-body">
        {t("tunnel.ranCommand", { target: target ?? "" })}
      </p>
      {command !== null && <Pre>{command}</Pre>}
      <div>
        <Button onClick={onCancel}>{t("common.cancel")}</Button>
      </div>
    </div>
  );
}

/** 터널을 열지 못한 실행. message, 명령의 stderr, Try again과 Edit connection. */
export function TunnelFailed({
  rejection,
  retry,
  onRetry,
  onEditConnection,
}: {
  rejection: Rejection;
  retry: RunRequest;
  onRetry(): void;
  onEditConnection?(name: string): void;
}) {
  return (
    <MessageBlock icon={ErrorIcon}>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <p className="text-body">{rejection.title}</p>
        <CommandOutput text={rejection.output} />
        <div className="flex gap-2">
          <Button onClick={onRetry}>{t("tunnel.tryAgain")}</Button>
          {onEditConnection !== undefined && (
            <Button
              variant="ghost"
              onClick={() => onEditConnection(retry.connection)}
            >
              {t("tunnel.editConnection")}
            </Button>
          )}
        </div>
      </div>
    </MessageBlock>
  );
}

/** 터널이 끊겨 다시 실행하는 중. 결과 위의 한 줄. */
export function TunnelRestarting({ attempt }: { attempt: number }) {
  return (
    <p className="border-line-1 bg-bg-1 text-small text-fg-2 shrink-0 border-b px-3.5 py-2">
      {t("tunnel.restarting", { attempt })}
    </p>
  );
}

/** 다시 실행을 3번 실패해 멈춘 터널. 마지막 stderr와 Try again. */
export function TunnelGaveUp({
  output,
  onRetry,
}: {
  output: string | null;
  onRetry(): void;
}) {
  return (
    <div
      role="alert"
      className="border-line-1 bg-bg-1 flex shrink-0 gap-3 border-b px-3.5 py-3"
    >
      <ErrorIcon size={16} className="text-fg mt-px shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-small text-fg-2">{t("tunnel.gaveUp")}</span>
        <CommandOutput text={output} />
        <div>
          <Button onClick={onRetry}>{t("tunnel.tryAgain")}</Button>
        </div>
      </div>
    </div>
  );
}

/** 끊긴 세션을 새 세션이 대신했다는 알림. */
export function ReconnectedBanner({ onClose }: { onClose(): void }) {
  return (
    <div
      role="status"
      className="border-line-1 bg-bg-1 flex shrink-0 items-start gap-3 border-b px-3.5 py-3"
    >
      <ReconnectIcon className="text-fg mt-px shrink-0" />
      <div className="flex flex-1 flex-col gap-1">
        <span className="text-body font-medium">{t("result.reconnected")}</span>
        <span className="text-small text-fg-2">
          {t("result.reconnectedDetail")}
        </span>
      </div>
      <Button variant="ghost" size="small" onClick={onClose}>
        {t("common.close")}
      </Button>
    </div>
  );
}
