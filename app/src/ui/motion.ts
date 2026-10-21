// 出来事の演出（領域の移動・破壊/追放/バウンス・対象への光弾・ダメージ/回復）。design/motion-ui.md
// 盤面は回答のたびに作り直す（play.ts の render）ので、描き直す前にカードの位置と要素を控え（capture）、
// 描き直した後に、前の位置に写し（ゴースト）を置いて、出来事の順に動かす（play）。
// 演出の考え方は f/pokemon-tcg（MIT）の ui.js（projectile / impact / stamp / fly）を参考にした。

import type { CardView, GameEvent, GameView, ManaColor } from "../engine/protocol";
import { t } from "../i18n";
import { h } from "./dom";

const KEY = "mtgp.motion";

export function motionEnabled(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    if (v !== null) return v === "1";
  } catch { /* 保存できない環境では既定 */ }
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function setMotionEnabled(on: boolean) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* 覚えられなくても切り替えは効く */ }
}

// ---------------------------------------------------------------- 控え

interface Shot { el: HTMLElement; rect: DOMRect; h: string }

export interface Snapshot {
  /** 盤面（両側の欄・開いた束）のカード */
  cards: Map<string, Shot>;
  /** スタックの小窓のカード（解決の光弾の出どころ） */
  stack: Map<string, Shot>;
  /** プレイヤーの見出し */
  players: Map<string, DOMRect>;
}

function shot(el: HTMLElement): Shot {
  return { el, rect: el.getBoundingClientRect(), h: getComputedStyle(el).getPropertyValue("--h") };
}

export function capture(root: HTMLElement): Snapshot {
  const cards = new Map<string, Shot>();
  const stack = new Map<string, Shot>();
  for (const el of root.querySelectorAll<HTMLElement>(".card[data-id]")) {
    const id = el.dataset.id!;
    if (el.closest(".stackbox")) stack.set(id, shot(el));
    else if (el.closest(".side") && !cards.has(id)) cards.set(id, shot(el));
  }
  for (const el of root.querySelectorAll<HTMLElement>(".combatbox .card[data-id]")) {
    if (!cards.has(el.dataset.id!)) cards.set(el.dataset.id!, shot(el));
  }
  const players = new Map<string, DOMRect>();
  for (const el of root.querySelectorAll<HTMLElement>(".phead[data-player]")) players.set(el.dataset.player!, el.getBoundingClientRect());
  return { cards, stack, players };
}

// ---------------------------------------------------------------- 再生

let skipping = false;
let running: HTMLElement | null = null;

/** 演出の層を押したとき: 残りを待たずに終わらせる */
export function skip() {
  skipping = true;
  running?.querySelectorAll("*").forEach((e) => e.getAnimations().forEach((a) => a.finish()));
  document.querySelectorAll<HTMLElement>(".mv").forEach((e) => e.getAnimations().forEach((a) => a.finish()));
}

/** 演出全体の速さ（長さと待ち時間に掛ける。小さいほど速い） */
const TEMPO = 0.55;

const sleep = (ms: number) => (skipping ? Promise.resolve() : new Promise<void>((r) => setTimeout(r, ms * TEMPO)));

/** el.animate と同じ。長さと遅れに TEMPO を掛ける */
function anim(el: Element, kf: Keyframe[], opts: KeyframeAnimationOptions): Animation {
  return el.animate(kf, { ...opts, duration: Number(opts.duration ?? 0) * TEMPO, delay: (opts.delay ?? 0) * TEMPO });
}
/** 動きが終わるまで待つ。裏のタブでは描画のコマが止まって終わらないことがあるので、長さ + 500 ms で打ち切る */
const done = (a: Animation): Promise<void> => {
  const tm = a.effect?.getComputedTiming();
  const ms = Number(tm?.endTime ?? 1000) + 500;
  return Promise.race([a.finished.then(() => undefined, () => undefined), new Promise<void>((r) => setTimeout(r, ms))]);
};

const ZONE_ORDER = ["Battlefield", "Stack", "Hand", "Graveyard", "Exile"];

export interface PlayArgs {
  root: HTMLElement;
  before: Snapshot;
  prev: GameView;
  next: GameView;
  events: GameEvent[];
  viewer: string;
  /** 最後に見えていたカードの姿（スタックの呪文はエンジンの盤面に出てこないので、色をここから取る） */
  known?: Map<string, CardView>;
}

/**
 * 再生の順に並べ替える。Forge は解決の効果（ダメージ・ライフ・移動）を出してから resolved を出すので、
 * resolved をその効果のまとまりの前に移す（光弾が飛んでから、当たったものが壊れる）
 */
export function beatOrder(events: GameEvent[]): GameEvent[] {
  const out: GameEvent[] = [];
  let blockStart = 0;
  for (const e of events) {
    if (e.type === "resolved") {
      out.splice(blockStart, 0, e);
      blockStart = out.length;
    } else {
      out.push(e);
      if (!EFFECTS.has(e.type)) blockStart = out.length;
    }
  }
  return out;
}

const EFFECTS = new Set<GameEvent["type"]>(["damage", "life", "zoneChange", "counters", "tapped"]);

