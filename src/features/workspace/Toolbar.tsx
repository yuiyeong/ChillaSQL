import { useRef, useState } from "react";
import { ConnectionDot } from "../connections/ConnectionDot";
import { TunnelChipStatus } from "../connections/TunnelStatus";
import { isTunnelStarting, useTunnels } from "../connections/tunnelsStore";
import { connectionTarget } from "../connections/connectionTarget";
import { useEditorStatus } from "../editor/editorStatus";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { useRuns } from "../query/runsStore";
import { Button } from "../../shared/ui/Button";
import {
  ChevronDownIcon,
  PlayIcon,
  ReformatIcon,
  StopIcon,
  TunnelIcon,
} from "../../shared/ui/icons";
import { Kbd } from "../../shared/ui/Kbd";
import { Menu, MenuItem, MenuSeparator } from "../../shared/ui/Menu";
import { changeConnection, execute } from "./commands";
import { shortcutKeys, shortcutLabel } from "./shortcuts";
import { TransactionControls } from "./TransactionControls";
import { t } from "../../shared/i18n/t";
import type { Connection } from "../../shared/api/types";

/** 실행 버튼의 너비. label이 바뀌어도 toolbar가 움직이지 않도록 고정한다. */
const RUN_WIDTH = 200;
const CHOOSE_WIDTH = 26;
const ICON_WIDTH = 28;
const CANCEL_WIDTH = 227;
/** menu 너비에서 border 2px과 padding 8px을 뺀 안쪽 너비 */
const CONNECTION_MENU_WIDTH = 290;
const RUN_MENU_WIDTH = 230;
/** 프로젝트가 없을 때의 접속 목록. selector가 매번 새 배열을 돌려주면 다시 그리기를 멈추지 않는다. */
const NO_CONNECTIONS: Connection[] = [];

