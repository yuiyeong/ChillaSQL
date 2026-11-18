import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import {
  columnResizingFeature,
  columnSizingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ColumnSizingState,
  type Header,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Cell } from "../../shared/api/types";
import { formatCount, t, tc } from "../../shared/i18n/t";
import { Button } from "../../shared/ui/Button";
import { SpinnerIcon } from "../../shared/ui/icons";
import {
  anchorShift,
  cellDisplay,
  copyCell,
  FOOTER_HEIGHT,
  fitWidth,
  GAP_HEIGHT,
  HEADER_HEIGHT,
  headerMeasure,
  MIN_DRAG,
  ROW_HEIGHT,
  rowNumberWidth,
  rowSpan,
  selectedRows,
  shouldFetch,
  tsv,
  type Selection,
} from "./grid";
import { receivedRows, type ResultData } from "./runReducer";

/** 지금 선택을 복사할 text와 알림 문구. 선택이 없으면 null */
export type CopyTarget = { text: string; message: string } | null;

interface ResultGridProps {
  /** columns가 null이 아니다 */
  result: ResultData;
  /** 결과가 끝났으면 서버가 알려 준 전체 행 수 */
  endRows: number | null;
  onFetchMore(): void;
  onRunAgain(): void;
  onCopied(message: string): void;
  /** ResultPane header의 복사 버튼이 부른다 */
  copyTargetRef: RefObject<(() => CopyTarget) | null>;
  /** 선택이 생기거나 없어질 때. header 복사 버튼의 disabled에 쓴다 */
  onSelectionChange(hasSelection: boolean): void;
}

// TanStack Table은 column 정의와 너비 조절에만 쓴다. row model은 부르지 않는다.
const features = tableFeatures({ columnSizingFeature, columnResizingFeature });
type Features = typeof features;
const NO_ROWS: Cell[][] = [];
const NO_COLUMNS: string[] = [];

/** 첫 render가 쓰는 viewport 크기. 실제 크기는 ResizeObserver가 알려 준다. */
const INITIAL_RECT = { width: 800, height: 400 };
const OVERSCAN = 10;
const estimateSize = () => ROW_HEIGHT;

/**
 * 가상 스크롤 결과 표. 같은 실행 동안에는 batch마다 `result` object가 바뀌어도 상태를 이어 가고,
 * 다른 실행(`startedAt`이나 `sql`이 다름)이 오면 처음부터 다시 그린다(선택, 스크롤, 너비).
 * props가 그대로면(알림, header 복사 버튼) 다시 그리지 않는다.
 */
export const ResultGrid = memo(function ResultGrid(props: ResultGridProps) {
  const { startedAt, sql } = props.result;
  return <Grid key={`${startedAt}:${sql}`} {...props} />;
});

