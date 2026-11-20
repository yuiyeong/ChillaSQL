import { createToastStore } from "../../shared/ui/toastStore";

/** 에디터 자리에 잠깐 보이는 알림. command가 React 밖에서 띄우므로 React 밖의 store를 쓴다. */
export const editorNotice = createToastStore();
