import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/clipboard");
vi.mock("../workspace/commands", () => ({ runAgain: vi.fn() }));

import { copyText } from "../../shared/api/clipboard";
import type { Cell, Outcome } from "../../shared/api/types";
import { runAgain } from "../workspace/commands";
import { ResultPane } from "./ResultPane";
import { emptyResult, type ResultData, type RunState } from "./runReducer";
import { useRuns } from "./runsStore";

const realFetchMore = useRuns.getInitialState().fetchMore;

beforeEach(async () => {
  // jsdom은 layout이 없어 clientHeight가 0이다. 결과 panel 크기의 viewport로 둔다.
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.mocked(copyText).mockResolvedValue(undefined);
  await useRuns.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
  useRuns.setState({ fetchMore: realFetchMore });
});

function result(patch: Partial<ResultData> = {}): ResultData {
  return {
    ...emptyResult("SELECT id, name FROM t", { line: 1, column: 1 }, 0),
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
  render(<ResultPane tabId="t" hasConnection />);
}

function finished(outcome: Outcome, patch: Partial<ResultData> = {}) {
  show({ status: "finished", result: result(patch), outcome });
}

test("tabId가 null이거나 idle이면 단축키를 가르친다", () => {
  const { unmount } = render(<ResultPane tabId={null} hasConnection={false} />);
  expect(screen.getByText("Run statement at cursor")).toBeInTheDocument();
  expect(screen.getByText("New tab")).toBeInTheDocument();
  expect(screen.queryByRole("tablist")).toBeNull();
  unmount();

  // runs에 없는 탭은 idle이다.
  render(<ResultPane tabId="t" hasConnection />);
  expect(screen.getByText("Run statement at cursor")).toBeInTheDocument();
});

test("접속이 없는 탭은 접속을 고르라고 한다", () => {
  render(<ResultPane tabId="t" hasConnection={false} />);

  expect(
    screen.getByText("Choose a connection to run queries."),
  ).toBeInTheDocument();
  expect(screen.queryByText("Run statement at cursor")).toBeNull();
});

test("connecting이면 연결 중이다", () => {
  show({ status: "connecting" });

  expect(screen.getByText("Connecting…")).toBeInTheDocument();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.queryByRole("grid")).toBeNull();
});

test("실행 중이고 행이 없으면 경과 시간을 보여 준다", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  show({
    status: "running",
    result: result({
      columns: ["id", "name"],
      elapsedMicros: null,
      startedAt: 10_000,
    }),
  });

  expect(screen.getByText("Running 0.0 s")).toBeInTheDocument();
  act(() => {
    vi.advanceTimersByTime(4_230);
  });

  expect(screen.getByText("Running 4.2 s")).toBeInTheDocument();
  expect(
    screen.getByText("Waiting for the first row from the server"),
  ).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "SELECT t" })).toBeInTheDocument();
  expect(screen.queryByRole("grid")).toBeNull();
});

test("행이 오면 rows 뒤에 +를 붙인다", () => {
  show({
    status: "running",
    result: result({
      columns: ["id", "name"],
      rows: someRows,
      elapsedMicros: 38_000,
    }),
  });

  expect(screen.getByText("3+ rows · 38 ms")).toBeInTheDocument();
  expect(screen.getByRole("grid")).toBeInTheDocument();
  expect(screen.queryByText(/^End/)).toBeNull();
});

test("앞 행을 버린 뒤에도 rows는 지금까지 받은 행 수다", () => {
  show({
    status: "running",
    result: result({
      columns: ["id", "name"],
      rows: someRows,
      firstRow: 124_497,
      elapsedMicros: 2_100_000,
    }),
  });

  expect(screen.getByText("124,500+ rows · 2.10 s")).toBeInTheDocument();
});

test("앞 행을 버린 결과를 cancel하면 header는 받은 행 수, 안내는 남은 행 수다", () => {
  finished(
    { outcome: "cancelled" },
    { columns: ["id", "name"], rows: someRows, firstRow: 124_497 },
  );

  expect(screen.getByText("124,500 rows · 1.23 s")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Stopped on the server. The 3 rows received stay visible.",
    ),
  ).toBeInTheDocument();
});

