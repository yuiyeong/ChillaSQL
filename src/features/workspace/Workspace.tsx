import { useState } from "react";
import type { Connection, Project } from "../../shared/api/types";
import { ConnectionForm } from "../connections/ConnectionForm";
import { saveTab } from "../editor/saveTab";
import { SqlEditor } from "../editor/SqlEditor";
import { TabBar } from "../editor/TabBar";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { Sidebar } from "../project/Sidebar";
import { ResultPane } from "../query/ResultPane";
import { closeTab, execute, switchProject } from "./commands";
import { useShortcuts } from "./shortcuts";
import { Toolbar } from "./Toolbar";

/** 연 접속 form. 열 때마다 새 object라서 닫은 form의 늦은 onSaved를 가려낸다. */
interface OpenForm {
  original: Connection | null;
}

/** 프로젝트가 열린 뒤의 화면. 왼쪽 sidebar, 오른쪽에 탭, toolbar, 에디터, 결과. */
export function Workspace() {
  const activeId = useTabs((s) => s.activeId);
  const openFile = useTabs((s) => s.openFile);
  const markDirty = useTabs((s) => s.markDirty);
  const project = useProject((s) => s.project);
  const error = useProject((s) => s.error);
  const applyProject = useProject((s) => s.applyProject);
  const clearError = useProject((s) => s.clearError);
  const [form, setForm] = useState<OpenForm | null>(null);
  // 접속 form이 열려 있으면 뒤의 탭을 실행하거나 닫지 않는다.
  useShortcuts(form === null);

  function editConnection(name: string) {
    const original = project?.connections.find((c) => c.name === name);
    if (original !== undefined) setForm({ original });
  }

  /** form을 닫은 뒤에 저장이 끝나도 접속은 반영한다. 그 사이 새로 연 form은 닫지 않는다. */
  function connectionSaved(saved: Project, from: OpenForm) {
    applyProject(saved);
    setForm((current) => (current === from ? null : current));
  }

  function nameTab(path: string) {
    if (activeId !== null) void saveTab(activeId, path);
  }

  return (
    <div className="flex h-screen bg-zinc-900 text-zinc-100">
      <div className="flex w-[260px] shrink-0 flex-col">
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
            className="shrink-0 border-t border-r border-zinc-800 bg-zinc-950"
          >
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-sm break-words text-red-400 hover:bg-zinc-900"
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
        <div className="relative min-h-0 flex-3">
          <div className="absolute inset-0">
            {activeId !== null ? (
              <SqlEditor tabId={activeId} onDocChange={markDirty} />
            ) : (
              <p className="flex h-full items-center justify-center text-sm text-zinc-500">
                Shift+Cmd+L로 새 탭
              </p>
            )}
          </div>
        </div>
        <div className="relative min-h-0 flex-2 border-t border-zinc-800">
          <div className="absolute inset-0">
            <ResultPane tabId={activeId} />
          </div>
        </div>
      </main>

      {form !== null && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/60">
          <ConnectionForm
            key={form.original?.name ?? "new"}
            original={form.original}
            onSaved={(saved) => connectionSaved(saved, form)}
            onClose={() => setForm(null)}
          />
        </div>
      )}
    </div>
  );
}
