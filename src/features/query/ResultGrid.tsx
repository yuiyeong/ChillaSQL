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
import type { Cell, ResultColumn, TypeInfo } from "../../shared/api/types";
import { formatCount, t, tc } from "../../shared/i18n/t";
import { Button } from "../../shared/ui/Button";
import { SpinnerIcon } from "../../shared/ui/icons";
import { Menu, MenuItem } from "../../shared/ui/Menu";
import { CellEditor } from "./CellEditor";
import { EditPreview } from "./EditPreview";
import { buildUpdates, type Changes, type UpdateStatement } from "./editSql";
import { useEdits } from "./editsStore";
import {
  editTargetOf,
  notEditableText,
  type EditTarget,
  type NotEditable,
} from "./editTarget";
import { useEditTables } from "./editTargetStore";
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
  rowViewOf,
  selectedRows,
  selectionRetained,
  shouldFetch,
  tsv,
  viewSpan,
  type FitColumn,
  type RowView,
  type Selection,
} from "./grid";
import { valueKind, type ValueKind } from "./cellDisplay";
import {
  dropGridView,
  runKeyOf,
  savedGridView,
  saveGridView,
  type GridView,
} from "./gridViews";
import { ResultNote } from "./ResultNote";
import { receivedRows, type ResultData } from "./runReducer";
import { useRuns } from "./runsStore";
import { rowsInView, type ExportSource } from "./exportRows";
import { nextSort, sortOrder, type SortState } from "./sortRows";
import { useColumnTypes } from "./typesStore";
import { ValueViewer } from "./ValueViewer";

/** 지금 선택을 복사할 text와 알림 문구. 선택이 없으면 null */
export type CopyTarget = { text: string; message: string } | null;

interface ResultGridProps {
  /** 결과를 낸 탭의 접속. 컬럼의 type과 편집할 테이블을 이 접속에서 읽는다. */
  connection: string | null;
  /** 탭 접속이 읽기 전용이면 셀을 편집하지 않는다. */
  readOnly: boolean;
  /** 결과를 낸 탭. 탭을 바꿨다 돌아오면 그 탭의 view(너비, 선택, 스크롤)를 이어 간다. */
  tabId: string;
  /** columns가 null이 아니다 */
  result: ResultData;
  /** 결과가 끝났으면 서버가 알려 준 전체 행 수 */
  endRows: number | null;
  onFetchMore(): void;
  onRunAgain(): void;
  onCopied(message: string): void;
  /** ResultPane header의 복사 버튼이 부른다 */
  copyTargetRef: RefObject<(() => CopyTarget) | null>;
  /** ResultPane header의 Apply가 보낼 UPDATE 문. 미리 보기와 같다 */
  statementsRef: RefObject<UpdateStatement[] | null>;
  /** ResultPane header의 Export가 부른다. 보관한 행을 보이는 순서로, 서버 값 그대로 준다 */
  exportSourceRef?: RefObject<ExportSource | null>;
  /** 복사할 선택이 생기거나 없어질 때(고른 행이 모두 버려진 때도). header 복사 버튼의 disabled에 쓴다 */
  onSelectionChange(hasSelection: boolean): void;
  /** 정렬을 켜거나 끌 때(탭을 바꿔 이어 간 정렬도). ResultPane이 일부만 정렬했다는 안내에 쓴다 */
  onSortChange(sorted: boolean): void;
}

// TanStack Table은 column 정의와 너비 조절에만 쓴다. row model은 부르지 않는다.
const features = tableFeatures({ columnSizingFeature, columnResizingFeature });
type Features = typeof features;
const NO_ROWS: Cell[][] = [];
const NO_COLUMNS: string[] = [];
const NO_RESULT_COLUMNS: ResultColumn[] = [];
const NO_ATTNUMS: number[] = [];

/** 첫 render가 쓰는 viewport 크기. 실제 크기는 ResizeObserver가 알려 준다. */
const INITIAL_RECT = { width: 800, height: 400 };
const OVERSCAN = 10;
const estimateSize = () => ROW_HEIGHT;

/**
 * 가상 스크롤 결과 표. 같은 실행 동안에는 batch마다 `result` object가 바뀌어도 상태를 이어 가고,
 * 다른 실행(`runKeyOf`가 다름. 여러 문장의 다른 문장도)이 오면 처음부터 다시 그린다(선택, 스크롤, 너비).
 * 다른 탭을 보다 돌아오면 그 탭이 같은 실행일 때 떠날 때의 view를 이어 간다.
 * props가 그대로면(알림, header 복사 버튼) 다시 그리지 않는다.
 */
