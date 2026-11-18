import { useEffect, useId, useState } from "react";
import { homeDir } from "../../shared/api/path";
import { connectionColor } from "../connections/colors";
import { useTabs } from "../editor/tabsStore";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  RefreshIcon,
  SwitchIcon,
  TunnelIcon,
} from "../../shared/ui/icons";
import { IconButton } from "../../shared/ui/IconButton";
import {
  buildTree,
  projectInitials,
  shortenHome,
  type TreeNode,
} from "./fileTree";
import { useProject } from "./projectStore";
import { t } from "../../shared/i18n/t";

const LABEL = "text-label text-fg-2 m-0 font-semibold tracking-[0.04em]";

interface Row {
  node: TreeNode;
  depth: number;
}

/** 접힌 folder 안은 건너뛰고 화면에 보이는 줄만 순서대로 편다. */
function visibleRows(
  nodes: TreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): Row[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.kind === "folder" && !collapsed.has(node.path)
      ? visibleRows(node.children, collapsed, depth + 1)
      : []),
  ]);
}

const SEGMENTS = [
  { key: "sidebar.viewFiles", selected: true },
  { key: "sidebar.viewSchema", selected: false },
  { key: "sidebar.viewHistory", selected: false },
] as const;

export function Sidebar({
  onOpenFile,
  onAddConnection,
  onEditConnection,
  onSwitchProject,
}: {
  onOpenFile(path: string): void;
  onAddConnection(): void;
  onEditConnection(name: string): void;
  onSwitchProject(): void;
}) {
  const project = useProject((s) => s.project);
  const files = useProject((s) => s.files);
  const refreshFiles = useProject((s) => s.refreshFiles);
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const nameId = useId();
  const dirId = useId();
  const [home, setHome] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const dir = await homeDir();
        if (live) setHome(dir);
      } catch {
        // home을 모르면 전체 경로를 그대로 보여 준다.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (project === null) return null;

  const activePath = tabs.find((tab) => tab.id === activeId)?.path ?? null;
  const dirtyPaths = new Set(
    tabs.flatMap((tab) => (tab.dirty && tab.path !== null ? [tab.path] : [])),
  );
  const rows = visibleRows(buildTree(files), collapsed);

  function toggle(path: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  return (
    <aside
      aria-label={t("sidebar.label")}
      className="border-line-1 bg-bg-0 flex h-full w-full flex-col border-r"
    >
      <div
        data-tauri-drag-region
        data-testid="sidebar-drag"
        className="h-[38px] shrink-0"
      />

      <div className="px-2.5 pt-0.5 pb-3">
        <button
          type="button"
          aria-label={t("sidebar.switchProject")}
          aria-describedby={`${nameId} ${dirId}`}
          className="border-line-1 bg-bg-1 focus-visible:outline-accent flex w-full cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left focus-visible:outline-2"
          onClick={onSwitchProject}
        >
          <span
            aria-hidden="true"
            className="bg-bg-3 text-fg text-label flex size-[26px] shrink-0 items-center justify-center rounded-[6px] font-semibold"
          >
            {projectInitials(project.name)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span id={nameId} className="truncate font-semibold">
              {project.name}
            </span>
            <span id={dirId} className="text-label text-fg-2 truncate">
              {shortenHome(project.dir, home)}
            </span>
          </span>
          <SwitchIcon className="text-fg-2 shrink-0" />
        </button>
      </div>

      <section
        aria-label={t("sidebar.connections")}
        className="border-line-1 flex flex-col gap-px border-b px-1.5 pb-3"
      >
        <div className="flex items-center justify-between px-2 pb-1">
          <h3 className={LABEL}>{t("sidebar.connections")}</h3>
          <IconButton
            size={22}
            label={t("sidebar.addConnection")}
            onClick={onAddConnection}
          >
            <PlusIcon />
          </IconButton>
        </div>
        {project.connections.map((connection) => (
          <button
            key={connection.name}
            type="button"
            aria-label={t("sidebar.edit", { name: connection.name })}
            className="hover:bg-bg-2 focus-visible:outline-accent flex w-full cursor-pointer items-center gap-2.5 rounded-[6px] border-0 bg-transparent px-2 py-[5px] text-left focus-visible:outline-2"
            onClick={() => onEditConnection(connection.name)}
          >
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{
                background:
                  connectionColor(connection.color) ?? "var(--color-line-2)",
              }}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1.5 font-medium">
                <span className="truncate">{connection.name}</span>
                {connection.tunnel !== null && (
                  <span
                    role="img"
                    aria-label={t("sidebar.tunnel")}
                    className="text-fg-2 flex shrink-0"
                  >
                    <TunnelIcon />
                  </span>
                )}
              </span>
              <span className="text-label text-fg-3 truncate font-mono">
                {`${connection.host}:${connection.port}/${connection.database}`}
              </span>
            </span>
          </button>
        ))}
      </section>

      <div
        role="tablist"
        aria-label={t("sidebar.views")}
        className="border-line-2 bg-bg-2 rounded-control mx-2.5 mt-3 mb-2 flex gap-0.5 border p-0.5"
      >
        {SEGMENTS.map(({ key, selected }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-disabled={selected ? undefined : true}
            className={[
              "text-small h-[22px] flex-1 rounded-[5px] border-0 font-medium",
              selected
                ? "bg-bg-3 text-fg cursor-pointer"
                : "text-fg-2 cursor-default bg-transparent opacity-50",
            ].join(" ")}
          >
            {t(key)}
          </button>
        ))}
      </div>

      <section
        aria-label={t("sidebar.files")}
        className="flex min-h-0 flex-1 flex-col gap-px px-1.5 py-1"
      >
        <div className="flex items-center justify-between px-2 pb-1">
          <h3 className={LABEL}>{t("sidebar.files")}</h3>
          <IconButton
            size={22}
            label={t("sidebar.refresh")}
            onClick={() => void refreshFiles()}
          >
            <RefreshIcon />
          </IconButton>
        </div>
        <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-y-auto p-0">
          {rows.map(({ node, depth }) => {
            const active = node.kind === "file" && node.path === activePath;
            const className = [
              "text-small text-fg focus-visible:outline-accent flex h-[26px] w-full cursor-pointer items-center gap-1.5 rounded-[6px] border-0 pr-2 text-left focus-visible:outline-2",
              active ? "bg-accent/14" : "hover:bg-bg-2 bg-transparent",
            ].join(" ");
            const style = { paddingLeft: `${8 + depth * 16}px` };
            return (
              <li key={node.path}>
                {node.kind === "folder" ? (
                  <button
                    type="button"
                    aria-expanded={!collapsed.has(node.path)}
                    className={className}
                    style={style}
                    onClick={() => toggle(node.path)}
                  >
                    {collapsed.has(node.path) ? (
                      <ChevronRightIcon className="text-fg-2 shrink-0" />
                    ) : (
                      <ChevronDownIcon className="text-fg-2 shrink-0" />
                    )}
                    <FolderIcon className="text-fg-2 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    className={className}
                    style={style}
                    onClick={() => onOpenFile(node.path)}
                  >
                    <FileIcon className="text-fg-3 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    {dirtyPaths.has(node.path) && (
                      <span
                        role="img"
                        aria-label={t("tabs.unsaved")}
                        className="bg-fg size-1.5 shrink-0 rounded-full"
                      />
                    )}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}
