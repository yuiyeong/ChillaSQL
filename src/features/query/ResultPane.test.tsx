import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import type { Cell, Outcome } from "../../shared/api/types";
import { ResultPane } from "./ResultPane";
import { emptyResult, type ResultData, type RunState } from "./runReducer";
import { useRuns } from "./runsStore";

beforeEach(() => {
  useRuns.getState().reset();
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
  expect(screen.getByText("Cmd+Enter로 실행")).toBeInTheDocument();
  unmount();

  // runs에 없는 탭은 idle이다.
  render(<ResultPane tabId="t" />);
  expect(screen.getByText("Cmd+Enter로 실행")).toBeInTheDocument();
});

test("connecting이면 연결 중이다", () => {
  show({ status: "connecting" });

  expect(screen.getByText("연결 중…")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

test("running이고 행이 없으면 실행 중이다", () => {
  show({
    status: "running",
    result: result({ columns: ["id", "name"], elapsedMicros: null }),
  });

  expect(screen.getByText("실행 중…")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

test("running이고 행이 있으면 표와 더 있음을 보여 준다", () => {
  show({
    status: "running",
    result: result({ columns: ["id", "name"], rows: someRows }),
  });

  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(screen.getAllByRole("row")).toHaveLength(4);
  expect(screen.getByText("3행 표시 · 더 있음")).toBeInTheDocument();
  expect(screen.queryByText("실행 중…")).toBeNull();
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
  expect(screen.getByText("3행 · 1.23 s")).toBeInTheDocument();
});

test("completed이고 columns가 없으면 영향받은 행 수를 보여 준다", () => {
  finished({ outcome: "completed", rows: 12 }, { elapsedMicros: 420 });

  expect(screen.getByText("12행 영향 · 0.42 ms")).toBeInTheDocument();
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
  expect(screen.queryByText(/^줄 /)).toBeNull();
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
  expect(screen.getByText("줄 4:6")).toBeInTheDocument();
  expect(screen.getByText("42P01")).toBeInTheDocument();
});

test("cancelled면 취소됨과 시간을, 받은 행이 있으면 표도 보여 준다", () => {
  finished(
    { outcome: "cancelled" },
    { columns: ["id", "name"], rows: someRows },
  );

  expect(screen.getByText("취소됨 · 1.23 s")).toBeInTheDocument();
  expect(screen.getByRole("table")).toBeInTheDocument();
});

test("cancelled이고 받은 행이 없으면 표를 그리지 않는다", () => {
  finished({ outcome: "cancelled" }, { columns: ["id", "name"] });

  expect(screen.getByText("취소됨 · 1.23 s")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

test("discarded면 버렸다고 보여 준다", () => {
  finished(
    { outcome: "discarded" },
    { columns: ["id", "name"], rows: someRows },
  );

  expect(screen.getByText("결과를 버렸습니다")).toBeInTheDocument();
  expect(screen.queryByRole("table")).toBeNull();
});

test("connection_lost면 끊긴 이유와 다음 실행의 안내를 보여 준다", () => {
  finished({ outcome: "connection_lost", message: "server closed" });

  expect(
    screen.getByText("연결이 끊겼습니다: server closed"),
  ).toBeInTheDocument();
  expect(
    screen.getByText("다음 실행에서 새 세션을 엽니다"),
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
  expect(cells[1]).toHaveTextContent(/^$/);
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
