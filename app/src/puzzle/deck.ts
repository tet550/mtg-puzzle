// デッキ登録・管理・テキストインポート・マリガン・プレイテスト盤面生成。

import { lang, t } from "../i18n";
import { cardMeta, isCardDbLoaded, normalizeQuery, searchCards, type CardMeta } from "./carddb";
import { ENGINE_VERSION, SCHEMA_VERSION, type PuzzleJson } from "./schema";

export interface DeckEntry {
  cardId: string;
  count: number;
}

export interface DeckDef {
  id: string;
  name: string;
  description?: string;
  en?: {
    name?: string;
    description?: string;
  };
  cards: DeckEntry[];
  sideboard?: DeckEntry[];
  updatedAt: number;
}

export interface DeckParseUnknown {
  line: number;
  raw: string;
}

export interface DeckParseResult {
  cards: DeckEntry[];
  sideboard: DeckEntry[];
  unknown: DeckParseUnknown[];
}

export interface MulliganState {
  allCards: string[];
  mulliganCount: number;
  hand: string[];
  library: string[];
  /** キープ時にライブラリーの下に送る手札のインデックス */
  bottomIndices: number[];
}

const STORAGE_KEY = "mtg-puzzle.decks.v1";

export const SAMPLE_DECKS: DeckDef[] = [
  {
    id: "sample-mono-red",
    name: "赤単バーン (サンプル)",
    description: "軽量火力と速攻クリーチャーで20点を削り切る定番アグロデッキ",
    en: {
      name: "Mono-Red Burn (Sample)",
      description: "Classic aggro deck that burns out 20 life with efficient burn spells and haste creatures",
    },
    cards: [
      { cardId: "Monastery Swiftspear", count: 4 },
      { cardId: "Goblin Guide", count: 4 },
      { cardId: "Eidolon of the Great Revel", count: 4 },
      { cardId: "Lightning Bolt", count: 4 },
      { cardId: "Lava Spike", count: 4 },
      { cardId: "Rift Bolt", count: 4 },
      { cardId: "Skewer the Critics", count: 4 },
      { cardId: "Searing Blaze", count: 4 },
      { cardId: "Shock", count: 4 },
      { cardId: "Light Up the Stage", count: 4 },
      { cardId: "Mountain", count: 20 },
    ],
    sideboard: [],
    updatedAt: 1700000000000,
  },
  {
    id: "sample-mono-green",
    name: "緑単ストンピィ (サンプル)",
    description: "マナ加速から高スタッツのクリーチャーと強化呪文を展開するビートダウン",
    en: {
      name: "Mono-Green Stompy (Sample)",
      description: "Beatdown deck that ramps into high-stat creatures and pump spells",
    },
    cards: [
      { cardId: "Llanowar Elves", count: 4 },
      { cardId: "Elvish Mystic", count: 4 },
      { cardId: "Pelt Collector", count: 4 },
      { cardId: "Strangleroot Geist", count: 4 },
      { cardId: "Leatherback Baloth", count: 4 },
      { cardId: "Steel Leaf Champion", count: 4 },
      { cardId: "Ghalta, Primal Hunger", count: 2 },
      { cardId: "Giant Growth", count: 4 },
      { cardId: "Aspect of Hydra", count: 4 },
      { cardId: "Rancor", count: 4 },
      { cardId: "Forest", count: 22 },
    ],
    sideboard: [],
    updatedAt: 1700000001000,
  },
  {
    id: "sample-izzet-spells",
    name: "青赤果敢スペル (サンプル)",
    description: "軽量ドローと火力呪文を連打して果敢・トークンを誘発させるテンポデッキ",
    en: {
      name: "Izzet Prowess Spells (Sample)",
      description: "Tempo deck chaining cantrips and burn spells to trigger prowess and token makers",
    },
    cards: [
      { cardId: "Monastery Swiftspear", count: 4 },
      { cardId: "Stormchaser Mage", count: 4 },
      { cardId: "Young Pyromancer", count: 4 },
      { cardId: "Opt", count: 4 },
      { cardId: "Consider", count: 4 },
      { cardId: "Lightning Bolt", count: 4 },
      { cardId: "Shock", count: 4 },
      { cardId: "Unsummon", count: 4 },
      { cardId: "Expressive Iteration", count: 4 },
      { cardId: "Treasure Cruise", count: 4 },
      { cardId: "Island", count: 10 },
      { cardId: "Mountain", count: 10 },
    ],
    sideboard: [],
    updatedAt: 1700000002000,
  },
];

