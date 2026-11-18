import { homeDir as tauriHomeDir } from "@tauri-apps/api/path";

let home: Promise<string> | null = null;

/**
 * 사용자의 home 디렉토리. sidebar가 프로젝트 경로를 `~`로 줄이는 데 쓴다.
 * 앱이 떠 있는 동안 바뀌지 않으므로 처음 한 번만 묻는다. 묻지 못했으면 다음에 다시 묻는다.
 */
export function homeDir(): Promise<string> {
  home ??= tauriHomeDir().catch((error: unknown) => {
    home = null;
    throw error;
  });
  return home;
}
