import { open, save } from "@tauri-apps/plugin-dialog";

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

/** 저장할 경로를 고르는 dialog. 이미 있는 파일이면 dialog가 덮어쓸지 묻는다. 취소하면 null이다. */
export async function pickSavePath(
  defaultPath: string,
  extension: "csv" | "json",
): Promise<string | null> {
  return save({
    defaultPath,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
}