/** 現在の表示言語に合わせたデッキ名を返す（未変更のサンプルデッキは JA/EN 自動切替） */
export function deckTitle(deck: Pick<DeckDef, "name"> & { id?: string; en?: { name?: string } }): string {
  const sample = deck.id ? SAMPLE_DECKS.find((s) => s.id === deck.id) : undefined;
  if (sample && (deck.name === sample.name || deck.name === sample.en?.name)) {
    return lang() === "en" ? (sample.en?.name ?? sample.name) : sample.name;
  }
  if (lang() === "en" && deck.en?.name) return deck.en.name;
  return deck.name;
}

/** 現在の表示言語に合わせたデッキ説明を返す（未変更のサンプルデッキは JA/EN 自動切替） */
export function deckDescription(deck: Pick<DeckDef, "description"> & { id?: string; en?: { description?: string } }): string {
  const raw = deck.description ?? "";
  const sample = deck.id ? SAMPLE_DECKS.find((s) => s.id === deck.id) : undefined;
  if (sample && (raw === (sample.description ?? "") || raw === (sample.en?.description ?? ""))) {
    return lang() === "en" ? (sample.en?.description ?? raw) : (sample.description ?? raw);
  }
  if (lang() === "en" && deck.en?.description) return deck.en.description;
  return raw;
}

/** デッキの合計枚数を返す */
export function deckTotalCount(entries: readonly DeckEntry[]): number {
  let sum = 0;
  for (const e of entries) {
    if (e.count > 0) sum += e.count;
  }
  return sum;
}

/** 同じ cardId のエントリをまとめる（0 以下の枚数は除く） */
export function normalizeDeckEntries(entries: readonly DeckEntry[]): DeckEntry[] {
  const map = new Map<string, number>();
  for (const e of entries) {
    const id = e.cardId.trim();
    const n = Math.floor(e.count);
    if (!id || !Number.isFinite(n) || n <= 0) continue;
    map.set(id, (map.get(id) ?? 0) + n);
  }
  return [...map.entries()].map(([cardId, count]) => ({ cardId, count }));
}

/**
 * カード名（英語名・日本語名・MTGアリーナ形式のセット記号付きなど）から CardMeta を引く。
 * カードDBが未ロードのときは null を返す。
 */
export function resolveCardName(raw: string): CardMeta | null {
  if (!isCardDbLoaded()) return null;
  let cleaned = raw
    .trim()
    // MTG Arena のセット・コレクター番号 ("Lightning Bolt (STA) 42", "稲妻 (M11) 149 *F*") を除去
    .replace(/\s*\([A-Za-z0-9]{2,6}\)\s*[A-Za-z0-9★☆*-]*(\s+\*[A-Za-z]+\*)*\s*$/, "")
    .replace(/\s+\*[A-Za-z]+\*\s*$/, "")
    .trim();
  if (!cleaned) return null;

  // スラッシュ区切り ("Fire / Ice", "火 / 氷", "砕骨の巨人/踏みつけ") を正規化
  const slashNorm = cleaned.replace(/\s*\/\/?\s*/g, " // ");
  const direct = cardMeta(slashNorm) ?? cardMeta(cleaned);
  if (direct) return direct;

  // 片面名（"砕骨の巨人 // 踏みつけ" の前半だけ）でも試す
  const frontPart = slashNorm.split(" // ")[0].trim();
  const candidates = searchCards(cleaned, 10);
  const qNorm = normalizeQuery(cleaned);
  const qFrontNorm = normalizeQuery(frontPart);

  for (const c of candidates) {
    const enLower = c.name.toLowerCase();
    const jaNorm = c.jaName ? normalizeQuery(c.jaName) : "";
    const altEn = c.altNames.map((a) => a.toLowerCase());
    const altJa = c.altJaNames.map((a) => normalizeQuery(a));
    if (
      enLower === qNorm ||
      jaNorm === qNorm ||
      altEn.includes(qNorm) ||
      altJa.includes(qNorm) ||
      enLower === qFrontNorm ||
      jaNorm === qFrontNorm ||
      altEn.includes(qFrontNorm) ||
      altJa.includes(qFrontNorm)
    ) {
      return c;
    }
  }

  if (frontPart !== cleaned) {
    const frontCandidates = searchCards(frontPart, 5);
    for (const c of frontCandidates) {
      const enLower = c.name.toLowerCase();
      const jaNorm = c.jaName ? normalizeQuery(c.jaName) : "";
      const altEn = c.altNames.map((a) => a.toLowerCase());
      const altJa = c.altJaNames.map((a) => normalizeQuery(a));
      if (
        enLower === qFrontNorm ||
        jaNorm === qFrontNorm ||
        altEn.includes(qFrontNorm) ||
        altJa.includes(qFrontNorm)
      ) {
        return c;
      }
    }
  }

  return null;
}

