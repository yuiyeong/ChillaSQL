import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { copyText } from "../../shared/api/clipboard";
import type { Outcome } from "../../shared/api/types";
import { t, tc } from "../../shared/i18n/t";
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
import { Toast, useToast } from "../../shared/ui/Toast";
import { runAgain } from "../workspace/commands";
import {
  affectedText,
  errorLocation,
  formatElapsed,
  formatLive,
} from "./format";
import { resultLabel } from "./grid";
import { ResultGrid, type CopyTarget } from "./ResultGrid";
import type { ResultData } from "./runReducer";
import { useRuns } from "./runsStore";

const LIVE_MS = 100;

/**
 * 결과 panel. header 아래에 표나 상태 화면이 온다.
 * running과 finished가 같은 자리에 같은 component로 표를 그린다. 끝나도 표가 다시 mount되지 않아 스크롤 위치가 남는다.
 */
export const ResultPane = memo(function ResultPane({
  tabId,
  hasConnection,
}: {
  tabId: string | null;
  hasConnection: boolean;
}) {
  const state = useRuns((s) => (tabId === null ? undefined : s.runs[tabId]));
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
  let showCopy = false;

  const gridOf = (result: ResultData, endRows: number | null) => (
    <ResultGrid
      result={result}
      endRows={endRows}
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
      body = <Centered>{t("result.connecting")}</Centered>;
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
        showCopy = true;
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
            grid = gridOf(result, outcome.rows);
            showCopy = true;
          }
          break;
        case "failed": {
          header = name;
          body = <ServerError result={result} outcome={outcome} copy={copy} />;
          break;
        }
        case "cancelled": {
          const received = result.rows.length;
          header = (
            <Header sql={result.sql}>
              <Meta>{tc("result.rows", received, { elapsed })}</Meta>
            </Header>
          );
          notice = (
            <Notice icon={<CancelledIcon />} title={t("result.cancelled")}>
              {received > 0
                ? tc("result.stoppedRows", received)
                : t("result.stopped")}
            </Notice>
          );
          if (received > 0) {
            // 끝난 결과라 더 가져오지 않는다. 마지막 fetch 값(fetching)이 spinner로 남지 않게 한다.
            grid = gridOf({ ...result, fetch: "none" }, null);
            showCopy = true;
          }
          break;
        }
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
            <div className="flex gap-3 p-4">
              <ErrorIcon size={16} className="text-fg mt-px shrink-0" />
              <p className="text-body font-mono">{outcome.message}</p>
            </div>
          );
          break;
      }
      break;
    }
    case "rejected":
      body = (
        <div className="flex gap-3 p-4">
          <WarningIcon size={16} className="text-fg mt-px shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="text-body text-fg">{state.rejection.title}</p>
            {state.rejection.detail !== null && (
              <p className="text-small text-fg-2">{state.rejection.detail}</p>
            )}
          </div>
        </div>
      );
      break;
  }

  const copySelection = () => {
    const target = copyTargetRef.current?.();
    if (target != null) void copy(target.text, target.message);
  };

  return (
    <section className="bg-bg-0 text-fg flex h-full min-h-0 flex-col">
      {header !== null && (
        <div className="border-line-1 flex h-9 shrink-0 items-center gap-3 border-b px-3">
          {header}
          <div className="flex-1" />
          {showCopy && (
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
    count: result.rows.length,
    elapsed: formatElapsed(result.elapsedMicros ?? 0),
  });
}

/** header의 결과 탭. 탭은 하나뿐이다. */
function Header({ sql, children }: { sql: string; children?: ReactNode }) {
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
          {resultLabel(sql)}
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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), LIVE_MS);
    return () => clearInterval(timer);
  }, []);
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
        <Kbd>⌘↵</Kbd>
        {t("result.hintRun")}
      </span>
      <span className="flex items-center gap-2">
        <Kbd>⇧⌘L</Kbd>
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
    <div className="flex gap-3 p-4">
      <ErrorIcon size={16} className="text-fg mt-px shrink-0" />
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
                line: String(location.line),
                column: String(location.column),
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
    </div>
  );
}
