import {
  createRef,
  type ComponentProps,
  type ReactElement,
  type RefObject,
} from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import { describeTables } from "../../shared/api/commands";
import type {
  Cell,
  EditTable,
  ResultColumn,
  TypeInfo,
} from "../../shared/api/types";
import { change } from "../../test/change";
import { resultColumns } from "../../test/fixtures";
import { stubLayout } from "../../test/layout";
import { useEditTableCache } from "./editTargetStore";
import { useEdits } from "./editsStore";
import { fitWidth, rowNumberWidth } from "./grid";
import { runKeyOf } from "./gridViews";
import { ResultGrid, type CopyTarget } from "./ResultGrid";
import { emptyResult, type ResultData } from "./runReducer";
import { useRuns } from "./runsStore";
import { typeKey, useTypes } from "./typesStore";

type Props = ComponentProps<typeof ResultGrid>;

// 결과 panel 크기의 viewport로 둔다.
beforeEach(() => {
  vi.resetAllMocks();
  stubLayout({ width: 800, height: 400 });
  useTypes.getState().reset();
  useEditTableCache.getState().reset();
  useEdits.getState().reset();
});

function rowsOf(count: number, from = 0): Cell[][] {
  return Array.from({ length: count }, (_, i) => [
    String(from + i + 1),
    `user${from + i + 1}@example.com`,
  ]);
}

function result(patch: Partial<ResultData> = {}): ResultData {
  return {
    ...emptyResult(
      {
        sql: "SELECT id, email FROM users",
        from: 0,
        origin: { line: 1, column: 1 },
      },
      "run-0",
      1000,
    ),
    columns: resultColumns("id", "email"),
    rows: rowsOf(3),
    elapsedMicros: 38000,
    fetch: "ready",
    ...patch,
  };
}

function props(patch: Partial<Props> = {}): Props {
  return {
    tabId: "t",
    connection: "local",
    readOnly: false,
    result: result(),
    endRows: null,
    onFetchMore: vi.fn(),
    onRunAgain: vi.fn(),
    onCopied: vi.fn(),
    copyTargetRef: createRef() as RefObject<(() => CopyTarget) | null>,
    statementsRef: createRef(),
    onSelectionChange: vi.fn(),
    onSortChange: vi.fn(),
    onStatementsChange: vi.fn(),
    ...patch,
  };
}

function setup(patch: Partial<Props> = {}, extra?: ReactElement) {
  const p = props(patch);
  const view = render(
    <>
      {extra}
      <ResultGrid {...p} />
    </>,
  );
  const rerender = (next: Partial<Props>) =>
    view.rerender(
      <>
        {extra}
        <ResultGrid {...p} {...next} />
      </>,
    );
  return { props: p, rerender, grid: () => screen.getByRole("grid") };
}

function cell(text: string): HTMLElement {
  return screen.getByText(text).closest<HTMLElement>("[role=gridcell]")!;
}

function rowHeader(label: string): HTMLElement {
  return screen.getByRole("rowheader", { name: label });
}

// header 칸의 이름에는 handle의 label도 들어가므로 글자로 찾는다.
function columnHeader(name: string): HTMLElement {
  return screen.getByText(name).closest<HTMLElement>("[role=columnheader]")!;
}

function copy(target: Element) {
  const clipboardData = { setData: vi.fn() };
  const notPrevented = fireEvent.copy(target, { clipboardData });
  return { setData: clipboardData.setData, prevented: !notPrevented };
}

test("보이는 행만 그린다", () => {
  setup({ result: result({ rows: rowsOf(10_000) }) });

  const rows = screen.getAllByRole("row");
  expect(rows.length).toBeGreaterThan(10);
  expect(rows.length).toBeLessThan(100);
  expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "10001");
});

