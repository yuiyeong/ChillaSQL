import { useMemo, useRef, useState, type MouseEvent } from "react";
import { copyText } from "../../shared/api/clipboard";
import type { ConstraintKind } from "../../shared/api/types";
import { quoteIdent, reservedSet } from "../../shared/sql/identifiers";
import { t } from "../../shared/i18n/t";
import { Button } from "../../shared/ui/Button";
import { IconButton } from "../../shared/ui/IconButton";
import { Menu, MenuItem } from "../../shared/ui/Menu";
import { Toast, useToast } from "../../shared/ui/Toast";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ErrorIcon,
  RefreshIcon,
  SpinnerIcon,
} from "../../shared/ui/icons";
import { ConnectionDot } from "../connections/ConnectionDot";
import { selectActiveConnection, useTabs } from "../editor/tabsStore";
import { useConnection } from "../project/projectStore";
import { selectFirstRows } from "../workspace/commands";
import { isView } from "../../shared/sql/catalog";
import { schemaRows, type SchemaRow } from "./schemaRows";
import { useSchema } from "./schemaStore";

/** 제약조건 줄의 오른쪽. SQL keyword라 번역하지 않는다. */
const CONSTRAINT_LABEL: Record<ConstraintKind, string> = {
  primary_key: "PRIMARY KEY",
  foreign_key: "FOREIGN KEY",
  unique: "UNIQUE",
  check: "CHECK",
  exclusion: "EXCLUDE",
};

const ROW =
  "text-small flex h-6 w-full items-center gap-1.5 rounded-[5px] border-0 pr-2 text-left whitespace-nowrap";

/** 줄의 왼쪽 여백. 캔버스(Sidebar A)의 `8 + depth * 14`px이다. */
function indent(depth: number) {
  return { paddingLeft: `${8 + depth * 14}px` };
}

/** 이름 앞의 짧은 표시. group과 상태 줄은 비어 있다. */
function iconOf(row: SchemaRow): string {
  switch (row.kind) {
    case "schema":
      return "S";
    case "relation":
      return isView(row.relation) ? "V" : "T";
    case "column":
      return row.column.primaryKey ? "PK" : "c";
    case "index":
      return "ix";
    case "constraint":
      return "ct";
    default:
      return "";
  }
}

function nameOf(row: SchemaRow): string {
  switch (row.kind) {
    case "schema":
      return row.name;
    case "group":
      return t(`schema.group.${row.group}`);
    case "relation":
      return row.relation.name;
    case "column":
      return row.column.name;
    case "index":
      return row.index.name;
    case "constraint":
      return row.constraint.name;
    default:
      return "";
  }
}

/** 이름 오른쪽의 작은 표시. */
function labelOf(row: SchemaRow): string | null {
  switch (row.kind) {
    case "column":
      return row.column.type;
    case "index":
      return row.index.unique ? t("schema.unique") : null;
    case "constraint":
      return CONSTRAINT_LABEL[row.constraint.kind];
    case "relation":
      return row.relation.kind === "materialized_view"
        ? t("schema.materialized")
        : null;
    default:
      return null;
  }
}

function titleOf(row: SchemaRow): string | undefined {
  if (row.kind === "index") return row.index.definition;
  if (row.kind === "constraint") return row.constraint.definition;
  return undefined;
}

