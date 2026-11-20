import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");
vi.mock("../../shared/api/clipboard");
vi.mock("../workspace/commands", () => ({
  runAgain: vi.fn(),
  cancelRun: vi.fn(),
  retryTunnel: vi.fn(),
}));

import { copyText } from "../../shared/api/clipboard";
import { stubLayout } from "../../test/layout";
import type { Cell, Outcome } from "../../shared/api/types";
import { cancelRun, retryTunnel, runAgain } from "../workspace/commands";
import { useTunnels } from "../connections/tunnelsStore";
import {
  connection,
  openProjectWith,
  resultColumns,
} from "../../test/fixtures";
import type { TunnelState } from "../../shared/api/types";
import { ResultPane } from "./ResultPane";
import { fitWidth } from "./grid";
import { emptyResult, type ResultData, type RunState } from "./runReducer";
import { shortcutLabel } from "../workspace/shortcuts";
import { useRuns } from "./runsStore";

const realFetchMore = useRuns.getInitialState().fetchMore;

beforeEach(async () => {
  // 결과 panel 크기의 viewport로 둔다.
  stubLayout({ width: 800, height: 400 });
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

test("hints_include_reformat", () => {
  render(<ResultPane tabId={null} hasConnection={false} />);

  expect(screen.getByText("Reformat")).toBeInTheDocument();
  expect(screen.getByText(shortcutLabel("reformat"))).toHaveTextContent("⌥⌘L");
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
      columns: resultColumns("id", "name"),
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
      columns: resultColumns("id", "name"),
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
      columns: resultColumns("id", "name"),
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
    { columns: resultColumns("id", "name"), rows: someRows, firstRow: 124_497 },
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
    result: result({
      columns: resultColumns("id", "name"),
      rows,
      elapsedMicros: 38_000,
    }),
  });

  expect(screen.getByText("500+ rows · 38 ms")).toBeInTheDocument();
});

test("끝나면 End 줄과 전체 행 수를 보여 준다", () => {
  finished(
    { outcome: "completed", rows: 1240 },
    {
      columns: resultColumns("id", "name"),
      rows: someRows,
      elapsedMicros: 41_000,
    },
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
    { columns: resultColumns("id", "name"), rows: someRows },
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
  finished({ outcome: "cancelled" }, { columns: resultColumns("id", "name") });

  expect(screen.getByText("Cancelled")).toBeInTheDocument();
  expect(screen.getByText("Stopped on the server.")).toBeInTheDocument();
  expect(screen.getByText("0 rows · 1.23 s")).toBeInTheDocument();
  expect(screen.queryByRole("grid")).toBeNull();
});

test("discarded면 버렸다고 보여 준다", () => {
  finished(
    { outcome: "discarded" },
    { columns: resultColumns("id", "name"), rows: someRows },
  );

  expect(screen.getByText("Results discarded")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Running the next query discarded the rows not yet fetched. Run again to see them.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByRole("grid")).toBeNull();
});

test("expired면 닫았다고 알리고 받은 행은 표에 남긴다", () => {
  finished(
    { outcome: "expired" },
    {
      columns: resultColumns("id", "name"),
      rows: someRows,
      elapsedMicros: 41_000,
    },
  );

  expect(screen.getByText("Results closed")).toBeInTheDocument();
  expect(
    screen.getByText(
      "Nothing was fetched for 10 minutes, so the query was closed on the database. The 3 rows received stay visible.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByText("3 rows · 41 ms")).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: /id/ })).toBeInTheDocument();
  expect(screen.queryByText(/^End/)).toBeNull();
});

test("expired의 받은 행이 하나면 단수로 쓴다", () => {
  finished(
    { outcome: "expired" },
    { columns: resultColumns("id"), rows: [["1"]] },
  );
  expect(
    screen.getByText(
      "Nothing was fetched for 10 minutes, so the query was closed on the database. The 1 row received stays visible.",
    ),
  ).toBeInTheDocument();
});

test("expired의 받은 행 수는 1000 단위로 묶는다", () => {
  const rows: Cell[][] = Array.from({ length: 1500 }, (_, i) => [String(i)]);
  finished({ outcome: "expired" }, { columns: resultColumns("id"), rows });
  expect(
    screen.getByText(
      "Nothing was fetched for 10 minutes, so the query was closed on the database. The 1,500 rows received stay visible.",
    ),
  ).toBeInTheDocument();
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
    { columns: resultColumns("id", "name"), rows: someRows, firstRow: 600 },
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
      columns: resultColumns("id", "name"),
      rows: someRows,
      fetch: "ready",
    }),
  });

  expect(fetchMore).toHaveBeenCalledWith("t");
});

