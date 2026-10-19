// 画面に出す文（フェイズ・出来事・選択要求の説明）。文そのものは i18n の辞書にある。

import type { Decision, GameEvent, Phase } from "../engine/protocol";
import { t, type MessageKey } from "../i18n";

export function phaseName(p: Phase): string {
  return t(`phase.${p}` as MessageKey);
}

/** フェイズの帯に出す区切り（mtgtable の phaseStrip と同じく、フェイズごとにまとめる） */
export const PHASE_STRIP: { key: MessageKey; icon: "beginning" | "main1" | "combat" | "main2" | "ending"; phases: Phase[] }[] = [
  { key: "strip.beginning", icon: "beginning", phases: ["UNTAP", "UPKEEP", "DRAW"] },
  { key: "strip.main1", icon: "main1", phases: ["MAIN1"] },
  { key: "strip.combat", icon: "combat", phases: ["COMBAT_BEGIN", "COMBAT_DECLARE_ATTACKERS", "COMBAT_DECLARE_BLOCKERS", "COMBAT_FIRST_STRIKE_DAMAGE", "COMBAT_DAMAGE", "COMBAT_END"] },
  { key: "strip.main2", icon: "main2", phases: ["MAIN2"] },
  { key: "strip.end", icon: "ending", phases: ["END_OF_TURN", "CLEANUP"] },
];

export function zoneName(z: string | null): string {
  if (!z) return "-";
  const key = `zone.${z}` as MessageKey;
  const s = t(key);
  return s === key ? z : s;
}

/** 優先権をパスしたときに進む先（パスのボタンに書く） */
export function passLabel(phase: Phase, stackSize: number): string {
  if (stackSize > 0) return t("pass.resolve");
  switch (phase) {
    case "MAIN1": return t("pass.toCombat");
    case "COMBAT_DECLARE_ATTACKERS":
    case "COMBAT_DECLARE_BLOCKERS": return t("pass.toDamage");
    case "MAIN2": return t("pass.toEnd");
    case "END_OF_TURN": return t("pass.endTurn");
    default: return t("pass.default");
  }
}

export function decisionPrompt(d: Decision): string {
  switch (d.kind) {
    case "PRIORITY": return t("prompt.PRIORITY");
    case "TARGETS": return d.max > 1 ? t("prompt.TARGETS.n", { n: countText(d) }) : t("prompt.TARGETS");
    case "ATTACKERS": return t("prompt.ATTACKERS");
    case "CONFIRM": return d.prompt;
    case "PAY_MANA": return t("prompt.PAY_MANA", { cost: d.prompt.replace(/^Pay /, "").replace(/ for .*/, "") });
    case "CHOOSE_CARDS": {
      const crew = /^Tap creatures with total power (\d+) or greater/.exec(d.prompt);
      return crew ? t("prompt.totalPower", { n: crew[1] }) : t("prompt.CHOOSE_CARDS", { n: countText(d) });
    }
    case "CHOOSE_ENTITY": return t("prompt.CHOOSE_ENTITY", { prompt: d.prompt, n: countText(d) });
    case "CHOOSE_MODE": return t("prompt.CHOOSE_MODE", { n: countText(d) });
    case "CHOOSE_NUMBER": return d.prompt.startsWith("Announce") ? t("prompt.X") : d.prompt;
  }
}

function countText(d: Decision): string {
  return d.min === d.max ? t("count.exact", { n: d.min }) : t("count.range", { min: d.min, max: d.max });
}

export function playerName(id: string, viewer: string): string {
  return id === viewer ? t("player.you") : t("player.opponent");
}

/** 出来事を Log の 1 行にする。表示しない出来事は null。name はインスタンス ID → 表示名 */
export function eventText(e: GameEvent, name: (id: string) => string, viewer: string): string | null {
  const card = (id: string | null) => (id ? `<${name(id)}>` : "?");
  const who = (p: string) => (p === "p1" || p === "p2" || p === viewer ? playerName(p, viewer) : card(p));
  switch (e.type) {
    case "turnBegan": return t("log.turn", { turn: e.turn, player: playerName(e.player, viewer) });
    case "phase": return null;
    case "cast": return t("log.cast", { card: card(e.sourceId) });
    case "resolved": return t(e.fizzled ? "log.fizzled" : "log.resolved", { card: card(e.sourceId) });
    case "life": return t("log.life", { player: playerName(e.player, viewer), from: e.from, to: e.to });
    case "damage": return t(e.combat ? "log.damageCombat" : "log.damage", { source: card(e.sourceId), target: who(e.target), n: e.amount });
    case "zoneChange":
      if (e.from === "Library" && e.to === "Hand") return t("log.draw");
      return t("log.move", { card: card(e.cardId), from: zoneName(e.from), to: zoneName(e.to) });
    case "tapped": return null;
    case "counters": return t("log.counters", { card: card(e.cardId), counter: e.counter, from: e.from, to: e.to });
    case "attackersDeclared":
      return e.attackers.length ? t("log.attack", { list: e.attackers.map((a) => card(a.cardId)).join(t("log.sep")) }) : null;
    case "gameOver": return e.winner ? t("log.gameOver", { player: playerName(e.winner, viewer) }) : t("log.gameOverDraw");
  }
}
