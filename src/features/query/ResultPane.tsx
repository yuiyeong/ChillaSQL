import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { copyText } from "../../shared/api/clipboard";
import type { Outcome } from "../../shared/api/types";
import { formatCount, t, tc } from "../../shared/i18n/t";
import { Button } from "../../shared/ui/Button";
import { IconButton } from "../../shared/ui/IconButton";
import {
  CancelledIcon,
  CheckIcon,
  CopyIcon,
  ErrorIcon,
  LinkBrokenIcon,
  TrashIcon,
  WarningIcon,
} from "../../shared/ui/icons";
import { Kbd } from "../../shared/ui/Kbd";
import { useNow } from "../../shared/ui/useNow";
import { Toast, useToast } from "../../shared/ui/Toast";
import { useTunnel } from "../connections/tunnelsStore";
import { cancelRun, retryTunnel, runAgain } from "../workspace/commands";
import { MessageBlock } from "./MessageBlock";
import { shortcutLabel } from "../workspace/shortcuts";
import {
  affectedText,
  errorLocation,
  formatElapsed,
  formatLive,
  resultLabel,
} from "./format";
import { ResultGrid, type CopyTarget } from "./ResultGrid";
import { receivedRows, type ResultData } from "./runReducer";
import { useRuns } from "./runsStore";
import {
  ReconnectedBanner,
  TunnelFailed,
  TunnelGaveUp,
  TunnelRestarting,
  TunnelStarting,
} from "./TunnelPanels";

const LIVE_MS = 100;

/**
 * 결과 panel. header 아래에 표나 상태 화면이 온다.
 * running과 finished가 같은 자리에 같은 component로 표를 그린다. 끝나도 표가 다시 mount되지 않아 스크롤 위치가 남는다.
 */
