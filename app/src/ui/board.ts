// 盤面の描画。見せ方は mtgtable（mtg-playtest の GUI）に合わせる（design/phase1-plan.md の D9・M5）。
// - 上に相手の側、下に自分の側。戦闘・スタック・カードの詳細は盤面の上に浮かぶ小窓（play.ts）
// - 見出しは 1 行: アバター・LIFE・優先権（挙げた手）・フェイズのアイコン（今のフェイズにステップ名）
// - 左の列に束（ライブラリー・墓地・追放。名前はカードの上に重ねる）、右に戦場・土地・手札
// - 戦場の土地以外は種類ごとに左から、土地は別の行で名前ごとの束（タップ状態はまとめて 1 束）
// - 相手の手札・土地・ライブラリー・墓地・追放は枚数や要約だけ。選択の候補になったときだけ開いて見せる

import type { CardKind, CardView, GameView, ManaColor, PlayerView } from "../engine/protocol";
import { h, onTapOrHold } from "./dom";
import { t, type MessageKey } from "../i18n";
import { avatarUrl, icon } from "./icons";
import { displayName } from "./images";
import { localized } from "./localize";
import { manaNodes } from "./mana";
import { PHASE_STRIP, passLabel, phaseName } from "./text";

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
  /** 攻撃している・ブロックしているカード（カードの上に札を出す） */
  attacking: Set<string>;
  blocking: Set<string>;
}

export function combatSets(view: GameView): { attacking: Set<string>; blocking: Set<string> } {
  return {
    attacking: new Set(view.combat.map((a) => a.attackerId)),
    blocking: new Set(view.combat.flatMap((a) => a.blockers)),
  };
}

const KIND_ORDER: CardKind[] = ["creature", "artifact", "enchantment", "planeswalker", "battle"];
const MANA_ORDER: ManaColor[] = ["W", "U", "B", "R", "G", "C"];

export function renderBoard(view: GameView, ui: BoardUi, hooks: BoardHooks): HTMLElement {
  const me = view.players.find((p) => p.id === ui.viewer) ?? view.players[0];
  const opp = view.players.find((p) => p !== me) ?? view.players[1];
  return h("section.board", null,
    opponentSide(view, opp, ui, hooks),
    mySide(view, me, ui, hooks),
  );
}

// ---------------------------------------------------------------- 見出し

function playerHead(view: GameView, p: PlayerView, ui: BoardUi, hooks: BoardHooks, mine: boolean): HTMLElement {
  const mark = ui.marks.get(p.id);
  const head = h("div.phead" + (mark ? `.${mark}` : ""), { "data-player": p.id });
  head.addEventListener("click", () => hooks.player(p.id));
  const who = mine ? t("player.you") : t("player.opponent");
  // 名前は出さずにアイコンで示す（名前は Tip）。あなたは旅の少年、相手（自動でパスする）は石のゴーレム
  const avatar = h("span.avatar" + (mine ? ".me" : ""), { title: who, "aria-label": who },
    h("img", { src: avatarUrl(mine ? "human" : "ai"), alt: "" }));
  const life = h("span.life" + (p.life <= 0 ? ".dead" : p.life <= 5 ? ".low" : ""), { title: t("player.life") },
    h("span.llbl", null, "LIFE"), h("span.lnum", null, p.life));
  head.append(avatar, life);
  // 優先権: ライフの右の決まった欄に挙げた手（持っていない側も欄は取っておく）
  const prio = h("span.prio" + (view.priorityPlayer === p.id ? "" : ".off"), { title: t("player.priority"), "aria-label": t("player.priority") });
  prio.append(icon("priority"));
  head.append(prio);
  if (view.activePlayer === p.id) head.append(phaseStrip(view, ui));
  const extra = h("span.pextra");
  for (const c of MANA_ORDER) {
    const n = p.manaPool[c];
    if (n) extra.append(h(`span.chip.mana.m${c}`, { title: `{${c}} ×${n}` }, manaNodes(`{${c}}`), ` ×${n}`));
  }
  if (p.poison) extra.append(h("span.chip", null, t("player.poison", { n: p.poison })));
  head.append(extra);
  return head;
}

