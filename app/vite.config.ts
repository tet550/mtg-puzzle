import { defineConfig } from "vitest/config";

// エンジン（CheerpJ + forge-adapter の jar）は public/engine/ に置き、Vite の変換対象にしない。
// CheerpJ は jar を Range リクエストで部分的に読む。
// GitHub Pages（/<repo>/）でもルート配信（/）でもそのまま動くよう既定の base は "./" にする（環境変数 BASE_PATH で上書き可能）。
export default defineConfig({
  base: process.env.BASE_PATH || "./",
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: { target: "es2022" },
  // e2e/ は Playwright のテスト（npm run e2e）
  test: { include: ["src/**/*.test.ts"] },
});
