// 問題の一覧（トップ画面）。

import { clearedIds, type CatalogEntry } from "../puzzle/catalog";
import { t } from "../i18n";
import { h } from "./dom";
import { langSwitch } from "./lang";

export function renderCatalog(entries: CatalogEntry[], open: (id: string) => void): HTMLElement {
  const cleared = clearedIds();
  return h("div.catalog", null,
    h("header.bar", null, h("strong.brand", null, "MTG Puzzle"), h("span.muted", null, t("catalog.tagline")), h("span.spacer"), langSwitch()),
    h("main.list", null,
      h("p.lead", null, t("catalog.lead")),
      h("ol.puzzles", null, entries.map((e) => h("li", null,
        h("button.pz" + (cleared.has(e.id) ? ".done" : ""), { type: "button", onclick: () => open(e.id), "data-puzzle": e.id },
          h("span.pzt", null, e.title, cleared.has(e.id) ? h("span.chip.ok", null, t("catalog.cleared")) : null),
          e.description ? h("span.pzd.muted", null, e.description.split("\n")[0]) : null,
          e.sourceFile ? h("span.pzs.muted", null, t("catalog.source.forge", { file: e.sourceFile })) : null))))),
    h("footer.credits.muted", null, [
      t("credits.engine"),
      t("credits.images"),
      t("credits.fcp"),
    ].map((line) => h("div", null, line))));
}
