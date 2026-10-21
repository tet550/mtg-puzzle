// カードの画像と日本語の名前・文（Scryfall）。
// 同梱の問題のカードは、ビルド時に tools/card-images.py で作った一覧（public/cards.json）を使う。
// 一覧に無いカード（URL で渡された問題など）は、問題を開いたときに Scryfall の API で引き、この端末に覚える（ensureCardImages）。
// 日本語の画面では、日本語版の画像・名前・印刷された文があればそれを使う（無ければ英語版）。
// 画像を出すかどうかは表示の設定で切り替え、この端末に覚える。

import { lang } from "../i18n";

export interface CardImage {
  normal: string;
  small: string;
  artist?: string;
  /** 日本語版（あれば） */
  ja?: { name: string; normal?: string; small?: string; artist?: string; text?: string };
}

const BASE = import.meta.env.BASE_URL;
const KEY = "mtg-puzzle.images";
/** 実行時に Scryfall で引いた結果（見つからなかった名前は null）。cards.json と同じ形 */
const CACHE_KEY = "mtg-puzzle.cardImages.v1";
const API = "https://api.scryfall.com";
let table: Record<string, CardImage> = {};
let fetched: Record<string, CardImage | null> = {};

export async function loadCardImages(): Promise<void> {
  try {
    fetched = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") as Record<string, CardImage | null>;
  } catch {
    fetched = {};
  }
  try {
    const res = await fetch(`${BASE}cards.json`);
    if (res.ok) table = (await res.json()) as Record<string, CardImage>;
  } catch {
    // 一覧が無くても文字のカード（英語の名前）で遊べる
  }
}

/**
 * names のうち、画像の一覧にも端末の記録にも無いカードを Scryfall で引く（tools/card-images.py と同じ引き方）。
 * 英語版は /cards/collection でまとめて（75 枚ずつ）、日本語版はカードごとに検索する。
 * 新しく分かったカードがあれば true（呼び出し側で描き直す）。通信に失敗しても例外にはしない（文字のカードで遊べる）
 */
export async function ensureCardImages(names: string[]): Promise<boolean> {
  const missing = [...new Set(names)].filter((n) => !entry(n) && !(n in fetched));
  if (missing.length === 0) return false;
  let changed = false;
  for (let i = 0; i < missing.length; i += 75) {
    const chunk = missing.slice(i, i + 75);
    const data = await api<{ data?: ScryfallCard[] }>("/cards/collection", { identifiers: chunk.map((name) => ({ name })) });
    if (!data) return changed;
    const found = new Map<string, CardImage>();
    for (const card of data.data ?? []) {
      const img = imageOf(card);
      if (!img) continue;
      found.set(card.name, img);
      // 両面・分割カードは "A // B" の名前で返る。Forge の名前（1 面目）でも引けるようにする
      if (!found.has(card.name.split(" // ")[0])) found.set(card.name.split(" // ")[0], img);
    }
    for (const n of chunk) {
      const img = found.get(n) ?? null;
      if (img) {
        // 検索の API は間隔を空けて呼ぶ（Scryfall のお願い）
        await sleep(100);
        const ja = japaneseOf(await api<{ data?: ScryfallCard[] }>(`/cards/search?q=${encodeURIComponent(`!"${n}" lang:ja`)}&unique=prints&order=released&dir=desc`));
        if (ja) img.ja = ja;
      }
      fetched[n] = img;
      changed ||= !!img;
    }
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(fetched));
  } catch {
    // 覚えられなくても、この表示の間は効く
  }
  return changed;
}

interface ScryfallFace {
  printed_name?: string;
  printed_text?: string;
  image_uris?: { normal?: string; small?: string };
}

export interface ScryfallCard extends ScryfallFace {
  name: string;
  artist?: string;
  promo?: boolean;
  full_art?: boolean;
  frame_effects?: string[];
  border_color?: string;
  card_faces?: ScryfallFace[];
}

/** 表の面の画像（両面カードは 1 面目） */
export function imageOf(card: ScryfallCard): CardImage | null {
  const uris = card.image_uris ?? card.card_faces?.[0]?.image_uris;
  if (!uris?.normal || !uris.small) return null;
  return { normal: uris.normal, small: uris.small, ...(card.artist ? { artist: card.artist } : {}) };
}

/** 日本語版の検索結果（新しい順）から、通常の版で最新のもの（無ければ特殊な版。日本語版が無ければ undefined） */
export function japaneseOf(result: { data?: ScryfallCard[] } | null): CardImage["ja"] {
  const plain = (c: ScryfallCard) => !(c.promo || c.full_art || c.frame_effects?.length || c.border_color === "borderless");
  const cards = (result?.data ?? []).filter((c) => c.printed_name || c.card_faces?.[0]?.printed_name);
  const card = cards.find(plain) ?? cards[0];
  if (!card) return undefined;
  const face = card.card_faces?.[0] ?? card;
  const img = imageOf(card);
  const ja: NonNullable<CardImage["ja"]> = { name: (card.printed_name ?? face.printed_name)! };
  if (img) Object.assign(ja, { normal: img.normal, small: img.small }, img.artist ? { artist: img.artist } : {});
  const text = card.printed_text ?? face.printed_text;
  if (text) ja.text = text;
  return ja;
}

/** Scryfall の API（見つからない・通信できないときは null。429 は少し待って 1 回だけやり直す） */
async function api<T>(path: string, body?: unknown): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(API + path, body === undefined
        ? { headers: { Accept: "application/json" } }
        : { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (res.status === 429) {
        await sleep(Number(res.headers.get("Retry-After")) * 1000 || 2000);
        continue;
      }
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function entry(name: string): CardImage | null {
  const front = name.split(" // ")[0];
  return table[name] ?? table[front] ?? fetched[name] ?? fetched[front] ?? null;
}

/** 画面の言語に合わせたカードの画像（無ければ null） */
export function cardImage(name: string): { normal: string; artist?: string } | null {
  const e = entry(name);
  if (!e) return null;
  if (lang() === "ja" && e.ja?.normal) return { normal: e.ja.normal, artist: e.ja.artist };
  return { normal: e.normal, artist: e.artist };
}

/** 画面に出すカード名（日本語の画面で日本語の名前があればそれ。ルールの処理は英語の名前で行う） */
export function displayName(name: string): string {
  if (lang() !== "ja") return name;
  return entry(name)?.ja?.name ?? name;
}

/** 日本語版の印刷された文（日本語の画面でだけ。無ければ null） */
export function printedText(name: string): string | null {
  if (lang() !== "ja") return null;
  return entry(name)?.ja?.text ?? null;
}

export function imagesEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setImagesEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // 覚えられなくても、この表示の間は効く
  }
}
