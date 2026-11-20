import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../../shared/api/commands");

import { loadSettings } from "../../shared/api/commands";
import { setLanguage, t } from "../../shared/i18n/t";
import { settingsFixture } from "../../test/fixtures";
import {
  commandFor,
  DEFAULT_KEYMAP,
  setKeymap,
  shortcutLabel,
} from "../workspace/shortcuts";
import {
  DEFAULT_EDITOR,
  DEFAULT_IDLE_TIMEOUT_SECS,
  useSettings,
} from "./settingsStore";

beforeEach(() => {
  vi.resetAllMocks();
  useSettings.setState(useSettings.getInitialState(), true);
});

afterEach(() => {
  setLanguage("en");
  setKeymap(DEFAULT_KEYMAP);
});

const shiftCmdF = new KeyboardEvent("keydown", {
  code: "KeyF",
  metaKey: true,
  shiftKey: true,
});
const cmdEnter = new KeyboardEvent("keydown", { code: "Enter", metaKey: true });

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
  expect(state.storeAvailable).toBe(true);
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
  expect(useSettings.getState().storeAvailable).toBe(false);

  useSettings.getState().dismissErrors();

  expect(useSettings.getState().errors).toEqual([]);
});

test("a failed load starts with the defaults", async () => {
  vi.mocked(loadSettings).mockRejectedValue(new Error("no backend"));

  await useSettings.getState().load();

  const state = useSettings.getState();
  expect(state.status).toBe("ready");
  expect(state.language).toBe("en");
  expect(state.editor).toEqual(DEFAULT_EDITOR);
  expect(state.idleTimeoutSecs).toBe(DEFAULT_IDLE_TIMEOUT_SECS);
  expect(state.errors).toEqual([
    { title: "settings.errorTitle", reason: "no backend" },
  ]);
});

test("load_applies_the_keymap", async () => {
  vi.mocked(loadSettings).mockResolvedValue(
    settingsFixture({
      shortcuts: [
        ...DEFAULT_KEYMAP.filter((b) => b.command !== "reformat"),
        {
          command: "reformat",
          code: "KeyF",
          shift: true,
          alt: false,
          ctrl: false,
        },
      ],
    }),
  );

  await useSettings.getState().load();

  expect(commandFor(shiftCmdF)).toBe("reformat");
  expect(shortcutLabel("reformat")).toBe("⇧⌘F");
  expect(commandFor(cmdEnter)).toBe("run");
});

test("failed_load_keeps_the_default_keymap", async () => {
  vi.mocked(loadSettings).mockRejectedValue(new Error("no backend"));

  await useSettings.getState().load();

  expect(commandFor(cmdEnter)).toBe("run");
  expect(commandFor(shiftCmdF)).toBeNull();
  expect(shortcutLabel("reformat")).toBe("⌥⌘L");
});
