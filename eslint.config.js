import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

const invokeMessage = "Tauri invoke는 src/shared/api 안에서만 호출한다";

export default tseslint.config(
  {
    ignores: ["dist", "target", "src-tauri/gen", ".superpowers"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["*.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/shared/api/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "@tauri-apps/api/core", message: invokeMessage }],
        },
      ],
    },
  },
  prettier,
);