test("500행이 오면 500+ rows라고 쓴다", () => {
  const rows = Array.from({ length: 500 }, (_, i) => [String(i), "x"]);
  show({
    status: "running",
    result: result({ columns: ["id", "name"], rows, elapsedMicros: 38_000 }),
  });

  expect(screen.getByText("500+ rows · 38 ms")).toBeInTheDocument();
});

test("끝나면 End 줄과 전체 행 수를 보여 준다", () => {
  finished(
    { outcome: "completed", rows: 1240 },
    { columns: ["id", "name"], rows: someRows, elapsedMicros: 41_000 },
  );

  expect(screen.getByText("1,240 rows · 41 ms")).toBeInTheDocument();
  expect(screen.getByText("End · 1,240 rows")).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: /id/ })).toBeInTheDocument();
});

test("completed이고 columns가 없으면 영향받은 행 수를 문장으로 보여 준다", () => {
  finished(
    { outcome: "completed", rows: 12 },
    { sql: "UPDATE t SET a = 1", elapsedMicros: 420 },
  );

  expect(screen.getByText("12 rows updated")).toBeInTheDocument();
  expect(screen.getByText("0.42 ms")).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "UPDATE t" })).toBeInTheDocument();
  expect(screen.queryByRole("grid")).toBeNull();
});

test("행을 돌려주지 않는 다른 문장은 Done이다", () => {
  finished({ outcome: "completed", rows: 0 }, { sql: "CREATE TABLE t ()" });

  expect(screen.getByText("Done")).toBeInTheDocument();
});

const failure = {
  outcome: "failed",
  error: {
    code: "42601",
    message: "syntax error at end of input",
    detail: null,
    hint: null,
    position: null,
  },
} as const;

test("failed면 server error와 SQLSTATE, 시간을 보여 준다", () => {
  finished(failure, { elapsedMicros: 3_000 });

  expect(screen.getByText("syntax error at end of input")).toBeInTheDocument();
  expect(screen.getByText("SQLSTATE 42601")).toBeInTheDocument();
  expect(screen.getByText("3 ms")).toBeInTheDocument();
  expect(screen.queryByText(/^Ln /)).toBeNull();
  // header에는 이름만 있다.
  expect(screen.getByRole("tab")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Copy selected cells" }),
  ).toBeNull();
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
  expect(screen.getByText("SQLSTATE 42P01")).toBeInTheDocument();
});

test("오류의 Copy message는 서버 message를 복사하고 알린다", async () => {
  finished(failure);

  fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

  expect(copyText).toHaveBeenCalledWith("syntax error at end of input");
  expect(await screen.findByText("Copied message")).toBeInTheDocument();
});

test("cancelled면 안내와 받은 행을 보여 준다", () => {
  finished(
    { outcome: "cancelled" },
    { columns: ["id", "name"], rows: someRows },
  );

  expect(screen.getByText("Cancelled")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Stopped on the server. The 3 rows received stay visible.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("3 rows · 1.23 s")).toBeInTheDocument();
  expect(screen.getByRole("grid")).toBeInTheDocument();
  // 끝난 표지만 End 줄은 없고 더 가져오지도 않는다.
  expect(screen.queryByText(/^End/)).toBeNull();
});

test("cancelled이고 받은 행이 없으면 표를 그리지 않는다", () => {
  finished({ outcome: "cancelled" }, { columns: ["id", "name"] });

  expect(screen.getByText("Cancelled")).toBeInTheDocument();
  expect(screen.getByText("Stopped on the server.")).toBeInTheDocument();
  expect(screen.getByText("0 rows · 1.23 s")).toBeInTheDocument();
  expect(screen.queryByRole("grid")).toBeNull();
});

test("discarded면 버렸다고 보여 준다", () => {
  finished(
    { outcome: "discarded" },
    { columns: ["id", "name"], rows: someRows },
  );

  expect(screen.getByText("Results discarded")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Running the next query discarded the rows not yet fetched. Run again to see them.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByRole("grid")).toBeNull();
});

