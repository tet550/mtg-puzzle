// 画面の言語（日本語・英語）。辞書は i18n/ja.ts と i18n/en.ts（キーは同じ）。
// 言語はこの端末に覚える。覚えていなければブラウザの言語（ja で始まれば日本語、ほかは英語）。

import { en } from "./i18n/en";
import { ja, type Messages } from "./i18n/ja";

export type Lang = "ja" | "en";
export type MessageKey = keyof Messages;

const KEY = "mtg-puzzle.lang";
const DICTS: Record<Lang, Messages> = { ja, en };
const listeners = new Set<(l: Lang) => void>();

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "ja" || saved === "en") return saved;
  } catch {
    // 覚えられない環境
  }
  if (typeof navigator === "undefined") return "ja"; // テスト（Node）
  return navigator.language?.toLowerCase().startsWith("ja") ? "ja" : "en";
}

let current: Lang = initial();
if (typeof document !== "undefined") document.documentElement.lang = current;

export function lang(): Lang {
  return current;
}

export function setLang(l: Lang) {
  if (l === current) return;
  current = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    // この表示の間だけ効く
  }
  if (typeof document !== "undefined") document.documentElement.lang = l;
  for (const fn of listeners) fn(l);
}

export function onLangChange(fn: (l: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 問題の題名と説明。title / description は日本語で、英語の画面では en の英訳があればそれを使う */
export interface PuzzleText {
  title: string;
  description?: string;
  en?: { title?: string; description?: string };
}

export function puzzleTitle(p: PuzzleText): string {
  return (current === "en" && p.en?.title) || p.title;
}

export function puzzleDescription(p: PuzzleText): string | undefined {
  return (current === "en" && p.en?.description) || p.description;
}

/** t("key", { n: 3 }) → 辞書の文の {n} を置き換える */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let s: string = DICTS[current][key] ?? ja[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}
