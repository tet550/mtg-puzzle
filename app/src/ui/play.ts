// パズルを遊ぶ画面。PuzzleSession の状態を描き、盤面と操作の欄からの入力を回答にして送る。

import type { EngineStatus, ForgeEngine } from "../engine/client";
import type { CardView, GameEvent, GameView, Option, StackItem } from "../engine/protocol";
import { markCleared } from "../puzzle/catalog";
import { verdictText } from "../puzzle/judge";
import type { PuzzleJson } from "../puzzle/schema";
import { PuzzleSession, type SessionState } from "../puzzle/session";
import { detailBody, renderBoard, type BoardHooks, type BoardUi } from "./board";
import { buildInteraction, marksOf, optionLabel, type Interaction } from "./decision";
import { h } from "./dom";
import { decisionPrompt, eventText, passLabel, PHASE_NAMES } from "./text";

const VIEWER = "p1";

export class PlayPage {
  readonly el: HTMLElement;
  private readonly session: PuzzleSession;
  private engineStatus: EngineStatus = "idle";
  private selected = new Set<string>();
  private decisionSeq = -1;
  private open = new Set<string>();
  private flash = new Set<string>();
  private detail: CardView | null = null;
  private logOpen = window.matchMedia("(min-width: 901px)").matches;
  private menu: { x: number; y: number; options: Option[] } | null = null;
  private readonly names = new Map<string, string>();
  private readonly unsubs: (() => void)[] = [];
  private flashTimer = 0;
  private lastHistoryLength = 0;

  constructor(engine: ForgeEngine, private readonly puzzleId: string, private readonly onBack: () => void) {
    this.el = h("div.play");
    this.session = new PuzzleSession(engine);
    this.unsubs.push(engine.onStatus((s) => { this.engineStatus = s; this.render(); }));
    this.unsubs.push(this.session.subscribe((s) => this.onSession(s)));
    document.addEventListener("keydown", this.onKey);
  }

  async load(data: unknown) {
    await this.session.open(data);
  }

  /** 自動テスト用: 今の状態（進行・選択待ち・判定） */
  snapshot() {
    const s = this.session.state;
    return { phase: s.phase, pending: s.step?.pending ?? null, verdict: s.verdict, errors: s.errors, engine: this.engineStatus };
  }

