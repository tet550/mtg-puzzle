// 同梱のサンプル問題の一覧（public/puzzles/index.json）と、クリアしたかどうかの記録（この端末だけ）。

export interface CatalogEntry {
  id: string;
  title: string;
  description: string;
  /** 出典（Forge の .pzl から変換したものなど） */
  source: string | null;
}

const BASE = import.meta.env.BASE_URL;
const CLEARED_KEY = "mtg-puzzle.cleared";

export async function loadCatalog(): Promise<CatalogEntry[]> {
  const res = await fetch(`${BASE}puzzles/index.json`);
  if (!res.ok) throw new Error(`問題の一覧を読めません（${res.status}）`);
  return (await res.json()) as CatalogEntry[];
}

export async function loadPuzzle(id: string): Promise<unknown> {
  if (!/^[\w-]+$/.test(id)) throw new Error(`問題の ID が不正です: ${id}`);
  const res = await fetch(`${BASE}puzzles/${id}.json`);
  if (!res.ok) throw new Error(`問題を読めません: ${id}（${res.status}）`);
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
