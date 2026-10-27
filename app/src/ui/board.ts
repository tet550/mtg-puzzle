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
import { displayName, displayTypeLine } from "./images";
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
  /**
   * 相手の要約（土地・墓地・追放）と自分の束を開く・閉じる。
   * closing は閉じるときだけ渡す、その束の選択の印（markSig）。同じ印のあいだは開いたままにしない（BoardUi.dismissed）
   */
  toggle(key: string, closing?: string): void;
  /** 自分の見出しの「スタックで止める」を切り替える */
  toggleHoldStack?(): void;
  /** 自分の見出しの「積む順を選ぶ」を切り替える */
  toggleOrderStack?(): void;
}

export interface BoardUi {
  viewer: string;
  marks: Map<string, Mark>;
  /** 開いている相手の要約（"lands" / "graveyard" / "exile"）と自分の束（"my-graveyard" / "my-exile"） */
  open: Set<string>;
  /** 選択の候補を含むので開いていた束を利用者が閉じたときの、その束の印（markSig）。印が変わるまで閉じたままにする */
  dismissed?: Map<string, string>;
  /** 期限（このターン中）の表示用 */
  startTurn: number;
  /** 直前の出来事で変わったカード（短く光らせる） */
  flash: Set<string>;
  /** カード画像の URL（画像を出さない設定か、画像が無ければ null） */
  art: (name: string) => string | null;
  /** 攻撃している・ブロックしているカード（カードの上に札を出す） */
  attacking: Set<string>;
  blocking: Set<string>;
  /** エディタ表示（裏向きの領域も開けて編集できるようにし、同名カードも束ねず広げる） */
  editable?: boolean;
  /** 呪文や能力を自動で解決せず、スタックに積んだところで止めるか */
  holdStack?: boolean;
  /** 同時に誘発した能力をスタックに積む順番を手動で選ぶか（false なら自動） */
  orderStack?: boolean;
  /** ターン期限なし（一人回し・プレイテスト用） */
  noDeadline?: boolean;
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
  return h("section.board" + (ui.editable ? ".editable" : ""), null,
    opponentSide(view, opp, ui, hooks),
    mySide(view, me, ui, hooks),
  );
}

// ---------------------------------------------------------------- 見出し

function playerHead(view: GameView, p: PlayerView, ui: BoardUi, hooks: BoardHooks, mine: boolean): HTMLElement {
  const mark = ui.marks.get(p.id);
  const head = h("div.phead" + (mark ? `.${mark}` : ""), { "data-player": p.id, onclick: () => hooks.player(p.id) });
  const who = mine ? t("player.you") : t("player.opponent");
  // 名前は出さずにアイコンで示す（名前は Tip）。あなたはフードの魔道士、相手（自動でパスする）は古のドラゴン
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
  if (mine && !ui.editable && hooks.toggleHoldStack) {
    const on = !!ui.holdStack;
    head.append(h("button.sumchip.holdstack" + (on ? ".on" : ""), {
      type: "button",
      "data-hold-stack": "1",
      "aria-pressed": String(on),
      title: t("player.holdStack.title"),
      onclick: (ev: Event) => { ev.stopPropagation(); hooks.toggleHoldStack!(); },
    }, icon("stack"), h("span", null, t("player.holdStack"))));
  }
  if (mine && !ui.editable && hooks.toggleOrderStack) {
    const on = !!ui.orderStack;
    head.append(h("button.sumchip.holdstack" + (on ? ".on" : ""), {
      type: "button",
      "data-order-stack": "1",
      "aria-pressed": String(on),
      title: t("player.orderStack.title"),
      onclick: (ev: Event) => { ev.stopPropagation(); hooks.toggleOrderStack!(); },
    }, icon("stack"), h("span", null, t("player.orderStack"))));
  }
  const extra = h("span.pextra");
  if (!mine) extra.append(...manaChips(p));
  if (p.poison) extra.append(h("span.chip", null, t("player.poison", { n: p.poison })));
  head.append(extra);
  return head;
}

