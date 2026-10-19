// カードの画像と日本語の名前・文（Scryfall）。一覧はビルド時に tools/card-images.py で作る（public/cards.json）。
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
let table: Record<string, CardImage> = {};

export async function loadCardImages(): Promise<void> {
  try {
    const res = await fetch(`${BASE}cards.json`);
    if (res.ok) table = (await res.json()) as Record<string, CardImage>;
  } catch {
    // 一覧が無くても文字のカード（英語の名前）で遊べる
  }
}

function entry(name: string): CardImage | null {
  return table[name] ?? table[name.split(" // ")[0]] ?? null;
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
