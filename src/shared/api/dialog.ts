import { ask, open } from "@tauri-apps/plugin-dialog";

/** 폴더 선택 dialog. 취소하면 null이다. */
export async function pickDirectory(): Promise<string | null> {
  return open({ directory: true, multiple: false });
}

/** 파일 하나를 고르는 dialog. `extensions`의 파일만 보인다. 취소하면 null이다. */
export async function pickFile(extensions: string[]): Promise<string | null> {
  return open({
    directory: false,
    multiple: false,
    filters: [{ name: extensions.join(", "), extensions }],
  });
}

export async function confirm(message: string): Promise<boolean> {
  return ask(message, { kind: "warning" });
}
