import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

const tauriMessage = "Tauri API는 src/shared/api 안에서만 import한다";

export default defineConfig(
  {
    ignores: ["dist", "target", "src-tauri/gen", ".superpowers"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/shared/api/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [{ group: ["@tauri-apps/*"], message: tauriMessage }],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^@tauri-apps\\//]",
          message: tauriMessage,
        },
      ],
    },
  },
  prettier,
);