  dispose() {
    this.unsubs.forEach((u) => u());
    document.removeEventListener("keydown", this.onKey);
    window.clearTimeout(this.flashTimer);
  }

  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { this.menu = null; this.detail = null; this.render(); }
    if (e.key === "l" && !(e.target instanceof HTMLInputElement)) { this.logOpen = !this.logOpen; this.render(); }
  };

  private onSession(s: SessionState) {
    if (s.step) {
      for (const p of s.step.view.players) for (const c of p.cards) this.names.set(c.instanceId, c.name);
      for (const it of s.step.view.stack) if (!this.names.has(it.sourceId)) this.names.set(it.sourceId, it.description);
    }
    if (s.step?.pending?.seq !== this.decisionSeq) {
      this.decisionSeq = s.step?.pending?.seq ?? -1;
      this.selected.clear();
      this.menu = null;
    }
    // 新しい出来事で変わったカードを短く光らせる（イベントの再生の最小限）
    if (s.history.length < this.lastHistoryLength) this.lastHistoryLength = 0;
    const fresh = s.history.slice(this.lastHistoryLength);
    this.lastHistoryLength = s.history.length;
    this.flash = changedCards(fresh);
    if (this.flash.size) {
      window.clearTimeout(this.flashTimer);
      this.flashTimer = window.setTimeout(() => { this.flash.clear(); this.render(); }, 900);
    }
    if (s.phase === "finished" && s.verdict.result === "CLEARED") markCleared(this.puzzleId);
    this.render();
  }

  // ---------------------------------------------------------------- 描画

  private render() {
    const s = this.session.state;
    const view = s.step?.view ?? (s.puzzle ? previewView(s.puzzle) : null);
    const interaction = s.phase === "playing" && s.step?.pending && s.step ? buildInteraction(s.step.pending, s.step.view) : null;
    const ui: BoardUi = {
      viewer: VIEWER,
      marks: marksOf(interaction, this.selected),
      open: this.open,
      startTurn: s.startTurn || view?.turn || 1,
      flash: this.flash,
    };
    const hooks: BoardHooks = {
      card: (c) => this.onCard(c, interaction),
      detail: (c) => { this.detail = c; this.render(); },
      player: (id) => this.onPlayer(id, interaction),
      toggle: (key) => { this.open.has(key) ? this.open.delete(key) : this.open.add(key); this.render(); },
    };
    const scroll = this.el.querySelector<HTMLElement>(".hand")?.scrollLeft ?? 0;
    const logScroll = this.el.querySelector<HTMLElement>(".log");
    const stickLog = !logScroll || logScroll.scrollTop + logScroll.clientHeight >= logScroll.scrollHeight - 8;

    const header = h("header.bar", null,
      h("button.back", { type: "button", onclick: () => this.onBack(), title: "問題の一覧へ" }, "← 一覧"),
      h("strong.ptitle", null, s.puzzle?.title ?? "…"),
      h("span.chip.goal", { title: "勝利条件" }, "このターン中に勝利"),
      view ? h("span.turn", null, `${view.turn} ターン目・${PHASE_NAMES[view.phase] ?? view.phase}`) : null,
      h("span.spacer"),
      engineBadge(this.engineStatus),
      h("button", { type: "button", onclick: () => void this.session.reset(), disabled: !s.puzzle || s.phase === "loading" || s.phase === "busy", title: "初期盤面からやり直す" }, "リセット"),
      h("button" + (this.logOpen ? ".on" : ""), { type: "button", onclick: () => { this.logOpen = !this.logOpen; this.render(); }, title: "Log を開く・閉じる（L キー）" }, "Log"),
    );

    const board = view ? renderBoard(view, ui, hooks) : h("section.board");
    // スタックは相手の側と自分の側の間に置く（盤面の見出しに重ねない）
    const stack = view ? stackBox(view, this.names, ui.marks) : null;
    if (stack) board.insertBefore(stack, board.children[1] ?? null);
    const main = h("main.layout" + (this.logOpen ? ".withlog" : ""), null,
      h("div.boardwrap", null, board, s.puzzle?.description ? h("p.pdesc.muted", null, s.puzzle.description) : null),
      this.logOpen ? h("aside.logpane", null, h("div.lphead", null, "Log",
        h("button", { type: "button", onclick: () => { this.logOpen = false; this.render(); } }, "×")),
        logList(s.history, this.names)) : null,
    );

    const panel = this.actionPanel(s, interaction);
    const detail = this.detail ? h("div.float.cdetail", { role: "dialog" },
      h("div.fhead", null, "カード", h("button", { type: "button", onclick: () => { this.detail = null; this.render(); }, title: "閉じる" }, "×")),
      detailBody(this.detail)) : null;
    const menu = this.menu ? optionMenu(this.menu, (o) => this.choose(o, interaction)) : null;

    this.el.replaceChildren(header, main, panel, ...(detail ? [detail] : []), ...(menu ? [menu] : []));
    const hand = this.el.querySelector<HTMLElement>(".hand");
    if (hand) hand.scrollLeft = scroll;
    const log = this.el.querySelector<HTMLElement>(".log");
    if (log && stickLog) log.scrollTop = log.scrollHeight;
  }

  /** 画面の下に固定した操作の欄 */
  private actionPanel(s: SessionState, i: Interaction | null): HTMLElement {
    const bar = h("div.actions", { "data-phase": s.phase });
    switch (s.phase) {
      case "idle":
      case "loading":
        bar.append(h("div.prompt", null, h("span.spin"), this.engineStatus === "ready" ? "問題を読み込んでいます…" : `エンジンを準備しています…（${statusText(this.engineStatus)}）`));
        break;
      case "busy":
        bar.append(h("div.prompt", null, h("span.spin"), "処理中…"));
        break;
      case "finished": {
        const cleared = s.verdict.result === "CLEARED";
        bar.classList.add(cleared ? "cleared" : "failed");
        bar.append(h("div.result", null, verdictText(s.verdict)),
          h("div.btns", null,
            h("button.on.big", { type: "button", onclick: () => void this.session.reset() }, "もう一度"),
            h("button.big", { type: "button", onclick: () => this.onBack() }, "問題の一覧へ")));
        break;
      }
      case "error":
        bar.classList.add("error");
        bar.append(h("div.result", null, "問題を続けられません"),
          h("ul.errors", null, s.errors.map((e) => h("li", null, e))),
          h("div.btns", null,
            s.puzzle ? h("button.on.big", { type: "button", onclick: () => void this.session.reset() }, "リセット") : null,
            h("button.big", { type: "button", onclick: () => location.reload() }, "再読み込み"),
            h("button.big", { type: "button", onclick: () => this.onBack() }, "問題の一覧へ")));
        break;
      case "playing":
        if (i) this.decisionBar(bar, s, i);
        break;
    }
    if (s.notice) bar.prepend(h("div.notice", null, s.notice));
    return bar;
  }

  private decisionBar(bar: HTMLElement, s: SessionState, i: Interaction) {
    const d = i.decision;
    const view = s.step!.view;
    bar.append(h("div.prompt", null, decisionPrompt(d)));
    const btns = h("div.btns");
    // 盤面に無い選択肢（モード・数・見えない領域のカード）はここに並べる
    if (i.listed.length) {
      const list = h("div.listed");
      for (const o of i.listed) {
        const on = this.selected.has(o.id);
        list.append(h("button.opt" + (on ? ".on" : ""), { type: "button", onclick: () => this.choose(o, i) }, optionLabel(o)));
      }
      bar.append(list);
    }
    if (!i.single && d.kind !== "PRIORITY") {
      const n = this.selected.size;
      const ok = n >= d.min && n <= d.max;
      const label = d.kind === "ATTACKERS" ? (n ? `${n} 体で攻撃する` : "攻撃しない") : `決定（${n}）`;
      btns.append(h("button.on.big", { type: "button", disabled: !ok, onclick: () => this.send([...this.selected]) }, label));
      if (n) btns.append(h("button", { type: "button", onclick: () => { this.selected.clear(); this.render(); } }, "選び直す"));
    }
    for (const o of i.specials) {
      const value = o.ref?.type === "special" ? o.ref.value : "";
      const text = value === "pass" ? passLabel(view.phase, view.stack.length) : optionLabel(o);
      btns.append(h("button.big" + (value === "pass" || value === "yes" ? ".on" : ""), {
        type: "button", "data-special": value, onclick: () => this.send([o.id]),
      }, text));
    }
    bar.append(btns);
  }

  // ---------------------------------------------------------------- 入力

  private onCard(c: CardView, i: Interaction | null) {
    const opts = i?.onBoard.get(c.instanceId);
    if (!i || !opts) {
      this.detail = c;
      this.render();
      return;
    }
    this.pick(opts, i, c.instanceId);
  }

  private onPlayer(id: string, i: Interaction | null) {
    const opts = i?.onBoard.get(id);
    if (i && opts) this.pick(opts, i, id);
  }

  /** 1 つの盤面の要素に複数の選択肢があればメニューを出す */
  private pick(opts: Option[], i: Interaction, key: string) {
    if (opts.length === 1) {
      this.choose(opts[0], i);
      return;
    }
    const el = this.el.querySelector<HTMLElement>(`[data-id="${CSS.escape(key)}"], [data-player="${CSS.escape(key)}"]`);
    const r = el?.getBoundingClientRect();
    this.menu = { x: r ? r.left : 20, y: r ? r.bottom + 4 : 80, options: opts };
    this.render();
  }

  private choose(o: Option, i: Interaction | null) {
    this.menu = null;
    if (!i) return;
    if (i.single) {
      this.send([o.id]);
      return;
    }
    if (this.selected.has(o.id)) this.selected.delete(o.id);
    else if (this.selected.size < i.decision.max) this.selected.add(o.id);
    this.render();
  }

  private send(ids: string[]) {
    this.selected.clear();
    this.menu = null;
    void this.session.answer(ids);
  }
}

