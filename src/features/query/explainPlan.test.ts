import { expect, test } from "vitest";
import type { ResultColumn } from "../../shared/api/types";
import { isPlanResult, parsePlan } from "./explainPlan";

/** 실제 PostgreSQL 18.6의 `EXPLAIN ANALYZE SELECT * FROM big_table b JOIN (SELECT id FROM big_table LIMIT 50) s USING (id) ORDER BY note` 출력 */
const PG18 = [
  "Sort  (cost=425.26..425.38 rows=50 width=261) (actual time=0.113..0.115 rows=50.00 loops=1)",
  "  Sort Key: b.note",
  "  Sort Method: quicksort  Memory: 35kB",
  "  Buffers: shared hit=205 read=1",
  "  ->  Nested Loop  (cost=0.85..423.85 rows=50 width=261) (actual time=0.010..0.071 rows=50.00 loops=1)",
  "        Buffers: shared hit=205 read=1",
  "        ->  Limit  (cost=0.42..1.72 rows=50 width=8) (actual time=0.007..0.015 rows=50.00 loops=1)",
  "              Buffers: shared hit=6",
  "              ->  Index Only Scan using big_table_pkey on big_table  (cost=0.42..25980.42 rows=1000000 width=8) (actual time=0.007..0.013 rows=50.00 loops=1)",
  "                    Heap Fetches: 38",
  "                    Index Searches: 1",
  "                    Buffers: shared hit=6",
  "        ->  Index Scan using big_table_pkey on big_table b  (cost=0.42..8.44 rows=1 width=261) (actual time=0.001..0.001 rows=1.00 loops=50)",
  "              Index Cond: (id = big_table.id)",
  "              Index Searches: 50",
  "              Buffers: shared hit=199 read=1",
  "Planning:",
  "  Buffers: shared hit=138 read=3",
  "Planning Time: 1.058 ms",
  "Execution Time: 0.124 ms",
];

test("parses_postgres_18_analyze_output", () => {
  const plan = parsePlan(PG18)!;
  expect(plan.nodes.map((n) => n.depth)).toEqual([0, 1, 2, 3, 2]);
  expect(plan.nodes.map((n) => n.label)).toEqual([
    "Sort",
    "Nested Loop",
    "Limit",
    "Index Only Scan using big_table_pkey on big_table",
    "Index Scan using big_table_pkey on big_table b",
  ]);
  const scan = plan.nodes[4];
  expect(scan.loops).toBe(50);
  expect(scan.totalMs).toBeCloseTo(0.05, 6);
  expect(scan.estimatedRows).toBe(1);
  expect(scan.actualRows).toBe(1);
  expect(plan.nodes[0].estimatedRows).toBe(50);
  expect(plan.planningMs).toBeCloseTo(1.058, 6);
  expect(plan.executionMs).toBeCloseTo(0.124, 6);
  // Nested Loop 0.071 - (Limit 0.015 + Index Scan 0.05)
  expect(plan.nodes[1].selfMs).toBeCloseTo(0.006, 6);
});

test("integer_rows_from_older_servers", () => {
  const plan = parsePlan([
    "Seq Scan on t  (cost=0.00..1.10 rows=118 width=4) (actual time=0.010..0.020 rows=118 loops=1)",
    "Planning Time: 0.100 ms",
    "Execution Time: 0.050 ms",
  ])!;
  expect(plan.nodes[0].actualRows).toBe(118);
  expect(plan.nodes[0].loops).toBe(1);
  expect(plan.nodes[0].totalMs).toBeCloseTo(0.02, 6);
});

const TOOLS_PLAN = [
  "Sort  (cost=900.00..900.30 rows=120 width=64) (actual time=40.9..41.0 rows=118 loops=1)",
  "  Sort Key: o.created_at",
  "  ->  Hash Join  (cost=10.00..880.00 rows=120 width=64) (actual time=0.9..40.6 rows=118 loops=1)",
  "        Hash Cond: (o.user_id = u.id)",
  "        ->  Seq Scan on orders o  (cost=0.00..800.00 rows=1200 width=40) (actual time=0.010..36.9 rows=98410 loops=1)",
  "              Filter: (total > 10)",
  "        ->  Hash  (cost=9.00..9.00 rows=80 width=24) (actual time=0.3..0.3 rows=76 loops=1)",
  "              Buckets: 1024  Batches: 1  Memory Usage: 12kB",
  "              ->  Index Scan using users_pkey on users u  (cost=0.15..9.00 rows=80 width=24) (actual time=0.1..0.2 rows=76 loops=1)",
  "Planning Time: 0.400 ms",
  "Execution Time: 41.200 ms",
];