export const ResultGrid = memo(function ResultGrid(props: ResultGridProps) {
  const runKey = runKeyOf(props.result);
  return <Grid key={`${props.tabId}\n${runKey}`} runKey={runKey} {...props} />;
});

/**
 * 그 탭이 아직 이 실행을 보여 줄 수 있는지. 여러 문장의 실행이면 끝난 앞 문장도 결과 탭으로 다시 본다.
 * release했거나 다시 실행했으면 false다.
 */
function isShownRun(tabId: string, runKey: string): boolean {
  const { runs, scripts } = useRuns.getState();
  return [runs[tabId], ...(scripts[tabId]?.done ?? [])].some(
    (run) =>
      (run?.status === "running" || run?.status === "finished") &&
      runKeyOf(run.result) === runKey,
  );
}

function Grid({
  tabId,
  connection,
  readOnly,
  runKey,
  result,
  endRows,
  onFetchMore,
  onRunAgain,
  onCopied,
  copyTargetRef,
  statementsRef,
  exportSourceRef,
  onSelectionChange,
  onSortChange,
}: ResultGridProps & { runKey: string }) {
  const { firstRow, rows, fetch } = result;
  const resultColumns = result.columns;
  const columns = useMemo(
    () => resultColumns?.map((column) => column.name) ?? NO_COLUMNS,
    [resultColumns],
  );
  // type은 늦게 오거나(결과가 먼저 도착), 접속의 schema를 새로 읽으면 사라질 수 있다. 모르면 text다.
  const columnTypes = useColumnTypes(
    connection,
    resultColumns ?? NO_RESULT_COLUMNS,
  );
  const fits = useMemo(() => columnTypes.map(fitColumnOf), [columnTypes]);
  const kinds = useMemo(() => fits.map((fit) => fit.kind), [fits]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 셀 편집. 행을 받는 중이면 편집하지 않는다. 테이블을 묻는 동안은 판단을 미룬다(null).
  const editTables = useEditTables(
    connection,
    resultColumns ?? NO_RESULT_COLUMNS,
  );
  const target = useMemo(
    () =>
      resultColumns === null
        ? null
        : editTargetOf(resultColumns, editTables, readOnly, fetch !== "none"),
    [resultColumns, editTables, readOnly, fetch],
  );
  // 결과 열마다 고칠 수 있는 컬럼의 attnum. 고칠 수 없는 열은 0이라 바뀐 값을 넣지도 보이지도 않는다.
  const attnums = useMemo(
    () =>
      target !== null && "table" in target
        ? target.columns.map((entry) =>
            "column" in entry ? entry.column.number : 0,
          )
        : NO_ATTNUMS,
    [target],
  );
  const tabEdits = useEdits((state) => state.edits[tabId]);
  // 다른 결과에서 고친 값은 이 표의 것이 아니다.
  const changes = tabEdits?.runKey === runKey ? tabEdits.changes : undefined;
  // Apply 실패 note가 ResultPane의 같은 자리에 뜨면 편집할 수 없다는 note는 그리지 않는다.
  const applyFailed = useEdits(
    (state) => changes !== undefined && tabId in state.failure,
  );

  // 떠날 때 저장한 view. 그 사이 앞 행이 버려졌으면 보던 행이 그 자리에 오게 스크롤을 당긴다.
  const [restored] = useState((): GridView | undefined => {
    const saved = savedGridView(tabId, runKey);
    if (saved === undefined) return undefined;
    const shift = anchorShift(saved.firstRow, firstRow);
    return { ...saved, scrollTop: Math.max(0, saved.scrollTop + shift) };
  });
  // 화면 내 정렬. 받은 행만 정렬하고, 행 번호와 선택과 편집은 결과 행 번호 그대로다.
  const [sort, setSort] = useState<SortState>(restored?.sort ?? null);
  const sortCategory =
    sort === null ? undefined : columnTypes[sort.column]?.category;
  const view = useMemo(
    () => rowViewOf(sortOrder(rows, sort, sortCategory)),
    [rows, sort, sortCategory],
  );
  const onSort = useCallback(
    (column: number) => setSort((current) => nextSort(current, column)),
    [],
  );

  // virtualizer가 처음 scroll 위치를 읽기 전에 둔다. 그래서 useVirtualizer보다 앞에 있다.
  useLayoutEffect(() => {
    if (restored !== undefined && scrollRef.current !== null) {
      scrollRef.current.scrollTop = restored.scrollTop;
    }
  }, [restored]);

  // 자동으로 맞춘 너비. 저장한 view를 이은 열은 사용자가 정한 너비라 자동으로 맞추지 않는다.
  const [initialSizing] = useState(() => {
    if (restored !== undefined) {
      return { sizing: restored.columnSizing, fitted: {} as FittedSizes };
    }
    const sizing = fitColumns(columns, rows, fits);
    return { sizing, fitted: fittedSizes(sizing, fits) };
  });
  const autoFit = useRef(initialSizing.fitted);
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(
    initialSizing.sizing,
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

  // 보이는 위치의 행을 결과 행 번호로 가리켜 정렬이 바뀌어도 같은 행의 element를 다시 쓴다.
  const getItemKey = useCallback(
    (index: number) => firstRow + (view.order?.[index] ?? index),
    [firstRow, view],
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
    initialOffset: restored?.scrollTop ?? 0,
  });
  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  // range는 getVirtualItems가 정한다. overscan을 뺀 보이는 범위다.
  const lastVisible = virtualizer.range?.endIndex ?? -1;

  const [selection, setSelection] = useState<Selection>(
    restored?.selection ?? null,
  );
  // 값 보기 panel. 열어 둔 채 고른 셀을 바꾸면 그 셀을 보이고, 셀이 아닌 것을 고르면 숨는다.
  const [viewerOpen, setViewerOpen] = useState(false);
  const viewedRow =
    viewerOpen && selection?.kind === "cell"
      ? rows[selection.row - firstRow]
      : undefined;
  const viewedValue =
    viewedRow !== undefined && selection?.kind === "cell"
      ? shownValue(viewedRow, selection.row, selection.column, attnums, changes)
      : null;
  // 열린 editor, 편집할 수 없다는 note, 셀의 우클릭 menu.
  // note는 띄운 때의 선택 object가 그대로인 동안만 보인다. 선택이 바뀌면 사라진다.
  const [editing, setEditing] = useState<{
    row: number;
    column: number;
    value: string;
  } | null>(null);
  const [note, setNote] = useState<{ text: string; at: Selection } | null>(
    null,
  );
  const [menu, setMenu] = useState<{
    at: { x: number; y: number };
    row: number;
    column: number;
  } | null>(null);
  const closeViewer = useCallback(() => {
    setViewerOpen(false);
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  // 아래 effect와 handler가 읽는 최신 값. render 중에는 쓰지 않는다.
  const latest = useRef({
    selection,
    columnSizing,
    sort,
    view,
    firstRow,
    rows,
    onCopied,
    onFetchMore,
  });
  useLayoutEffect(() => {
    const current = latest.current;
    current.selection = selection;
    current.columnSizing = columnSizing;
    current.sort = sort;
    current.view = view;
    current.firstRow = firstRow;
    current.rows = rows;
    current.onCopied = onCopied;
    current.onFetchMore = onFetchMore;
  });

  // 표가 사라질 때(다른 탭으로 감) view를 저장한다. 스크롤마다 쓰지 않고 여기서 한 번 읽는다.
  // layout effect의 cleanup은 element를 DOM에서 떼기 전에 돌아 scrollTop이 남아 있다.
  // 그 탭을 release했거나 다시 실행했으면 저장하지 않고 남은 것도 버린다.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    // object는 그대로이고 값만 바뀐다. cleanup은 떠날 때의 값을 읽는다.
    const current = latest.current;
    return () => {
      if (!isShownRun(tabId, runKey)) {
        dropGridView(tabId);
        return;
      }
      const { columnSizing, selection, sort, firstRow } = current;
      saveGridView(tabId, runKey, {
        columnSizing,
        selection,
        sort,
        firstRow,
        scrollTop: element?.scrollTop ?? 0,
      });
    };
  }, [tabId, runKey]);

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

  // type이 너비를 정한 뒤에 도착하면, 아직 끌지 않은 열은 type을 센 너비로 다시 맞춘다.
  useEffect(() => {
    const { columnSizing: sizing, rows: held } = latest.current;
    const fitted = autoFit.current;
    let next: ColumnSizingState | null = null;
    columns.forEach((name, index) => {
      const id = String(index);
      const entry = fitted[id];
      if (
        entry === undefined ||
        entry.type === fits[index].type ||
        sizing[id] !== entry.size
      ) {
        return;
      }
      const size = fitWidth(
        name,
        columnValues(held, index),
        headerMeasure(),
        fits[index],
      );
      fitted[id] = { size, type: fits[index].type };
      next ??= { ...sizing };
      next[id] = size;
    });
    if (next !== null) setColumnSizing(next);
  }, [columns, fits]);

  useEffect(() => {
    // 위치를 당긴 commit의 lastVisible은 당기기 전 scroll 위치로 셌다. 당긴 뒤의 scroll event가 다시 센다.
    if (anchored.current) {
      anchored.current = false;
      return;
    }
    // 정렬한 동안은 보이는 끝이 결과의 끝이 아니므로 다음 batch를 요청하지 않는다.
    if (sort === null && shouldFetch(lastVisible, rows.length, fetch)) {
      latest.current.onFetchMore();
    }
  }, [lastVisible, rows.length, fetch, firstRow, sort]);

  // 고른 행이 모두 버려졌으면 복사할 것이 없다. header 복사 버튼은 이것으로 disabled가 된다.
  const hasSelection = selectionRetained(
    selection,
    firstRow,
    rows.length,
    view,
  );
  useEffect(() => {
    onSelectionChange(hasSelection);
  }, [hasSelection, onSelectionChange]);
  const sorted = sort !== null;
  useEffect(() => {
    onSortChange(sorted);
  }, [sorted, onSortChange]);

  useImperativeHandle(
    copyTargetRef,
    () => () => copyTargetOf(latest.current),
    [],
  );
  useImperativeHandle(
    exportSourceRef,
    () => () => ({
      columns: resultColumns ?? NO_RESULT_COLUMNS,
      rows: rowsInView(latest.current.rows, latest.current.view),
      types: columnTypes,
    }),
    [resultColumns, columnTypes],
  );

  // Cmd+C와 Edit > Copy는 둘 다 copy event로 온다. focus가 표 안일 때만 가로챈다.
  useEffect(() => {
    const onCopy = (event: ClipboardEvent) => {
      const grid = scrollRef.current;
      if (grid === null || !grid.contains(document.activeElement)) return;
      // 셀 editor 안의 복사는 editor의 글자를 복사한다.
      if (document.activeElement instanceof HTMLTextAreaElement) return;
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
    // 같은 칸을 다시 누르면 선택 object를 그대로 둔다. note가 남는다.
    selectCell(row, Number(cellElement.dataset.col));
  };

  /** 그 칸을 고른다. 이미 고른 칸이면 지금 선택 object를 그대로 돌려준다. */
  const selectCell = (row: number, column: number): Selection => {
    const same =
      selection?.kind === "cell" &&
      selection.row === row &&
      selection.column === column;
    const next: Selection = same ? selection : { kind: "cell", row, column };
    setSelection(next);
    return next;
  };

  /** 고칠 수 있는 칸이면 editor를 열고, 아니면 그 이유를 note로 띄운다. 판단을 미루는 동안은 아무것도 않는다. */
  const startEdit = (row: number, column: number, at: Selection) => {
    const cells = rows[row - firstRow];
    const edit = editOf(target, column);
    if (cells === undefined || edit === null) return;
    if (typeof edit === "string") {
      setNote({ text: edit, at });
      return;
    }
    setNote(null);
    const value = shownValue(cells, row, column, attnums, changes);
    setEditing({ row, column, value: value ?? "" });
  };

  /** 이벤트가 난 셀의 결과 행 번호와 열. 셀이 아니면 null */
  const cellAt = (element: Element): { row: number; column: number } | null => {
    const rowElement = element.closest<HTMLElement>("[data-row]");
    const cellElement = element.closest<HTMLElement>("[data-col]");
    if (rowElement === null || cellElement === null) return null;
    return {
      row: Number(rowElement.dataset.row),
      column: Number(cellElement.dataset.col),
    };
  };

  const onBodyDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const at = cellAt(event.target as Element);
    if (at === null) return;
    startEdit(at.row, at.column, selectCell(at.row, at.column));
  };

  // 고칠 수 있는 셀에서만 연다. 아니면 WebKit의 menu를 그대로 둔다.
  const onBodyContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const at = cellAt(event.target as Element);
    if (at === null || typeof editOf(target, at.column) !== "number") return;
    event.preventDefault();
    selectCell(at.row, at.column);
    setMenu({ at: { x: event.clientX, y: event.clientY }, ...at });
  };

  /** 셀의 값을 바꾼다. 원래 값과 같으면 store가 변경을 지운다. */
  const setCell = (row: number, column: number, value: Cell) => {
    const original = rows[row - firstRow]?.[column];
    const attnum = attnums[column] ?? 0;
    if (original === undefined || attnum === 0) return;
    useEdits.getState().setCell(tabId, runKey, row, attnum, value, original);
  };

  /** editor를 닫는다. key로 닫았으면(focus가 editor에 있음) 표에 focus를 돌린다. blur면 누른 곳이 focus를 가진다. */
  const closeEditor = () => {
    setEditing(null);
    if (document.activeElement instanceof HTMLTextAreaElement) {
      scrollRef.current?.focus({ preventScroll: true });
    }
  };

  // WebKit은 Home, End(Cmd+위아래 화살표)를 애니메이션으로 스크롤한다. 한 frame에 수천 행씩 지나가
  // 그 frame의 행을 그리기 전에 화면이 먼저 움직여 빈 몸통이 보인다. 끝으로 바로 가면 scroll event가 한 번이다.
  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      if (selection?.kind === "cell") {
        event.preventDefault();
        startEdit(selection.row, selection.column, selection);
      }
      return;
    }
    if (event.key === "Enter" && event.shiftKey) {
      // 고른 셀이 있을 때만 연다. 전역 단축키가 아니라 표에 focus가 있을 때의 key다.
      if (viewerOpen) {
        event.preventDefault();
        setViewerOpen(false);
      } else if (selection?.kind === "cell") {
        event.preventDefault();
        setViewerOpen(true);
      }
      return;
    }
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
    (index: number) => {
      const size = fitWidth(
        columns[index],
        columnValues(latest.current.rows, index),
        headerMeasure(),
        fits[index],
      );
      autoFit.current[String(index)] = { size, type: fits[index].type };
      setColumnSizing((old) => ({ ...old, [String(index)]: size }));
    },
    [columns, fits],
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

  // 행 선택의 범위는 보이는 위치로 센다.
  const rowRange = viewSpan(selection, firstRow, rows.length, view);

  // Apply가 보낼 UPDATE 문. 바뀐 값이 있고 편집할 수 있는 결과일 때만 있다.
  const statements = useMemo(() => {
    if (changes === undefined || target === null || !("table" in target)) {
      return [];
    }
    return buildUpdates(
      target,
      changes,
      (row) => rows[row - firstRow],
      columnTypes.map((type) => type?.category),
    );
  }, [changes, target, rows, firstRow, columnTypes]);
  useImperativeHandle(statementsRef, () => statements, [statements]);

  const menuChanged =
    menu !== null &&
    changes?.get(menu.row)?.has(attnums[menu.column] ?? 0) === true;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {note !== null && note.at === selection && !applyFailed && (
        <ResultNote>{note.text}</ResultNote>
      )}
      <div
        className="flex min-h-0 flex-1"
        onKeyDown={(event) => {
          if (event.key === "Escape" && viewerOpen && !event.defaultPrevented) {
            event.preventDefault();
            closeViewer();
          }
        }}
      >
        <div
          ref={scrollRef}
          role="grid"
          tabIndex={0}
          aria-rowcount={receivedRows(result) + 1}
          className="bg-bg-0 text-small text-fg @container relative min-h-0 min-w-0 flex-1 overflow-auto font-mono outline-none"
          style={sizeVars}
          onKeyDown={onGridKeyDown}
        >
          <HeaderRow
            headers={headers}
            columns={columns}
            types={columnTypes}
            kinds={kinds}
            columnSizing={columnSizing}
            resizing={resizing}
            sort={sort}
            onSort={onSort}
            onFit={fitColumn}
          />
          <div
            className="relative w-(--row-width) min-w-full select-none"
            style={{ height: totalSize }}
            onClick={onBodyClick}
            onDoubleClick={onBodyDoubleClick}
            onContextMenu={onBodyContextMenu}
          >
            {firstRow > 0 && (
              <div
                role="row"
                className="border-line-1 absolute top-0 left-0 h-10 w-full border-b bg-[repeating-linear-gradient(135deg,var(--color-bg-1)_0_8px,var(--color-bg-0)_8px_16px)]"
              >
                <div className="sticky left-0 flex h-full w-[100cqw] items-center gap-3 px-3 font-sans">
                  <span className="min-w-0 flex-1 truncate">
                    {t("result.dropped", { end: formatCount(firstRow) })}
                  </span>
                  <Button size="small" onClick={onRunAgain}>
                    {t("result.runAgain")}
                  </Button>
                </div>
              </div>
            )}
            {items.map((item) => {
              const index = view.order?.[item.index] ?? item.index;
              const rowNumber = firstRow + index;
              return (
                <Row
                  key={item.key}
                  cells={rows[index]}
                  kinds={kinds}
                  attnums={attnums}
                  changed={changes?.get(rowNumber)}
                  rowNumber={rowNumber}
                  top={item.start - HEADER_HEIGHT}
                  selected={
                    rowRange !== null &&
                    item.index >= rowRange[0] &&
                    item.index <= rowRange[1]
                  }
                  selectedColumn={
                    selection?.kind === "cell" && selection.row === rowNumber
                      ? selection.column
                      : -1
                  }
                />
              );
            })}
            {editing !== null && (
              // 행이 아니라 몸통에 두어 가상 스크롤이 그 행을 지워도 남는다.
              <CellEditor
                label={t("edit.editor", { name: columns[editing.column] })}
                value={editing.value}
                style={editorBox(
                  editing.column,
                  view.position?.[editing.row - firstRow] ??
                    editing.row - firstRow,
                  firstRow,
                  numberWidth,
                  headers.map((header) => header.getSize()),
                )}
                onCommit={(value) => {
                  // 연 값 그대로 확정하면 변경이 아니다. NULL이 보이던 셀은 빈 채로 열리므로 NULL 그대로다.
                  if (value !== editing.value) {
                    setCell(editing.row, editing.column, value);
                  }
                  closeEditor();
                }}
                onCancel={closeEditor}
              />
            )}
            <Footer
              top={totalSize - FOOTER_HEIGHT}
              fetching={fetch === "fetching"}
              endRows={endRows}
              received={receivedRows(result)}
            />
          </div>
        </div>
        {viewedRow !== undefined && selection?.kind === "cell" && (
          <ValueViewer
            column={resultColumns![selection.column]}
            type={columnTypes[selection.column]}
            row={selection.row + 1}
            value={viewedValue}
            onClose={closeViewer}
            onCopied={onCopied}
          />
        )}
      </div>
      {statements.length > 0 && <EditPreview statements={statements} />}
      <Menu
        open={menu !== null}
        onClose={() => setMenu(null)}
        anchor={scrollRef}
        at={menu?.at}
        label={t("edit.menu")}
      >
        {menu !== null && (
          <>
            <MenuItem onSelect={() => setCell(menu.row, menu.column, null)}>
              {t("edit.setNull")}
            </MenuItem>
            {menuChanged && (
              <MenuItem
                onSelect={() =>
                  useEdits
                    .getState()
                    .revertCell(tabId, menu.row, attnums[menu.column])
                }
              >
                {t("edit.revertValue")}
              </MenuItem>
            )}
          </>
        )}
      </Menu>
    </div>
  );
}

