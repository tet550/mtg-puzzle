// カードの画像と日本語の名前・文（Scryfall）。
// 同梱の問題のカードとトークンは、ビルド時に tools/card-images.py で作った一覧（public/cards.json）を使う。
// 一覧に無いカードやトークン（URL で渡された問題や、プレイ中に生成されたトークンなど）は、Scryfall の API で引き、この端末に覚える（ensureCardImages）。
// 日本語の画面では、日本語版の画像・名前・印刷された文があればそれを使う（無ければ英語版）。
// 画像を出すかどうかは表示の設定で切り替え、この端末に覚える。

import { lang } from "../i18n";

export interface CardImage {
  normal: string;
  small: string;
  artist?: string;
  /** 日本語版（あれば。トークンでは printed_name が無く画像だけのこともある） */
  ja?: { name?: string; normal?: string; small?: string; artist?: string; text?: string };
}

const BASE = import.meta.env.BASE_URL;
const KEY = "mtg-puzzle.images";
/** 実行時に Scryfall で引いた結果（見つからなかった名前は null）。cards.json と同じ形 */
const CACHE_KEY = "mtg-puzzle.cardImages.v2";
const API = "https://api.scryfall.com";
const HAS_JA_RE = /[ぁ-んァ-ヶー一-龠々]/;
let table: Record<string, CardImage> = {};
let fetched: Record<string, CardImage | null> = {};
const inflight = new Set<string>();
let jaFallback: ((name: string) => { name?: string; text?: string } | null) | null = null;

/** カードデータベース（carddb.ts）から日本語名・日本語テキストのフォールバックを登録する */
export function setJaFallback(fn: ((name: string) => { name?: string; text?: string } | null) | null) {
  jaFallback = fn;
}

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

export function isTokenName(name: string): boolean {
  return name === "Token" || name.endsWith(" Token");
}

export function tokenBaseName(name: string): string {
  return name.replace(/\s+Token$/, "");
}

/** Scryfall の日本語名に付いている読み仮名を外す（例: 急（きゅう）抗（こう）直（ちょっ）下（か） → 急抗直下） */
export function stripRuby(text: string): string {
  return text.replace(/（[ぁ-ゖァ-ヺー]+）/g, "");
}

/**
 * names のうち、画像の一覧にも端末の記録にも無いカード・トークンを Scryfall で引く（tools/card-images.py と同じ引き方）。
 * 通常のカードは /cards/collection でまとめて（75 枚ずつ）、トークン（"<Name> Token" や通常カードに無い名前）は is:token で検索し、
 * 日本語版はカードごとに検索する。新しく分かったカードがあれば true（呼び出し側で描き直す）。通信に失敗しても例外にはしない
 */
export async function ensureCardImages(names: string[]): Promise<boolean> {
  const missing = [...new Set(names)].filter((n) => n && !entry(n) && !(n in fetched) && !inflight.has(n));
  if (missing.length === 0) return false;
  for (const n of missing) inflight.add(n);
  let changed = false;
  try {
    const regular = missing.filter((n) => !isTokenName(n));
    const tokens = missing.filter((n) => isTokenName(n));
    for (let i = 0; i < regular.length; i += 75) {
      const chunk = regular.slice(i, i + 75);
      const data = await api<{ data?: ScryfallCard[] }>("/cards/collection", { identifiers: chunk.map((name) => ({ name })) });
      if (!data) return changed;
      const found = new Map<string, { img: CardImage; fullName: string }>();
      for (const card of data.data ?? []) {
        const img = imageOf(card);
        if (!img) continue;
        found.set(card.name, { img, fullName: card.name });
        // 両面・分割・出来事・前兆カードは "A // B" の名前で返る。各面の名前でも引けるようにする
        for (const part of card.name.split(" // ")) {
          if (!found.has(part)) {
            found.set(part, { img: imageOf(card, part) ?? img, fullName: card.name });
          }
        }
      }
      for (const n of chunk) {
        const hit = found.get(n) ?? found.get(n.split(" // ")[0]) ?? null;
        if (hit) {
          const img: CardImage = { ...hit.img };
          // 検索の API は間隔を空けて呼ぶ（Scryfall のお願い）
          await sleep(100);
          const ja = japaneseOf(
            await api<{ data?: ScryfallCard[] }>(
              `/cards/search?q=${encodeURIComponent(`!"${hit.fullName}" lang:ja`)}&unique=prints&order=released&dir=desc`,
            ),
            false,
            n,
          );
          if (ja) img.ja = ja;
          fetched[n] = img;
          changed = true;
        } else if (jaFallback?.(n) !== null && jaFallback !== null) {
          // カードDBに存在する通常カード（Scryfall未収録のデジタル専用カード等）はトークン検索を行わない
          fetched[n] = null;
        } else {
          // 通常のカードに見つからなければトークン（名前付きトークンなど）として探す
          tokens.push(n);
        }
      }
    }
    for (const n of tokens) {
      const base = tokenBaseName(n);
      if (regular.length > 0 || n !== tokens[0]) await sleep(100);
      const en = await api<{ data?: ScryfallCard[] }>(`/cards/search?q=${encodeURIComponent(`!"${base}" is:token`)}&unique=prints&order=released&dir=desc`);
      const img = tokenImageOf(en, base);
      if (img) {
        await sleep(100);
        const ja = japaneseOf(await api<{ data?: ScryfallCard[] }>(`/cards/search?q=${encodeURIComponent(`!"${base}" is:token lang:ja`)}&unique=prints&order=released&dir=desc`), true, base);
        if (ja) img.ja = ja;
      }
      fetched[n] = img;
      changed ||= !!img;
    }
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(fetched));
    } catch {
      // 覚えられなくても、この表示の間は効く
    }
    return changed;
  } finally {
    for (const n of missing) inflight.delete(n);
  }
}

