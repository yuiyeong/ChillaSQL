import { act, fireEvent } from "@testing-library/react";

/** 클릭하고, 그 handler가 시작한 promise가 한 번 돌 때까지 기다린다. */
export async function click(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}
