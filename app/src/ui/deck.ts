// デッキ登録・管理・テキスト一括インポート・初手マリガン・一人回し（プレイテスト）画面。

import {
  cardMeta,
  isCardDbLoaded,
  loadCardDb,
  searchCards,
  type CardMeta,
} from "../puzzle/carddb";
import {
  buildPlaytestPuzzle,
  canKeepHand,
  deckDescription,
  deckTitle,
  deckTotalCount,
  deleteDeck,
  finalizeKeep,
  formatDeckList,
  loadDecks,
  mulliganAgain,
  normalizeDeckEntries,
  parseDeckList,
  restoreSampleDecks,
  saveDeck,
  startMulligan,
  toggleBottomCard,
  type DeckDef,
  type DeckEntry,
  type DeckParseUnknown,
  type MulliganState,
} from "../puzzle/deck";
import type { PuzzleJson } from "../puzzle/schema";
import { lang, onLangChange, t } from "../i18n";
import { h } from "./dom";
import { cardImage, displayName, ensureCardImages, imagesEnabled } from "./images";
import { optionsButton } from "./options";
import { manaNodes } from "./mana";

type DeckTab = "list" | "import";

/** デッキ内のカードから代表的なマナ色記号列（"{R}{G}" など）を作る */
export function deckColorIcons(entries: readonly DeckEntry[]): string {
  const seen = new Set<string>();
  for (const e of entries) {
    const m = cardMeta(e.cardId);
    if (!m) continue;
    for (const c of ["W", "U", "B", "R", "G"]) {
      if (m.manaCost.includes(`{${c}}`)) seen.add(c);
    }
    if (m.name === "Plains") seen.add("W");
    else if (m.name === "Island") seen.add("U");
    else if (m.name === "Swamp") seen.add("B");
    else if (m.name === "Mountain") seen.add("R");
    else if (m.name === "Forest") seen.add("G");
  }
  if (seen.size === 0) return "{C}";
  return ["W", "U", "B", "R", "G"]
    .filter((c) => seen.has(c))
    .map((c) => `{${c}}`)
    .join("");
}

/**
 * 初手確認・ロンドンマリガン用のモーダル `<dialog>` を開く。
 * DeckPage からも PlayPage（「🎲 初手を引き直す」）からも呼べる。
 */
