// 盤面の描画。見せ方は mtgtable（mtg-playtest の GUI）に合わせる（design/phase1-plan.md の D9・M5）。
// - 上に相手の側、下に自分の側。間に戦闘の欄、スタックは浮かぶ小窓
// - 戦場の土地以外は種類ごとに左から、土地は別の行で名前ごとの束（タップ状態はまとめて 1 束）
// - 相手の手札・土地・ライブラリー・墓地・追放は枚数や要約だけ。選択の候補になったときだけ開いて見せる

import type { CardKind, CardView, GameView, ManaColor, PlayerView } from "../engine/protocol";
import { h, onTapOrHold } from "./dom";
import { PHASE_STRIP, passLabel } from "./text";

export type Mark = "cand" | "chosen";

export interface BoardHooks {
  /** カードを押した（選択の候補でなければ詳細を出す） */
  card(c: CardView): void;
  /** 長押し・右クリック: 詳細 */
  detail(c: CardView): void;
  player(id: string): void;
  /** 相手の要約（土地・墓地・追放）を開く・閉じる */
  toggle(key: string): void;
}

export interface BoardUi {
  viewer: string;
  marks: Map<string, Mark>;
  /** 開いている相手の要約（"lands" / "graveyard" / "exile"）と自分の束（"my-graveyard" / "my-exile"） */
  open: Set<string>;
  /** 期限（このターン中）の表示用 */
  startTurn: number;
  /** 直前の出来事で変わったカード（短く光らせる） */
  flash: Set<string>;
  /** カード画像の URL（画像を出さない設定か、画像が無ければ null） */
  art: (name: string) => string | null;
}

const KIND_ORDER: CardKind[] = ["creature", "artifact", "enchantment", "planeswalker", "battle"];
const MANA_ORDER: ManaColor[] = ["W", "U", "B", "R", "G", "C"];

export function renderBoard(view: GameView, ui: BoardUi, hooks: BoardHooks): HTMLElement {
  const me = view.players.find((p) => p.id === ui.viewer) ?? view.players[0];
  const opp = view.players.find((p) => p !== me) ?? view.players[1];
  return h("section.board", null,
    opponentSide(view, opp, ui, hooks),
    combatBox(view, ui, hooks),
    mySide(view, me, ui, hooks),
  );
}

// ---------------------------------------------------------------- 見出し

function playerHead(view: GameView, p: PlayerView, ui: BoardUi, hooks: BoardHooks, mine: boolean): HTMLElement {
  const mark = ui.marks.get(p.id);
  const head = h("div.phead" + (mark ? `.${mark}` : ""), { "data-player": p.id });
  head.addEventListener("click", () => hooks.player(p.id));
  const life = h("span.life" + (p.life <= 0 ? ".dead" : p.life <= 5 ? ".low" : ""), { title: "ライフ" },
    h("span.lbl", null, "LIFE"), h("span.lnum", null, p.life));
  head.append(h("span.who", null, mine ? "あなた" : "相手"), life);
  head.append(h("span.prio" + (view.priorityPlayer === p.id ? "" : ".off"), { title: "優先権" }, "◆"));
  if (view.activePlayer === p.id) head.append(phaseStrip(view, ui));
  const extra = h("span.pextra");
  for (const c of MANA_ORDER) {
    const n = p.manaPool[c];
    if (n) extra.append(h(`span.chip.mana.m${c}`, null, `{${c}} ×${n}`));
  }
  if (p.poison) extra.append(h("span.chip", null, `毒 ${p.poison}`));
  head.append(extra);
  return head;
}

function phaseStrip(view: GameView, ui: BoardUi): HTMLElement {
  const strip = h("span.phases", { title: `${view.turn} ターン目` });
  for (const g of PHASE_STRIP) {
    const cur = g.phases.includes(view.phase);
    strip.append(h("span.ph" + (cur ? ".cur" : ""), null, g.label));
  }
  if (view.turn === ui.startTurn) strip.append(h("span.chip.deadline", { title: "このターン中に勝てばクリア" }, "このターン中"));
  return strip;
}

// ---------------------------------------------------------------- 相手の側（最小限）