test("connection_lost면 끊긴 이유와 다음 실행의 안내를 보여 준다", () => {
  finished({ outcome: "connection_lost", message: "server closed" });

  expect(screen.getByText("Connection lost")).toBeInTheDocument();
  expect(screen.getByText("server closed")).toBeInTheDocument();
  expect(
    screen.getByText(
      "The next run opens a new session. SET values and temp tables are gone.",
    ),
  ).toBeInTheDocument();
});

test("client_error면 message를 보여 준다", () => {
  finished({ outcome: "client_error", message: "값을 읽지 못했습니다" });

  expect(screen.getByText("값을 읽지 못했습니다")).toBeInTheDocument();
  expect(screen.getByRole("tab")).toBeInTheDocument();
});

test("rejected면 title과 detail을 보여 주고 header는 없다", () => {
  show({
    status: "rejected",
    rejection: { title: "서버에 닿지 못했습니다", detail: "시간 초과" },
  });

  expect(screen.getByText("서버에 닿지 못했습니다")).toBeInTheDocument();
  expect(screen.getByText("시간 초과")).toBeInTheDocument();
  expect(screen.queryByRole("tablist")).toBeNull();
});

test("split_failed 거절은 제목과 설명을 보여 준다", () => {
  show({
    status: "rejected",
    rejection: {
      title: "Couldn't find a statement",
      detail: "The text could not be split into statements.",
    },
  });

  expect(screen.getByText("Couldn't find a statement")).toBeInTheDocument();
  expect(
    screen.getByText("The text could not be split into statements."),
  ).toBeInTheDocument();
});

test("rejected의 detail이 null이면 title만 보여 준다", () => {
  show({
    status: "rejected",
    rejection: { title: "Nothing to run", detail: null },
  });

  expect(screen.getByText("Nothing to run")).toBeInTheDocument();
});

test("Run again은 runAgain을 부른다", () => {
  finished(
    { outcome: "completed", rows: 900 },
    { columns: ["id", "name"], rows: someRows, firstRow: 600 },
  );

  fireEvent.click(screen.getByRole("button", { name: "Run again" }));

  expect(runAgain).toHaveBeenCalledWith("t");
});

test("스크롤 끝에서 fetchMore를 부른다", () => {
  const fetchMore = vi.fn().mockResolvedValue(undefined);
  useRuns.setState({ fetchMore });
  show({
    status: "running",
    result: result({
      columns: ["id", "name"],
      rows: someRows,
      fetch: "ready",
    }),
  });

  expect(fetchMore).toHaveBeenCalledWith("t");
});

test("선택이 있어야 header의 복사 button이 켜지고, 누르면 복사하고 알린다", async () => {
  finished(
    { outcome: "completed", rows: 3 },
    { columns: ["id", "name"], rows: someRows },
  );
  const button = screen.getByRole("button", { name: "Copy selected cells" });
  expect(button).toBeDisabled();

  fireEvent.click(screen.getByText("b"));
  expect(button).toBeEnabled();
  fireEvent.click(button);

  expect(copyText).toHaveBeenCalledWith("b");
  expect(await screen.findByText("Copied cell")).toBeInTheDocument();
});

test("복사 알림은 창이 아니라 결과 panel의 아래 가운데에 붙는다", async () => {
  finished(
    { outcome: "completed", rows: 3 },
    { columns: ["id", "name"], rows: someRows },
  );

  fireEvent.click(screen.getByText("b"));
  fireEvent.click(screen.getByRole("button", { name: "Copy selected cells" }));

  const status = await screen.findByRole("status");
  expect(status).toHaveTextContent("Copied cell");
  // jsdom은 layout이 없어 class로 본다. panel(section)이 기준이라 아래의 status bar와 겹치지 않는다.
  expect(status).toHaveClass("absolute", "bottom-3", "left-1/2");
  expect(status).not.toHaveClass("fixed");
  expect(status.parentElement).toBe(status.closest("section"));
  expect(status.closest("section")).toHaveClass("relative");
});

test("끝나도 표를 다시 만들지 않는다", () => {
  const running = result({ columns: ["id", "name"], rows: someRows });
  show({ status: "running", result: running });
  const grid = screen.getByRole("grid");

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
  expect(screen.getByRole("grid")).toBe(grid);
});
