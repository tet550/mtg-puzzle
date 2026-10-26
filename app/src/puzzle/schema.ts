// 問題データ（schemaVersion 1）の型と検証。要件 6 章。
// Forge の内部構造には依存させない。エンジン側でも検証する（存在しないカードなど）が、
// 形の誤りはエンジンを起動する前にここで弾く。

import type { ManaColor } from "../engine/protocol";
import { t } from "../i18n";
import { validateSolutionSteps, type SolutionStep } from "./solution";

export const SCHEMA_VERSION = 1;
/** このアプリが同梱しているエンジンの Forge のバージョン */
export const ENGINE_VERSION = "2.0.15";
export const MANA_COLORS: ManaColor[] = ["W", "U", "B", "R", "G", "C"];

export interface CardDef {
  id: string;
  cardId: string;
  tapped?: boolean;
  summoningSick?: boolean;
  /** 計画済み（追放領域のカードだけ。後のターンにソーサリーとしてマナ・コストを支払わずに唱えられる） */
  plotted?: boolean;
  /** トークン（戦場のカード。新生コピーなど） */
  token?: boolean;
  counters?: Record<string, number>;
}

export interface PlayerDef {
  id: string;
  life?: number;
  hand?: CardDef[];
  battlefield?: CardDef[];
  graveyard?: CardDef[];
  exile?: CardDef[];
  library?: CardDef[];
  manaPool?: string;
}

export interface PuzzleGoal {
  type: "win";
  player: string;
  deadline: "current_turn";
}

export interface PuzzleJson {
  schemaVersion: number;
  title: string;
  description?: string;
  source?: { type: string; file?: string; url?: string | null; difficulty?: string | null };
  engine: { type: "forge"; version: string };
  game: {
    activePlayer: string;
    phase: string;
    turn?: number;
    players: PlayerDef[];
  };
  goal: PuzzleGoal;
  opponent?: { policy: "pass"; block?: "minimize" | "none" };
  /** 登録済みの解答手順（任意） */
  solution?: SolutionStep[];
}

export const ZONES = ["hand", "battlefield", "graveyard", "exile", "library"] as const;
export type ZoneKey = (typeof ZONES)[number];

/** "R R G" のようなマナプール文字列を色ごとの数に変える */
export function parseManaPool(raw?: string): Partial<Record<ManaColor, number>> {
  const out: Partial<Record<ManaColor, number>> = {};
  if (!raw) return out;
  for (const tok of raw.trim().split(/\s+/)) {
    const c = tok.toUpperCase() as ManaColor;
    if (MANA_COLORS.includes(c)) {
      out[c] = (out[c] ?? 0) + 1;
    }
  }
  return out;
}

/** 色ごとの数を "R R G" のようなマナプール文字列に変える（空なら undefined） */
export function formatManaPool(pool: Partial<Record<ManaColor, number>>): string | undefined {
  const parts: string[] = [];
  for (const c of MANA_COLORS) {
    const n = Math.max(0, Math.floor(pool[c] ?? 0));
    for (let i = 0; i < n; i++) parts.push(c);
  }
  return parts.length ? parts.join(" ") : undefined;
}

export type ValidationResult = { ok: true; puzzle: PuzzleJson } | { ok: false; errors: string[] };

/** 問題データの形を確かめる。エラーは利用者に見せる日本語の文 */
export function validatePuzzle(data: unknown): ValidationResult {
  const errors: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(data)) return { ok: false, errors: [t("schema.notObject")] };

  if (data.schemaVersion !== SCHEMA_VERSION) {
    errors.push(t("schema.version", { v: String(data.schemaVersion) }));
    return { ok: false, errors };
  }
  const engine = data.engine;
  if (!isObj(engine) || engine.type !== "forge") {
    errors.push(t("schema.engineType"));
  } else if (engine.version !== ENGINE_VERSION) {
    errors.push(t("schema.engineVersion", { v: String(engine.version), site: ENGINE_VERSION }));
  }
  if (typeof data.title !== "string" || !data.title) errors.push(t("schema.title"));

  const game = data.game;
  if (!isObj(game)) {
    errors.push(t("schema.game"));
    return { ok: false, errors };
  }
  const players = Array.isArray(game.players) ? game.players : [];
  if (players.length !== 2) errors.push(t("schema.players"));
  const playerIds = new Set<string>();
  const instanceIds = new Set<string>();
  players.forEach((p, i) => {
    if (!isObj(p) || typeof p.id !== "string" || !p.id) {
      errors.push(t("schema.playerId", { i }));
      return;
    }
    if (playerIds.has(p.id)) errors.push(t("schema.playerDup", { id: p.id }));
    playerIds.add(p.id);
    if (p.life !== undefined && (typeof p.life !== "number" || !Number.isInteger(p.life))) {
      errors.push(t("schema.life", { id: p.id }));
    }
    for (const zone of ZONES) {
      const cards = p[zone];
      if (cards === undefined) continue;
      if (!Array.isArray(cards)) {
        errors.push(t("schema.zoneArray", { zone: `${p.id}.${zone}` }));
        continue;
      }
      cards.forEach((c, j) => {
        if (!isObj(c) || typeof c.id !== "string" || typeof c.cardId !== "string" || !c.cardId) {
          errors.push(t("schema.card", { where: `${p.id}.${zone}[${j}]` }));
          return;
        }
        if (instanceIds.has(c.id)) errors.push(t("schema.cardDup", { id: c.id }));
        instanceIds.add(c.id);
      });
    }
  });
  if (typeof game.activePlayer !== "string" || !playerIds.has(game.activePlayer)) {
    errors.push(t("schema.active"));
  }
  if (typeof game.phase !== "string") errors.push(t("schema.phase"));

  const goal = data.goal;
  if (!isObj(goal) || goal.type !== "win" || goal.deadline !== "current_turn") {
    errors.push(t("schema.goal"));
  } else if (typeof goal.player !== "string" || !playerIds.has(goal.player)) {
    errors.push(t("schema.goalPlayer"));
  }

  if (data.solution !== undefined) {
    const validSol = validateSolutionSteps(data.solution);
    if (!validSol) {
      errors.push(t("schema.solution"));
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, puzzle: data as unknown as PuzzleJson };
}
