import { memo, useCallback, useMemo } from "react";
import { copyText } from "../../shared/api/clipboard";
import type { Cell, ResultColumn, TypeInfo } from "../../shared/api/types";
import { formatCount, t } from "../../shared/i18n/t";
import { IconButton } from "../../shared/ui/IconButton";
import { CloseIcon, CopyIcon } from "../../shared/ui/icons";
import { endOfString, SCALAR_END, valueKind, WHITESPACE } from "./cellDisplay";
import { copyCell } from "./grid";

export type JsonTokenKind = "key" | "string" | "number" | "literal" | "punct";
export interface JsonToken {
  text: string;
  kind: JsonTokenKind;
}

/** 이보다 긴 JSON은 들여쓰지 않고 원문으로 보인다. token마다 element를 만들어 큰 값은 화면이 멈춘다. */
const JSON_PRETTY_LIMIT = 1_000_000;

/**
 * JSON을 2칸 들여쓴 token으로 쪼갠다. 값은 원문 그대로 옮겨 숫자 표기와 key 순서가 바뀌지 않는다.
 * 빈 object와 array는 한 줄이다. JSON이 아니면 null이다.
 */
export function jsonTokens(value: string): JsonToken[] | null {
  if (value.length > JSON_PRETTY_LIMIT) return null;
  try {
    JSON.parse(value);
  } catch {
    return null;
  }
  const tokens: JsonToken[] = [];
  const push = (text: string, kind: JsonTokenKind) => {
    tokens.push({ text, kind });
  };
  // 열린 container. 맨 위가 `{`이면 다음 문자열은 key다.
  const open: string[] = [];
  const newline = () => `\n${"  ".repeat(open.length)}`;
  let expectKey = false;
  let i = 0;
  while (i < value.length) {
    const char = value[i];
    if (WHITESPACE.test(char)) {
      i++;
    } else if (char === "{" || char === "[") {
      let next = i + 1;
      while (WHITESPACE.test(value[next])) next++;
      const close = char === "{" ? "}" : "]";
      if (value[next] === close) {
        push(char + close, "punct");
        i = next + 1;
        continue;
      }
      open.push(char);
      push(char + newline(), "punct");
      expectKey = char === "{";
      i++;
    } else if (char === "}" || char === "]") {
      open.pop();
      push(newline() + char, "punct");
      i++;
    } else if (char === ",") {
      push(`,${newline()}`, "punct");
      expectKey = open[open.length - 1] === "{";
      i++;
    } else if (char === ":") {
      push(": ", "punct");
      expectKey = false;
      i++;
    } else if (char === '"') {
      const end = endOfString(value, i);
      push(value.slice(i, end), expectKey ? "key" : "string");
      expectKey = false;
      i = end;
    } else {
      let end = i;
      while (end < value.length && !SCALAR_END.test(value[end])) end++;
      const text = value.slice(i, end);
      push(text, /^-?\d/.test(text) ? "number" : "literal");
      i = end;
    }
  }
  return tokens;
}

const TOKEN_CLASS: Record<JsonTokenKind, string> = {
  key: "text-syntax-function",
  string: "text-syntax-string",
  number: "text-syntax-number",
  literal: "text-syntax-keyword",
  punct: "text-syntax-operator",
};

const BODY =
  "text-small min-h-0 flex-1 overflow-auto p-3 font-mono leading-[1.6]";
const WRAP = "m-0 break-words whitespace-pre-wrap";

/**
 * 결과 표에서 고른 셀의 전체 값을 오른쪽에 보이는 panel. json과 jsonb는 들여쓰고 token마다 색을 칠하고,
 * 나머지는 원문을 줄바꿈해 보인다. `row`는 표의 행 번호처럼 1부터 센다.
 */
export const ValueViewer = memo(function ValueViewer({
  column,
  type,
  row,
  value,
  onClose,
  onCopied,
}: {
  column: ResultColumn;
  /** 아직 모르면 undefined. 머리 줄에 행 번호만 쓴다. */
  type: TypeInfo | undefined;
  row: number;
  value: Cell;
  onClose(): void;
  /** 복사했다는 알림. 복사하지 못하면 부르지 않는다. */
  onCopied(message: string): void;
}) {
  // json과 jsonb가 아니면 값이 JSON 모양이어도 들여쓰지 않으므로 쪼개지도 않는다.
  const isJson = valueKind(type) === "json";
  const tokens = useMemo(
    () => (value === null || !isJson ? null : jsonTokens(value)),
    [value, isJson],
  );
  const pretty = tokens !== null;

  const copy = useCallback(async () => {
    try {
      await copyText(copyCell(value));
    } catch {
      // clipboard를 쓰지 못하면 복사했다고 알리지 않는다.
      return;
    }
    onCopied(t("toast.copiedValue"));
  }, [value, onCopied]);

  const rowText = formatCount(row);
  return (
    <aside
      aria-label={t("viewer.label")}
      className="border-line-1 bg-bg-1 flex w-[340px] shrink-0 flex-col border-l"
    >
      <div className="border-line-1 flex h-9 shrink-0 items-center gap-2 border-b pr-2 pl-3">
        <span className="text-small min-w-0 truncate font-mono font-medium">
          {column.name}
        </span>
        <span className="text-label text-fg-2 shrink-0 font-mono">
          {type === undefined
            ? t("viewer.metaUntyped", { row: rowText })
            : t("viewer.meta", { type: type.name, row: rowText })}
        </span>
        <div className="flex-1" />
        <IconButton label={t("viewer.copy")} onClick={() => void copy()}>
          <CopyIcon />
        </IconButton>
        <IconButton label={t("viewer.close")} onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
      {value === null ? (
        <div data-testid="value-body" className={BODY}>
          <span className="text-fg-3 italic">NULL</span>
        </div>
      ) : pretty ? (
        <pre data-testid="value-body" className={`${BODY} ${WRAP}`}>
          {tokens.map((token, index) => (
            <span key={index} className={TOKEN_CLASS[token.kind]}>
              {token.text}
            </span>
          ))}
        </pre>
      ) : (
        <div
          data-testid="value-body"
          className={`${BODY} ${WRAP} ${value === "" ? "text-fg-3" : ""}`}
        >
          {value === "" ? "''" : value}
        </div>
      )}
    </aside>
  );
});
