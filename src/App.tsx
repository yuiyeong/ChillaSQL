import { useEffect, useRef } from "react";
import { ProjectGate } from "./features/project/ProjectGate";
import {
  useSettings,
  type SettingsError,
} from "./features/settings/settingsStore";
import { useQuitRequests } from "./features/workspace/quit";
import { Workspace } from "./features/workspace/Workspace";
import { t } from "./shared/i18n/t";
import { DialogHost } from "./shared/ui/DialogHost";
import { ask } from "./shared/ui/dialogs";

function App() {
  useQuitRequests();
  const status = useSettings((s) => s.status);
  const load = useSettings((s) => s.load);
  useSettingsErrors();

  // StrictMode가 effect를 두 번 돌려도 설정은 한 번만 읽는다.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void load();
  }, [load]);

  return (
    <>
      {/* 언어가 정해진 뒤에 그린다. */}
      {status === "ready" && (
        <ProjectGate>
          <Workspace />
        </ProjectGate>
      )}
      <DialogHost />
    </>
  );
}

/** 설정 파일이나 앱 저장소의 오류를 하나씩 dialog로 보이고, 모두 OK를 누르면 지운다. */
function useSettingsErrors() {
  const errors = useSettings((s) => s.errors);
  const dismissErrors = useSettings((s) => s.dismissErrors);
  // StrictMode가 effect를 두 번 돌려도 같은 오류는 한 번만 보인다.
  const shown = useRef<SettingsError[] | null>(null);
  useEffect(() => {
    if (errors.length === 0 || shown.current === errors) return;
    shown.current = errors;
    void Promise.all(errors.map(showSettingsError)).then(dismissErrors);
  }, [errors, dismissErrors]);
}

function showSettingsError({ title, reason }: SettingsError): Promise<string> {
  return ask({
    title: t(title),
    // toml의 오류는 원문 줄과 위치 표시를 함께 보내므로 줄과 칸을 그대로 둔다.
    body: (
      <span className="block font-mono break-words whitespace-pre-wrap">
        {reason}
      </span>
    ),
    actions: [{ id: "cancel", label: t("common.ok"), variant: "primary" }],
  });
}

export default App;