test("행 번호는 firstRow부터 센다", () => {
  const { props: p } = setup({
    result: result({ firstRow: 24_500, rows: rowsOf(1000, 24_500) }),
  });

  expect(screen.getAllByRole("rowheader")[0]).toHaveTextContent("24,501");
  expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", "25501");
  expect(
    screen.getByText("Rows 1–24,500 were dropped · run again to see them"),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Run again" }));
  expect(p.onRunAgain).toHaveBeenCalledTimes(1);
});

test("버린 행이 없으면 버린 구간 줄이 없다", () => {
  setup();

  expect(screen.getAllByRole("rowheader")[0]).toHaveTextContent("1");
  expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
});

test("NULL과 빈 문자열을 구분해 그린다", () => {
  setup({
    result: result({
      columns: resultColumns("a", "b", "c"),
      rows: [[null, "", "NULL"]],
    }),
  });

  const [nullCell, textCell] = screen.getAllByText("NULL");
  expect(nullCell).toHaveClass("italic", "text-fg-3");
  expect(textCell).not.toHaveClass("italic");
  expect(textCell).not.toHaveClass("text-fg-3");
  const empty = screen.getByText("''");
  expect(empty).toHaveClass("text-fg-3");
  expect(empty).not.toHaveClass("italic");
});

test("끝 가까이 스크롤하면 onFetchMore를 부른다", () => {
  const ready = setup({ result: result({ rows: rowsOf(500) }) });
  expect(ready.props.onFetchMore).not.toHaveBeenCalled();
  ready.grid().scrollTop = 500 * 26;
  fireEvent.scroll(ready.grid());
  expect(ready.props.onFetchMore).toHaveBeenCalledTimes(1);
});

test("가져오는 중이거나 끝난 결과는 onFetchMore를 부르지 않는다", () => {
  const fetching = setup({
    result: result({ rows: rowsOf(500), fetch: "fetching" }),
  });
  fetching.grid().scrollTop = 500 * 26;
  fireEvent.scroll(fetching.grid());
  expect(fetching.props.onFetchMore).not.toHaveBeenCalled();
  expect(screen.getByText("Fetching next 500 rows")).toBeInTheDocument();
});

test("끝난 결과는 onFetchMore를 부르지 않고 끝을 알린다", () => {
  // 끝난 결과는 reducer가 fetch를 none으로 둔다.
  const done = setup({
    result: result({ rows: rowsOf(500), fetch: "none" }),
    endRows: 500,
  });
  done.grid().scrollTop = 500 * 26;
  fireEvent.scroll(done.grid());
  expect(done.props.onFetchMore).not.toHaveBeenCalled();
  expect(screen.getByText("End · 500 rows")).toBeInTheDocument();
  expect(screen.queryByText("Fetching next 500 rows")).toBeNull();
});

test("앞쪽 행이 버려져도 보던 행이 그 자리에 있다", () => {
  const { rerender, grid } = setup({ result: result({ rows: rowsOf(1000) }) });
  grid().scrollTop = 13_000;

  rerender({ result: result({ firstRow: 500, rows: rowsOf(1000, 500) }) });
  expect(grid().scrollTop).toBe(13_000 + 40 - 500 * 26);

  // 뒤에 붙기만 하면 그대로다.
  grid().scrollTop = 5_000;
  rerender({ result: result({ firstRow: 500, rows: rowsOf(1500, 500) }) });
  expect(grid().scrollTop).toBe(5_000);
});

test("위치를 당긴 직후에는 당기기 전 위치로 세어 이어서 가져오지 않는다", () => {
  const {
    props: p,
    rerender,
    grid,
  } = setup({
    result: result({ rows: rowsOf(1000), fetch: "fetching" }),
  });
  grid().scrollTop = 1000 * 26;
  fireEvent.scroll(grid());

  // 맨 아래에서 batch가 와 앞 500행이 버려졌다. 보던 행은 이제 가운데쯤이다.
  rerender({ result: result({ firstRow: 500, rows: rowsOf(1000, 500) }) });
  expect(p.onFetchMore).not.toHaveBeenCalled();

  fireEvent.scroll(grid());
  expect(p.onFetchMore).not.toHaveBeenCalled();
});

test("셀을 누르고 복사하면 값이 가고 알림을 부른다", () => {
  const { props: p, grid } = setup();

  fireEvent.click(cell("user2@example.com"));
  expect(document.activeElement).toBe(grid());
  expect(cell("user2@example.com")).toHaveAttribute("aria-selected", "true");
  expect(p.onSelectionChange).toHaveBeenLastCalledWith(true);

  const { setData, prevented } = copy(grid());
  expect(setData).toHaveBeenCalledWith("text/plain", "user2@example.com");
  expect(prevented).toBe(true);
  expect(p.onCopied).toHaveBeenCalledWith("Copied cell");
  expect(p.copyTargetRef.current?.()).toEqual({
    text: "user2@example.com",
    message: "Copied cell",
  });
});

test("행 번호를 Shift와 누르면 범위를 TSV로 복사한다", () => {
  const { props: p, grid } = setup();

  fireEvent.click(rowHeader("2"));
  fireEvent.click(rowHeader("3"), { shiftKey: true });
  expect(
    screen
      .getAllByRole("row")
      .filter((row) => row.getAttribute("aria-selected") === "true"),
  ).toHaveLength(2);

  const { setData } = copy(grid());
  expect(setData).toHaveBeenCalledWith(
    "text/plain",
    "2\tuser2@example.com\n3\tuser3@example.com",
  );
  expect(p.onCopied).toHaveBeenCalledWith("Copied 2 rows (tab-separated)");
});

test("focus가 결과 표 밖이면 copy를 건드리지 않는다", () => {
  const { props: p } = setup({}, <textarea aria-label="editor" />);

  fireEvent.click(cell("user1@example.com"));
  const editor = screen.getByRole("textbox", { name: "editor" });
  editor.focus();

  const { setData, prevented } = copy(editor);
  expect(setData).not.toHaveBeenCalled();
  expect(prevented).toBe(false);
  expect(p.onCopied).not.toHaveBeenCalled();
});

test("선택이 없으면 copy를 건드리지 않는다", () => {
  const { props: p, grid } = setup();
  grid().focus();

  const { setData, prevented } = copy(grid());
  expect(setData).not.toHaveBeenCalled();
  expect(prevented).toBe(false);
  expect(p.copyTargetRef.current?.()).toBeNull();
});

test("고른 행이 모두 버려지면 복사할 것이 없다고 알린다", () => {
  const { props: p, rerender } = setup({
    result: result({ rows: rowsOf(1000) }),
  });
  fireEvent.click(rowHeader("2"));
  fireEvent.click(rowHeader("3"), { shiftKey: true });
  expect(p.onSelectionChange).toHaveBeenLastCalledWith(true);

  // 범위의 일부(3번째 행)가 남아 있으면 그대로다.
  rerender({ result: result({ firstRow: 2, rows: rowsOf(1000, 2) }) });
  expect(p.onSelectionChange).toHaveBeenLastCalledWith(true);

  rerender({ result: result({ firstRow: 500, rows: rowsOf(1000, 500) }) });
  expect(p.onSelectionChange).toHaveBeenLastCalledWith(false);
  expect(p.copyTargetRef.current?.()).toBeNull();
});

test("고른 셀의 행이 버려지면 복사할 것이 없다고 알린다", () => {
  const { props: p, rerender } = setup({
    result: result({ rows: rowsOf(1000) }),
  });
  fireEvent.click(cell("user1@example.com"));
  expect(p.onSelectionChange).toHaveBeenLastCalledWith(true);

  rerender({ result: result({ firstRow: 500, rows: rowsOf(1000, 500) }) });
  expect(p.onSelectionChange).toHaveBeenLastCalledWith(false);
});

test("다시 실행하면 선택과 스크롤을 처음으로 돌린다", () => {
  const {
    props: p,
    rerender,
    grid,
  } = setup({
    result: result({ rows: rowsOf(1000) }),
  });
  fireEvent.click(cell("user1@example.com"));
  grid().scrollTop = 2_600;

  rerender({ result: result({ rows: rowsOf(1000), startedAt: 2000 }) });

  expect(grid().scrollTop).toBe(0);
  expect(grid().querySelectorAll("[aria-selected=true]")).toHaveLength(0);
  expect(p.onSelectionChange).toHaveBeenLastCalledWith(false);
  expect(p.copyTargetRef.current?.()).toBeNull();
});

test("처음 너비는 header와 첫 batch에 맞춘다", () => {
  const rows = rowsOf(3);
  setup({ result: result({ rows }) });

  const header = columnHeader("email");
  expect(header.style.width).toBe(
    `${fitWidth(
      "email",
      rows.map((row) => row[1]),
    )}px`,
  );
});

test("header 이름은 값과 다른 글꼴(system font semibold)의 너비로 맞춘다", () => {
  setup({
    result: result({ columns: resultColumns("amount"), rows: [["1"]] }),
  });

  // jsdom에는 canvas가 없어 반각 한 칸 9px로 어림한다. D2Coding으로 세면 64px로 잘린다.
  expect(columnHeader("amount").style.width).toBe(`${6 * 9 + 20 + 1}px`);
});

test("handle을 두 번 누르면 내용에 맞춘다", () => {
  const rows = rowsOf(3);
  setup({ result: result({ rows }) });
  const fit = fitWidth(
    "email",
    rows.map((row) => row[1]),
  );
  const header = columnHeader("email");
  const handle = within(header).getByRole("separator");

  fireEvent.mouseDown(handle, { clientX: 500 });
  // 끄는 동안 handle의 선이 켜져 있다.
  expect(handle).toHaveClass("after:bg-accent");
  fireEvent.mouseMove(document, { clientX: 470 });
  fireEvent.mouseUp(document, { clientX: 470 });
  expect(header.style.width).toBe(`${fit - 30}px`);
  expect(handle).not.toHaveClass("after:bg-accent");

  fireEvent.doubleClick(handle);
  expect(header.style.width).toBe(`${fit}px`);
});

// WebKit은 Home, End를 애니메이션으로 스크롤한다. 한 frame에 수천 행씩 지나가 행을 그리기 전의 빈 몸통이 보인다.
test.each([
  ["End", {}, 26_000],
  ["ArrowDown", { metaKey: true }, 26_000],
  ["Home", {}, 0],
  ["ArrowUp", { metaKey: true }, 0],
])("%s(%o)는 애니메이션 없이 끝으로 바로 간다", (key, modifiers, expected) => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
    26_000,
  );
  const { grid } = setup({ result: result({ rows: rowsOf(1000) }) });
  grid().scrollTop = 13_000;

  const notPrevented = fireEvent.keyDown(grid(), { key, ...modifiers });

  expect(notPrevented).toBe(false);
  expect(grid().scrollTop).toBe(expected);
});