function phaseStrip(view: GameView, ui: BoardUi): HTMLElement {
  const strip = h("span.phases", { title: t("phase.turnTitle", { turn: view.turn }) });
  for (const g of PHASE_STRIP) {
    const cur = g.phases.includes(view.phase);
    const ph = h("span.ph" + (cur ? ".cur" : "") + (g.icon === "ending" ? ".fill" : ""), { title: t(g.key) });
    ph.append(icon(g.icon));
    if (cur) ph.append(h("span.pstep", null, phaseName(view.phase)));
    strip.append(ph);
  }
  const box = h("span.phasebox", null, strip);
  if (view.turn === ui.startTurn) box.append(h("span.chip.deadline", { title: t("phase.deadline.title") }, t("phase.deadline")));
  return box;
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
    summaryChip(t("opp.lands", { n: lands.length, untapped }), "lands", isOpen("lands", lands), lands.length > 0, hooks, p.id),
    h("span.chip", { title: t("opp.hand.title"), "data-pile": "hand", "data-owner": p.id }, t("opp.hand", { n: p.handCount })),
    h("span.chip", { title: t("opp.library.title"), "data-pile": "library", "data-owner": p.id }, t("opp.library", { n: p.libraryCount })),
    summaryChip(t("opp.graveyard", { n: gy.length }), "graveyard", isOpen("graveyard", gy), gy.length > 0, hooks, p.id),
    summaryChip(t("opp.exile", { n: ex.length }), "exile", isOpen("exile", ex), ex.length > 0, hooks, p.id),
  );
  side.append(summary);
  // 土地以外のパーマネントは自分の側と同じ大きさ（ブロッカー・対象・除去の対象になるため）
  if (others.length) side.append(h("div.row.bfrow", null, kindGroups(others, p, ui, hooks)));
  if (isOpen("lands", lands) && lands.length) side.append(h("div.row.bfrow.lands", null, landGroups(lands, ui, hooks)));
  if (isOpen("graveyard", gy) && gy.length) side.append(opened(t("opened.oppGraveyard"), gy, ui, hooks));
  if (isOpen("exile", ex) && ex.length) side.append(opened(t("opened.oppExile"), ex, ui, hooks));
  return side;
}