export function openMulliganDialog(
  deck: DeckDef,
  onStart: (puzzle: PuzzleJson, deck: DeckDef) => void,
): HTMLDialogElement {
  document.querySelectorAll("dialog.mulligan-dialog").forEach((d) => d.remove());

  let state: MulliganState = startMulligan(deck.cards);
  const dialog = h("dialog.mulligan-dialog", {
    closedby: "any",
    "aria-labelledby": "mulligan-dialog-title",
  }) as HTMLDialogElement;

  // Fallback for browsers without declarative <dialog closedby> support
  if (typeof HTMLDialogElement !== "undefined" && !("closedBy" in HTMLDialogElement.prototype)) {
    dialog.addEventListener("click", (event: MouseEvent) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const isDialogContent =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (isDialogContent) return;
      dialog.close();
    });
  }

  const unsubLang = onLangChange(() => {
    if (dialog.isConnected) renderModal();
  });

  dialog.addEventListener("close", () => {
    unsubLang();
    dialog.remove();
  });

  const renderModal = () => {
    const needed = Math.min(state.mulliganCount, state.hand.length);
    const selected = state.bottomIndices.length;
    const keepable = canKeepHand(state);
    const keepCount = Math.max(0, state.hand.length - needed);
    const nextStart = Math.max(1, 7 - (state.mulliganCount + 1));

    const statusText =
      state.mulliganCount === 0
        ? t("deck.mulligan.status0")
        : t("deck.mulligan.statusN", { count: state.mulliganCount, needed, selected });

    const handEl = h(
      "div.mulligan-hand",
      null,
      state.hand.map((cardId, idx) => {
        const isBottom = state.bottomIndices.includes(idx);
        const img = imagesEnabled() ? cardImage(cardId)?.normal ?? null : null;
        const meta = cardMeta(cardId);
        return h(
          "button.mulligan-card" + (isBottom ? ".to-bottom" : "") + (needed > 0 ? ".selectable" : ""),
          {
            type: "button",
            "data-hand-index": String(idx),
            "aria-pressed": String(isBottom),
            title: displayName(cardId),
            onclick: () => {
              if (needed > 0) {
                state = toggleBottomCard(state, idx);
                renderModal();
              }
            },
          },
          img
            ? h("img.mulligan-card-img", { src: img, alt: displayName(cardId), draggable: "false" })
            : h(
                "div.mulligan-card-fallback",
                null,
                h("div.mcf-head", null,
                  h("strong", null, displayName(cardId)),
                  meta?.manaCost ? h("span", null, manaNodes(meta.manaCost)) : null,
                ),
                meta
                  ? h("div.mcf-type.muted", null, lang() === "ja" && meta.jaTypeLine ? meta.jaTypeLine : meta.typeLine)
                  : null,
                meta
                  ? h("div.mcf-text", null, lang() === "ja" && meta.jaText ? meta.jaText : meta.text)
                  : null,
              ),
          h("span.mulligan-card-label", null, displayName(cardId)),
          isBottom ? h("span.mulligan-bottom-badge", null, t("deck.mulligan.bottomBadge")) : null,
        );
      }),
    );

    dialog.replaceChildren(
      h(
        "div.mulligan-box",
        null,
        h(
          "div.mulligan-head",
          null,
          h("h2#mulligan-dialog-title", null, t("deck.mulligan.title", { name: deckTitle(deck) })),
          h(
            "button.mulligan-close",
            {
              type: "button",
              title: t("deck.mulligan.cancel"),
              onclick: () => dialog.close(),
            },
            "×",
          ),
        ),
        h("p.mulligan-status" + ( needed > 0 && !keepable ? ".warn" : ""), null, statusText),
        handEl,
        h(
          "div.mulligan-actions",
          null,
          h(
            "button.big.on",
            {
              type: "button",
              "data-action": "mulligan-keep",
              disabled: !keepable || state.hand.length === 0,
              onclick: () => {
                const { hand, library } = finalizeKeep(state);
                const puzzle = buildPlaytestPuzzle(deck, hand, library);
                dialog.close();
                onStart(puzzle, deck);
              },
            },
            t("deck.mulligan.keep", { n: keepCount }),
          ),
          h(
            "button.big",
            {
              type: "button",
              "data-action": "mulligan-redraw",
              disabled: state.mulliganCount >= 6 || state.allCards.length === 0,
              onclick: () => {
                state = mulliganAgain(state);
                renderModal();
              },
            },
            t("deck.mulligan.redraw", { next: nextStart }),
          ),
          h(
            "button.big",
            {
              type: "button",
              "data-action": "mulligan-reset7",
              onclick: () => {
                state = startMulligan(deck.cards);
                renderModal();
              },
            },
            t("deck.mulligan.reset7"),
          ),
          h(
            "button.big",
            {
              type: "button",
              onclick: () => dialog.close(),
            },
            t("deck.mulligan.cancel"),
          ),
        ),
      ),
    );
  };

  renderModal();
  document.body.append(dialog);
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }

  if (!isCardDbLoaded()) {
    void loadCardDb()
      .then(() => {
        if (dialog.isConnected) renderModal();
      })
      .catch(() => {});
  }
  void ensureCardImages(deck.cards.map((c) => c.cardId)).then((changed) => {
    if (changed && dialog.isConnected) renderModal();
  });

  return dialog;
}

export class DeckPage {
  readonly el: HTMLElement;
  private decks: DeckDef[];
  private current: DeckDef;
  private tab: DeckTab = "list";
  private searchQuery = "";
  private addTarget: "main" | "side" = "main";
  private importText = "";
  private importUnknown: DeckParseUnknown[] = [];
  private toast: { text: string; isError?: boolean } | null = null;
  private toastTimer = 0;
  private dbLoading = false;
  private disposed = false;