function opponentSide(view: GameView, p: PlayerView, ui: BoardUi, hooks: BoardHooks): HTMLElement {
  const side = h("div.side.opp" + (view.activePlayer === p.id ? ".active" : ""));
  side.append(playerHead(view, p, ui, hooks, false));
  const bf = battlefield(p);
  const lands = bf.filter((c) => c.kinds.includes("land"));
  const others = bf.filter((c) => !c.kinds.includes("land"));
  const gy = p.cards.filter((c) => c.zone === "Graveyard");
  const ex = p.cards.filter((c) => c.zone === "Exile");
  // 選択の候補・選んだものを含む要約は開いて見せる
  const forced = (cards: CardView[]) => cards.some((c) => ui.marks.has(c.instanceId));
  const isOpen = (key: string, cards: CardView[]) => ui.open.has(key) || forced(cards);

  const untapped = lands.filter((c) => !c.tapped).length;
  const summary = h("div.osum", null,
    summaryChip(`土地 ${lands.length}（アンタップ ${untapped}）`, "lands", isOpen("lands", lands), lands.length > 0, hooks),
    h("span.chip", { title: "相手の手札" }, `手札 ${p.handCount}`),
    h("span.chip", { title: "相手のライブラリー" }, `ライブラリー ${p.libraryCount}`),
    summaryChip(`墓地 ${gy.length}`, "graveyard", isOpen("graveyard", gy), gy.length > 0, hooks),
    summaryChip(`追放 ${ex.length}`, "exile", isOpen("exile", ex), ex.length > 0, hooks),
  );
  side.append(summary);
  // 土地以外のパーマネントは自分の側と同じ大きさ（ブロッカー・対象・除去の対象になるため）
  if (others.length) side.append(h("div.row.bfrow", null, kindGroups(others, p, ui, hooks)));
  if (isOpen("lands", lands) && lands.length) side.append(h("div.row.bfrow.lands", null, landGroups(lands, ui, hooks)));
  if (isOpen("graveyard", gy) && gy.length) side.append(opened("相手の墓地", gy, ui, hooks));
  if (isOpen("exile", ex) && ex.length) side.append(opened("相手の追放", ex, ui, hooks));
  return side;
}

function summaryChip(text: string, key: string, open: boolean, enabled: boolean, hooks: BoardHooks): HTMLElement {
  return h("button.chip.sumchip" + (open ? ".on" : ""), {
    type: "button", disabled: !enabled, "aria-expanded": String(open),
    onclick: (ev: Event) => { ev.stopPropagation(); hooks.toggle(key); },
  }, text);
}

// ---------------------------------------------------------------- 自分の側

function mySide(view: GameView, p: PlayerView, ui: BoardUi, hooks: BoardHooks): HTMLElement {
  const side = h("div.side.mine" + (view.activePlayer === p.id ? ".active" : ""));
  side.append(playerHead(view, p, ui, hooks, true));
  const bf = battlefield(p);
  const lands = bf.filter((c) => c.kinds.includes("land"));
  const others = bf.filter((c) => !c.kinds.includes("land"));
  const gy = p.cards.filter((c) => c.zone === "Graveyard");
  const ex = p.cards.filter((c) => c.zone === "Exile" && !c.exiledBy);
  const hand = p.cards.filter((c) => c.zone === "Hand");

  const piles = h("div.piles", null,
    pile("ライブラリー", p.libraryCount, null, false, null, ui),
    pile("墓地", gy.length, gy[gy.length - 1] ?? null, ui.open.has("my-graveyard") || gy.some((c) => ui.marks.has(c.instanceId)), () => hooks.toggle("my-graveyard"), ui),
    ex.length ? pile("追放", ex.length, ex[ex.length - 1], ui.open.has("my-exile") || ex.some((c) => ui.marks.has(c.instanceId)), () => hooks.toggle("my-exile"), ui) : null,
  );
  const field = h("div.field", null,
    h("div.row.bfrow", null, kindGroups(others, p, ui, hooks)),
    h("div.row.bfrow.lands", null, landGroups(lands, ui, hooks)),
  );
  const handRow = h("div.hand.fan", { "data-zone": "hand" }, hand.map((c) => cardTile(c, ui, hooks, ".inhand")));
  side.append(h("div.sidegrid", null, piles, h("div.sidemain", null, field, handRow)));
  if ((ui.open.has("my-graveyard") || gy.some((c) => ui.marks.has(c.instanceId))) && gy.length) side.append(opened("あなたの墓地", gy, ui, hooks));
  if ((ui.open.has("my-exile") || ex.some((c) => ui.marks.has(c.instanceId))) && ex.length) side.append(opened("あなたの追放", ex, ui, hooks));
  return side;
}

