// 準備完了・問題の読み込み・1 操作の時間を、通常の Chrome で計測する（Phase 1 M6）。
// 同じプロファイルで N 回開き、1 回目（キャッシュなし）と 2 回目以降（キャッシュあり）を比べる。
// 使い方: node scripts/measure.mjs [URL=http://localhost:5173] [回数=3]
import { chromium } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] || "http://localhost:5173";
const times = Number(process.argv[3] || 3);
const profile = mkdtempSync(join(tmpdir(), "mtgp-measure-"));
const ctx = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true, viewport: { width: 1280, height: 860 } });
const results = [];
try {
  for (let i = 1; i <= times; i++) {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const t0 = Date.now();
    await page.goto(`${base}/?n=${i}#/play/s1-bolt`);
    await page.waitForFunction(() => window.__page?.()?.snapshot()?.phase === "playing", null, { timeout: 180_000 });
    const playableMs = Date.now() - t0;
    const metrics = await page.evaluate(() => ({ ...window.__engine.metrics }));
    // 1 操作（Lightning Bolt を押す → 対象の選択が出るまで）
    const t1 = Date.now();
    await page.locator('.board [data-id="c1"]').click();
    await page.waitForFunction(() => window.__page?.()?.snapshot()?.pending?.kind === "TARGETS");
    const actionMs = Date.now() - t1;
    // リセット
    const t2 = Date.now();
    await page.locator("header button", { hasText: "リセット" }).click();
    await page.waitForFunction(() => window.__page?.()?.snapshot()?.pending?.kind === "PRIORITY");
    const resetMs = Date.now() - t2;
    results.push({ run: i, playableMs, ...metrics, actionMs, resetMs });
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}
