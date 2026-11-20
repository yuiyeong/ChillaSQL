import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { copyText } from "../../shared/api/clipboard";
import type { Connection, Outcome } from "../../shared/api/types";
import { formatCount, t, tc } from "../../shared/i18n/t";
import { Button } from "../../shared/ui/Button";
import { IconButton } from "../../shared/ui/IconButton";
import {
  CancelledIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  ErrorIcon,
  LinkBrokenIcon,
  LockIcon,
  TrashIcon,
  WarningIcon,
} from "../../shared/ui/icons";
import { Kbd } from "../../shared/ui/Kbd";
import { useNow } from "../../shared/ui/useNow";
import { Toast, useToast } from "../../shared/ui/Toast";
import { useTunnel } from "../connections/tunnelsStore";
import { useConnection } from "../project/projectStore";
import { useSettings } from "../settings/settingsStore";
import { useEditorStatus } from "../editor/editorStatus";
import { anchorLocation, goToError } from "../editor/runAnchors";
import {
  cancelRun,
  retryRun,
  retryTunnel,
  runAgain,
} from "../workspace/commands";
import { MessageBlock } from "./MessageBlock";
import { shortcutLabel } from "../workspace/shortcuts";
import {
  affectedText,
  errorLocation,
  formatElapsed,
  formatLive,
  resultLabel,
} from "./format";
import { isPlanResult, parsePlan, type Plan } from "./explainPlan";
import { DdlView } from "./DdlView";
import { useDdl } from "./ddlStore";
import { ExplainView } from "./ExplainView";
import { ResultBar, SingleTab } from "./ResultBar";
import { ResultGrid, type CopyTarget } from "./ResultGrid";
import { receivedRows, type ResultData, type RunState } from "./runReducer";
import { endable, useRuns, type ScriptRun } from "./runsStore";
import {
  failedHintOf,
  TransactionFailedHeader,
  TransactionLostBanner,
} from "./TransactionPanels";
import {
  ReconnectedBanner,
  TunnelFailed,
  TunnelGaveUp,
  TunnelRestarting,
  TunnelStarting,
} from "./TunnelPanels";

const LIVE_MS = 100;