test("다른 key와 grid 안의 버튼에서 온 key는 그대로 둔다", () => {
  const { grid } = setup({
    result: result({ rows: rowsOf(1000), firstRow: 500 }),
  });
  grid().scrollTop = 13_000;

  expect(fireEvent.keyDown(grid(), { key: "PageDown" })).toBe(true);
  expect(
    fireEvent.keyDown(screen.getByRole("button", { name: "Run again" }), {
      key: "End",
    }),
  ).toBe(true);
  expect(grid().scrollTop).toBe(13_000);
});

/** 접속 local이 아는 type으로 컬럼을 만든다. OID는 index로 구분한다. */
function typedColumns(
  ...specs: [name: string, type: string, category: string][]
): ResultColumn[] {
  const infos: TypeInfo[] = specs.map(([, name, category], i) => ({
    oid: 100 + i,
    modifier: -1,
    name,
    category,
  }));
  useTypes.setState({
    types: {
      local: Object.fromEntries(
        infos.map((info) => [typeKey(info.oid, info.modifier), info]),
      ),
    },
  });
  return specs.map(([name], i) => ({
    name,
    typeOid: 100 + i,
    typeModifier: -1,
    tableOid: 0,
    columnNumber: 0,
  }));
}

test("header_shows_the_type", () => {
  setup({
    result: result({
      columns: typedColumns(["id", "bigint", "N"], ["email", "text", "S"]),
      rows: rowsOf(1),
    }),
  });

  const id = columnHeader("id");
  expect(within(id).getByText("bigint")).toHaveClass(
    "font-mono",
    "text-label",
    "text-fg-3",
    "font-normal",
  );
  expect(within(columnHeader("email")).getByText("text")).toBeInTheDocument();
});