export const ResultPane = memo(function ResultPane({
  tabId,
  hasConnection,
  connection = null,
  onEditConnection,
}: {
  tabId: string | null;
  hasConnection: boolean;
  /** 탭의 접속. 그 접속의 터널 상태를 그린다. */
  connection?: string | null;
  onEditConnection?(name: string): void;
}) {
  const state = useRuns((s) => (tabId === null ? undefined : s.runs[tabId]));
  const runNotice = useRuns((s) =>
    tabId === null ? undefined : s.notices[tabId],
  );
  const tunnel = useTunnel(connection);
  const toast = useToast();
  const copyTargetRef = useRef<(() => CopyTarget) | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

  const onFetchMore = useCallback(() => {
    if (tabId !== null) void useRuns.getState().fetchMore(tabId);
  }, [tabId]);
  const onRunAgain = useCallback(() => {
    if (tabId !== null) void runAgain(tabId);
  }, [tabId]);

  const { show } = toast;
  const copy = useCallback(
    async (text: string, message: string) => {
      try {
        await copyText(text);
      } catch {
        // clipboard를 쓰지 못하면 복사했다고 알리지 않는다.
        return;
      }
      show(message);
    },
    [show],
  );

  let header: ReactNode = null;
  let notice: ReactNode = null;
  let grid: ReactNode = null;
  let body: ReactNode = null;

  const gridOf = (result: ResultData, end: string | null) => (
    <ResultGrid
      // 실행 상태가 있으면 tabId는 null이 아니다.
      tabId={tabId!}
      result={result}
      end={end}
      onFetchMore={onFetchMore}
      onRunAgain={onRunAgain}
      onCopied={show}
      copyTargetRef={copyTargetRef}
      onSelectionChange={setHasSelection}
    />
  );

  switch (state?.status) {
    case undefined:
    case "idle":
      body =
        tabId !== null && !hasConnection ? (
          <Centered>{t("run.noConnection")}</Centered>
        ) : (
          <Hints />
        );
      break;
    case "connecting":
      body =
        connection !== null &&
        tunnel?.state.status === "starting" &&
        tunnel.state.attempt === 0 ? (
          <TunnelStarting
            connection={connection}
            onCancel={() => {
              if (tabId !== null) void cancelRun(tabId);
            }}
          />
        ) : (
          <Centered>{t("result.connecting")}</Centered>
        );
      break;
    case "running": {
      const { result } = state;
      const hasRows = result.rows.length > 0;
      header = (
        <Header sql={result.sql}>
          {hasRows ? (
            <Meta>{rowsMeta(result)}</Meta>
          ) : (
            <LiveMeta startedAt={result.startedAt} />
          )}
        </Header>
      );
      if (hasRows) {
        grid = gridOf(result, null);
      } else {
        body = <Centered>{t("result.waiting")}</Centered>;
      }
      break;
    }
    case "finished": {
      const { result, outcome } = state;
      const elapsed = formatElapsed(result.elapsedMicros ?? 0);
      const name = <Header sql={result.sql} />;
      switch (outcome.outcome) {
        case "completed":
          if (result.columns === null) {
            header = (
              <Header sql={result.sql}>
                <Meta>{elapsed}</Meta>
              </Header>
            );
            body = (
              <Centered>
                <span className="text-title text-fg flex items-center gap-2">
                  <CheckIcon />
                  {affectedText(result.sql, outcome.rows)}
                </span>
              </Centered>
            );
          } else {
            header = (
              <Header sql={result.sql}>
                <Meta>{tc("result.rows", outcome.rows, { elapsed })}</Meta>
              </Header>
            );
            grid = gridOf(result, tc("result.end", outcome.rows));
          }
          break;
        case "failed": {
          header = name;
          body = <ServerError result={result} outcome={outcome} copy={copy} />;
          break;
        }
        case "cancelled": {
          // header는 받은 행 수, 안내는 표에 남은 행 수다. 버린 앞 행은 표의 버린 구간 줄이 알린다.
          const retained = result.rows.length;
          header = (
            <Header sql={result.sql}>
              <Meta>
                {tc("result.rows", receivedRows(result), { elapsed })}
              </Meta>
            </Header>
          );
          notice = (
            <Notice icon={<CancelledIcon />} title={t("result.cancelled")}>
              {retained > 0
                ? tc("result.stoppedRows", retained)
                : t("result.stopped")}
            </Notice>
          );
          if (retained > 0) grid = gridOf(result, null);
          break;
        }
        case "expired":
          // 더 가져오지 않아 닫았다. 받은 행은 그대로 두고 끝 줄이 알린다.
          header = (
            <Header sql={result.sql}>
              <Meta>
                {tc("result.rows", receivedRows(result), { elapsed })}
              </Meta>
            </Header>
          );
          grid = gridOf(result, t("result.expired"));
          break;
        case "discarded":
          header = name;
          body = (
            <Notice icon={<TrashIcon />} title={t("result.discarded")}>
              {t("result.discardedDetail")}
            </Notice>
          );
          break;
        case "connection_lost":
          header = name;
          body = (
            <Notice
              icon={<LinkBrokenIcon />}
              title={t("result.connectionLost")}
            >
              <span className="text-small text-fg font-mono">
                {outcome.message}
              </span>
              {t("result.nextRunNewSession")}
            </Notice>
          );
          break;
        case "client_error":
          header = name;
          body = (
            <MessageBlock icon={ErrorIcon}>
              <p className="text-body font-mono">{outcome.message}</p>
            </MessageBlock>
          );
          break;
      }
      break;
    }
    case "rejected": {
      const { rejection } = state;
      const { retry } = rejection;
      if (retry !== undefined) {
        body = (
          <TunnelFailed
            rejection={rejection}
            retry={retry}
            onRetry={() => {
              if (tabId !== null)
                void useRuns.getState().run(tabId, () => retry);
            }}
            onEditConnection={onEditConnection}
          />
        );
        break;
      }
      body = (
        <MessageBlock icon={WarningIcon}>
          <div className="flex flex-col gap-1">
            <p className="text-body text-fg">{state.rejection.title}</p>
            {state.rejection.detail !== null && (
              <p className="text-small text-fg-2">{state.rejection.detail}</p>
            )}
          </div>
        </MessageBlock>
      );
      break;
    }
  }

  const tunnelState = tunnel?.state;
  const banners = (
    <>
      {runNotice === "reconnected" && tabId !== null && (
        <ReconnectedBanner
          onClose={() => useRuns.getState().dismissNotice(tabId)}
        />
      )}
      {tunnelState?.status === "starting" && tunnelState.attempt >= 1 && (
        <TunnelRestarting attempt={tunnelState.attempt} />
      )}
      {tunnelState?.status === "failed" &&
        tunnelState.reason !== "cancelled" &&
        tunnel?.afterRestart === true &&
        connection !== null && (
          <TunnelGaveUp
            output={"output" in tunnelState ? tunnelState.output : null}
            onRetry={() => void retryTunnel(connection)}
          />
        )}
    </>
  );

  const copySelection = () => {
    const target = copyTargetRef.current?.();
    if (target != null) void copy(target.text, target.message);
  };

  return (
    <section className="bg-bg-0 text-fg relative flex h-full min-h-0 flex-col">
      {banners}
      {header !== null && (
        <div className="border-line-1 flex h-9 shrink-0 items-center gap-3 border-b px-3">
          {header}
          <div className="flex-1" />
          {grid !== null && (
            <IconButton
              label={t("result.copySelected")}
              disabled={!hasSelection}
              onClick={copySelection}
            >
              <CopyIcon />
            </IconButton>
          )}
        </div>
      )}
      {notice}
      {grid}
      {body !== null && (
        <div className="min-h-0 flex-1 overflow-auto">{body}</div>
      )}
      <Toast message={toast.message} />
    </section>
  );
});

