import {
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { HistoryEntry } from "../../shared/api/types";
import { t } from "../../shared/i18n/t";
import { ErrorIcon, SearchIcon } from "../../shared/ui/icons";
import { Kbd } from "../../shared/ui/Kbd";
import { SECTION_LABEL } from "../../shared/ui/sectionLabel";
import { useNow } from "../../shared/ui/useNow";
import { ConnectionDot } from "../connections/ConnectionDot";
import { viewShowing } from "../editor/documents";
import { useTabs } from "../editor/tabsStore";
import { useProject } from "../project/projectStore";
import { formatElapsed } from "../query/format";
import { useHistory } from "./historyStore";
import { dayLabel, timeOfDay } from "./when";

/**
 * 기록의 SQL로 새 탭을 연다. 기록의 접속이 지금 프로젝트에 있으면 그 접속을 고르고, 없으면 새 탭의
 * 기본 접속을 둔다. 실행하지 않는다. 새 탭이 활성이 되면 에디터에 focus를 준다.
 */
function openHistoryEntry(entry: HistoryEntry): void {
  const tabs = useTabs.getState();
  const id = tabs.newTab({ text: entry.sql });
  const known = useProject
    .getState()
    .project?.connections.some((c) => c.name === entry.connection);
  if (known === true) tabs.setConnection(id, entry.connection);
  // 탭이 없던 때는 에디터가 지금 그려지므로 그린 뒤에 focus한다.
  requestAnimationFrame(() => viewShowing(id)?.focus());
}

interface Group {
  /** 지역 날짜(`toDateString`) */
  day: string;
  /** React key. 같은 날이 떨어져 두 번 나와도 겹치지 않게 첫 항목의 index를 붙인다 */
  key: string;
  label: string;
  /** `entries`의 index와 함께 */
  items: { entry: HistoryEntry; index: number }[];
}

/** 최근 것부터 온 기록을 지역 시각의 날짜로 묶는다. */
function groupByDay(entries: readonly HistoryEntry[], now: number): Group[] {
  const groups: Group[] = [];
  entries.forEach((entry, index) => {
    const day = new Date(entry.executedAt).toDateString();
    let group = groups[groups.length - 1];
    if (group?.day !== day) {
      group = {
        day,
        key: `${day}#${index}`,
        label: dayLabel(entry.executedAt, now),
        items: [],
      };
      groups.push(group);
    }
    group.items.push({ entry, index });
  });
  return groups;
}

function Message({ children }: { children: ReactNode }) {
  return (
    <div className="text-small text-fg-2 mx-1.5 px-4 py-4 leading-normal">
      {children}
    </div>
  );
}

/** sidebar의 History 화면. 실행한 문장을 검색하고 새 탭으로 불러온다(캔버스 Sidebar C). */
export function HistoryView() {
  const query = useHistory((s) => s.query);
  const entries = useHistory((s) => s.entries);
  const selected = useHistory((s) => s.selected);
  const status = useHistory((s) => s.status);
  const error = useHistory((s) => s.error);
  const connections = useProject((s) => s.project?.connections);
  // 자정을 넘기면 Today와 Yesterday가 바뀐다.
  const now = useNow(60_000);
  const selectedItem = useRef<HTMLButtonElement | null>(null);

  // 화면이 열려 있는 동안만 기록이 목록을 새로 읽는다. 지난번에 본 목록은 낡았으므로 열 때 다시
  // 읽는다. idle이면(처음이거나 프로젝트를 바꿔 비웠으면) 아래 effect가 읽는다.
  useEffect(() => {
    const { setOpen, load, status: current } = useHistory.getState();
    setOpen(true);
    if (current !== "idle") void load();
    return () => setOpen(false);
  }, []);
  useEffect(() => {
    if (status === "idle") void useHistory.getState().load();
  }, [status]);

  // 키로 옮긴 선택이 보이게 한다.
  useEffect(() => {
    selectedItem.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  // 검색어 입력과 화살표 키마다 다시 그려지므로 묶음과 접속 찾기는 목록이 바뀔 때만 만든다.
  const groups = useMemo(() => groupByDay(entries, now), [entries, now]);
  const profiles = useMemo(
    () => new Map(connections?.map((c) => [c.name, c])),
    [connections],
  );

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    // 한글 입력기가 조합 중일 때의 키는 입력기의 것이다.
    if (event.nativeEvent.isComposing) return;
    const { move, entries: current, selected: index } = useHistory.getState();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && index !== null) {
      // 항목 button의 click(선택)이 뒤따르지 않게 한다. 연 때만 막는다.
      event.preventDefault();
      openHistoryEntry(current[index]);
    }
  }

  return (
    <section
      aria-label={t("history.label")}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={onKeyDown}
    >
      <label className="border-line-2 bg-bg-0 text-fg-2 rounded-control focus-within:border-accent mx-2.5 mb-2.5 flex h-7 shrink-0 items-center gap-1.5 border px-2">
        <SearchIcon className="shrink-0" />
        <input
          type="search"
          aria-label={t("history.search")}
          placeholder={t("history.search")}
          value={query}
          className="text-small text-fg placeholder:text-fg-3 min-w-0 flex-1 appearance-none border-0 bg-transparent outline-none"
          onChange={(event) =>
            useHistory.getState().setQuery(event.target.value)
          }
        />
      </label>

      {status === "failed" && error !== null && (
        <div
          role="alert"
          className="text-small text-fg-2 mx-1.5 flex shrink-0 items-start gap-1.5 px-2.5 py-2 break-words"
        >
          <ErrorIcon className="mt-[3px] shrink-0" />
          {error}
        </div>
      )}
      {status === "ready" && entries.length === 0 && (
        <Message>
          {query.trim() === "" ? t("history.empty") : t("history.noMatch")}
        </Message>
      )}
      <div
        role="listbox"
        aria-label={t("history.label")}
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5"
      >
        {groups.map((group) => (
          <div
            key={group.key}
            role="group"
            aria-label={group.label}
            className="flex flex-col gap-0.5"
          >
            <span
              aria-hidden="true"
              className={`${SECTION_LABEL} px-2.5 pt-2 pb-1`}
            >
              {group.label}
            </span>
            {group.items.map(({ entry, index }) => {
              const profile = profiles.get(entry.connection);
              const isSelected = index === selected;
              return (
                <button
                  key={entry.id}
                  ref={isSelected ? selectedItem : undefined}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={[
                    "focus-visible:outline-accent flex w-full cursor-pointer flex-col gap-1 rounded-[6px] border-0 px-2.5 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2",
                    isSelected
                      ? "bg-accent/14"
                      : "hover:bg-bg-2 bg-transparent",
                  ].join(" ")}
                  onClick={() => useHistory.getState().select(index)}
                  onDoubleClick={() => openHistoryEntry(entry)}
                >
                  <span className="text-small text-fg max-h-9 w-full overflow-hidden font-mono leading-normal text-ellipsis whitespace-pre">
                    {entry.sql}
                  </span>
                  <span className="text-label text-fg-2 flex min-w-0 items-center gap-1.5">
                    {profile !== undefined && (
                      <ConnectionDot
                        color={profile.color}
                        testId="history-dot"
                      />
                    )}
                    <span className="truncate">
                      {entry.connection} · {timeOfDay(entry.executedAt)} ·{" "}
                      <span className="font-mono">
                        {formatElapsed(entry.elapsedMicros)}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="border-line-1 text-small text-fg-2 flex shrink-0 items-center gap-2 border-t px-3 py-2.5">
        <Kbd>↵</Kbd>
        {t("history.openInEditor")}
      </div>
    </section>
  );
}
