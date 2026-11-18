import { homeDir as tauriHomeDir } from "@tauri-apps/api/path";

/** 사용자의 home 디렉토리. sidebar가 프로젝트 경로를 `~`로 줄이는 데 쓴다. */
export async function homeDir(): Promise<string> {
  return tauriHomeDir();
}
