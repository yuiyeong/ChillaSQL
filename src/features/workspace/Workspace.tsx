import { useRef, useState, type PointerEvent } from "react";
import type { Connection, Project } from "../../shared/api/types";
import { ConnectionForm } from "../connections/ConnectionForm";
import { saveTab } from "../editor/saveTab";
import { SqlEditor } from "../editor/SqlEditor";
import { TabBar } from "../editor/TabBar";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { Sidebar } from "../project/Sidebar";
import { Hints, ResultPane } from "../query/ResultPane";
import { connectionColor } from "../connections/colors";
import {
  applySavedProject,
  closeTab,
  execute,
  switchProject,
} from "./commands";
import { useShortcuts } from "./shortcuts";
import { StatusBar } from "./StatusBar";
import { Toolbar } from "./Toolbar";
import { t } from "../../shared/i18n/t";

/** 연 접속 form. 열 때마다 새 object라서 닫은 form의 늦은 onSaved를 가려낸다. */
interface OpenForm {
  original: Connection | null;
}

/** 결과 panel의 처음 높이 */
const RESULT_HEIGHT = 396;
/** 에디터와 결과 panel이 각각 줄어들 수 있는 가장 낮은 높이 */
const MIN_PANE = 120;

/** 프로젝트가 열린 뒤의 화면. 왼쪽 sidebar, 오른쪽에 탭, toolbar, 에디터, 결과. */
export function Workspace() {
  const activeId = useTabs((s) => s.activeId);
  const connectionName = useTabs(
    (s) => s.tabs.find((tab) => tab.id === s.activeId)?.connection ?? null,
  );
  const hasConnection = connectionName !== null;
  const openFile = useTabs((s) => s.openFile);
  const markDirty = useTabs((s) => s.markDirty);
  const project = useProject((s) => s.project);
  const error = useProject((s) => s.error);
  const clearError = useProject((s) => s.clearError);
  const [form, setForm] = useState<OpenForm | null>(null);
  const [resultHeight, setResultHeight] = useState(RESULT_HEIGHT);
  const editorRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    startY: number;
    startHeight: number;
    max: number;
  } | null>(null);
  const barColor =
    connectionColor(
      project?.connections.find((c) => c.name === connectionName)?.color ??
        null,
    ) ?? "var(--color-line-2)";
  // 접속 form이 열려 있으면 뒤의 탭을 실행하거나 닫지 않는다.
  useShortcuts(form === null);

  function editConnection(name: string) {
    const original = project?.connections.find((c) => c.name === name);
    if (original !== undefined) setForm({ original });
  }

  /** form을 닫은 뒤에 저장이 끝나도 접속은 반영한다. 그 사이 새로 연 form은 닫지 않는다. */
  function connectionSaved(saved: Project, from: OpenForm) {
    void applySavedProject(saved);
    setForm((current) => (current === from ? null : current));
  }

  function nameTab(path: string) {
    if (activeId !== null) void saveTab(activeId, path);
  }

  function startDrag(e: PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const editorHeight = editorRef.current?.clientHeight ?? 0;
    drag.current = {
      startY: e.clientY,
      startHeight: resultHeight,
      max: Math.max(MIN_PANE, editorHeight + resultHeight - MIN_PANE),
    };
  }

  function moveDrag(e: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (current === null) return;
    const next = current.startHeight - (e.clientY - current.startY);
    setResultHeight(Math.min(current.max, Math.max(MIN_PANE, next)));
  }

  function endDrag(e: PointerEvent<HTMLDivElement>) {
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }

  return (
    <div className="bg-bg-0 text-fg flex h-screen flex-col">
      <div
        aria-hidden="true"
        data-testid="connection-bar"
        className="h-[3px] shrink-0"
        style={{ background: barColor }}
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[248px] shrink-0 flex-col">
          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0">
              <Sidebar
                onOpenFile={(path) => void openFile(path)}
                onAddConnection={() => setForm({ original: null })}
                onEditConnection={editConnection}
                onSwitchProject={() => void switchProject()}
              />
            </div>
          </div>
          {error !== null && (
            <div
              role="alert"
              className="border-line-1 bg-bg-0 shrink-0 border-t border-r"
            >
              <button
                type="button"
                className="text-small text-danger hover:bg-bg-2 block w-full px-3 py-2 text-left break-words"
                onClick={clearError}
              >
                {error}
              </button>
            </div>
          )}
        </div>

        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar
            onClose={(id) => void closeTab(id)}
            onNew={() => void execute("newTab")}
            onName={nameTab}
          />
          <Toolbar />
          <div
            ref={editorRef}
            className="bg-bg-1 relative min-h-[120px] min-w-0 flex-1"
          >
            <div className="absolute inset-0">
              {activeId !== null ? (
                <SqlEditor tabId={activeId} onDocChange={markDirty} />
              ) : (
                <Hints />
              )}
            </div>
          </div>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label={t("workspace.resizeResults")}
            aria-valuenow={resultHeight}
            aria-valuemin={MIN_PANE}
            className="border-line-1 bg-bg-0 flex h-[5px] shrink-0 touch-none items-center justify-center border-t"
            style={{ cursor: "row-resize" }}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <span className="bg-line-2 h-[3px] w-9 rounded-[2px]" />
          </div>
          <div
            className="relative min-h-[120px] shrink"
            style={{ flex: `0 1 ${resultHeight}px` }}
          >
            <div className="absolute inset-0">
              <ResultPane tabId={activeId} hasConnection={hasConnection} />
            </div>
          </div>
          <StatusBar tabId={activeId} />
        </main>
      </div>

      {form !== null && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
          <ConnectionForm
            key={form.original?.name ?? "new"}
            original={form.original}
            existingNames={project?.connections.map((c) => c.name) ?? []}
            onSaved={(saved) => connectionSaved(saved, form)}
            onClose={() => setForm(null)}
          />
        </div>
      )}
    </div>
  );
}