export async function play(a: PlayArgs): Promise<void> {
  const { root, before, prev, next } = a;
  const events = beatOrder(a.events);
  skipping = false;
  const layer = h("div.fxlayer", { title: t("motion.skip") });
  layer.addEventListener("pointerdown", (ev) => { ev.preventDefault(); skip(); });
  document.body.append(layer);
  running = layer;

  const prevCards = cardMap(prev);
  const nextCards = cardMap(next);
  const now = (id: string) => liveCard(root, id);
  const hidden = new Set<HTMLElement>();
  const held: HTMLElement[] = [];
  const ghosts = new Map<string, HTMLElement>();
  const lifeEls = new Map<string, HTMLElement>();

  try {
    // 1. 領域が変わったカードは、後の要素を隠して前の位置に写しを置く。同じ領域で動いたカードは前の位置に留める
    const moved = new Set<string>();
    for (const [id, c] of nextCards) {
      const p = prevCards.get(id);
      if (!p || p.zone !== c.zone) moved.add(id);
    }
    for (const id of prevCards.keys()) if (!nextCards.has(id)) moved.add(id);

    for (const id of moved) {
      const el = now(id);
      if (el) { el.style.visibility = "hidden"; hidden.add(el); }
      // 束の一番上に出ているなら、それも着くまで隠す
      for (const f of root.querySelectorAll<HTMLElement>(`[data-top="${CSS.escape(id)}"]`)) { f.style.visibility = "hidden"; hidden.add(f); }
      const old = before.cards.get(id) ?? before.stack.get(id);
      if (old) ghosts.set(id, ghost(layer, old.el, old.rect, old.h));
    }
    // タップ・アンタップしたカードは、前の中心から回しながら動かす（下の tapSpin）。留めておく対象から外す
    const tapChanged = new Set([...nextCards].filter(([id, c]) => !moved.has(id) && prevCards.get(id)?.tapped !== c.tapped).map(([id]) => id));
    for (const [id, old] of before.cards) {
      if (moved.has(id) || tapChanged.has(id)) continue;
      const el = now(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const dx = old.rect.left - r.left, dy = old.rect.top - r.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        el.style.translate = `${dx}px ${dy}px`;
        el.classList.add("mv");
        held.push(el);
      }
    }
    // ライフの数は、拍が来るまで前の値を出しておく
    for (const e of events) {
      if (e.type !== "life" || lifeEls.has(e.player)) continue;
      const el = root.querySelector<HTMLElement>(`.phead[data-player="${CSS.escape(e.player)}"] .lnum`);
      if (el) { el.textContent = String(e.from); lifeEls.set(e.player, el); }
    }

    // タップ・アンタップは最初にまとめて回す
    const taps: Promise<void>[] = [];
    for (const id of tapChanged) {
      const el = now(id);
      const old = before.cards.get(id);
      if (el && old) taps.push(tapSpin(el, old.rect, nextCards.get(id)!.tapped));
    }
    if (taps.length) await Promise.race([Promise.all(taps), sleep(300)]);

    // 2. 出来事を順に再生する
    const card = (id: string | null) => (id ? nextCards.get(id) ?? prevCards.get(id) ?? a.known?.get(id) : undefined);
    const ctx: Ctx = { a, layer, prevCards, nextCards, ghosts, hidden, lifeEls, struck: new Set(), now, card };
    const handled = new Set<string>();
    for (const e of events) {
      if (skipping) break;
      switch (e.type) {
        case "zoneChange":
          if (!handled.has(e.cardId) && moved.has(e.cardId)) {
            handled.add(e.cardId);
            await moveCard(ctx, e.cardId, e.from, e.to);
          }
          break;
        case "resolved":
          await resolve(ctx, e.sourceId, e.fizzled);
          break;
        case "damage":
          await damage(ctx, e.sourceId, e.target, e.amount, e.combat || inCombat(prev, e.sourceId));
          break;
        case "life":
          await life(ctx, e.player, e.from, e.to);
          break;
        case "counters":
          if (e.to !== e.from) counter(ctx, e.cardId, e.to - e.from, e.counter);
          break;
      }
    }
    // 出来事に出てこなかった移動（エンジンが知らせない種類）も最後に動かす
    const rest = [...moved].filter((id) => !handled.has(id))
      .sort((x, y) => ZONE_ORDER.indexOf(nextCards.get(x)?.zone ?? "") - ZONE_ORDER.indexOf(nextCards.get(y)?.zone ?? ""));
    if (!skipping) await Promise.all(rest.map((id) => moveCard(ctx, id, prevCards.get(id)?.zone ?? null, nextCards.get(id)?.zone ?? null)));

    // 新しく積まれた対象のある項目: 発生源から対象へ光の線（対象に取った印）
    const was = new Set(prev.stack.map((s) => `${s.sourceId}:${s.description}`));
    const aims = next.stack.filter((s) => s.targets.length && !was.has(`${s.sourceId}:${s.description}`));
    for (const s of aims) {
      if (skipping) break;
      const from = liveCard(root, s.sourceId, true) ?? now(s.sourceId)
        ?? root.querySelector<HTMLElement>(`.stackbox .sitem[data-source="${CSS.escape(s.sourceId)}"]`);
      if (!from) continue;
      const color = colorOf(card(s.sourceId));
      await Promise.all(s.targets.map((tg) => {
        const to = targetEl(root, tg);
        return to ? aim(layer, from.getBoundingClientRect(), to.getBoundingClientRect(), color) : Promise.resolve();
      }));
    }

    // 3. 留めていたカードを新しい位置へ滑らせる
    if (!skipping && held.length) {
      await Promise.all(held.map((el) => done(anim(el, [{ translate: el.style.translate }, { translate: "0px 0px" }],
        { duration: 300, easing: "cubic-bezier(.3,.7,.3,1)" }))));
    }
  } finally {
    // 4. 片付け（飛ばしたとき・途中で失敗したときも、盤面は必ず後の状態に戻す）
    for (const el of held) { el.style.translate = ""; el.classList.remove("mv"); }
    for (const el of hidden) el.style.visibility = "";
    for (const [id, el] of lifeEls) {
      const p = next.players.find((x) => x.id === id);
      if (p) el.textContent = String(p.life);
    }
    layer.remove();
    running = null;
    skipping = false;
  }
}

interface Ctx {
  a: PlayArgs;
  layer: HTMLElement;
  prevCards: Map<string, CardView>;
  nextCards: Map<string, CardView>;
  ghosts: Map<string, HTMLElement>;
  hidden: Set<HTMLElement>;
  lifeEls: Map<string, HTMLElement>;
  /** 解決の光弾が当たった対象（同じ解決のダメージで、もう一度飛ばさない） */
  struck: Set<string>;
  now: (id: string) => HTMLElement | null;
  card: (id: string | null) => CardView | undefined;
}

