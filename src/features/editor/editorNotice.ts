import { create } from "zustand";
import { TOAST_MS } from "../../shared/ui/Toast";

/** 에디터 자리에 잠깐 보이는 알림. command가 React 밖에서 띄우므로 store에 둔다. */
export const useEditorNotice = create<{ message: string | null }>()(() => ({
  message: null,
}));

let timer: ReturnType<typeof setTimeout> | undefined;

/** `TOAST_MS` 동안 보인다. 다시 부르면 새로 잰다. */
export function showEditorNotice(message: string): void {
  clearTimeout(timer);
  useEditorNotice.setState({ message });
  timer = setTimeout(
    () => useEditorNotice.setState({ message: null }),
    TOAST_MS,
  );
}

export function resetEditorNotice(): void {
  clearTimeout(timer);
  useEditorNotice.setState({ message: null });
}
