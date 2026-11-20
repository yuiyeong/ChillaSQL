import { create } from "zustand";

/** 값을 묻고 있는 `:name`들. `values`는 입력란의 처음 값(앞에 쓴 값, 없으면 빈 text)이다. */
export interface ParameterRequest {
  /** 물음마다 다른 번호. dialog가 이것으로 입력란의 state를 새로 시작한다 */
  id: number;
  tabId: string;
  names: string[];
  values: Record<string, string>;
}

export const useParameterPrompt = create<{ request: ParameterRequest | null }>(
  () => ({ request: null }),
);

let nextId = 0;
/** 떠 있는 물음의 답을 기다리는 쪽. 물음은 하나뿐이다. */
let pending: ((values: Record<string, string> | null) => void) | null = null;
/** 탭마다 이름별로 마지막에 쓴 값. 메모리에만 두고 프로젝트를 바꾸면 잊는다. */
let remembered = new Map<string, Record<string, string>>();

/** 값을 묻는다. Cancel이면 null. 이미 떠 있으면 앞의 것을 null로 끝낸다. */
export function askParameters(
  tabId: string,
  names: string[],
): Promise<Record<string, string> | null> {
  answerParameters(null);
  const before = remembered.get(tabId) ?? {};
  const values = Object.fromEntries(
    names.map((name) => [name, before[name] ?? ""]),
  );
  return new Promise((resolve) => {
    pending = resolve;
    useParameterPrompt.setState({
      request: { id: nextId++, tabId, names, values },
    });
  });
}

/** 떠 있는 물음에 답한다. null이면 Cancel이다. 물음이 없으면 아무것도 하지 않는다. */
export function answerParameters(values: Record<string, string> | null): void {
  const { request } = useParameterPrompt.getState();
  const resolve = pending;
  pending = null;
  useParameterPrompt.setState({ request: null });
  if (request !== null && values !== null) {
    remembered.set(request.tabId, {
      ...remembered.get(request.tabId),
      ...values,
    });
  }
  resolve?.(values);
}

/** 그 탭의 물음이 떠 있으면 Cancel로 끝낸다. 다른 탭의 물음은 그대로 둔다. */
export function cancelParameterPrompt(tabId: string): void {
  if (useParameterPrompt.getState().request?.tabId === tabId) {
    answerParameters(null);
  }
}

export function isParameterPromptOpen(): boolean {
  return useParameterPrompt.getState().request !== null;
}

/** 프로젝트를 바꿀 때. 떠 있는 물음은 Cancel로 끝내고 기억한 값도 잊는다. */
export function resetParameterPrompt(): void {
  answerParameters(null);
  remembered = new Map();
}
