import { create } from "zustand";
import { loadSettings } from "../../shared/api/commands";
import { messageOf } from "../../shared/api/errors";
import { setLanguage, type Language } from "../../shared/i18n/t";

/** 시작할 때 알릴 오류. 제목은 어디의 오류인지에 따라 다르다. */
export interface SettingsError {
  title: "settings.errorTitle" | "settings.storeErrorTitle";
  /** Rust가 보낸 이유 그대로. 설정 파일의 오류는 여러 줄일 수 있다. */
  reason: string;
}

export interface SettingsState {
  status: "loading" | "ready";
  language: Language;
  editor: { font: string; fontSize: number };
  idleTimeoutSecs: number;
  /** 설정 파일이나 앱 저장소의 오류. 첫 화면이 한 번 보이고 지운다. */
  errors: SettingsError[];
  /** 설정을 읽고 그 언어를 `t`에 고른 뒤 "ready"가 된다. */
  load(): Promise<void>;
  dismissErrors(): void;
}

export const useSettings = create<SettingsState>()((set) => ({
  status: "loading",
  language: "en",
  editor: { font: "D2Coding", fontSize: 15 },
  idleTimeoutSecs: 600,
  errors: [],

  async load() {
    try {
      const settings = await loadSettings();
      const errors: SettingsError[] = [];
      if (settings.error !== null)
        errors.push({ title: "settings.errorTitle", reason: settings.error });
      if (settings.storeError !== null)
        errors.push({
          title: "settings.storeErrorTitle",
          reason: settings.storeError,
        });
      setLanguage(settings.language);
      set({
        status: "ready",
        language: settings.language,
        editor: settings.editor,
        idleTimeoutSecs: settings.idleTimeoutSecs,
        errors,
      });
    } catch (error) {
      // 설정을 받지 못해도 기본값으로 시작한다.
      set({
        status: "ready",
        errors: [{ title: "settings.errorTitle", reason: messageOf(error) }],
      });
    }
  },

  dismissErrors() {
    set({ errors: [] });
  },
}));