function Grid({
  result,
  endRows,
  onFetchMore,
  onRunAgain,
  onCopied,
  copyTargetRef,
  onSelectionChange,
}: ResultGridProps) {
  const { firstRow, rows, fetch } = result;
  const columns = result.columns ?? NO_COLUMNS;
  const scrollRef = useRef<HTMLDivElement>(null);

  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() =>
    fitColumns(columns, rows),
  );
  const columnDefs = useMemo(
    (): ColumnDef<Features, Cell[]>[] =>
      columns.map((name, index) => ({
        id: String(index),
        header: name,
        minSize: MIN_DRAG,
      })),
    [columns],
  );
  const table = useTable({
    features,
    columns: columnDefs,
    data: NO_ROWS,
    columnResizeMode: "onChange",
    state: { columnSizing },
    onColumnSizingChange: setColumnSizing,
  });
  const headers = table.getFlatHeaders();

  const getItemKey = useCallback(
    (index: number) => firstRow + index,
    [firstRow],
  );
  // React Compiler는 쓰지 않는다. memo한 Row에는 virtualizer의 함수가 아니라 값만 넘긴다.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    overscan: OVERSCAN,
    paddingStart: firstRow > 0 ? GAP_HEIGHT : 0,
    paddingEnd: FOOTER_HEIGHT,
    scrollMargin: HEADER_HEIGHT,
    initialRect: INITIAL_RECT,
  });
  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  // range는 getVirtualItems가 정한다. overscan을 뺀 보이는 범위다.
  const lastVisible = virtualizer.range?.endIndex ?? -1;

  const [selection, setSelection] = useState<Selection>(null);

  // 아래 effect와 handler가 읽는 최신 값. render 중에는 쓰지 않는다.
  const latest = useRef({ selection, firstRow, rows, onCopied, onFetchMore });
  useLayoutEffect(() => {
    const current = latest.current;
    current.selection = selection;
    current.firstRow = firstRow;
    current.rows = rows;
    current.onCopied = onCopied;
    current.onFetchMore = onFetchMore;
  });

  // 앞 행이 버려지면 버린 만큼 당겨 보던 행을 그 자리에 둔다.
  const shownFirstRow = useRef(firstRow);
  const anchored = useRef(false);
  useLayoutEffect(() => {
    const shift = anchorShift(shownFirstRow.current, firstRow);
    shownFirstRow.current = firstRow;
    const element = scrollRef.current;
    if (shift === 0 || element === null) return;
    element.scrollTop += shift;
    anchored.current = true;
  }, [firstRow]);

  useEffect(() => {
    // 위치를 당긴 commit의 lastVisible은 당기기 전 scroll 위치로 셌다. 당긴 뒤의 scroll event가 다시 센다.
    if (anchored.current) {
      anchored.current = false;
      return;
    }
    if (shouldFetch(lastVisible, rows.length, fetch)) {
      latest.current.onFetchMore();
    }
  }, [lastVisible, rows.length, fetch, firstRow]);

  const hasSelection = selection !== null;
  useEffect(() => {
    onSelectionChange(hasSelection);
  }, [hasSelection, onSelectionChange]);

  useImperativeHandle(
    copyTargetRef,
    () => () => copyTargetOf(latest.current),
    [],
  );

  // Cmd+C와 Edit > Copy는 둘 다 copy event로 온다. focus가 표 안일 때만 가로챈다.
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      const grid = scrollRef.current;
      if (grid === null || !grid.contains(document.activeElement)) return;
      if (event.clipboardData === null) return;
      const target = copyTargetOf(latest.current);
      if (target === null) return;
      event.clipboardData.setData("text/plain", target.text);
      event.preventDefault();
      latest.current.onCopied(target.message);
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, []);

  const onBodyClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    const rowElement = target.closest<HTMLElement>("[data-row]");
    if (rowElement === null) return;
    const row = Number(rowElement.dataset.row);
    scrollRef.current?.focus({ preventScroll: true });
    if (target.closest("[role=rowheader]") !== null) {
      const extend = event.shiftKey;
      setSelection((previous) => ({
        kind: "rows",
        anchor: extend ? anchorOf(previous, row) : row,
        focus: row,
      }));
      return;
    }
    const cellElement = target.closest<HTMLElement>("[data-col]");
    if (cellElement === null) return;
    setSelection({
      kind: "cell",
      row,
      column: Number(cellElement.dataset.col),
    });
  };

  // WebKit은 Home, End(Cmd+위아래 화살표)를 애니메이션으로 스크롤한다. 한 frame에 수천 행씩 지나가
  // 그 frame의 행을 그리기 전에 화면이 먼저 움직여 빈 몸통이 보인다. 끝으로 바로 가면 scroll event가 한 번이다.
  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const toEnd =
      event.key === "End" || (event.metaKey && event.key === "ArrowDown");
    const toStart =
      event.key === "Home" || (event.metaKey && event.key === "ArrowUp");
    if (!toEnd && !toStart) return;
    event.preventDefault();
    const element = event.currentTarget;
    element.scrollTop = toEnd ? element.scrollHeight : 0;
  };

  // 행은 누른 때의 것을 읽는다. 그래서 batch가 와도 header를 다시 그리지 않는다.
  const fitColumn = useCallback(
    (index: number) =>
      setColumnSizing((old) => ({
        ...old,
        [String(index)]: fitWidth(
          columns[index],
          columnValues(latest.current.rows, index),
          headerMeasure(),
        ),
      })),
    [columns],
  );

  const numberWidth = rowNumberWidth(receivedRows(result));
  // header의 getSize는 columnSizing을 읽는다. 스크롤만 한 frame에서는 다시 만들지 않는다.
  const sizeVars = useMemo(() => {
    const vars: Record<string, string> = {
      "--col-rn": `${numberWidth}px`,
      "--grid-cols": [
        "var(--col-rn)",
        ...columns.map((_, i) => `var(--col-${i})`),
      ].join(" "),
    };
    let total = numberWidth;
    for (const header of headers) {
      const size = header.getSize();
      vars[`--col-${header.id}`] = `${size}px`;
      total += size;
    }
    vars["--row-width"] = `${total}px`;
    return vars as CSSProperties;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getSize가 columnSizing을 읽는다
  }, [headers, columns, columnSizing, numberWidth]);
  const resizing = table.state.columnResizing.isResizingColumn;

  const rowRange = rowSpan(selection);

  return (
    <div
      ref={scrollRef}
      role="grid"
      tabIndex={0}
      aria-rowcount={receivedRows(result) + 1}
      className="bg-bg-0 text-small text-fg @container relative min-h-0 flex-1 overflow-auto font-mono outline-none"
      style={sizeVars}
      onKeyDown={onGridKeyDown}
    >
      <HeaderRow
        headers={headers}
        columns={columns}
        columnSizing={columnSizing}
        resizing={resizing}
        onFit={fitColumn}
      />
      <div
        className="relative w-(--row-width) min-w-full select-none"
        style={{ height: totalSize }}
        onClick={onBodyClick}
      >
        {firstRow > 0 && (
          <div
            role="row"
            className="border-line-1 absolute top-0 left-0 h-10 w-full border-b bg-[repeating-linear-gradient(135deg,var(--color-bg-1)_0_8px,var(--color-bg-0)_8px_16px)]"
          >
            <div className="sticky left-0 flex h-full w-[100cqw] items-center gap-3 px-3 font-sans">
              <span className="min-w-0 flex-1 truncate">
                {t("result.dropped", { end: firstRow })}
              </span>
              <Button size="small" onClick={onRunAgain}>
                {t("result.runAgain")}
              </Button>
            </div>
          </div>
        )}
        {items.map((item) => {
          const rowNumber = firstRow + item.index;
          return (
            <Row
              key={item.key}
              cells={rows[item.index]}
              rowNumber={rowNumber}
              top={item.start - HEADER_HEIGHT}
              selected={
                rowRange !== null &&
                rowNumber >= rowRange[0] &&
                rowNumber <= rowRange[1]
              }
              selectedColumn={
                selection?.kind === "cell" && selection.row === rowNumber
                  ? selection.column
                  : -1
              }
            />
          );
        })}
        <Footer
          top={totalSize - FOOTER_HEIGHT}
          fetching={fetch === "fetching"}
          endRows={endRows}
        />
      </div>
    </div>
  );
}

