import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { parsePlan } from "./explainPlan";
import { ExplainView } from "./ExplainView";

const TAB = <span>tabs</span>;

function view(lines: string[]) {
  const plan = parsePlan(lines);
  if (plan === null) throw new Error("not a plan");
  return render(<ExplainView tabs={TAB} plan={plan} lines={lines} />);
}

const ANALYZE = [
  "Sort  (cost=1.00..2.00 rows=120 width=8) (actual time=40.900..41.000 rows=118.00 loops=1)",
  "  Sort Key: a",
  "  ->  Hash Join  (cost=1.00..2.00 rows=120 width=8) (actual time=0.100..40.600 rows=118.00 loops=1)",
  "        ->  Seq Scan on orders  (cost=0.00..1.00 rows=1200 width=8) (actual time=0.010..36.900 rows=98410.00 loops=1)",
  "        ->  Hash  (cost=0.00..1.00 rows=80 width=8) (actual time=0.300..0.300 rows=76.00 loops=1)",
  "              ->  Index Scan using users_pkey on users  (cost=0.00..1.00 rows=80 width=8) (actual time=0.100..0.200 rows=76.00 loops=1)",
  "Planning Time: 0.400 ms",
  "Execution Time: 41.200 ms",
];

const rows = () =>
  screen
    .getAllByRole("row")
    .filter((row) => !row.querySelector('[role="columnheader"]'));
const cells = (row: HTMLElement) => within(row).getAllByRole("cell");

test("indents_by_depth", () => {
  view(ANALYZE);

  const indents = rows().map((row) => cells(row)[0].style.paddingLeft);
  expect(indents).toEqual(["10px", "26px", "42px", "42px", "58px"]);
  expect(cells(rows()[2])[0]).toHaveTextContent("Seq Scan on orders");
});

test("slowest_row_is_bold", () => {
  view(ANALYZE);

  const bold = rows().filter((row) => row.className.includes("font-semibold"));
  expect(bold).toHaveLength(1);
  expect(bold[0]).toHaveTextContent("Seq Scan on orders");
  expect(bold[0].className).toContain("bg-bg-1");
});

test("rows_show_estimate_and_actual", () => {
  view(ANALYZE);

  expect(cells(rows()[2]).map((c) => c.textContent)).toEqual([
    "Seq Scan on orders",
    "37 ms",
    "1,200 → 98,410",
    "1",
  ]);
  expect(cells(rows()[0])[1]).toHaveTextContent("41 ms");
  expect(cells(rows()[0])[2]).toHaveTextContent("120 → 118");
});

test("fractional_actual_rows_keep_the_decimal", () => {
  view([
    "Index Scan on t  (cost=0.00..1.00 rows=3 width=8) (actual time=0.010..0.020 rows=50.50 loops=2)",
  ]);

  expect(cells(rows()[0])[2]).toHaveTextContent("3 → 50.5");
});

test("a_plan_without_analyze_shows_only_estimates", () => {
  view(["Seq Scan on t  (cost=0.00..1.00 rows=1200 width=8)"]);

  expect(cells(rows()[0]).map((c) => c.textContent)).toEqual([
    "Seq Scan on t",
    "",
    "1,200",
    "",
  ]);
  expect(rows()[0].className).not.toContain("font-semibold");
});

test("never_executed_node_says_so", () => {
  view([
    "Append  (cost=0.00..2.00 rows=2 width=8) (actual time=0.010..0.020 rows=1.00 loops=1)",
    "  ->  Seq Scan on a  (cost=0.00..1.00 rows=1 width=8) (actual time=0.005..0.010 rows=1.00 loops=1)",
    "  ->  Seq Scan on b  (cost=0.00..1.00 rows=1 width=8) (never executed)",
  ]);

  const never = cells(rows()[2]);
  expect(never[1]).toHaveTextContent("never executed");
  expect(never[1].className).toContain("text-fg-3");
  expect(never[2]).toHaveTextContent("1");
  expect(never[3]).toHaveTextContent("");
});

test("show_raw_toggles_server_text", () => {
  view(ANALYZE);

  fireEvent.click(screen.getByRole("button", { name: "Show raw" }));

  expect(screen.queryByRole("table")).toBeNull();
  const raw = screen.getByTestId("explain-raw");
  expect(raw.tagName).toBe("PRE");
  expect(raw.textContent).toBe(ANALYZE.join("\n"));

  fireEvent.click(screen.getByRole("button", { name: "Show tree" }));

  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(screen.queryByTestId("explain-raw")).toBeNull();
});

test("timings_omit_missing_values", () => {
  const { unmount } = view(ANALYZE);
  expect(
    screen.getByText("Execution 41 ms · Planning 0.40 ms"),
  ).toBeInTheDocument();
  unmount();

  const executionOnly = view([
    "Seq Scan on t  (cost=0.00..1.00 rows=1 width=8) (actual time=0.010..0.020 rows=1.00 loops=1)",
    "Execution Time: 0.050 ms",
  ]);
  expect(screen.getByText("Execution 0.05 ms")).toBeInTheDocument();
  executionOnly.unmount();

  const planningOnly = view([
    "Seq Scan on t  (cost=0.00..1.00 rows=1 width=8)",
    "Planning Time: 0.250 ms",
  ]);
  expect(screen.getByText("Planning 0.25 ms")).toBeInTheDocument();
  planningOnly.unmount();

  view(["Seq Scan on t  (cost=0.00..1.00 rows=1 width=8)"]);
  expect(screen.queryByText(/Execution|Planning/)).toBeNull();
});

test("without_tabs_it_draws_the_explain_tab", () => {
  const lines = ["Result  (cost=0.00..0.01 rows=1 width=4)"];
  const plan = parsePlan(lines)!;
  render(<ExplainView tabs={null} plan={plan} lines={lines} />);

  expect(screen.getByRole("tab", { name: "EXPLAIN" })).toBeInTheDocument();
});