const RESTRICTION_KEYS: readonly string[] = [
  "Activated", "Creature", "Artifact", "Enchantment", "Instant", "Sorcery", "Planeswalker", "Spell",
];

function restrictionLabel(restriction: string): string {
  const exactKey = `mana.restricted.${restriction}` as MessageKey;
  const exact = t(exactKey);
  if (exact !== exactKey) return exact;
  for (const k of RESTRICTION_KEYS) {
    if (restriction.includes(k)) return t(`mana.restricted.${k}` as MessageKey);
  }
  return t("mana.restricted");
}

export interface ManaChipItem {
  color: ManaColor;
  count: number;
  restriction?: string;
  label?: string;
  title: string;
}

export function splitManaPool(p: Pick<PlayerView, "manaPool" | "restrictedMana">): ManaChipItem[] {
  const items: ManaChipItem[] = [];
  const restrictedList = p.restrictedMana ?? [];
  const restrictedByColor = new Map<ManaColor, number>();
  for (const r of restrictedList) {
    if (r.count > 0) restrictedByColor.set(r.color, (restrictedByColor.get(r.color) ?? 0) + r.count);
  }
  for (const c of MANA_ORDER) {
    const total = p.manaPool[c] ?? 0;
    const restCount = restrictedByColor.get(c) ?? 0;
    const free = Math.max(0, total - restCount);
    if (free > 0) {
      items.push({ color: c, count: free, title: `{${c}} ×${free}` });
    }
    for (const r of restrictedList) {
      if (r.color !== c || r.count <= 0) continue;
      const label = restrictionLabel(r.restriction);
      const detail = label !== t("mana.restricted") ? label : `${label}: ${r.restriction}`;
      const title = t("mana.restricted.title", { mana: `{${c}}`, n: r.count, label: detail });
      items.push({ color: c, count: r.count, restriction: r.restriction, label, title });
    }
  }
  return items;
}

function manaChips(p: PlayerView): HTMLElement[] {
  return splitManaPool(p).map((it) =>
    it.restriction
      ? h(`span.chip.mana.m${it.color}.restricted`, { title: it.title, "data-restriction": it.restriction },
          manaNodes(`{${it.color}}`), ` ×${it.count}`, h("span.mrestr", null, it.label))
      : h(`span.chip.mana.m${it.color}`, { title: it.title }, manaNodes(`{${it.color}}`), ` ×${it.count}`),
  );
}

function phaseStrip(view: GameView, ui?: BoardUi): HTMLElement {
  const strip = h("span.phases", { title: t("phase.turnTitle", { turn: view.turn }) });
  if (ui?.noDeadline) {
    strip.append(h("span.ph.turnbadge", { "data-turn-badge": String(view.turn), title: t("phase.turnTitle", { turn: view.turn }) }, `T${view.turn}`));
  }
  for (const g of PHASE_STRIP) {
    const cur = g.phases.includes(view.phase);
    const ph = h("span.ph" + (cur ? ".cur" : "") + (g.icon === "ending" ? ".fill" : ""), { title: t(g.key) });
    ph.append(icon(g.icon));
    if (cur) ph.append(h("span.pstep", null, phaseName(view.phase)));
    strip.append(ph);
  }
  return h("span.phasebox", null, strip);
}

/** 勝利期限（「このターン中」）を相手の戦場の右隅に紋章・目標カードとして出す */
function goalCard(): HTMLElement {
  return h("div.goalcard", {
    "data-goal-card": "1",
    role: "note",
    title: t("phase.deadline.title"),
  },
    h("div.gckicker", null, t("header.goal.title")),
    h("div.gcicon", null, icon("resolve")),
    h("div.gctitle", null, t("phase.deadline")),
    h("div.gctext", null, t("phase.deadline.title")),
  );
}

// ---------------------------------------------------------------- 相手の側（最小限）

