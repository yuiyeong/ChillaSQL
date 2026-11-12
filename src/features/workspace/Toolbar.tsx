import { useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { useRuns } from "../query/runsStore";
import { changeConnection, execute } from "./commands";

const buttonClass =
  "rounded bg-zinc-700 px-3 py-1 hover:bg-zinc-600 focus-visible:outline-2 focus-visible:outline-zinc-400 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-zinc-700";

/** 활성 탭의 접속과 실행, 취소, 저장. 활성 탭이 없으면 모두 disabled다. */
export function Toolbar() {
  const tab = useTabs((s) => s.tabs.find((t) => t.id === s.activeId));
  const project = useProject((s) => s.project);
  const status = useRuns((s) =>
    tab === undefined ? undefined : s.runs[tab.id]?.status,
  );

  return (
    <div
      role="toolbar"
      aria-label="쿼리"
      className="flex shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5 text-sm"
    >
      <select
        aria-label="접속"
        className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 focus-visible:outline-2 focus-visible:outline-zinc-400 disabled:opacity-50"
        disabled={tab === undefined}
        value={tab?.connection ?? ""}
        onChange={(event) => {
          if (tab === undefined) return;
          const value = event.target.value;
          void changeConnection(tab.id, value === "" ? null : value);
        }}
      >
        <option value="">접속 없음</option>
        {project?.connections.map((connection) => (
          <option key={connection.name} value={connection.name}>
            {connection.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={buttonClass}
        disabled={tab === undefined}
        onClick={() => void execute("run")}
      >
        실행
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={status !== "running"}
        onClick={() => void execute("cancel")}
      >
        취소
      </button>
      <button
        type="button"
        className={buttonClass}
        disabled={tab === undefined || !(tab.dirty || tab.path === null)}
        onClick={() => void execute("save")}
      >
        저장
      </button>
    </div>
  );
}
