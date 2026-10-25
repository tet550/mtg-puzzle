// 解答手順（SolutionStep）の記録・照合・整形・保存・読み込み。
// Solver が出力する *.solution.json と同じ構造（kind / indexes / labels）を使い、
// プレイ中の選択記録、ローカル登録、URL 公開、自動／1手ずつの再生に対応する。

import type { Decision } from "../engine/protocol";
import { lang as currentLang, setLang, t, type Lang } from "../i18n";

export interface SolutionStep {
  kind: string;
  indexes: number[];
  labels: string[];
}

export interface PuzzleSolution {
  puzzle?: string;
  steps: SolutionStep[];
}

const BASE = import.meta.env.BASE_URL;
export const SOLUTIONS_STORAGE_KEY = "mtg-puzzle.solutions.v1";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const normNoInst = (s: string) =>
  norm(
    s
      .replace(/^c\d+:\s*/, "")
      .replace(/\s*(?:\(\d+\)|\[\d+\])/g, ""),
  );

/** 未知のデータから SolutionStep 配列を検証・抽出する（不正なら null） */
export function validateSolutionSteps(raw: unknown): SolutionStep[] | null {
  const arr = Array.isArray(raw)
    ? raw
    : (typeof raw === "object" && raw !== null && Array.isArray((raw as { steps?: unknown }).steps))
      ? (raw as { steps: unknown[] }).steps
      : null;
  if (!arr) return null;
  const out: SolutionStep[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) return null;
    const obj = item as Record<string, unknown>;
    if (typeof obj.kind !== "string" || !obj.kind) return null;
    if (!Array.isArray(obj.indexes) || !obj.indexes.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0)) {
      return null;
    }
    if (!Array.isArray(obj.labels) || !obj.labels.every((s) => typeof s === "string")) {
      return null;
    }
    out.push({
      kind: obj.kind,
      indexes: [...(obj.indexes as number[])],
      labels: [...(obj.labels as string[])],
    });
  }
  return out;
}

/** 選択要求と選んだ optionIds から 1 手分の SolutionStep を記録する */
export function recordDecisionStep(d: Decision, optionIds: string[]): SolutionStep {
  const indexes: number[] = [];
  const labels: string[] = [];
  for (const id of optionIds) {
    const idx = d.options.findIndex((o) => o.id === id);
    if (idx >= 0) indexes.push(idx);
    const opt = idx >= 0 ? d.options[idx] : undefined;
    labels.push(opt ? opt.label : id);
  }
  return { kind: d.kind, indexes, labels };
}

/**
 * 現在の選択要求 Decision に対して SolutionStep を照合し、送るべき optionIds を返す。
 * 照合できない場合（盤面や手順が食い違っている場合）は null を返す。
 */
export function matchSolutionStep(d: Decision, step: SolutionStep): string[] | null {
  if (d.kind !== step.kind) return null;
  if (step.labels.length === 0 && step.indexes.length === 0) {
    return d.min === 0 ? [] : null;
  }
  const picked = new Set<string>();
  const ids: string[] = [];
  const count = Math.max(step.labels.length, step.indexes.length);
  for (let i = 0; i < count; i++) {
    const wantLabel = step.labels[i];
    const wantIdx = step.indexes[i];
    let found = wantLabel !== undefined
      ? d.options.find((o) => !picked.has(o.id) && norm(o.label) === norm(wantLabel))
      : undefined;
    if (!found && wantLabel !== undefined) {
      // "c2: Heartfire Hero" や "Burst Lightning [2] — ..." のようにインスタンス ID や番号が異なる同種カードへのフォールバック
      const targetNoInst = normNoInst(wantLabel);
      found = d.options.find((o) => !picked.has(o.id) && normNoInst(o.label) === targetNoInst);
    }
    if (!found && typeof wantIdx === "number" && wantIdx >= 0 && wantIdx < d.options.length) {
      const byIdx = d.options[wantIdx];
      if (byIdx && !picked.has(byIdx.id)) found = byIdx;
    }
    if (!found) return null;
    picked.add(found.id);
    ids.push(found.id);
  }
  return ids;
}

