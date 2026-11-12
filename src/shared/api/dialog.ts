import { ask, open } from "@tauri-apps/plugin-dialog";

/** 폴더 선택 dialog. 취소하면 null이다. */
export async function pickDirectory(): Promise<string | null> {
  return open({ directory: true, multiple: false });
}

export async function confirm(message: string): Promise<boolean> {
  return ask(message, { kind: "warning" });
}
