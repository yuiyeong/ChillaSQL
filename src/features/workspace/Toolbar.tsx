import { useRef, useState } from "react";
import { connectionColor } from "../connections/colors";
import { useEditorStatus } from "../editor/editorStatus";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { useRuns } from "../query/runsStore";
import { Button } from "../../shared/ui/Button";
import {
  ChevronDownIcon,
  PlayIcon,
  StopIcon,
  TunnelIcon,
} from "../../shared/ui/icons";
import { Kbd } from "../../shared/ui/Kbd";
import { Menu, MenuItem, MenuSeparator } from "../../shared/ui/Menu";
import { changeConnection, execute } from "./commands";
import { t } from "../../shared/i18n/t";

/** 실행 버튼의 너비. label이 바뀌어도 toolbar가 움직이지 않도록 고정한다. */
const RUN_WIDTH = 200;
const CHOOSE_WIDTH = 26;
const CANCEL_WIDTH = 227;
/** menu 너비에서 border 2px과 padding 8px을 뺀 안쪽 너비 */
const CONNECTION_MENU_WIDTH = 290;
const RUN_MENU_WIDTH = 230;

const RUN_KEYS = "⌘↵";
const CANCEL_KEYS = "⌘F2";

/** 접속의 색 dot. 색을 정하지 않은 접속은 line-2, 접속이 없으면 빈 원이다. */
function Dot({ color }: { color: string | null | undefined }) {
  if (color === undefined) {
    return (
      <span
        aria-hidden="true"
        className="border-fg-3 size-2 shrink-0 rounded-full border-[1.5px]"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full"
      style={{ background: connectionColor(color) ?? "var(--color-line-2)" }}
    />
  );
}

/** 활성 탭의 접속 chip과 menu, 실행 버튼. 활성 탭이 없으면 모두 disabled다. */
export function Toolbar({ onAddConnection }: { onAddConnection(): void }) {
  const tab = useTabs((s) => s.tabs.find((tab) => tab.id === s.activeId));
  const tabId = tab?.id ?? null;
  const connections = useProject((s) => s.project?.connections ?? []);
  const status = useRuns((s) =>
    tabId === null ? undefined : s.runs[tabId]?.status,
  );
  const waitingForRow = useRuns((s) => {
    const run = tabId === null ? undefined : s.runs[tabId];
    return (
      run?.status === "connecting" ||
      (run?.status === "running" && run.result.rows.length === 0)
    );
  });
  const hasSelection = useEditorStatus(
    (s) => s.tabId === tabId && s.hasSelection,
  );
  const [connectionMenu, setConnectionMenu] = useState(false);
  const [runMenu, setRunMenu] = useState(false);
  const chipRef = useRef<HTMLButtonElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);

  const current = connections.find((c) => c.name === tab?.connection);
  const connected = tab?.connection != null;
  const busy = status === "connecting" || status === "running";
  const canRun = tab !== undefined && connected;
  // 실행이 시작되면 열려 있던 run menu를 닫는다. 안 닫으면 실행이 끝나 split 버튼이 돌아올 때 다시 열린다.
  if (busy && runMenu) setRunMenu(false);
  const runLabel = hasSelection
    ? t("toolbar.runSelection")
    : t("toolbar.runStatement");

  return (
    <div className="relative shrink-0">
      <div
        role="toolbar"
        aria-label={t("toolbar.label")}
        className="border-line-1 bg-bg-1 flex h-11 items-center gap-2.5 border-b px-3"
      >
        <button
          ref={chipRef}
          type="button"
          aria-label={t("toolbar.changeConnection")}
          aria-haspopup="menu"
          aria-expanded={connectionMenu}
          disabled={tab === undefined}
          className={[
            "text-body text-fg rounded-control focus-visible:outline-accent inline-flex h-7 cursor-pointer items-center gap-2 border px-2.5 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-default disabled:opacity-50",
            connected
              ? "border-line-2 bg-bg-2"
              : "border-line-2 border-dashed bg-transparent",
          ].join(" ")}
          onClick={() => setConnectionMenu((open) => !open)}
        >
          {connected ? (
            <>
              <Dot color={current?.color ?? null} />
              <span className="font-medium">{tab.connection}</span>
              {current !== undefined && (
                <span className="text-small text-fg-2 font-mono">
                  {current.database}
                </span>
              )}
            </>
          ) : (
            <>
              <Dot color={undefined} />
              <span className="text-fg-2">{t("toolbar.chooseConnection")}</span>
            </>
          )}
          <ChevronDownIcon
            className={`text-fg-2 ${connectionMenu ? "rotate-180" : ""}`}
          />
        </button>
        <Menu
          open={connectionMenu}
          onClose={() => setConnectionMenu(false)}
          anchor={chipRef}
          label={t("toolbar.connections")}
        >
          <div style={{ width: CONNECTION_MENU_WIDTH }}>
            {connections.map((c) => (
              <MenuItem
                key={c.name}
                checked={c.name === tab?.connection}
                onSelect={() => {
                  if (tabId !== null) void changeConnection(tabId, c.name);
                }}
              >
                <Dot color={c.color} />
                <span className="font-medium">{c.name}</span>
                {c.tunnel !== null && (
                  <TunnelIcon className="text-fg-2 shrink-0" />
                )}
                <span className="text-label text-fg-3 min-w-0 flex-1 truncate text-right font-mono">
                  {`${c.host}:${c.port}/${c.database}`}
                </span>
              </MenuItem>
            ))}
            {connections.length > 0 && <MenuSeparator />}
            <MenuItem onSelect={onAddConnection}>
              <span className="text-fg-2">{t("toolbar.addConnection")}</span>
            </MenuItem>
          </div>
        </Menu>

        <div className="flex-1" />

        {busy ? (
          <Button
            disabled={status === "connecting"}
            style={{ width: CANCEL_WIDTH }}
            className="pr-2 pl-3"
            onClick={() => void execute("cancel")}
          >
            <StopIcon />
            <span className="flex-1 text-left">{t("common.cancel")}</span>
            <Kbd>{CANCEL_KEYS}</Kbd>
          </Button>
        ) : (
          <span className="flex">
            <Button
              variant="primary"
              disabled={!canRun}
              style={{ width: RUN_WIDTH }}
              className="rounded-r-none pr-2 pl-3"
              onClick={() => void execute("run")}
            >
              <PlayIcon />
              <span className="flex-1 text-left">{runLabel}</span>
              <Kbd>{RUN_KEYS}</Kbd>
            </Button>
            <Button
              ref={chooseRef}
              variant="primary"
              aria-label={t("toolbar.chooseWhatToRun")}
              aria-haspopup="menu"
              aria-expanded={runMenu}
              disabled={!canRun}
              style={{ width: CHOOSE_WIDTH, padding: 0 }}
              className="ml-px justify-center rounded-l-none"
              onClick={() => setRunMenu((open) => !open)}
            >
              <ChevronDownIcon />
            </Button>
            <Menu
              open={runMenu}
              onClose={() => setRunMenu(false)}
              anchor={chooseRef}
              align="end"
              label={t("toolbar.whatToRun")}
            >
              <div style={{ width: RUN_MENU_WIDTH }}>
                <MenuItem onSelect={() => void execute("run")}>
                  <span className="flex-1 text-left">{runLabel}</span>
                  <Kbd>{RUN_KEYS}</Kbd>
                </MenuItem>
                <MenuItem disabled onSelect={() => {}}>
                  <span className="flex-1 text-left">
                    {t("toolbar.runFile")}
                  </span>
                </MenuItem>
              </div>
            </Menu>
          </span>
        )}
      </div>
      {waitingForRow && (
        <div
          aria-hidden="true"
          data-testid="progress-bar"
          className="bg-bg-2 pointer-events-none absolute inset-x-0 top-full z-10 h-0.5 overflow-hidden"
        >
          <span className="bg-accent animate-progress block h-full w-[28%] motion-reduce:animate-none" />
        </div>
      )}
    </div>
  );
}