const MAIN_HEADERS = new Set([
  "deck",
  "main",
  "maindeck",
  "mainboard",
  "メイン",
  "メインデッキ",
  "デッキ",
]);

const SIDE_HEADERS = new Set([
  "sideboard",
  "side",
  "sb",
  "サイド",
  "サイドボード",
]);

const IGNORE_HEADERS = new Set([
  "commander",
  "companion",
  "統率者",
  "相棒",
]);

/**
 * デッキリスト文字列（MTGアリーナ / MO / 一般的なテキスト形式）を解析する。
 * 例:
 *   4 Lightning Bolt
 *   4 稲妻 (STA) 42
 *   4x Monastery Swiftspear
 *   山 x20
 */
export function parseDeckList(text: string): DeckParseResult {
  const main: DeckEntry[] = [];
  const side: DeckEntry[] = [];
  const unknown: DeckParseUnknown[] = [];
  let inSideboard = false;

  const lines = text.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const rawLine = lines[idx].trim();
    if (!rawLine || rawLine.startsWith("#") || rawLine.startsWith("//")) continue;

    const headerKey = rawLine.replace(/[:：]\s*$/, "").trim().toLowerCase();
    if (MAIN_HEADERS.has(headerKey)) {
      inSideboard = false;
      continue;
    }
    if (SIDE_HEADERS.has(headerKey)) {
      inSideboard = true;
      continue;
    }
    if (IGNORE_HEADERS.has(headerKey)) {
      continue;
    }

    let targetSide = inSideboard;
    let body = rawLine;
    const sbMatch = body.match(/^(?:SB|サイド)\s*[:：]\s*(.+)$/i);
    if (sbMatch) {
      targetSide = true;
      body = sbMatch[1].trim();
    }

    let count = 1;
    let cardNameRaw = body;

    // パターン1: 先頭に枚数 ("4 Lightning Bolt", "4x 稲妻", "4× 山", "4枚 稲妻")
    const leadMatch = body.match(/^(\d+)\s*(?:[xX×]|枚)?\s+(.+)$/);
    if (leadMatch) {
      count = Number(leadMatch[1]);
      cardNameRaw = leadMatch[2].trim();
    } else {
      // パターン2: 末尾に枚数 ("稲妻 x4", "稲妻 ×4", "稲妻 4枚")
      const trailMatch = body.match(/^(.+?)\s+(?:[xX×]\s*(\d+)|(\d+)\s*枚)$/);
      if (trailMatch) {
        cardNameRaw = trailMatch[1].trim();
        count = Number(trailMatch[2] ?? trailMatch[3]);
      }
    }

    if (!Number.isFinite(count) || count <= 0) continue;

    const resolved = resolveCardName(cardNameRaw);
    if (resolved) {
      (targetSide ? side : main).push({ cardId: resolved.name, count });
    } else if (!isCardDbLoaded()) {
      // カードDB未ロード時のフォールバック（テストやオフライン時）
      const fallbackName = cardNameRaw
        .replace(/\s*\([A-Za-z0-9]{2,6}\)\s*[A-Za-z0-9★☆*-]*(\s+\*[A-Za-z]+\*)*\s*$/, "")
        .trim();
      if (fallbackName) {
        (targetSide ? side : main).push({ cardId: fallbackName, count });
      }
    } else {
      unknown.push({ line: lineNo, raw: rawLine });
    }
  }

  return {
    cards: normalizeDeckEntries(main),
    sideboard: normalizeDeckEntries(side),
    unknown,
  };
}

