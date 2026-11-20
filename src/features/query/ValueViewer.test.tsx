import { createRef, type RefObject } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../shared/api/clipboard");

import { copyText } from "../../shared/api/clipboard";
import type { Cell, ResultColumn } from "../../shared/api/types";
import { stubLayout } from "../../test/layout";
import { ResultGrid, type CopyTarget } from "./ResultGrid";
import { emptyResult, type ResultData } from "./runReducer";
import { typeKey, useTypes } from "./typesStore";
import { jsonTokens, ValueViewer } from "./ValueViewer";

const PROFILE =
  '{"plan": "pro", "seats": 5, "billing": {"cycle": "yearly"}, "tags": ["beta"], "ok": true, "none": null}';

beforeEach(() => {
  stubLayout({ width: 800, height: 400 });
  useTypes.getState().reset();
  vi.mocked(copyText).mockResolvedValue(undefined);
});

/** 접속 local이 아는 type으로 컬럼을 만든다. */
function typedColumns(
  ...specs: [name: string, type: string][]
): ResultColumn[] {
  useTypes.setState({
    types: {
      local: Object.fromEntries(
        specs.map(([, name], i) => [
          typeKey(100 + i, -1),
          { oid: 100 + i, modifier: -1, name, category: "U" },
        ]),
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

function result(columns: ResultColumn[], rows: Cell[][]): ResultData {
  return {
    ...emptyResult(
      { sql: "SELECT 1", from: 0, origin: { line: 1, column: 1 } },
      "run-0",
      1000,
    ),
    columns,
    rows,
    elapsedMicros: 1000,
    fetch: "ready",
  };
}

function setup(
  rows: Cell[][] = [
    [PROFILE, "hello"],
    [null, "x"],
  ],
) {
  const onCopied = vi.fn();
  render(
    <ResultGrid
      tabId="t"
      connection="local"
      readOnly={false}
      result={result(
        typedColumns(["profile", "jsonb"], ["note", "text"]),
        rows,
      )}
      endRows={null}
      onFetchMore={vi.fn()}
      onRunAgain={vi.fn()}
      onCopied={onCopied}
      copyTargetRef={createRef() as RefObject<(() => CopyTarget) | null>}
      statementsRef={createRef()}
      onSelectionChange={vi.fn()}
      onSortChange={vi.fn()}
      onStatementsChange={vi.fn()}
    />,
  );
  return { onCopied, grid: screen.getByRole("grid") };
}

function pick(text: string) {
  fireEvent.click(screen.getByText(text).closest("[role=gridcell]")!);
}

const viewer = () =>
  screen.queryByRole("complementary", { name: "Value viewer" });

describe("jsonTokens", () => {
  test("pretty_prints_with_two_spaces", () => {
    const tokens = jsonTokens('{"a":[1,{"b":null}],"c":"x"}')!;
    expect(tokens.map((token) => token.text).join("")).toBe(
      [
        "{",
        '  "a": [',
        "    1,",
        "    {",
        '      "b": null',
        "    }",
        "  ],",
        '  "c": "x"',
        "}",
      ].join("\n"),
    );
  });

  test("classifies_tokens", () => {
    const tokens = jsonTokens('{"a": [1, "s", true]}')!.filter(
      (token) => token.kind !== "punct",
    );
    expect(tokens).toEqual([
      { text: '"a"', kind: "key" },
      { text: "1", kind: "number" },
      { text: '"s"', kind: "string" },
      { text: "true", kind: "literal" },
    ]);
  });

  test("keeps_number_notation_and_empty_containers", () => {
    const text = jsonTokens(
      '{"n": 1.50e3, "big": 12345678901234567890, "e": {}, "a": []}',
    )!
      .map((token) => token.text)
      .join("");
    expect(text).toContain('"n": 1.50e3');
    expect(text).toContain('"big": 12345678901234567890');
    expect(text).toContain('"e": {}');
    expect(text).toContain('"a": []');
  });

  test("returns_null_when_not_json", () => {
    expect(jsonTokens("not json")).toBeNull();
    expect(jsonTokens("")).toBeNull();
    expect(jsonTokens("{")).toBeNull();
  });

  test("handles_scalars_and_escapes", () => {
    expect(jsonTokens('"a\\"b"')).toEqual([
      { text: '"a\\"b"', kind: "string" },
    ]);
    expect(jsonTokens("42")).toEqual([{ text: "42", kind: "number" }]);
  });
});

describe("ValueViewer", () => {
  const column: ResultColumn = {
    name: "profile",
    typeOid: 100,
    typeModifier: -1,
    tableOid: 0,
    columnNumber: 0,
  };
  const jsonb = { oid: 100, modifier: -1, name: "jsonb", category: "U" };

  function view(patch: Partial<Parameters<typeof ValueViewer>[0]> = {}) {
    const onClose = vi.fn();
    render(
      <ValueViewer
        column={column}
        type={jsonb}
        row={1}
        value={PROFILE}
        onClose={onClose}
        onCopied={vi.fn()}
        {...patch}
      />,
    );
    return { onClose };
  }

  test("header_shows_name_type_and_row", () => {
    view();
    const panel = screen.getByRole("complementary", { name: "Value viewer" });
    expect(within(panel).getByText("profile")).toBeInTheDocument();
    expect(within(panel).getByText("jsonb · row 1")).toBeInTheDocument();
  });

  test("header_shows_only_the_row_when_the_type_is_unknown", () => {
    view({ type: undefined, row: 12_345 });
    expect(screen.getByText("row 12,345")).toBeInTheDocument();
  });

  test("json_is_pretty_printed_and_colored", () => {
    view();
    const body = screen.getByTestId("value-body");
    expect(body.textContent).toContain('\n  "plan": "pro",\n');
    expect(body.textContent).toContain('\n    "cycle": "yearly"\n');
    expect(screen.getByText('"plan"')).toHaveClass("text-syntax-function");
    expect(screen.getByText('"pro"')).toHaveClass("text-syntax-string");
    expect(screen.getByText("5")).toHaveClass("text-syntax-number");
  });

  test("text_wraps_and_null_is_marked", () => {
    const { unmount } = render(
      <ValueViewer
        column={column}
        type={{ ...jsonb, name: "text" }}
        row={1}
        value={"line one\nline two"}
        onClose={vi.fn()}
        onCopied={vi.fn()}
      />,
    );
    const body = screen.getAllByTestId("value-body")[0];
    expect(body).toHaveTextContent("line one line two");
    expect(body).toHaveClass("whitespace-pre-wrap");
    unmount();

    view({ value: null });
    const nul = screen.getByText("NULL");
    expect(nul).toHaveClass("text-fg-3", "italic");
  });

  test("copy_copies_the_full_value", async () => {
    const long = "x".repeat(1000);
    const onCopied = vi.fn();
    view({ type: { ...jsonb, name: "text" }, value: long, onCopied });

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Copy value" })),
    );

    expect(copyText).toHaveBeenCalledWith(long);
    expect(onCopied).toHaveBeenCalledWith("Copied value");
  });

  test("copy_does_not_announce_when_the_clipboard_fails", async () => {
    vi.mocked(copyText).mockRejectedValue(new Error("denied"));
    const onCopied = vi.fn();
    view({ onCopied });

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Copy value" })),
    );

    expect(onCopied).not.toHaveBeenCalled();
  });

  test("close_button_closes", () => {
    const { onClose } = view();
    fireEvent.click(screen.getByRole("button", { name: "Close value viewer" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("result grid", () => {
  test("shift_enter_opens_and_closes", () => {
    const { grid } = setup();
    expect(viewer()).toBeNull();

    // 고른 셀이 없으면 열지 않는다.
    fireEvent.keyDown(grid, { key: "Enter", shiftKey: true });
    expect(viewer()).toBeNull();

    pick("hello");
    fireEvent.keyDown(grid, { key: "Enter", shiftKey: true });
    expect(viewer()).toBeInTheDocument();
    expect(within(viewer()!).getByTestId("value-body")).toHaveTextContent(
      "hello",
    );

    fireEvent.keyDown(grid, { key: "Enter", shiftKey: true });
    expect(viewer()).toBeNull();
  });

  test("plain_enter_does_not_open", () => {
    const { grid } = setup();
    pick("hello");
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(viewer()).toBeNull();
  });

  test("escape_closes", () => {
    const { grid } = setup();
    pick("hello");
    fireEvent.keyDown(grid, { key: "Enter", shiftKey: true });
    expect(viewer()).toBeInTheDocument();

    fireEvent.keyDown(grid, { key: "Escape" });
    expect(viewer()).toBeNull();
  });

  test("close_button_returns_focus_to_the_grid", () => {
    const { grid } = setup();
    pick("hello");
    fireEvent.keyDown(grid, { key: "Enter", shiftKey: true });

    fireEvent.click(screen.getByRole("button", { name: "Close value viewer" }));

    expect(viewer()).toBeNull();
    expect(grid).toHaveFocus();
  });

  test("follows_the_selected_cell", () => {
    const { grid } = setup();
    pick("hello");
    fireEvent.keyDown(grid, { key: "Enter", shiftKey: true });
    expect(screen.getByText("text · row 1")).toBeInTheDocument();

    // 다른 행의 다른 열
    pick("x");
    expect(screen.getByText("text · row 2")).toBeInTheDocument();
    expect(within(viewer()!).getByTestId("value-body")).toHaveTextContent("x");

    // NULL 셀
    fireEvent.click(
      screen.getAllByRole("gridcell").find((el) => el.textContent === "NULL")!,
    );
    expect(screen.getByText("jsonb · row 2")).toBeInTheDocument();
    expect(within(viewer()!).getByText("NULL")).toHaveClass("italic");
  });

  test("shows_the_full_value_of_a_long_cell", () => {
    const long = "y".repeat(600);
    const { grid } = setup([[PROFILE, long]]);
    fireEvent.click(screen.getAllByRole("gridcell")[1]);
    fireEvent.keyDown(grid, { key: "Enter", shiftKey: true });

    expect(within(viewer()!).getByTestId("value-body").textContent).toBe(long);
  });

  test("hides_while_a_row_is_selected", () => {
    const { grid } = setup();
    pick("hello");
    fireEvent.keyDown(grid, { key: "Enter", shiftKey: true });

    fireEvent.click(screen.getAllByRole("rowheader")[0]);
    expect(viewer()).toBeNull();

    pick("hello");
    expect(viewer()).toBeInTheDocument();
  });
});