/** sidebar의 Schema 화면. 활성 탭 접속의 catalog를 트리로 그린다(캔버스 Sidebar A, B). */
export function SchemaView({
  onChooseConnection,
}: {
  onChooseConnection(): void;
}) {
  const connection = useTabs(selectActiveConnection);
  const hasTab = useTabs((s) => s.activeId !== null);
  const profile = useConnection(connection);
  const entry = useSchema((s) =>
    connection === null ? undefined : s.entries[connection],
  );
  const rows = useMemo(
    () => (entry === undefined ? [] : schemaRows(entry)),
    [entry],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    row: SchemaRow;
    at: { x: number; y: number };
  } | null>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const toast = useToast();

  if (connection === null) {
    return (
      <div className="border-line-1 flex h-[200px] shrink-0 flex-col items-center justify-center gap-3 border-b px-5 text-center">
        <span className="text-small text-fg-2">{t("schema.noConnection")}</span>
        {/* 탭이 없으면 접속을 정할 곳이 없다. */}
        {hasTab && (
          <Button onClick={onChooseConnection}>
            {t("schema.chooseConnection")}
          </Button>
        )}
      </div>
    );
  }

  const schema = useSchema.getState();
  const catalog = entry?.catalog ?? null;
  // 줄은 catalog가 있을 때만 있으므로 아래 handler는 catalog가 있을 때만 불린다.
  const reserved = catalog === null ? new Set<string>() : reservedSet(catalog);

  const press = (row: SchemaRow) => {
    setSelected(row.key);
    if (
      row.kind === "schema" ||
      row.kind === "group" ||
      row.kind === "relation"
    ) {
      schema.toggle(connection, row.key);
    }
  };

  const openMenu = (row: SchemaRow, event: MouseEvent<HTMLElement>) => {
    // group과 상태 줄은 이름이 있는 object가 아니다.
    if (row.kind === "group") return;
    event.preventDefault();
    menuAnchor.current = event.currentTarget;
    setSelected(row.key);
    setMenu({ row, at: { x: event.clientX, y: event.clientY } });
  };

  const firstRows = (row: SchemaRow) => {
    if (row.kind === "relation") void selectFirstRows(row.relation, reserved);
  };

  const copyName = async (row: SchemaRow) => {
    const name = quoteIdent(nameOf(row), reserved);
    try {
      await copyText(name);
    } catch {
      return;
    }
    toast.show(t("schema.copied", { name }));
  };

  const loadingFirst =
    entry === undefined ||
    (entry.status === "loading" && entry.catalog === null);

  return (
    <section
      aria-label={t("schema.label")}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      <div
        data-testid="schema-header"
        className="text-small flex items-center gap-2 pr-2.5 pb-2 pl-4"
      >
        <ConnectionDot color={profile?.color ?? null} testId="connection-dot" />
        <span className="truncate font-medium">{connection}</span>
        {profile !== undefined && (
          <span className="text-label text-fg-2 truncate font-mono">
            {profile.database}
          </span>
        )}
        <span className="flex-1" />
        <IconButton
          size={22}
          label={t("schema.refresh")}
          onClick={() => void schema.refresh(connection)}
        >
          <RefreshIcon />
        </IconButton>
      </div>

      {entry?.status === "failed" && (
        <div className="text-small text-fg-2 flex flex-col items-start gap-2 px-4 pb-3">
          <span className="flex items-start gap-1.5 break-words">
            <ErrorIcon className="mt-[3px] shrink-0" />
            {entry.error}
          </span>
          <Button size="small" onClick={() => void schema.refresh(connection)}>
            {t("schema.retry")}
          </Button>
        </div>
      )}

      <ul className="m-0 flex min-h-0 flex-1 list-none flex-col overflow-y-auto px-1.5 pb-2">
        {loadingFirst && (
          <li className={`${ROW} text-fg-2`} style={indent(0)}>
            <SpinnerIcon size={11} />
            {t("schema.loading")}
          </li>
        )}
        {rows.map((row) => (
          <li key={row.key}>
            <TreeRow
              row={row}
              selected={row.key === selected}
              onPress={() => press(row)}
              onDoubleClick={() => firstRows(row)}
              onContextMenu={(event) => openMenu(row, event)}
            />
          </li>
        ))}
      </ul>

      <Menu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchor={menuAnchor}
        at={menu?.at}
        label={menu === null ? "" : nameOf(menu.row)}
      >
        {menu?.row.kind === "relation" && (
          <MenuItem onSelect={() => firstRows(menu.row)}>
            <span className="flex-1">{t("schema.menu.selectFirstRows")}</span>
            <span className="text-label text-fg-2">
              {t("schema.menu.doubleClick")}
            </span>
          </MenuItem>
        )}
        {menu !== null && (
          <MenuItem onSelect={() => void copyName(menu.row)}>
            {t("schema.menu.copyName")}
          </MenuItem>
        )}
      </Menu>
      <Toast message={toast.message} />
    </section>
  );
}

function TreeRow({
  row,
  selected,
  onPress,
  onDoubleClick,
  onContextMenu,
}: {
  row: SchemaRow;
  selected: boolean;
  onPress(): void;
  onDoubleClick(): void;
  onContextMenu(event: MouseEvent<HTMLElement>): void;
}) {
  if (row.kind === "loading" || row.kind === "empty" || row.kind === "failed") {
    return (
      <span className={`${ROW} text-fg-2`} style={indent(row.depth)}>
        {row.kind === "loading" && <SpinnerIcon size={11} />}
        {row.kind === "failed" && <ErrorIcon className="shrink-0" />}
        <span className="truncate">
          {row.kind === "loading"
            ? t("schema.loading")
            : row.kind === "empty"
              ? t("schema.empty")
              : row.error}
        </span>
      </span>
    );
  }

  const expandable =
    row.kind === "schema" || row.kind === "group" || row.kind === "relation";
  const expanded = expandable ? row.expanded : undefined;
  const label = labelOf(row);
  const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      title={titleOf(row)}
      className={[
        ROW,
        "focus-visible:outline-accent cursor-pointer focus-visible:outline-2",
        row.kind === "group" ? "text-fg-2" : "text-fg",
        selected ? "bg-accent/14" : "hover:bg-bg-2 bg-transparent",
      ].join(" ")}
      style={indent(row.depth)}
      onClick={onPress}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <Chevron
        size={11}
        className={`text-fg-2 shrink-0 ${expandable ? "" : "invisible"}`}
      />
      <span
        aria-hidden="true"
        className="text-fg-3 text-tiny w-3.5 shrink-0 text-center font-mono"
      >
        {iconOf(row)}
      </span>
      <span className={`truncate ${row.kind === "group" ? "" : "font-mono"}`}>
        {nameOf(row)}
      </span>
      {label !== null && " "}
      {label !== null && (
        <span className="text-label text-fg-3 ml-auto shrink-0 pl-2 font-mono">
          {label}
        </span>
      )}
    </button>
  );
}