/**
 * 그 열을 고칠 수 있으면 attnum, 없으면 note 문구다. 아직 모르면(테이블을 묻는 중) null이다.
 */
function editOf(
  target: EditTarget | NotEditable | null,
  column: number,
): number | string | null {
  if (target === null) return null;
  if (!("table" in target)) return notEditableText(target);
  const entry = target.columns[column];
  return "column" in entry ? entry.column.number : notEditableText(entry);
}

/** 표에 보이는 값. 바뀐 값이 있으면 그것이다. 같은 attnum의 열은 모두 같은 바뀐 값을 보인다. */
function shownValue(
  cells: Cell[],
  row: number,
  column: number,
  attnums: readonly number[],
  changes: Changes | undefined,
): Cell {
  const attnum = attnums[column] ?? 0;
  const changed = changes?.get(row);
  if (attnum !== 0 && changed?.has(attnum)) return changed.get(attnum) as Cell;
  return cells[column];
}

/** editor의 자리. 그 셀(보이는 위치 `position`의 행)과 같은 left, top, width다. */
function editorBox(
  column: number,
  position: number,
  firstRow: number,
  numberWidth: number,
  sizes: readonly number[],
): CSSProperties {
  let left = numberWidth;
  for (let index = 0; index < column; index++) left += sizes[index];
  const top = (firstRow > 0 ? GAP_HEIGHT : 0) + position * ROW_HEIGHT;
  return { left, top, width: sizes[column] };
}