interface ScryfallFace {
  name?: string;
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

function plain(c: ScryfallCard): boolean {
  return !(c.promo || c.full_art || c.frame_effects?.length || c.border_color === "borderless");
}

/** 表の面の画像（両面カードは faceName が一致する面、無ければ 1 面目） */
export function imageOf(card: ScryfallCard, faceName?: string): CardImage | null {
  const face = (faceName ? card.card_faces?.find((f) => f.name?.toLowerCase() === faceName.toLowerCase()) : undefined)
    ?? card.card_faces?.[0];
  const uris = card.image_uris ?? face?.image_uris;
  if (!uris?.normal || !uris.small) return null;
  return { normal: uris.normal, small: uris.small, ...(card.artist ? { artist: card.artist } : {}) };
}

/** トークンの検索結果（新しい順）から、片面の通常版を優先して画像を取り出す */
export function tokenImageOf(result: { data?: ScryfallCard[] } | null, tokenName: string): CardImage | null {
  const cards = (result?.data ?? []).filter((c) => imageOf(c, tokenName) !== null);
  const single = (c: ScryfallCard) => !!c.image_uris?.normal;
  const card = cards.find((c) => single(c) && plain(c)) ?? cards.find(single) ?? cards.find(plain) ?? cards[0];
  return card ? imageOf(card, tokenName) : null;
}

/** 日本語版の検索結果（新しい順）から、通常の版で最新のもの（無ければ特殊な版。日本語版が無ければ undefined） */
export function japaneseOf(result: { data?: ScryfallCard[] } | null, token = false, faceName?: string): CardImage["ja"] {
  const isSplitQuery = !!faceName?.includes(" // ");
  const matchFace = (c: ScryfallCard): ScryfallFace =>
    (!isSplitQuery && faceName ? c.card_faces?.find((f) => f.name?.toLowerCase() === faceName.toLowerCase()) : undefined)
    ?? c.card_faces?.[0] ?? c;
  const translatedName = (c: ScryfallCard): string | undefined => {
    if (isSplitQuery && !c.printed_name && c.card_faces && c.card_faces.length > 1) {
      const parts = c.card_faces.map((f) => {
        const p = stripRuby(f.printed_name ?? "");
        return p && p.toLowerCase() !== (f.name ?? "").toLowerCase() ? p : "";
      });
      return parts.every(Boolean) ? parts.join(" // ") : undefined;
    }
    const f = matchFace(c);
    const raw = stripRuby(c.printed_name ?? f.printed_name ?? "");
    if (!raw) return undefined;
    const enName = f.name ?? faceName ?? c.name;
    return raw.toLowerCase() === enName.toLowerCase() ? undefined : raw;
  };
  const cards = (result?.data ?? []).filter(
    (c) => translatedName(c) || c.printed_name || c.card_faces?.[0]?.printed_name || (token && imageOf(c, faceName)),
  );
  const single = (c: ScryfallCard) => !!c.image_uris?.normal;
  const card = (token
    ? cards.find((c) => single(c) && plain(c)) ?? cards.find(single)
    : cards.find((c) => translatedName(c) && plain(c)) ?? cards.find((c) => !!translatedName(c)))
    ?? cards.find(plain) ?? cards[0];
  if (!card) return undefined;
  const face = matchFace(card);
  const img = imageOf(card, isSplitQuery ? undefined : faceName);
  const name = translatedName(card);
  const ja: NonNullable<CardImage["ja"]> = name ? { name } : {};
  if (img) Object.assign(ja, { normal: img.normal, small: img.small }, img.artist ? { artist: img.artist } : {});
  const rawText = isSplitQuery && !card.printed_text && card.card_faces && card.card_faces.length > 1
    ? card.card_faces.map((f) => f.printed_text ?? "").filter((t) => HAS_JA_RE.test(t)).join("\n//\n")
    : (card.printed_text ?? face.printed_text);
  if (rawText && HAS_JA_RE.test(rawText)) ja.text = rawText;
  return Object.keys(ja).length ? ja : undefined;
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
  return entry(name)?.ja?.name ?? jaFallback?.(name)?.name ?? name;
}

/** 日本語版の印刷された文（日本語の画面でだけ。無ければ null） */
export function printedText(name: string): string | null {
  if (lang() !== "ja") return null;
  return entry(name)?.ja?.text ?? jaFallback?.(name)?.text ?? null;
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
