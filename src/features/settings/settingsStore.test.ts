import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import { loadSettings } from "../../shared/api/commands";
import { setLanguage, t } from "../../shared/i18n/t";
import { settingsFixture } from "../../test/fixtures";
import { useSettings } from "./settingsStore";

beforeEach(() => {
  vi.resetAllMocks();
  useSettings.setState(useSettings.getInitialState(), true);
});

afterEach(() => setLanguage("en"));

test("load sets the language", async () => {
  vi.mocked(loadSettings).mockResolvedValue(
    settingsFixture({
      language: "ko",
      editor: { font: "Menlo", fontSize: 13 },
      idleTimeoutSecs: 120,
    }),
  );
  expect(useSettings.getState().status).toBe("loading");

  await useSettings.getState().load();

  const state = useSettings.getState();
  expect(state.status).toBe("ready");
  expect(state.language).toBe("ko");
  expect(state.editor).toEqual({ font: "Menlo", fontSize: 13 });
  expect(state.idleTimeoutSecs).toBe(120);
  expect(state.errors).toEqual([]);
  expect(t("common.cancel")).toBe("취소");
});

test("settings error is shown once", async () => {
  vi.mocked(loadSettings).mockResolvedValue(
    settingsFixture({
      error: "/Users/jo/.config/chilla/config.toml: bad",
      storeError: "database is locked",
    }),
  );

  await useSettings.getState().load();

  expect(useSettings.getState().errors).toEqual([
    {
      title: "settings.errorTitle",
      reason: "/Users/jo/.config/chilla/config.toml: bad",
    },
    { title: "settings.storeErrorTitle", reason: "database is locked" },
  ]);

  useSettings.getState().dismissErrors();

  expect(useSettings.getState().errors).toEqual([]);
});

test("a failed load starts with the defaults", async () => {
  vi.mocked(loadSettings).mockRejectedValue(new Error("no backend"));

  await useSettings.getState().load();

  const state = useSettings.getState();
  expect(state.status).toBe("ready");
  expect(state.language).toBe("en");
  expect(state.errors).toEqual([
    { title: "settings.errorTitle", reason: "no backend" },
  ]);
});
