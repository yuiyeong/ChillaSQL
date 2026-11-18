import { useEffect, useRef } from "react";
import { pickDirectory } from "../../shared/api/dialog";
import { messageOf } from "../../shared/api/errors";
import { useProject } from "./projectStore";
import { t } from "../../shared/i18n/t";

const buttonClass =
  "rounded bg-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-600 focus-visible:outline-2 focus-visible:outline-zinc-400";

/** "ready"일 때만 children을 그린다. 그 전에는 프로젝트를 열거나 만드는 화면이다. */
export function ProjectGate({ children }: { children: React.ReactNode }) {
  const status = useProject((s) => s.status);
  const error = useProject((s) => s.error);
  const missingDir = useProject((s) => s.missingDir);
  const boot = useProject((s) => s.boot);
  const open = useProject((s) => s.open);
  const create = useProject((s) => s.create);
  const showError = useProject((s) => s.showError);

  // StrictMode가 effect를 두 번 돌려도 boot는 한 번만 부른다.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void boot();
  }, [boot]);

  async function pickAndOpen() {
    let dir: string | null;
    try {
      dir = await pickDirectory();
    } catch (error) {
      showError(messageOf(error));
      return;
    }
    if (dir !== null) await open(dir);
  }

  if (status === "ready") return <>{children}</>;
  if (status === "booting") return null;

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-3xl font-semibold">ChillaSQL</h1>
      {status === "missing" && missingDir !== null ? (
        <>
          <p>{t("project.missing", { dir: missingDir })}</p>
          <div className="flex gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => void create(missingDir)}
            >
              {t("project.create")}
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() => void pickAndOpen()}
            >
              {t("project.chooseAnother")}
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className={buttonClass}
          onClick={() => void pickAndOpen()}
        >
          {t("project.open")}
        </button>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </main>
  );
}
