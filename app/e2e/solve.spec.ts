// 同梱のサンプル問題を、解答手順どおりに画面（盤面のカード・操作の欄のボタン）を押して解く。
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Step { kind: string; indexes: number[]; labels: string[] }
interface Solution { puzzle: string; steps: Step[] }
interface CatalogEntry { id: string; title: string }

const dir = fileURLToPath(new URL("../public/puzzles/", import.meta.url));
const catalog: CatalogEntry[] = JSON.parse(readFileSync(dir + "index.json", "utf-8"));

type Snapshot = {
  phase: string;
  pending: { seq: number; kind: string; min: number; max: number; options: { id: string; label: string; ref: Record<string, string> | null }[] } | null;
  verdict: { result: string };
  errors: string[];
};

const snapshot = (page: Page) => page.evaluate(() => (window as unknown as { __page(): { snapshot(): Snapshot } | null }).__page()?.snapshot() ?? null);

async function waitFor(page: Page, pred: (s: Snapshot) => boolean, what: string): Promise<Snapshot> {
  let last: Snapshot | null = null;
  await expect.poll(async () => {
    last = await snapshot(page);
    return !!last && (pred(last) || last.phase === "error");
  }, { message: what, timeout: 120_000, intervals: [100, 250, 500] }).toBe(true);
  if (last!.phase === "error") throw new Error(`エラー: ${last!.errors.join(" / ")}`);
  return last!;
}

type Opt = NonNullable<Snapshot["pending"]>["options"][number];

/**
 * 1 つの選択肢を画面で押す。盤面にあるものはカード・プレイヤーを押し、同じカードに選択肢が複数あれば
 * メニューの menuIndex 番目を押す。盤面に無いものは操作の欄の listIndex 番目のボタン
 */
async function clickOption(page: Page, opt: Opt, onBoard: boolean, menuIndex: number, listIndex: number) {
  const ref = opt.ref;
  if (ref?.type === "special") {
    await page.locator(`.actions [data-special="${ref.value}"]`).click();
    return;
  }
  if (onBoard) {
    const key = ref?.cardId ?? ref?.player;
    await page.locator(`.board [data-id="${key}"], .board [data-player="${key}"]`).first().click();
    if (menuIndex >= 0) await page.locator(".menu button").nth(menuIndex).click();
    return;
  }
  await page.locator(".actions .listed .opt").nth(listIndex).click();
}

// 解答手順のある問題だけを解く（相手のブロックを考えると探索で解けない問題は、解答手順を持たない）
for (const entry of catalog.filter((e) => existsSync(`${dir}${e.id}.solution.json`))) {
  test(`${entry.id}: ${entry.title}`, async ({ page }) => {
    const solution: Solution = JSON.parse(readFileSync(`${dir}${entry.id}.solution.json`, "utf-8"));
    page.on("console", (m) => { if (m.type() === "error") console.log(`[console] ${m.text()}`); });
    await page.goto(`/#/play/${entry.id}`);
    let seq = -1;
    for (const [n, step] of solution.steps.entries()) {
      const s = await waitFor(page, (x) => x.phase === "playing" && !!x.pending && x.pending.seq !== seq, `step ${n + 1} (${step.kind})`);
      const d = s.pending!;
      expect(d.kind, `step ${n + 1}`).toBe(step.kind);
      seq = d.seq;
      // 盤面の要素ごとの選択肢の並び（メニューの位置）と、操作の欄に並ぶ選択肢の位置を出す
      const visible = await page.evaluate(() => [...document.querySelectorAll(".board [data-id], .board [data-player]")]
        .map((e) => (e as HTMLElement).dataset.id ?? (e as HTMLElement).dataset.player));
      const keyOf = (o: Opt) => (o.ref?.type === "special" ? null : (o.ref?.cardId ?? o.ref?.player ?? null));
      const listed = d.options.filter((o) => o.ref?.type !== "special" && !(keyOf(o) && visible.includes(keyOf(o)!)));
      for (const i of step.indexes) {
        const opt = d.options[i];
        const key = keyOf(opt);
        const onBoard = !!key && visible.includes(key);
        const same = onBoard ? d.options.filter((o) => keyOf(o) === key) : [];
        await clickOption(page, opt, onBoard, same.length > 1 ? same.indexOf(opt) : -1, listed.indexOf(opt));
      }
      const single = d.min === 1 && d.max === 1;
      const special = step.indexes.some((i) => d.options[i].ref?.type === "special");
      if (!single && !special && d.kind !== "PRIORITY") {
        await page.locator(".actions .btns button.on.big").first().click();
      }
    }
    const end = await waitFor(page, (x) => x.phase === "finished", "結果");
    expect(end.verdict.result).toBe("CLEARED");
    await expect(page.locator(".actions .result")).toHaveText(/^(クリア！|Cleared!)$/);
  });
}

test("不正な問題データはエラーを表示する", async ({ page }) => {
  await page.goto("/#/play/no-such-puzzle");
  await expect(page.locator(".actions.error")).toBeVisible();
});
