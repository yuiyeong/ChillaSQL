import { useProject } from "./projectStore";

const smallButton =
  "rounded bg-zinc-800 px-2 py-0.5 text-xs hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-zinc-400";

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

  if (project === null) return null;

  return (
    <aside className="flex h-full w-64 flex-col gap-4 overflow-y-auto border-r border-zinc-800 bg-zinc-950 p-3 text-sm">
      <header className="flex items-center justify-between gap-2">
        <h2 className="truncate font-semibold">{project.name}</h2>
        <button type="button" className={smallButton} onClick={onSwitchProject}>
          다른 프로젝트
        </button>
      </header>

      <section aria-label="접속" className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold text-zinc-400">접속</h3>
        <ul className="flex flex-col gap-2">
          {project.connections.map((connection) => (
            <li
              key={connection.name}
              className="flex items-center justify-between gap-2"
            >
              <div className="min-w-0">
                <div className="truncate">{connection.name}</div>
                <div className="truncate text-xs text-zinc-400">
                  {`${connection.host}:${connection.port}/${connection.database}`}
                </div>
              </div>
              <button
                type="button"
                className={smallButton}
                onClick={() => onEditConnection(connection.name)}
              >
                수정
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className={smallButton} onClick={onAddConnection}>
          접속 추가
        </button>
      </section>

      <section aria-label="SQL 파일" className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-zinc-400">SQL 파일</h3>
          <button
            type="button"
            className={smallButton}
            onClick={() => void refreshFiles()}
          >
            새로고침
          </button>
        </div>
        <ul className="flex flex-col">
          {files.map((path) => (
            <li key={path}>
              <button
                type="button"
                className="w-full truncate rounded px-1 py-0.5 text-left hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-zinc-400"
                onClick={() => onOpenFile(path)}
              >
                {path}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