function pile(label: string, count: number, top: CardView | null, open: boolean, onclick: (() => void) | null, ui: BoardUi): HTMLElement {
  const url = top ? ui.art(top.name) : null;
  const face = top
    ? h("div.face", null, url ? h("img", { src: url, alt: top.name, loading: "lazy" }) : h("div.ftext", null, top.name))
    : count ? h("div.face.back") : null;
  return h("div.pile" + (count ? "" : ".empty") + (open ? ".open" : ""), {
    onclick: onclick && count ? (ev: Event) => { ev.stopPropagation(); onclick(); } : null,
    title: `${label} ${count} 枚`,
  }, h("div.pstack", null, face, h("span.chip.strong.pcount", null, count)), h("div.plabel", null, label));
}

function opened(title: string, cards: CardView[], ui: BoardUi, hooks: BoardHooks): HTMLElement {
  return h("div.zone.opened", null, h("h3", null, `${title}（${cards.length}）`),
    h("div.row", null, cards.map((c) => cardTile(c, ui, hooks, ""))));
}

// ---------------------------------------------------------------- 戦場の並べ方

function battlefield(p: PlayerView): CardView[] {
  return p.cards.filter((c) => c.zone === "Battlefield" && c.controller === p.id && !isAttachedToCard(c, p));
}

function isAttachedToCard(c: CardView, p: PlayerView): boolean {
  return !!c.attachedTo && p.cards.some((o) => o.instanceId === c.attachedTo);
}

function kindOf(c: CardView): number {
  const i = KIND_ORDER.findIndex((k) => c.kinds.includes(k));
  return i < 0 ? KIND_ORDER.length : i;
}

/** 土地以外: 種類ごとに左から（クリーチャー → アーティファクト → エンチャント → PW → バトル）。付いているものは下に差し込む */
function kindGroups(cards: CardView[], p: PlayerView, ui: BoardUi, hooks: BoardHooks): HTMLElement[] {
  const sorted = cards.map((c, i) => ({ c, i })).sort((a, b) => kindOf(a.c) - kindOf(b.c) || a.i - b.i);
  let prev = -1;
  return sorted.map(({ c }) => {
    const under = p.cards.filter((o) => o.attachedTo === c.instanceId || (o.zone === "Exile" && o.exiledBy === c.instanceId));
    const tile = under.length ? tuck(c, under, ui, hooks) : cardTile(c, ui, hooks, "");
    if (prev >= 0 && kindOf(c) !== prev) tile.classList.add("kgap");
    prev = kindOf(c);
    return tile;
  });
}

function tuck(c: CardView, under: CardView[], ui: BoardUi, hooks: BoardHooks): HTMLElement {
  const box = h("div.tuck", { style: `--n:${under.length}` } as never);
  under.forEach((u, i) => {
    const t = cardTile(u, ui, hooks, ".under");
    t.style.top = `${i * 18}px`;
    box.append(t);
  });
  box.append(cardTile(c, ui, hooks, ""));
  return box;
}

/** 土地: アンタップは名前ごとの束、タップ状態はまとめて 1 束。束には ×N */
function landGroups(lands: CardView[], ui: BoardUi, hooks: BoardHooks): HTMLElement[] {
  const groups: { key: string; cards: CardView[] }[] = [];
  for (const c of lands) {
    const key = c.tapped ? "tapped" : c.name;
    const g = groups.find((x) => x.key === key);
    if (g) g.cards.push(c);
    else groups.push({ key, cards: [c] });
  }
  return groups.map((g) => {
    // 選択の候補を含む束は重ねずに広げる（1 枚ずつ選べるように）
    const spread = g.cards.some((c) => ui.marks.has(c.instanceId));
    const box = h("div.lgroup" + (spread ? "" : ".overlap"), null, g.cards.map((c) => cardTile(c, ui, hooks, ".land")));
    if (g.cards.length > 1 && !spread) box.append(h("span.chip.strong.gcount", null, `×${g.cards.length}`));
    return box;
  });
}

// ---------------------------------------------------------------- 戦闘の欄

function combatBox(view: GameView, ui: BoardUi, hooks: BoardHooks): HTMLElement | null {
  if (!view.combat.length) return null;
  const byId = new Map(view.players.flatMap((p) => p.cards).map((c) => [c.instanceId, c]));
  return h("div.combatbox", null, h("h3", null, "戦闘"),
    h("div.combat", null, view.combat.map((a) => {
      const att = byId.get(a.attackerId);
      return h("div.attack", null,
        att ? cardTile(att, ui, hooks, ".small") : a.attackerId,
        h("span.arrow", null, "→"),
        h("span.chip", null, view.players.some((p) => p.id === a.defender) ? (a.defender === ui.viewer ? "あなた" : "相手") : byId.get(a.defender)?.name ?? a.defender),
        a.blockers.length ? h("span.muted", null, "ブロック: ", a.blockers.map((b) => byId.get(b)?.name ?? b).join("、")) : null,
      );
    })));
}