test("선택이 있어야 header의 복사 button이 켜지고, 누르면 복사하고 알린다", async () => {
  finished(
    { outcome: "completed", rows: 3 },
    { columns: resultColumns("id", "name"), rows: someRows },
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
    { columns: resultColumns("id", "name"), rows: someRows },
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
  const running = result({
    columns: resultColumns("id", "name"),
    rows: someRows,
  });
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

describe("탭을 바꿨다 돌아올 때의 결과 표", () => {
  const manyRows: Cell[][] = Array.from({ length: 1000 }, (_, i) => [
    String(i + 1),
    `name${i + 1}`,
  ]);
  const fit = fitWidth(
    "name",
    manyRows.map((row) => row[1]),
  );

  function finishedRun(startedAt: number, sql = "SELECT id, name FROM t") {
    return {
      status: "finished",
      result: result({
        sql,
        startedAt,
        columns: resultColumns("id", "name"),
        rows: manyRows,
      }),
      outcome: { outcome: "completed", rows: 1000 },
    } satisfies RunState;
  }

  const grid = () => screen.getByRole("grid");
  const nameHeader = () =>
    screen.getByText("name").closest<HTMLElement>("[role=columnheader]")!;
  const selectedCells = () =>
    grid().querySelectorAll("[role=gridcell][aria-selected=true]");
  const copyButton = () =>
    screen.getByRole("button", { name: "Copy selected cells" });

  /** 탭 a의 표에서 name 열을 20px 줄이고, 두 번째 행의 name을 고르고, 10행 내린다(고른 행은 overscan 안이라 그려진다). */
  function touchGrid() {
    const handle = within(nameHeader()).getByRole("separator");
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 480 });
    fireEvent.mouseUp(document, { clientX: 480 });
    fireEvent.click(screen.getByText("name2"));
    grid().scrollTop = 260;
    fireEvent.scroll(grid());
  }

  function expectFresh() {
    expect(nameHeader().style.width).toBe(`${fit}px`);
    expect(selectedCells()).toHaveLength(0);
    expect(grid().scrollTop).toBe(0);
    expect(copyButton()).toBeDisabled();
  }

  test("같은 실행이면 너비, 선택, 스크롤이 그대로다", () => {
    useRuns.setState({ runs: { a: finishedRun(1), b: finishedRun(2) } });
    const view = render(<ResultPane tabId="a" hasConnection />);
    touchGrid();

    view.rerender(<ResultPane tabId="b" hasConnection />);
    expectFresh();

    view.rerender(<ResultPane tabId="a" hasConnection />);
    expect(nameHeader().style.width).toBe(`${fit - 20}px`);
    expect(selectedCells()).toHaveLength(1);
    expect(
      screen.getByText("name2").closest("[role=gridcell]"),
    ).toHaveAttribute("aria-selected", "true");
    expect(grid().scrollTop).toBe(260);
    expect(copyButton()).toBeEnabled();
  });

  test("떠난 사이 앞 행이 버려졌으면 보던 행이 그 자리에 있다", () => {
    useRuns.setState({ runs: { a: finishedRun(1), b: finishedRun(2) } });
    const view = render(<ResultPane tabId="a" hasConnection />);
    grid().scrollTop = 13_000;
    fireEvent.scroll(grid());

    view.rerender(<ResultPane tabId="b" hasConnection />);
    const run = finishedRun(1);
    act(() =>
      useRuns.setState((s) => ({
        runs: {
          ...s.runs,
          a: {
            ...run,
            result: { ...run.result, firstRow: 100, rows: manyRows.slice(100) },
          },
        },
      })),
    );
    view.rerender(<ResultPane tabId="a" hasConnection />);

    expect(grid().scrollTop).toBe(13_000 + 40 - 100 * 26);
  });

  test("그 탭에서 다시 실행했으면 처음부터 그린다", () => {
    useRuns.setState({ runs: { a: finishedRun(1), b: finishedRun(2) } });
    const view = render(<ResultPane tabId="a" hasConnection />);
    touchGrid();

    view.rerender(<ResultPane tabId="b" hasConnection />);
    act(() =>
      useRuns.setState((s) => ({ runs: { ...s.runs, a: finishedRun(3) } })),
    );
    view.rerender(<ResultPane tabId="a" hasConnection />);

    expectFresh();
  });

  test("release한 탭의 view는 버린다", async () => {
    useRuns.setState({ runs: { a: finishedRun(1), b: finishedRun(2) } });
    const view = render(<ResultPane tabId="a" hasConnection />);
    touchGrid();
    view.rerender(<ResultPane tabId="b" hasConnection />);

    // 보이지 않는 탭을 닫았다. 같은 실행이 다시 와도 이어 가지 않는다.
    await act(() => useRuns.getState().release("a"));
    act(() =>
      useRuns.setState((s) => ({ runs: { ...s.runs, a: finishedRun(1) } })),
    );
    view.rerender(<ResultPane tabId="a" hasConnection />);
    expectFresh();

    // 보고 있는 탭을 닫으면 표가 사라질 때 저장하지 않는다.
    touchGrid();
    await act(() => useRuns.getState().release("a"));
    act(() =>
      useRuns.setState((s) => ({ runs: { ...s.runs, a: finishedRun(1) } })),
    );
    expectFresh();
  });

  test("프로젝트를 바꾸면(reset) 모든 view를 버린다", async () => {
    useRuns.setState({ runs: { a: finishedRun(1), b: finishedRun(2) } });
    const view = render(<ResultPane tabId="a" hasConnection />);
    touchGrid();
    view.rerender(<ResultPane tabId="b" hasConnection />);

    await act(() => useRuns.getState().reset());
    act(() => useRuns.setState({ runs: { a: finishedRun(1) } }));
    view.rerender(<ResultPane tabId="a" hasConnection />);

    expectFresh();
  });
});

describe("터널", () => {
  const staging = connection("staging", {
    port: 25432,
    tunnel: "ssh -N -L 25432:db.internal:5432 bastion",
  });

  beforeEach(() => {
    openProjectWith([staging]);
    useTunnels.getState().reset();
  });

  function tunnel(state: TunnelState) {
    act(() => useTunnels.getState().apply({ connection: "staging", state }));
  }

  function showFor(state: RunState, onEditConnection = vi.fn()) {
    useRuns.setState({ runs: { t: state } });
    render(
      <ResultPane
        tabId="t"
        hasConnection
        connection="staging"
        onEditConnection={onEditConnection}
      />,
    );
    return onEditConnection;
  }

  test("연결 중에 터널이 시작 중이면 명령과 Cancel을 보여 준다", async () => {
    tunnel({ status: "starting", attempt: 0, timeoutSecs: 20 });
    showFor({ status: "connecting" });

    expect(
      screen.getByText(
        "Ran the tunnel command. Connects once localhost:25432 opens.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("ssh -N -L 25432:db.internal:5432 bastion"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelRun).toHaveBeenCalledWith("t");
  });

  test("터널을 열지 못한 실행은 명령의 출력과 Try again, Edit connection을 준다", () => {
    const run = vi.spyOn(useRuns.getState(), "run").mockResolvedValue();
    const retry = {
      connection: "staging",
      sql: "SELECT 1",
      origin: { line: 1, column: 1 },
    };
    const onEdit = showFor({
      status: "rejected",
      rejection: {
        title: "localhost:25432 didn't open within 20 seconds",
        detail: null,
        output: "Unauthorized. Please login",
        retry,
      },
    });

    expect(screen.getByText("Command output (stderr)")).toBeInTheDocument();
    expect(screen.getByText("Unauthorized. Please login")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(run).toHaveBeenCalledWith("t", expect.any(Function));
    const prepare = run.mock.calls[0][1];
    expect(prepare()).toEqual(retry);

    fireEvent.click(screen.getByRole("button", { name: "Edit connection" }));
    expect(onEdit).toHaveBeenCalledWith("staging");
    run.mockRestore();
  });

  test("다시 실행 중이면 한 줄로 알린다", () => {
    tunnel({ status: "ready" });
    tunnel({ status: "starting", attempt: 2, timeoutSecs: 20 });
    showFor({ status: "idle" });
    expect(
      screen.getByText(
        "The tunnel process exited. Running the command again (2/3).",
      ),
    ).toBeInTheDocument();
  });

  test("다시 실행을 멈춘 터널은 출력과 Try again을 준다", () => {
    tunnel({ status: "starting", attempt: 3, timeoutSecs: 20 });
    tunnel({ status: "failed", reason: "exited", code: 1, output: "e3" });
    showFor({ status: "idle" });

    expect(
      screen.getByText(
        "Ran the tunnel 3 times but it didn't open, so it stopped.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("e3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retryTunnel).toHaveBeenCalledWith("staging");
  });

  test("Reconnected 알림은 Close로 닫는다", () => {
    useRuns.setState({ notices: { t: { kind: "reconnected" } } });
    showFor({ status: "idle" });

    const banner = screen.getByText("Reconnected").closest('[role="status"]');
    expect(banner).not.toBeNull();
    expect(banner).toHaveTextContent(
      "This is a new session, so session state such as SET values and temporary tables was reset.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(useRuns.getState().notices.t).toBeUndefined();
  });
});

describe("트랜잭션", () => {
  const failedOutcome: Outcome = {
    outcome: "failed",
    error: {
      code: "25P02",
      message:
        "current transaction is aborted, commands ignored until end of transaction block",
      detail: null,
      hint: null,
      position: null,
    },
  };

  function failedIn(
    status: "open" | "failed" | null,
    outcome: Outcome = failedOutcome,
  ) {
    useRuns.setState({
      runs: {
        t: { status: "finished", result: result(), outcome },
      },
      transactions:
        status === null
          ? {}
          : { t: { status, statements: 2, openedAt: 0, openedBy: "app" } },
    });
    render(<ResultPane tabId="t" hasConnection />);
  }

  test("a_failed_statement_in_a_failed_transaction_says_so", () => {
    const end = vi
      .spyOn(useRuns.getState(), "endTransaction")
      .mockResolvedValue(true);
    try {
      failedIn("failed", failedOutcome);

      expect(screen.getByText("Transaction failed")).toBeInTheDocument();
      expect(
        screen.getByText(
          "current transaction is aborted, commands ignored until end of transaction block",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("SQLSTATE 25P02")).toBeInTheDocument();
      expect(
        screen.getByText(
          "An earlier error left the transaction failed. Roll back, then run again.",
        ),
      ).toBeInTheDocument();
      const rollback = screen.getByRole("button", { name: /Rollback/ });
      expect(
        within(rollback).getByText(shortcutLabel("rollback")),
      ).toBeVisible();

      fireEvent.click(rollback);
      expect(end).toHaveBeenCalledWith("t", "rollback");
    } finally {
      end.mockRestore();
    }
  });

  test("the_statement_that_failed_the_transaction_keeps_the_error_details", () => {
    failedIn("failed", {
      outcome: "failed",
      error: {
        code: "42P01",
        message: 'relation "nope" does not exist',
        detail: null,
        hint: null,
        position: 15,
      },
    });

    expect(screen.getByText("Transaction failed")).toBeInTheDocument();
    expect(screen.getByText("Ln 1, Col 16")).toBeInTheDocument();
    expect(screen.getByText("1.23 s")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy message" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This error left the transaction failed. Roll back, then run again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/An earlier error/)).toBeNull();
  });

  test("the_failed_view_disables_rollback_while_ending", () => {
    useRuns.setState({ ending: { t: {} } });
    failedIn("failed");

    expect(screen.getByRole("button", { name: /Rollback/ })).toBeDisabled();
  });

  test("a_failure_outside_a_failed_transaction_is_the_plain_error", () => {
    failedIn(null);

    expect(screen.queryByText("Transaction failed")).toBeNull();
    expect(screen.queryByRole("button", { name: /Rollback/ })).toBeNull();
    expect(screen.getByText("SQLSTATE 25P02")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy message" }),
    ).toBeInTheDocument();
  });

  test("a_failure_in_an_open_transaction_is_the_plain_error", () => {
    failedIn("open");

    expect(screen.queryByText("Transaction failed")).toBeNull();
    expect(screen.queryByRole("button", { name: /Rollback/ })).toBeNull();
  });

  test("transaction_lost_notice_dismisses_with_ok", () => {
    useRuns.setState({
      notices: {
        t: { kind: "transactionLost", statements: 2, openedBy: "app" },
      },
    });
    show({ status: "idle" });

    const banner = screen
      .getByText("Transaction lost")
      .closest('[role="alert"]');
    expect(banner).not.toBeNull();
    expect(banner).toHaveTextContent(
      "The connection dropped while a transaction was open. The 2 uncommitted statements were not applied. The next run opens a new session.",
    );
    fireEvent.click(
      within(banner as HTMLElement).getByRole("button", { name: "OK" }),
    );
    expect(useRuns.getState().notices.t).toBeUndefined();
  });

  test("transaction_lost_notice_counts_one_statement_and_none", () => {
    useRuns.setState({
      notices: {
        t: { kind: "transactionLost", statements: 1, openedBy: "app" },
      },
    });
    show({ status: "idle" });

    expect(
      screen.getByText(/The 1 uncommitted statement was not applied\./),
    ).toBeInTheDocument();
  });

  test("transaction_lost_notice_without_statements_says_it_was_not_applied", () => {
    useRuns.setState({
      notices: {
        t: { kind: "transactionLost", statements: 0, openedBy: "user" },
      },
    });
    show({ status: "idle" });

    expect(
      screen.getByText(
        "The connection dropped while a transaction was open. It was not applied. The next run opens a new session.",
      ),
    ).toBeInTheDocument();
  });

  test("transaction_lost_notice_of_an_app_opened_transaction_counts_0_statements", () => {
    useRuns.setState({
      notices: {
        t: { kind: "transactionLost", statements: 0, openedBy: "app" },
      },
    });
    show({ status: "idle" });

    expect(
      screen.getByText(/The 0 uncommitted statements were not applied\./),
    ).toBeInTheDocument();
  });

  test("a_discard_from_ending_the_transaction_says_so", () => {
    useRuns.setState({ discardedByEnd: { t: true } });
    finished(
      { outcome: "discarded" },
      { columns: resultColumns("id", "name"), rows: someRows },
    );

    expect(screen.getByText("Results discarded")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Ending the transaction discarded the rows not yet fetched. Run again to see them.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Running the next query/)).toBeNull();
  });
});
