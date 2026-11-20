import { createStore, type StoreApi } from "zustand/vanilla";

const TOAST_MS = 2000;

export interface ToastStore {
  store: StoreApi<{ message: string | null }>;
  /** `TOAST_MS` 동안 message가 있다. 다시 부르면 새로 잰다. */
  show(message: string): void;
  /** message를 지우고 재던 시간을 멈춘다. */
  reset(): void;
}

/** 잠깐 보이는 알림의 상태와 시간. React 밖(command)에서도 띄울 수 있다. */
export function createToastStore(): ToastStore {
  const store = createStore<{ message: string | null }>(() => ({
    message: null,
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    store,
    show(message) {
      clearTimeout(timer);
      store.setState({ message });
      timer = setTimeout(() => store.setState({ message: null }), TOAST_MS);
    },
    reset() {
      clearTimeout(timer);
      store.setState({ message: null });
    },
  };
}
