import { connectionColor } from "../connections/colors";
import { useProject } from "../project/projectStore";
import { CloseIcon, PlusIcon } from "../../shared/ui/icons";
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

  const namingTab =
    naming !== null && naming === activeId
      ? tabs.find((tab) => tab.id === naming)
      : undefined;

  /** 접속이 없으면 null, 색을 정하지 않은 접속이면 line-2다. */
  function dotColor(connection: string | null): string | null {
    if (connection === null) return null;
    const color = connections?.find((c) => c.name === connection)?.color;
    return connectionColor(color ?? null) ?? "var(--color-line-2)";
  }

  return (
    <>
      <div
        data-tauri-drag-region
        data-testid="tab-row"
        className="border-line-1 bg-bg-0 flex h-[38px] shrink-0 items-end border-b"
      >
        <div
          role="tablist"
          aria-label={t("tabs.list")}
          className="flex min-w-0 items-end gap-0.5 px-2"
        >
          {tabs.map((tab) => {
            const selected = tab.id === activeId;
            const color = dotColor(tab.connection);
            return (
              <div
                key={tab.id}
                className={[
                  "group text-small flex h-[31px] max-w-[220px] min-w-0 items-center gap-1 rounded-t-[8px] border pr-2 pl-3",
                  selected
                    ? "bg-bg-1 text-fg border-line-1 border-b-bg-1 -mb-px"
                    : "text-fg-2 border-transparent",
                ].join(" ")}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="focus-visible:outline-accent flex min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-inherit focus-visible:outline-2 focus-visible:outline-offset-4"
                  onClick={() => activate(tab.id)}
                >
                  <span
                    aria-hidden="true"
                    data-testid="tab-dot"
                    className={
                      color === null
                        ? "border-fg-3 size-2 shrink-0 rounded-full border-[1.5px]"
                        : "size-2 shrink-0 rounded-full"
                    }
                    style={color === null ? undefined : { background: color }}
                  />
                  <span className="truncate">{tab.title}</span>
                </button>
                <span className="relative ml-1 size-[18px] shrink-0">
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
          <IconButton
            label={t("tabs.new")}
            className="mb-1 ml-1"
            onClick={onNew}
          >
            <PlusIcon />
          </IconButton>
        </div>
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
