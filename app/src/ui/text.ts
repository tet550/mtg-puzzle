// 画面に出す日本語（フェイズ・出来事・選択要求の説明）。

import type { Decision, GameEvent, Phase } from "../engine/protocol";

export const PHASE_NAMES: Record<Phase, string> = {
  UNTAP: "アンタップ",
  UPKEEP: "アップキープ",
  DRAW: "ドロー",
  MAIN1: "メイン 1",
  COMBAT_BEGIN: "戦闘開始",
  COMBAT_DECLARE_ATTACKERS: "攻撃宣言",
  COMBAT_DECLARE_BLOCKERS: "ブロック宣言",
  COMBAT_FIRST_STRIKE_DAMAGE: "先制ダメージ",
  COMBAT_DAMAGE: "戦闘ダメージ",
  COMBAT_END: "戦闘終了",
  MAIN2: "メイン 2",
  END_OF_TURN: "終了",
  CLEANUP: "クリンナップ",
};

/** フェイズの帯に出す区切り（mtgtable の phaseStrip と同じく、フェイズごとにまとめる） */
export const PHASE_STRIP: { label: string; phases: Phase[] }[] = [
  { label: "開始", phases: ["UNTAP", "UPKEEP", "DRAW"] },
  { label: "メイン 1", phases: ["MAIN1"] },
  { label: "戦闘", phases: ["COMBAT_BEGIN", "COMBAT_DECLARE_ATTACKERS", "COMBAT_DECLARE_BLOCKERS", "COMBAT_FIRST_STRIKE_DAMAGE", "COMBAT_DAMAGE", "COMBAT_END"] },
  { label: "メイン 2", phases: ["MAIN2"] },
  { label: "終了", phases: ["END_OF_TURN", "CLEANUP"] },
];

export const ZONE_NAMES: Record<string, string> = {
  Hand: "手札", Battlefield: "戦場", Graveyard: "墓地", Exile: "追放", Library: "ライブラリー", Stack: "スタック", Command: "統率",
};

/** 優先権をパスしたときに進む先（パスのボタンに書く） */
export function passLabel(phase: Phase, stackSize: number): string {
  if (stackSize > 0) return "解決する";
  switch (phase) {
    case "MAIN1": return "戦闘へ";
    case "COMBAT_DECLARE_ATTACKERS":
    case "COMBAT_DECLARE_BLOCKERS": return "ダメージへ";
    case "MAIN2": return "終了ステップへ";
    case "END_OF_TURN": return "ターンを終える";
    default: return "パス";
  }
}

export function decisionPrompt(d: Decision): string {
  switch (d.kind) {
    case "PRIORITY": return "行動を選んでください（カードを押す）";
    case "TARGETS": return d.max > 1 ? `対象を ${d.min === d.max ? d.min : `${d.min}〜${d.max}`} 個選んでください` : "対象を選んでください";
    case "ATTACKERS": return "攻撃するクリーチャーを選んでください";
    case "CONFIRM": return d.prompt;
    case "PAY_MANA": return `マナを支払ってください（${d.prompt.replace(/^Pay /, "").replace(/ for .*/, "")}）`;
    case "CHOOSE_CARDS": return `コストに使うカードを選んでください（${countText(d)}）`;
    case "CHOOSE_ENTITY": return `${d.prompt}（${countText(d)}）`;
    case "CHOOSE_MODE": return `モードを選んでください（${countText(d)}）`;
    case "CHOOSE_NUMBER": return d.prompt.startsWith("Announce") ? "X の値を選んでください" : d.prompt;
  }
}

function countText(d: Decision): string {
  return d.min === d.max ? `${d.min} 個` : `${d.min}〜${d.max} 個`;
}

export function playerName(id: string, viewer: string): string {
  return id === viewer ? "あなた" : "相手";
}

/** 出来事を Log の 1 行にする。表示しない出来事は null */
export function eventText(e: GameEvent, name: (id: string) => string, viewer: string): string | null {
  const who = (p: string) => (p === viewer || p === "p1" || p === "p2" ? playerName(p, viewer) : `<${name(p)}>`);
  switch (e.type) {
    case "turnBegan": return `── ${e.turn} ターン目（${playerName(e.player, viewer)}） ──`;
    case "phase": return null;
    case "cast": return `<${name(e.sourceId)}> を唱えた／起動した`;
    case "resolved": return `<${name(e.sourceId)}> が解決した${e.fizzled ? "（対象が無く打ち消された）" : ""}`;
    case "life": return `${playerName(e.player, viewer)}のライフ ${e.from} → ${e.to}`;
    case "damage": return `${e.sourceId ? `<${name(e.sourceId)}>` : "?"} が ${who(e.target)} に ${e.amount} 点${e.combat ? "（戦闘）" : ""}`;
    case "zoneChange":
      if (e.from === "Library" && e.to === "Hand") return `カードを 1 枚引いた`;
      return `<${name(e.cardId)}>: ${ZONE_NAMES[e.from ?? ""] ?? e.from ?? "-"} → ${ZONE_NAMES[e.to ?? ""] ?? e.to ?? "-"}`;
    case "tapped": return null;
    case "counters": return `<${name(e.cardId)}> の ${e.counter} カウンター ${e.from} → ${e.to}`;
    case "attackersDeclared":
      return e.attackers.length ? `攻撃: ${e.attackers.map((a) => `<${name(a.cardId)}>`).join("、")}` : null;
    case "gameOver": return e.winner ? `ゲーム終了（勝者: ${playerName(e.winner, viewer)}）` : "ゲーム終了（引き分け）";
  }
}
