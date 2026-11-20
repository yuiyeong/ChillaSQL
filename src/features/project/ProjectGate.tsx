import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { pickDirectory } from "../../shared/api/dialog";
import { messageOf } from "../../shared/api/errors";
import { t } from "../../shared/i18n/t";
import { rt, mono } from "../../shared/i18n/rich";
import { Button } from "../../shared/ui/Button";
import { ErrorIcon } from "../../shared/ui/icons";
import { isDialogOpen } from "../../shared/ui/dialogs";
import { Kbd } from "../../shared/ui/Kbd";
import { MODAL_PANEL, Scrim } from "../../shared/ui/Modal";
import { useNow } from "../../shared/ui/useNow";
import { enterProject } from "../workspace/commands";
import {
  commandFor,
  shortcutKeys,
  shortcutLabel,
} from "../workspace/shortcuts";
import { useSettings } from "../settings/settingsStore";
import { useProject } from "./projectStore";
import { initials, openedWhen, shortPath, useHome } from "./recent";

/**
 * "ready"일 때만 children을 그린다. 그 전에는 프로젝트를 열거나 만드는 Welcome 화면이다(캔버스
 * Welcome A, B). 여는 길은 모두 `enterProject`를 거쳐 보관한 탭을 되살린다.
 */
export function ProjectGate({ children }: { children: React.ReactNode }) {
  const status = useProject((s) => s.status);
  const boot = useProject((s) => s.boot);

  // StrictMode가 effect를 두 번 돌려도 boot는 한 번만 부른다.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void enterProject(boot);
  }, [boot]);

  if (status === "ready") return <>{children}</>;
  if (status === "booting") return null;
  return <Welcome />;
}

/** 폴더 picker로 고른 디렉토리를 연다. 고르지 않으면 아무것도 하지 않는다. */
async function pickAndOpen(): Promise<void> {
  const { open, showError } = useProject.getState();
  let dir: string | null;
  try {
    dir = await pickDirectory();
  } catch (error) {
    showError(messageOf(error));
    return;
  }
  if (dir !== null) await enterProject(() => open(dir));
}

