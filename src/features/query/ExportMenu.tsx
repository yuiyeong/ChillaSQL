import { useRef, useState, type RefObject } from "react";
import { writeExport } from "../../shared/api/commands";
import { pickSavePath } from "../../shared/api/dialog";
import { messageOf } from "../../shared/api/errors";
import { t, tc } from "../../shared/i18n/t";
import { Button } from "../../shared/ui/Button";
import { ask } from "../../shared/ui/dialogs";
import { Menu, MenuItem } from "../../shared/ui/Menu";
import { useProject } from "../project/projectStore";
import {
  toCsv,
  toJson,
  type ExportRows,
  type ExportSource,
} from "./exportRows";

type Format = "csv" | "json";

/** 캔버스 Tools 7의 Export 버튼 높이와 menu 너비(px) */
const BUTTON_HEIGHT = 26;
const MENU_WIDTH = 220;

/**
 * 결과 header의 Export 버튼과 menu. 고른 형식으로 저장 dialog를 열고, 표가 준 행을 쓴 뒤
 * `onSaved`로 toast 문구를 넘긴다. 쓰지 못하면 toast 대신 오류 dialog를 띄운다.
 */
export function ExportMenu({
  sourceRef,
  partial,
  onSaved,
}: {
  sourceRef: RefObject<ExportSource | null>;
  /** 표의 행이 결과의 일부인지(`isPartialResult`). toast가 받은 행이라고 알린다 */
  partial: boolean;
  onSaved(message: string): void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  const save = async (format: Format) => {
    const source = sourceRef.current?.();
    if (source === undefined) return;
    const message = await saveRows(source, format, partial);
    if (message !== null) onSaved(message);
  };

  return (
    <>
      <Button
        ref={anchor}
        variant="ghost"
        size="small"
        style={{ height: BUTTON_HEIGHT }}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {t("export.button")}
      </Button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchor}
        align="end"
        label={t("export.button")}
      >
        <div style={{ width: MENU_WIDTH }}>
          <MenuItem onSelect={() => void save("csv")}>
            {t("export.csv")}
          </MenuItem>
          <MenuItem onSelect={() => void save("json")}>
            {t("export.json")}
          </MenuItem>
        </div>
      </Menu>
    </>
  );
}

/**
 * 저장 dialog로 고른 경로에 행을 쓰고 toast 문구를 돌려준다. 기본 위치는 열린 프로젝트 디렉토리다.
 * 취소했거나 쓰지 못했으면(오류 dialog를 띄운다) null이다.
 */
async function saveRows(
  { columns, rows, types }: ExportRows,
  format: Format,
  partial: boolean,
): Promise<string | null> {
  const name = `result.${format}`;
  const dir = useProject.getState().project?.dir;
  let path: string | null;
  try {
    path = await pickSavePath(
      dir === undefined ? name : `${dir}/${name}`,
      format,
    );
    if (path === null) return null;
    const text =
      format === "csv" ? toCsv(columns, rows) : toJson(columns, rows, types);
    await writeExport(path, text);
  } catch (error) {
    void ask({
      title: t("export.failedTitle"),
      body: messageOf(error),
      actions: [{ id: "cancel", label: t("common.ok"), variant: "primary" }],
    });
    return null;
  }
  const file = path.slice(path.lastIndexOf("/") + 1);
  return tc(partial ? "export.savedPartial" : "export.saved", rows.length, {
    file,
  });
}
