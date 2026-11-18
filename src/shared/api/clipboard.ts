import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** text를 system clipboard에 넣는다. */
export async function copyText(text: string): Promise<void> {
  await writeText(text);
}
