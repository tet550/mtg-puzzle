// ブラウザ（CheerpJ）でエンジンが止まらないかを確かめる（design/forge-overlay.md）。
// CheerpJ は Forge の Card.keywordsToText を同じページで一定回数呼んだあとに止まる。Forge のクラスの上書きが効いていれば止まらない。
// 画面は操作せず、エンジンを直接呼んで、キーワードを持つカードの文面を何度も作らせる（s11: 速攻のトークンを作り続ける）。
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Step { kind: string; labels: string[] }
const dir = fileURLToPath(new URL("../public/puzzles/", import.meta.url));
const steps: Step[] = JSON.parse(readFileSync(`${dir}s11-redshift.solution.json`, "utf-8")).steps;

test("s11 を 30 手進めてリセットを 6 回繰り返し、最後に解き切っても止まらない", async ({ page }, info) => {
  test.skip(info.project.name !== "chrome", "エンジンの確かめなので Chrome だけで行う");
  test.setTimeout(600_000);
  await page.goto("/#/play/s11-redshift");
  await expect.poll(() => page.evaluate(() => (window as any).__page?.()?.snapshot()?.phase), { timeout: 120_000 }).toBe("playing");

  const result = await page.evaluate(async (steps: Step[]) => {
    const engine = (window as any).__page().session.engine;
    const norm = (x: string) => x.replace(/\s+/g, " ").trim();
    // 解答の手を、ラベルで選択肢に引き当てて送る（位置は選択肢の並びが変わるとずれるので使わない）
    const play = async (count: number) => {
      let st = await engine.reset();
      for (const [n, step] of steps.slice(0, count).entries()) {
        const ids: string[] = [];
        for (const w of step.labels) {
          const o = st.pending?.options.find((x: any) => norm(x.label) === norm(w) && !ids.includes(x.id));
          if (!o) throw new Error(`${n + 1} 手目: 選択肢が無い: ${w}`);
          ids.push(o.id);
        }
        st = await engine.submit(ids);
      }
      return st.javaJudge?.status as string;
    };
    try {
      for (let run = 0; run < 6; run++) await play(30);
      return { ok: true, last: await play(steps.length) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, steps);

  expect(result, JSON.stringify(result)).toEqual({ ok: true, last: "CLEARED" });
});