function Welcome() {
  const status = useProject((s) => s.status);
  const missingDir = useProject((s) => s.missingDir);
  const error = useProject((s) => s.error);
  const recent = useProject((s) => s.recent);
  const open = useProject((s) => s.open);
  const language = useSettings((s) => s.language);
  const home = useHome();
  // 오늘과 어제의 경계를 넘어도 맞도록 1분마다 다시 그린다.
  const now = useNow(60_000);

  // Welcome에는 작업 화면의 단축키(useShortcuts)가 없다. Cmd+O만 잡는다. sheet나 확인 dialog가
  // 떠 있으면 건드리지 않는다.
  const asking = status === "missing";
  useEffect(() => {
    if (asking) return;
    function onKeyDown(event: KeyboardEvent) {
      if (isDialogOpen() || commandFor(event) !== "openProject") return;
      event.preventDefault();
      event.stopPropagation();
      void pickAndOpen();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [asking]);

  return (
    <main className="bg-bg-0 text-fg flex h-screen flex-col">
      <div data-tauri-drag-region className="h-[38px] shrink-0" />
      <div className="mx-auto mt-6 flex w-[480px] flex-col gap-5">
        <div className="flex items-center justify-between">
          <h1 className="text-title">ChillaSQL</h1>
          <Button
            variant="primary"
            size="kbd"
            aria-keyshortcuts={shortcutKeys("openProject")}
            onClick={() => void pickAndOpen()}
          >
            {t("project.openShortcut")}
            <Kbd>{shortcutLabel("openProject")}</Kbd>
          </Button>
        </div>
        {error !== null && status === "none" && <ErrorLine message={error} />}
        {recent.length > 0 && (
          <section className="flex flex-col gap-1.5">
            <h2 className="text-label text-fg-2 px-2.5 font-semibold tracking-[0.04em]">
              {t("project.recent")}
            </h2>
            {recent.map((project) => (
              <button
                key={project.dir}
                type="button"
                className="hover:bg-bg-2 hover:border-line-2 focus-visible:bg-bg-2 focus-visible:border-line-2 focus-visible:outline-accent flex w-full cursor-pointer items-center gap-3 rounded-lg border border-transparent bg-transparent px-2.5 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-1"
                // 목록에서 연 디렉토리는 chilla.toml이 없어도 만들지 묻지 않고 오류만 보인다.
                onClick={() =>
                  void enterProject(() => open(project.dir, false))
                }
              >
                <span
                  aria-hidden="true"
                  className="bg-bg-3 text-fg text-label flex size-[30px] shrink-0 items-center justify-center rounded-[7px] font-semibold"
                >
                  {initials(project.name)}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">{project.name}</span>
                  <span className="text-label text-fg-2 truncate font-mono">
                    {home === null ? project.dir : shortPath(project.dir, home)}
                  </span>
                </span>
                <span className="text-label text-fg-2 shrink-0">
                  {openedWhen(project.openedAt * 1000, now, language)}
                </span>
              </button>
            ))}
          </section>
        )}
      </div>
      {asking && missingDir !== null && (
        <MissingSheet
          dir={home === null ? missingDir : shortPath(missingDir, home)}
          full={missingDir}
          error={error}
        />
      )}
    </main>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" className="text-small text-fg flex items-start gap-2">
      <ErrorIcon className="text-fg-2 mt-0.5 shrink-0" size={14} />
      {message}
    </p>
  );
}

/**
 * chilla.toml이 없는 디렉토리를 고른 직후 만들지 묻는 sheet(캔버스 Welcome B). Create만 chilla.toml을
 * 쓰고, Cancel이나 Escape는 아무것도 쓰지 않고 Welcome으로 돌아간다.
 */
function MissingSheet({
  dir,
  full,
  error,
}: {
  /** 화면에 보이는 경로(`~`로 줄인 것) */
  dir: string;
  /** 만들 디렉토리 */
  full: string;
  /** 만들기가 실패한 이유 */
  error: string | null;
}) {
  const create = useProject((s) => s.create);
  const dismissMissing = useProject((s) => s.dismissMissing);
  const titleId = useId();
  const bodyId = useId();
  const panel = useRef<HTMLDivElement>(null);

  function onKeyDown(event: ReactKeyboardEvent) {
    // 한글 입력 중에는 key가 "Process"라서 code로 판별한다.
    if (event.code === "Escape") {
      event.preventDefault();
      dismissMissing();
    } else if (event.code === "Tab") {
      keepFocusInside(event, panel.current);
    }
  }

  return (
    <Scrim>
      <div
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className={MODAL_PANEL}
        onKeyDown={onKeyDown}
      >
        <div className="flex flex-col gap-1.5">
          <h2 id={titleId} className="text-title">
            {rt("project.missingTitle", { dir: mono(dir) })}
          </h2>
          <p id={bodyId} className="text-body text-fg-2 leading-[1.55]">
            {t("project.missingBody")}
          </p>
        </div>
        {error !== null && <ErrorLine message={error} />}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => void pickAndOpen()}>
            {t("project.chooseAnother")}
          </Button>
          <span className="flex-1" />
          <Button onClick={dismissMissing}>{t("common.cancel")}</Button>
          <Button
            autoFocus
            variant="primary"
            onClick={() => void enterProject(() => create(full))}
          >
            {t("project.create")}
          </Button>
        </div>
      </div>
    </Scrim>
  );
}

/** Tab이 sheet 밖으로 나가지 않게 한다. 끝에서 넘어가면 반대쪽 끝으로 돌린다. */
function keepFocusInside(event: ReactKeyboardEvent, panel: HTMLElement | null) {
  const buttons = Array.from(
    panel?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [],
  );
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  if (first === undefined || last === undefined) return;
  const focused = document.activeElement;
  if (event.shiftKey ? focused === first : focused === last) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