test("header_has_no_type_until_it_arrives", () => {
  const columns = resultColumns("id");
  setup({ result: result({ columns, rows: [["1"]] }) });

  expect(columnHeader("id")).not.toHaveClass("justify-end");
  expect(within(columnHeader("id")).queryByText("bigint")).toBeNull();
  // type을 모르는 열은 왼쪽 정렬이다.
  expect(screen.getAllByRole("gridcell")[0]).not.toHaveClass("text-right");
});

test("the_type_shows_up_when_it_arrives_later", () => {
  const columns: ResultColumn[] = [
    {
      name: "id",
      typeOid: 100,
      typeModifier: -1,
      tableOid: 0,
      columnNumber: 0,
    },
  ];
  setup({ result: result({ columns, rows: [["1"]] }) });
  const before = columnHeader("id").style.width;
  expect(within(columnHeader("id")).queryByText("bigint")).toBeNull();

  act(() =>
    useTypes.setState({
      types: {
        local: {
          [typeKey(100, -1)]: {
            oid: 100,
            modifier: -1,
            name: "bigint",
            category: "N",
          },
        },
      },
    }),
  );

  expect(within(columnHeader("id")).getByText("bigint")).toBeInTheDocument();
  expect(screen.getAllByRole("gridcell")[0]).toHaveClass("text-right");
  // 아직 끌지 않은 열은 type을 센 너비로 다시 맞춘다.
  expect(columnHeader("id").style.width).toBe(
    `${fitWidth("id", ["1"], undefined, { type: "bigint", kind: "number" })}px`,
  );
  expect(columnHeader("id").style.width).not.toBe(before);
});

test("a_dragged_column_keeps_its_width_when_the_type_arrives", () => {
  const columns: ResultColumn[] = [
    {
      name: "id",
      typeOid: 100,
      typeModifier: -1,
      tableOid: 0,
      columnNumber: 0,
    },
  ];
  setup({ result: result({ columns, rows: [["1"]] }) });
  const header = columnHeader("id");
  const handle = within(header).getByRole("separator");
  const fit = fitWidth("id", ["1"]);

  fireEvent.mouseDown(handle, { clientX: 500 });
  fireEvent.mouseMove(document, { clientX: 540 });
  fireEvent.mouseUp(document, { clientX: 540 });
  expect(header.style.width).toBe(`${fit + 40}px`);

  act(() =>
    useTypes.setState({
      types: {
        local: {
          [typeKey(100, -1)]: {
            oid: 100,
            modifier: -1,
            name: "bigint",
            category: "N",
          },
        },
      },
    }),
  );

  expect(within(columnHeader("id")).getByText("bigint")).toBeInTheDocument();
  expect(columnHeader("id").style.width).toBe(`${fit + 40}px`);
});

test("numbers_are_right_aligned", () => {
  setup({
    result: result({
      columns: typedColumns(["n", "numeric(10,2)", "N"], ["s", "text", "S"]),
      rows: [
        ["10482.50", "abc"],
        [null, null],
      ],
    }),
  });

  expect(cell("10482.50")).toHaveClass("text-right", "text-syntax-number");
  expect(cell("abc")).not.toHaveClass("text-right");
  expect(cell("abc")).not.toHaveClass("text-syntax-number");
  expect(columnHeader("n")).toHaveClass("justify-end");
  expect(columnHeader("s")).not.toHaveClass("justify-end");
  // NULL은 숫자 색이 아니라 muted이고, 숫자 열이라 오른쪽에 붙는다.
  const [nullNumber, nullText] = screen.getAllByText("NULL");
  expect(nullNumber).toHaveClass("text-right", "text-fg-3", "italic");
  expect(nullNumber).not.toHaveClass("text-syntax-number");
  expect(nullText).not.toHaveClass("text-right");
});

test("json_and_vector_cells_are_shortened", () => {
  setup({
    result: result({
      columns: typedColumns(
        ["profile", "jsonb", "U"],
        ["embedding", "vector(4)", "U"],
      ),
      rows: [['{"plan": "pro", "billing": {"cycle": "yearly"}}', "[1,2,3,4]"]],
    }),
  });

  expect(
    screen.getByText('{"plan": "pro", "billing": {…}}'),
  ).toBeInTheDocument();
  const vector = screen.getByText("[1, 2, 3, …");
  expect(within(vector).getByText("4 values")).toHaveClass("text-fg-3");
});

