// 画面に出す文（フェイズ・出来事・選択要求の説明）。文そのものは i18n の辞書にある。

import type { Decision, GameEvent, Phase } from "../engine/protocol";
import { lang, t, type MessageKey } from "../i18n";
import { displayName } from "./images";

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
  // Adapter が種類と値（promptKey / promptArgs）を返した説明は、画面の言語の辞書で文にする
  const fromKey = d.promptKey ? askText(d.promptKey, d) : null;
  if (fromKey) return fromKey;
  // Forge が作った説明（英語）。種類だけで言えるものは辞書の文にする
  switch (d.kind) {
    case "PRIORITY": return t("prompt.PRIORITY");
    case "TARGETS": return d.max > 1 ? t("prompt.TARGETS.n", { n: countText(d) }) : t("prompt.TARGETS");
    case "ATTACKERS": return t("prompt.ATTACKERS");
    case "CHOOSE_CARDS": return t("prompt.CHOOSE_CARDS", { n: countText(d) });
    case "CHOOSE_MODE": return t("prompt.CHOOSE_MODE", { n: countText(d) });
    case "CHOOSE_ENTITY": return t("prompt.CHOOSE_ENTITY", { prompt: d.prompt, n: countText(d) });
    default: return d.prompt;
  }
}

/** promptKey ごとの文。args のカード名は画面の言語の名前にする */
function askText(key: string, d: Decision): string | null {
  const a = d.promptArgs ?? {};
  const card = a.card ? displayName(a.card) : "";
  const desc = lang() === "ja" && a.descJa && /[ぁ-んァ-ヶ一-龠]/.test(a.descJa) ? a.descJa : a.desc ?? "";
  switch (key) {
    case "priority": return t("prompt.PRIORITY");
    case "targets": return d.max > 1 ? t("prompt.TARGETS.n", { n: countText(d) }) : t("ask.targets", { card });
    case "optionalTrigger": return t("ask.optionalTrigger", { desc });
    case "mode": return t("ask.mode", { card, n: countText(d) });
    case "attackers": return t("prompt.ATTACKERS");
    case "payMana": return t("ask.payMana", { cost: a.cost ?? "", card });
    case "payCost": return t("ask.payCost", { card, n: countText(d) });
    case "totalPower": return t("prompt.totalPower", { n: a.n ?? "" });
    case "assignDamage":
      return t("prompt.assignDamage", { from: displayName(a.from ?? ""), to: displayName(a.to ?? ""), lethal: a.lethal ?? "", left: a.left ?? "" });
    case "announce": return a.what === "X" ? t("prompt.X") : t("ask.announce", { what: a.what ?? "", card });
    case "zoneChange": return t("ask.zoneChange", { zone: zoneName(capitalize(a.zone ?? "")) });
    case "sacrifice": return t("ask.sacrifice", { n: countText(d) });
    case "destroy": return t("ask.destroy", { n: countText(d) });
    case "discard": return t("ask.discard", { n: countText(d) });
    case "discardHandSize": return t("ask.discardHandSize", { n: a.n ?? "" });
    case "delve": return t("ask.delve", { n: countText(d) });
    case "convoke": return t("ask.convoke");
    case "totalCMC": return t("ask.totalCMC", { n: a.n ?? "" });
    case "divide": return t("ask.divide", { target: displayName(a.target ?? ""), left: a.left ?? "" });
    case "putOnTop": return t("ask.putOnTop", { card });
    case "scryBottom": return t("ask.scryBottom");
    case "surveilGrave": return t("ask.surveilGrave");
    case "orderSimultaneous": return t("ask.orderSimultaneous");
    case "orderBlockers": return t("ask.orderBlockers", { card });
    case "orderAttackers": return t("ask.orderAttackers", { card });
    case "counterType": return t("ask.counterType");
    case "protection": return t("ask.protection");
    case "replacementOrder": return t("ask.replacementOrder");
    case "staticOrder": return t("ask.staticOrder");
    case "optionalCost": return t("ask.optionalCost", { card });
    case "color": return a.n ? t("ask.color.n", { card, n: a.n, of: a.of ?? "" }) : t("ask.color", { card });
    default: return null;
  }
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
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
      if (e.from === "Library" && e.to === "Hand") {
        if (!e.player) return t("log.draw");
        const resolvedName = name(e.cardId);
        const knownCard = e.player === viewer && resolvedName && resolvedName !== e.cardId && !/^f\d+$/.test(resolvedName);
        return knownCard
          ? t("log.drawCard", { player: playerName(e.player, viewer), card: card(e.cardId) })
          : t("log.drawPlayer", { player: playerName(e.player, viewer) });
      }
      return t("log.move", { card: card(e.cardId), from: zoneName(e.from), to: zoneName(e.to) });
    case "tapped": return null;
    case "counters": return t("log.counters", { card: card(e.cardId), counter: e.counter, from: e.from, to: e.to });
    case "attackersDeclared":
      return e.attackers.length ? t("log.attack", { list: e.attackers.map((a) => card(a.cardId)).join(t("log.sep")) }) : null;
    case "gameOver": {
      const base = e.winner ? t("log.gameOver", { player: playerName(e.winner, viewer) }) : t("log.gameOverDraw");
      const reason = outcomeReason(e.winCondition, e.outcomes);
      return reason ? `${base} — ${reason}` : base;
    }
  }
}

function outcomeReason(winCondition?: string | null, outcomes?: string[]): string | null {
  const joined = (outcomes ?? []).join(" ");
  if (winCondition === "Milled" || joined.includes("empty library")) return t("log.win.Milled");
  if (winCondition === "LifeReachedZero" || joined.includes("life total reached 0")) return t("log.win.LifeReachedZero");
  if (winCondition === "Poisoned" || joined.includes("poison counters")) return t("log.win.Poisoned");
  if (winCondition === "CommanderDamage" || joined.includes("commander damage")) return t("log.win.CommanderDamage");
  if (winCondition === "SpellEffect" || joined.includes("effect of a spell")) return t("log.win.SpellEffect");
  if (winCondition === "Conceded" || joined.includes("conceded")) return t("log.win.Conceded");
  const wk = winCondition ? (`log.win.${winCondition}` as MessageKey) : null;
  if (wk && t(wk) !== wk) return t(wk);
  return outcomes?.length ? outcomes.join(" / ") : null;
}
