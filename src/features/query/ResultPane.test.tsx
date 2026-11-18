import { act, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import type { Cell, Outcome } from "../../shared/api/types";
import { ResultPane } from "./ResultPane";
import { emptyResult, type ResultData, type RunState } from "./runReducer";
import { useRuns } from "./runsStore";

beforeEach(async () => {
  await useRuns.getState().reset();
});

function result(patch: Partial<ResultData> = {}): ResultData {
  return {
    ...emptyResult("SELECT id, name FROM t", { line: 1, column: 1 }),
    elapsedMicros: 1234567,
    ...patch,
  };
}

const someRows: Cell[][] = [
  ["1", "a"],
  ["2", "b"],
  ["3", "c"],
];

function show(state: RunState) {
  useRuns.setState({ runs: { t: state } });
  render(<ResultPane tabId="t" />);
}

function finished(outcome: Outcome, patch: Partial<ResultData> = {}) {
  show({ status: "finished", result: result(patch), outcome });
}

test("tabId가 null이거나 idle이면 실행 방법을 보여 준다", () => {
  const { unmount } = render(<ResultPane tabId={null} />);
  expect(screen.getByText("Press Cmd+Enter to run")).toBeInTheDocument();
  unmount();

  // runs에 없는 탭은 idle이다.
  render(<ResultPane tabId="t" />);
  expect(screen.getByText("Press Cmd+Enter to run")).toBeInTheDocument();
});

test("connecting이면 연결 중이다", () => {
  show({ status: "connecting" });

  expect(screen.getByText("Connecting…")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

test("running이고 행이 없으면 실행 중이다", () => {
  show({
    status: "running",
    result: result({ columns: ["id", "name"], elapsedMicros: null }),
  });

  expect(screen.getByText("Running…")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

test("running이고 행이 있으면 표와 더 있음을 보여 준다", () => {
  show({
    status: "running",
    result: result({ columns: ["id", "name"], rows: someRows }),
  });

  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(screen.getAllByRole("row")).toHaveLength(4);
  expect(screen.getByText("3 rows shown · more available")).toBeInTheDocument();
  expect(screen.queryByText("Running…")).toBeNull();
});

test("completed이고 columns가 있으면 표와 행 수, 시간을 보여 준다", () => {
  finished(
    { outcome: "completed", rows: 3 },
    { columns: ["id", "name"], rows: someRows },
  );

  expect(screen.getByRole("columnheader", { name: "id" })).toBeInTheDocument();
  expect(
    screen.getByRole("columnheader", { name: "name" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("cell", { name: "b" })).toBeInTheDocument();
  expect(screen.getByText("3 rows · 1.23 s")).toBeInTheDocument();
});

test("completed이고 columns가 없으면 영향받은 행 수를 보여 준다", () => {
  finished({ outcome: "completed", rows: 12 }, { elapsedMicros: 420 });

  expect(screen.getByText("12 rows affected · 0.42 ms")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

test("failed면 server error를 보여 준다", () => {
  finished({
    outcome: "failed",
    error: {
      code: "42601",
      message: "syntax error at end of input",
      detail: null,
      hint: null,
      position: null,
    },
  });

  expect(screen.getByText("syntax error at end of input")).toBeInTheDocument();
  expect(screen.getByText("42601")).toBeInTheDocument();
  expect(screen.queryByText(/^Ln /)).toBeNull();
});

test("실패는 message, detail, hint, 위치를 보여 준다", () => {
  finished(
    {
      outcome: "failed",
      error: {
        code: "42P01",
        message: 'relation "nope" does not exist',
        detail: "자세한 설명",
        hint: "테이블 이름을 확인하세요",
        position: 14,
      },
    },
    { sql: "SELECT *\nFROM nope", origin: { line: 3, column: 5 } },
  );

  expect(
    screen.getByText('relation "nope" does not exist'),
  ).toBeInTheDocument();
  expect(screen.getByText("자세한 설명")).toBeInTheDocument();
  expect(screen.getByText("테이블 이름을 확인하세요")).toBeInTheDocument();
  expect(screen.getByText("Ln 4, Col 6")).toBeInTheDocument();
  expect(screen.getByText("42P01")).toBeInTheDocument();
});

test("cancelled면 취소됨과 시간을, 받은 행이 있으면 표도 보여 준다", () => {
  finished(
    { outcome: "cancelled" },
    { columns: ["id", "name"], rows: someRows },
  );

  expect(screen.getByText("Cancelled · 1.23 s")).toBeInTheDocument();
  expect(screen.getByRole("table")).toBeInTheDocument();
});

test("cancelled이고 받은 행이 없으면 표를 그리지 않는다", () => {
  finished({ outcome: "cancelled" }, { columns: ["id", "name"] });

  expect(screen.getByText("Cancelled · 1.23 s")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

test("discarded면 버렸다고 보여 준다", () => {
  finished(
    { outcome: "discarded" },
    { columns: ["id", "name"], rows: someRows },
  );

  expect(screen.getByText("Results discarded")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

test("connection_lost면 끊긴 이유와 다음 실행의 안내를 보여 준다", () => {
  finished({ outcome: "connection_lost", message: "server closed" });

  expect(
    screen.getByText("Connection lost: server closed"),
  ).toBeInTheDocument();
  expect(
    screen.getByText("The next run opens a new session"),
  ).toBeInTheDocument();
});

test("client_error면 message를 보여 준다", () => {
  finished({ outcome: "client_error", message: "값을 읽지 못했습니다" });

  expect(screen.getByText("값을 읽지 못했습니다")).toBeInTheDocument();
});

test("rejected면 message를 보여 준다", () => {
  show({ status: "rejected", message: "서버에 닿지 못했습니다" });

  expect(screen.getByText("서버에 닿지 못했습니다")).toBeInTheDocument();
});

test("NULL과 빈 문자열을 다르게 그린다", () => {
  finished(
    { outcome: "completed", rows: 1 },
    { columns: ["a", "b"], rows: [[null, ""]] },
  );

  const cells = screen.getAllByRole("cell");
  expect(cells[0]).toHaveTextContent("NULL");
  expect(cells[1]).toBeEmptyDOMElement();
});

test("300자를 넘는 값은 줄여 그린다", () => {
  const long = "x".repeat(1000);
  const exact = "y".repeat(300);
  finished(
    { outcome: "completed", rows: 1 },
    { columns: ["long", "exact"], rows: [[long, exact]] },
  );

  const cells = screen.getAllByRole("cell");
  expect(cells[0].textContent).toHaveLength(301);
  expect(cells[0].textContent).toBe(`${"x".repeat(300)}…`);
  expect(cells[1].textContent).toBe(exact);
});

test("300자 경계의 emoji를 가르지 않는다", () => {
  const value = `${"x".repeat(299)}😀${"y".repeat(10)}`;
  finished(
    { outcome: "completed", rows: 1 },
    { columns: ["v"], rows: [[value]] },
  );

  expect(screen.getByRole("cell").textContent).toBe(`${"x".repeat(299)}…`);
});

test("끝나도 표를 다시 만들지 않는다", () => {
  const running = result({ columns: ["id", "name"], rows: someRows });
  show({ status: "running", result: running });
  const table = screen.getByRole("table");

  act(() =>
    useRuns.setState({
      runs: {
        t: {
          status: "finished",
          result: running,
          outcome: { outcome: "completed", rows: 3 },
        },
      },
    }),
  );

  expect(screen.getByText("3 rows · 1.23 s")).toBeInTheDocument();
  expect(screen.getByRole("table")).toBe(table);
});