// ---------------------------------------------------------------- カード

export function cardTile(c: CardView, ui: BoardUi, hooks: BoardHooks, extra: string): HTMLElement {
  const mark = ui.marks.get(c.instanceId);
  const small = extra.includes("small");
  const url = small || c.faceDown ? null : ui.art(c.name);
  const cls = "div.card" + extra + (url ? ".withart" : "") + (c.tapped ? ".tapped" : "") + (mark ? `.${mark}` : "")
    + (ui.flash.has(c.instanceId) ? ".flash" : "");
  const d = h(cls as "div", { "data-id": c.instanceId, title: `${c.name}${c.tapped ? "（タップ）" : ""}` });
  const flags: string[] = [];
  if (c.token) flags.push("トークン");
  if (c.sick && c.kinds.includes("creature") && c.zone === "Battlefield") flags.push("召喚酔い");
  if (c.controller !== c.owner) flags.push(`持ち主 ${c.owner}`);
  const chips: HTMLElement[] = Object.entries(c.counters).map(([k, n]) => h("span.chip.strong", null, `${counterName(k)} ×${n}`));
  if (c.damage) chips.push(h("span.chip.strong.dmg", null, `ダメージ ${c.damage}`));
  const pt = c.power !== null && c.toughness !== null
    ? h("span.pt" + (c.power !== c.basePower || c.toughness !== c.baseToughness ? ".mod" : ""), null, `${c.power}/${c.toughness}`)
    : null;

  if (url) {
    // 画像のカード: 絵の上にエンジンが持っている情報（状態・カウンター・P/T）を重ねる（mtgtable の art と同じ）
    const img = h("img.art", { src: url, alt: c.name, loading: "lazy" });
    const box = h("div.artbox", null, img,
      flags.length ? h("div.flags", null, flags.map((f) => h("span.chip.strong", null, f))) : null,
      chips.length ? h("div.over", null, chips) : null,
      pt);
    img.addEventListener("error", () => { box.classList.add("noimg"); img.remove(); box.prepend(h("div.alt", null, c.name)); });
    d.append(box);
    if (!extra.includes("under")) d.append(h("div.nm", null, c.name));
  } else {
    const cost = c.manaCost && c.manaCost !== "no cost" ? h("span.cost", null, c.manaCost) : null;
    d.append(h("div.top", null, h("div.nm", null, c.name), cost));
    if (!small && !extra.includes("under")) d.append(h("div.tl", null, c.typeLine));
    if (flags.length) d.append(h("div.flags", null, flags.join(" · ")));
    if (chips.length) d.append(h("div.over", null, chips));
    if (pt) d.append(pt);
  }
  onTapOrHold(d, (ev) => { ev.stopPropagation(); hooks.card(c); }, () => hooks.detail(c));
  return d;
}

function counterName(k: string): string {
  const m: Record<string, string> = { P1P1: "+1/+1", M1M1: "-1/-1", LOYALTY: "忠誠", DEFENSE: "守備", POISON: "毒" };
  return m[k] ?? k.toLowerCase();
}

export function detailBody(c: CardView, art: string | null, artist: string | null): HTMLElement {
  const lines = [
    art ? h("img.big", { src: art, alt: c.name }) : null,
    art && artist ? h("div.muted.credit", null, `Illustrated by ${artist}`) : null,
    h("div.dname", null, c.name, c.manaCost && c.manaCost !== "no cost" ? h("span.cost", null, " ", c.manaCost) : null),
    h("div.tl", null, c.typeLine),
    c.power !== null ? h("div", null, `P/T ${c.power}/${c.toughness}` + (c.power !== c.basePower || c.toughness !== c.baseToughness ? `（元は ${c.basePower}/${c.baseToughness}）` : "")) : null,
    // Forge のルール文は改行を "\n" の 2 文字で持っている
    h("div.otext", null, c.text ? c.text.replace(/\\n/g, "\n") : "（ルール文なし）"),
    h("div.muted", null, [c.tapped && "タップ状態", c.sick && c.kinds.includes("creature") && "召喚酔い", c.token && "トークン",
      c.damage && `ダメージ ${c.damage}`].filter(Boolean).join(" · ")),
  ];
  return h("div.detail", null, lines);
}

export { passLabel };
