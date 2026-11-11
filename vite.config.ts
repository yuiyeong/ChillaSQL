import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  // tauri dev에서 Vite가 화면을 지워 Rust error를 가리지 않게 한다.
  clearScreen: false,

  plugins: [react(), tailwindcss()],

  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },

  // Tauri는 고정 port를 기대하므로 port를 쓸 수 없으면 실패한다.
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"] },
  },
});