function cardMap(v: GameView): Map<string, CardView> {
  return new Map(v.players.flatMap((p) => p.cards).map((c) => [c.instanceId, c]));
}

/** 今の盤面のカードの要素。inStack なら、スタックの小窓の方を先に探す */
function liveCard(root: HTMLElement, id: string, inStack = false): HTMLElement | null {
  const q = `.card[data-id="${CSS.escape(id)}"]`;
  if (inStack) return root.querySelector<HTMLElement>(`.stackbox ${q}`);
  return root.querySelector<HTMLElement>(`.side ${q}`) ?? root.querySelector<HTMLElement>(`.combatbox ${q}`) ?? root.querySelector<HTMLElement>(`.stackbox ${q}`);
}

function targetEl(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`.phead[data-player="${CSS.escape(id)}"] .avatar`) ?? liveCard(root, id);
}

/** 戦闘ダメージか（Forge はクリーチャーへのダメージに戦闘かどうかを付けない）: 戦闘中で、発生源が攻撃・ブロックしている */
function inCombat(v: GameView, sourceId: string | null): boolean {
  return !!sourceId && v.phase.startsWith("COMBAT") && v.combat.some((a) => a.attackerId === sourceId || a.blockers.includes(sourceId));
}

// ---------------------------------------------------------------- 色

const COLORS: Record<ManaColor, string> = { W: "#f6dc7a", U: "#4aa3ff", B: "#a46ee0", R: "#ff6a2b", G: "#4fc36b", C: "#c9d3e0" };

