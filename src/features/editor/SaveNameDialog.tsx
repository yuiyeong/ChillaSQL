import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "../../shared/ui/Button";
import { noTextCorrection } from "../../shared/ui/noTextCorrection";
import { t } from "../../shared/i18n/t";

/** 파일이 없는 탭을 저장할 때 프로젝트 안의 경로를 묻는 modal. */
export function SaveNameDialog({
  title,
  onSubmit,
  onCancel,
}: {
  title: string;
  onSubmit(path: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState("");
  const headingId = useId();

  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit(value);
  }

  function keyDown(event: KeyboardEvent) {
    // 한글 입력 중에는 key가 "Process"라서 code로 판별한다.
    if (event.code === "Escape") onCancel();
  }

  return (
    <div className="fixed inset-0 z-10 flex items-start justify-center bg-black/60 pt-[84px]">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="border-line-2 bg-bg-2 flex w-[452px] flex-col gap-3.5 rounded-xl border p-5 shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
        onSubmit={submit}
        onKeyDown={keyDown}
      >
        <h2 id={headingId} className="text-title">
          {t("tabs.saveTitle", { title })}
        </h2>
        <label className="flex flex-col gap-1.5">
          <span className="text-small text-fg-2">{t("tabs.filePath")}</span>
          <input
            autoFocus
            {...noTextCorrection}
            placeholder={t("tabs.filePathPlaceholder")}
            className="border-line-2 bg-bg-0 text-fg placeholder:text-fg-3 focus-visible:outline-accent rounded-control text-small h-8 w-full border px-2.5 font-mono focus-visible:outline-2 focus-visible:-outline-offset-1"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit">
            {t("common.save")}
          </Button>
        </div>
      </form>
    </div>
  );
}
