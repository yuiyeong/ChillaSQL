import { useEffect, useRef } from "react";
import { pickDirectory } from "../../shared/api/dialog";
import { useProject } from "./projectStore";

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

  // StrictMode가 effect를 두 번 돌려도 boot는 한 번만 부른다.
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void boot();
  }, [boot]);

  async function pickAndOpen() {
    const dir = await pickDirectory();
    if (dir !== null) await open(dir);
  }

  if (status === "ready") return <>{children}</>;
  if (status === "booting") return null;

  return (
    <main className="flex h-screen flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-3xl font-semibold">ChillaSQL</h1>
      {status === "missing" && missingDir !== null ? (
        <>
          <p>{missingDir}에 chilla.toml이 없습니다</p>
          <div className="flex gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => void create(missingDir)}
            >
              chilla.toml 만들기
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() => void pickAndOpen()}
            >
              다른 디렉토리 열기
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className={buttonClass}
          onClick={() => void pickAndOpen()}
        >
          프로젝트 열기
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