test("header_width_counts_the_type", () => {
  const rows = [["1"]];
  setup({
    result: result({
      columns: typedColumns([
        "account_identifier",
        "timestamp with time zone",
        "D",
      ]),
      rows,
    }),
  });

  expect(columnHeader("account_identifier").style.width).toBe(
    `${fitWidth("account_identifier", ["1"], undefined, { type: "timestamp with time zone" })}px`,
  );
  expect(columnHeader("account_identifier").style.width).not.toBe(
    `${fitWidth("account_identifier", ["1"])}px`,
  );
});

const USERS = 100;
const ORDERS = 200;

function editColumn(number: number, name: string, primaryKey = false) {
  return { number, name, quotedName: name, primaryKey, updatable: true };
}

const usersTable: EditTable = {
  oid: USERS,
  qualifiedName: "public.users",
  name: "users",
  kind: "table",
  columns: [editColumn(1, "id", true), editColumn(2, "email")],
};

const ordersTable: EditTable = {
  oid: ORDERS,
  qualifiedName: "public.orders",
  name: "orders",
  kind: "table",
  columns: [editColumn(1, "id", true)],
};

function tableColumn(
  name: string,
  tableOid: number,
  columnNumber: number,
): ResultColumn {
  return { name, typeOid: 0, typeModifier: -1, tableOid, columnNumber };
}

/** `SELECT id, email, email AS e, 1 AS n FROM users`의 끝난 결과. */
function editable(patch: Partial<ResultData> = {}): ResultData {
  return result({
    columns: [
      tableColumn("id", USERS, 1),
      tableColumn("email", USERS, 2),
      tableColumn("e", USERS, 2),
      tableColumn("n", 0, 0),
    ],
    rows: [
      ["1", "a@x", "a@x", "1"],
      ["2", "b@x", "b@x", "1"],
      ["3", null, null, "1"],
    ],
    fetch: "none",
    ...patch,
  });
}

/** 결과 r행(0부터)의 c번째 열 칸 */
function cellAt(row: number, column: number): HTMLElement {
  return document.querySelector<HTMLElement>(
    `[data-row="${row}"] [data-col="${column}"]`,
  )!;
}

async function setupEditable(patch: Partial<Props> = {}) {
  vi.mocked(describeTables).mockResolvedValue([usersTable, ordersTable]);
  const view = setup({ result: editable(), ...patch });
  // describeTables의 답을 기다린다.
  await act(async () => {});
  return view;
}

function editor(): HTMLTextAreaElement | null {
  return screen.queryByRole<HTMLTextAreaElement>("textbox");
}

function note(): HTMLElement | null {
  return screen.queryByRole("status");
}

test("double_click_opens_the_editor_on_an_editable_cell", async () => {
  const { grid } = await setupEditable();

  fireEvent.click(cellAt(1, 1));
  fireEvent.doubleClick(cellAt(1, 1));

  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Edit email",
  });
  expect(input.value).toBe("b@x");
  expect(input).toHaveFocus();
  expect(describeTables).toHaveBeenCalledWith("local", [USERS]);

  change(input, "new@x");
  fireEvent.keyDown(input, { key: "Enter" });

  expect(editor()).toBeNull();
  expect(grid()).toHaveFocus();
  expect(cellAt(1, 1)).toHaveTextContent("new@x");
  expect(useEdits.getState().edits.t).toEqual({
    runKey: runKeyOf(editable()),
    changes: new Map([[1, new Map([[2, "new@x"]])]]),
  });
});

test("enter_on_a_selected_cell_opens_the_editor", async () => {
  const { grid } = await setupEditable();

  fireEvent.click(cellAt(0, 1));
  const notPrevented = fireEvent.keyDown(grid(), { key: "Enter" });

  expect(notPrevented).toBe(false);
  expect(editor()?.value).toBe("a@x");

  fireEvent.keyDown(editor()!, { key: "Escape" });
  expect(editor()).toBeNull();
  expect(grid()).toHaveFocus();
  expect(useEdits.getState().edits.t).toBeUndefined();
});

test("a_null_cell_opens_empty_and_stays_null_when_left_empty", async () => {
  await setupEditable();

  fireEvent.doubleClick(cellAt(2, 1));
  expect(editor()?.value).toBe("");
  fireEvent.keyDown(editor()!, { key: "Enter" });

  expect(cellAt(2, 1)).toHaveTextContent("NULL");
  expect(useEdits.getState().edits.t).toBeUndefined();
});

test("changed_cell_is_marked_in_every_column_with_that_attnum", async () => {
  await setupEditable();

  fireEvent.doubleClick(cellAt(0, 2));
  change(editor()!, "new@x");
  fireEvent.keyDown(editor()!, { key: "Enter" });
  fireEvent.click(cellAt(1, 0));

  for (const column of [1, 2]) {
    expect(cellAt(0, column)).toHaveTextContent("new@x");
    expect(cellAt(0, column)).toHaveAttribute("data-changed", "true");
  }
  expect(cellAt(0, 0)).not.toHaveAttribute("data-changed");
  expect(cellAt(1, 1)).toHaveTextContent("b@x");
  expect(cellAt(1, 1)).not.toHaveAttribute("data-changed");
});