function rowsMeta(result: ResultData): string {
  return t("result.rowsMore", {
    count: formatCount(receivedRows(result)),
    elapsed: formatElapsed(result.elapsedMicros ?? 0),
  });
}

/** header의 결과 탭. 탭은 하나뿐이다. */
function Header({ sql, children }: { sql: string; children?: ReactNode }) {
  // batch, 알림, 선택마다 다시 그려지므로 label은 실행마다 한 번 만든다.
  const label = useMemo(() => resultLabel(sql), [sql]);
  return (
    <>
      <div
        role="tablist"
        aria-label={t("result.tabs")}
        className="flex gap-0.5"
      >
        <button
          type="button"
          role="tab"
          aria-selected="true"
          className="text-small bg-bg-3 text-fg h-6 cursor-default rounded-[6px] border-0 px-2.5 font-medium"
        >
          {label}
        </button>
      </div>
      {children}
    </>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <span className="text-small text-fg-2 font-mono">{children}</span>;
}

/** 실행 중 경과 시간. 100ms마다 다시 잰다. */
function LiveMeta({ startedAt }: { startedAt: number }) {
  const now = useNow(LIVE_MS);
  return (
    <Meta>
      {t("result.running", {
        elapsed: formatLive(Math.max(0, now - startedAt)),
      })}
    </Meta>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="text-small text-fg-2 flex h-full min-h-16 items-center justify-center p-4">
      {children}
    </div>
  );
}

/** 실행과 새 탭 단축키 안내. 결과 panel의 빈 상태와 탭이 없는 에디터 자리가 같이 쓴다. */
export function Hints() {
  return (
    <div className="text-small text-fg-2 flex h-full min-h-16 items-center justify-center gap-7 p-4">
      <span className="flex items-center gap-2">
        <Kbd>{shortcutLabel("run")}</Kbd>
        {t("result.hintRun")}
      </span>
      <span className="flex items-center gap-2">
        <Kbd>{shortcutLabel("newTab")}</Kbd>
        {t("result.hintNewTab")}
      </span>
    </div>
  );
}

/** icon과 제목 줄, 그 아래 설명. 색이나 배경으로 구분하지 않는다. */
function Notice({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-4 py-3.5">
      <span className="text-small text-fg flex items-center gap-2 font-medium">
        {icon}
        {title}
      </span>
      <div className="text-small text-fg-2 flex flex-col gap-1.5">
        {children}
      </div>
    </div>
  );
}

function ServerError({
  result,
  outcome,
  copy,
}: {
  result: ResultData;
  outcome: Extract<Outcome, { outcome: "failed" }>;
  copy(text: string, message: string): Promise<void>;
}) {
  const { error } = outcome;
  const location =
    error.position === null ? null : errorLocation(result, error.position);
  return (
    <MessageBlock icon={ErrorIcon}>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <p className="text-body font-mono break-words">{error.message}</p>
        {error.detail !== null && (
          <p className="text-small text-fg">{error.detail}</p>
        )}
        {error.hint !== null && (
          <p className="text-small text-fg-2">{error.hint}</p>
        )}
        <div className="text-small text-fg-2 flex gap-4">
          <span>{t("result.sqlstate", { code: error.code })}</span>
          {location !== null && (
            <span>
              {t("result.errorLocation", {
                line: location.line,
                column: location.column,
              })}
            </span>
          )}
          <span className="font-mono">
            {formatElapsed(result.elapsedMicros ?? 0)}
          </span>
        </div>
        <div>
          <Button
            variant="ghost"
            onClick={() => void copy(error.message, t("toast.copiedMessage"))}
          >
            {t("result.copyMessage")}
          </Button>
        </div>
      </div>
    </MessageBlock>
  );
}