/** query_canceled. statement_timeout이 끊은 문장도 이 코드다. */
const TIMEOUT_CODE = "57014";
/** read_only_sql_transaction */
const READ_ONLY_CODE = "25006";

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
  const current = useRuns((s) => (tabId === null ? undefined : s.runs[tabId]));
  const script = useRuns((s) =>
    tabId === null ? undefined : s.scripts[tabId],
  );
  // 결과 탭에서 앞 문장을 고르면 그 문장의 고정된 결과를 그린다.
  const state =
    script !== undefined && script.selected < script.current
      ? script.done[script.selected]
      : current;
  const runNotice = useRuns((s) =>
    tabId === null ? undefined : s.notices[tabId],
  );
  const txFailed = useRuns((s) =>
    tabId === null ? false : s.transactions[tabId]?.status === "failed",
  );
  const rollbackDisabled = useRuns(
    (s) => tabId === null || !endable(s, tabId, "rollback"),
  );
  const discardedByEnd = useRuns((s) =>
    tabId === null ? false : s.discardedByEnd[tabId] === true,
  );
  const ddl = useDdl((s) => (tabId === null ? undefined : s.views[tabId]));
  const tunnel = useTunnel(connection);
  const tabConnection = useConnection(connection);
  const idleTimeoutSecs = useSettings((s) => s.idleTimeoutSecs);
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

  const tabs =
    script === undefined || tabId === null ? null : (
      <ScriptTabs tabId={tabId} script={script} current={current} />
    );
  // 멈춘 문장을 보고 있으면 거기서 멈췄고 뒤 문장은 실행하지 않았다고 알린다.
  const stopped =
    script !== undefined &&
    script.stoppedAt !== null &&
    script.selected === script.stoppedAt
      ? stoppedText(script.stoppedAt, script.steps.length)
      : null;

  // tree를 그릴 EXPLAIN인지는 결과가 바뀔 때만 다시 parse한다.
  const completed =
    state?.status === "finished" && state.outcome.outcome === "completed"
      ? state.result
      : null;
  const plan = useMemo(
    () => (completed === null ? null : planOf(completed)),
    [completed],
  );

  let header: ReactNode = null;
  let notice: ReactNode = null;
  let grid: ReactNode = null;
  let body: ReactNode = null;
  let explain: ReactNode = null;

  const gridOf = (result: ResultData, endRows: number | null) => (
    <ResultGrid
      // 실행 상태가 있으면 tabId는 null이 아니다.
      tabId={tabId!}
      connection={connection}
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
        <Header sql={result.sql} tabs={tabs}>
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
      const name = <Header sql={result.sql} tabs={tabs} />;
      switch (outcome.outcome) {
        case "completed":
          if (result.columns === null) {
            header = (
              <Header sql={result.sql} tabs={tabs}>
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
            if (plan !== null) {
              // 앞 행을 버리지 않았고 node 줄이 있는 EXPLAIN은 표 대신 tree로 그린다.
              explain = (
                <ExplainView
                  key={result.runKey}
                  tabs={tabs}
                  plan={plan.plan}
                  lines={plan.lines}
                />
              );
              break;
            }
            header = (
              <Header sql={result.sql} tabs={tabs}>
                <Meta>{tc("result.rows", outcome.rows, { elapsed })}</Meta>
              </Header>
            );
            grid = gridOf(result, outcome.rows);
          }
          break;
        case "failed": {
          header = name;
          body = (
            <ServerError
              tabId={tabId}
              result={result}
              outcome={outcome}
              connection={tabConnection}
              stopped={stopped}
              copy={copy}
              failedTransaction={
                txFailed && tabId !== null
                  ? {
                      disabled: rollbackDisabled,
                      onRollback: () =>
                        void useRuns
                          .getState()
                          .endTransaction(tabId, "rollback"),
                    }
                  : undefined
              }
            />
          );
          break;
        }
        case "cancelled":
        case "expired": {
          // header는 받은 행 수, 안내는 표에 남은 행 수다. 버린 앞 행은 표의 버린 구간 줄이 알린다.
          const retained = result.rows.length;
          header = (
            <Header sql={result.sql} tabs={tabs}>
              <Meta>
                {tc("result.rows", receivedRows(result), { elapsed })}
              </Meta>
            </Header>
          );
          notice =
            outcome.outcome === "cancelled" ? (
              <Notice icon={<CancelledIcon />} title={t("result.cancelled")}>
                {retained > 0
                  ? tc("result.stoppedRows", retained)
                  : t("result.stopped")}
              </Notice>
            ) : (
              <Notice icon={<ClockIcon />} title={t("result.expired")}>
                {idleTimeoutSecs % 60 === 0
                  ? tc("result.expiredRows", retained, {
                      minutes: idleTimeoutSecs / 60,
                    })
                  : tc("result.expiredRowsSeconds", retained, {
                      seconds: idleTimeoutSecs,
                    })}
              </Notice>
            );
          if (retained > 0) grid = gridOf(result, null);
          break;
        }
        case "discarded":
          header = name;
          body = (
            <Notice icon={<TrashIcon />} title={t("result.discarded")}>
              {discardedByEnd
                ? t("result.discardedByEnd")
                : t("result.discardedDetail")}
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
      if (stopped !== null && outcome.outcome !== "failed") {
        notice = (
          <>
            {notice}
            <p className="text-small text-fg-2 shrink-0 px-4 pt-3">{stopped}</p>
          </>
        );
      }
      break;
    }
    case "rejected": {
      const { rejection } = state;
      // 여러 문장의 실행 가운데 보내지 못한 문장이면 결과 탭과 멈춘 안내를 둔다.
      if (tabs !== null) header = tabs;
      const { retry } = rejection;
      if (retry !== undefined) {
        body = (
          <TunnelFailed
            rejection={rejection}
            retry={retry}
            onRetry={() => {
              if (tabId !== null) void retryRun(tabId, retry);
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
            {stopped !== null && (
              <p className="text-small text-fg-2">{stopped}</p>
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
      {runNotice?.kind === "reconnected" && tabId !== null && (
        <ReconnectedBanner
          onClose={() => useRuns.getState().dismissNotice(tabId)}
        />
      )}
      {runNotice?.kind === "transactionLost" && tabId !== null && (
        <TransactionLostBanner
          tx={runNotice}
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
      {ddl !== undefined && tabId !== null ? (
        // DDL은 다른 어떤 결과 상태보다 먼저 그린다. 닫으면 지난 결과가 그대로 있다.
        <DdlView tabId={tabId} view={ddl} />
      ) : (
        <>
          {header !== null && (
            <ResultBar>
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
            </ResultBar>
          )}
          {notice}
          {explain}
          {grid}
          {body !== null && (
            <div className="min-h-0 flex-1 overflow-auto">{body}</div>
          )}
        </>
      )}
      <Toast message={toast.message} />
    </section>
  );
});

/** 끝난 결과가 tree로 그릴 EXPLAIN이면 그 plan과 서버가 준 줄. 아니면 null이다. */
function planOf(result: ResultData): { plan: Plan; lines: string[] } | null {
  if (result.firstRow !== 0 || !isPlanResult(result.columns)) return null;
  const lines = result.rows.map((row) => row[0] ?? "");
  const plan = parsePlan(lines);
  return plan === null ? null : { plan, lines };
}

function rowsMeta(result: ResultData): string {
  return t("result.rowsMore", {
    count: formatCount(receivedRows(result)),
    elapsed: formatElapsed(result.elapsedMicros ?? 0),
  });
}

/** `Stopped at statement 3. Statement 4 was not run.` `stoppedAt`은 0부터 센다. */
function stoppedText(stoppedAt: number, count: number): string {
  const first = stoppedAt + 2;
  return `${t("result.stoppedAt", { n: stoppedAt + 1 })} ${tc(
    "result.notRunRest",
    count - first + 1,
    { first, last: count },
  )}`;
}

const TAB_CLASS =
  "text-small inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[6px] border-0 px-2.5 font-medium";

/**
 * header의 결과 탭. 문장이 하나면 탭 하나이고, 여러 문장의 실행이면 `tabs`(문장마다 탭)를 그린다.
 */
function Header({
  sql,
  tabs,
  children,
}: {
  sql: string;
  tabs: ReactNode;
  children?: ReactNode;
}) {
  // batch, 알림, 선택마다 다시 그려지므로 label은 실행마다 한 번 만든다.
  const label = useMemo(() => resultLabel(sql), [sql]);
  return (
    <>
      {tabs ?? <SingleTab>{label}</SingleTab>}
      {children}
    </>
  );
}

/**
 * 여러 문장의 결과 탭. fg-3 번호와 문장 이름이다. 오류로 끝난 문장은 Error, 멈춰서 보내지 않은 문장은
 * Not run이다. 결과가 없는 문장(보내지 않았거나 아직 차례가 오지 않은 문장)은 누를 수 없다.
 */
function ScriptTabs({
  tabId,
  script,
  current,
}: {
  tabId: string;
  script: ScriptRun;
  /** 지금 문장의 상태 */
  current: RunState | undefined;
}) {
  const { steps } = script;
  const labels = useMemo(
    () => steps.map((step) => resultLabel(step.sql)),
    [steps],
  );
  // 서버 오류로 끝났거나 보내지 못한 문장은 Error다.
  const failed =
    current?.status === "rejected" ||
    (current?.status === "finished" && current.outcome.outcome === "failed");
  return (
    <div
      role="tablist"
      aria-label={t("result.tabs")}
      className="flex min-w-0 gap-0.5 overflow-x-auto"
    >
      {steps.map((_, index) => {
        const hasResult = index <= script.current;
        const selected = index === script.selected;
        let content: ReactNode = labels[index];
        if (index === script.current && failed) {
          content = (
            <>
              <ErrorIcon />
              {t("result.errorTab")}
            </>
          );
        } else if (!hasResult && script.stoppedAt !== null) {
          content = t("result.notRun");
        }
        const tone = selected
          ? "bg-bg-3 text-fg cursor-default"
          : hasResult
            ? "text-fg-2 cursor-pointer bg-transparent"
            : "text-fg-3 cursor-default bg-transparent";
        return (
          <button
            key={index}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-disabled={hasResult ? undefined : true}
            className={`${TAB_CLASS} ${tone}`}
            onClick={() => useRuns.getState().selectStep(tabId, index)}
          >
            <span className="text-fg-3 font-mono">{index + 1}</span> {content}
          </button>
        );
      })}
    </div>
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

/** 실행, 새 탭, Reformat 단축키 안내. 결과 panel의 빈 상태와 탭이 없는 에디터 자리가 같이 쓴다. */
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
      <span className="flex items-center gap-2">
        <Kbd>{shortcutLabel("reformat")}</Kbd>
        {t("result.hintReformat")}
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
  tabId,
  result,
  outcome,
  connection,
  stopped,
  copy,
  failedTransaction,
}: {
  tabId: string | null;
  result: ResultData;
  outcome: Extract<Outcome, { outcome: "failed" }>;
  /** 탭의 접속. 없으면 timeout과 read-only의 설명을 붙일 수 없다. */
  connection: Connection | undefined;
  /** 여러 문장의 실행이 이 오류에서 멈췄으면 그 안내 */
  stopped: string | null;
  copy(text: string, message: string): Promise<void>;
  /** 이 오류로 트랜잭션이 실패한 상태면 제목과 Rollback, 안내를 더한다. */
  failedTransaction?: { disabled: boolean; onRollback(): void };
}) {
  const { error } = outcome;
  // 문서가 따라 옮긴 위치는 이 component의 입력이 아니므로, 에디터가 바뀔 때마다 다시 읽는다.
  // 위치가 달라졌을 때만 다시 그린다.
  const moved = useEditorStatus(
    useShallow(() =>
      tabId === null ? null : anchorLocation(tabId, result.runKey),
    ),
  );
  const canGo = error.position !== null && moved !== null;
  const location =
    error.position === null
      ? null
      : errorLocation(result, error.position, moved ?? result.origin);
  // 접속의 statement_timeout이 끊은 문장은 서버 오류 57014로 온다. 접속에 timeout이 없으면 사용자의 cancel 등 다른 이유다.
  const timeout =
    error.code === TIMEOUT_CODE ? (connection?.statementTimeout ?? null) : null;
  const readOnly =
    error.code === READ_ONLY_CODE && connection?.readOnly === true;
  const explanation =
    timeout !== null
      ? t("result.timeoutDetail", { secs: timeout })
      : readOnly
        ? t("result.readOnlyDetail", { connection: connection.name })
        : null;
  return (
    <MessageBlock
      icon={
        failedTransaction
          ? WarningIcon
          : timeout !== null
            ? ClockIcon
            : readOnly
              ? LockIcon
              : ErrorIcon
      }
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {failedTransaction && (
          <TransactionFailedHeader {...failedTransaction} />
        )}
        {timeout !== null && (
          <p className="text-small text-fg font-medium">
            {t("result.timedOut")}
          </p>
        )}
        <p className="text-body font-mono break-words">{error.message}</p>
        {stopped !== null && <p className="text-small text-fg-2">{stopped}</p>}
        {error.detail !== null && (
          <p className="text-small text-fg">{error.detail}</p>
        )}
        {error.hint !== null && (
          <p className="text-small text-fg-2">{error.hint}</p>
        )}
        <div className="text-small text-fg-2 flex gap-4">
          <span>
            {explanation === null
              ? t("result.sqlstate", { code: error.code })
              : `${t("result.sqlstate", { code: error.code })} · ${explanation}`}
          </span>
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
        {failedTransaction && (
          <p className="text-small text-fg-2">{failedHintOf(error.code)}</p>
        )}
        <div className="flex gap-2">
          {error.position !== null && (
            <Button
              disabled={!canGo}
              onClick={() => {
                if (tabId !== null) goToError(tabId);
              }}
            >
              {t("result.goToError")}
            </Button>
          )}
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
