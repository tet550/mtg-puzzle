import { defineConfig } from "vitest/config";

// エンジン（CheerpJ + forge-adapter の jar）は public/engine/ に置き、Vite の変換対象にしない。
// CheerpJ は jar を Range リクエストで部分的に読む。
export default defineConfig({
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: { target: "es2022" },
  // e2e/ は Playwright のテスト（npm run e2e）
  test: { include: ["src/**/*.test.ts"] },
});
