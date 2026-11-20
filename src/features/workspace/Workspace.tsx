import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import type { Connection, Project } from "../../shared/api/types";
import { ConnectionForm } from "../connections/ConnectionForm";
import { useEditorNotice } from "../editor/editorNotice";
import { saveTab } from "../editor/saveTab";
import { SqlEditor } from "../editor/SqlEditor";
import { TabBar } from "../editor/TabBar";
import { selectActiveConnection, useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { Sidebar } from "../project/Sidebar";
import { Hints, ResultPane } from "../query/ResultPane";
import { useSchema } from "../schema/schemaStore";
import { useSchemaLifecycle } from "../schema/useSchemaLifecycle";
import { colorOf, connectionColor } from "../connections/colors";
import {
  applySavedProject,
  applySavedProjectKeepingSessions,
  connectionInUse,
  closeTab,
  execute,
  switchProject,
} from "./commands";
import { useShortcuts } from "./shortcuts";
import { StatusBar } from "./StatusBar";
import { Toolbar } from "./Toolbar";
import { applySettlement, chooseSettlement } from "./transactionPrompts";
import { subscribeTunnelEvents } from "./tunnelEvents";
import { t } from "../../shared/i18n/t";
import { Toast } from "../../shared/ui/Toast";

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
  const connectionName = useTabs(selectActiveConnection);
  const catalog = useSchema((s) =>
    connectionName === null
      ? null
      : (s.entries[connectionName]?.catalog ?? null),
  );
  const openFile = useTabs((s) => s.openFile);
  const markDirty = useTabs((s) => s.markDirty);
  const project = useProject((s) => s.project);
  const error = useProject((s) => s.error);
  const clearError = useProject((s) => s.clearError);
  const notice = useEditorNotice((s) => s.message);
  const [form, setForm] = useState<OpenForm | null>(null);
  const [connectionMenu, setConnectionMenu] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const barColor = connectionColor(
    colorOf(project?.connections, connectionName) ?? null,
  );
  // 저장 경로 dialog가 떠 있는지. TabBar와 같이 활성 탭의 이름을 물을 때만 dialog를 그린다.
  const naming = useTabs((s) => s.naming !== null && s.naming === s.activeId);
  // 접속 form이나 저장 경로 dialog가 열려 있으면 뒤의 탭을 실행하거나 닫거나 바꾸지 않는다.
  // 확인 dialog는 useShortcuts가 스스로 본다.
  useShortcuts(form === null && !naming);
  useSchemaLifecycle();

  // 터널 상태 event를 받는다. 구독이 끝나기 전에 unmount되면 끝난 뒤 바로 그만 받는다.
  useEffect(() => {
    const subscribed = subscribeTunnelEvents();
    return () => {
      void subscribed.then((stop) => stop());
    };
  }, []);

  function editConnection(name: string) {
    const original = project?.connections.find((c) => c.name === name);
    if (original !== undefined) setForm({ original });
  }

  /** form을 닫은 뒤에 저장이 끝나도 접속은 반영한다. 그 사이 새로 연 form은 닫지 않는다. */
  function connectionSaved(saved: Project, from: OpenForm) {
    void applySavedProject(saved, from.original?.name);
    setForm((current) => (current === from ? null : current));
  }

  /**
   * 대상을 바꿔 저장하면 그 접속을 쓰는 탭의 세션이 닫히므로 열린 트랜잭션을 먼저 묻는다. 고른 대로
   * 끝내는 것은 저장에 성공한 뒤에 form이 부른다.
   */
  async function settleBeforeSave(
    connection: Connection,
  ): Promise<(() => Promise<boolean>) | null> {
    const using = useTabs
      .getState()
      .tabs.filter((tab) => tab.connection === connection.name)
      .map((tab) => tab.id);
    const settlement = await chooseSettlement(using, "saveTarget", {
      connection: connection.name,
    });
    return settlement === null ? null : () => applySettlement(settlement);
  }

  function nameTab(path: string) {
    if (activeId !== null) void saveTab(activeId, path);
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
                onChooseConnection={() => setConnectionMenu(true)}
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
          <Toolbar
            onAddConnection={() => setForm({ original: null })}
            connectionMenuOpen={connectionMenu}
            onConnectionMenuChange={setConnectionMenu}
          />
          <div
            ref={editorRef}
            data-testid="editor-area"
            className="bg-bg-1 relative min-h-[120px] min-w-0 flex-1"
          >
            <div className="absolute inset-0">
              {activeId !== null ? (
                <SqlEditor
                  tabId={activeId}
                  catalog={catalog}
                  onDocChange={markDirty}
                />
              ) : (
                <Hints />
              )}
            </div>
            <Toast message={notice} />
          </div>
          <ResultSplit
            editorRef={editorRef}
            tabId={activeId}
            connection={connectionName}
            onEditConnection={editConnection}
          />
          <StatusBar tabId={activeId} />
        </main>
      </div>

      {form !== null && (
        <div className="bg-scrim fixed inset-0 z-10 flex items-start justify-center">
          <ConnectionForm
            key={form.original?.name ?? "new"}
            original={form.original}
            inUse={form.original && connectionInUse(form.original.name)}
            existingNames={project?.connections.map((c) => c.name) ?? []}
            beforeSave={settleBeforeSave}
            onSaved={(saved) => connectionSaved(saved, form)}
            onSavedNotApplied={applySavedProjectKeepingSessions}
            onClose={() => setForm(null)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 에디터 아래의 경계와 결과 panel. 끄는 동안의 높이 state를 여기 두어 pointermove마다
 * 이 부분만 다시 그린다. `editorRef`는 최대 높이를 잴 때 쓴다.
 */
function ResultSplit({
  editorRef,
  tabId,
  connection,
  onEditConnection,
}: {
  editorRef: RefObject<HTMLDivElement | null>;
  tabId: string | null;
  connection: string | null;
  onEditConnection(name: string): void;
}) {
  const [resultHeight, setResultHeight] = useState(RESULT_HEIGHT);
  const [maxHeight, setMaxHeight] = useState(MIN_PANE);
  const resultRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    startY: number;
    startHeight: number;
    max: number;
  } | null>(null);
  // 처음 그린 뒤의 aria-valuemax. layout을 재야 알 수 있어서 effect에서 정한다. 이후는 끌 때마다 다시 잰다.
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMaxHeight(measure().max);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 처음 한 번만 잰다
  }, []);

  /** 에디터와 결과 panel이 지금 그려진 높이로 나눠 가진 공간에서, 에디터에 120px을 남긴 결과 panel의 최대 높이 */
  function measure(): { rendered: number; max: number } {
    const rendered = resultRef.current?.clientHeight ?? resultHeight;
    const editorHeight = editorRef.current?.clientHeight ?? 0;
    return {
      rendered,
      max: Math.max(MIN_PANE, editorHeight + rendered - MIN_PANE),
    };
  }

  function startDrag(e: PointerEvent<HTMLDivElement>) {
    // 끄는 동안 화면의 글자가 선택되지 않게 한다. pointer capture에는 영향이 없다.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // 창이 줄어 flex-shrink로 작아진 panel이 있으면 저장한 높이가 아니라 그려진 높이에서 시작한다.
    const { rendered, max } = measure();
    drag.current = { startY: e.clientY, startHeight: rendered, max };
    setResultHeight(rendered);
    setMaxHeight(max);
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
    <>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("workspace.resizeResults")}
        aria-valuenow={resultHeight}
        aria-valuemin={MIN_PANE}
        aria-valuemax={maxHeight}
        className="border-line-1 bg-bg-0 flex h-[5px] shrink-0 cursor-row-resize touch-none items-center justify-center border-t"
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="bg-line-2 h-[3px] w-9 rounded-[2px]" />
      </div>
      <div
        ref={resultRef}
        data-testid="result-panel"
        className="relative min-h-[120px] shrink"
        style={{ flex: `0 1 ${resultHeight}px` }}
      >
        <div className="absolute inset-0">
          <ResultPane
            tabId={tabId}
            hasConnection={connection !== null}
            connection={connection}
            onEditConnection={onEditConnection}
          />
        </div>
      </div>
    </>
  );
}
