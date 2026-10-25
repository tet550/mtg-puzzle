// 盤面エディタ（Phase 2: WYSIWYG ボードエディタ）。
// - プレイ画面と同じ盤面（renderBoard + previewView）をそのまま使い、カードを直接クリックして状態変更・移動・削除できる
// - 右下（縦画面では下部）の操作パネルでカード検索（日英対応・Forge 全カード DB）・プレイヤー設定・JSON 入出力を行う
// - 「▶ テストプレイ」で現在の盤面をそのまま Forge エンジンに読み込んで試遊できる

import type { ForgeEngine } from "../engine/client";
import type { CardView, ManaColor } from "../engine/protocol";
import { t, type MessageKey } from "../i18n";
import {
  cardMeta,
  loadCardDb,
  searchCards,
  type CardMeta,
} from "../puzzle/carddb";
import { loadCatalog, loadPuzzle, type CatalogEntry } from "../puzzle/catalog";
import {
  ENGINE_VERSION,
  formatManaPool,
  MANA_COLORS,
  parseManaPool,
  SCHEMA_VERSION,
  validatePuzzle,
  ZONES,
  type CardDef,
  type PlayerDef,
  type PuzzleJson,
  type ZoneKey,
} from "../puzzle/schema";
import {
  buildShareUrl,
  MAX_SHARE_URL_LENGTH,
  parsePuzzleInput,
} from "../puzzle/share";
import { formatSolutionStep } from "../puzzle/solution";
import { detailBody, renderBoard, type BoardHooks, type BoardUi, type Mark } from "./board";
import { h } from "./dom";
import { fitHands, setupFloat } from "./float";
import { cardImage, displayName, ensureCardImages, imagesEnabled, printedText, setImagesEnabled } from "./images";
import { langSwitch } from "./lang";
import { manaNodes } from "./mana";
import { engineBadge, previewView } from "./play";
import { phaseName } from "./text";

export const EDITOR_DRAFT_KEY = "mtg-puzzle.editor.draft.v1";

export const EDITABLE_PHASES = [
  "UPKEEP",
  "DRAW",
  "MAIN1",
  "COMBAT_BEGIN",
  "COMBAT_DECLARE_ATTACKERS",
  "COMBAT_DECLARE_BLOCKERS",
  "COMBAT_DAMAGE",
  "COMBAT_END",
  "MAIN2",
  "END_OF_TURN",
] as const;

export const EDITABLE_COUNTERS = ["P1P1", "M1M1", "LOYALTY", "DEFENSE"] as const;

export interface CardLocation {
  playerIndex: number;
  playerId: string;
  zone: ZoneKey;
  index: number;
  card: CardDef;
}

// ---------------------------------------------------------------- 純粋な問題データ操作関数（テスト可能）

export function createEmptyPuzzle(title?: string): PuzzleJson {
  return {
    schemaVersion: SCHEMA_VERSION,
    title: title ?? t("editor.defaultTitle"),
    description: "",
    engine: { type: "forge", version: ENGINE_VERSION },
    game: {
      activePlayer: "p1",
      phase: "MAIN1",
      turn: 1,
      players: [
        { id: "p1", life: 20, hand: [], battlefield: [], graveyard: [], exile: [], library: [] },
        { id: "p2", life: 20, hand: [], battlefield: [], graveyard: [], exile: [], library: [] },
      ],
    },
    goal: { type: "win", player: "p1", deadline: "current_turn" },
    opponent: { policy: "pass", block: "minimize" },
  };
}

export function clonePuzzle(p: PuzzleJson): PuzzleJson {
  return JSON.parse(JSON.stringify(p)) as PuzzleJson;
}

/** 既存の全カード ID と衝突しない新しいカード ID ("c1", "c2", ...) を採番する */
export function nextCardInstanceId(p: PuzzleJson): string {
  const used = new Set<string>();
  let maxNum = 0;
  for (const pl of p.game.players) {
    for (const z of ZONES) {
      for (const c of pl[z] ?? []) {
        used.add(c.id);
        const m = /^c(\d+)$/.exec(c.id);
        if (m) maxNum = Math.max(maxNum, Number(m[1]));
      }
    }
  }
  let n = maxNum + 1;
  while (used.has(`c${n}`)) n++;
  return `c${n}`;
}

export function findCardLocation(p: PuzzleJson, instanceId: string): CardLocation | null {
  for (let pi = 0; pi < p.game.players.length; pi++) {
    const pl = p.game.players[pi];
    for (const zone of ZONES) {
      const list = pl[zone];
      if (!list) continue;
      const idx = list.findIndex((c) => c.id === instanceId);
      if (idx >= 0) {
        return { playerIndex: pi, playerId: pl.id, zone, index: idx, card: list[idx] };
      }
    }
  }
  return null;
}

const PERMANENT_KINDS = new Set([
  "land",
  "creature",
  "artifact",
  "enchantment",
  "planeswalker",
  "battle",
]);

/**
 * カードが戦場に置けるパーマネントかどうかを返す。
 * カードDB未読み込み時や未知のカードは制限しない（true）。
 * インスタント・ソーサリーのみを持つカードは戦場に置けないため false を返す。
 */
export function isPermanentCard(cardId: string): boolean {
  const meta = cardMeta(cardId);
  if (!meta || meta.kinds.length === 0) return true;
  return meta.kinds.some((k) => PERMANENT_KINDS.has(k));
}

/**
 * 戦場に置くカードの初期カウンター（プレインズウォーカーの忠誠度・バトルの守備値）を補完する。
 * Forge の GameState は戦場のカードに |NoETBTrigs を付けて生成するため、
 * 忠誠度や守備値を Counters に明示しないと 0 個で出て状況起因処理により即座に墓地へ置かれてしまう。
 */
