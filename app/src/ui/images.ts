// カード画像（Scryfall の画像 CDN）。URL の一覧はビルド時に tools/card-images.py で作る（public/cards.json）。
// 画像を出すかどうかは表示の設定で切り替え、この端末に覚える。

export interface CardImage {
  normal: string;
  small: string;
  artist?: string;
}

const BASE = import.meta.env.BASE_URL;
const KEY = "mtg-puzzle.images";
let table: Record<string, CardImage> = {};

export async function loadCardImages(): Promise<void> {
  try {
    const res = await fetch(`${BASE}cards.json`);
    if (res.ok) table = (await res.json()) as Record<string, CardImage>;
  } catch {
    // 一覧が無くても文字のカードで遊べる
  }
}

export function cardImage(name: string): CardImage | null {
  return table[name] ?? table[name.split(" // ")[0]] ?? null;
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