/** "c2: Llanowar Elves" や "player:p2" / "p2 (2 life)" などのラベルを表示用の短い名前に整形する */
function formatEntityLabel(raw: string, cardNameFn: (name: string) => string): string {
  const s = raw.trim();
  if (s === "player:p1" || /^p1\s*(?:\(|$)/i.test(s)) return t("player.you");
  if (s === "player:p2" || /^p2\s*(?:\(|$)/i.test(s)) return t("player.opponent");
  const cardMatch = /^c\d+:\s*(.+)$/.exec(s);
  if (cardMatch) {
    // "Llanowar Elves (1)" や "Mountain [1]" のような末尾番号を除いてカード名関数に通す
    const cleanName = cardMatch[1].replace(/\s*(?:\(\d+\)|\[\d+\])\s*$/, "").trim();
    return cardNameFn(cleanName);
  }
  return cardNameFn(s.replace(/\s*(?:\(\d+\)|\[\d+\])\s*$/, "").trim());
}

export interface FormatSolutionOptions {
  lang?: Lang;
  cardName?: (name: string) => string;
}

/** 1 手分の SolutionStep を UI 表示用の読みやすい文に整形する */
export function formatSolutionStep(
  step: SolutionStep,
  cardNameOrOpts: ((name: string) => string) | FormatSolutionOptions = (n) => n,
): string {
  const cardNameFn = typeof cardNameOrOpts === "function"
    ? cardNameOrOpts
    : (cardNameOrOpts.cardName ?? ((n: string) => n));
  const targetLang = typeof cardNameOrOpts === "object" && cardNameOrOpts !== null ? cardNameOrOpts.lang : undefined;
  const prevLang = currentLang();
  if (targetLang && targetLang !== prevLang) setLang(targetLang);

  try {
    const { kind, labels } = step;
    if (kind === "PRIORITY") {
      const first = labels[0] ?? "";
      if (!first || first === "Pass priority" || first === "Pass") return t("opt.pass");
      const sep = first.includes(" | ") ? " | " : first.includes(" — ") ? " — " : null;
      if (sep) {
        const sepIdx = first.indexOf(sep);
        const rawCard = first.slice(0, sepIdx).replace(/\s*(?:\(\d+\)|\[\d+\])\s*$/, "").trim();
        const card = cardNameFn(rawCard);
        const rest = first.slice(sepIdx + sep.length).trim();
        if (rest === "Play land" || /^Land\b/i.test(rest)) {
          return `${card}: ${t("opt.land")}`;
        }
        return `${card}: ${rest}`;
      }
      return formatEntityLabel(first, cardNameFn);
    }

    if (kind === "TARGETS" || kind === "TARGET") {
      const meaningful = labels.filter((l) => l !== "Done");
      if (meaningful.length === 0) return t("solution.step.targetDone");
      const names = meaningful.map((l) => formatEntityLabel(l, cardNameFn));
      return `${t("solution.step.target")}: ${names.join(", ")}`;
    }

    if (kind === "PAY_MANA") {
      if (labels.length === 1 && labels[0] === "Auto pay") return t("opt.auto");
      return `${t("solution.step.mana")}: ${labels.map((l) => formatEntityLabel(l, cardNameFn)).join(", ")}`;
    }

    if (kind === "ATTACKERS") {
      if (labels.length === 0) return t("action.noAttack");
      const names = labels.map((l) => formatEntityLabel(l, cardNameFn));
      return `${t("card.attacking")}: ${names.join(", ")}`;
    }

    if (labels.length === 0) return kind;
    const formatted = labels.map((l) => {
      if (l === "Yes") return t("opt.yes");
      if (l === "No") return t("opt.no");
      if (l === "Auto pay") return t("opt.auto");
      if (l === "Pass priority" || l === "Pass") return t("opt.pass");
      return formatEntityLabel(l, cardNameFn);
    });
    return formatted.join(", ");
  } finally {
    if (targetLang && targetLang !== prevLang) setLang(prevLang);
  }
}

const memorySolutions: Record<string, SolutionStep[]> = {};

/** 端末に保存されている全パズルの登録解答マップを読む */
function readStoredSolutionsMap(): Record<string, SolutionStep[]> {
  try {
    const raw = typeof localStorage !== "undefined" && typeof localStorage.getItem === "function"
      ? localStorage.getItem(SOLUTIONS_STORAGE_KEY)
      : null;
    if (!raw) return { ...memorySolutions };
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ...memorySolutions };
    const out: Record<string, SolutionStep[]> = { ...memorySolutions };
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const valid = validateSolutionSteps(v);
      if (valid && valid.length > 0) out[k] = valid;
    }
    return out;
  } catch {
    return { ...memorySolutions };
  }
}

function writeStoredSolutionsMap(map: Record<string, SolutionStep[]>): void {
  try {
    if (typeof localStorage !== "undefined" && typeof localStorage.setItem === "function") {
      localStorage.setItem(SOLUTIONS_STORAGE_KEY, JSON.stringify(map));
    }
  } catch {
    // プライベートブラウズや Node テスト環境で書けないときはメモリ保持のみ
  }
}

/** 指定したパズル ID に登録されている解答手順を localStorage から取得する */
export function loadRegisteredSolution(puzzleId: string): SolutionStep[] | null {
  if (!puzzleId) return null;
  const map = readStoredSolutionsMap();
  return map[puzzleId] ?? null;
}

/** 指定したパズル ID の解答手順を localStorage に登録（保存）する */
export function saveRegisteredSolution(puzzleId: string, steps: SolutionStep[]): void {
  if (!puzzleId || steps.length === 0) return;
  const copied = steps.map((s) => ({
    kind: s.kind,
    indexes: [...s.indexes],
    labels: [...s.labels],
  }));
  memorySolutions[puzzleId] = copied;
  const map = readStoredSolutionsMap();
  map[puzzleId] = copied;
  writeStoredSolutionsMap(map);
}

/** 指定したパズル ID の登録済み解答手順を削除する */
export function deleteRegisteredSolution(puzzleId: string): void {
  if (!puzzleId) return;
  delete memorySolutions[puzzleId];
  const map = readStoredSolutionsMap();
  delete map[puzzleId];
  writeStoredSolutionsMap(map);
}

/** 同梱パズルの公式解答ファイル（public/puzzles/<id>.solution.json）を読み込む */
export async function loadBundledSolution(id: string): Promise<SolutionStep[] | null> {
  if (!/^[\w-]+$/.test(id) || id === "shared" || id === "editor-test") return null;
  try {
    const res = await fetch(`${BASE}puzzles/${id}.solution.json`);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return validateSolutionSteps(data);
  } catch {
    return null;
  }
}
