import { defineConfig, devices } from "@playwright/test";

// E2E: 同梱のサンプル問題を、解答手順（*.solution.json）どおりに画面を操作して解く。
// エンジン（CheerpJ）の初回の準備に数秒〜十数秒かかるので、時間は長めにとる。
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure" },
  projects: [
    { name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"], channel: "chrome" } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: { command: "npm run dev", url: "http://localhost:5173", reuseExistingServer: true, timeout: 60_000 },
});
