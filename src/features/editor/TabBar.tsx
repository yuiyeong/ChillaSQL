import { useEffect, useRef } from "react";
import { ConnectionDot } from "../connections/ConnectionDot";
import { TunnelTabIcon } from "../connections/TunnelStatus";
import { useProject } from "../project/projectStore";
import { useRuns } from "../query/runsStore";
import { useElapsed } from "../query/useElapsed";
import type { TxInfo } from "../query/transaction";
import { CloseIcon, PlusIcon } from "../../shared/ui/icons";
import type { ConnectionColor } from "../../shared/api/types";
import { IconButton } from "../../shared/ui/IconButton";
import { SaveNameDialog } from "./SaveNameDialog";
import { useTabs } from "./tabsStore";
import { t } from "../../shared/i18n/t";

interface TabBarProps {
  onClose(id: string): void;
  onNew(): void;
  onName(path: string): void;
}

/** 탭 줄. 창의 title bar를 겸하므로 빈 자리와 줄 자체는 창을 끄는 자리다. */
export function TabBar({ onClose, onNew, onName }: TabBarProps) {
  const tabs = useTabs((state) => state.tabs);
  const activeId = useTabs((state) => state.activeId);
  const naming = useTabs((state) => state.naming);
  const error = useTabs((state) => state.error);
  const activate = useTabs((state) => state.activate);
  const requestName = useTabs((state) => state.requestName);
  const setError = useTabs((state) => state.setError);
  const connections = useProject((state) => state.project?.connections);
  const transactions = useRuns((state) => state.transactions);

  const scroller = useRef<HTMLDivElement>(null);

  // 탭이 많아 줄이 스크롤되면 활성 탭이 보이는 자리로 옮긴다.
  useEffect(() => {
    scroller.current
      ?.querySelector<HTMLElement>('[data-selected="true"]')
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId, tabs.length]);

  const namingTab =
    naming !== null && naming === activeId
      ? tabs.find((tab) => tab.id === naming)
      : undefined;

  /** 접속이 없으면 undefined(빈 원), 있으면 그 접속의 color 이름이다. */
  function dotColor(
    connection: string | null,
  ): ConnectionColor | null | undefined {
    if (connection === null) return undefined;
    return connections?.find((c) => c.name === connection)?.color ?? null;
  }

  return (
    <>
      <div
        data-tauri-drag-region
        data-testid="tab-row"
        className="bg-bg-0 flex h-[38px] shrink-0 items-end shadow-[inset_0_-1px_0_var(--color-line-1)]"
      >
        {/* 탭이 많으면 이 안에서 스크롤한다. 줄의 아래 선은 inset shadow라서 스크롤이 활성 탭을 자르지 않는다. */}
        <div
          ref={scroller}
          data-testid="tab-scroller"
          className="flex min-w-0 [scrollbar-width:none] items-end overflow-x-auto pl-2 [&::-webkit-scrollbar]:hidden"
        >
          <div
            role="tablist"
            aria-label={t("tabs.list")}
            className="flex items-end gap-0.5"
          >
            {tabs.map((tab) => {
              const selected = tab.id === activeId;
              const color = dotColor(tab.connection);
              return (
                <div
                  key={tab.id}
                  data-selected={selected}
                  className={[
                    "group text-small flex h-[31px] max-w-[220px] min-w-24 shrink-0 items-center rounded-t-[8px] border pr-2",
                    selected
                      ? "bg-bg-1 text-fg border-line-1 border-b-bg-1"
                      : "text-fg-2 border-transparent",
                  ].join(" ")}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className="focus-visible:outline-accent flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent pr-1 pl-3 text-inherit focus-visible:outline-2 focus-visible:-outline-offset-2"
                    onClick={() => activate(tab.id)}
                  >
                    <ConnectionDot color={color} testId="tab-dot" />
                    <span className="truncate">{tab.title}</span>
                  </button>
                  {transactions[tab.id] !== undefined && (
                    <TransactionBadge tx={transactions[tab.id]} />
                  )}
                  <span className="mr-1 inline-flex">
                    <TunnelTabIcon connection={tab.connection} />
                  </span>
                  <span className="relative size-[18px] shrink-0">
                    {tab.dirty && (
                      <span
                        role="img"
                        aria-label={t("tabs.unsaved")}
                        className="bg-fg absolute inset-0 m-auto size-[7px] rounded-full group-focus-within:opacity-0 group-hover:opacity-0"
                      />
                    )}
                    <button
                      type="button"
                      aria-label={t("tabs.close", { title: tab.title })}
                      className={[
                        "text-fg-2 hover:bg-bg-3 hover:text-fg focus-visible:outline-accent absolute inset-0 flex cursor-pointer items-center justify-center rounded-[4px] border-0 bg-transparent focus-visible:outline-2",
                        tab.dirty
                          ? "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                          : "",
                      ].join(" ")}
                      onClick={() => onClose(tab.id)}
                    >
                      <CloseIcon />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <IconButton
          label={t("tabs.new")}
          className="mr-1 mb-1 ml-1"
          onClick={onNew}
        >
          <PlusIcon />
        </IconButton>
        <div
          aria-hidden="true"
          data-tauri-drag-region
          data-testid="tab-row-spacer"
          className="flex-1 self-stretch"
        />
      </div>
      {namingTab !== undefined && (
        <SaveNameDialog
          title={namingTab.title}
          onSubmit={onName}
          onCancel={() => requestName(null)}
        />
      )}
      {error !== null && (
        <button
          type="button"
          className="text-small text-danger hover:bg-bg-2 border-line-1 block w-full shrink-0 truncate border-b px-3 py-1 text-left"
          onClick={() => setError(null)}
        >
          {error}
        </button>
      )}
    </>
  );
}

/** 열린 트랜잭션이 있는 탭의 `TX 3:12`. 탭 이름에 섞이지 않게 탭 button 밖에 둔다. */
function TransactionBadge({ tx }: { tx: TxInfo }) {
  const elapsed = useElapsed(tx.openedAt);
  return (
    <span
      role="img"
      aria-label={t("tx.badgeLabel", { elapsed })}
      className="text-label border-line-2 text-fg mr-1 inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[4px] border px-1.5 font-medium whitespace-nowrap"
    >
      {t("tx.badge")} <span className="font-mono">{elapsed}</span>
    </span>
  );
}