interface HeaderRowProps {
  headers: Header<Features, Cell[]>[];
  columns: string[];
  /** 컬럼의 type. 아직 모르면 undefined */
  types: (TypeInfo | undefined)[];
  /** 컬럼마다 값을 그리는 방식 */
  kinds: readonly ValueKind[];
  /** 너비가 바뀌면 다시 그린다. header object는 그대로라 크기는 이것으로 안다. */
  columnSizing: ColumnSizingState;
  /** 끄는 중인 column의 id. 없으면 false */
  resizing: string | false;
  sort: SortState;
  /** 이름 부분을 누르면 그 열의 다음 정렬로 */
  onSort(index: number): void;
  onFit(index: number): void;
}

// 스크롤하는 동안에는 header 칸을 다시 그리지 않는다.
const HeaderRow = memo(function HeaderRow({
  headers,
  columns,
  types,
  kinds,
  resizing,
  sort,
  onSort,
  onFit,
}: HeaderRowProps) {
  return (
    <div
      role="row"
      className="border-line-1 bg-bg-1 sticky top-0 z-10 grid h-8 w-(--row-width) min-w-full grid-cols-(--grid-cols) border-b font-sans font-semibold select-none"
    >
      <div role="columnheader" className="border-line-1 border-r" />
      {headers.map((header, index) => {
        const right = kinds[index] === "number";
        const direction = sort?.column === index ? sort.direction : null;
        return (
          <div
            key={header.id}
            role="columnheader"
            aria-sort={direction === null ? undefined : SORT_ARIA[direction]}
            className={right ? HEADER_RIGHT : HEADER}
            style={{ width: header.getSize() }}
          >
            {/* 리사이즈 handle은 이 button 밖에 있어 끌거나 두 번 눌러도 정렬하지 않는다. */}
            <button
              type="button"
              aria-label={
                direction === null
                  ? undefined
                  : t(SORT_LABEL[direction], { name: columns[index] })
              }
              className={right ? SORT_BUTTON_RIGHT : SORT_BUTTON}
              onClick={() => onSort(index)}
            >
              <span className="truncate">{columns[index]}</span>
              {types[index] !== undefined && (
                <span className="text-label text-fg-3 min-w-0 truncate font-mono font-normal">
                  {types[index].name}
                </span>
              )}
              {direction !== null && (
                <span aria-hidden className="text-fg-2 font-normal">
                  {SORT_ARROW[direction]}
                </span>
              )}
            </button>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("result.resizeColumn", { name: columns[index] })}
              className={resizing === header.id ? HANDLE_ACTIVE : HANDLE}
              onMouseDown={header.getResizeHandler()}
              onDoubleClick={() => onFit(index)}
            />
          </div>
        );
      })}
    </div>
  );
});