/** 활성 탭의 접속 chip과 menu, 실행 버튼. 활성 탭이 없으면 모두 disabled다. */
export function Toolbar({
  onAddConnection,
  connectionMenuOpen: connectionMenu,
  onConnectionMenuChange: setConnectionMenu,
}: {
  onAddConnection(): void;
  /** 접속 menu의 열림. sidebar의 Choose connection도 열므로 Workspace가 갖는다. */
  connectionMenuOpen: boolean;
  onConnectionMenuChange(open: boolean): void;
}) {
  const tab = useTabs((s) => s.tabs.find((tab) => tab.id === s.activeId));
  const tabId = tab?.id ?? null;
  const connections = useProject(
    (s) => s.project?.connections ?? NO_CONNECTIONS,
  );
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
  const tunnelStarting = useTunnels((s) =>
    isTunnelStarting(s.tunnels, tab?.connection ?? null),
  );
  const chipRef = useRef<HTMLButtonElement>(null);

  const current = connections.find((c) => c.name === tab?.connection);
  const connected = tab?.connection != null;
  const busy = status === "connecting" || status === "running";

  return (
    <div className="relative shrink-0">
      <div
        role="toolbar"
        aria-label={t("toolbar.label")}
        className="border-line-1 bg-bg-1 flex h-11 items-center gap-2.5 border-b px-3"
      >
        <Button
          ref={chipRef}
          variant={connected ? "secondary" : "dashed"}
          size="chip"
          aria-label={t("toolbar.changeConnection")}
          aria-haspopup="menu"
          aria-expanded={connectionMenu}
          disabled={tab === undefined}
          onClick={() => setConnectionMenu(!connectionMenu)}
        >
          {connected ? (
            <>
              <ConnectionDot color={current?.color ?? null} />
              <span className="font-medium">{tab.connection}</span>
              {current !== undefined && (
                <span className="text-small text-fg-2 font-mono">
                  {current.database}
                </span>
              )}
              {tab.connection !== null && (
                <TunnelChipStatus connection={tab.connection} />
              )}
            </>
          ) : (
            <>
              <ConnectionDot color={undefined} />
              <span className="text-fg-2">{t("toolbar.chooseConnection")}</span>
            </>
          )}
          <ChevronDownIcon
            className={`text-fg-2 ${connectionMenu ? "rotate-180" : ""}`}
          />
        </Button>
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
                <ConnectionDot color={c.color} />
                <span className="font-medium">{c.name}</span>
                {c.tunnel !== null && (
                  <TunnelIcon className="text-fg-2 shrink-0" />
                )}
                <span className="text-label text-fg-3 min-w-0 flex-1 truncate text-right font-mono">
                  {connectionTarget(c)}
                </span>
              </MenuItem>
            ))}
            {connections.length > 0 && <MenuSeparator />}
            <MenuItem onSelect={onAddConnection}>
              <span className="text-fg-2">{t("toolbar.addConnection")}</span>
            </MenuItem>
          </div>
        </Menu>

        <TransactionControls tabId={tabId} />

        <Button
          variant="ghost"
          size="icon"
          aria-label={t("toolbar.reformat")}
          aria-keyshortcuts={shortcutKeys("reformat")}
          disabled={tab === undefined}
          style={{ width: ICON_WIDTH }}
          onClick={() => void execute("reformat")}
        >
          <ReformatIcon />
        </Button>
        <div aria-hidden="true" className="bg-line-2 h-[18px] w-px shrink-0" />

        {busy ? (
          <Button
            size="kbd"
            // 연결 중에는 터널이 시작 중일 때만 멈출 수 있다(그 터널 시작을 멈춘다).
            disabled={status === "connecting" && !tunnelStarting}
            aria-keyshortcuts={shortcutKeys("cancel")}
            style={{ width: CANCEL_WIDTH }}
            onClick={() => void execute("cancel")}
          >
            <StopIcon />
            <span className="flex-1 text-left">{t("common.cancel")}</span>
            <Kbd>{shortcutLabel("cancel")}</Kbd>
          </Button>
        ) : (
          <RunSplitButton
            disabled={!connected}
            label={
              hasSelection
                ? t("toolbar.runSelection")
                : t("toolbar.runStatement")
            }
          />
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

/**
 * 실행 버튼과 실행할 것을 고르는 menu. 실행 중에는 취소 버튼이 이 자리를 차지하므로
 * menu 상태도 함께 사라진다(실행이 끝나 돌아와도 menu가 다시 열리지 않는다).
 */
function RunSplitButton({
  disabled,
  label,
}: {
  disabled: boolean;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const keys = shortcutKeys("run");
  const keyLabel = shortcutLabel("run");
  return (
    <span className="flex">
      <Button
        variant="primary"
        size="kbd"
        disabled={disabled}
        aria-keyshortcuts={keys}
        style={{ width: RUN_WIDTH }}
        className="rounded-r-none"
        onClick={() => void execute("run")}
      >
        <PlayIcon />
        <span className="flex-1 text-left">{label}</span>
        <Kbd>{keyLabel}</Kbd>
      </Button>
      <Button
        ref={chooseRef}
        variant="primary"
        size="icon"
        aria-label={t("toolbar.chooseWhatToRun")}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        style={{ width: CHOOSE_WIDTH }}
        className="ml-px rounded-l-none"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDownIcon />
      </Button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={chooseRef}
        align="end"
        label={t("toolbar.whatToRun")}
      >
        <div style={{ width: RUN_MENU_WIDTH }}>
          <MenuItem keyShortcuts={keys} onSelect={() => void execute("run")}>
            <span className="flex-1 text-left">{label}</span>
            <Kbd>{keyLabel}</Kbd>
          </MenuItem>
          <MenuItem disabled onSelect={() => {}}>
            <span className="flex-1 text-left">{t("toolbar.runFile")}</span>
          </MenuItem>
        </div>
      </Menu>
    </span>
  );
}
