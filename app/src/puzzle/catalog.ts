// 同梱のサンプル問題の一覧（public/puzzles/index.json）と、クリアしたかどうかの記録（この端末だけ）。

import { t } from "../i18n";

export type PuzzleCategory = "tutorial" | "easy" | "combo";

export interface CatalogEntry {
  id: string;
  title: string;
  description: string;
  /** 英語の画面で出す題名・説明（任意） */
  en?: { title?: string; description?: string };
  /** 問題のカテゴリ（チュートリアル・簡単な問題・コンボ問題） */
  category?: PuzzleCategory;
  /** Forge の .pzl から変換した問題なら、そのファイル名 */
  sourceFile: string | null;
}

const BASE = import.meta.env.BASE_URL;
const CLEARED_KEY = "mtg-puzzle.cleared";

export async function loadCatalog(): Promise<CatalogEntry[]> {
  const res = await fetch(`${BASE}puzzles/index.json`);
  if (!res.ok) throw new Error(t("error.catalog", { status: res.status }));
  return (await res.json()) as CatalogEntry[];
}

export async function loadPuzzle(id: string): Promise<unknown> {
  if (!/^[\w-]+$/.test(id)) throw new Error(t("error.puzzleId", { id }));
  const res = await fetch(`${BASE}puzzles/${id}.json`);
  if (!res.ok) throw new Error(t("error.puzzle", { id, status: res.status }));
  return res.json();
}

export function clearedIds(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(CLEARED_KEY) || "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function markCleared(id: string) {
  try {
    const ids = clearedIds();
    ids.add(id);
    localStorage.setItem(CLEARED_KEY, JSON.stringify([...ids]));
  } catch {
    // 記録できなくても遊べる（プライベートブラウズなど）
  }
}
