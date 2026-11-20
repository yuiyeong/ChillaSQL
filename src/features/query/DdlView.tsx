import { useMemo } from "react";
import { copyText } from "../../shared/api/clipboard";
import { t } from "../../shared/i18n/t";
import { Button } from "../../shared/ui/Button";
import { IconButton } from "../../shared/ui/IconButton";
import { CloseIcon, ErrorIcon, SpinnerIcon } from "../../shared/ui/icons";
import { Toast, useToast } from "../../shared/ui/Toast";
import { highlightSql } from "../editor/highlightSql";
import { useTabs } from "../editor/tabsStore";
import { closeDdl, type DdlView as DdlViewState } from "./ddlStore";
import { ResultBar, SingleTab } from "./ResultBar";

/** 칠한 SQL. 줄 사이에 줄바꿈을 두어 pre의 text가 원문과 같다. 셀 편집의 미리 보기도 쓴다. */
export function Code({ text }: { text: string }) {
  const lines = useMemo(() => highlightSql(text), [text]);
  return (
    <>
      {lines.map((line, index) => (
        <span key={index}>
          {index > 0 && "\n"}
          {line.map((piece, at) =>
            piece.className === "" ? (
              piece.text
            ) : (
              <span key={at} className={piece.className}>
                {piece.text}
              </span>
            ),
          )}
        </span>
      ))}
    </>
  );
}

/**
 * 결과 panel에 그리는 relation의 DDL(캔버스 Tools의 M9 DDL 보기). 읽는 동안과 실패했을 때도 header를 그린다.
 * Copy와 Open in new tab은 읽은 뒤에만 쓸 수 있다. Close는 캔버스에 없지만 지난 결과로 돌아가려고 더했다.
 */
export function DdlView({
  tabId,
  view,
}: {
  tabId: string;
  view: DdlViewState;
}) {
  const toast = useToast();
  const ready = view.status === "ready";
  const text = view.status === "ready" ? view.text : "";

  const copy = async () => {
    try {
      await copyText(text);
    } catch {
      // clipboard를 쓰지 못하면 복사했다고 알리지 않는다.
      return;
    }
    toast.show(t("ddl.copied"));
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ResultBar>
        <SingleTab>{t("ddl.tab", { name: view.name })}</SingleTab>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="small"
          disabled={!ready}
          onClick={() => void copy()}
        >
          {t("ddl.copy")}
        </Button>
        <Button
          size="small"
          disabled={!ready}
          onClick={() => useTabs.getState().newTab({ text })}
        >
          {t("ddl.openInNewTab")}
        </Button>
        <IconButton
          size={22}
          label={t("ddl.close")}
          onClick={() => closeDdl(tabId)}
        >
          <CloseIcon />
        </IconButton>
      </ResultBar>
      {view.status === "ready" ? (
        <pre
          data-testid="ddl-text"
          className="text-small bg-bg-1 text-fg m-0 min-h-0 flex-1 overflow-auto px-4 py-3 font-mono leading-[1.6] whitespace-pre"
        >
          <Code text={view.text} />
        </pre>
      ) : (
        <div className="text-small text-fg-2 flex min-h-0 flex-1 items-start gap-1.5 px-4 py-3">
          {view.status === "loading" ? (
            <>
              <SpinnerIcon size={11} className="mt-[3px]" />
              {t("ddl.loading")}
            </>
          ) : (
            <>
              <ErrorIcon className="mt-[3px] shrink-0" />
              <span className="break-words">{view.message}</span>
            </>
          )}
        </div>
      )}
      <Toast message={toast.message} />
    </div>
  );
}
