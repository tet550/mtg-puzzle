// 問題の一覧（トップ画面）。

import { clearedIds, type CatalogEntry, type PuzzleCategory } from "../puzzle/catalog";
import { t } from "../i18n";
import { h } from "./dom";
import { avatarUrl, heroArtUrl, icon, portraitUrl } from "./icons";
import { cardImage, displayName, ensureCardImages, imagesEnabled, setImagesEnabled } from "./images";
import { langSwitch } from "./lang";
import { manaNodes } from "./mana";

interface PuzzleMeta {
  cards: string[];
  colors: string;
  life: [number, number];
  series?: string;
}

/** 同梱パズルのビジュアルメタ情報（カードサムネイル・色・初期ライフ） */
const PUZZLE_META: Record<string, PuzzleMeta> = {
  "t01-burn": {
    cards: ["Shock", "Mountain"],
    colors: "{R}",
    life: [20, 2],
    series: "Tutorial #01",
  },
  "t02-attack": {
    cards: ["Savannah Lions"],
    colors: "{W}",
    life: [20, 2],
    series: "Tutorial #02",
  },
  "t03-pump": {
    cards: ["Giant Growth", "Grizzly Bears"],
    colors: "{G}",
    life: [20, 5],
    series: "Tutorial #03",
  },
  "t04-removal": {
    cards: ["Go for the Throat", "Bloodthirsty Conqueror", "Serra Angel"],
    colors: "{B}",
    life: [20, 5],
    series: "Tutorial #04",
  },
  "t05-ability": {
    cards: ["Fanatical Firebrand", "Savannah Lions", "Llanowar Elves"],
    colors: "{W}{R}",
    life: [10, 2],
    series: "Tutorial #05",
  },
  "e01-prowess": {
    cards: ["Monastery Swiftspear", "Giant Growth", "Shock"],
    colors: "{R}{G}",
    life: [10, 8],
    series: "Easy #01",
  },
  "e02-valiant": {
    cards: ["Heartfire Hero", "Giant Growth", "Shivan Dragon"],
    colors: "{R}{G}",
    life: [10, 7],
    series: "Easy #02",
  },
  "e03-shelter": {
    cards: ["Sheltered by Ghosts", "Ajani's Pridemate", "Healer's Hawk"],
    colors: "{W}",
    life: [10, 4],
    series: "Easy #03",
  },
  "e04-bite": {
    cards: ["Bite Down", "Giant Growth", "Llanowar Elves"],
    colors: "{G}",
    life: [10, 5],
    series: "Easy #04",
  },
  "e05-tempest": {
    cards: ["Monastery Swiftspear", "Go for the Throat", "Bite Down"],
    colors: "{B}{R}{G}",
    life: [10, 3],
    series: "Easy #05",
  },
  "c01-oracle": {
    cards: ["Thassa's Oracle", "Kasmina, Enigma Sage", "Jace's Machinations"],
    colors: "{G}{U}",
    life: [20, 20],
    series: "Combo #01",
  },
  "c02-terror": {
    cards: ["Terror of the Peaks", "Marang River Regent", "Kona, Rescue Beastie"],
    colors: "{G}{U}{R}",
    life: [20, 20],
    series: "Combo #02",
  },
  "c03-showoff": {
    cards: ["Slickshot Show-Off", "Full Bore", "Callous Sell-Sword"],
    colors: "{R}",
    life: [20, 18],
    series: "Combo #03",
  },
  "c04-tokens": {
    cards: ["Biotech Specialist", "The Sackville-Bagginses", "Mutagen Man, Living Ooze"],
    colors: "{B}{R}{G}",
    life: [20, 20],
    series: "Combo #04",
  },
  "c05-redshift": {
    cards: ["Redshift, Rocketeer Chief", "Agatha's Soul Cauldron", "Sewer-veillance Cam"],
    colors: "{U}{R}{G}",
    life: [20, 20],
    series: "Combo #05",
  },
  "c06-squirrel": {
    cards: ["The Unbeatable Squirrel Girl", "Nature's Rhythm", "Badgermole Cub"],
    colors: "{G}",
    life: [20, 20],
    series: "Combo #06",
  },
  "c07-battlecrier": {
    cards: ["Temur Battlecrier", "Outcaster Trailblazer", "Devastating Onslaught"],
    colors: "{G}{U}{R}",
    life: [20, 12],
    series: "Combo #07",
  },
  "c08-lifegain": {
    cards: ["Essence Channeler", "Delney, Streetwise Lookout", "Ajani Resolute"],
    colors: "{W}{B}",
    life: [20, 155],
    series: "Combo #08",
  },
};