test("the_editor_stays_while_virtual_scroll_drops_its_row", async () => {
  const rows: Cell[][] = Array.from({ length: 1000 }, (_, i) => [
    String(i + 1),
    `u${i + 1}@x`,
    `u${i + 1}@x`,
    "1",
  ]);
  const { grid } = await setupEditable({ result: editable({ rows }) });

  fireEvent.doubleClick(cellAt(0, 1));
  change(editor()!, "kept");
  grid().scrollTop = 20_000;
  fireEvent.scroll(grid());

  expect(document.querySelector('[data-row="0"]')).toBeNull();
  expect(editor()?.value).toBe("kept");
  fireEvent.keyDown(editor()!, { key: "Enter" });
  expect(useEdits.getState().edits.t?.changes.get(0)?.get(2)).toBe("kept");
});

test("not_editable_cell_shows_the_note", async () => {
  await setupEditable({
    result: editable({
      columns: [
        tableColumn("order_id", ORDERS, 1),
        tableColumn("id", USERS, 1),
        tableColumn("email", USERS, 2),
        tableColumn("n", 0, 0),
      ],
    }),
  });

  fireEvent.doubleClick(cellAt(0, 2));

  expect(editor()).toBeNull();
  expect(note()).toHaveTextContent(
    "Not editable: rows come from 2 tables (orders, users).",
  );
});

test("a_computed_column_shows_its_note_on_enter", async () => {
  const { grid } = await setupEditable();

  fireEvent.click(cellAt(0, 3));
  fireEvent.keyDown(grid(), { key: "Enter" });

  expect(editor()).toBeNull();
  expect(note()).toHaveTextContent("Not editable: n is computed.");
});

test("note_hides_when_the_selection_changes", async () => {
  await setupEditable();

  fireEvent.click(cellAt(0, 3));
  fireEvent.doubleClick(cellAt(0, 3));
  expect(note()).not.toBeNull();

  // 같은 칸을 다시 누르는 것은 선택이 바뀐 것이 아니다.
  fireEvent.click(cellAt(0, 3));
  expect(note()).not.toBeNull();

  fireEvent.click(cellAt(1, 3));
  expect(note()).toBeNull();
});

