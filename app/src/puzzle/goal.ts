// 勝利条件の期限（goal.deadline）の解釈と表示。
// - "current_turn": このターン中（turns = 1 と同じ）
// - "turns": 開始ターンを 1 として、相手のターンも含めて数えた goal.turns ターン目が終わるまで
// - "unlimited": ターン制限なしで勝利（通常の問題）
// - "none": ターン制限なし（一人回し・プレイテスト専用。共有 URL などの判定に使う）
// エンジンは "current_turn" と "none" しか知らないので、読み込ませる前に toEnginePuzzle で変換し、
// 2 ターン以上の期限は judge が turnBegan の出来事から判定する。

import { t } from "../i18n";
import type { PuzzleGoal, PuzzleJson } from "./schema";

/** 期限として選べるターン数の上限 */
export const MAX_GOAL_TURNS = 9;

/** 期限のターン数（開始ターンを 1 と数える）。期限なしなら null */
export function goalTurnLimit(goal: PuzzleGoal): number | null {
  if (goal.deadline === "current_turn") return 1;
  if (goal.deadline === "turns") return goal.turns ?? 1;
  return null;
}

/** 一人回し（プレイテスト）の問題か */
export function isPlaytestGoal(goal: PuzzleGoal | undefined): boolean {
  return goal?.deadline === "none";
}

/** エンジンに渡す形に変える（エンジンは current_turn / none のみ対応） */
export function toEnginePuzzle(p: PuzzleJson): PuzzleJson {
  const limit = goalTurnLimit(p.goal);
  const deadline = limit === 1 ? "current_turn" : "none";
  if (p.goal.deadline === deadline && p.goal.turns === undefined) return p;
  return { ...p, goal: { type: p.goal.type, player: p.goal.player, deadline } };
}

export interface GoalLabel {
  /** ヘッダーの札（「このターン中に勝利」など） */
  chip: string;
  /** 目標カードの見出し（「このターン中」など） */
  card: string;
  /** 説明の文（「このターン中に勝てばクリア」など） */
  text: string;
}

/** 勝利条件の表示。activePlayer は開始時の手番（期限の最後が誰のターンかを決める） */
export function goalLabel(goal: PuzzleGoal, activePlayer: string): GoalLabel {
  const limit = goalTurnLimit(goal);
  if (limit === null) {
    return { chip: t("goal.unlimited.chip"), card: t("goal.unlimited.card"), text: t("goal.unlimited.text") };
  }
  if (limit <= 1) {
    return { chip: t("header.goal"), card: t("phase.deadline"), text: t("phase.deadline.title") };
  }
  const selfStart = activePlayer === goal.player;
  // 期限の最後のターンが自分のものか（自分の手番で始まれば奇数ターン目が自分）
  const lastIsSelf = (limit % 2 === 1) === selfStart;
  // そのプレイヤーの何回目のターンか（開始ターンを含めて数える）
  const nth = lastIsSelf ? (selfStart ? (limit + 1) / 2 : limit / 2) : (selfStart ? limit / 2 : (limit + 1) / 2);
  // 「次の」で言えるのは、開始ターンを除いて最初に来るそのプレイヤーのターン
  const nextNth = lastIsSelf ? (selfStart ? 2 : 1) : (selfStart ? 1 : 2);
  const who = lastIsSelf ? "self" : "opp";
  if (nth === nextNth) {
    return {
      chip: t(`goal.${who}Next.chip`),
      card: t(`goal.${who}Next.card`),
      text: t(`goal.${who}Next.text`),
    };
  }
  return {
    chip: t(`goal.${who}Nth.chip`, { n: nth }),
    card: t(`goal.${who}Nth.card`, { n: nth }),
    text: t(`goal.${who}Nth.text`, { n: nth }),
  };
}
