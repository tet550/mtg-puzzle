// 問題データ（schemaVersion 1）の型と検証。要件 6 章。
// Forge の内部構造には依存させない。エンジン側でも検証する（存在しないカードなど）が、
// 形の誤りはエンジンを起動する前にここで弾く。

export const SCHEMA_VERSION = 1;
/** このアプリが同梱しているエンジンの Forge のバージョン */
export const ENGINE_VERSION = "2.0.15";

export interface CardDef {
  id: string;
  cardId: string;
  tapped?: boolean;
  summoningSick?: boolean;
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
  opponent?: { policy: "pass" };
}

export const ZONES = ["hand", "battlefield", "graveyard", "exile", "library"] as const;

export type ValidationResult = { ok: true; puzzle: PuzzleJson } | { ok: false; errors: string[] };

/** 問題データの形を確かめる。エラーは利用者に見せる日本語の文 */
export function validatePuzzle(data: unknown): ValidationResult {
  const errors: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(data)) return { ok: false, errors: ["問題データが JSON のオブジェクトではありません"] };

  if (data.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`この問題の形式（schemaVersion ${String(data.schemaVersion)}）には対応していません`);
    return { ok: false, errors };
  }
  const engine = data.engine;
  if (!isObj(engine) || engine.type !== "forge") {
    errors.push("engine.type が forge ではありません");
  } else if (engine.version !== ENGINE_VERSION) {
    errors.push(`この問題は Forge ${String(engine.version)} 用です（このサイトは ${ENGINE_VERSION}）`);
  }
  if (typeof data.title !== "string" || !data.title) errors.push("title がありません");

  const game = data.game;
  if (!isObj(game)) {
    errors.push("game がありません");
    return { ok: false, errors };
  }
  const players = Array.isArray(game.players) ? game.players : [];
  if (players.length !== 2) errors.push("プレイヤーは 2 人である必要があります");
  const playerIds = new Set<string>();
  const instanceIds = new Set<string>();
  players.forEach((p, i) => {
    if (!isObj(p) || typeof p.id !== "string" || !p.id) {
      errors.push(`players[${i}] の id がありません`);
      return;
    }
    if (playerIds.has(p.id)) errors.push(`プレイヤーの id が重複しています: ${p.id}`);
    playerIds.add(p.id);
    if (p.life !== undefined && (typeof p.life !== "number" || !Number.isInteger(p.life))) {
      errors.push(`${p.id} のライフが整数ではありません`);
    }
    for (const zone of ZONES) {
      const cards = p[zone];
      if (cards === undefined) continue;
      if (!Array.isArray(cards)) {
        errors.push(`${p.id}.${zone} が配列ではありません`);
        continue;
      }
      cards.forEach((c, j) => {
        if (!isObj(c) || typeof c.id !== "string" || typeof c.cardId !== "string" || !c.cardId) {
          errors.push(`${p.id}.${zone}[${j}] に id か cardId がありません`);
          return;
        }
        if (instanceIds.has(c.id)) errors.push(`カードの id が重複しています: ${c.id}`);
        instanceIds.add(c.id);
      });
    }
  });
  if (typeof game.activePlayer !== "string" || !playerIds.has(game.activePlayer)) {
    errors.push("activePlayer がプレイヤーの id と一致しません");
  }
  if (typeof game.phase !== "string") errors.push("phase がありません");

  const goal = data.goal;
  if (!isObj(goal) || goal.type !== "win" || goal.deadline !== "current_turn") {
    errors.push("対応していない勝利条件です（このターン中に勝利、のみ対応）");
  } else if (typeof goal.player !== "string" || !playerIds.has(goal.player)) {
    errors.push("goal.player がプレイヤーの id と一致しません");
  }

  return errors.length ? { ok: false, errors } : { ok: true, puzzle: data as unknown as PuzzleJson };
}