export function defaultBattlefieldCounters(
  cardId: string,
  existing?: Record<string, number>,
): Record<string, number> | undefined {
  const meta = cardMeta(cardId);
  const out: Record<string, number> = existing ? { ...existing } : {};
  if (meta?.loyalty !== undefined && out.LOYALTY === undefined && out.loyalty === undefined) {
    out.LOYALTY = meta.loyalty;
  }
  if (meta?.defense !== undefined && out.DEFENSE === undefined && out.defense === undefined) {
    out.DEFENSE = meta.defense;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 問題データを Forge エンジンで安全に読み込めるよう正規化する:
 * 1. 分割カード等のカード名を Forge の正式名（"Fire // Ice" など）に揃える
 * 2. 戦場に誤って置かれているインスタント・ソーサリーを手札へ移す
 * 3. 戦場のプレインズウォーカー・バトルに初期カウンター（LOYALTY / DEFENSE）が無ければ補完する
 */
export function normalizePuzzleForEngine(p: PuzzleJson): PuzzleJson {
  const next = clonePuzzle(p);
  for (const pl of next.game.players) {
    for (const z of ZONES) {
      for (const c of pl[z] ?? []) {
        const meta = cardMeta(c.cardId);
        if (meta && meta.name !== c.cardId) {
          c.cardId = meta.name;
        }
      }
    }
    if (pl.battlefield && pl.battlefield.length > 0) {
      const stay: CardDef[] = [];
      for (const c of pl.battlefield) {
        if (!isPermanentCard(c.cardId)) {
          delete c.tapped;
          delete c.summoningSick;
          delete c.counters;
          (pl.hand ?? (pl.hand = [])).push(c);
        } else {
          const counters = defaultBattlefieldCounters(c.cardId, c.counters);
          if (counters) c.counters = counters;
          else delete c.counters;
          stay.push(c);
        }
      }
      pl.battlefield = stay;
    }
  }
  return next;
}

export function addCardToPuzzle(
  p: PuzzleJson,
  playerId: string,
  zone: ZoneKey,
  cardId: string,
): { puzzle: PuzzleJson; added: CardDef } {
  const next = clonePuzzle(p);
  const pl = next.game.players.find((x) => x.id === playerId) ?? next.game.players[0];
  const canonicalId = cardMeta(cardId)?.name ?? cardId;
  const effectiveZone: ZoneKey = zone === "battlefield" && !isPermanentCard(canonicalId) ? "hand" : zone;
  const id = nextCardInstanceId(next);
  const counters = effectiveZone === "battlefield" ? defaultBattlefieldCounters(canonicalId) : undefined;
  const added: CardDef = {
    id,
    cardId: canonicalId,
    ...(counters ? { counters } : {}),
  };
  const list = pl[effectiveZone] ?? (pl[effectiveZone] = []);
  list.push(added);
  return { puzzle: next, added };
}

export function removeCardFromPuzzle(p: PuzzleJson, instanceId: string): PuzzleJson {
  const next = clonePuzzle(p);
  const loc = findCardLocation(next, instanceId);
  if (!loc) return next;
  const list = next.game.players[loc.playerIndex][loc.zone];
  if (list) list.splice(loc.index, 1);
  return next;
}

export function duplicateCardInPuzzle(
  p: PuzzleJson,
  instanceId: string,
): { puzzle: PuzzleJson; duplicated: CardDef | null } {
  const next = clonePuzzle(p);
  const loc = findCardLocation(next, instanceId);
  if (!loc) return { puzzle: next, duplicated: null };
  const id = nextCardInstanceId(next);
  const copy: CardDef = {
    ...loc.card,
    id,
    counters: loc.card.counters ? { ...loc.card.counters } : undefined,
  };
  const list = next.game.players[loc.playerIndex][loc.zone]!;
  list.splice(loc.index + 1, 0, copy);
  return { puzzle: next, duplicated: copy };
}

export function moveCardInPuzzle(
  p: PuzzleJson,
  instanceId: string,
  targetPlayerId: string,
  targetZone: ZoneKey,
): PuzzleJson {
  const next = clonePuzzle(p);
  const loc = findCardLocation(next, instanceId);
  if (!loc) return next;
  if (loc.playerId === targetPlayerId && loc.zone === targetZone) return next;
  if (targetZone === "battlefield" && !isPermanentCard(loc.card.cardId)) return next;
  const srcList = next.game.players[loc.playerIndex][loc.zone]!;
  const [card] = srcList.splice(loc.index, 1);
  // 戦場以外の領域へ移す場合はタップ・召喚酔い・カウンターを外す。戦場へ移す場合は初期カウンターを補完する
  if (targetZone !== "battlefield") {
    delete card.tapped;
    delete card.summoningSick;
    delete card.counters;
  } else {
    const counters = defaultBattlefieldCounters(card.cardId, card.counters);
    if (counters) card.counters = counters;
  }
  const dstPlayer = next.game.players.find((x) => x.id === targetPlayerId) ?? next.game.players[0];
  const dstList = dstPlayer[targetZone] ?? (dstPlayer[targetZone] = []);
  dstList.push(card);
  return next;
}

export function moveCardOrderInZone(
  p: PuzzleJson,
  instanceId: string,
  position: "top" | "bottom" | "left" | "right",
): PuzzleJson {
  const next = clonePuzzle(p);
  const loc = findCardLocation(next, instanceId);
  if (!loc) return next;
  const list = next.game.players[loc.playerIndex][loc.zone];
  if (!list || list.length <= 1) return next;
  const [card] = list.splice(loc.index, 1);
  if (position === "top") {
    list.unshift(card);
  } else if (position === "bottom") {
    list.push(card);
  } else if (position === "left") {
    list.splice(Math.max(0, loc.index - 1), 0, card);
  } else {
    list.splice(Math.min(list.length, loc.index + 1), 0, card);
  }
  return next;
}

export function toggleCardProp(
  p: PuzzleJson,
  instanceId: string,
  prop: "tapped" | "summoningSick",
): PuzzleJson {
  const next = clonePuzzle(p);
  const loc = findCardLocation(next, instanceId);
  if (!loc) return next;
  if (loc.card[prop]) {
    delete loc.card[prop];
  } else {
    loc.card[prop] = true;
  }
  return next;
}

export function setCardCounter(
  p: PuzzleJson,
  instanceId: string,
  counterType: string,
  count: number,
): PuzzleJson {
  const next = clonePuzzle(p);
  const loc = findCardLocation(next, instanceId);
  if (!loc) return next;
  const n = Math.max(0, Math.floor(count));
  const counters = loc.card.counters ? { ...loc.card.counters } : {};
  if (n <= 0) {
    delete counters[counterType];
  } else {
    counters[counterType] = n;
  }
  if (Object.keys(counters).length === 0) {
    delete loc.card.counters;
  } else {
    loc.card.counters = counters;
  }
  return next;
}

export function setPlayerLife(p: PuzzleJson, playerId: string, life: number): PuzzleJson {
  const next = clonePuzzle(p);
  const pl = next.game.players.find((x) => x.id === playerId);
  if (pl && Number.isFinite(life)) {
    pl.life = Math.round(life);
  }
  return next;
}

export function adjustPlayerMana(
  p: PuzzleJson,
  playerId: string,
  color: ManaColor,
  delta: number,
): PuzzleJson {
  const next = clonePuzzle(p);
  const pl = next.game.players.find((x) => x.id === playerId);
  if (!pl) return next;
  const pool = parseManaPool(pl.manaPool);
  const nextVal = Math.max(0, (pool[color] ?? 0) + delta);
  if (nextVal <= 0) delete pool[color];
  else pool[color] = nextVal;
  const formatted = formatManaPool(pool);
  if (formatted) pl.manaPool = formatted;
  else delete pl.manaPool;
  return next;
}

export function clearPlayerMana(p: PuzzleJson, playerId: string): PuzzleJson {
  const next = clonePuzzle(p);
  const pl = next.game.players.find((x) => x.id === playerId);
  if (pl) delete pl.manaPool;
  return next;
}

export function saveEditorDraft(p: PuzzleJson): void {
  try {
    localStorage.setItem(EDITOR_DRAFT_KEY, JSON.stringify(p));
  } catch { /* プライベートブラウズ等で書けないときは無視 */ }
}

export function loadEditorDraft(): PuzzleJson | null {
  try {
    const raw = localStorage.getItem(EDITOR_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const res = validatePuzzle(parsed);
    return res.ok ? res.puzzle : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 画面クラス

type EditorTab = "cards" | "settings" | "data";

export class EditPage {
  readonly el = h("div.play.editpage");
  private puzzle: PuzzleJson;
  private tab: EditorTab = "cards";
  private targetPlayer = "p1";
  private targetZone: ZoneKey = "hand";
  private selectedCardId: string | null = null;
  private detailCard: CardView | null = null;
  private openZones = new Set<string>();
  private searchQuery = "";
  private dbReady = false;
  private dbError: string | null = null;
  private catalogEntries: CatalogEntry[] = [];
  private selectedTemplateId = "";
  private dataFeedback: { text: string; isError: boolean } | null = null;
  private jsonDraftText = "";
  private images = imagesEnabled();
  private panelMinimized = false;
  private unsubEngine: (() => void) | null = null;
  private onResize = () => fitHands(this.el);

  // フォーカス維持のため結果一覧と盤面要素を保持
  private searchResultsEl: HTMLElement | null = null;
  private boardContainerEl: HTMLElement | null = null;

  constructor(
    private engine: ForgeEngine,
    private onBack: () => void,
    private onTestPlay: (puzzle: PuzzleJson) => void,
    initialPuzzle?: PuzzleJson,
  ) {
    this.puzzle = initialPuzzle ? clonePuzzle(initialPuzzle) : (loadEditorDraft() ?? createEmptyPuzzle());
    this.jsonDraftText = JSON.stringify(this.puzzle, null, 2);
    this.unsubEngine = this.engine.onStatus(() => this.render());
    window.addEventListener("resize", this.onResize);

    this.render();

    // カードDBと問題一覧を並行して読み込む
    void loadCardDb().then(() => {
      this.dbReady = true;
      this.dbError = null;
      this.puzzle = normalizePuzzleForEngine(this.puzzle);
      this.jsonDraftText = JSON.stringify(this.puzzle, null, 2);
      saveEditorDraft(this.puzzle);
      void this.ensureCurrentPuzzleImages();
      this.render();
    }).catch((err) => {
      this.dbError = String(err instanceof Error ? err.message : err);
      this.render();
    });
    void loadCatalog().then((entries) => {
      this.catalogEntries = entries;
      if (!this.selectedTemplateId && entries.length) {
        this.selectedTemplateId = entries[0].id;
      }
      if (this.tab === "data") this.render();
    }).catch(() => { /* 一覧が読めなくても編集は続けられる */ });
  }

  getPuzzle(): PuzzleJson {
    return clonePuzzle(this.puzzle);
  }

  async loadTemplateById(id: string): Promise<void> {
    try {
      const raw = await loadPuzzle(id);
      const res = validatePuzzle(raw);
      if (!res.ok) {
        this.dataFeedback = { text: res.errors.join(" / "), isError: true };
        this.render();
        return;
      }
      this.setPuzzle(res.puzzle);
    } catch (e) {
      this.dataFeedback = { text: String(e), isError: true };
      this.render();
    }
  }

  setPuzzle(p: PuzzleJson): void {
    this.puzzle = normalizePuzzleForEngine(p);
    this.selectedCardId = null;
    this.detailCard = null;
    this.jsonDraftText = JSON.stringify(this.puzzle, null, 2);
    saveEditorDraft(this.puzzle);
    void this.ensureCurrentPuzzleImages();
    this.render();
  }

  refresh(): void {
    this.render();
  }

  dispose(): void {
    this.unsubEngine?.();
    this.unsubEngine = null;
    window.removeEventListener("resize", this.onResize);
  }

  private async ensureCurrentPuzzleImages(): Promise<void> {
    const names = new Set<string>();
    for (const pl of this.puzzle.game.players) {
      for (const z of ZONES) {
        for (const c of pl[z] ?? []) names.add(c.cardId);
      }
    }
    if (names.size === 0) return;
    await ensureCardImages([...names]);
    this.renderBoardOnly();
  }

  private updatePuzzle(next: PuzzleJson, keepJsonDraft = false): void {
    this.puzzle = next;
    if (!keepJsonDraft) {
      this.jsonDraftText = JSON.stringify(this.puzzle, null, 2);
    }
    saveEditorDraft(this.puzzle);
    this.render();
  }

  /** 配置先を切り替えたとき、裏向き・要約領域なら盤面上で自動的に開いて見えるようにする */
  private syncOpenZoneForTarget(): void {
    if (this.targetPlayer === "p1") {
      if (this.targetZone === "library") this.openZones.add("my-library");
      else if (this.targetZone === "graveyard") this.openZones.add("my-graveyard");
      else if (this.targetZone === "exile") this.openZones.add("my-exile");
    } else {
      if (this.targetZone === "hand") this.openZones.add("hand");
      else if (this.targetZone === "library") this.openZones.add("library");
      else if (this.targetZone === "graveyard") this.openZones.add("graveyard");
      else if (this.targetZone === "exile") this.openZones.add("exile");
      else if (this.targetZone === "battlefield") this.openZones.add("lands");
    }
  }

  private buildBoardElement(): HTMLElement {
    const view = previewView(this.puzzle, { includeHidden: true });
    const marks = new Map<string, Mark>();
    if (this.selectedCardId) marks.set(this.selectedCardId, "chosen");
    marks.set(this.targetPlayer, "cand");

    const ui: BoardUi = {
      viewer: this.puzzle.goal.player,
      marks,
      open: this.openZones,
      startTurn: this.puzzle.game.turn ?? 1,
      flash: new Set(),
      art: (name) => (this.images ? cardImage(name)?.normal ?? null : null),
      attacking: new Set(),
      blocking: new Set(),
      editable: true,
    };

    const hooks: BoardHooks = {
      card: (c) => {
        this.selectedCardId = c.instanceId;
        const loc = findCardLocation(this.puzzle, c.instanceId);
        if (loc) {
          this.targetPlayer = loc.playerId;
          this.targetZone = loc.zone;
        }
        if (this.tab !== "cards") this.tab = "cards";
        this.render();
      },
      detail: (c) => {
        this.detailCard = c;
        this.render();
      },
      player: (id) => {
        this.targetPlayer = id;
        this.render();
      },
      toggle: (key) => {
        if (this.openZones.has(key)) {
          this.openZones.delete(key);
        } else {
          this.openZones.add(key);
          // 盤面の束や要約チップを開いたら、そこを次のカード追加先にする
          if (key === "my-library") { this.targetPlayer = "p1"; this.targetZone = "library"; }
          else if (key === "my-graveyard") { this.targetPlayer = "p1"; this.targetZone = "graveyard"; }
          else if (key === "my-exile") { this.targetPlayer = "p1"; this.targetZone = "exile"; }
          else if (key === "hand") { this.targetPlayer = "p2"; this.targetZone = "hand"; }
          else if (key === "library") { this.targetPlayer = "p2"; this.targetZone = "library"; }
          else if (key === "graveyard") { this.targetPlayer = "p2"; this.targetZone = "graveyard"; }
          else if (key === "exile") { this.targetPlayer = "p2"; this.targetZone = "exile"; }
          else if (key === "lands") { this.targetPlayer = "p2"; this.targetZone = "battlefield"; }
        }
        this.render();
      },
    };

    return renderBoard(view, ui, hooks);
  }

  private renderBoardOnly(): void {
    if (!this.boardContainerEl) return;
    const nextBoard = this.buildBoardElement();
    this.boardContainerEl.replaceWith(nextBoard);
    this.boardContainerEl = nextBoard;
    fitHands(this.el);
  }

  private render(): void {
    const topBar = h("header.bar", null,
      h("button.back", { type: "button", onclick: () => this.onBack(), title: t("header.back.title") }, t("header.back")),
      h("strong.ptitle", null, this.puzzle.title || t("editor.defaultTitle")),
      h("span.chip.goal", null, t("editor.badge")),
      h("span.spacer"),
      h("button.on", {
        type: "button",
        "data-action": "test-play",
        title: t("editor.testPlay.title"),
        onclick: () => this.onTestPlay(normalizePuzzleForEngine(this.puzzle)),
      }, t("editor.testPlay")),
      engineBadge(this.engine.status),
      h("button" + (this.images ? ".on" : ""), {
        type: "button",
        "aria-pressed": String(this.images),
        title: t("header.images.title"),
        onclick: () => {
          this.images = !this.images;
          setImagesEnabled(this.images);
          this.render();
        },
      }, t("header.images")),
      langSwitch(),
    );

    const board = this.buildBoardElement();
    this.boardContainerEl = board;

    const panel = this.buildEditorPanel();
    const children: HTMLElement[] = [topBar, h("main.layout", null, board), panel];

    if (this.detailCard) {
      const d = this.detailCard;
      const detailEl = h("div.float.cdetail", { role: "dialog", "aria-label": t("card.detail") },
        h("div.fhead", null,
          h("span", null, displayName(d.name)),
          h("button", { type: "button", onclick: () => { this.detailCard = null; this.render(); }, title: t("card.close") }, "×"),
        ),
        h("div.fbody", null,
          detailBody(
            d,
            this.images ? cardImage(d.name)?.normal ?? null : null,
            cardImage(d.name)?.artist ?? null,
            printedText(d.name),
          ),
        ),
      );
      children.push(detailEl);
    }

    this.el.replaceChildren(...children);
    const det = this.el.querySelector<HTMLElement>(".cdetail");
    if (det) setupFloat(det, "detail");
    fitHands(this.el);
  }

  private buildEditorPanel(): HTMLElement {
    const tabs: { id: EditorTab; key: MessageKey }[] = [
      { id: "cards", key: "editor.tab.cards" },
      { id: "settings", key: "editor.tab.settings" },
      { id: "data", key: "editor.tab.data" },
    ];

    const tabBar = h("div.etabs", null,
      tabs.map((tb) =>
        h("button" + (this.tab === tb.id ? ".on" : ""), {
          type: "button",
          "data-tab": tb.id,
          onclick: () => {
            this.tab = tb.id;
            this.dataFeedback = null;
            this.render();
          },
        }, t(tb.key)),
      ),
    );

    const body = h("div.ebody");
    if (this.tab === "cards") body.append(this.buildCardsTab());
    else if (this.tab === "settings") body.append(this.buildSettingsTab());
    else body.append(this.buildDataTab());

    const min = this.panelMinimized;
    return h("div.float.playpanel.editpanel" + (min ? ".min" : ""), null,
      h("div.fhead", null,
        h("span", null, t("editor.panel")),
        h("button", {
          type: "button",
          title: t("panel.min"),
          "aria-expanded": String(!min),
          onclick: () => {
            this.panelMinimized = !this.panelMinimized;
            this.render();
          },
        }, min ? "+" : "–"),
      ),
      h("div.fbody.epanel", null, tabBar, body),
    );
  }

  // ---------------------------------------------------------------- タブ 1: カード追加 & 選択カード編集

  private buildCardsTab(): HTMLElement {
    const wrap = h("div.ecards");

    // 1. 選択中のカードがあればインスペクタを最上部に表示
    const selectedLoc = this.selectedCardId ? findCardLocation(this.puzzle, this.selectedCardId) : null;
    if (selectedLoc) {
      wrap.append(this.buildSelectedCardInspector(selectedLoc));
    }

    // 2. 配置先プレイヤー & ゾーン選択
    const p1Btn = h("button" + (this.targetPlayer === "p1" ? ".on" : ""), {
      type: "button",
      "data-target-player": "p1",
      onclick: () => {
        this.targetPlayer = "p1";
        this.syncOpenZoneForTarget();
        this.render();
      },
    }, t("player.you"));
    const p2Btn = h("button" + (this.targetPlayer === "p2" ? ".on" : ""), {
      type: "button",
      "data-target-player": "p2",
      onclick: () => {
        this.targetPlayer = "p2";
        this.syncOpenZoneForTarget();
        this.render();
      },
    }, t("player.opponent"));

    const zoneButtons = ZONES.map((z) =>
      h("button" + (this.targetZone === z ? ".on" : ""), {
        type: "button",
        "data-target-zone": z,
        onclick: () => {
          this.targetZone = z;
          this.syncOpenZoneForTarget();
          this.render();
        },
      }, zoneLabel(z)),
    );

    wrap.append(
      h("div.etargets", null,
        h("div.erow", null, h("span.elbl", null, t("editor.targetPlayer")), h("div.ebtns", null, p1Btn, p2Btn)),
        h("div.erow", null, h("span.elbl", null, t("editor.targetZone")), h("div.ebtns.ezones", null, zoneButtons)),
      ),
    );

    // 3. カード検索欄（IME 入力を妨げないよう input イベントでは結果一覧のみ差し替える）
    const input = h("input.esearch", {
      type: "search",
      value: this.searchQuery,
      placeholder: t("editor.search.placeholder"),
      autocomplete: "off",
      oninput: (ev: Event) => {
        this.searchQuery = (ev.target as HTMLInputElement).value;
        this.renderSearchResults();
      },
    }) as HTMLInputElement;

    const resultsBox = h("div.eresults");
    this.searchResultsEl = resultsBox;
    this.renderSearchResults();

    wrap.append(h("div.esearchbox", null, input, resultsBox));
    return wrap;
  }

  private renderSearchResults(): void {
    const box = this.searchResultsEl;
    if (!box) return;
    if (this.dbError) {
      box.replaceChildren(h("div.enote.err", null, this.dbError));
      return;
    }
    if (!this.dbReady) {
      box.replaceChildren(h("div.muted.enote", null, t("editor.search.loading")));
      return;
    }

    const q = this.searchQuery.trim();
    const list: CardMeta[] = searchCards(q, 30);

    const playerLabel = this.targetPlayer === "p1" ? t("player.you") : t("player.opponent");
    const zLabel = zoneLabel(this.targetZone);
    const caption = q
      ? (list.length ? t("editor.search.count", { n: list.length, player: playerLabel, zone: zLabel }) : t("editor.search.empty"))
      : t("editor.search.defaults", { player: playerLabel, zone: zLabel });

    const items = list.map((entry) => {
      const ja = entry.jaName;
      const primaryName = displayName(entry.name);
      const subName = ja && primaryName === ja ? entry.name : null;
      return h("button.ecarditem", {
        type: "button",
        "data-add-card": entry.name,
        onclick: () => this.onAddCard(entry.name),
      },
        h("div.ecmain", null,
          h("span.ecname", null, primaryName),
          subName ? h("span.ecsub.muted", null, subName) : null,
        ),
        h("div.ecmeta", null,
          entry.manaCost ? h("span.cost", null, manaNodes(entry.manaCost)) : null,
          entry.basePower !== null && entry.baseToughness !== null
            ? h("span.chip", null, `${entry.basePower}/${entry.baseToughness}`)
            : null,
          h("span.chip.addchip", null, `＋ ${t("editor.card.add")}`),
        ),
      );
    });

    box.replaceChildren(
      h("div.muted.enote", null, caption),
      h("div.eresultlist", null, items),
    );
  }

  private onAddCard(cardId: string): void {
    if (this.targetZone === "battlefield" && !isPermanentCard(cardId)) {
      this.targetZone = "hand";
    }
    this.syncOpenZoneForTarget();
    const { puzzle, added } = addCardToPuzzle(this.puzzle, this.targetPlayer, this.targetZone, cardId);
    this.selectedCardId = added.id;
    this.puzzle = puzzle;
    this.jsonDraftText = JSON.stringify(this.puzzle, null, 2);
    saveEditorDraft(this.puzzle);
    this.render();
    void ensureCardImages([added.cardId]).then(() => this.renderBoardOnly());
  }

  private buildSelectedCardInspector(loc: CardLocation): HTMLElement {
    const { card, playerId, zone } = loc;
    const meta = cardMeta(card.cardId);
    const isCreature = meta ? meta.kinds.includes("creature") : true;
    const canBeOnBattlefield = isPermanentCard(card.cardId);
    const zoneList = this.puzzle.game.players[loc.playerIndex][zone] ?? [];

    const head = h("div.eselhead", null,
      h("strong.eselname", null, displayName(card.cardId)),
      h("span.chip", null, `${playerId === "p1" ? t("player.you") : t("player.opponent")} / ${zoneLabel(zone)}`),
      h("span.spacer"),
      h("button", {
        type: "button",
        "data-card-action": "detail",
        onclick: () => {
          const view = previewView(this.puzzle, { includeHidden: true });
          const cv = view.players.flatMap((p) => p.cards).find((c) => c.instanceId === card.id) ?? null;
          this.detailCard = cv;
          this.render();
        },
      }, t("card.detail")),
      h("button", {
        type: "button",
        "data-card-action": "duplicate",
        onclick: () => {
          const { puzzle, duplicated } = duplicateCardInPuzzle(this.puzzle, card.id);
          if (duplicated) this.selectedCardId = duplicated.id;
          this.updatePuzzle(puzzle);
        },
      }, t("editor.card.duplicate")),
      h("button.warnbtn", {
        type: "button",
        "data-card-action": "delete",
        onclick: () => {
          const next = removeCardFromPuzzle(this.puzzle, card.id);
          this.selectedCardId = null;
          this.updatePuzzle(next);
        },
      }, t("editor.card.delete")),
      h("button", {
        type: "button",
        title: t("card.close"),
        onclick: () => {
          this.selectedCardId = null;
          this.render();
        },
      }, "×"),
    );

    // ゾーン・オーナー移動
    const moveRow = h("div.erow", null,
      h("span.elbl", null, t("editor.card.moveZone")),
      h("div.ebtns.ezones", null,
        (["p1", "p2"] as const).map((pid) =>
          h("button" + (playerId === pid ? ".on" : ""), {
            type: "button",
            onclick: () => {
              this.targetPlayer = pid;
              this.syncOpenZoneForTarget();
              this.updatePuzzle(moveCardInPuzzle(this.puzzle, card.id, pid, zone));
            },
          }, pid === "p1" ? t("player.you") : t("player.opponent")),
        ),
        ZONES.map((z) =>
          h("button" + (zone === z ? ".on" : ""), {
            type: "button",
            disabled: z === "battlefield" && !canBeOnBattlefield,
            onclick: () => {
              this.targetZone = z;
              this.syncOpenZoneForTarget();
              this.updatePuzzle(moveCardInPuzzle(this.puzzle, card.id, playerId, z));
            },
          }, zoneLabel(z)),
        ),
      ),
    );

    // ライブラリー等の順序変更（2枚以上あるとき）
    const orderRow = zoneList.length > 1
      ? h("div.erow", null,
          h("span.elbl", null, `#${loc.index + 1}/${zoneList.length}`),
          h("div.ebtns", null,
            h("button", {
              type: "button",
              disabled: loc.index === 0,
              onclick: () => this.updatePuzzle(moveCardOrderInZone(this.puzzle, card.id, "top")),
            }, t("editor.card.moveTop")),
            h("button", {
              type: "button",
              disabled: loc.index === 0,
              onclick: () => this.updatePuzzle(moveCardOrderInZone(this.puzzle, card.id, "left")),
            }, "←"),
            h("button", {
              type: "button",
              disabled: loc.index === zoneList.length - 1,
              onclick: () => this.updatePuzzle(moveCardOrderInZone(this.puzzle, card.id, "right")),
            }, "→"),
            h("button", {
              type: "button",
              disabled: loc.index === zoneList.length - 1,
              onclick: () => this.updatePuzzle(moveCardOrderInZone(this.puzzle, card.id, "bottom")),
            }, t("editor.card.moveBottom")),
          ),
        )
      : null;

    // 戦場での状態（タップ・召喚酔い）とカウンター
    const stateRow = zone === "battlefield"
      ? h("div.erow", null,
          h("span.elbl", null, t("editor.card.state")),
          h("div.ebtns", null,
            h("button" + (card.tapped ? ".on" : ""), {
              type: "button",
              "data-toggle": "tapped",
              onclick: () => this.updatePuzzle(toggleCardProp(this.puzzle, card.id, "tapped")),
            }, manaNodes(`{T} ${t("card.tappedState")}`)),
            isCreature
              ? h("button" + (card.summoningSick ? ".on" : ""), {
                  type: "button",
                  "data-toggle": "summoningSick",
                  onclick: () => this.updatePuzzle(toggleCardProp(this.puzzle, card.id, "summoningSick")),
                }, t("card.sick"))
              : null,
          ),
        )
      : null;

    const countersRow = zone === "battlefield"
      ? h("div.erow", null,
          h("span.elbl", null, t("editor.card.counters")),
          h("div.ecounters", null,
            EDITABLE_COUNTERS.map((ck) => {
              const cur = card.counters?.[ck] ?? 0;
              return h("div.ecounter", null,
                h("span.eclbl", null, t(`counter.${ck}` as MessageKey)),
                h("button", {
                  type: "button",
                  disabled: cur <= 0,
                  onclick: () => this.updatePuzzle(setCardCounter(this.puzzle, card.id, ck, cur - 1)),
                }, "−"),
                h("span.ecval", null, cur),
                h("button", {
                  type: "button",
                  onclick: () => this.updatePuzzle(setCardCounter(this.puzzle, card.id, ck, cur + 1)),
                }, "＋"),
              );
            }),
          ),
        )
      : null;

    return h("div.eselbox", null, head, moveRow, orderRow, stateRow, countersRow);
  }

  // ---------------------------------------------------------------- タブ 2: 盤面・プレイヤー・ルール設定

  private buildSettingsTab(): HTMLElement {
    const p1 = this.puzzle.game.players[0];
    const p2 = this.puzzle.game.players[1];

    const playerBlock = (pl: PlayerDef, label: string) => {
      const life = pl.life ?? 20;
      const pool = parseManaPool(pl.manaPool);
      return h("div.epblock", null,
        h("div.erow", null,
          h("strong.elbl", null, label),
          h("span.elbl", null, t("player.life")),
          h("div.ebtns", null,
            ([-5, -1, 1, 5] as const).map((d) =>
              h("button", {
                type: "button",
                onclick: () => this.updatePuzzle(setPlayerLife(this.puzzle, pl.id, life + d)),
              }, d > 0 ? `+${d}` : String(d)),
            ),
            h("input.elifein", {
              type: "number",
              "data-life-input": pl.id,
              value: String(life),
              onchange: (ev: Event) => {
                const v = Number((ev.target as HTMLInputElement).value);
                if (Number.isFinite(v)) this.updatePuzzle(setPlayerLife(this.puzzle, pl.id, v));
              },
            }),
          ),
        ),
        h("div.erow", null,
          h("span.elbl", null, t("editor.settings.manaPool")),
          h("div.ebtns.emana", null,
            MANA_COLORS.map((c) => {
              const n = pool[c] ?? 0;
              return h("button.mpipbtn" + (n ? ".on" : ""), {
                type: "button",
                title: `{${c}} ×${n}`,
                onclick: () => this.updatePuzzle(adjustPlayerMana(this.puzzle, pl.id, c, 1)),
                oncontextmenu: (ev: Event) => {
                  ev.preventDefault();
                  this.updatePuzzle(adjustPlayerMana(this.puzzle, pl.id, c, -1));
                },
              }, manaNodes(`{${c}}`), n ? ` ×${n}` : "");
            }),
            pl.manaPool
              ? h("button", {
                  type: "button",
                  onclick: () => this.updatePuzzle(clearPlayerMana(this.puzzle, pl.id)),
                }, t("editor.settings.manaClear"))
              : null,
          ),
        ),
      );
    };

    const curPhase = this.puzzle.game.phase.toUpperCase();
    const curBlock = this.puzzle.opponent?.block ?? "minimize";

    return h("div.esettings", null,
      h("h3", null, t("editor.settings.players")),
      playerBlock(p1, `${t("player.you")} (p1)`),
      playerBlock(p2, `${t("player.opponent")} (p2)`),

      h("h3", null, t("editor.settings.game")),
      h("div.erow", null,
        h("span.elbl", null, t("editor.settings.activePlayer")),
        h("div.ebtns", null,
          (["p1", "p2"] as const).map((pid) =>
            h("button" + (this.puzzle.game.activePlayer === pid ? ".on" : ""), {
              type: "button",
              onclick: () => {
                const next = clonePuzzle(this.puzzle);
                next.game.activePlayer = pid;
                this.updatePuzzle(next);
              },
            }, pid === "p1" ? t("player.you") : t("player.opponent")),
          ),
        ),
      ),
      h("div.erow", null,
        h("span.elbl", null, t("editor.settings.phase")),
        h("select.eselect", {
          "data-setting": "phase",
          onchange: (ev: Event) => {
            const next = clonePuzzle(this.puzzle);
            next.game.phase = (ev.target as HTMLSelectElement).value;
            this.updatePuzzle(next);
          },
        }, EDITABLE_PHASES.map((ph) =>
          h("option", { value: ph, selected: curPhase === ph ? "selected" : null }, `${phaseName(ph)} (${ph})`),
        )),
      ),
      h("div.erow", null,
        h("span.elbl", null, t("editor.settings.oppBlock")),
        h("div.ebtns", null,
          (["minimize", "none"] as const).map((blk) =>
            h("button" + (curBlock === blk ? ".on" : ""), {
              type: "button",
              onclick: () => {
                const next = clonePuzzle(this.puzzle);
                next.opponent = { policy: "pass", block: blk };
                this.updatePuzzle(next);
              },
            }, t(`editor.settings.block.${blk}` as MessageKey)),
          ),
        ),
      ),

      h("h3", null, t("editor.settings.meta")),
      h("div.erow", null,
        h("span.elbl", null, t("editor.settings.title")),
        h("input.etextin", {
          type: "text",
          "data-setting": "title",
          value: this.puzzle.title,
          oninput: (ev: Event) => {
            const val = (ev.target as HTMLInputElement).value;
            this.puzzle.title = val || t("editor.defaultTitle");
            this.jsonDraftText = JSON.stringify(this.puzzle, null, 2);
            saveEditorDraft(this.puzzle);
            const titleEl = this.el.querySelector(".bar > .ptitle");
            if (titleEl) titleEl.textContent = this.puzzle.title;
          },
        }),
      ),
      h("div.erow", null,
        h("span.elbl", null, t("editor.settings.description")),
        h("textarea.edescin", {
          rows: 2,
          "data-setting": "description",
          oninput: (ev: Event) => {
            const val = (ev.target as HTMLTextAreaElement).value;
            if (val) this.puzzle.description = val;
            else delete this.puzzle.description;
            this.jsonDraftText = JSON.stringify(this.puzzle, null, 2);
            saveEditorDraft(this.puzzle);
          },
        }, this.puzzle.description ?? ""),
      ),
    );
  }

  // ---------------------------------------------------------------- タブ 3: テンプレート読み込み & JSON 入出力

  private buildDataTab(): HTMLElement {
    const templateRow = h("div.erow", null,
      h("select.eselect", {
        "data-template-select": "1",
        onchange: (ev: Event) => {
          this.selectedTemplateId = (ev.target as HTMLSelectElement).value;
        },
      }, this.catalogEntries.map((e) =>
        h("option", {
          value: e.id,
          selected: e.id === this.selectedTemplateId ? "selected" : null,
        }, `${e.id}: ${e.title}`),
      )),
      h("button", {
        type: "button",
        disabled: !this.selectedTemplateId,
        onclick: () => {
          if (this.selectedTemplateId) void this.loadTemplateById(this.selectedTemplateId);
        },
      }, t("editor.data.loadTemplate")),
      h("button.warnbtn", {
        type: "button",
        "data-action": "reset-empty",
        onclick: () => this.setPuzzle(createEmptyPuzzle()),
      }, t("editor.data.resetEmpty")),
    );

    const copyShareUrl = async (mode: "play" | "edit", includeSolutionParam = false) => {
      try {
        const normalized = normalizePuzzleForEngine(this.puzzle);
        const url = await buildShareUrl(
          normalized,
          mode,
          undefined,
          includeSolutionParam ? this.puzzle.solution : undefined,
        );
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          this.jsonDraftText = url;
        }
        if (url.length > MAX_SHARE_URL_LENGTH) {
          this.dataFeedback = {
            text: t("editor.data.urlTooLong", { n: url.length, length: url.length, max: MAX_SHARE_URL_LENGTH }),
            isError: true,
          };
        } else {
          this.dataFeedback = {
            text: t("editor.data.copiedUrl", { n: url.length, length: url.length }),
            isError: false,
          };
        }
        this.render();
      } catch (e) {
        this.dataFeedback = { text: String(e), isError: true };
        this.render();
      }
    };

    const urlButtons = h("div.ebtns", null,
      h("button.on", {
        type: "button",
        "data-action": "copy-play-url",
        onclick: () => void copyShareUrl("play"),
      }, t("editor.data.copyPlayUrl")),
      h("button", {
        type: "button",
        "data-action": "copy-edit-url",
        onclick: () => void copyShareUrl("edit"),
      }, t("editor.data.copyEditUrl")),
    );

    const solSteps = this.puzzle.solution ?? [];
    const solutionSection = solSteps.length > 0
      ? h("div.esolbox", null,
          h("div.erow", null,
            h("span.chip", null, t("editor.solution.registered", { n: solSteps.length })),
            h("div.ebtns", null,
              h("button.on", {
                type: "button",
                "data-action": "copy-solution-url",
                onclick: () => void copyShareUrl("play", true),
              }, t("editor.solution.copyUrl")),
              h("button.warnbtn", {
                type: "button",
                "data-action": "clear-solution",
                onclick: () => {
                  const next = clonePuzzle(this.puzzle);
                  delete next.solution;
                  this.updatePuzzle(next);
                },
              }, t("editor.solution.clear")),
            ),
          ),
          h("details.solsteps", null,
            h("summary", null, t("solution.stepsList", { n: solSteps.length })),
            h("ol.sollist", null,
              solSteps.map((st) =>
                h("li", null, formatSolutionStep(st, displayName)),
              ),
            ),
          ),
        )
      : h("div.muted.enote", { "data-solution-empty": "1" }, t("editor.solution.none"));

    const jsonArea = h("textarea.ejson", {
      rows: 7,
      "data-json-textarea": "1",
      oninput: (ev: Event) => {
        this.jsonDraftText = (ev.target as HTMLTextAreaElement).value;
      },
    }, this.jsonDraftText);

    const jsonButtons = h("div.ebtns", null,
      h("button", {
        type: "button",
        "data-action": "copy-json",
        onclick: async () => {
          const text = JSON.stringify(this.puzzle, null, 2);
          this.jsonDraftText = text;
          try {
            await navigator.clipboard.writeText(text);
            this.dataFeedback = { text: t("editor.data.copied"), isError: false };
            this.render();
          } catch { /* クリップボード権限が無い環境 */ }
        },
      }, t("editor.data.copy")),
      h("button", {
        type: "button",
        "data-action": "download-json",
        onclick: () => {
          const blob = new Blob([JSON.stringify(this.puzzle, null, 2) + "\n"], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = h("a", { href: url, download: `${slugifyTitle(this.puzzle.title)}.json` });
          a.click();
          URL.revokeObjectURL(url);
        },
      }, t("editor.data.download")),
      h("button.on", {
        type: "button",
        "data-action": "import-json",
        onclick: async () => {
          try {
            const res = await parsePuzzleInput(this.jsonDraftText);
            if (!res.ok) {
              this.dataFeedback = { text: res.errors.join(" / "), isError: true };
              this.render();
              return;
            }
            this.dataFeedback = { text: t("editor.data.imported"), isError: false };
            this.setPuzzle(res.puzzle);
          } catch (e) {
            this.dataFeedback = { text: t("editor.data.invalidJson", { message: String(e) }), isError: true };
            this.render();
          }
        },
      }, t("editor.data.import")),
    );

    return h("div.edata", null,
      h("h3", null, t("editor.data.template")),
      templateRow,
      h("h3", null, t("editor.solution.title")),
      solutionSection,
      h("h3", null, t("editor.data.url")),
      urlButtons,
      h("h3", null, t("editor.data.json")),
      jsonButtons,
      this.dataFeedback
        ? h("div.enote" + (this.dataFeedback.isError ? ".err" : ".ok"), null, this.dataFeedback.text)
        : null,
      jsonArea,
    );
  }
}

function zoneLabel(z: ZoneKey): string {
  const map: Record<ZoneKey, MessageKey> = {
    hand: "zone.Hand",
    battlefield: "zone.Battlefield",
    graveyard: "zone.Graveyard",
    exile: "zone.Exile",
    library: "zone.Library",
  };
  return t(map[z]);
}

function slugifyTitle(title: string): string {
  const s = title.trim().replace(/\s+/g, "-").replace(/[\\/:*?"<>|]/g, "");
  return s || "puzzle";
}
