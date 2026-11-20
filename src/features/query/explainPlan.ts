import type { ResultColumn } from "../../shared/api/types";

/** EXPLAIN text 출력의 node 하나. 화면에는 깊이만큼 들여 쓴 목록으로 그린다. */
export interface PlanNode {
  /** `Seq Scan on orders` */
  label: string;
  /** 뿌리가 0 */
  depth: number;
  estimatedRows: number | null;
  /** PostgreSQL 18부터는 `50.00`처럼 소수다. */
  actualRows: number | null;
  /** `actual time`의 끝 값 × loops */
  totalMs: number | null;
  /** `totalMs`에서 자식 `totalMs`의 합을 뺀 값. 0 미만이면 0 */
  selfMs: number | null;
  loops: number | null;
  neverExecuted: boolean;
}

export interface Plan {
  nodes: PlanNode[];
  planningMs: number | null;
  executionMs: number | null;
  /** `selfMs`가 가장 큰 node의 index. 시간을 잰 node가 없으면 null */
  slowest: number | null;
}

/** label 뒤에 오는 첫 괄호. COSTS OFF에서는 공백이 하나만 온다. */
const STATS_START = /\s+\((?:cost=|actual |never executed\))/;
const ARROW = /^(\s*)->\s+(.*)$/;
const ESTIMATED_ROWS = /\(cost=[^)]*?\brows=(\d+(?:\.\d+)?)/;
const ACTUAL =
  /\(actual (?:time=[\d.]+\.\.([\d.]+) )?rows=(\d+(?:\.\d+)?) loops=(\d+)\)/;
const NEVER_EXECUTED = /\(never executed\)/;
/** 첫 줄에 괄호가 없을 때(`COSTS OFF`) label로 인정하는 모양. JSON, YAML, XML을 거른다. */
const BARE_LABEL = /^[A-Za-z][^:]*$/;

/** 결과가 EXPLAIN의 text 출력인지(컬럼이 `QUERY PLAN` 하나) 본다. */
export function isPlanResult(columns: ResultColumn[] | null): boolean {
  return (
    columns !== null && columns.length === 1 && columns[0].name === "QUERY PLAN"
  );
}

function parseNode(text: string, depth: number): PlanNode {
  const label = text.split(STATS_START)[0].trim();
  const estimated = ESTIMATED_ROWS.exec(text);
  const neverExecuted = NEVER_EXECUTED.test(text);
  const actual = ACTUAL.exec(text);
  const loops = actual ? Number(actual[3]) : null;
  return {
    label,
    depth,
    estimatedRows: estimated ? Number(estimated[1]) : null,
    actualRows: actual ? Number(actual[2]) : null,
    // actual time은 loop 한 번의 평균이라 loops를 곱해야 node가 쓴 전체 시간이 된다.
    totalMs:
      actual?.[1] !== undefined ? Number(actual[1]) * (loops ?? 1) : null,
    selfMs: null,
    loops,
    neverExecuted,
  };
}

function millis(line: string, prefix: string): number | null {
  if (!line.startsWith(prefix)) return null;
  const value = Number.parseFloat(line.slice(prefix.length));
  return Number.isNaN(value) ? null : value;
}

/**
 * text 출력을 한 줄씩 받아 node 목록으로 바꾼다. node 줄이 없으면 null이다.
 *
 * 뿌리는 `->` 없는 첫 node 줄이고 자식은 `->`로 시작하는 줄이다. 부모는 `->`의 열 위치로 정한다.
 * 그래서 `InitPlan 1`, `SubPlan 1` 줄은 node가 아니고, 그 아래 `->` node는 위 node의 자식이 된다.
 * 나머지 줄은 detail이라 `Planning Time:`과 `Execution Time:`만 읽는다.
 */
export function parsePlan(lines: string[]): Plan | null {
  const nodes: PlanNode[] = [];
  const parents: (number | null)[] = [];
  /** 열린 node의 `->` 열. 뿌리는 -1이라 pop되지 않는다. */
  const stack: { column: number; index: number }[] = [];
  let planningMs: number | null = null;
  let executionMs: number | null = null;

  lines.forEach((line, i) => {
    planningMs ??= millis(line, "Planning Time: ");
    executionMs ??= millis(line, "Execution Time: ");

    const arrow = ARROW.exec(line);
    if (arrow) {
      if (nodes.length === 0) return;
      const column = arrow[1].length;
      while (stack.length > 0 && stack[stack.length - 1].column >= column)
        stack.pop();
      parents.push(stack.length > 0 ? stack[stack.length - 1].index : null);
      nodes.push(parseNode(arrow[2], stack.length));
      stack.push({ column, index: nodes.length - 1 });
      return;
    }
    if (nodes.length > 0) return;
    if (STATS_START.test(line) || (i === 0 && BARE_LABEL.test(line))) {
      parents.push(null);
      nodes.push(parseNode(line, 0));
      stack.push({ column: -1, index: 0 });
    }
  });

  if (nodes.length === 0) return null;

  const childMs = new Array<number>(nodes.length).fill(0);
  parents.forEach((parent, index) => {
    if (parent !== null) childMs[parent] += nodes[index].totalMs ?? 0;
  });
  let slowest: number | null = null;
  nodes.forEach((node, index) => {
    if (node.totalMs === null) return;
    node.selfMs = Math.max(0, node.totalMs - childMs[index]);
    if (slowest === null || node.selfMs > (nodes[slowest].selfMs ?? 0))
      slowest = index;
  });

  return { nodes, planningMs, executionMs, slowest };
}