function opponentSide(view: GameView, p: PlayerView, ui: BoardUi, hooks: BoardHooks): HTMLElement {
  const side = h("div.side.opp" + (view.activePlayer === p.id ? ".active" : ""));
  const head = playerHead(view, p, ui, hooks, false);
  const bf = battlefield(p);
  const lands = bf.filter((c) => c.kinds.includes("land"));
  const others = bf.filter((c) => !c.kinds.includes("land"));
  const hand = p.cards.filter((c) => c.zone === "Hand");
  const lib = p.cards.filter((c) => c.zone === "Library");
  const gy = p.cards.filter((c) => c.zone === "Graveyard");
  const ex = p.cards.filter((c) => c.zone === "Exile");
  const isOpen = (key: string, cards: CardView[]) => pileOpen(key, cards, ui);

  const untapped = lands.filter((c) => !c.tapped).length;
  const summary = h("div.osum", null,
    summaryChip(t("opp.lands", { n: lands.length, untapped }), "lands", lands, lands.length > 0 || !!ui.editable, ui, hooks, p.id),
    ui.editable
      ? summaryChip(t("opp.hand", { n: p.handCount }), "hand", hand, true, ui, hooks, p.id)
      : h("span.chip", { title: t("opp.hand.title"), "data-pile": "hand", "data-owner": p.id }, t("opp.hand", { n: p.handCount })),
    ui.editable
      ? summaryChip(t("opp.library", { n: p.libraryCount }), "library", lib, true, ui, hooks, p.id)
      : h("span.chip", { title: t("opp.library.title"), "data-pile": "library", "data-owner": p.id }, t("opp.library", { n: p.libraryCount })),
    summaryChip(t("opp.graveyard", { n: gy.length }), "graveyard", gy, gy.length > 0 || !!ui.editable, ui, hooks, p.id),
    summaryChip(t("opp.exile", { n: ex.length }), "exile", ex, ex.length > 0 || !!ui.editable, ui, hooks, p.id),
  );
  head.insertBefore(summary, head.querySelector(".pextra"));
  side.append(head);
  // 土地以外のパーマネントは自分の側と同じ大きさ（ブロッカー・対象・除去の対象になるため）。領域の高さを固定するため空でも行を出し、開いた土地も同じ行に並べる
  const row = h("div.row.bfrow", null, kindGroups(others, p, ui, hooks));
  if (isOpen("lands", lands) && lands.length) {
    const lgroups = landGroups(lands, ui, hooks);
    if (others.length && lgroups.length) lgroups[0].classList.add("kgap");
    row.append(...lgroups);
  }
  if (!ui.noDeadline && view.turn === ui.startTurn) row.append(goalCard());
  side.append(row);
  if (ui.editable && isOpen("hand", hand)) side.append(opened(t("opened.oppHand"), hand, ui, hooks));
  if (ui.editable && isOpen("library", lib)) side.append(opened(t("opened.oppLibrary"), lib, ui, hooks));
  if (isOpen("graveyard", gy) && (gy.length || ui.editable)) side.append(opened(t("opened.oppGraveyard"), gy, ui, hooks));
  if (isOpen("exile", ex) && (ex.length || ui.editable)) side.append(opened(t("opened.oppExile"), ex, ui, hooks));
  return side;
}

function summaryChip(text: string, key: string, cards: CardView[], enabled: boolean, ui: BoardUi, hooks: BoardHooks, owner: string): HTMLElement {
  const open = pileOpen(key, cards, ui);
  return h("button.chip.sumchip" + (open ? ".on" : ""), {
    type: "button", disabled: !enabled, "aria-expanded": String(open), "data-pile": key, "data-owner": owner,
    onclick: (ev: Event) => { ev.stopPropagation(); togglePile(key, cards, ui, hooks); },
  }, text);
}

/** 束の中のカードに付いた選択の印（候補・選んだもの）。印が無ければ "" */
export function markSig(cards: CardView[], ui: BoardUi): string {
  return cards.filter((c) => ui.marks.has(c.instanceId)).map((c) => `${c.instanceId}:${ui.marks.get(c.instanceId)}`).join(",");
}