const SORT_ARIA = { asc: "ascending", desc: "descending" } as const;
const SORT_LABEL = {
  asc: "result.sortAscending",
  desc: "result.sortDescending",
} as const;
const SORT_ARROW = { asc: "↑", desc: "↓" } as const;
const SORT_BUTTON =
  "flex h-full min-w-0 flex-1 cursor-default items-center gap-1.5 text-left";
const SORT_BUTTON_RIGHT = [SORT_BUTTON, "justify-end"].join(" ");

const HEADER =
  "border-line-1 relative flex min-w-0 items-center gap-1.5 border-r px-2.5";
const HEADER_RIGHT = [HEADER, "justify-end"].join(" ");

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
/** Apply하지 않은 바뀐 값(캔버스 Tools M10) */
const CELL_CHANGED = "bg-accent/8 shadow-[inset_2px_0_0_var(--color-accent)]";
/** 0 보통, 1 muted, 2 muted italic(NULL), 3 숫자 */
const TONES = [
  [],
  ["text-fg-3"],
  ["text-fg-3", "italic"],
  ["text-syntax-number"],
];
/** [보통 0, 고름 1, 바뀜 2][tone][right]. 숫자 열은 오른쪽 정렬이다. 고른 칸은 바뀌었어도 고른 모양이다. */
const CELL_CLASSES = [[], [CELL_SELECTED], [CELL_CHANGED]].map((state) =>
  TONES.map((tone) =>
    [false, true].map((right) =>
      [CELL, ...tone, ...(right ? ["text-right"] : []), ...state].join(" "),
    ),
  ),
);