test("slowest_is_by_self_time", () => {
  const plan = parsePlan(TOOLS_PLAN)!;
  expect(plan.nodes.map((n) => n.depth)).toEqual([0, 1, 2, 2, 3]);
  expect(plan.nodes.map((n) => n.totalMs)).toEqual([
    41.0, 40.6, 36.9, 0.3, 0.2,
  ]);
  // 총 시간으로는 Sort가 가장 크지만 self time으로는 Seq Scan이다.
  expect(plan.nodes[0].selfMs).toBeCloseTo(0.4, 6);
  expect(plan.nodes[1].selfMs).toBeCloseTo(3.4, 6);
  expect(plan.nodes[2].selfMs).toBeCloseTo(36.9, 6);
  expect(plan.slowest).toBe(2);
  expect(plan.nodes[2].label).toBe("Seq Scan on orders o");
});

test("self_time_is_clamped_at_zero", () => {
  const plan = parsePlan([
    "Append  (cost=0.00..1.00 rows=2 width=4) (actual time=0.0..1.0 rows=2 loops=1)",
    "  ->  Seq Scan on a  (cost=0.00..1.00 rows=1 width=4) (actual time=0.0..0.8 rows=1 loops=1)",
    "  ->  Seq Scan on b  (cost=0.00..1.00 rows=1 width=4) (actual time=0.0..0.8 rows=1 loops=1)",
  ])!;
  expect(plan.nodes[0].selfMs).toBe(0);
});

test("subplans_attach_to_their_parent", () => {
  const plan = parsePlan([
    "Seq Scan on t1  (cost=0.01..50.00 rows=10 width=4) (actual time=0.5..1.5 rows=10 loops=1)",
    "  Filter: ((c > (InitPlan 1).col1) AND (d = (SubPlan 2)))",
    "  InitPlan 1",
    "    ->  Result  (cost=0.00..0.01 rows=1 width=4) (actual time=0.001..0.001 rows=1 loops=1)",
    "  SubPlan 2",
    "    ->  Aggregate  (cost=1.00..1.01 rows=1 width=8) (actual time=0.010..0.010 rows=1 loops=10)",
    "          ->  Seq Scan on t2  (cost=0.00..1.00 rows=1 width=4) (actual time=0.005..0.006 rows=1 loops=10)",
    "Planning Time: 0.1 ms",
  ])!;
  expect(plan.nodes.map((n) => n.label)).toEqual([
    "Seq Scan on t1",
    "Result",
    "Aggregate",
    "Seq Scan on t2",
  ]);
  expect(plan.nodes.map((n) => n.depth)).toEqual([0, 1, 1, 2]);
});

test("older_initplan_with_returns_and_sibling_after_subplan", () => {
  const plan = parsePlan([
    "Nested Loop  (cost=0.01..9.00 rows=1 width=4)",
    "  InitPlan 1 (returns $0)",
    "    ->  Result  (cost=0.00..0.01 rows=1 width=4)",
    "  ->  Seq Scan on t  (cost=0.00..1.00 rows=1 width=4)",
    "        Filter: (c = $0)",
  ])!;
  expect(plan.nodes.map((n) => n.depth)).toEqual([0, 1, 1]);
  expect(plan.nodes[2].label).toBe("Seq Scan on t");
});