/** 開いているか。選択の候補・選んだものを含む束は開いて見せる（利用者が閉じたら、印が変わるまで閉じたまま） */
function pileOpen(key: string, cards: CardView[], ui: BoardUi): boolean {
  if (ui.open.has(key)) return true;
  const sig = markSig(cards, ui);
  return sig !== "" && ui.dismissed?.get(key) !== sig;
}

function togglePile(key: string, cards: CardView[], ui: BoardUi, hooks: BoardHooks): void {
  if (pileOpen(key, cards, ui)) hooks.toggle(key, markSig(cards, ui));
  else hooks.toggle(key);
}

// ---------------------------------------------------------------- 自分の側

function mySide(view: GameView, p: PlayerView, ui: BoardUi, hooks: BoardHooks): HTMLElement {
  const side = h("div.side.mine" + (view.activePlayer === p.id ? ".active" : ""));
  side.append(playerHead(view, p, ui, hooks, true));
  const bf = battlefield(p);
  const lands = bf.filter((c) => c.kinds.includes("land"));
  const others = bf.filter((c) => !c.kinds.includes("land"));
  const lib = p.cards.filter((c) => c.zone === "Library");
  const gy = p.cards.filter((c) => c.zone === "Graveyard");
  const ex = p.cards.filter((c) => c.zone === "Exile" && !c.exiledBy);
  const hand = p.cards.filter((c) => c.zone === "Hand");

  const libOpen = !!ui.editable && pileOpen("my-library", lib, ui);
  const gyOpen = pileOpen("my-graveyard", gy, ui);
  const exOpen = pileOpen("my-exile", ex, ui);
  const piles = h("div.piles", null,
    pile(t("pile.library"), p.libraryCount, ui.editable ? (lib[0] ?? null) : null, libOpen, ui.editable ? () => togglePile("my-library", lib, ui, hooks) : null, ui, "library", p.id),
    pile(t("pile.graveyard"), gy.length, gy[gy.length - 1] ?? null, gyOpen, () => togglePile("my-graveyard", gy, ui, hooks), ui, "graveyard", p.id),
    pile(t("pile.exile"), ex.length, ex[ex.length - 1] ?? null, exOpen, () => togglePile("my-exile", ex, ui, hooks), ui, "exile", p.id),
  );
  const field = h("div.field", null,
    h("div.row.bfrow", null, kindGroups(others, p, ui, hooks)),
    h("div.manapool", { "data-mana-pool": p.id }, manaChips(p)),
    h("div.row.bfrow.lands", null, landGroups(lands, ui, hooks)),
  );
  // 手札は土地に少し重ね、欄の下の端で切る（mtgtable と同じ。押すと浮かせて全体を見せる）
  const handRow = h("div.handbox", { "data-pile": "hand", "data-owner": p.id }, h("div.hand.fan", { "data-zone": "hand" }, hand.map((c) => cardTile(c, ui, hooks, ".inhand"))));
  side.append(h("div.sidegrid", null, piles, h("div.sidemain", null, field, handRow)));
  if (libOpen) side.append(opened(t("opened.myLibrary"), lib, ui, hooks));
  if (gyOpen && (gy.length || ui.editable)) side.append(opened(t("opened.myGraveyard"), gy, ui, hooks));
  if (exOpen && (ex.length || ui.editable)) side.append(opened(t("opened.myExile"), ex, ui, hooks));
  return side;
}

function pile(label: string, count: number, top: CardView | null, open: boolean, onclick: (() => void) | null, ui: BoardUi, key: string, owner: string): HTMLElement {
  const url = top ? ui.art(top.name) : null;
  const face = top
    ? h("div.face", { "data-top": top.instanceId }, url ? h("img", { src: url, alt: displayName(top.name), loading: "lazy" }) : h("div.ftext", null, displayName(top.name)))
    : count ? h("div.face.back") : h("div.face.emptyface", null, h("span.pempty", null, t("pile.empty")));
  return h("div.pile" + (count ? "" : ".empty") + (open ? ".open" : ""), {
    "data-pile": key, "data-owner": owner,
    onclick: onclick && (count || ui.editable) ? (ev: Event) => { ev.stopPropagation(); onclick(); } : null,
    title: t("pile.title", { label, n: count }),
  }, h("div.pstack", null, h("div.plabel", null, label), face, h("span.chip.strong.pcount", null, count)));
}