interface RowProps {
  cells: Cell[];
  /** 열마다 값을 그리는 방법 */
  kinds: readonly ValueKind[];
  /** 열마다 고칠 수 있는 컬럼의 attnum. 고칠 수 없는 열은 0 */
  attnums: readonly number[];
  /** 이 행의 바뀐 값(attnum →). 없으면 undefined */
  changed: Map<number, Cell> | undefined;
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
  kinds,
  attnums,
  changed,
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
      {cells.map((original, column) => {
        const kind = kinds[column] ?? "text";
        const attnum = attnums[column] ?? 0;
        const isChanged = attnum !== 0 && changed?.has(attnum) === true;
        const value = isChanged ? (changed!.get(attnum) as Cell) : original;
        const { text, dim, muted, italic } = cellDisplay(value, kind);
        const isSelected = column === selectedColumn;
        const tone = italic ? 2 : muted ? 1 : kind === "number" ? 3 : 0;
        const state = isSelected ? 1 : isChanged ? 2 : 0;
        return (
          <div
            key={column}
            role="gridcell"
            aria-selected={isSelected || undefined}
            data-col={column}
            data-changed={isChanged || undefined}
            className={CELL_CLASSES[state][tone][kind === "number" ? 1 : 0]}
          >
            {text}
            {dim !== null && <span className="text-fg-3"> {dim}</span>}
          </div>
        );
      })}
    </div>
  );
});

