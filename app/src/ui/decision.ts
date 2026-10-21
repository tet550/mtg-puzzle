// 選択要求（Decision）を、盤面で押せるもの（候補）と操作の欄のボタンに振り分ける。

import type { Decision, GameView, ManaColor, Option } from "../engine/protocol";
import { t, type MessageKey } from "../i18n";
import type { Mark } from "./board";
import { displayName } from "./images";
import { localized } from "./localize";

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
    // 色は、カードの上の吹き出しで選ぶ。カードが見えないときのために、操作の欄にも並べる
    if (o.ref?.type === "color" && key && visible.has(key)) listed.push(o);
  }
  return { decision: d, onBoard, listed, specials, single: d.min === 1 && d.max === 1 };
}

export function refKey(o: Option): string | null {
  const r = o.ref;
  if (!r) return null;
  if (r.type === "card" || r.type === "ability") return r.cardId;
  if (r.type === "color") return r.cardId;
  if (r.type === "player") return r.player;
  return null;
}

/**
 * 盤面の印: 候補は cand、選んだものは chosen。
 * マナ能力しか無いもの（優先権のときの土地など）は印を付けない（押せば起動できるが、毎回すべての土地が光るとうるさい）
 */
export function marksOf(i: Interaction | null, selected: Set<string>): Map<string, Mark> {
  const m = new Map<string, Mark>();
  if (!i) return m;
  for (const [key, opts] of i.onBoard) {
    if (opts.every((o) => o.ref?.type === "ability" && o.ref.abilityKind === "mana")) continue;
    m.set(key, opts.some((o) => selected.has(o.id)) ? "chosen" : "cand");
  }
  return m;
}

/** PRIORITY の選択肢のラベル（"Name | 説明" から、何をするかの短い文に） */
export function optionLabel(o: Option): string {
  const r = o.ref;
  if (r?.type === "ability") {
    // "Name | 説明" の説明の部分（日本語の画面では Forge の訳）
    const after = (s: string) => (s.includes(" | ") ? s.slice(s.indexOf(" | ") + 3).trim() : s);
    const desc = localized(after(o.label), o.labelJa ? after(o.labelJa) : null);
    if (r.abilityKind === "land") return t("opt.land");
    if (r.abilityKind === "spell") return shorten(desc) ? t("opt.castWith", { desc: shorten(desc) }) : t("opt.cast");
    if (r.abilityKind === "mana" && r.color) return t("opt.manaColor", { desc: shorten(stripColor(desc)), color: colorName(r.color) });
    if (r.abilityKind === "mana") return t("opt.mana", { desc: shorten(desc) });
    return t("opt.activate", { desc: shorten(desc) });
  }
  if (r?.type === "color") return colorName(r.color);
  if (r?.type === "special") {
    return t(`opt.${r.value}`);
  }
  if (r?.type === "player") return r.player === "p1" ? t("player.you") : t("player.opponent");
  if (r?.type === "card" && o.labelJa) return localized(o.label, o.labelJa); // マナ源（"名前: {T}：…を加える。"）
  if (r?.type === "card") return displayName(o.label.replace(/\s*\((Battlefield|Hand|Graveyard|Exile|Stack|Library), p\d\)$/, ""));
  return localized(o.label, o.labelJa); // モード・色・二択・効果の順など
}

function shorten(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 60 ? one.slice(0, 58) + "…" : one;
}

export function colorName(c: ManaColor): string {
  return t(`color.${c}` as MessageKey);
}

/** 色ごとに分けたマナ能力のラベルの末尾の " [G]" */
function stripColor(s: string): string {
  return s.replace(/\s*\[[WUBRG]\]$/, "");
}

/** 色ごとに分けたマナ能力の、色を除いたラベル（メニューで 1 行にまとめるとき） */
export function manaLabel(o: Option): string {
  return optionLabel({ ...o, label: stripColor(o.label), labelJa: o.labelJa ? stripColor(o.labelJa) : null,
    ref: o.ref?.type === "ability" ? { ...o.ref, color: undefined } : o.ref });
}

/** 色の問い合わせ（起動したマナ能力の色・「色を 1 つ選ぶ」効果）。取りやめはできない */
export function isColorAsk(d: Decision): boolean {
  return d.options.length > 0 && d.options.every((o) => o.ref?.type === "color");
}