/** デッキをテキスト形式（MTGアリーナ互換）に整形する */
export function formatDeckList(
  deck: Pick<DeckDef, "cards" | "sideboard">,
  lang: "ja" | "en" = "ja",
): string {
  const formatEntry = (e: DeckEntry): string => {
    if (lang === "ja") {
      const m = cardMeta(e.cardId);
      const name = m?.jaName ? m.jaName.split(" // ")[0] : e.cardId;
      return `${e.count} ${name}`;
    }
    return `${e.count} ${e.cardId}`;
  };

  const lines: string[] = [];
  for (const e of deck.cards) {
    if (e.count > 0) lines.push(formatEntry(e));
  }
  const sb = (deck.sideboard ?? []).filter((e) => e.count > 0);
  if (sb.length > 0) {
    lines.push("");
    lines.push("Sideboard");
    for (const e of sb) {
      lines.push(formatEntry(e));
    }
  }
  return lines.join("\n");
}

/** localStorage から登録済みデッキ一覧を読み込む（初回はサンプルデッキを返す） */
export function loadDecks(): DeckDef[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const initial = SAMPLE_DECKS.map((d) => ({
        ...d,
        cards: d.cards.map((c) => ({ ...c })),
        sideboard: (d.sideboard ?? []).map((c) => ({ ...c })),
      }));
      saveDecks(initial);
      return initial;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: DeckDef[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.id !== "string" || typeof obj.name !== "string" || !Array.isArray(obj.cards)) continue;
      const cards = normalizeDeckEntries(
        obj.cards.filter(
          (c): c is DeckEntry =>
            typeof c === "object" &&
            c !== null &&
            typeof (c as DeckEntry).cardId === "string" &&
            typeof (c as DeckEntry).count === "number",
        ),
      );
      const sideboard = Array.isArray(obj.sideboard)
        ? normalizeDeckEntries(
            obj.sideboard.filter(
              (c): c is DeckEntry =>
                typeof c === "object" &&
                c !== null &&
                typeof (c as DeckEntry).cardId === "string" &&
                typeof (c as DeckEntry).count === "number",
            ),
          )
        : [];
      const sample = SAMPLE_DECKS.find((s) => s.id === obj.id);
      const enObj = typeof obj.en === "object" && obj.en !== null ? (obj.en as Record<string, unknown>) : null;
      const en = enObj
        ? {
            ...(typeof enObj.name === "string" ? { name: enObj.name } : {}),
            ...(typeof enObj.description === "string" ? { description: enObj.description } : {}),
          }
        : sample?.en;
      out.push({
        id: obj.id,
        name: obj.name,
        ...(typeof obj.description === "string" ? { description: obj.description } : {}),
        ...(en && (en.name || en.description) ? { en } : {}),
        cards,
        sideboard,
        updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : Date.now(),
      });
    }
    return out;
  } catch {
    return SAMPLE_DECKS;
  }
}

/** デッキ一覧を localStorage に保存する */
export function saveDecks(decks: readonly DeckDef[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(decks));
  } catch {
    // プライベートブラウジング等で書けない場合は無視
  }
}

/** 1 件のデッキを追加または上書き保存する */
export function saveDeck(deck: DeckDef): DeckDef[] {
  const decks = loadDecks();
  const normalized: DeckDef = {
    ...deck,
    name: deck.name.trim() || t("deck.untitledName"),
    cards: normalizeDeckEntries(deck.cards),
    sideboard: normalizeDeckEntries(deck.sideboard ?? []),
    updatedAt: Date.now(),
  };
  const idx = decks.findIndex((d) => d.id === normalized.id);
  if (idx >= 0) {
    decks[idx] = normalized;
  } else {
    decks.unshift(normalized);
  }
  saveDecks(decks);
  return decks;
}

