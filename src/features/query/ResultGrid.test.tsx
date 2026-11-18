import {
  createRef,
  type ComponentProps,
  type ReactElement,
  type RefObject,
} from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { Cell } from "../../shared/api/types";
import { fitWidth } from "./grid";
import { ResultGrid, type CopyTarget } from "./ResultGrid";
import { emptyResult, type ResultData } from "./runReducer";

type Props = ComponentProps<typeof ResultGrid>;

// jsdom은 layout이 없어 clientHeight가 0이다. 결과 panel 크기의 viewport로 둔다.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
});

function rowsOf(count: number, from = 0): Cell[][] {
  return Array.from({ length: count }, (_, i) => [
    String(from + i + 1),
    `user${from + i + 1}@example.com`,
  ]);
}

function result(patch: Partial<ResultData> = {}): ResultData {
  return {
    ...emptyResult("SELECT id, email FROM users", { line: 1, column: 1 }, 1000),
    columns: ["id", "email"],
    rows: rowsOf(3),
    elapsedMicros: 38000,
    fetch: "ready",
    ...patch,
  };
}

function props(patch: Partial<Props> = {}): Props {
  return {
    result: result(),
    endRows: null,
    onFetchMore: vi.fn(),
    onRunAgain: vi.fn(),
    onCopied: vi.fn(),
    copyTargetRef: createRef() as RefObject<(() => CopyTarget) | null>,
    onSelectionChange: vi.fn(),
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
    result: result({ columns: ["a", "b", "c"], rows: [[null, "", "NULL"]] }),
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

test("끝난 결과는 fetch가 남아 있어도 onFetchMore를 부르지 않고 끝을 알린다", () => {
  const done = setup({ result: result({ rows: rowsOf(500) }), endRows: 500 });
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
  setup({ result: result({ columns: ["amount"], rows: [["1"]] }) });

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
  fireEvent.mouseMove(document, { clientX: 470 });
  fireEvent.mouseUp(document, { clientX: 470 });
  expect(header.style.width).toBe(`${fit - 30}px`);

  fireEvent.doubleClick(handle);
  expect(header.style.width).toBe(`${fit}px`);
});
