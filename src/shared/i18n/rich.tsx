import { Fragment, type ReactNode } from "react";
import type { MessageKey } from "./en";
import { template } from "./t";

/**
 * 문구의 `{name}`을 넘긴 node로 바꾼다(굵은 이름, code 같은 inline 요소를 문장 안에 넣을 때 쓴다).
 * 없는 param은 `{name}` 그대로 둔다.
 */
export function rt(
  key: MessageKey,
  params: Record<string, ReactNode>,
): ReactNode {
  // 홀수 자리가 placeholder의 이름이다.
  return template(key)
    .split(/\{(\w+)\}/)
    .map((part, index) => {
      if (index % 2 === 0) return part;
      return part in params ? (
        <Fragment key={index}>{params[part]}</Fragment>
      ) : (
        `{${part}}`
      );
    });
}

/** 본문 안에서 이름을 fg로 굵게 보인다. */
export function bold(text: string): ReactNode {
  return <b className="text-fg font-semibold">{text}</b>;
}

/** 제목 안의 파일 이름이나 경로. 글자 크기는 제목보다 한 단계 작다. */
export function mono(text: string): ReactNode {
  return <span className="text-body font-mono">{text}</span>;
}

/** 둘레의 글자 크기 그대로 D2Coding으로 보인다(목록의 경과 시간). */
export function monoText(text: string): ReactNode {
  return <span className="font-mono">{text}</span>;
}

/** 본문 안의 SQL 조각(D2Coding). keyword는 SQL keyword 색을 쓴다. */
export function sqlCode(
  text: string,
  { keyword = false }: { keyword?: boolean } = {},
): ReactNode {
  return (
    <code
      className={`bg-bg-3 text-small rounded-[4px] px-1 font-mono ${keyword ? "text-syntax-keyword" : "text-fg"}`}
    >
      {text}
    </code>
  );
}
