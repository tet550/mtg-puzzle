// 選択要求（Decision）を、盤面で押せるもの（候補）と操作の欄のボタンに振り分ける。

import type { Decision, GameView, Option } from "../engine/protocol";
import type { Mark } from "./board";

export interface Interaction {
  decision: Decision;
  /** 盤面のカード・プレイヤー → それを指す選択肢 */
  onBoard: Map<string, Option[]>;
  /** 盤面に無いもの（モード・数・見えない領域のカード）。操作の欄に並べる */
  listed: Option[];
  /** パス・自動で支払う・取りやめ・はい・いいえ */
  specials: Option[];
  /** 1 つ選んだらすぐ送る（min = max = 1） */
  single: boolean;
}

export function buildInteraction(d: Decision, view: GameView): Interaction {
  const visible = new Set<string>(view.players.flatMap((p) => [p.id, ...p.cards.map((c) => c.instanceId)]));
  const onBoard = new Map<string, Option[]>();
  const listed: Option[] = [];
  const specials: Option[] = [];
  for (const o of d.options) {
    const key = refKey(o);
    if (o.ref?.type === "special") specials.push(o);
    else if (key && visible.has(key)) onBoard.set(key, [...(onBoard.get(key) ?? []), o]);
    else listed.push(o);
  }
  return { decision: d, onBoard, listed, specials, single: d.min === 1 && d.max === 1 };
}

export function refKey(o: Option): string | null {
  const r = o.ref;
  if (!r) return null;
  if (r.type === "card" || r.type === "ability") return r.cardId;
  if (r.type === "player") return r.player;
  return null;
}

/** 盤面の印: 候補は cand、選んだものは chosen */
export function marksOf(i: Interaction | null, selected: Set<string>): Map<string, Mark> {
  const m = new Map<string, Mark>();
  if (!i) return m;
  for (const [key, opts] of i.onBoard) {
    m.set(key, opts.some((o) => selected.has(o.id)) ? "chosen" : "cand");
  }
  return m;
}

/** PRIORITY の選択肢のラベル（"Name | 説明" から、何をするかの短い文に） */
export function optionLabel(o: Option): string {
  const r = o.ref;
  if (r?.type === "ability") {
    const desc = o.label.includes(" | ") ? o.label.slice(o.label.indexOf(" | ") + 3).trim() : o.label;
    if (r.abilityKind === "land") return "土地として出す";
    if (r.abilityKind === "spell") return `唱える${shorten(desc) ? `: ${shorten(desc)}` : ""}`;
    return `起動: ${shorten(desc)}`;
  }
  if (r?.type === "special") {
    return { pass: "パス", auto: "自動で支払う", cancel: "取りやめ", yes: "はい", no: "いいえ" }[r.value];
  }
  if (r?.type === "player") return r.player === "p1" ? "あなた" : "相手";
  return o.label.replace(/\s*\((Battlefield|Hand|Graveyard|Exile|Stack|Library), p\d\)$/, "");
}

function shorten(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 60 ? one.slice(0, 58) + "…" : one;
}
