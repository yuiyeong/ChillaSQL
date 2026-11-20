import { createElement, Fragment, type ReactNode } from "react";
import { inspectStatement } from "../../shared/api/commands";
import type { Danger } from "../../shared/api/types";
import { bold, rt, sqlCode } from "../../shared/i18n/rich";
import { t } from "../../shared/i18n/t";
import { ask, type DialogSpec } from "../../shared/ui/dialogs";
import { modeOf, useTabs } from "../editor/tabsStore";
import { useRuns } from "../query/runsStore";

function keyword(text: string): ReactNode {
  return sqlCode(text, { keyword: true });
}

/** 여러 이름을 `, `로 이어 각각 code로 보인다. */
function names(list: string[]): ReactNode {
  return list.map((name, index) =>
    createElement(
      Fragment,
      { key: index },
      index === 0 ? "" : ", ",
      sqlCode(name),
    ),
  );
}

function titleOf(danger: Danger): ReactNode {
  switch (danger.kind) {
    case "delete_without_where":
    case "update_without_where":
      return rt("dialog.danger.title.withoutWhere", {
        verb: keyword(
          danger.kind === "delete_without_where" ? "DELETE" : "UPDATE",
        ),
        where: keyword("WHERE"),
      });
    case "drop":
      return rt("dialog.danger.title.drop", {
        drop: keyword(danger.object === "" ? "DROP" : `DROP ${danger.object}`),
      });
    case "truncate":
      return rt("dialog.danger.title.truncate", {
        truncate: keyword("TRUNCATE"),
      });
  }
}

function firstSentence(danger: Danger, connection: string): ReactNode {
  const on = bold(connection);
  switch (danger.kind) {
    case "delete_without_where":
    case "truncate":
      // TRUNCATE도 모든 행을 지운다는 같은 문장이다.
      return rt("dialog.danger.first.delete", {
        tables: names(
          danger.kind === "truncate" ? danger.tables : [danger.table],
        ),
        connection: on,
      });
    case "update_without_where":
      return rt("dialog.danger.first.update", {
        tables: names([danger.table]),
        connection: on,
      });
    case "drop":
      // `DROP OWNED BY`의 이름은 지울 object가 아니라 그것을 가진 role이다.
      return rt(
        danger.object === "OWNED"
          ? "dialog.danger.first.dropOwned"
          : "dialog.danger.first.drop",
        {
          names: names(danger.names),
          connection: on,
        },
      );
  }
}

/** 위험한지 살펴볼 문장과 그것을 보낼 접속 */
interface DangerRequest {
  connection: string;
  sql: string;
}

/** Manual이거나 트랜잭션이 열려 있으면 Rollback할 수 있고, Auto이고 트랜잭션 밖이면 바로 Commit된다. */
function secondSentence(tabId: string): ReactNode {
  const reversible =
    modeOf(useTabs.getState(), tabId) === "manual" ||
    useRuns.getState().transactions[tabId] !== undefined;
  return reversible
    ? t("dialog.danger.second.reversible")
    : rt("dialog.danger.second.final", {
        emphasis: bold(t("dialog.danger.second.final.emphasis")),
      });
}

function specOf(
  tabId: string,
  request: DangerRequest,
  danger: Danger,
): DialogSpec {
  return {
    icon: "warning",
    title: titleOf(danger),
    body: rt("dialog.danger.body", {
      first: firstSentence(danger, request.connection),
      second: secondSentence(tabId),
    }),
    sql: request.sql,
    actions: [
      { id: "cancel", label: t("common.cancel") },
      { id: "run", label: t("dialog.danger.run"), variant: "danger" },
    ],
  };
}

/**
 * 실행하기 전에 위험한 문장(WHERE 없는 UPDATE와 DELETE, DROP, TRUNCATE)이면 묻는다. 위험하지
 * 않거나 Run을 고르면 true. 문장을 살펴보지 못하면 묻지 않고 true다(서버가 판단한다).
 * 여러 문장의 실행은 문장마다 그 차례에 부른다.
 */
export async function confirmDanger(
  tabId: string,
  request: DangerRequest,
): Promise<boolean> {
  let danger: Danger | null;
  try {
    danger = await inspectStatement(request.sql);
  } catch {
    return true;
  }
  if (!danger) return true;
  return (await ask(specOf(tabId, request, danger))) === "run";
}
