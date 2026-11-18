import { beforeEach, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn() }));

import { homeDir as tauriHomeDir } from "@tauri-apps/api/path";

// homeDir는 결과를 module에 둔다. test마다 module을 새로 읽는다.
async function freshHomeDir() {
  vi.resetModules();
  return (await import("./path")).homeDir;
}

beforeEach(() => {
  vi.mocked(tauriHomeDir).mockReset();
});

test("homeDir는 한 번만 묻는다", async () => {
  vi.mocked(tauriHomeDir).mockResolvedValue("/Users/jo");
  const homeDir = await freshHomeDir();

  expect(await homeDir()).toBe("/Users/jo");
  expect(await homeDir()).toBe("/Users/jo");
  expect(tauriHomeDir).toHaveBeenCalledTimes(1);
});

test("묻지 못했으면 다음에 다시 묻는다", async () => {
  vi.mocked(tauriHomeDir)
    .mockRejectedValueOnce(new Error("no home"))
    .mockResolvedValueOnce("/Users/jo");
  const homeDir = await freshHomeDir();

  await expect(homeDir()).rejects.toThrow("no home");
  expect(await homeDir()).toBe("/Users/jo");
  expect(tauriHomeDir).toHaveBeenCalledTimes(2);
});