test("never_executed_node", () => {
  const plan = parsePlan([
    "Nested Loop  (cost=0.15..10.00 rows=1 width=4) (actual time=0.010..0.020 rows=0 loops=1)",
    "  ->  Seq Scan on a  (cost=0.00..1.00 rows=1 width=4) (actual time=0.005..0.005 rows=0 loops=1)",
    "  ->  Index Scan using b_pkey on b  (cost=0.15..8.17 rows=1 width=4) (never executed)",
    "        Index Cond: (id = a.id)",
  ])!;
  const never = plan.nodes[2];
  expect(never.neverExecuted).toBe(true);
  expect(never.totalMs).toBeNull();
  expect(never.selfMs).toBeNull();
  expect(never.actualRows).toBeNull();
  expect(never.loops).toBeNull();
  expect(never.estimatedRows).toBe(1);
  expect(plan.nodes[1].neverExecuted).toBe(false);
  // 실행되지 않은 자식은 부모의 self time에서 0으로 센다.
  expect(plan.nodes[0].selfMs).toBeCloseTo(0.015, 6);
  expect(plan.slowest).toBe(0);
});

test("plain_explain_has_estimates_only", () => {
  const plan = parsePlan([
    "Hash Join  (cost=10.00..880.00 rows=120 width=64)",
    "  Hash Cond: (o.user_id = u.id)",
    "  ->  Seq Scan on orders o  (cost=0.00..800.00 rows=1200 width=40)",
    "  ->  Hash  (cost=9.00..9.00 rows=80 width=24)",
    "        ->  Seq Scan on users u  (cost=0.00..9.00 rows=80 width=24)",
  ])!;
  expect(plan.nodes).toHaveLength(4);
  expect(plan.nodes.map((n) => n.estimatedRows)).toEqual([120, 1200, 80, 80]);
  for (const n of plan.nodes) {
    expect(n.actualRows).toBeNull();
    expect(n.totalMs).toBeNull();
    expect(n.selfMs).toBeNull();
    expect(n.loops).toBeNull();
    expect(n.neverExecuted).toBe(false);
  }
  expect(plan.planningMs).toBeNull();
  expect(plan.executionMs).toBeNull();
  expect(plan.slowest).toBeNull();
});

test("costs_off_and_timing_off", () => {
  const plan = parsePlan([
    "Nested Loop (actual rows=1.00 loops=1)",
    "  ->  Seq Scan on a (actual rows=1.00 loops=1)",
    "  ->  Index Scan using b_pkey on b (actual rows=1.00 loops=1)",
    "        Index Cond: (id = a.id)",
  ])!;
  expect(plan.nodes.map((n) => n.label)).toEqual([
    "Nested Loop",
    "Seq Scan on a",
    "Index Scan using b_pkey on b",
  ]);
  expect(plan.nodes[0].actualRows).toBe(1);
  expect(plan.nodes[0].loops).toBe(1);
  expect(plan.nodes[0].estimatedRows).toBeNull();
  expect(plan.nodes[0].totalMs).toBeNull();
  expect(plan.slowest).toBeNull();
});

test("costs_off_without_analyze_is_labels_only", () => {
  const plan = parsePlan([
    "Hash Join",
    "  Hash Cond: (o.user_id = u.id)",
    "  ->  Seq Scan on orders o",
    "  ->  Hash",
    "        ->  Seq Scan on users u",
  ])!;
  expect(plan.nodes.map((n) => [n.depth, n.label])).toEqual([
    [0, "Hash Join"],
    [1, "Seq Scan on orders o"],
    [1, "Hash"],
    [2, "Seq Scan on users u"],
  ]);
});

test("json_format_is_not_a_plan", () => {
  expect(
    parsePlan(['[{"Plan": {"Node Type": "Seq Scan", "Total Cost": 1.0}}]']),
  ).toBeNull();
  expect(
    parsePlan([
      "[",
      '  {"Plan": {',
      '    "Node Type": "Seq Scan"',
      "  }}",
      "]",
    ]),
  ).toBeNull();
  expect(parsePlan(["- Plan:", '    Node Type: "Seq Scan"'])).toBeNull();
  expect(parsePlan([])).toBeNull();
});

function col(name: string): ResultColumn {
  return { name, typeOid: 25, typeModifier: -1 };
}

test("is_plan_result_needs_exactly_the_query_plan_column", () => {
  expect(isPlanResult([col("QUERY PLAN")])).toBe(true);
  expect(isPlanResult([col("QUERY PLAN"), col("x")])).toBe(false);
  expect(isPlanResult([col("query plan")])).toBe(false);
  expect(isPlanResult([])).toBe(false);
  expect(isPlanResult(null)).toBe(false);
});