interface HeaderRowProps {
  headers: Header<Features, Cell[]>[];
  columns: string[];
  /** 너비가 바뀌면 다시 그린다. header object는 그대로라 크기는 이것으로 안다. */
  columnSizing: ColumnSizingState;
  /** 끄는 중인 column의 id. 없으면 false */
  resizing: string | false;
  onFit(index: number): void;
}

// 스크롤하는 동안에는 header 칸을 다시 그리지 않는다.
const HeaderRow = memo(function HeaderRow({
  headers,
  columns,
  resizing,
  onFit,
}: HeaderRowProps) {
  return (
    <div
      role="row"
      className="border-line-1 bg-bg-1 sticky top-0 z-10 grid h-8 w-(--row-width) min-w-full grid-cols-(--grid-cols) border-b font-sans font-semibold select-none"
    >
      <div role="columnheader" className="border-line-1 border-r" />
      {headers.map((header, index) => (
        <div
          key={header.id}
          role="columnheader"
          className="border-line-1 relative flex min-w-0 items-center border-r px-2.5"
          style={{ width: header.getSize() }}
        >
          <span className="truncate">{columns[index]}</span>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("result.resizeColumn", { name: columns[index] })}
            className={resizing === header.id ? HANDLE_ACTIVE : HANDLE}
            onMouseDown={header.getResizeHandler()}
            onDoubleClick={() => onFit(index)}
          />
        </div>
      ))}
    </div>
  );
});

const HANDLE =
  "absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize after:absolute after:inset-y-0 after:right-0 after:w-0.5 hover:after:bg-accent";
const HANDLE_ACTIVE = [HANDLE, "after:bg-accent"].join(" ");

const ROW =
  "absolute top-0 left-0 grid h-[26px] w-full grid-cols-(--grid-cols) border-b border-bg-2 leading-[25px]";