export function colorOf(c: CardView | undefined): string {
  const m = c?.manaCost.match(/\{([WUBRG])/);
  return COLORS[(m?.[1] as ManaColor | undefined) ?? "C"];
}

// ---------------------------------------------------------------- 部品

function center(r: DOMRect | { left: number; top: number; width: number; height: number }) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function fx(layer: HTMLElement, cls: string, style: Record<string, string> = {}): HTMLElement {
  const d = h(`div.fx.${cls}` as "div");
  for (const [k, v] of Object.entries(style)) d.style.setProperty(k, v);
  layer.append(d);
  return d;
}

function gone(el: Element, a: Animation) {
  void done(a).then(() => el.remove());
}

/** カードの写し。元の要素（描き直しで外れた要素）をそのまま写し、大きさと --h を固定して層に置く */
function ghost(layer: HTMLElement, src: HTMLElement, rect: DOMRect, hVar: string): HTMLElement {
  const g = src.cloneNode(true) as HTMLElement;
  g.classList.remove("cand", "chosen", "flash", "dragging", "mv");
  g.classList.add("ghost");
  g.style.visibility = "";
  g.style.translate = "";
  if (hVar) g.style.setProperty("--h", hVar);
  // 傾いた手札の外接矩形ではなく、要素の本来の大きさを中心に合わせて置く
  const w = src.offsetWidth || rect.width, ht = src.offsetHeight || rect.height;
  const c = center(rect);
  Object.assign(g.style, { left: `${c.x - w / 2}px`, top: `${c.y - ht / 2}px`, width: `${w}px`, height: `${ht}px` });
  layer.append(g);
  return g;
}

/** 写しを rect まで弧を描いて飛ばす（大きさも合わせる）。終わっても写しは消さない */
function fly(g: HTMLElement, to: DOMRect, opts: { duration?: number; lift?: number; spin?: number; endScale?: number; fade?: boolean } = {}): Promise<void> {
  // 前の演出で動いた分（浮き上がり・縮み）から続ける
  const cs = getComputedStyle(g);
  const s0 = cs.scale === "none" ? 1 : parseFloat(cs.scale) || 1;
  const [tx, ty] = cs.translate === "none" ? [0, 0] : cs.translate.split(" ").map((v) => parseFloat(v) || 0).concat(0).slice(0, 2);
  const from = g.getBoundingClientRect();
  const A = center(from), B = center(to);
  const dx = B.x - A.x, dy = B.y - A.y;
  const s = opts.endScale ?? Math.min(2, Math.max(0.2, to.height / Math.max(1, from.height / s0)));
  const lift = opts.lift ?? Math.min(80, 30 + Math.hypot(dx, dy) * 0.1);
  const spin = opts.spin ?? 0;
  const kf: Keyframe[] = [
    { translate: `${tx}px ${ty}px`, scale: String(s0), rotate: "0deg", opacity: 1 },
    { translate: `${tx + dx * 0.5}px ${ty + dy * 0.5 - lift}px`, scale: String((s0 + s) / 2 * 1.08), rotate: `${spin / 2 - 6}deg`, opacity: 1, offset: 0.5 },
    { translate: `${tx + dx}px ${ty + dy}px`, scale: String(s), rotate: `${spin}deg`, opacity: opts.fade ? 0 : 1 },
  ];
  return done(anim(g, kf, { duration: opts.duration ?? 520, easing: "cubic-bezier(.45,.05,.3,1)", fill: "forwards" }));
}

/** 隠しておいた後の要素を出す（着地の沈み込みを付けることもある） */
function reveal(ctx: Ctx, id: string, land = false) {
  for (const f of ctx.a.root.querySelectorAll<HTMLElement>(`[data-top="${CSS.escape(id)}"]`)) {
    f.style.visibility = "";
    ctx.hidden.delete(f);
    anim(f, [{ filter: "brightness(1.8)" }, { filter: "none" }], { duration: 300 });
  }
  const el = ctx.now(id);
  if (!el) return;
  el.style.visibility = "";
  ctx.hidden.delete(el);
  if (land) {
    anim(el, [{ scale: "1.12" }, { scale: "0.96", offset: 0.6 }, { scale: "1" }], { duration: 320, easing: "ease-out" });
    const r = el.getBoundingClientRect(), c = center(r);
    const ring = fx(ctx.layer, "dust", { left: `${c.x}px`, top: `${c.y}px`, width: `${r.width * 1.2}px`, height: `${r.width * 1.2}px` });
    gone(ring, anim(ring, [{ transform: "translate(-50%,-50%) scale(.5)", opacity: 0.8 }, { transform: "translate(-50%,-50%) scale(1.4)", opacity: 0 }],
      { duration: 420, easing: "ease-out", fill: "forwards" }));
  } else {
    anim(el, [{ opacity: 0.4, scale: "0.92" }, { opacity: 1, scale: "1" }], { duration: 200, easing: "ease-out" });
  }
}

/** 束・要約の札（墓地・追放・ライブラリー・相手の手札）。無ければ持ち主の見出し */
function pileRect(ctx: Ctx, owner: string, pile: string): DOMRect | null {
  const root = ctx.a.root;
  const el = root.querySelector<HTMLElement>(`[data-pile="${pile}"][data-owner="${CSS.escape(owner)}"] .face`)
    ?? root.querySelector<HTMLElement>(`[data-pile="${pile}"][data-owner="${CSS.escape(owner)}"]`)
    ?? root.querySelector<HTMLElement>(`.phead[data-player="${CSS.escape(owner)}"] .avatar`);
  return el?.getBoundingClientRect() ?? null;
}

/** スタックの小窓の置き場所（盤面の右上。小窓が出ていなければ、出たときの位置） */
function stackArea(ctx: Ctx, g: HTMLElement): DOMRect | null {
  const box = ctx.a.root.querySelector<HTMLElement>(".stackbox");
  if (box) return box.getBoundingClientRect();
  const b = ctx.a.root.querySelector<HTMLElement>(".board")?.getBoundingClientRect();
  if (!b) return null;
  const w = g.offsetWidth, ht = g.offsetHeight;
  return new DOMRect(b.right - 8 - 160 - w / 2, b.top + 16, w, ht);
}

// ---------------------------------------------------------------- 領域の移動

async function moveCard(ctx: Ctx, id: string, from: string | null, to: string | null) {
  const card = ctx.card(id);
  const owner = card?.owner ?? ctx.a.viewer;
  let g = ctx.ghosts.get(id) ?? null;
  const dest = ctx.now(id);
  // 前の位置が無い（ライブラリーから引いた・トークンが出た）: 出どころの束に後の見た目の写しを作る
  if (!g && dest) {
    const src = from === "Library" ? pileRect(ctx, owner, "library") : null;
    if (!src) {
      reveal(ctx, id, to === "Battlefield");
      if (to === "Stack") glow(ctx.layer, dest.getBoundingClientRect(), colorOf(card));
      return;
    }
    g = ghost(ctx.layer, dest, src, getComputedStyle(dest).getPropertyValue("--h"));
    const r = g.getBoundingClientRect();
    g.style.scale = String(src.height / Math.max(1, r.height));
  }
  if (!g) return;
  ctx.ghosts.delete(id);

  if (from === "Battlefield" && to === "Graveyard") await destroyFx(ctx, g, owner);
  else if (to === "Exile") await exileFx(ctx, g, owner);
  else if (from === "Battlefield" && (to === "Hand" || to === "Library")) await bounceFx(ctx, g, dest, owner, to);
  else if (to === "Graveyard") {
    const r = pileRect(ctx, owner, "graveyard");
    if (r) await fly(g, r, { duration: 460, fade: !dest });
  } else if (dest) {
    await fly(g, dest.getBoundingClientRect(), { duration: to === "Stack" ? 460 : 520 });
    if (to === "Stack") glow(ctx.layer, dest.getBoundingClientRect(), colorOf(card));
  } else if (from === "Hand" && !ctx.nextCards.has(id)) {
    // 唱えている途中（対象・支払いを選んでいる間）は、エンジンの盤面のどの領域にも無い。スタックの置き場所へ飛ばして消す
    const r = stackArea(ctx, g);
    if (r) {
      await fly(g, r, { duration: 460 });
      glow(ctx.layer, r, colorOf(card));
      await done(anim(g, [{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: "forwards" }));
    }
  } else {
    const r = to === "Hand" || to === "Library" ? pileRect(ctx, owner, to === "Hand" ? "hand" : "library") : null;
    if (r) await fly(g, r, { duration: 460, fade: true });
  }
  g.remove();
  reveal(ctx, id, to === "Battlefield");
}

/** 破壊: 赤く光って震え、ひびの閃光と破片が散り、縮みながら墓地へ */
async function destroyFx(ctx: Ctx, g: HTMLElement, owner: string) {
  const r = g.getBoundingClientRect(), c = center(r);
  await done(anim(g, [
    { translate: "0px 0px", filter: "none" },
    { translate: "-6px 0px", filter: "brightness(1.4) sepia(1) saturate(5) hue-rotate(-30deg)", offset: 0.2 },
    { translate: "5px 0px", offset: 0.4 },
    { translate: "-3px 0px", offset: 0.6 },
    { translate: "0px 0px", filter: "brightness(1.6) sepia(1) saturate(6) hue-rotate(-30deg)" },
  ], { duration: 360, fill: "forwards" }));
  const crack = fx(ctx.layer, "crack", { left: `${c.x}px`, top: `${c.y}px`, width: `${r.width * 1.3}px`, height: `${r.height * 1.1}px` });
  gone(crack, anim(crack, [{ opacity: 0, transform: "translate(-50%,-50%) scale(.6)" }, { opacity: 1, offset: 0.2 }, { opacity: 0, transform: "translate(-50%,-50%) scale(1.2)" }],
    { duration: 420, fill: "forwards" }));
  shards(ctx.layer, r, "#ff8a5c", 10);
  const pile = pileRect(ctx, owner, "graveyard");
  const fall = anim(g, [
    { opacity: 1, scale: "1", filter: "brightness(1.6) sepia(1) saturate(6) hue-rotate(-30deg)" },
    { opacity: 0.85, scale: "0.9", filter: "grayscale(1) brightness(.7)", offset: 0.3 },
    { opacity: pile ? 0.6 : 0, scale: pile ? "0.9" : "0.6", filter: "grayscale(1) brightness(.5)" },
  ], { duration: 260, fill: "forwards" });
  await done(fall);
  if (pile) await fly(g, pile, { duration: 420, lift: 20, fade: false });
}

/** 追放: 白く光って浮き上がり、光の粒になって消える */
async function exileFx(ctx: Ctx, g: HTMLElement, owner: string) {
  const r = g.getBoundingClientRect();
  motes(ctx.layer, r, "#e8f4ff", 18);
  await done(anim(g, [
    { translate: "0px 0px", scale: "1", opacity: 1, filter: "none" },
    { translate: "0px -10px", scale: "1.06", opacity: 1, filter: "brightness(2.2) saturate(.3) blur(0px)", offset: 0.35 },
    { translate: "0px -46px", scale: "1.14", opacity: 0, filter: "brightness(3) saturate(0) blur(6px)" },
  ], { duration: 720, easing: "ease-in", fill: "forwards" }));
  const pile = ctx.a.root.querySelector<HTMLElement>(`[data-pile="exile"][data-owner="${CSS.escape(owner)}"]`);
  if (pile) anim(pile, [{ filter: "brightness(2)", scale: "1.06" }, { filter: "none", scale: "1" }], { duration: 360 });
}

/** バウンス: 青い渦の輪が出て、浮き上がってから手札（相手なら相手の手札の札）へ戻る */
async function bounceFx(ctx: Ctx, g: HTMLElement, dest: HTMLElement | null, owner: string, to: string) {
  const r = g.getBoundingClientRect(), c = center(r);
  const ring = fx(ctx.layer, "swirl", { left: `${c.x}px`, top: `${c.y}px`, width: `${r.width * 1.5}px`, height: `${r.width * 1.5}px` });
  gone(ring, anim(ring, [{ transform: "translate(-50%,-50%) scale(.3) rotate(0deg)", opacity: 0.9 }, { transform: "translate(-50%,-50%) scale(1.3) rotate(300deg)", opacity: 0 }],
    { duration: 640, easing: "ease-out", fill: "forwards" }));
  await done(anim(g, [{ translate: "0px 0px", scale: "1", filter: "none" }, { translate: "0px -24px", scale: "1.12", filter: "brightness(1.3) hue-rotate(160deg) saturate(1.4)" }],
    { duration: 260, easing: "ease-out", fill: "forwards" }));
  const target = dest?.getBoundingClientRect() ?? pileRect(ctx, owner, to === "Hand" ? "hand" : "library");
  if (target) await fly(g, target, { duration: 480, spin: -360, fade: !dest });
}

// ---------------------------------------------------------------- 解決・対象・ダメージ・ライフ

/** 解決: 対象があれば発生源から対象へ光弾。立ち消えなら煙 */
async function resolve(ctx: Ctx, sourceId: string, fizzled: boolean) {
  const item = ctx.a.prev.stack.find((s) => s.sourceId === sourceId);
  const src = ctx.a.before.stack.get(sourceId)?.rect ?? ctx.a.before.cards.get(sourceId)?.rect
    ?? ctx.ghosts.get(sourceId)?.getBoundingClientRect() ?? ctx.now(sourceId)?.getBoundingClientRect();
  if (!src) return;
  const color = colorOf(ctx.card(sourceId));
  if (fizzled) {
    motes(ctx.layer, src, "#9aa0a8", 10);
    await sleep(300);
    return;
  }
  glow(ctx.layer, src, color);
  const targets = item?.targets ?? [];
  if (!targets.length) {
    await sleep(240);
    return;
  }
  await sleep(120);
  await Promise.all(targets.map(async (tg) => {
    const to = targetRect(ctx, tg);
    if (!to) return;
    await bolt(ctx.layer, src, to, color);
    ctx.struck.add(tg);
  }));
}

function targetRect(ctx: Ctx, id: string): DOMRect | null {
  const g = ctx.ghosts.get(id);
  if (g) return g.getBoundingClientRect();
  return targetEl(ctx.a.root, id)?.getBoundingClientRect() ?? ctx.a.before.cards.get(id)?.rect ?? null;
}

function targetNode(ctx: Ctx, id: string): HTMLElement | null {
  return ctx.ghosts.get(id) ?? targetEl(ctx.a.root, id);
}

async function damage(ctx: Ctx, sourceId: string | null, target: string, amount: number, combat: boolean) {
  const node = targetNode(ctx, target);
  if (!node) return;
  const to = node.getBoundingClientRect();
  const src = sourceId ? (ctx.ghosts.get(sourceId) ?? ctx.now(sourceId)) : null;
  const color = colorOf(ctx.card(sourceId));
  if (combat && src) {
    // 攻撃クリーチャーが対象へ踏み込む。戦場の行ははみ出しを切るので、層の上の写しを動かす
    const own = !src.classList.contains("ghost");
    const mover = own ? ghost(ctx.layer, src, src.getBoundingClientRect(), getComputedStyle(src).getPropertyValue("--h")) : src;
    if (own) src.style.visibility = "hidden";
    const a = center(src.getBoundingClientRect()), b = center(to);
    const dx = (b.x - a.x) * 0.45, dy = (b.y - a.y) * 0.45;
    const lunge = anim(mover, [
      { translate: "0px 0px", scale: "1" },
      { translate: `${-dx * 0.08}px ${-dy * 0.08}px`, scale: "0.97", offset: 0.25 },
      { translate: `${dx}px ${dy}px`, scale: "1.08", offset: 0.55 },
      { translate: "0px 0px", scale: "1" },
    ], { duration: 520, easing: "ease-in-out" });
    if (own) {
      void done(lunge).then(() => {
        mover.remove();
        if (!ctx.hidden.has(src)) src.style.visibility = "";
      });
    }
    await sleep(270);
  } else if (sourceId && !ctx.struck.has(target)) {
    const from = ctx.a.before.stack.get(sourceId)?.rect ?? src?.getBoundingClientRect();
    if (from) await bolt(ctx.layer, from, to, color);
  }
  ctx.struck.delete(target);
  await impact(ctx, node, color, amount >= 4);
  // プレイヤーへのダメージの数は、続く life の拍で LIFE の札に出す
  if (!ctx.a.next.players.some((p) => p.id === target)) stamp(ctx.layer, node.getBoundingClientRect(), `−${amount}`, "dmg");
  await sleep(260);
}

async function life(ctx: Ctx, player: string, from: number, to: number) {
  const head = ctx.a.root.querySelector<HTMLElement>(`.phead[data-player="${CSS.escape(player)}"] .life`);
  const num = ctx.lifeEls.get(player);
  if (!head) return;
  const r = head.getBoundingClientRect();
  const diff = to - from;
  if (diff < 0) {
    anim(head, [{ translate: "0px 0px" }, { translate: "-5px 0px" }, { translate: "4px 0px" }, { translate: "-2px 0px" }, { translate: "0px 0px" }], { duration: 360 });
    anim(head, [{ boxShadow: "0 0 0 3px #ff4b3e, 0 0 18px #ff4b3e" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 700, easing: "ease-out" });
    stamp(ctx.layer, r, `−${-diff}`, "dmg");
  } else if (diff > 0) {
    const c = center(r);
    const ring = fx(ctx.layer, "heal", { left: `${c.x}px`, top: `${c.y}px` });
    gone(ring, anim(ring, [{ transform: "translate(-50%,-50%) scale(.3)", opacity: 0.9 }, { transform: "translate(-50%,-50%) scale(2.2)", opacity: 0 }],
      { duration: 640, easing: "ease-out", fill: "forwards" }));
    rise(ctx.layer, r, "#7dffa0", 12);
    anim(head, [{ boxShadow: "0 0 0 3px #4fd877, 0 0 18px #4fd877" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 800, easing: "ease-out" });
    stamp(ctx.layer, r, `+${diff}`, "heal");
  }
  if (num) await countTo(num, from, to, 420 * TEMPO);
  ctx.lifeEls.delete(player);
  await sleep(200);
}

function counter(ctx: Ctx, cardId: string, diff: number, kind: string) {
  const el = ctx.now(cardId);
  if (!el) return;
  const label = kind === "P1P1" ? `${diff > 0 ? "+" : ""}${diff}/${diff > 0 ? "+" : ""}${diff}` : `${diff > 0 ? "+" : ""}${diff}`;
  stamp(ctx.layer, el.getBoundingClientRect(), label, diff > 0 ? "heal" : "dmg", 0.9);
  anim(el, [{ scale: "1.08" }, { scale: "1" }], { duration: 300 });
}

function countTo(el: HTMLElement, from: number, to: number, ms: number): Promise<void> {
  if (skipping) { el.textContent = String(to); return Promise.resolve(); }
  return new Promise((resolveDone) => {
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      el.textContent = String(Math.round(from + (to - from) * p));
      if (p < 1 && !skipping) requestAnimationFrame(step);
      else { el.textContent = String(to); resolveDone(); }
    };
    requestAnimationFrame(step);
    setTimeout(() => { el.textContent = String(to); resolveDone(); }, ms + 400); // 裏のタブでは描画のコマが止まる
  });
}

/**
 * タップ: 横向きに回る。画像のカードは置き場所ごと横長になり、束の中の位置も変わるので、
 * 前の中心に置いて前の向きに戻した形から、新しい中心・向きへ回しながら動かす（回転の中心は要素の中心）
 */
function tapSpin(el: HTMLElement, from: DOMRect, tapped: boolean): Promise<void> {
  const art = el.classList.contains("withart") && !el.classList.contains("inhand") && !el.classList.contains("incombat");
  const deg = art ? 90 : 6;
  const a = center(from), b = center(el.getBoundingClientRect());
  return done(anim(el, [
    { translate: `${a.x - b.x}px ${a.y - b.y}px`, rotate: `${tapped ? -deg : deg}deg` },
    { translate: "0px 0px", rotate: "0deg" },
  ], { duration: 280, easing: "cubic-bezier(.3,.7,.3,1)" }));
}

// ---------------------------------------------------------------- 光・弾・着弾

/** 発生源が光る（解決・唱えた呪文がスタックに着いた） */
function glow(layer: HTMLElement, r: DOMRect, color: string) {
  const c = center(r);
  const g = fx(layer, "glow", { left: `${c.x}px`, top: `${c.y}px`, width: `${r.width * 1.6}px`, height: `${r.height * 1.3}px`, "--c": color });
  gone(g, anim(g, [{ opacity: 0, transform: "translate(-50%,-50%) scale(.7)" }, { opacity: 1, offset: 0.3 }, { opacity: 0, transform: "translate(-50%,-50%) scale(1.15)" }],
    { duration: 520, easing: "ease-out", fill: "forwards" }));
}

/**
 * 対象に取った: 発生源から対象へ、弧を描く太い矢印を引く（縁取りの付いた胴と三角の頭）。
 * 胴が根元から伸び、頭が対象の上で弾んで止まり、少し見せてから消える
 */
async function aim(layer: HTMLElement, from: DOMRect, to: DOMRect, color: string) {
  const A = center(from), B = center(to);
  const dx = B.x - A.x, dy = B.y - A.y;
  const len = Math.hypot(dx, dy);
  if (len < 8) return;
  const k = Math.min(1, Math.max(0.55, len / 260)); // 近い対象には細く小さく
  const W = 12 * k, headLen = 34 * k, headW = 24 * k;
  // 弧は画面の上側へふくらませる（向きによらず同じ側。下向きの矢印でも頭が見えるように）
  const nx = -dy / len, ny = dx / len;
  const side = ny <= 0 ? 1 : -1;
  const bend = Math.max(40, len * 0.28) * side;
  const C = { x: A.x + dx / 2 + nx * bend, y: A.y + dy / 2 + ny * bend };
  // 頭の向きは、弧の終わりの接線（制御点から先端へ）
  const tl = Math.hypot(B.x - C.x, B.y - C.y) || 1;
  const ux = (B.x - C.x) / tl, uy = (B.y - C.y) / tl;
  const E = { x: B.x - ux * headLen * 0.8, y: B.y - uy * headLen * 0.8 };
  const body = `M${A.x.toFixed(1)},${A.y.toFixed(1)} Q${C.x.toFixed(1)},${C.y.toFixed(1)} ${E.x.toFixed(1)},${E.y.toFixed(1)}`;
  const bx = B.x - ux * headLen, by = B.y - uy * headLen;
  const head = [[B.x, B.y], [bx - uy * headW, by + ux * headW], [bx + uy * headW, by - ux * headW]].map((q) => q.map((v) => v.toFixed(1)).join(",")).join(" ");

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "fx arrow");
  svg.setAttribute("width", String(window.innerWidth));
  svg.setAttribute("height", String(window.innerHeight));
  svg.style.setProperty("--c", color);
  // 縁取り（胴・頭）を先に、塗り（胴・頭）を後に描く。頭の縁取りを胴の上に描くと、境目に線が出る
  svg.innerHTML = `<path class="edge" d="${body}" stroke-width="${W + 7}"/><polygon class="edge head" points="${head}" stroke-width="7"/>`
    + `<path class="fill" d="${body}" stroke-width="${W}"/><polygon class="fill head" points="${head}"/>`;
  layer.append(svg);

  const paths = [...svg.querySelectorAll<SVGPathElement>("path")];
  const L = paths[0].getTotalLength();
  const grow = paths.map((pth) => {
    pth.style.strokeDasharray = `${L} ${L}`;
    return anim(pth, [{ strokeDashoffset: L }, { strokeDashoffset: 0 }], { duration: 300, easing: "cubic-bezier(.3,.7,.3,1)", fill: "forwards" });
  });
  const heads = [...svg.querySelectorAll<SVGPolygonElement>(".head")];
  for (const hd of heads) {
    hd.style.transformOrigin = `${B.x}px ${B.y}px`;
    hd.style.opacity = "0";
  }
  await done(grow[0]);
  await Promise.all(heads.map((hd) => done(anim(hd, [
    { opacity: 1, transform: "scale(.2)" },
    { opacity: 1, transform: "scale(1.25)", offset: 0.6 },
    { opacity: 1, transform: "scale(1)" },
  ], { duration: 200, easing: "ease-out", fill: "forwards" }))));
  await sleep(440);
  await done(anim(svg, [{ opacity: 1 }, { opacity: 0 }], { duration: 240, fill: "forwards" }));
  svg.remove();
}

/** 光弾: 光の玉と尾が発生源から対象へ飛ぶ。当たったところで終わる */
async function bolt(layer: HTMLElement, from: DOMRect, to: DOMRect, color: string) {
  const A = center(from), B = center(to);
  const dx = B.x - A.x, dy = B.y - A.y;
  const D = Math.min(520, 260 + Math.hypot(dx, dy) * 0.4);
  const travel = (el: HTMLElement, delay: number) => anim(el, [
    { transform: "translate(-50%,-50%) translate(0px,0px) scale(.6)", opacity: 0 },
    { opacity: 1, offset: 0.12 },
    { transform: `translate(-50%,-50%) translate(${dx}px,${dy}px) scale(1)`, opacity: 1 },
  ], { duration: D, delay, easing: "cubic-bezier(.5,0,.9,.6)", fill: "forwards" });
  for (let i = 1; i <= 4; i++) {
    const tr = fx(layer, "trail", { left: `${A.x}px`, top: `${A.y}px`, "--c": color, "--s": String(1 - i * 0.16) });
    const an = travel(tr, i * 26);
    void done(an).then(() => anim(tr, [{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" })).then((a) => a && gone(tr, a));
  }
  const orb = fx(layer, "orb", { left: `${A.x}px`, top: `${A.y}px`, "--c": color });
  await done(travel(orb, 0));
  orb.remove();
}

/** 着弾: 閃光・星形の弾け・衝撃の輪・対象の揺れ（ヒットストップの後に弾かれる） */
async function impact(ctx: Ctx, node: HTMLElement, color: string, strong: boolean) {
  const r = node.getBoundingClientRect(), c = center(r);
  const star = fx(ctx.layer, "star", { left: `${c.x}px`, top: `${c.y}px`, "--c": color });
  gone(star, anim(star, [
    { transform: "translate(-50%,-50%) scale(.2) rotate(0deg)", opacity: 1 },
    { transform: `translate(-50%,-50%) scale(${strong ? 1.5 : 1.1}) rotate(25deg)`, opacity: 1, offset: 0.35 },
    { transform: `translate(-50%,-50%) scale(${strong ? 1.8 : 1.3}) rotate(35deg)`, opacity: 0 },
  ], { duration: 420, fill: "forwards" }));
  const ring = fx(ctx.layer, "shock", { left: `${c.x}px`, top: `${c.y}px`, "--c": color });
  gone(ring, anim(ring, [{ transform: "translate(-50%,-50%) scale(.2)", opacity: 1 }, { transform: "translate(-50%,-50%) scale(2.4)", opacity: 0 }],
    { duration: 480, easing: "ease-out", fill: "forwards" }));
  sparks(ctx.layer, r, color, strong ? 12 : 8);
  anim(node, [
    { translate: "0px 0px", filter: "none" },
    { translate: "3px 0px", filter: "brightness(2.2) saturate(0)", offset: 0.12 },
    { translate: "3px 0px", filter: "brightness(2.2) saturate(0)", offset: 0.24 },
    { translate: "-6px 2px", filter: "sepia(1) saturate(6) hue-rotate(-40deg)", offset: 0.45 },
    { translate: "3px -1px", filter: "none", offset: 0.75 },
    { translate: "0px 0px", filter: "none" },
  ], { duration: 560, easing: "ease-out" });
  if (strong) {
    const board = ctx.a.root.querySelector<HTMLElement>(".board");
    board && anim(board, [{ translate: "0px 0px" }, { translate: "-6px 4px" }, { translate: "5px -4px" }, { translate: "-3px -2px" }, { translate: "0px 0px" }], { duration: 320 });
  }
  await sleep(160);
}

/** 文字のスタンプ（−3・+2 など）。カードや LIFE の札の上で弾んで、上へ抜ける */
function stamp(layer: HTMLElement, r: DOMRect, text: string, cls: string, size = 1) {
  // 画面の上の端に近いもの（相手の LIFE）は、下に出す（上へ抜ける動きが切れないように）
  const y = r.top < 70 ? r.bottom + 34 : r.top + r.height * 0.35;
  const s = fx(layer, `stamp.${cls}`, { left: `${r.left + r.width / 2}px`, top: `${y}px`, "--k": String(size) });
  s.textContent = text;
  gone(s, anim(s, [
    { transform: "translate(-50%,-50%) scale(2.4) rotate(-12deg)", opacity: 0 },
    { transform: "translate(-50%,-50%) scale(.92) rotate(-8deg)", opacity: 1, offset: 0.14 },
    { transform: "translate(-50%,-50%) scale(1.05) rotate(-8deg)", opacity: 1, offset: 0.24 },
    { transform: "translate(-50%,-90%) scale(1) rotate(-8deg)", opacity: 1, offset: 0.75 },
    { transform: "translate(-50%,-130%) scale(.95) rotate(-8deg)", opacity: 0 },
  ], { duration: 1200, easing: "ease-out", fill: "forwards" }));
}

/** 画面の中央の大きなスタンプ（クリア・失敗） */
export function verdictStamp(cleared: boolean) {
  if (!motionEnabled()) return;
  const layer = h("div.fxlayer.pass");
  document.body.append(layer);
  const s = fx(layer, `stamp.big.${cleared ? "win" : "lose"}`, { left: "50%", top: "42%" });
  s.textContent = cleared ? t("motion.cleared") : t("motion.failed");
  if (cleared) {
    const r = new DOMRect(window.innerWidth / 2 - 120, window.innerHeight * 0.42 - 40, 240, 80);
    sparks(layer, r, "#ffd75e", 24);
  }
  const a = anim(s, [
    { transform: "translate(-50%,-50%) scale(3) rotate(-14deg)", opacity: 0 },
    { transform: "translate(-50%,-50%) scale(.94) rotate(-8deg)", opacity: 1, offset: 0.12 },
    { transform: "translate(-50%,-50%) scale(1.04) rotate(-8deg)", opacity: 1, offset: 0.2 },
    { transform: "translate(-50%,-50%) scale(1) rotate(-8deg)", opacity: 1, offset: 0.8 },
    { transform: "translate(-50%,-60%) scale(1) rotate(-8deg)", opacity: 0 },
  ], { duration: 1800, easing: "ease-out", fill: "forwards" });
  void done(a).then(() => layer.remove());
}

// ---------------------------------------------------------------- 粒

function particles(layer: HTMLElement, r: DOMRect, color: string, n: number, cls: string,
  path: (i: number) => { x: number; y: number; ms: number; delay: number }) {
  const c = center(r);
  for (let i = 0; i < n; i++) {
    const p = path(i);
    const d = fx(layer, cls, { left: `${c.x}px`, top: `${c.y}px`, "--c": color });
    gone(d, anim(d, [
      { transform: "translate(-50%,-50%) translate(0px,0px) scale(1)", opacity: 1 },
      { transform: `translate(-50%,-50%) translate(${p.x}px,${p.y}px) scale(.3)`, opacity: 0 },
    ], { duration: p.ms, delay: p.delay, easing: "cubic-bezier(.2,.7,.4,1)", fill: "forwards" }));
  }
}

/** 着弾の火花: 四方へ飛ぶ */
function sparks(layer: HTMLElement, r: DOMRect, color: string, n: number) {
  particles(layer, r, color, n, "spark", (i) => {
    const ang = (i / n) * Math.PI * 2 + Math.random() * 0.4, dist = 40 + Math.random() * 50;
    return { x: Math.cos(ang) * dist, y: Math.sin(ang) * dist, ms: 420 + Math.random() * 160, delay: 0 };
  });
}

/** 破壊の破片: 下へ落ちながら散る */
function shards(layer: HTMLElement, r: DOMRect, color: string, n: number) {
  particles(layer, r, color, n, "shard", () => ({
    x: (Math.random() - 0.5) * r.width * 1.8, y: r.height * (0.2 + Math.random() * 0.6), ms: 520 + Math.random() * 240, delay: Math.random() * 60,
  }));
}

/** 追放・立ち消えの粒: カードの面から上へ漂う */
function motes(layer: HTMLElement, r: DOMRect, color: string, n: number) {
  for (let i = 0; i < n; i++) {
    const sub = new DOMRect(r.left + Math.random() * r.width - r.width / 2, r.top + Math.random() * r.height - r.height / 2, r.width, r.height);
    particles(layer, sub, color, 1, "mote", () => ({ x: (Math.random() - 0.5) * 30, y: -60 - Math.random() * 60, ms: 700 + Math.random() * 400, delay: Math.random() * 300 }));
  }
}

/** 回復の粒: 札から立ち上る */
function rise(layer: HTMLElement, r: DOMRect, color: string, n: number) {
  particles(layer, r, color, n, "mote", () => ({ x: (Math.random() - 0.5) * r.width, y: -40 - Math.random() * 40, ms: 700 + Math.random() * 300, delay: Math.random() * 200 }));
}