const HERO_FALLBACK_CARDS = [
  "Bloodthirsty Conqueror",
  "Tempest Djinn",
  "Heartfire Hero",
];

export type FilterKey = "all" | "tutorial" | "easy" | "combo" | "basic" | "challenge" | "unsolved" | "cleared";

export function entryCategory(entry: CatalogEntry): PuzzleCategory {
  if (entry.category) return entry.category;
  if (entry.sourceFile) return "combo";
  if (entry.id.startsWith("e")) return "easy";
  if (entry.id.startsWith("c")) return "combo";
  return "tutorial";
}

export function matchesCatalogFilter(entry: CatalogEntry, filter: FilterKey, cleared: ReadonlySet<string>): boolean {
  const cat = entryCategory(entry);
  if (filter === "tutorial" || filter === "basic") return cat === "tutorial";
  if (filter === "easy") return cat === "easy";
  if (filter === "combo") return cat === "combo";
  if (filter === "challenge") return cat !== "tutorial";
  if (filter === "unsolved") return !cleared.has(entry.id);
  if (filter === "cleared") return cleared.has(entry.id);
  return true;
}

export function selectNextPuzzle(entries: CatalogEntry[], cleared: ReadonlySet<string>): CatalogEntry | undefined {
  return entries.find((e) => !cleared.has(e.id)) ?? entries[0];
}

function renderCardThumb(name: string, cls = "pz-thumb"): HTMLElement {
  const img = imagesEnabled() ? cardImage(name) : null;
  if (img) {
    return h(`div.${cls}.has-img`, { title: displayName(name) },
      h("img", { src: img.normal, alt: displayName(name), loading: "lazy", draggable: "false" }),
    );
  }
  return h(`div.${cls}.no-img`, { title: displayName(name) },
    h("span.pz-thumb-name", null, displayName(name)),
  );
}

function renderLifeMatchup(life: [number, number]): HTMLElement {
  return h("span.chip.pz-life", { title: t("catalog.life", { you: life[0], opp: life[1] }) },
    h("img.pz-life-ico", { src: avatarUrl("human"), alt: "", draggable: "false" }),
    h("span.pz-life-num", null, String(life[0])),
    h("span.pz-life-vs", null, "vs"),
    h("span.pz-life-num", null, String(life[1])),
    h("img.pz-life-ico", { src: avatarUrl("ai"), alt: "", draggable: "false" }),
  );
}

