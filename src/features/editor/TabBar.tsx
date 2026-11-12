import { useState, type FormEvent, type KeyboardEvent } from "react";
import { useTabs } from "./tabsStore";

interface TabBarProps {
  onClose(id: string): void;
  onNew(): void;
  onName(path: string): void;
}

export function TabBar({ onClose, onNew, onName }: TabBarProps) {
  const tabs = useTabs((state) => state.tabs);
  const activeId = useTabs((state) => state.activeId);
  const naming = useTabs((state) => state.naming);
  const error = useTabs((state) => state.error);
  const activate = useTabs((state) => state.activate);
  const requestName = useTabs((state) => state.requestName);
  const setError = useTabs((state) => state.setError);

  return (
    <div className="border-b border-zinc-800 bg-zinc-900 text-sm text-zinc-300">
      <div className="flex items-stretch overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`flex shrink-0 items-center border-r border-zinc-800 ${
              tab.id === activeId
                ? "bg-zinc-800 text-zinc-100"
                : "hover:bg-zinc-800/60"
            }`}
          >
            <button
              type="button"
              aria-current={tab.id === activeId ? "true" : undefined}
              className="flex items-center gap-1.5 py-1.5 pr-1 pl-3"
              onClick={() => activate(tab.id)}
            >
              <span>{tab.title}</span>
              {tab.dirty && (
                <span aria-label="저장하지 않음" className="text-zinc-400">
                  ●
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label={`${tab.title} 닫기`}
              className="px-2 py-1.5 text-zinc-500 hover:text-zinc-100"
              onClick={() => onClose(tab.id)}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label="새 탭"
          className="shrink-0 px-3 py-1.5 text-zinc-400 hover:text-zinc-100"
          onClick={onNew}
        >
          +
        </button>
      </div>
      {naming !== null && naming === activeId && (
        <NameForm onSubmit={onName} onCancel={() => requestName(null)} />
      )}
      {error !== null && (
        <button
          type="button"
          className="block w-full truncate px-3 py-1 text-left text-red-400 hover:bg-zinc-800"
          onClick={() => setError(null)}
        >
          {error}
        </button>
      )}
    </div>
  );
}

function NameForm({
  onSubmit,
  onCancel,
}: {
  onSubmit(path: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(value);
  }

  function keyDown(event: KeyboardEvent) {
    if (event.code === "Escape") onCancel();
  }

  return (
    <form
      className="flex gap-2 border-t border-zinc-800 px-3 py-1.5"
      onSubmit={submit}
    >
      <input
        autoFocus
        aria-label="파일 경로"
        placeholder="queries/이름.sql"
        className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100 outline-none focus:border-zinc-500"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={keyDown}
      />
      <button
        type="submit"
        className="rounded bg-zinc-700 px-3 py-1 text-zinc-100 hover:bg-zinc-600"
      >
        저장
      </button>
    </form>
  );
}
