import { defineConfig, devices } from "@playwright/test";

// E2E: ブラウザ（CheerpJ）でしか起きないエンジンの停止を確かめる（e2e/engine-stall.spec.ts、design/forge-overlay.md）。
// 画面の動きは実際に操作して確かめるので、ここでは扱わない。Forge を更新したときに流す。
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
  webServer: { command: "npm run dev", url: "http://localhost:5173", reuseExistingServer: true, timeout: 60_000 },
});