test("context_menu_sets_null_and_reverts", async () => {
  await setupEditable();

  fireEvent.contextMenu(cellAt(0, 1), { clientX: 50, clientY: 60 });
  const menu = screen.getByRole("menu");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Set NULL"]);
  expect(cellAt(0, 1)).toHaveAttribute("aria-selected", "true");

  fireEvent.click(within(menu).getByRole("menuitem", { name: "Set NULL" }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(cellAt(0, 1)).toHaveTextContent("NULL");
  expect(cellAt(0, 2)).toHaveTextContent("NULL");
  expect(useEdits.getState().edits.t?.changes.get(0)?.get(2)).toBeNull();

  fireEvent.contextMenu(cellAt(0, 2), { clientX: 50, clientY: 60 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Revert value" }));
  expect(cellAt(0, 1)).toHaveTextContent("a@x");
  expect(cellAt(0, 1)).not.toHaveAttribute("data-changed");
  expect(useEdits.getState().edits.t).toBeUndefined();
});

test("context_menu_does_not_open_on_a_not_editable_cell", async () => {
  await setupEditable();

  const notPrevented = fireEvent.contextMenu(cellAt(0, 3));

  expect(notPrevented).toBe(true);
  expect(screen.queryByRole("menu")).toBeNull();
});

test("running_result_is_not_editable", async () => {
  await setupEditable({ result: editable({ fetch: "ready" }) });

  fireEvent.doubleClick(cellAt(0, 1));

  expect(editor()).toBeNull();
  expect(note()).toHaveTextContent(
    "Not editable while rows are still coming. Cancel keeps the rows received so far.",
  );
  fireEvent.contextMenu(cellAt(0, 1));
  expect(screen.queryByRole("menu")).toBeNull();
});

test("read_only_connection_is_not_editable", async () => {
  await setupEditable({ readOnly: true });

  fireEvent.doubleClick(cellAt(0, 1));

  expect(editor()).toBeNull();
  expect(note()).toHaveTextContent(
    "Not editable: the connection is read-only.",
  );
});

test("changes_of_another_run_are_not_shown", async () => {
  useEdits.getState().setCell("t", "run-other", 0, 2, "elsewhere", "a@x");

  await setupEditable();

  expect(cellAt(0, 1)).toHaveTextContent("a@x");
  expect(cellAt(0, 1)).not.toHaveAttribute("data-changed");
});

test("confirming_a_set_null_cell_without_typing_keeps_null", async () => {
  await setupEditable();
  fireEvent.contextMenu(cellAt(0, 1), { clientX: 50, clientY: 60 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Set NULL" }));

  fireEvent.doubleClick(cellAt(0, 1));
  expect(editor()?.value).toBe("");
  fireEvent.keyDown(editor()!, { key: "Enter" });

  expect(useEdits.getState().edits.t?.changes.get(0)?.get(2)).toBeNull();
  expect(cellAt(0, 1)).toHaveTextContent("NULL");
});

test("blur_without_typing_keeps_the_change", async () => {
  await setupEditable();
  fireEvent.contextMenu(cellAt(0, 1), { clientX: 50, clientY: 60 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Set NULL" }));
  fireEvent.doubleClick(cellAt(1, 1));
  change(editor()!, "x@x");
  fireEvent.keyDown(editor()!, { key: "Enter" });

  fireEvent.doubleClick(cellAt(0, 1));
  fireEvent.blur(editor()!);
  fireEvent.doubleClick(cellAt(1, 1));
  expect(editor()?.value).toBe("x@x");
  fireEvent.blur(editor()!);

  expect(useEdits.getState().edits.t?.changes).toEqual(
    new Map([
      [0, new Map<number, Cell>([[2, null]])],
      [1, new Map<number, Cell>([[2, "x@x"]])],
    ]),
  );
});

test("the_editor_opens_on_the_result_row_after_dropped_rows", async () => {
  const rows: Cell[][] = Array.from({ length: 3 }, (_, i) => [
    String(5001 + i),
    `u${5001 + i}@x`,
    `u${5001 + i}@x`,
    "1",
  ]);
  await setupEditable({ result: editable({ firstRow: 5000, rows }) });

  fireEvent.doubleClick(cellAt(5001, 1));

  const input = editor()!;
  expect(input.value).toBe("u5002@x");
  // 버린 구간 줄(40px) 아래 두 번째 행이다.
  expect(input.style.top).toBe(`${40 + 26}px`);
  expect(input.style.left).toBe(
    `${rowNumberWidth(5003) + parseFloat(columnHeader("id").style.width)}px`,
  );
  expect(input.style.width).toBe(columnHeader("email").style.width);

  change(input, "moved@x");
  fireEvent.keyDown(input, { key: "Enter" });

  expect(useEdits.getState().edits.t?.changes).toEqual(
    new Map([[5001, new Map([[2, "moved@x"]])]]),
  );
  expect(cellAt(5001, 2)).toHaveTextContent("moved@x");
});

/** id(bigint)와 email(text) 열의 끝난 결과. 결과 순서의 id는 10, 9, 100, 50이다. */
function sortable(patch: Partial<ResultData> = {}): ResultData {
  return result({
    columns: typedColumns(["id", "bigint", "N"], ["email", "text", "S"]),
    rows: [
      ["10", "b"],
      ["9", "c"],
      ["100", "a"],
      ["50", "d"],
    ],
    fetch: "none",
    ...patch,
  });
}

function sortButton(name: string): HTMLElement {
  return within(columnHeader(name)).getByRole("button");
}

/** 보이는 순서(위에서 아래)의 행 번호 */
function shownRowNumbers(): string[] {
  return screen
    .getAllByRole("rowheader")
    .map((header) => header.textContent ?? "");
}

test("header_click_sorts_and_shows_arrow", () => {
  const { props: p } = setup({ result: sortable() });
  expect(columnHeader("id")).not.toHaveAttribute("aria-sort");

  fireEvent.click(sortButton("id"));
  expect(columnHeader("id")).toHaveAttribute("aria-sort", "ascending");
  expect(sortButton("id")).toHaveAccessibleName("id, sorted ascending");
  expect(within(columnHeader("id")).getByText("↑")).toHaveClass("text-fg-2");
  expect(columnHeader("email")).not.toHaveAttribute("aria-sort");
  expect(shownRowNumbers()).toEqual(["2", "1", "4", "3"]);
  // 9가 든 결과 2번째 행이 맨 위에 그려진다.
  expect(
    document.querySelector<HTMLElement>('[data-row="1"]')!.style.transform,
  ).toBe("translateY(0px)");
  expect(p.onSortChange).toHaveBeenLastCalledWith(true);

  fireEvent.click(sortButton("id"));
  expect(columnHeader("id")).toHaveAttribute("aria-sort", "descending");
  expect(sortButton("id")).toHaveAccessibleName("id, sorted descending");
  expect(within(columnHeader("id")).getByText("↓")).toHaveClass("text-fg-2");
  expect(shownRowNumbers()).toEqual(["3", "4", "1", "2"]);

  fireEvent.click(sortButton("id"));
  expect(columnHeader("id")).not.toHaveAttribute("aria-sort");
  expect(within(columnHeader("id")).queryByText("↑")).toBeNull();
  expect(within(columnHeader("id")).queryByText("↓")).toBeNull();
  expect(shownRowNumbers()).toEqual(["1", "2", "3", "4"]);
  expect(p.onSortChange).toHaveBeenLastCalledWith(false);

  // 글자 열은 code unit 순이다.
  fireEvent.click(sortButton("email"));
  expect(shownRowNumbers()).toEqual(["3", "1", "2", "4"]);
});

test("row_numbers_keep_result_order", () => {
  setup({ result: sortable() });

  fireEvent.click(sortButton("id"));

  const row = cell("100").closest<HTMLElement>("[role=row]")!;
  expect(within(row).getByRole("rowheader")).toHaveTextContent("3");
  expect(row).toHaveAttribute("aria-rowindex", "4");
  expect(screen.getAllByRole("rowheader")[0]).toHaveTextContent("2");
});

test("shift_click_range_follows_view_order", () => {
  const { props: p, grid } = setup({ result: sortable() });
  fireEvent.click(sortButton("id"));

  // 보이는 순서는 2, 1, 4, 3번 행이다. 2번에서 4번까지면 2, 1, 4번이다.
  fireEvent.click(rowHeader("2"));
  fireEvent.click(rowHeader("4"), { shiftKey: true });

  expect(
    screen
      .getAllByRole("row")
      .filter((row) => row.getAttribute("aria-selected") === "true")
      .map((row) => within(row).getByRole("rowheader").textContent),
  ).toEqual(["2", "1", "4"]);
  const { setData } = copy(grid());
  expect(setData).toHaveBeenCalledWith("text/plain", "9\tc\n10\tb\n50\td");
  expect(p.onCopied).toHaveBeenCalledWith("Copied 3 rows (tab-separated)");
  expect(p.copyTargetRef.current?.()?.text).toBe("9\tc\n10\tb\n50\td");
});

test("sorted_grid_does_not_fetch_on_scroll", () => {
  const { props: p, grid } = setup({
    result: result({ rows: rowsOf(500), fetch: "ready" }),
  });
  fireEvent.click(sortButton("id"));

  grid().scrollTop = 500 * 26;
  fireEvent.scroll(grid());
  expect(p.onFetchMore).not.toHaveBeenCalled();

  // 정렬을 풀면 끝 가까이라 다음 batch를 요청한다.
  fireEvent.click(sortButton("id"));
  fireEvent.click(sortButton("id"));
  expect(p.onFetchMore).toHaveBeenCalledTimes(1);
});

test("arriving_batch_is_sorted_in", () => {
  const first = sortable({ fetch: "fetching" });
  const { props: p, rerender } = setup({ result: first });
  fireEvent.click(sortButton("id"));
  expect(shownRowNumbers()).toEqual(["2", "1", "4", "3"]);

  rerender({
    result: {
      ...first,
      rows: [...first.rows, ["1", "e"], ["95", "f"]],
      fetch: "ready",
    },
  });

  expect(shownRowNumbers()).toEqual(["5", "2", "1", "4", "6", "3"]);
  expect(columnHeader("id")).toHaveAttribute("aria-sort", "ascending");
  expect(p.onFetchMore).not.toHaveBeenCalled();
});

test("resize_handle_does_not_sort", () => {
  setup({ result: sortable() });
  const handle = within(columnHeader("id")).getByRole("separator");

  fireEvent.mouseDown(handle, { clientX: 500 });
  fireEvent.mouseMove(document, { clientX: 470 });
  fireEvent.mouseUp(document, { clientX: 470 });
  fireEvent.click(handle);
  fireEvent.doubleClick(handle);

  expect(columnHeader("id")).not.toHaveAttribute("aria-sort");
  expect(shownRowNumbers()).toEqual(["1", "2", "3", "4"]);
  fireEvent.click(sortButton("id"));
  expect(columnHeader("id")).toHaveAttribute("aria-sort", "ascending");
});

test("sort_survives_tab_switch", () => {
  const shown = sortable();
  // 탭 t가 아직 이 실행을 보여 줄 수 있어야 떠날 때 view를 저장한다.
  useRuns.setState({
    runs: {
      t: {
        status: "finished",
        result: shown,
        outcome: { outcome: "completed", rows: 4 },
      },
    },
  });
  try {
    const { props: p, rerender } = setup({ result: shown });
    fireEvent.click(sortButton("id"));
    fireEvent.click(sortButton("id"));

    rerender({ tabId: "u" });
    expect(columnHeader("id")).not.toHaveAttribute("aria-sort");
    expect(p.onSortChange).toHaveBeenLastCalledWith(false);

    rerender({ tabId: "t" });
    expect(columnHeader("id")).toHaveAttribute("aria-sort", "descending");
    expect(shownRowNumbers()).toEqual(["3", "4", "1", "2"]);
    expect(p.onSortChange).toHaveBeenLastCalledWith(true);
  } finally {
    useRuns.setState({ runs: {} });
  }
});

test("editing_a_sorted_view_edits_the_result_row", async () => {
  await setupEditable();
  // id는 type을 모르는 열이라 글자 순이다. 내림차순이면 결과 3, 2, 1번째 행 순이다.
  fireEvent.click(sortButton("id"));
  fireEvent.click(sortButton("id"));

  fireEvent.doubleClick(cellAt(0, 1));
  const input = editor()!;
  expect(input.value).toBe("a@x");
  // 결과 첫 행은 맨 아래(보이는 위치 2)에 있다.
  expect(input.style.top).toBe(`${2 * 26}px`);

  change(input, "new@x");
  fireEvent.keyDown(input, { key: "Enter" });

  expect(useEdits.getState().edits.t?.changes).toEqual(
    new Map([[0, new Map([[2, "new@x"]])]]),
  );
  expect(cellAt(0, 1)).toHaveTextContent("new@x");
  expect(cellAt(0, 1)).toHaveAttribute("data-changed", "true");
  expect(cellAt(1, 1)).toHaveTextContent("b@x");
});
