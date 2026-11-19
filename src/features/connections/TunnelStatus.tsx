import { useId, useState, type ReactNode } from "react";
import { t } from "../../shared/i18n/t";
import {
  ErrorIcon,
  ExternalTunnelIcon,
  SpinnerIcon,
} from "../../shared/ui/icons";
import { useNow } from "../../shared/ui/useNow";
import { useConnection } from "../project/projectStore";
import { useTunnel, type TunnelView } from "./tunnelsStore";

/** 화면에 그릴 터널 상태. 열린 터널과 멈춘(취소한) 시작은 그리지 않는다. */
function useShownTunnel(connection: string | null): TunnelView | undefined {
  const view = useTunnel(connection);
  if (view === undefined) return undefined;
  const { state } = view;
  if (state.status === "ready") return undefined;
  if (state.status === "failed" && state.reason === "cancelled")
    return undefined;
  return view;
}

/** 접속의 `host:port`. 터널이 열릴 곳이다. */
export function useTunnelTarget(connection: string | null): string | null {
  const found = useConnection(connection);
  return found === undefined ? null : `${found.host}:${found.port}`;
}

const STATUS = {
  starting: { label: "tunnel.starting", Icon: SpinnerIcon },
  reconnecting: { label: "tunnel.reconnecting", Icon: SpinnerIcon },
  failed: { label: "tunnel.failed", Icon: ErrorIcon },
  external: { label: "tunnel.external", Icon: ExternalTunnelIcon },
} as const;

function statusOf(view: TunnelView) {
  switch (view.state.status) {
    case "starting":
      return view.state.attempt === 0 ? STATUS.starting : STATUS.reconnecting;
    case "failed":
      return STATUS.failed;
    default:
      return STATUS.external;
  }
}

/** hover나 focus 동안 앱이 띄우지 않은 터널의 설명을 띄운다. 그 밖의 상태는 그대로 그린다. */
function ExternalHint({
  connection,
  view,
  children,
}: {
  connection: string;
  view: TunnelView;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  if (view.state.status !== "external") return <>{children(undefined)}</>;
  return <Tooltip connection={connection}>{children}</Tooltip>;
}

function Tooltip({
  connection,
  children,
}: {
  connection: string;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const target = useTunnelTarget(connection);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children(id)}
      {open && target !== null && (
        <span
          id={id}
          role="tooltip"
          className="bg-bg-3 border-line-2 text-small text-fg shadow-popover rounded-control absolute top-full left-0 z-20 mt-1.5 w-72 border px-3 py-2.5 text-left leading-normal font-normal whitespace-normal"
        >
          {t("tunnel.externalHint", { target })}
        </span>
      )}
    </span>
  );
}

/** toolbar 접속 chip 안의 터널 상태 칸. */
export function TunnelChipStatus({ connection }: { connection: string }) {
  const view = useShownTunnel(connection);
  if (view === undefined) return null;
  const { label, Icon } = statusOf(view);
  return (
    <ExternalHint connection={connection} view={view}>
      {(describedBy) => (
        <span
          aria-describedby={describedBy}
          className="border-line-2 text-small text-fg-2 inline-flex items-center gap-1.5 border-l pl-2"
        >
          <Icon />
          {t(label)}
          {view.state.status === "starting" &&
            (view.state.attempt === 0 ? (
              <Seconds since={view.since} total={view.state.timeoutSecs} />
            ) : (
              <span className="font-mono">
                {t("tunnel.attempt", { attempt: view.state.attempt })}
              </span>
            ))}
        </span>
      )}
    </ExternalHint>
  );
}

/** 시작한 뒤 지난 초와 대기 시간. 처음 시작에만 그린다. */
function Seconds({ since, total }: { since: number; total: number }) {
  const now = useNow(1000);
  const elapsed = Math.min(
    total,
    Math.max(0, Math.floor((now - since) / 1000)),
  );
  return (
    <span className="font-mono">{t("tunnel.seconds", { elapsed, total })}</span>
  );
}

/** 탭 제목 옆의 터널 icon. */
export function TunnelTabIcon({ connection }: { connection: string | null }) {
  const view = useShownTunnel(connection);
  if (view === undefined || connection === null) return null;
  const { label, Icon } = statusOf(view);
  return (
    <ExternalHint connection={connection} view={view}>
      {(describedBy) => (
        <span
          role="img"
          aria-label={t(label)}
          aria-describedby={describedBy}
          className="text-fg-2 inline-flex shrink-0"
        >
          <Icon />
        </span>
      )}
    </ExternalHint>
  );
}