// ---------------------------------------------------------------- 部品

function engineBadge(s: EngineStatus): HTMLElement {
  return h(`span.engine.${s}`, { title: "エンジン（Forge）の状態" }, statusText(s));
}

function statusText(s: EngineStatus): string {
  return { idle: "待機", booting: "起動中", initializing: "初期化中", ready: "準備完了", failed: "異常" }[s];
}

/** スタック。唱えている途中（対象・支払いを選んでいる間）の呪文も、まだスタックに載っていない項目として出す */
function stackBox(view: GameView, names: Map<string, string>, marks: Map<string, string>): HTMLElement | null {
  const stack: StackItem[] = view.stack;
  const onStack = new Set(stack.map((it) => it.sourceId));
  const casting = view.players.flatMap((p) => p.cards).filter((c) => c.zone === "Stack" && !onStack.has(c.instanceId));
  if (!stack.length && !casting.length) return null;
  return h("div.stackbox", null, h("h3", null, `スタック（${stack.length}）`),
    h("ol.stack", null,
      casting.map((c) => h("li.casting", null, h("strong", null, c.name), h("div.muted", null, "唱えている途中"))),
      stack.map((it) => h("li" + (marks.has(it.sourceId) ? ".cand" : ""), null,
        h("strong", null, names.get(it.sourceId) ?? "?"), h("div.muted", null, it.description.replace(/\s*\(\d+\)/g, ""))))));
}