/** 指定 ID のデッキを削除する */
export function deleteDeck(id: string): DeckDef[] {
  const decks = loadDecks().filter((d) => d.id !== id);
  saveDecks(decks);
  return decks;
}

/** サンプルデッキを復元する（既存の同名IDが無ければ追加） */
export function restoreSampleDecks(): DeckDef[] {
  const decks = loadDecks();
  for (const sample of SAMPLE_DECKS) {
    if (!decks.some((d) => d.id === sample.id)) {
      decks.push({
        ...sample,
        cards: sample.cards.map((c) => ({ ...c })),
        sideboard: (sample.sideboard ?? []).map((c) => ({ ...c })),
        updatedAt: Date.now(),
      });
    }
  }
  saveDecks(decks);
  return decks;
}

/** デッキエントリを1枚ずつのカードID配列に展開する */
export function expandDeckCards(entries: readonly DeckEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const n = Math.max(0, Math.floor(e.count));
    for (let i = 0; i < n; i++) {
      out.push(e.cardId);
    }
  }
  return out;
}

/** Fisher-Yates シャッフル */
export function shuffleCards(cards: readonly string[], rng: () => number = Math.random): string[] {
  const arr = [...cards];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** ロンドン・マリガンの初期状態を作る（7枚引き、マリガン回数 0） */
export function startMulligan(entries: readonly DeckEntry[], rng: () => number = Math.random): MulliganState {
  const allCards = expandDeckCards(entries);
  const shuffled = shuffleCards(allCards, rng);
  const handSize = Math.min(7, shuffled.length);
  return {
    allCards,
    mulliganCount: 0,
    hand: shuffled.slice(0, handSize),
    library: shuffled.slice(handSize),
    bottomIndices: [],
  };
}

/** マリガンを実行する（ライブラリーを混ぜ直して7枚引き直し、マリガン回数を+1） */
export function mulliganAgain(state: MulliganState, rng: () => number = Math.random): MulliganState {
  const nextCount = Math.min(6, state.mulliganCount + 1);
  const shuffled = shuffleCards(state.allCards, rng);
  const handSize = Math.min(7, shuffled.length);
  return {
    allCards: state.allCards,
    mulliganCount: nextCount,
    hand: shuffled.slice(0, handSize),
    library: shuffled.slice(handSize),
    bottomIndices: [],
  };
}

/** ロンドン・マリガンでライブラリーの下に送る手札カードの選択を切り替える */
export function toggleBottomCard(state: MulliganState, handIndex: number): MulliganState {
  const needed = Math.min(state.mulliganCount, state.hand.length);
  if (needed <= 0 || handIndex < 0 || handIndex >= state.hand.length) return state;
  const exists = state.bottomIndices.includes(handIndex);
  let next: number[];
  if (exists) {
    next = state.bottomIndices.filter((i) => i !== handIndex);
  } else {
    if (state.bottomIndices.length >= needed) {
      // 既に必要枚数選ばれていたら、一番古く選んだものを外して入れ替える
      next = [...state.bottomIndices.slice(1), handIndex];
    } else {
      next = [...state.bottomIndices, handIndex];
    }
  }
  return { ...state, bottomIndices: next };
}

/** キープ可能か（マリガン回数分のボトム送りが選択済みか） */
export function canKeepHand(state: MulliganState): boolean {
  const needed = Math.min(state.mulliganCount, state.hand.length);
  return state.bottomIndices.length === needed;
}

/** キープを確定し、選択されたカードをライブラリーの一番下に送った手札とライブラリーを返す */
export function finalizeKeep(state: MulliganState): { hand: string[]; library: string[] } {
  const bottomSet = new Set(state.bottomIndices);
  const hand = state.hand.filter((_, idx) => !bottomSet.has(idx));
  const bottomCards = state.bottomIndices
    .filter((idx) => idx >= 0 && idx < state.hand.length)
    .map((idx) => state.hand[idx]);
  const library = [...state.library, ...bottomCards];
  return { hand, library };
}

export interface PlaytestOptions {
  playerLife?: number;
  opponentLife?: number;
  opponentBlock?: "minimize" | "none";
}

/**
 * 確定した初手とライブラリーから、一人回し（プレイテスト）用の PuzzleJson を組み立てる。
 * - goal.deadline は "none"（ターン制限なし）
 * - 対戦相手 (p2) はライフ 20・ライブラリー 60 枚のサンドバッグ（自動パス）
 */
export function buildPlaytestPuzzle(
  deck: Pick<DeckDef, "name"> & { id?: string; en?: { name?: string; description?: string } },
  hand: readonly string[],
  library: readonly string[],
  opts: PlaytestOptions = {},
): PuzzleJson {
  const playerLife = opts.playerLife ?? 20;
  const opponentLife = opts.opponentLife ?? 20;
  const opponentBlock = opts.opponentBlock ?? "minimize";
  const sample = deck.id ? SAMPLE_DECKS.find((s) => s.id === deck.id) : undefined;
  const isUnmodifiedSample = sample && (deck.name === sample.name || deck.name === sample.en?.name);
  const jaName = isUnmodifiedSample ? sample.name : deck.name;
  const enName = isUnmodifiedSample ? (sample.en?.name ?? deck.name) : (deck.en?.name ?? deck.name);

  return {
    schemaVersion: SCHEMA_VERSION,
    title: `${jaName} — 一人回し`,
    description: "デッキの初手とドローを確認しながら制限ターンなしで一人回しできます。",
    en: {
      title: `${enName} — Playtest`,
      description: "Playtest your deck across multiple turns with no turn limit.",
    },
    engine: { type: "forge", version: ENGINE_VERSION },
    game: {
      activePlayer: "p1",
      phase: "main1",
      turn: 1,
      players: [
        {
          id: "p1",
          life: playerLife,
          hand: hand.map((cardId, i) => ({ id: `h${i + 1}`, cardId })),
          library: library.map((cardId, i) => ({ id: `l${i + 1}`, cardId })),
        },
        {
          id: "p2",
          life: opponentLife,
          library: Array.from({ length: 60 }, (_, i) => ({ id: `ol${i + 1}`, cardId: "Plains" })),
        },
      ],
    },
    goal: { type: "win", player: "p1", deadline: "none" },
    opponent: { policy: "pass", block: opponentBlock },
  };
}

/**
 * 共有された一人回し用 PuzzleJson（deadline === "none"）から、
 * 「🎲 初手を引き直す」等で使う DeckDef を復元する。
 */
export function extractDeckFromPlaytestPuzzle(puzzle: PuzzleJson): DeckDef | null {
  if (puzzle.goal.deadline !== "none") return null;
  const p1 = puzzle.game.players.find((p) => p.id === puzzle.goal.player) ?? puzzle.game.players[0];
  if (!p1) return null;

  const rawEntries: DeckEntry[] = [];
  for (const z of ["hand", "battlefield", "graveyard", "exile", "library"] as const) {
    for (const c of p1[z] ?? []) {
      if (c.token) continue;
      rawEntries.push({ cardId: c.cardId, count: 1 });
    }
  }
  const cards = normalizeDeckEntries(rawEntries);
  if (cards.length === 0) return null;

  const cleanJaName = puzzle.title.replace(/\s*(?:—|-)\s*(?:一人回し|Playtest)\s*$/i, "").trim() || puzzle.title;
  const cleanEnName = puzzle.en?.title
    ? puzzle.en.title.replace(/\s*(?:—|-)\s*(?:一人回し|Playtest)\s*$/i, "").trim()
    : undefined;

  const sample = SAMPLE_DECKS.find((s) => s.name === cleanJaName || s.en?.name === cleanJaName || (cleanEnName && s.en?.name === cleanEnName));

  return {
    id: sample?.id ?? "shared-playtest",
    name: cleanJaName,
    ...(cleanEnName ? { en: { name: cleanEnName } } : sample?.en ? { en: sample.en } : {}),
    cards,
    sideboard: [],
    updatedAt: Date.now(),
  };
}
