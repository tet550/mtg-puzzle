// 入口。#/ は問題の一覧、#/play/<id> はその問題を遊ぶ画面。
import "./ui/style.css";
import { ForgeEngine } from "./engine/client";
import { loadCatalog, loadPuzzle } from "./puzzle/catalog";
import { renderCatalog } from "./ui/catalog";
import { h } from "./ui/dom";
import { loadCardImages } from "./ui/images";
import { PlayPage } from "./ui/play";

// ?timeout=<秒> でエンジンの 1 回の呼び出しの待ち時間を変える（調査用）
const timeout = Number(new URLSearchParams(location.search).get("timeout"));
const engine = new ForgeEngine(timeout > 0 ? { callTimeoutMs: timeout * 1000 } : {});
const root = document.getElementById("app")!;
let page: PlayPage | null = null;

// 一覧を見ている間にエンジンの準備を始めておく（数秒かかるため）
void engine.start().catch(() => { /* 画面ごとに状態を出す */ });

async function route() {
  page?.dispose();
  page = null;
  const m = /^#\/play\/([\w-]+)$/.exec(location.hash);
  if (m) {
    const id = m[1];
    page = new PlayPage(engine, id, () => { location.hash = "#/"; });
    root.replaceChildren(page.el);
    try {
      await page.load(await loadPuzzle(id));
    } catch (e) {
      await page.load({ error: String(e) });
    }
    return;
  }
  try {
    root.replaceChildren(renderCatalog(await loadCatalog(), (id) => { location.hash = `#/play/${id}`; }));
  } catch (e) {
    root.replaceChildren(h("div.fatal", null, String(e)));
  }
}

window.addEventListener("hashchange", () => void route());
// 画像の URL の一覧（小さい JSON）を読んでから描く。読めなければ文字のカードになる
void loadCardImages().then(route);

// 自動テスト（Playwright）用
Object.assign(window, { __engine: engine, __page: () => page });