function opened(title: string, cards: CardView[], ui: BoardUi, hooks: BoardHooks): HTMLElement {
  return h("div.zone.opened", { "data-zone": title }, h("h3", null, t("opened.count", { title, n: cards.length })),
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
  // 同じ見た目のパーマネントは 1 つの束にまとめて ×N（mtgtable と同じ）。付いているものがあるカードはまとめない
  const groups: { key: string; cards: CardView[]; under: CardView[] }[] = [];
  for (const { c } of sorted) {
    const under = p.cards.filter((o) => o.attachedTo === c.instanceId || (o.zone === "Exile" && o.exiledBy === c.instanceId));
    const key = under.length ? `#${c.instanceId}` : lookKey(c, ui);
    const g = groups.find((x) => x.key === key);
    if (g) g.cards.push(c);
    else groups.push({ key, cards: [c], under });
  }
  let prev = -1;
  return groups.map((g) => {
    const c = g.cards[0];
    let tile: HTMLElement;
    if (g.under.length) tile = tuck(c, g.under, ui, hooks);
    else if (g.cards.length === 1) tile = cardTile(c, ui, hooks, "");
    else {
      // 選択の候補・選んだものを含む束、またはエディタ表示は重ねずに広げる（1 枚ずつ選べるように）
      const spread = !!ui.editable || g.cards.some((x) => ui.marks.has(x.instanceId));
      tile = h("div.lgroup.pgroup" + (spread ? "" : ".overlap"), { "data-group": g.key }, g.cards.map((x) => cardTile(x, ui, hooks, "")));
      if (!spread) tile.append(h("span.chip.strong.gcount", null, `×${g.cards.length}`));
    }
    if (prev >= 0 && kindOf(c) !== prev) tile.classList.add("kgap");
    prev = kindOf(c);
    return tile;
  });
}

/** 見た目が同じかどうかの鍵: 名前と、カードの上に出す状態（タップ・P/T・ダメージ・カウンター・攻撃・ブロックなど）がすべて同じ */
function lookKey(c: CardView, ui: BoardUi): string {
  const counters = Object.entries(c.counters).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([c.name, c.tapped, c.power, c.toughness, c.basePower, c.baseToughness, c.damage, counters, c.token, c.faceDown,
    c.sick && c.kinds.includes("creature"), c.controller !== c.owner ? c.owner : "", ui.attacking.has(c.instanceId), ui.blocking.has(c.instanceId)]);
}

function tuck(c: CardView, under: CardView[], ui: BoardUi, hooks: BoardHooks): HTMLElement {
  const box = h("div.tuck", { "data-group": `#${c.instanceId}`, style: `--n:${under.length}` } as never);
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
    // 選択の候補を含む束、またはエディタ表示は重ねずに広げる（1 枚ずつ選べるように）
    const spread = !!ui.editable || g.cards.some((c) => ui.marks.has(c.instanceId));
    const box = h("div.lgroup" + (spread ? "" : ".overlap"), { "data-group": g.key }, g.cards.map((c) => cardTile(c, ui, hooks, ".land")));
    if (g.cards.length > 1 && !spread) box.append(h("span.chip.strong.gcount", null, `×${g.cards.length}`));
    return box;
  });
}

// ---------------------------------------------------------------- 戦闘・スタックの小窓の中身

/** 戦闘: 攻撃クリーチャーごとに、上（相手側）にブロック・攻撃先、下（自分側）に攻撃クリーチャーを縦に並べる */
export function combatBody(view: GameView, ui: BoardUi, hooks: BoardHooks): HTMLElement {
  const byId = new Map(view.players.flatMap((p) => p.cards).map((c) => [c.instanceId, c]));
  const target = (id: string) => view.players.some((p) => p.id === id)
    ? (id === ui.viewer ? t("player.you") : t("player.opponent")) : displayName(byId.get(id)?.name ?? id);
  return h("div.combat", null, view.combat.map((a) => {
    const att = byId.get(a.attackerId);
    const blockers = a.blockers.map((b) => byId.get(b)).filter((c): c is CardView => !!c);
    return h("div.cbcol", null,
      blockers.length ? h("div.cbrow", null, blockers.map((b) => cardTile(b, ui, hooks, ".incombat")))
        : h("div.cbblk", null, t("combat.noBlock")),
      h("div.cbto", null, h("span.arw", null, "↑"), target(a.defender)),
      att ? cardTile(att, ui, hooks, ".incombat") : null);
  }));
}