function summaryChip(text: string, key: string, open: boolean, enabled: boolean, hooks: BoardHooks, owner: string): HTMLElement {
  return h("button.chip.sumchip" + (open ? ".on" : ""), {
    type: "button", disabled: !enabled, "aria-expanded": String(open), "data-pile": key, "data-owner": owner,
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
    pile(t("pile.library"), p.libraryCount, null, false, null, ui, "library", p.id),
    pile(t("pile.graveyard"), gy.length, gy[gy.length - 1] ?? null, ui.open.has("my-graveyard") || gy.some((c) => ui.marks.has(c.instanceId)), () => hooks.toggle("my-graveyard"), ui, "graveyard", p.id),
    ex.length ? pile(t("pile.exile"), ex.length, ex[ex.length - 1], ui.open.has("my-exile") || ex.some((c) => ui.marks.has(c.instanceId)), () => hooks.toggle("my-exile"), ui, "exile", p.id) : null,
  );
  const field = h("div.field", null,
    h("div.row.bfrow", null, kindGroups(others, p, ui, hooks)),
    h("div.row.bfrow.lands", null, landGroups(lands, ui, hooks)),
  );
  // 手札は土地に少し重ね、欄の下の端で切る（mtgtable と同じ。押すと浮かせて全体を見せる）
  const handRow = h("div.handbox", { "data-pile": "hand", "data-owner": p.id }, h("div.hand.fan", { "data-zone": "hand" }, hand.map((c) => cardTile(c, ui, hooks, ".inhand"))));
  side.append(h("div.sidegrid", null, piles, h("div.sidemain", null, field, handRow)));
  if ((ui.open.has("my-graveyard") || gy.some((c) => ui.marks.has(c.instanceId))) && gy.length) side.append(opened(t("opened.myGraveyard"), gy, ui, hooks));
  if ((ui.open.has("my-exile") || ex.some((c) => ui.marks.has(c.instanceId))) && ex.length) side.append(opened(t("opened.myExile"), ex, ui, hooks));
  return side;
}

function pile(label: string, count: number, top: CardView | null, open: boolean, onclick: (() => void) | null, ui: BoardUi, key: string, owner: string): HTMLElement {
  const url = top ? ui.art(top.name) : null;
  const face = top
    ? h("div.face", { "data-top": top.instanceId }, url ? h("img", { src: url, alt: displayName(top.name), loading: "lazy" }) : h("div.ftext", null, displayName(top.name)))
    : count ? h("div.face.back") : null;
  return h("div.pile" + (count ? "" : ".empty") + (open ? ".open" : ""), {
    "data-pile": key, "data-owner": owner,
    onclick: onclick && count ? (ev: Event) => { ev.stopPropagation(); onclick(); } : null,
    title: t("pile.title", { label, n: count }),
  }, h("div.pstack", null, h("div.plabel", null, label), face, h("span.chip.strong.pcount", null, count)));
}

function opened(title: string, cards: CardView[], ui: BoardUi, hooks: BoardHooks): HTMLElement {
  return h("div.zone.opened", null, h("h3", null, t("opened.count", { title, n: cards.length })),
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

// ---------------------------------------------------------------- 戦闘・スタックの小窓の中身

/** 戦闘: 攻撃クリーチャーごとに、カード → 攻撃先 → ブロックしているカードを縦に並べる（mtgtable の cbcol） */
export function combatBody(view: GameView, ui: BoardUi, hooks: BoardHooks): HTMLElement {
  const byId = new Map(view.players.flatMap((p) => p.cards).map((c) => [c.instanceId, c]));
  const target = (id: string) => view.players.some((p) => p.id === id)
    ? (id === ui.viewer ? t("player.you") : t("player.opponent")) : displayName(byId.get(id)?.name ?? id);
  return h("div.combat", null, view.combat.map((a) => {
    const att = byId.get(a.attackerId);
    const blockers = a.blockers.map((b) => byId.get(b)).filter((c): c is CardView => !!c);
    return h("div.cbcol", null,
      att ? cardTile(att, ui, hooks, ".incombat") : null,
      h("div.cbto", null, h("span.arw", null, "↓"), target(a.defender)),
      blockers.length ? h("div.cbrow", null, blockers.map((b) => cardTile(b, ui, hooks, ".incombat")))
        : h("div.cbblk", null, t("combat.noBlock")));
  }));
}

/** スタック: 上から順に、呪文はそのカード、能力は発生源のカードを小さく出し、横に名前・文・対象を並べる */
export function stackBody(view: GameView, ui: BoardUi, hooks: BoardHooks, names: Map<string, string>, known: Map<string, CardView>): HTMLElement {
  const byId = new Map(view.players.flatMap((p) => p.cards).map((c) => [c.instanceId, c]));
  // 唱えた呪文のカードは、エンジンの盤面のどの領域にも出てこない。最後に見えていた姿（手札のカード）で出す
  const spellCard = (id: string): CardView | undefined => byId.get(id) ?? (known.has(id) ? { ...known.get(id)!, zone: "Stack", tapped: false } : undefined);
  const onStack = new Set(view.stack.map((it) => it.sourceId));
  // 唱えている途中（対象・支払いを選んでいる間）の呪文も、まだスタックに載っていない項目として出す
  const casting = view.players.flatMap((p) => p.cards).filter((c) => c.zone === "Stack" && !onStack.has(c.instanceId));
  const item = (c: CardView | undefined, name: string, text: string, top: string, targets: string[], cls: string, source: string) =>
    h("li.sitem" + cls + (c && ui.marks.has(c.instanceId) ? ".cand" : ""), { "data-source": source },
      c ? cardTile(c, ui, hooks, ".instack" + (c.zone === "Stack" ? "" : ".src")) : null,
      h("div.sbody", null,
        h("div.shead", null, h("span.chip", null, top), h("span.sname", null, displayName(name))),
        h("div.stext", null, manaNodes(text)),
        targets.length ? h("div.stargets.muted", null, "→ ", targets.map((x) =>
          view.players.some((p) => p.id === x) ? (x === ui.viewer ? t("player.you") : t("player.opponent")) : displayName(byId.get(x)?.name ?? names.get(x) ?? x)).join(t("log.sep"))) : null));
  return h("ol.stack.panel", null,
    casting.map((c) => item(c, c.name, t("stack.casting"), "…", [], ".casting", c.instanceId)),
    view.stack.map((it) => item(it.spell ? spellCard(it.sourceId) : byId.get(it.sourceId), names.get(it.sourceId) ?? "?",
      localized(it.description.replace(/\s*\(\d+\)/g, ""), it.descriptionJa), it.index === 0 ? t("stack.top") : String(it.index + 1), it.targets, "", it.sourceId)));
}

// ---------------------------------------------------------------- カード

export function cardTile(c: CardView, ui: BoardUi, hooks: BoardHooks, extra: string): HTMLElement {
  const mark = ui.marks.get(c.instanceId);
  const small = extra.includes("small");
  const url = small || c.faceDown ? null : ui.art(c.name);
  const cls = "div.card" + extra + (url ? ".withart" : "") + (c.tapped ? ".tapped" : "") + (mark ? `.${mark}` : "")
    + (ui.flash.has(c.instanceId) ? ".flash" : "");
  const d = h(cls as "div", { "data-id": c.instanceId, title: `${displayName(c.name)}${c.tapped ? t("card.tapped") : ""}` });
  const flags: string[] = [];
  if (ui.attacking.has(c.instanceId)) flags.push(t("card.attacking"));
  if (ui.blocking.has(c.instanceId)) flags.push(t("card.blocking"));
  if (c.token) flags.push(t("card.token"));
  if (c.sick && c.kinds.includes("creature") && c.zone === "Battlefield") flags.push(t("card.sick"));
  if (c.controller !== c.owner) flags.push(t("card.owner", { owner: c.owner }));
  const chips: HTMLElement[] = Object.entries(c.counters).map(([k, n]) => h("span.chip.strong", null, `${counterName(k)} ×${n}`));
  if (c.damage) chips.push(h("span.chip.strong.dmg", null, t("card.damage", { n: c.damage })));
  const pt = c.power !== null && c.toughness !== null
    ? h("span.pt" + (c.power !== c.basePower || c.toughness !== c.baseToughness ? ".mod" : ""), null, `${c.power}/${c.toughness}`)
    : null;

  if (url) {
    // 画像のカード: 絵の上にエンジンが持っている情報（状態・カウンター・P/T）を重ねる（mtgtable の art と同じ）
    const img = h("img.art", { src: url, alt: displayName(c.name), loading: "lazy" });
    const box = h("div.artbox", null, img,
      flags.length ? h("div.flags", null, flags.map((f) => h("span.chip.strong" + (f === t("card.attacking") ? ".atk" : f === t("card.blocking") ? ".blk" : ""), null, f))) : null,
      chips.length ? h("div.over", null, chips) : null,
      pt);
    img.addEventListener("error", () => { box.classList.add("noimg"); img.remove(); box.prepend(h("div.alt", null, displayName(c.name))); });
    d.append(box);
    if (!extra.includes("under")) d.append(h("div.nm", null, displayName(c.name)));
  } else {
    const cost = c.manaCost && c.manaCost !== "no cost" ? h("span.cost", null, manaNodes(c.manaCost)) : null;
    d.append(h("div.top", null, h("div.nm", null, displayName(c.name)), cost));
    if (!small && !extra.includes("under")) d.append(h("div.tl", null, c.typeLine));
    if (flags.length) d.append(h("div.flags", null, flags.join(" · ")));
    if (chips.length) d.append(h("div.over", null, chips));
    if (pt) d.append(pt);
  }
  onTapOrHold(d, (ev) => { ev.stopPropagation(); hooks.card(c); }, () => hooks.detail(c));
  return d;
}

function counterName(k: string): string {
  const key = `counter.${k}` as MessageKey;
  const s = t(key);
  return s === key ? k.toLowerCase() : s;
}

/** カード詳細。日本語の画面で日本語の文があれば、それを出し、英語のオラクル（判定に使う文）は開けるようにする */
export function detailBody(c: CardView, art: string | null, artist: string | null, printed: string | null): HTMLElement {
  const oracle = c.text ? c.text.replace(/\\n/g, "\n") : t("card.noText"); // Forge は改行を "\n" の 2 文字で持つ
  const changed = c.power !== c.basePower || c.toughness !== c.baseToughness;
  // タップ状態は {T} のアイコンを添える
  const state = [c.tapped && `{T} ${t("card.tappedState")}`, c.sick && c.kinds.includes("creature") && t("card.sick"), c.token && t("card.token"),
    c.damage && t("card.damage", { n: c.damage })].filter(Boolean).join(" · ");
  return h("div.detail", null,
    art ? h("img.big", { src: art, alt: displayName(c.name) }) : null,
    h("div.dname", null, displayName(c.name), c.manaCost && c.manaCost !== "no cost" ? h("span.cost", null, " ", manaNodes(c.manaCost)) : null),
    displayName(c.name) !== c.name ? h("div.muted", null, c.name) : null,
    h("div.tl", null, c.typeLine),
    c.power !== null ? h("div", null, `P/T ${c.power}/${c.toughness}` + (changed ? t("card.base", { p: c.basePower ?? "", t: c.baseToughness ?? "" }) : "")) : null,
    printed
      ? [h("div.otext", null, manaNodes(printed)), h("div.muted.onote", null, t("card.printedNote")),
        h("details.oracle-en", null, h("summary", null, t("card.oracleEn")), h("div.otext", null, manaNodes(oracle)))]
      : h("div.otext", null, manaNodes(oracle)),
    state ? h("div.muted", null, manaNodes(state)) : null,
    art && artist ? h("div.muted.credit", null, `Illustrated by ${artist}`) : null,
  );
}

export { passLabel };
