// 問題の一覧（トップ画面）。

import { clearedIds, type CatalogEntry } from "../puzzle/catalog";
import { h } from "./dom";

export function renderCatalog(entries: CatalogEntry[], open: (id: string) => void): HTMLElement {
  const cleared = clearedIds();
  return h("div.catalog", null,
    h("header.bar", null, h("strong.brand", null, "MTG Puzzle"), h("span.muted", null, "このターン中に勝てるか？")),
    h("main.list", null,
      h("p.lead", null, "盤面を見て、このターン中に勝つ手順を見つけてください。カードを押すと行動を選べます。長押し（右クリック）でカードの詳細。"),
      h("ol.puzzles", null, entries.map((e) => h("li", null,
        h("button.pz" + (cleared.has(e.id) ? ".done" : ""), { type: "button", onclick: () => open(e.id), "data-puzzle": e.id },
          h("span.pzt", null, e.title, cleared.has(e.id) ? h("span.chip.ok", null, "クリア済み") : null),
          e.description ? h("span.pzd.muted", null, e.description.split("\n")[0]) : null,
          e.source ? h("span.pzs.muted", null, e.source) : null))))),
    h("footer.credits.muted", null,
      "ルールエンジン: Forge（GPL-3.0）。CheerpJ でブラウザ上で動かしています。",
      "Magic: The Gathering は Wizards of the Coast LLC の商標です。本サイトは非公式のファンコンテンツです。"));
}
