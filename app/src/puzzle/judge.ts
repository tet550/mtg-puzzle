// クリア判定（要件 5 章）。エンジンが返した出来事と状態だけから決める純粋関数。
// - 対象プレイヤーの勝利が確定したらクリア
// - 期限（このターン）を過ぎたら失敗
// - 対象プレイヤーが敗北・引き分けなら失敗
// - エンジンが異常終了したらクリアにしない（エラー）

import type { EngineState, GameEvent } from "../engine/protocol";
import { t } from "../i18n";
import type { PuzzleGoal } from "./schema";

export type Verdict =
  | { result: "IN_PROGRESS" }
  | { result: "CLEARED"; reason: "win" }
  | { result: "FAILED"; reason: "deadline" | "lost" | "draw" }
  | { result: "ERROR"; message: string };

export interface JudgeInput {
  goal: PuzzleGoal;
  /** 問題を開始したターン（load の直後の view.turn） */
  startTurn: number;
  events: GameEvent[];
  engine: EngineState;
}

/** 1 ステップ分の出来事を順に見て判定する。先に起きた出来事が優先（期限の後の勝利はクリアにしない） */
export function judge({ goal, startTurn, events, engine }: JudgeInput): Verdict {
  for (const e of events) {
    if (goal.deadline === "current_turn" && e.type === "turnBegan" && e.turn > startTurn) {
      return { result: "FAILED", reason: "deadline" };
    }
    if (e.type === "gameOver") {
      return outcome(goal, e.winner, e.winner === null);
    }
  }
  switch (engine.state) {
    case "AWAITING":
      return { result: "IN_PROGRESS" };
    case "GAME_OVER":
      return outcome(goal, engine.outcome.winner, engine.outcome.draw);
    case "HALTED":
      return { result: "FAILED", reason: "deadline" };
    case "ERROR":
      return { result: "ERROR", message: engine.message };
  }
}

function outcome(goal: PuzzleGoal, winner: string | null, draw: boolean): Verdict {
  if (draw || winner === null) return { result: "FAILED", reason: "draw" };
  return winner === goal.player ? { result: "CLEARED", reason: "win" } : { result: "FAILED", reason: "lost" };
}

export function verdictText(v: Verdict): string {
  switch (v.result) {
    case "IN_PROGRESS":
      return t("verdict.playing");
    case "CLEARED":
      return t("verdict.cleared");
    case "FAILED":
      return t(`verdict.${v.reason}`);
    case "ERROR":
      return t("verdict.error", { message: v.message });
  }
}
