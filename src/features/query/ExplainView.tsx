import { useState, type ReactNode } from "react";
import { formatCount, t } from "../../shared/i18n/t";
import { Button } from "../../shared/ui/Button";
import { formatElapsed } from "./format";
import type { Plan, PlanNode } from "./explainPlan";
import { ResultBar, SingleTab } from "./ResultBar";

/** 표의 열. 시간, 행, loops 칸은 고정 너비다. */
const GRID = "minmax(0,1fr) 90px 120px 60px";
/** node 하나가 한 단계 깊어질 때 들여쓰는 너비와 뿌리의 왼쪽 padding(px) */
const INDENT = 16;
const BASE_PADDING = 10;
/** 시간, 행, loops 칸. 오른쪽에 붙인다 */
const NUMBER_CELL =
  "flex items-center justify-end overflow-hidden px-2.5 whitespace-nowrap";

/** `Execution 41 ms · Planning 0.40 ms`. 없는 값은 뺀다. 둘 다 없으면 null이다. */
function timingsOf(plan: Plan): string | null {
  const execution =
    plan.executionMs === null ? null : formatElapsed(plan.executionMs * 1000);
  const planning =
    plan.planningMs === null ? null : formatElapsed(plan.planningMs * 1000);
  if (execution !== null && planning !== null) {
    return t("explain.timings", { execution, planning });
  }
  if (execution !== null) return t("explain.timingsExecution", { execution });
  if (planning !== null) return t("explain.timingsPlanning", { planning });
  return null;
}

/** 행 수. 정수는 1000 단위로 묶고, 소수(루프 한 번의 평균)는 있는 그대로 보인다. */
function countOf(n: number): string {
  return Number.isInteger(n) ? formatCount(n) : String(n);
}

/** `1,200 → 98,410`. 한쪽만 있으면(ANALYZE가 없거나 실행하지 않은 node) 있는 쪽만 보인다. */
function rowsOf(node: PlanNode): string {
  const parts = [node.estimatedRows, node.actualRows]
    .filter((n): n is number => n !== null)
    .map(countOf);
  return parts.join(" → ");
}

function PlanRow({ node, slowest }: { node: PlanNode; slowest: boolean }) {
  return (
    <div
      role="row"
      className={`border-bg-2 text-small grid h-7 shrink-0 border-b font-mono ${
        slowest ? "bg-bg-1 font-semibold" : ""
      }`}
      style={{ gridTemplateColumns: GRID }}
    >
      <div
        role="cell"
        className="flex items-center overflow-hidden pr-2.5 whitespace-nowrap"
        style={{ paddingLeft: BASE_PADDING + node.depth * INDENT }}
      >
        <span className="truncate">{node.label}</span>
      </div>
      <div
        role="cell"
        className={`${NUMBER_CELL} ${node.neverExecuted ? "text-fg-3" : ""}`}
      >
        {node.neverExecuted
          ? t("explain.neverExecuted")
          : node.totalMs === null
            ? ""
            : formatElapsed(node.totalMs * 1000)}
      </div>
      <div role="cell" className={NUMBER_CELL}>
        {rowsOf(node)}
      </div>
      <div role="cell" className={NUMBER_CELL}>
        {node.loops === null ? "" : formatCount(node.loops)}
      </div>
    </div>
  );
}

/**
 * EXPLAIN의 text 출력을 tree로 그린 결과 panel. header(결과 탭, 시간, Show raw)와 본문을 모두 그린다.
 * `tabs`가 없으면 `EXPLAIN` 탭 하나를 그린다(여러 문장의 실행이면 문장마다의 결과 탭을 받는다).
 * raw와 tree 가운데 무엇을 보이는지는 이 component의 state라서 다른 실행의 결과로 바뀌면 호출한 쪽이
 * key를 바꿔 되돌린다.
 */
export function ExplainView({
  tabs,
  plan,
  lines,
}: {
  tabs: ReactNode;
  plan: Plan;
  /** 서버가 준 출력의 줄 */
  lines: string[];
}) {
  const [raw, setRaw] = useState(false);
  const timings = timingsOf(plan);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ResultBar>
        {tabs ?? <SingleTab>{t("explain.tab")}</SingleTab>}
        {timings !== null && (
          <span className="text-small text-fg-2 font-mono">{timings}</span>
        )}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="small"
          onClick={() => setRaw((value) => !value)}
        >
          {raw ? t("explain.showTree") : t("explain.showRaw")}
        </Button>
      </ResultBar>
      {raw ? (
        <pre
          data-testid="explain-raw"
          className="text-small bg-bg-1 m-0 min-h-0 flex-1 overflow-auto p-3 font-mono leading-[1.6] whitespace-pre"
        >
          {lines.join("\n")}
        </pre>
      ) : (
        <div
          role="table"
          className="flex min-h-0 flex-1 flex-col overflow-auto"
        >
          <div role="rowgroup">
            <div
              role="row"
              className="border-line-1 text-small text-fg-2 grid h-7 shrink-0 border-b"
              style={{ gridTemplateColumns: GRID }}
            >
              <div role="columnheader" className="flex items-center px-2.5">
                {t("explain.node")}
              </div>
              {(
                ["explain.actualTime", "explain.rows", "explain.loops"] as const
              ).map((key) => (
                <div
                  key={key}
                  role="columnheader"
                  className="flex items-center justify-end px-2.5"
                >
                  {t(key)}
                </div>
              ))}
            </div>
          </div>
          <div role="rowgroup">
            {plan.nodes.map((node, index) => (
              <PlanRow
                key={index}
                node={node}
                slowest={index === plan.slowest}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
