import { useEffect, useRef } from "react";
import { pickDirectory } from "../../shared/api/dialog";
import { messageOf } from "../../shared/api/errors";
import { enterProject } from "../workspace/commands";
import { useProject } from "./projectStore";
import { Button } from "../../shared/ui/Button";
import { ErrorIcon } from "../../shared/ui/icons";
import { t } from "../../shared/i18n/t";

/**
 * "ready"일 때만 children을 그린다. 그 전에는 프로젝트를 열거나 만드는 화면이다. 여는 길은 모두
 * `enterProject`를 거쳐 보관한 탭을 되살린다.
 */
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
    void enterProject(boot);
  }, [boot]);

  async function pickAndOpen() {
    let dir: string | null;
    try {
      dir = await pickDirectory();
    } catch (error) {
      showError(messageOf(error));
      return;
    }
    if (dir !== null) await enterProject(() => open(dir));
  }

  if (status === "ready") return <>{children}</>;
  if (status === "booting") return null;

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-title">ChillaSQL</h1>
      {status === "missing" && missingDir !== null ? (
        <>
          <p className="text-body text-fg-2">
            {t("project.missing", { dir: missingDir })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => void enterProject(() => create(missingDir))}
            >
              {t("project.create")}
            </Button>
            <Button onClick={() => void pickAndOpen()}>
              {t("project.chooseAnother")}
            </Button>
          </div>
        </>
      ) : (
        <Button variant="primary" onClick={() => void pickAndOpen()}>
          {t("project.open")}
        </Button>
      )}
      {error !== null && (
        <p role="alert" className="text-small text-fg flex items-start gap-2">
          <ErrorIcon className="text-fg-2 mt-0.5 shrink-0" size={14} />
          {error}
        </p>
      )}
    </main>
  );
}
