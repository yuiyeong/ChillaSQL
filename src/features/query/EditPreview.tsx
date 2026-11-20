import { useId } from "react";
import { t } from "../../shared/i18n/t";
import { SECTION_LABEL } from "../../shared/ui/sectionLabel";
import { Code } from "./DdlView";
import type { UpdateStatement } from "./editSql";

/**
 * 표 아래의 미리 보기(캔버스 Tools M10). Apply가 보낼 UPDATE 문을 줄마다 하나씩, 에디터와 같은 색으로
 * 칠해 보인다. 길면 160px까지 늘고 그 뒤는 스크롤한다.
 */
export function EditPreview({
  statements,
}: {
  statements: readonly UpdateStatement[];
}) {
  const labelId = useId();
  const sql = statements.map((statement) => statement.sql).join("\n");
  return (
    <div className="border-line-1 flex shrink-0 flex-col gap-1.5 border-t p-3">
      <span id={labelId} className={SECTION_LABEL}>
        {t("edit.preview")}
      </span>
      <pre
        aria-labelledby={labelId}
        className="bg-bg-1 text-small m-0 max-h-40 overflow-auto rounded-md px-2.5 py-2 font-mono leading-[1.6] whitespace-pre-wrap"
      >
        <Code text={sql} />
      </pre>
    </div>
  );
}