/** スタック: 上から順に、呪文はそのカード、能力は発生源のカードを小さく出し、横に名前・文・対象を並べる */
/** 唱えている途中・対象を選んでいる呪文・能力（スタックに出し、対象選択中はそこからカーソルへ矢印を出す）。text は能力の文 */
export interface Targeting {
  cardId: string;
  text: string;
  targets?: string[];
  aiming?: boolean;
}

export function stackBody(view: GameView, ui: BoardUi, hooks: BoardHooks, names: Map<string, string>, known: Map<string, CardView>,
  targeting: Targeting | null = null): HTMLElement {
  const byId = new Map(view.players.flatMap((p) => p.cards).map((c) => [c.instanceId, c]));
  // 唱えた呪文のカードは、エンジンの盤面のどの領域にも出てこない。最後に見えていた姿（手札のカード）で出す
  const spellCard = (id: string): CardView | undefined => {
    const c = byId.get(id) ?? known.get(id);
    return c ? (c.zone === "Hand" || !byId.has(id) ? { ...c, zone: "Stack", tapped: false } : c) : undefined;
  };
  const onStack = new Set(view.stack.map((it) => it.sourceId));
  // 唱えている途中（対象・支払いを選んでいる間）の呪文も、まだスタックに載っていない項目として出す
  const casting = view.players.flatMap((p) => p.cards).filter((c) => c.zone === "Stack" && !onStack.has(c.instanceId));
  const item = (c: CardView | undefined, name: string, text: string, top: string, targets: string[], cls: string, source: string, aiming = false) =>
    h("li.sitem" + cls + (aiming ? ".targeting" : "") + (c && ui.marks.has(c.instanceId) ? ".cand" : ""),
      aiming ? { "data-source": source, "data-targeting": "1" } : { "data-source": source },
      c ? cardTile(c, ui, hooks, ".instack" + (c.zone === "Stack" ? "" : ".src")) : null,
      h("div.sbody", null,
        h("div.shead", null, h("span.chip", null, top), h("span.sname", null, displayName(name))),
        h("div.stext", null, manaNodes(text)),
        targets.length ? h("div.stargets.muted", null, "→ ", targets.map((x) =>
          view.players.some((p) => p.id === x) ? (x === ui.viewer ? t("player.you") : t("player.opponent")) : displayName(byId.get(x)?.name ?? names.get(x) ?? x)).join(t("log.sep"))) : null));
  // 対象や支払いを選び終わるまで、呪文・能力はスタックに出てこない（唱えている呪文のカードは盤面のどこにも無い）。
  // 唱えている・解決の選択を待っている間は、まだ載っていない項目として先頭に出す（呪文は最後に見えていた姿、能力は持ち主のカード）
  const isAiming = targeting ? (targeting.aiming ?? true) : false;
  const aiming = targeting && !casting.some((c) => c.instanceId === targeting.cardId) ? spellCard(targeting.cardId) : undefined;
  return h("ol.stack.panel", null,
    aiming ? item(aiming, aiming.name, targeting!.text, "…", targeting!.targets ?? [], ".casting", targeting!.cardId, isAiming) : null,
    casting.map((c) => item(c, c.name, t("stack.casting"), "…", [], ".casting", c.instanceId, isAiming && c.instanceId === targeting?.cardId)),
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
    if (!small && !extra.includes("under")) d.append(h("div.tl", null, displayTypeLine(c.name, c.typeLine)));
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
    h("div.tl", null, displayTypeLine(c.name, c.typeLine)),
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