/**
 * 표 끝 줄. 끝난 결과는 전체 행 수다. 끝까지 읽은 앞 문장(`drain`)은 첫 batch만 받았으므로 받은 행이
 * 전체보다 적으면 그만큼만 보인다고 쓴다.
 */
function Footer({
  top,
  fetching,
  endRows,
  received,
}: {
  top: number;
  fetching: boolean;
  endRows: number | null;
  /** 지금까지 받은 행 수(버린 앞 행 포함) */
  received: number;
}) {
  const content =
    endRows !== null ? (
      received < endRows ? (
        t("result.firstRowsOf", {
          shown: formatCount(received),
          total: formatCount(endRows),
        })
      ) : (
        tc("result.end", endRows)
      )
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

/** 열 너비를 맞출 때 쓰는 type 표시. 모르는 type이면 비어 있다. */
function fitColumnOf(
  type: TypeInfo | undefined,
): FitColumn & { kind: ValueKind } {
  return { type: type?.name, kind: valueKind(type) };
}

function fitColumns(
  columns: readonly string[],
  rows: readonly Cell[][],
  fits: readonly FitColumn[],
): ColumnSizingState {
  const sizing: ColumnSizingState = {};
  const measureHeader = headerMeasure();
  columns.forEach((name, index) => {
    sizing[String(index)] = fitWidth(
      name,
      columnValues(rows, index),
      measureHeader,
      fits[index],
    );
  });
  return sizing;
}

/** 자동으로 맞춘 열의 너비와 그때 header에 쓴 type 이름. 열 id로 찾는다. */
type FittedSizes = Record<string, { size: number; type: string | undefined }>;

function fittedSizes(
  sizing: ColumnSizingState,
  fits: readonly FitColumn[],
): FittedSizes {
  return Object.fromEntries(
    fits.map((fit, index) => [
      String(index),
      { size: sizing[String(index)], type: fit.type },
    ]),
  );
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
  view,
}: {
  selection: Selection;
  firstRow: number;
  rows: readonly Cell[][];
  view: RowView;
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
  const picked = selectedRows(selection, firstRow, rows, view);
  if (picked.length === 0) return null;
  return { text: tsv(picked), message: tc("toast.copiedRows", picked.length) };
}