function logList(history: GameEvent[], names: Map<string, string>): HTMLElement {
  const lines = history.map((e) => eventText(e, (id) => names.get(id) ?? id, VIEWER)).filter((t): t is string => !!t);
  return h("div.log", null, lines.length ? lines.map((t) => h("div.ev" + (t.startsWith("──") ? ".turnline" : ""), null, t)) : h("div.muted", null, "まだ何も起きていません"));
}

function optionMenu(m: { x: number; y: number; options: Option[] }, choose: (o: Option) => void): HTMLElement {
  const x = Math.min(m.x, window.innerWidth - 300);
  const y = Math.min(m.y, window.innerHeight - 60 * m.options.length - 20);
  return h("div.menu", { role: "menu", style: `left:${Math.max(8, x)}px;top:${Math.max(8, y)}px` } as never,
    m.options.map((o) => h("button", { type: "button", role: "menuitem", onclick: () => choose(o) }, optionLabel(o))));
}

/** 出来事で変わったカード */
function changedCards(events: GameEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.type === "zoneChange" || e.type === "tapped" || e.type === "counters") out.add(e.cardId);
    if (e.type === "damage") out.add(e.target);
    if (e.type === "life") out.add(e.player);
  }
  return out;
}

const BASIC_LANDS = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes"]);

/** エンジンの準備ができる前に、問題データから盤面を仮に描く（A1 の所見: 準備中も盤面を見て考えられるように） */
export function previewView(p: PuzzleJson): GameView {
  return {
    turn: p.game.turn ?? 1,
    phase: (p.game.phase.toUpperCase() as GameView["phase"]) ?? "MAIN1",
    activePlayer: p.game.activePlayer,
    priorityPlayer: null,
    stack: [],
    combat: [],
    players: p.game.players.map((pl) => ({
      id: pl.id,
      life: pl.life ?? 20,
      poison: 0,
      manaPool: {},
      handCount: pl.hand?.length ?? 0,
      libraryCount: pl.library?.length ?? 0,
      cards: (["hand", "battlefield", "graveyard", "exile"] as const).flatMap((zone) =>
        (pl.id !== p.goal.player && zone === "hand") ? [] : (pl[zone] ?? []).map((c): CardView => ({
          instanceId: c.id,
          name: c.cardId,
          zone: (zone[0].toUpperCase() + zone.slice(1)) as CardView["zone"],
          owner: pl.id,
          controller: pl.id,
          kinds: BASIC_LANDS.has(c.cardId) ? ["land"] : [],
          typeLine: "",
          manaCost: "",
          text: "",
          power: null,
          toughness: null,
          basePower: null,
          baseToughness: null,
          damage: 0,
          tapped: !!c.tapped,
          sick: !!c.summoningSick,
          token: false,
          faceDown: false,
          counters: c.counters ?? {},
          attachedTo: null,
          exiledBy: null,
        }))),
    })),
  };
}
