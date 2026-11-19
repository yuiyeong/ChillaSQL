import { useEffect, useId, useState, type ReactNode } from "react";
import { t } from "../../shared/i18n/t";
import {
  ErrorIcon,
  ExternalTunnelIcon,
  SpinnerIcon,
} from "../../shared/ui/icons";
import { useProject } from "../project/projectStore";
import { useTunnels, type TunnelView } from "./tunnelsStore";

/** `since`부터 지난 초. 1초마다 다시 그린다. */
export function useElapsedSeconds(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return Math.max(0, Math.floor((now - since) / 1000));
}

/** 화면에 그릴 터널 상태. 열린 터널과 멈춘(취소한) 시작은 그리지 않는다. */
function useShownTunnel(connection: string | null): TunnelView | undefined {
  const view = useTunnels((s) =>
    connection === null ? undefined : s.tunnels[connection],
  );
  if (view === undefined) return undefined;
  const { state } = view;
  if (state.status === "ready") return undefined;
  if (state.status === "failed" && state.reason === "cancelled")
    return undefined;
  return view;
}

/** 접속의 `host:port`. 터널이 열릴 곳이다. */
export function useTunnelTarget(connection: string): string | null {
  return useProject((s) => {
    const found = s.project?.connections.find((c) => c.name === connection);
    return found === undefined ? null : `${found.host}:${found.port}`;
  });
}

function label(view: TunnelView): string {
  switch (view.state.status) {
    case "starting":
      return view.state.attempt === 0
        ? t("tunnel.starting")
        : t("tunnel.reconnecting");
    case "failed":
      return t("tunnel.failed");
    default:
      return t("tunnel.external");
  }
}

function StatusIcon({ view }: { view: TunnelView }) {
  switch (view.state.status) {
    case "starting":
      return <SpinnerIcon />;
    case "failed":
      return <ErrorIcon />;
    default:
      return <ExternalTunnelIcon />;
  }
}

/** hover나 focus 동안 설명을 띄운다. */
function WithTooltip({
  text,
  children,
}: {
  text: string | null;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (text === null) return <>{children(undefined)}</>;
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children(id)}
      {open && (
        <span
          id={id}
          role="tooltip"
          className="bg-bg-3 border-line-2 text-small text-fg shadow-popover rounded-control absolute top-full left-0 z-20 mt-1.5 w-72 border px-3 py-2.5 text-left leading-normal font-normal whitespace-normal"
        >
          {text}
        </span>
      )}
    </span>
  );
}

function externalHint(view: TunnelView, target: string | null): string | null {
  if (view.state.status !== "external" || target === null) return null;
  return t("tunnel.externalHint", { target });
}

/** toolbar 접속 chip 안의 터널 상태 칸. */
export function TunnelChipStatus({ connection }: { connection: string }) {
  const view = useShownTunnel(connection);
  const target = useTunnelTarget(connection);
  if (view === undefined) return null;
  return (
    <WithTooltip text={externalHint(view, target)}>
      {(describedBy) => (
        <span
          aria-describedby={describedBy}
          className="border-line-2 text-small text-fg-2 inline-flex items-center gap-1.5 border-l pl-2"
        >
          <StatusIcon view={view} />
          {label(view)}
          {view.state.status === "starting" && <Counter view={view} />}
        </span>
      )}
    </WithTooltip>
  );
}

function Counter({ view }: { view: TunnelView }) {
  const elapsed = useElapsedSeconds(view.since);
  if (view.state.status !== "starting") return null;
  const text =
    view.state.attempt === 0
      ? t("tunnel.seconds", {
          elapsed: Math.min(elapsed, view.state.timeoutSecs),
          total: view.state.timeoutSecs,
        })
      : t("tunnel.attempt", { attempt: view.state.attempt });
  return <span className="font-mono">{text}</span>;
}

/** 탭 제목 옆의 터널 icon. */
export function TunnelTabIcon({ connection }: { connection: string | null }) {
  const view = useShownTunnel(connection);
  const target = useTunnelTarget(connection ?? "");
  if (view === undefined) return null;
  return (
    <WithTooltip text={externalHint(view, target)}>
      {(describedBy) => (
        <span
          role="img"
          aria-label={label(view)}
          aria-describedby={describedBy}
          className="text-fg-2 inline-flex shrink-0"
        >
          <StatusIcon view={view} />
        </span>
      )}
    </WithTooltip>
  );
}