export function renderCatalog(
  entries: CatalogEntry[],
  open: (id: string) => void,
  edit?: (id?: string) => void,
): HTMLElement {
  const cleared = clearedIds();
  const totalCount = entries.length;
  const clearedCount = entries.filter((e) => cleared.has(e.id)).length;
  const progressPct = totalCount > 0 ? Math.round((clearedCount / totalCount) * 100) : 0;

  const nextEntry = selectNextPuzzle(entries, cleared);
  const nextMeta = nextEntry ? PUZZLE_META[nextEntry.id] : undefined;

  // ヒーローの3枚カードファン用に代表カードを選ぶ
  const heroCards: string[] = [];
  for (const c of [...(nextMeta?.cards ?? []), ...HERO_FALLBACK_CARDS]) {
    if (!heroCards.includes(c)) heroCards.push(c);
    if (heroCards.length >= 3) break;
  }

  let currentFilter: FilterKey = "all";

  const root = h("div.catalog");

  function build() {
    const tutorialCount = entries.filter((e) => entryCategory(e) === "tutorial").length;
    const easyCount = entries.filter((e) => entryCategory(e) === "easy").length;
    const comboCount = entries.filter((e) => entryCategory(e) === "combo").length;
    const unsolvedCount = totalCount - clearedCount;

    const emptyMsg = h("div.catalog-empty.muted", { hidden: true }, t("catalog.empty"));

    const rowEls = entries.map((e, idx) => {
      const isDone = cleared.has(e.id);
      const cat = entryCategory(e);
      const meta = PUZZLE_META[e.id];
      const thumbCards = (meta?.cards ?? []).slice(0, 2);
      const seriesLabel = t(`catalog.badge.${cat}`);
      const badgeCls = `chip.pz-badge.${cat}`;

      const row = h("li.pzrow", { "data-category": cat, "data-cleared": String(isDone) },
        h("button.pz" + (isDone ? ".done" : ""), {
          type: "button",
          onclick: () => open(e.id),
          "data-puzzle": e.id,
        },
          thumbCards.length > 0
            ? h("div.pz-art", { "aria-hidden": "true" },
                thumbCards.map((c, i) => renderCardThumb(c, `pz-thumb.t${i}`)))
            : null,
          h("div.pz-body", null,
            h("div.pz-meta", null,
              h("span.pz-num", null, `#${String(idx + 1).padStart(2, "0")}`),
              h(`span.${badgeCls}`, null, seriesLabel),
              meta?.colors ? h("span.pz-colors", null, manaNodes(meta.colors)) : null,
              meta?.life ? renderLifeMatchup(meta.life) : null,
              isDone ? h("span.chip.ok", null, "✓ ", t("catalog.cleared")) : null,
            ),
            h("span.pzt", null, e.title),
            meta?.cards.length
              ? h("div.pz-cards", null,
                  meta.cards.map((c) => h("span.pz-card-pill", null, displayName(c))))
              : null,
            e.description ? h("span.pzd.muted", null, e.description.split("\n")[0]) : null,
            e.sourceFile ? h("span.pzs.muted", null, t("catalog.source.forge", { file: e.sourceFile })) : null,
          ),
        ),
        edit
          ? h("button.pzedit", {
              type: "button",
              "data-edit-puzzle": e.id,
              title: t("catalog.edit.title"),
              onclick: () => edit(e.id),
            }, t("catalog.edit"))
          : null,
      );
      return { entry: e, el: row };
    });

    const filterDefs: { key: FilterKey; label: string }[] = [
      { key: "all", label: t("catalog.filter.all", { n: totalCount }) },
      { key: "tutorial", label: t("catalog.filter.tutorial", { n: tutorialCount }) },
      { key: "easy", label: t("catalog.filter.easy", { n: easyCount }) },
      { key: "combo", label: t("catalog.filter.combo", { n: comboCount }) },
      { key: "unsolved", label: t("catalog.filter.unsolved", { n: unsolvedCount }) },
      { key: "cleared", label: t("catalog.filter.cleared", { n: clearedCount }) },
    ];

    const filterBtns = new Map<FilterKey, HTMLButtonElement>();

    function applyFilter(next: FilterKey) {
      currentFilter = next;
      for (const [k, btn] of filterBtns) {
        btn.classList.toggle("on", k === currentFilter);
        btn.setAttribute("aria-pressed", String(k === currentFilter));
      }
      let visible = 0;
      for (const { entry, el } of rowEls) {
        const show = matchesCatalogFilter(entry, currentFilter, cleared);
        el.hidden = !show;
        if (show) visible++;
      }
      emptyMsg.hidden = visible > 0;
    }

    const filterBar = h("div.catalog-toolbar", null,
      h("div.filter-tabs", { role: "group" },
        filterDefs.map(({ key, label }) => {
          const btn = h("button.filter-tab" + (key === currentFilter ? ".on" : ""), {
            type: "button",
            "data-filter": key,
            "aria-pressed": String(key === currentFilter),
            onclick: () => applyFilter(key),
          }, label) as HTMLButtonElement;
          filterBtns.set(key, btn);
          return btn;
        }),
      ),
    );

    const ctaLabel = !nextEntry
      ? t("catalog.hero.playAgain")
      : clearedCount === 0
        ? t("catalog.hero.playFirst", { title: nextEntry.title })
        : clearedCount === totalCount
          ? t("catalog.hero.playAgain")
          : t("catalog.hero.playNext", { title: nextEntry.title });

    root.replaceChildren(
      h("header.bar", null,
        h("strong.brand", null,
          h("img.brand-icon", { src: avatarUrl("human"), alt: "", draggable: "false" }),
          "MTG Puzzle",
        ),
        h("span.muted.bar-tagline", null, t("catalog.tagline")),
        h("span.spacer"),
        h("button" + (imagesEnabled() ? ".on" : ""), {
          type: "button",
          title: t("header.images.title"),
          onclick: () => {
            setImagesEnabled(!imagesEnabled());
            build();
          },
        }, t("header.images")),
        edit
          ? h("button.on", {
              type: "button",
              "data-action": "create-puzzle",
              title: t("catalog.create.title"),
              onclick: () => edit(),
            }, t("catalog.create"))
          : null,
        langSwitch(),
      ),
      h("main.list", null,
        // ヒーローセクション
        h("section.hero", null,
          h("div.hero-copy", null,
            h("div.hero-eyebrow", null,
              h("span.hero-mana", null, manaNodes("{W}{U}{B}{R}{G}")),
              h("span", null, t("catalog.hero.eyebrow")),
            ),
            h("h1.hero-title", null, t("catalog.hero.title")),
            h("p.hero-sub", null, t("catalog.hero.sub")),
            h("div.hero-actions", null,
              nextEntry
                ? h("button.big.on.hero-cta", {
                    type: "button",
                    onclick: () => open(nextEntry.id),
                  }, ctaLabel)
                : null,
              edit
                ? h("button.big.hero-secondary", {
                    type: "button",
                    onclick: () => edit(),
                  }, t("catalog.create"))
                : null,
            ),
            h("div.hero-stats", null,
              h("div.hero-prog-head", null,
                h("span.hero-prog-label", null,
                  clearedCount === totalCount && totalCount > 0
                    ? t("catalog.hero.allCleared")
                    : t("catalog.hero.progress", { done: clearedCount, total: totalCount })),
                h("span.hero-prog-pct", null, `${progressPct}%`),
              ),
              h("div.prog-track", { role: "progressbar", "aria-valuenow": String(clearedCount), "aria-valuemin": "0", "aria-valuemax": String(totalCount) },
                h("div.prog-fill", { style: `width: ${progressPct}%` }),
              ),
            ),
          ),
          nextEntry
            ? h("button.hero-showcase", {
                type: "button",
                title: nextEntry.title,
                onclick: () => open(nextEntry.id),
              },
                h("div.hero-backdrop", { "aria-hidden": "true" },
                  h("img.hb-human", { src: heroArtUrl("human"), alt: "", draggable: "false" }),
                  h("img.hb-ai", { src: heroArtUrl("ai"), alt: "", draggable: "false" }),
                ),
                h("div.hero-duel", { "aria-hidden": "true" },
                  h("div.hero-fighter.me", null,
                    h("img.hero-portrait", { src: portraitUrl("human"), alt: "", draggable: "false" }),
                    nextMeta
                      ? h("span.hero-life", null,
                          h("span.llbl", null, "LIFE"),
                          h("span.lnum", null, String(nextMeta.life[0])),
                        )
                      : null,
                  ),
                  h("div.hero-fan", null,
                    heroCards.map((c, i) => renderCardThumb(c, `hero-card.hc${i}`)),
                  ),
                  h("div.hero-fighter.opp", null,
                    h("img.hero-portrait", { src: portraitUrl("ai"), alt: "", draggable: "false" }),
                    nextMeta
                      ? h("span.hero-life", null,
                          h("span.llbl", null, "LIFE"),
                          h("span.lnum", null, String(nextMeta.life[1])),
                        )
                      : null,
                  ),
                ),
                h("div.hero-spot", null,
                  h("span.hero-spot-kicker", null, t("catalog.hero.featured")),
                  h("strong.hero-spot-title", null, nextEntry.title),
                  nextMeta
                    ? h("div.hero-spot-meta", null,
                        h("span.pz-colors", null, manaNodes(nextMeta.colors)),
                        renderLifeMatchup(nextMeta.life),
                      )
                    : null,
                ),
              )
            : null,
        ),

        // 遊び方 3 ステップ
        h("section.howto", null,
          h("div.howto-card", null,
            h("div.howto-icon", null, icon("main1")),
            h("div.howto-text", null,
              h("strong.howto-title", null, t("catalog.howto.step1.title")),
              h("p.howto-desc.muted", null, t("catalog.howto.step1.desc")),
            ),
          ),
          h("div.howto-card", null,
            h("div.howto-icon", null, icon("resolve")),
            h("div.howto-text", null,
              h("strong.howto-title", null, t("catalog.howto.step2.title")),
              h("p.howto-desc.muted", null, t("catalog.howto.step2.desc")),
            ),
          ),
          h("div.howto-card", null,
            h("div.howto-icon", null, icon("combat")),
            h("div.howto-text", null,
              h("strong.howto-title", null, t("catalog.howto.step3.title")),
              h("p.howto-desc.muted", null, t("catalog.howto.step3.desc")),
            ),
          ),
        ),

        // フィルタ＆問題一覧
        filterBar,
        emptyMsg,
        h("ol.puzzles", null, rowEls.map((r) => r.el)),
      ),
      h("footer.credits.muted", null, [
        t("credits.engine"),
        t("credits.images"),
        t("credits.ui"),
        t("credits.fcp"),
      ].map((line) => h("div", null, line))),
    );

    applyFilter(currentFilter);
  }

  build();

  // cards.json に未収録の代表カード（例: s11-redshift）があればバックグラウンドで取得して再描画
  const allFeaturedCards = Object.values(PUZZLE_META).flatMap((m) => m.cards);
  void ensureCardImages(allFeaturedCards).then((changed) => {
    if (changed && root.isConnected) build();
  });

  return root;
}