const ROW_SELECTED = [ROW, "bg-accent/14"].join(" ");
const ROW_NUMBER_BASE =
  "cursor-default truncate border-r border-bg-2 px-2.5 text-right";
const ROW_NUMBER = [ROW_NUMBER_BASE, "text-fg-3"].join(" ");
const ROW_NUMBER_SELECTED = [ROW_NUMBER_BASE, "text-fg"].join(" ");
const CELL = "truncate border-r border-bg-2 px-2.5";
const CELL_SELECTED =
  "bg-accent/16 shadow-[inset_0_0_0_1.5px_var(--color-accent)]";
/** [selected][tone]. tone은 0 보통, 1 muted, 2 muted italic(NULL) */
const CELL_CLASSES = [false, true].map((selected) =>
  [[], ["text-fg-3"], ["text-fg-3", "italic"]].map((tone) =>
    [CELL, ...tone, ...(selected ? [CELL_SELECTED] : [])].join(" "),
  ),
);

interface RowProps {
  cells: Cell[];
  /** 0부터 센 결과 안의 행 번호 */
  rowNumber: number;
  /** 몸통 위에서부터의 px */
  top: number;
  selected: boolean;
  /** 선택된 셀의 column. 없으면 -1 */
  selectedColumn: number;
}

// 스크롤하는 동안 props가 그대로인 행은 다시 그리지 않는다.
const Row = memo(function Row({
  cells,
  rowNumber,
  top,
  selected,
  selectedColumn,
}: RowProps) {
  return (
    <div
      role="row"
      aria-rowindex={rowNumber + 2}
      aria-selected={selected || undefined}
      data-row={rowNumber}
      className={selected ? ROW_SELECTED : ROW}
      style={{ transform: `translateY(${top}px)` }}
    >
      <div
        role="rowheader"
        className={selected ? ROW_NUMBER_SELECTED : ROW_NUMBER}
      >
        {formatCount(rowNumber + 1)}
      </div>
      {cells.map((value, column) => {
        const { text, muted, italic } = cellDisplay(value);
        const isSelected = column === selectedColumn;
        return (
          <div
            key={column}
            role="gridcell"
            aria-selected={isSelected || undefined}
            data-col={column}
            className={
              CELL_CLASSES[isSelected ? 1 : 0][italic ? 2 : muted ? 1 : 0]
            }
          >
            {text}
          </div>
        );
      })}
    </div>
  );
});

function Footer({
  top,
  fetching,
  endRows,
}: {
  top: number;
  fetching: boolean;
  endRows: number | null;
}) {
  const content =
    endRows !== null ? (
      tc("result.end", endRows)
    ) : fetching ? (
      <>
        <SpinnerIcon />
        {t("result.fetchingMore")}
      </>
    ) : null;
  if (content === null) return null;
  return (
    <div role="row" className="absolute left-0 h-[30px] w-full" style={{ top }}>
      <div className="text-fg-2 sticky left-0 flex h-full w-[100cqw] items-center justify-center gap-2 font-sans">
        {content}
      </div>
    </div>
  );
}

function* columnValues(
  rows: readonly Cell[][],
  column: number,
): Generator<Cell> {
  for (const row of rows) yield row[column];
}

function fitColumns(
  columns: readonly string[],
  rows: readonly Cell[][],
): ColumnSizingState {
  const sizing: ColumnSizingState = {};
  const measureHeader = headerMeasure();
  columns.forEach((name, index) => {
    sizing[String(index)] = fitWidth(
      name,
      columnValues(rows, index),
      measureHeader,
    );
  });
  return sizing;
}

/** Shift로 넓힐 때의 기준 행. 고른 것이 없으면 누른 행이다. */
function anchorOf(selection: Selection, row: number): number {
  if (selection === null) return row;
  return selection.kind === "rows" ? selection.anchor : selection.row;
}

function copyTargetOf({
  selection,
  firstRow,
  rows,
}: {
  selection: Selection;
  firstRow: number;
  rows: readonly Cell[][];
}): CopyTarget {
  if (selection === null) return null;
  if (selection.kind === "cell") {
    const row = rows[selection.row - firstRow];
    if (row === undefined) return null;
    return {
      text: copyCell(row[selection.column]),
      message: t("toast.copiedCell"),
    };
  }
  const picked = selectedRows(selection, firstRow, rows);
  if (picked.length === 0) return null;
  return { text: tsv(picked), message: tc("toast.copiedRows", picked.length) };
}
