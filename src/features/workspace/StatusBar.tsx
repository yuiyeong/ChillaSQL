import { documentLineEnding } from "../editor/documents";
import { useEditorStatus } from "../editor/editorStatus";
import { t } from "../../shared/i18n/t";

/** 에디터 정보만 보여 주는 24px 줄. 탭이 없으면 비어 있다. */
export function StatusBar({ tabId }: { tabId: string | null }) {
  const statusTab = useEditorStatus((s) => s.tabId);
  const line = useEditorStatus((s) => s.line);
  const column = useEditorStatus((s) => s.column);
  // 에디터가 이 탭의 위치를 보내기 전에는 앞 탭의 위치를 보이지 않는다.
  const showPosition = tabId !== null && statusTab === tabId;
  return (
    <footer className="border-line-1 bg-bg-0 text-label text-fg-2 flex h-6 shrink-0 items-center justify-end gap-3.5 border-t px-3">
      {tabId !== null && (
        <>
          {showPosition && (
            <span>
              {t("status.position", {
                line,
                column,
              })}
            </span>
          )}
          <span>{t("status.encoding")}</span>
          <span>
            {documentLineEnding(tabId) === "CRLF"
              ? t("status.lineEndingCrlf")
              : t("status.lineEndingLf")}
          </span>
        </>
      )}
    </footer>
  );
}
