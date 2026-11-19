import type { ReactNode } from "react";
import { create } from "zustand";

export interface DialogAction {
  /** "cancel"은 Escape와 같다 */
  id: string;
  label: string;
  variant?: "secondary" | "primary" | "danger" | "ghost";
  /** 이 버튼 앞에서 빈 자리를 벌려, 앞의 버튼은 왼쪽에 두고 이 버튼부터 오른쪽에 붙인다 */
  spaceBefore?: boolean;
}

export interface DialogItem {
  /** 줄 맨 앞의 표시(접속 색 dot) */
  marker?: ReactNode;
  primary: string;
  secondary: ReactNode;
}

export interface DialogSpec {
  title: ReactNode;
  body?: ReactNode;
  /** D2Coding pre 한 덩어리(위험 쿼리의 문장). 8줄을 넘으면 그 안에서 scroll */
  sql?: string;
  /** 탭이나 파일 목록(앱 종료, 프로젝트 바꾸기) */
  items?: DialogItem[];
  /** 목록 아래의 덧붙임 */
  note?: ReactNode;
  /** 제목 왼쪽의 32px icon. 위험 쿼리는 warning, 열린 트랜잭션은 clock */
  icon?: "warning" | "clock";
  /** 왼쪽부터. "cancel"이 반드시 하나 있다 */
  actions: DialogAction[];
}

interface Pending {
  spec: DialogSpec;
  resolve(id: string): void;
}

/** 화면에 보이는 dialog. 대기 중인 ask는 module 안의 queue에 있다. */
export const useDialogs = create<{ current: DialogSpec | null }>(() => ({
  current: null,
}));

let active: Pending | null = null;
let waiting: Pending[] = [];

function showNext(): void {
  active = waiting.shift() ?? null;
  useDialogs.setState({ current: active?.spec ?? null });
}

/** dialog를 띄우고 사용자가 누른 action의 id를 돌려준다. 이미 하나가 떠 있으면 그 답 뒤에 보인다. */
export function ask(spec: DialogSpec): Promise<string> {
  return new Promise((resolve) => {
    waiting.push({ spec, resolve });
    if (active === null) showNext();
  });
}

/** 지금 떠 있는 dialog에 `id`로 답하고 다음 차례를 보인다. 떠 있는 dialog가 없으면 아무것도 하지 않는다. */
export function resolveDialog(id: string): void {
  const answered = active;
  if (answered === null) return;
  showNext();
  answered.resolve(id);
}

export function isDialogOpen(): boolean {
  return useDialogs.getState().current !== null;
}

/** 떠 있거나 기다리는 dialog를 모두 "cancel"로 끝내고 비운다. test가 store를 처음 상태로 돌릴 때 쓴다. */
export function resetDialogs(): void {
  const pending = active === null ? waiting : [active, ...waiting];
  active = null;
  waiting = [];
  useDialogs.setState({ current: null });
  for (const { resolve } of pending) resolve("cancel");
}
