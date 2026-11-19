import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { vi } from "vitest";
import {
  resolveDialog,
  useDialogs,
  type DialogSpec,
} from "../shared/ui/dialogs";

/** node가 그려 내는 글자. 굵은 이름이나 code 표시는 풀어서 문장만 남긴다. */
export function textOf(node: ReactNode): string {
  const holder = document.createElement("div");
  holder.innerHTML = renderToStaticMarkup(node);
  return holder.textContent ?? "";
}

/** 지금 떠 있는 dialog를 기다려 `id` action으로 답하고, 그 dialog의 spec을 돌려준다. */
export async function answerDialog(id: string): Promise<DialogSpec> {
  await vi.waitFor(() => {
    if (useDialogs.getState().current === null) throw new Error("no dialog");
  });
  const spec = useDialogs.getState().current as DialogSpec;
  resolveDialog(id);
  return spec;
}