  constructor(
    private readonly onBack: () => void,
    private readonly onPlaytest: (puzzle: PuzzleJson, deck: DeckDef) => void,
    initialDeckId?: string,
  ) {
    this.el = h("div.deck-page");
    this.decks = loadDecks();
    const found = initialDeckId ? this.decks.find((d) => d.id === initialDeckId) : this.decks[0];
    this.current = found
      ? this.cloneDeck(found)
      : {
          id: `deck-${Date.now()}`,
          name: t("deck.defaultName"),
          description: "",
          cards: [],
          sideboard: [],
          updatedAt: Date.now(),
        };
    this.importText = formatDeckList(this.current, lang());

    if (!isCardDbLoaded()) {
      this.dbLoading = true;
      void loadCardDb()
        .then(() => {
          this.dbLoading = false;
          this.importText = formatDeckList(this.current, lang());
          if (!this.disposed) this.render();
        })
        .catch(() => {
          this.dbLoading = false;
          if (!this.disposed) this.render();
        });
    }

    this.ensureCurrentDeckImages();
    this.render();
  }

  refresh(): void {
    this.importText = formatDeckList(this.current, lang());
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.toastTimer);
  }

  private cloneDeck(d: DeckDef): DeckDef {
    return {
      ...d,
      cards: d.cards.map((c) => ({ ...c })),
      sideboard: (d.sideboard ?? []).map((c) => ({ ...c })),
    };
  }

  private ensureCurrentDeckImages(): void {
    const names = [
      ...this.current.cards.map((c) => c.cardId),
      ...(this.current.sideboard ?? []).map((c) => c.cardId),
    ];
    if (names.length === 0) return;
    void ensureCardImages(names).then((changed) => {
      if (changed && !this.disposed) this.render();
    });
  }

  private showToast(text: string, isError = false): void {
    this.toast = { text, isError };
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast = null;
      if (!this.disposed) this.render();
    }, 3500);
    this.render();
  }

  private selectDeck(deck: DeckDef): void {
    this.current = this.cloneDeck(deck);
    this.importText = formatDeckList(this.current, lang());
    this.importUnknown = [];
    this.ensureCurrentDeckImages();
    this.render();
  }

  private createNewDeck(): void {
    const fresh: DeckDef = {
      id: `deck-${Date.now()}`,
      name: t("deck.numberedName", { n: this.decks.length + 1 }),
      description: "",
      cards: [],
      sideboard: [],
      updatedAt: Date.now(),
    };
    this.decks = saveDeck(fresh);
    this.selectDeck(fresh);
  }

  private saveCurrent(): void {
    this.decks = saveDeck(this.current);
    this.showToast(t("deck.savedToast", { name: deckTitle(this.current) }));
  }

  private duplicateCurrent(): void {
    const cloned = this.cloneDeck(this.current);
    delete cloned.en;
    const copy: DeckDef = {
      ...cloned,
      id: `deck-${Date.now()}`,
      name: t("deck.copyName", { name: deckTitle(this.current) }),
      description: deckDescription(this.current),
      updatedAt: Date.now(),
    };
    this.decks = saveDeck(copy);
    this.selectDeck(copy);
    this.showToast(t("deck.savedToast", { name: deckTitle(copy) }));
  }

  private deleteCurrent(): void {
    this.decks = deleteDeck(this.current.id);
    if (this.decks.length > 0) {
      this.selectDeck(this.decks[0]);
    } else {
      this.createNewDeck();
    }
    this.showToast(t("deck.deletedToast"));
  }

  private addCard(cardId: string, delta: number, side = this.addTarget === "side"): void {
    const list = side ? [...(this.current.sideboard ?? [])] : [...this.current.cards];
    const idx = list.findIndex((e) => e.cardId === cardId);
    if (idx >= 0) {
      const nextCount = list[idx].count + delta;
      if (nextCount <= 0) list.splice(idx, 1);
      else list[idx] = { cardId, count: nextCount };
    } else if (delta > 0) {
      list.push({ cardId, count: delta });
    }
    if (side) {
      this.current.sideboard = list;
    } else {
      this.current.cards = list;
    }
    this.decks = saveDeck(this.current);
    this.importText = formatDeckList(this.current, lang());
    void ensureCardImages([cardId]).then((changed) => {
      if (changed && !this.disposed) this.render();
    });
    this.render();
  }

  private applyImport(append: boolean): void {
    const res = parseDeckList(this.importText);
    this.importUnknown = res.unknown;
    if (append) {
      this.current.cards = normalizeDeckEntries([...this.current.cards, ...res.cards]);
      this.current.sideboard = normalizeDeckEntries([...(this.current.sideboard ?? []), ...res.sideboard]);
    } else {
      this.current.cards = res.cards;
      this.current.sideboard = res.sideboard;
    }
    this.decks = saveDeck(this.current);
    this.ensureCurrentDeckImages();
    this.showToast(
      t("deck.import.applied", {
        main: deckTotalCount(res.cards),
        side: deckTotalCount(res.sideboard),
      }),
      res.unknown.length > 0 && res.cards.length === 0,
    );
  }

  private startWithMulligan(): void {
    this.decks = saveDeck(this.current);
    openMulliganDialog(this.current, (puzzle, deck) => {
      this.onPlaytest(puzzle, deck);
    });
  }

  private startQuickKeep7(): void {
    this.decks = saveDeck(this.current);
    const state = startMulligan(this.current.cards);
    const { hand, library } = finalizeKeep(state);
    const puzzle = buildPlaytestPuzzle(this.current, hand, library);
    this.onPlaytest(puzzle, this.current);
  }

  private render(): void {
    const searchInput = this.el.querySelector<HTMLInputElement>("[data-deck-search]");
    const hadSearchFocus = document.activeElement === searchInput;
    const selStart = searchInput?.selectionStart ?? null;
    const selEnd = searchInput?.selectionEnd ?? null;

    const mainTotal = deckTotalCount(this.current.cards);
    const header = h(
      "header.bar",
      null,
      h("button.back", { type: "button", onclick: () => this.onBack(), title: t("header.back.title") }, t("header.back")),
      h("strong.ptitle", null, t("deck.pageTitle")),
      h("span.chip.goal", null, t("deck.badge")),
      h("span.spacer"),
      h(
        "button.on",
        {
          type: "button",
          "data-action": "header-start-playtest",
          disabled: mainTotal === 0,
          onclick: () => this.startWithMulligan(),
        },
        t("deck.startPlaytest"),
      ),
      optionsButton(() => this.render()),
    );

    const sidebar = h(
      "aside.deck-sidebar",
      null,
      h(
        "div.deck-side-head",
        null,
        h("strong", null, t("deck.savedList", { n: this.decks.length })),
        h(
          "div.deck-side-btns",
          null,
          h(
            "button.on",
            {
              type: "button",
              "data-action": "new-deck",
              onclick: () => this.createNewDeck(),
            },
            t("deck.new"),
          ),
          h(
            "button",
            {
              type: "button",
              "data-action": "restore-samples",
              title: t("deck.restoreSamples.title"),
              onclick: () => {
                this.decks = restoreSampleDecks();
                this.render();
              },
            },
            t("deck.restoreSamples"),
          ),
        ),
      ),
      h(
        "ul.deck-saved-list",
        null,
        this.decks.map((d) => {
          const isCur = d.id === this.current.id;
          const mCount = deckTotalCount(d.cards);
          const sCount = deckTotalCount(d.sideboard ?? []);
          const colors = deckColorIcons(d.cards);
          return h(
            "li.deck-saved-item" + (isCur ? ".on" : ""),
            null,
            h(
              "button.deck-saved-btn",
              {
                type: "button",
                "data-deck-id": d.id,
                onclick: () => this.selectDeck(d),
              },
              h(
                "div.ds-top",
                null,
                h("strong.ds-name", null, deckTitle(d)),
                h("span.ds-colors", null, manaNodes(colors)),
              ),
              h(
                "div.ds-sub.muted",
                null,
                sCount > 0
                  ? t("deck.cardCountWithSide", { main: mCount, side: sCount })
                  : t("deck.cardCount", { n: mCount }),
              ),
            ),
          );
        }),
      ),
    );

    const topbar = h(
      "div.deck-topbar",
      null,
      h(
        "div.deck-meta-inputs",
        null,
        h(
          "label.ed-field",
          null,
          h("span", null, t("deck.name")),
          h("input.ed-input", {
            type: "text",
            "data-deck-name": "1",
            value: deckTitle(this.current),
            placeholder: t("deck.namePlaceholder"),
            oninput: (ev: Event) => {
              this.current.name = (ev.target as HTMLInputElement).value;
              delete this.current.en;
            },
            onchange: () => {
              this.decks = saveDeck(this.current);
              this.render();
            },
          }),
        ),
        h(
          "label.ed-field",
          null,
          h("span", null, t("deck.description")),
          h("input.ed-input", {
            type: "text",
            value: deckDescription(this.current),
            placeholder: t("deck.descriptionPlaceholder"),
            oninput: (ev: Event) => {
              this.current.description = (ev.target as HTMLInputElement).value;
              if (this.current.en) delete this.current.en.description;
            },
            onchange: () => {
              this.decks = saveDeck(this.current);
            },
          }),
        ),
      ),
      h(
        "div.deck-top-actions",
        null,
        h(
          "button.big.on",
          {
            type: "button",
            "data-action": "start-playtest",
            disabled: mainTotal === 0,
            onclick: () => this.startWithMulligan(),
          },
          t("deck.startPlaytest"),
        ),
        h(
          "button.big",
          {
            type: "button",
            "data-action": "quick-playtest",
            disabled: mainTotal === 0,
            onclick: () => this.startQuickKeep7(),
          },
          t("deck.quickPlaytest"),
        ),
        h(
          "button",
          {
            type: "button",
            "data-action": "save-deck",
            onclick: () => this.saveCurrent(),
          },
          t("deck.save"),
        ),
        h(
          "button",
          {
            type: "button",
            onclick: () => this.duplicateCurrent(),
          },
          t("deck.duplicate"),
        ),
        h(
          "button.danger",
          {
            type: "button",
            onclick: () => this.deleteCurrent(),
          },
          t("deck.delete"),
        ),
      ),
      this.toast
        ? h("div.ed-toast" + (this.toast.isError ? ".error" : ""), null, this.toast.text)
        : null,
    );

    const tabs = h(
      "div.ed-tabs",
      null,
      h(
        "button.ed-tab" + (this.tab === "list" ? ".on" : ""),
        {
          type: "button",
          "data-deck-tab": "list",
          onclick: () => {
            this.tab = "list";
            this.render();
          },
        },
        t("deck.tab.list"),
      ),
      h(
        "button.ed-tab" + (this.tab === "import" ? ".on" : ""),
        {
          type: "button",
          "data-deck-tab": "import",
          onclick: () => {
            this.tab = "import";
            this.importText = formatDeckList(this.current, lang());
            this.render();
          },
        },
        t("deck.tab.import"),
      ),
    );

    const workspace = h(
      "section.deck-workspace",
      null,
      topbar,
      tabs,
      this.tab === "list" ? this.renderListTab() : this.renderImportTab(),
    );

    this.el.replaceChildren(header, h("main.deck-layout", null, sidebar, workspace));

    if (hadSearchFocus) {
      const nextInput = this.el.querySelector<HTMLInputElement>("[data-deck-search]");
      if (nextInput) {
        nextInput.focus();
        if (selStart !== null && selEnd !== null) {
          nextInput.setSelectionRange(selStart, selEnd);
        }
      }
    }
  }

  private renderListTab(): HTMLElement {
    const results: CardMeta[] = this.dbLoading ? [] : searchCards(this.searchQuery, 35);

    const searchCol = h(
      "div.deck-search-col",
      null,
      h(
        "div.deck-search-head",
        null,
        h("strong", null, t("deck.search.title")),
        h(
          "div.ed-seg",
          null,
          h(
            "button" + (this.addTarget === "main" ? ".on" : ""),
            {
              type: "button",
              onclick: () => {
                this.addTarget = "main";
                this.render();
              },
            },
            t("deck.search.targetMain"),
          ),
          h(
            "button" + (this.addTarget === "side" ? ".on" : ""),
            {
              type: "button",
              onclick: () => {
                this.addTarget = "side";
                this.render();
              },
            },
            t("deck.search.targetSide"),
          ),
        ),
      ),
      h(
        "div.ed-search-box",
        null,
        h("input.ed-input", {
          type: "search",
          "data-deck-search": "1",
          placeholder: t("deck.search.placeholder"),
          value: this.searchQuery,
          oninput: (ev: Event) => {
            this.searchQuery = (ev.target as HTMLInputElement).value;
            this.render();
          },
        }),
      ),
      this.dbLoading
        ? h("div.ed-hint.muted", null, t("editor.search.loading"))
        : results.length === 0
          ? h("div.ed-hint.muted", null, t("editor.search.empty"))
          : h(
              "ul.ed-results.deck-search-results",
              null,
              results.map((m) => {
                const primaryName = displayName(m.name);
                const subName = lang() === "ja" && m.jaName && primaryName !== m.name ? m.name : null;
                const typeText = lang() === "ja" && m.jaTypeLine ? m.jaTypeLine : m.typeLine;
                return h(
                  "li.ed-res-item",
                  null,
                  h(
                    "div.deck-res-row",
                    null,
                    h(
                      "button.ed-res-btn",
                      {
                        type: "button",
                        "data-add-card": m.name,
                        onclick: () => this.addCard(m.name, 1),
                      },
                      h(
                        "div.ed-res-main",
                        null,
                        h(
                          "span.ed-res-names",
                          null,
                          h("strong.ed-res-name", null, primaryName),
                          subName ? h("span.ed-res-en.muted", null, ` ${subName}`) : null,
                        ),
                        m.manaCost ? h("span.ed-res-mana", null, manaNodes(m.manaCost)) : null,
                      ),
                      h(
                        "div.ed-res-sub.muted",
                        null,
                        typeText,
                        m.basePower !== null && m.baseToughness !== null ? ` (${m.basePower}/${m.baseToughness})` : "",
                      ),
                    ),
                    h(
                      "div.deck-res-quick",
                      null,
                      h(
                        "button",
                        {
                          type: "button",
                          title: "+1",
                          onclick: () => this.addCard(m.name, 1),
                        },
                        "+1",
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          title: "+4",
                          onclick: () => this.addCard(m.name, 4),
                        },
                        "+4",
                      ),
                    ),
                  ),
                );
              }),
            ),
    );

    // メインデッキを クリーチャー / 呪文・その他 / 土地 に分類
    const creatures: DeckEntry[] = [];
    const spells: DeckEntry[] = [];
    const lands: DeckEntry[] = [];
    for (const e of this.current.cards) {
      const m = cardMeta(e.cardId);
      if (m?.kinds.includes("land")) lands.push(e);
      else if (m?.kinds.includes("creature")) creatures.push(e);
      else spells.push(e);
    }

    const mainTotal = deckTotalCount(this.current.cards);
    const sideEntries = this.current.sideboard ?? [];
    const sideTotal = deckTotalCount(sideEntries);

    const cardsCol = h(
      "div.deck-cards-col",
      null,
      h(
        "div.deck-board-sec",
        null,
        h(
          "div.deck-sec-head",
          null,
          h("strong", null, t("deck.mainboard", { n: mainTotal })),
          h("span.ds-colors", null, manaNodes(deckColorIcons(this.current.cards))),
        ),
        mainTotal === 0
          ? h("div.ed-hint.muted", null, t("deck.emptyMain"))
          : h(
              "div.deck-groups",
              null,
              creatures.length > 0
                ? this.renderCardGroup(t("deck.section.creatures", { n: deckTotalCount(creatures) }), creatures, false)
                : null,
              spells.length > 0
                ? this.renderCardGroup(t("deck.section.spells", { n: deckTotalCount(spells) }), spells, false)
                : null,
              lands.length > 0
                ? this.renderCardGroup(t("deck.section.lands", { n: deckTotalCount(lands) }), lands, false)
                : null,
            ),
      ),
      sideTotal > 0 || this.addTarget === "side"
        ? h(
            "div.deck-board-sec",
            null,
            h("div.deck-sec-head", null, h("strong", null, t("deck.sideboard", { n: sideTotal }))),
            this.renderCardGroup("", sideEntries, true),
          )
        : null,
    );

    return h("div.deck-list-grid", null, searchCol, cardsCol);
  }

  private renderCardGroup(title: string, entries: readonly DeckEntry[], side: boolean): HTMLElement {
    return h(
      "div.deck-group",
      null,
      title ? h("h4.deck-group-title", null, title) : null,
      h(
        "ul.deck-card-list",
        null,
        entries.map((e) => {
          const m = cardMeta(e.cardId);
          const img = imagesEnabled() ? cardImage(e.cardId)?.normal ?? null : null;
          return h(
            "li.deck-card-row",
            { "data-deck-card": e.cardId },
            img
              ? h("img.deck-row-thumb", { src: img, alt: "", loading: "lazy", draggable: "false" })
              : h("span.deck-row-thumb.placeholder"),
            h(
              "div.deck-row-info",
              null,
              h("span.deck-row-name", null, displayName(e.cardId)),
              m?.manaCost ? h("span.deck-row-mana", null, manaNodes(m.manaCost)) : null,
            ),
            h(
              "div.deck-row-qty",
              null,
              h(
                "button",
                {
                  type: "button",
                  title: "-1",
                  onclick: () => this.addCard(e.cardId, -1, side),
                },
                "−",
              ),
              h("span.deck-row-count", null, `×${e.count}`),
              h(
                "button",
                {
                  type: "button",
                  title: "+1",
                  onclick: () => this.addCard(e.cardId, 1, side),
                },
                "＋",
              ),
              h(
                "button.danger",
                {
                  type: "button",
                  title: t("editor.card.delete"),
                  onclick: () => this.addCard(e.cardId, -e.count, side),
                },
                "×",
              ),
            ),
          );
        }),
      ),
    );
  }

  private renderImportTab(): HTMLElement {
    return h(
      "div.deck-import-pane",
      null,
      h("h4.ed-sec-title", null, t("deck.import.title")),
      h("p.ed-hint.muted", null, t("deck.import.help")),
      h(
        "div.ed-btn-row",
        null,
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              this.importText = formatDeckList(this.current, "ja");
              this.render();
            },
          },
          t("deck.import.exportJa"),
        ),
        h(
          "button",
          {
            type: "button",
            onclick: () => {
              this.importText = formatDeckList(this.current, "en");
              this.render();
            },
          },
          t("deck.import.exportEn"),
        ),
        h(
          "button",
          {
            type: "button",
            onclick: async () => {
              await navigator.clipboard?.writeText(this.importText);
              this.showToast(t("deck.import.copied"));
            },
          },
          t("deck.import.copy"),
        ),
      ),
      h("textarea.ed-json-area.deck-import-area", {
        rows: 14,
        "data-deck-import-area": "1",
        placeholder: t("deck.import.placeholder"),
        value: this.importText,
        oninput: (ev: Event) => {
          this.importText = (ev.target as HTMLTextAreaElement).value;
        },
      }),
      h(
        "div.ed-btn-row",
        null,
        h(
          "button.on",
          {
            type: "button",
            "data-action": "import-replace",
            onclick: () => this.applyImport(false),
          },
          t("deck.import.replace"),
        ),
        h(
          "button",
          {
            type: "button",
            "data-action": "import-append",
            onclick: () => this.applyImport(true),
          },
          t("deck.import.append"),
        ),
      ),
      this.importUnknown.length > 0
        ? h(
            "div.deck-unknown-box",
            null,
            h("strong", null, t("deck.import.unknownHeader", { n: this.importUnknown.length })),
            h(
              "ul",
              null,
              this.importUnknown.map((u) => h("li", null, `L${u.line}: ${u.raw}`)),
            ),
          )
        : null,
    );
  }
}
