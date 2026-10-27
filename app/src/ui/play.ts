// パズルを遊ぶ画面。PuzzleSession の状態を描き、盤面と操作の欄からの入力を回答にして送る。

import { puzzleCardNames, type EngineStatus, type ForgeEngine } from "../engine/client";
import type { CardView, Decision, GameEvent, GameView, Option } from "../engine/protocol";
import { cardMeta, isCardDbLoaded, loadCardDb } from "../puzzle/carddb";
import { markCleared } from "../puzzle/catalog";
import { verdictText } from "../puzzle/judge";
import { parseManaPool, ZONES, type PuzzleJson } from "../puzzle/schema";
import { PuzzleSession, type SessionLogStep, type SessionState } from "../puzzle/session";
import { buildShareUrl, buildSolutionShareUrl, snapshotPuzzleFromView } from "../puzzle/share";
import {
  deleteRegisteredSolution,
  formatSolutionStep,
  loadBundledSolution,
  loadRegisteredSolution,
  matchSolutionStep,
  saveRegisteredSolution,
  type SolutionStep,
} from "../puzzle/solution";
import { combatBody, combatSets, detailBody, renderBoard, stackBody, type BoardHooks, type BoardUi, type Mark, type Targeting } from "./board";
import { TargetArrow } from "./arrow";
import { localized } from "./localize";
import { fitHands, setupFloat } from "./float";
import { macroAnswer, startMacro, type Macro } from "./quick";
import { manaNodes } from "./mana";
import { icon, type IconName } from "./icons";
import { buildInteraction, colorName, isColorAsk, isDirectManaLand, manaLabel, marksOf, optionLabel, type Interaction } from "./decision";
import { h, patchChildren } from "./dom";
import { cardImage, displayName, ensureCardImages, imagesEnabled, printedText } from "./images";
import { puzzleDescription, puzzleTitle, t, type MessageKey } from "../i18n";
import { optionsButton } from "./options";
import { openSnsShareDialog, type SnsShareKind } from "./sns";
import { decisionPrompt, eventText, passLabel, phaseName } from "./text";
import { capture, motionEnabled, play, skip, verdictStamp } from "./motion";

const VIEWER = "p1";

export interface PlayOptions {
  backKey?: MessageKey;
  backTitleKey?: MessageKey;
  toBackKey?: MessageKey;
  recordClear?: boolean;
  /** URL パラメータ (?s=...) 等で渡された公開解答手順 */
  sharedSolution?: SolutionStep[] | null;
  /** 解答手順が登録されたときのコールバック（エディタのテストプレイ連携用） */
  onRegisterSolution?: (steps: SolutionStep[]) => void;
  /** 一人回し（プレイテスト）で初手を引き直す・マリガン画面を開くコールバック */
  onNewHand?: (() => void) | null;
  /** 現在の盤面スナップショットを盤面エディタで開くコールバック */
  onOpenEditor?: ((puzzle: PuzzleJson) => void) | null;
}

interface ReplayState {
  steps: SolutionStep[];
  index: number;
  auto: boolean;
  timer: number;
  stepOnceAfterReset?: boolean;
  resetting?: boolean;
}

export class PlayPage {
  readonly el: HTMLElement;
  private readonly session: PuzzleSession;
  private readonly opts: Required<PlayOptions>;
  private engineStatus: EngineStatus = "idle";
  private selected = new Set<string>();
  private decisionSeq = -1;
  private open = new Set<string>();
  /** 選択の候補を含む束を閉じたときの印（BoardUi.dismissed） */
  private dismissed = new Map<string, string>();
  private flash = new Set<string>();
  private detail: CardView | null = null;
  private logOpen = window.matchMedia("(min-width: 900px) and (orientation: landscape)").matches;
  private debug = debugEnabled();
  /** カードの上のメニュー。locked は取りやめられない選択（色の問い合わせ）で、外を押しても閉じない */
  private menu: OptionMenu | null = null;
  /** 対象を選んでいる間の、スタックからカーソルへの矢印 */
  private arrow: TargetArrow | null = null;
  private readonly names = new Map<string, string>();
  /** 最後に見えていたカードの姿（スタックに積んだ呪文のカードを出すため） */
  private readonly known = new Map<string, CardView>();
  private readonly unsubs: (() => void)[] = [];
  private flashTimer = 0;
  private lastHistoryLength = 0;
  private images = imagesEnabled();
  /** 進行中のおまかせ（呪文・能力を唱えて解決まで進める。quick.ts） */
  private macro: Macro | null = null;
  /** 呪文や能力を自動で解決せず、スタックに積んだところで止めるか（プレイヤー見出しで切り替える） */
  private holdStack = false;
  /** 同時に誘発した能力をスタックに積む順番を手動で選ぶか（初期状態 OFF＝自動で並べる） */
  private orderStack = false;
  /** 手札のドラッグ */
  private drag: { id: string; el: HTMLElement; x: number; y: number; ghost: HTMLElement | null; over: HTMLElement | null;
    dx: number; dy: number; note: HTMLElement | null } | null = null;
  private suppressClick = false;
  /**
   * 直前に押したカード。ダブルクリックは自前で判定する: 1 回目のクリックで唱え始めるとカードが手札から
   * スタックへ移って描き直され、2 回目は別の要素に当たるので、ブラウザの dblclick は届かない
   */
  private lastPress: { id: string; at: number; x: number; y: number } | null = null;
  /** 畳んでいる小窓（"stack" / "combat" / "play"）。選択要求が変わると開き直す（操作パネルは除く） */
  private minimized = new Set<string>();
  /** 盤面に無い選択肢のメニューを閉じた選択要求の seq（同じ選択要求の間は自分では開き直さない） */
  private menuDismissed = -1;
  /** 出来事の演出（motion.ts）。再生中は描き直しを待たせる */
  private motion = motionEnabled();
  private playing = false;
  private dirty = false;
  private lastStep: SessionState["step"] = null;
  /** 優先権でプレイヤーが起動した起動型能力の発生源（誘発と区別する） */
  private activating: string | null = null;
  /** 唱えている・起動している途中（モード・対象・コスト支払いなど）の呪文・能力 */
  private casting: { cardId: string; desc: string; descJa: string | null; targets: string[] } | null = null;
  /** 解決の途中で選択を待っているスタックの項目（Forge は解決開始時にスタックから外すため、resolved まで残す） */
  private resolving: GameView["stack"][number] | null = null;
  /** スタックに積む前の選択で既に誘発の演出を出した発生源 */
  private promptedTriggers = new Set<string>();
  /** エンジン応答待ち（busy）の間も直前のハイライトを保ち、ちらつきを防ぐ */
  private lastMarks = new Map<string, Mark>();
  /** 解答手順パネルの開閉と、保持している解答手順（URL共有 / ローカル登録 / 同梱公式） */
  private solutionOpen = false;
  private sharedSolution: SolutionStep[] | null = null;
  private registeredSolution: SolutionStep[] | null = null;
  private bundledSolution: SolutionStep[] | null = null;
  private bundledRevealed = false;
  private solutionFeedback: { text: string; isError: boolean } | null = null;
  private replayError: string | null = null;
  private replay: ReplayState | null = null;
  private seeking = false;
  private lastStepCount = 0;
  private disposed = false;

  constructor(engine: ForgeEngine, private readonly puzzleId: string, private readonly onBack: () => void, opts: PlayOptions = {}) {
    this.opts = {
      backKey: opts.backKey ?? "header.back",
      backTitleKey: opts.backTitleKey ?? "header.back.title",
      toBackKey: opts.toBackKey ?? "action.toCatalog",
      recordClear: opts.recordClear ?? true,
      sharedSolution: opts.sharedSolution ?? null,
      onRegisterSolution: opts.onRegisterSolution ?? (() => {}),
      onNewHand: opts.onNewHand ?? null,
      onOpenEditor: opts.onOpenEditor ?? null,
    };
    this.sharedSolution = this.opts.sharedSolution;
    if (this.sharedSolution && this.sharedSolution.length > 0) {
      this.logOpen = true;
    }
    this.el = h("div.play");
    this.session = new PuzzleSession(engine);
    this.unsubs.push(engine.onStatus((s) => { this.engineStatus = s; this.render(); }));
    this.unsubs.push(this.session.subscribe((s) => this.onSession(s)));
    const wideMq = window.matchMedia("(min-width: 900px) and (orientation: landscape)");
    const onWideChange = (e: MediaQueryListEvent) => { this.logOpen = e.matches; this.render(); };
    wideMq.addEventListener("change", onWideChange);
    this.unsubs.push(() => wideMq.removeEventListener("change", onWideChange));
    document.addEventListener("keydown", this.onKey);
    this.setupQuickActions();
  }

  async load(data: unknown) {
    // カードDBが未ロードなら背景で読み込む（プレイテスト等の同梱外カードの日本語名・オラクル・タイプ行に使う）
    if (!isCardDbLoaded()) {
      void loadCardDb()
        .then(() => { if (!this.disposed) this.render(); })
        .catch(() => {});
    }
    // 画像の一覧に無いカードは Scryfall で引く（問題の読み込みと並行。分かったら描き直す）
    void ensureCardImages(puzzleCardNames(data)).then((changed) => { if (changed && !this.disposed) this.render(); });
    void loadBundledSolution(this.puzzleId).then((sol) => {
      if (!this.disposed && sol && sol.length > 0) {
        this.bundledSolution = sol;
        this.render();
      }
    });
    await this.session.open(data);
    const p = this.session.state.puzzle;
    const stored = loadRegisteredSolution(this.puzzleStorageKey());
    this.registeredSolution = stored ?? (p?.solution && p.solution.length > 0 ? p.solution : null);
    this.render();
  }

  /** 言語を切り替えたときなどに描き直す */
  refresh() {
    this.render();
  }

  /** 自動テスト用: 今の状態（進行・選択待ち・判定） */
  snapshot() {
    const s = this.session.state;
    return { phase: s.phase, pending: s.step?.pending ?? null, verdict: s.verdict, errors: s.errors, engine: this.engineStatus };
  }

  private dropArrow() {
    this.arrow?.dispose();
    this.arrow = null;
  }

  dispose() {
    this.stopReplay();
    this.dropArrow();
    this.disposed = true;
    this.unsubs.forEach((u) => u());
    document.removeEventListener("keydown", this.onKey);
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragEnd);
    window.removeEventListener("pointercancel", this.onDragCancel);
    if (this.drag) this.endDrag(this.drag);
    window.clearTimeout(this.flashTimer);
    skip();
  }

  private readonly onKey = (e: KeyboardEvent) => {
    // Esc: 開いているもの（メニュー・カードの詳細）を閉じる。何も開いていなければ、おまかせ・解答再生をやめるか、取りやめる
    if (e.key === "Escape") {
      if (this.menu && !this.menu.locked) this.closeMenu();
      else if (this.detail) this.detail = null;
      else if (this.replay) this.stopReplay();
      else if (!this.menu) {
        this.macro = null;
        const cancel = this.session.state.phase === "playing" && this.session.state.step?.pending?.options.find((o) => o.ref?.type === "special" && o.ref.value === "cancel");
        if (cancel) { this.send([cancel.id]); return; }
      }
      this.render();
      return;
    }
    const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
    if (!inInput) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (this.session.state.stepLogs.length > 0) {
          const entries = this.timelineEntries(this.session.state);
          void this.jumpToStep(this.session.state.stepLogs.length - 1, entries.map((x) => x.step));
        }
        return;
      }
      if ((mod && e.shiftKey && e.key.toLowerCase() === "z") || (mod && e.key.toLowerCase() === "y")) {
        e.preventDefault();
        const entries = this.timelineEntries(this.session.state);
        if (this.session.state.stepLogs.length < entries.length) {
          void this.jumpToStep(this.session.state.stepLogs.length + 1, entries.map((x) => x.step));
        }
        return;
      }
      if (e.key === "l") {
        this.logOpen = !this.logOpen;
        this.render();
      }
    }
  };

  private onSession(s: SessionState) {
    if (s.step) {
      const stepNames: string[] = [];
      for (const p of s.step.view.players) {
        for (const c of p.cards) {
          this.names.set(c.instanceId, c.name);
          this.known.set(c.instanceId, c);
          stepNames.push(c.name);
        }
      }
      for (const it of s.step.view.stack) if (!this.names.has(it.sourceId)) this.names.set(it.sourceId, it.description);
      // プレイ中に生成されたトークンなど、初期盤面に無かったカードの画像も Scryfall で引く
      void ensureCardImages(stepNames).then((changed) => { if (changed && !this.disposed) this.render(); });
    }
    if (s.step?.pending?.seq !== this.decisionSeq) {
      this.decisionSeq = s.step?.pending?.seq ?? -1;
      this.selected.clear();
      this.menu = null;
      this.minimized.delete("stack");
      this.minimized.delete("combat");
    }
    if (s.history.length < this.lastHistoryLength) {
      this.lastHistoryLength = 0;
      // やり直し・リセットで同じ ID のカードが戻るので、閉じた束の印も忘れる
      this.dismissed.clear();
      this.activating = null;
      this.casting = null;
      this.resolving = null;
      this.promptedTriggers.clear();
    }
    const fresh = s.history.slice(this.lastHistoryLength);
    this.lastHistoryLength = s.history.length;
    const prev = this.lastStep;
    this.lastStep = s.step;
    const activated = this.activating;
    const prompted = new Set(this.promptedTriggers);
    const triggered = preStackTriggers(prev, s.step, activated, this.promptedTriggers);
    if (s.phase !== "busy") {
      const d = s.step?.pending ?? null;
      if (!s.step || d?.kind === "PRIORITY" || s.phase !== "playing") {
        this.activating = null;
        this.casting = null;
        this.resolving = null;
        this.promptedTriggers.clear();
      } else {
        if (this.casting && fresh.some((e) =>
          (e.type === "cast" && e.sourceId === this.casting!.cardId)
          || (e.type === "zoneChange" && e.cardId === this.casting!.cardId && e.from === "Stack"))) {
          this.casting = null;
        }
        if (d?.source && (d.kind === "TARGETS" || d.kind === "CHOOSE_MODE")) {
          const a = d.promptArgs ?? {};
          if (!this.casting || this.casting.cardId !== d.source) {
            this.casting = { cardId: d.source, desc: a.desc ?? "", descJa: a.descJa ?? null, targets: [] };
          } else if (a.desc) {
            this.casting.desc = a.desc;
            this.casting.descJa = a.descJa ?? null;
          }
        }
        if (this.resolving && (
          fresh.some((e) => e.type === "resolved" && e.sourceId === this.resolving!.sourceId)
          || s.step.view.stack.some((it) => it.sourceId === this.resolving!.sourceId && it.description === this.resolving!.description)
        )) {
          this.resolving = null;
        }
      }
    }
    // 演出: 前の盤面があって、新しい出来事が来たときだけ（開いた・やり直した・シーク移動したときは描くだけ）
    const animate = !this.seeking && this.motion && !!prev && !!s.step && s.step !== prev && (fresh.length > 0 || triggered.length > 0);
    if (!animate) {
      // 演出を切っているときは、新しい出来事で変わったカードを短く光らせるだけ
      this.flash = (this.motion || this.seeking) ? new Set() : changedCards(fresh, triggered);
      if (this.flash.size) {
        window.clearTimeout(this.flashTimer);
        this.flashTimer = window.setTimeout(() => { this.flash.clear(); this.render(); }, 900);
      }
    }
    if (s.phase === "finished" && s.verdict.result === "CLEARED" && this.opts.recordClear) markCleared(this.puzzleId);
    if (s.phase === "finished" || s.phase === "error" || s.phase === "loading") this.macro = null;
    if (s.phase === "playing" && this.replay?.resetting) this.replay.resetting = false;
    if (s.phase === "finished" || s.phase === "error") this.stopReplay();
    if (s.step === prev && this.playing) {
      this.dirty = true;
      return;
    }
    if (this.playing) skip();
    const before = animate ? capture(this.el) : null;
    this.playing = false;
    this.render();
    const after = () => {
      this.arrow?.setOrigin(this.el.querySelector<HTMLElement>(".stackbox [data-targeting]"));
      if (!this.seeking && s.phase === "finished" && prev?.engine.state !== "GAME_OVER") verdictStamp(s.verdict.result === "CLEARED");
      if (this.macro && s.phase === "playing") queueMicrotask(() => this.stepMacro());
      else if (!this.orderStack && !this.replay && s.phase === "playing") queueMicrotask(() => this.stepAutoOrder());
      if (this.replay && s.phase === "playing") {
        if (this.replay.stepOnceAfterReset) {
          this.replay.stepOnceAfterReset = false;
          queueMicrotask(() => this.stepReplayOnce());
        } else if (this.replay.auto) {
          this.scheduleReplayStep(this.motion ? 320 : 80);
        } else {
          this.render();
        }
      }
    };
    if (!before || !prev || !s.step) {
      after();
      return;
    }
    this.playing = true;
    void play({ root: this.el, before, prev: prev.view, next: s.step.view, events: fresh, viewer: VIEWER, known: this.known, activated, triggered, prompted })
      .catch((e) => console.error(e))
      .finally(() => {
        if (this.session.state !== s) return; // 再生中に次の状態が来た（その状態の描画が済んでいる）
        this.playing = false;
        if (this.dirty) this.render();
        after();
      });
  }

  // ---------------------------------------------------------------- 手早く唱える（ドラッグ・ダブルクリック）

  /** おまかせを 1 歩進める。人が決める選択なら待つ（答えた後の状態でまた呼ばれる） */
  private stepMacro() {
    const s = this.session.state;
    const m = this.macro;
    if (!m || s.phase !== "playing" || !s.step?.pending) return;
    const ans = macroAnswer(m, s.step.pending, s.step.view, this.holdStack, this.orderStack);
    if (ans === "end") {
      this.macro = null;
      this.render();
      return;
    }
    if (ans) this.send(ans);
  }

  /** 「積む順を選ぶ」が OFF（自動）のとき、同時誘発の順番選択（orderSimultaneous）を自動で進める */
  private stepAutoOrder() {
    const s = this.session.state;
    const d = s.step?.pending;
    if (this.orderStack || this.replay || s.phase !== "playing" || !d) return;
    if (d.promptKey === "orderSimultaneous" && d.options.length > 0) {
      this.send([d.options[0].id]);
    }
  }

  private startQuick(cardId: string, targetKey: string | null, optionId: string | null = null) {
    this.menu = null;
    this.selected.clear();
    this.macro = startMacro(cardId, targetKey, optionId);
    this.render();
    this.stepMacro();
  }

  /** 今そのカードで唱える・起動することができるか（優先権の選択肢にあるか。マナ能力は除く） */
  private castable(cardId: string): boolean {
    const d = this.session.state.step?.pending;
    return this.session.state.phase === "playing" && d?.kind === "PRIORITY"
      && d.options.some((o) => o.ref?.type === "ability" && o.ref.cardId === cardId && o.ref.abilityKind !== "mana");
  }

  private setupQuickActions() {
    // 手札のドラッグ: 対象の上で離すとその対象で、盤面の上で離すと対象なしで唱える
    this.el.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      // ダブルクリック（400 ms 以内に、ほぼ同じ所を 2 回押す）: 1 回目に押したカードを唱えて解決まで進める
      const prev = this.lastPress;
      const now = performance.now();
      if (prev && now - prev.at < 400 && Math.hypot(ev.clientX - prev.x, ev.clientY - prev.y) < 12) {
        this.lastPress = null;
        const d = this.session.state.step?.pending;
        // 1 回目のクリックで唱え始めていれば、その続きから進める
        const busy = this.session.state.phase === "busy"; // 1 回目のクリックの「唱える」をエンジンが処理中
        if (this.castable(prev.id) || busy || (d && d.kind !== "PRIORITY")) {
          this.suppressClick = true; // 2 回目のクリックは、下にあった別のカードを押したことにしない
          if (this.detail?.instanceId === prev.id) this.detail = null;
          if (!this.macro) this.startQuick(prev.id, null);
          return;
        }
      }
      const pressed = (ev.target as HTMLElement).closest<HTMLElement>(".board .card[data-id]");
      this.lastPress = pressed ? { id: pressed.dataset.id!, at: now, x: ev.clientX, y: ev.clientY } : null;
      const card = (ev.target as HTMLElement).closest<HTMLElement>(".hand .card[data-id]");
      if (!card) return;
      const r = card.getBoundingClientRect();
      this.drag = { id: card.dataset.id!, el: card, x: ev.clientX, y: ev.clientY, ghost: null, over: null, dx: ev.clientX - r.left, dy: ev.clientY - r.top, note: null };
    });
    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragEnd);
    window.addEventListener("pointercancel", this.onDragCancel);
    // ドラッグ・ダブルクリックの後のクリックは捨てる（カードを押したことにしない）
    this.el.addEventListener("click", (ev) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        ev.stopPropagation();
        ev.preventDefault();
      }
    }, true);
    this.el.addEventListener("dblclick", (ev) => ev.preventDefault());
  }

  private readonly onDragMove = (ev: PointerEvent) => {
    const g = this.drag;
    if (!g) return;
    if (!g.ghost) {
      if (Math.hypot(ev.clientX - g.x, ev.clientY - g.y) < 8) return;
      if (!this.castable(g.id)) { this.drag = null; return; }
      const r = g.el.getBoundingClientRect();
      const ghost = g.el.cloneNode(true) as HTMLElement;
      ghost.classList.add("dragghost");
      ghost.classList.remove("cand", "chosen", "flash");
      // カードの大きさは手札の欄の --h から決めているので、欄の外（body の直下）に置く写しには値を写す
      ghost.style.setProperty("--h", getComputedStyle(g.el).getPropertyValue("--h"));
      Object.assign(ghost.style, { width: `${r.width}px`, height: `${r.height}px` });
      document.body.append(ghost);
      g.ghost = ghost;
      g.el.classList.add("dragging");
      document.body.classList.add("nosel");
      g.note = this.el.querySelector<HTMLElement>(".playpanel .actions")?.insertAdjacentElement("afterbegin", h("div.dragnote")) as HTMLElement ?? null;
    }
    ev.preventDefault();
    g.ghost.style.transform = `translate(${ev.clientX - g.dx}px, ${ev.clientY - g.dy}px)`;
    const target = this.dropTarget(ev.clientX, ev.clientY);
    if (target !== g.over) {
      g.over?.classList.remove("dropover");
      target?.classList.add("dropover");
      g.over = target;
    }
    // 離すとどうなるかを操作パネルに出す
    const onBoard = this.dropOnBoard(ev.clientX, ev.clientY);
    if (g.note) g.note.textContent = this.dropText(g.id, target, onBoard);
  };

  /** 盤面の上で離したか。手札の上（手札に戻した）と盤面の外は取りやめ */
  private dropOnBoard(x: number, y: number): boolean {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    return !!hit?.closest(".board") && !hit.closest(".handbox");
  }

  /** ドラッグ中の案内: 離したときに何をするか */
  private dropText(cardId: string, target: HTMLElement | null, onBoard: boolean): string {
    if (!onBoard) return t("drag.cancel");
    const card = displayName(this.names.get(cardId) ?? "");
    const opts = this.session.state.step?.pending?.options.filter((o) => o.ref?.type === "ability" && o.ref.cardId === cardId) ?? [];
    if (opts.some((o) => o.ref?.type === "ability" && o.ref.abilityKind === "land") && !opts.some((o) => o.ref?.type === "ability" && o.ref.abilityKind === "spell")) {
      return t("drag.land", { card });
    }
    if (target) {
      const key = target.dataset.player ?? target.dataset.id ?? "";
      const name = target.dataset.player ? (key === VIEWER ? t("player.you") : t("player.opponent")) : displayName(this.names.get(key) ?? "");
      return t("drag.toTarget", { card, target: name });
    }
    return t("drag.noTarget", { card });
  }

  /** 指の下の落とし先: 盤面のカード・プレイヤーの見出し（自分の手札は除く） */
  private dropTarget(x: number, y: number): HTMLElement | null {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const t = hit?.closest<HTMLElement>(".board [data-player], .board .card[data-id]");
    if (!t || t.closest(".hand")) return null;
    return t;
  }

  private readonly onDragEnd = (ev: PointerEvent) => {
    const g = this.drag;
    this.drag = null;
    if (!g?.ghost) return;
    const target = this.dropTarget(ev.clientX, ev.clientY);
    const onBoard = this.dropOnBoard(ev.clientX, ev.clientY);
    this.endDrag(g);
    this.suppressClick = true;
    window.setTimeout(() => { this.suppressClick = false; }, 0);
    if (!onBoard) return; // 盤面の外・手札の上で離したら取りやめ
    const key = target ? (target.dataset.player ?? target.dataset.id ?? null) : null;
    this.startQuick(g.id, key);
  };

  private readonly onDragCancel = () => {
    if (this.drag) this.endDrag(this.drag);
    this.drag = null;
  };

  private endDrag(g: NonNullable<PlayPage["drag"]>) {
    g.ghost?.remove();
    g.note?.remove();
    g.over?.classList.remove("dropover");
    g.el.classList.remove("dragging");
    document.body.classList.remove("nosel");
  }

  // ---------------------------------------------------------------- 描画

  private render() {
    // 演出の再生中は描き直さない（動かしている要素が入れ替わってしまう）。終わってから描く
    if (this.playing) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    const s = this.session.state;
    const view = s.step?.view ?? (s.puzzle ? previewView(s.puzzle) : null);
    const interaction = s.phase === "playing" && s.step?.pending && s.step ? buildInteraction(s.step.pending, s.step.view) : null;
    if (s.phase === "playing") {
      this.lastMarks = marksOf(interaction, this.selected);
    } else if (s.phase !== "busy") {
      this.lastMarks = new Map();
    }
    const isPlaytest = s.puzzle?.goal.deadline === "none";
    const ui: BoardUi = {
      viewer: VIEWER,
      marks: this.lastMarks,
      open: this.open,
      dismissed: this.dismissed,
      startTurn: s.startTurn || view?.turn || 1,
      flash: this.flash,
      art: (name) => (this.images ? cardImage(name)?.normal ?? null : null),
      holdStack: this.holdStack,
      orderStack: this.orderStack,
      noDeadline: isPlaytest,
      ...(view ? combatSets(view) : { attacking: new Set<string>(), blocking: new Set<string>() }),
    };
    const hooks: BoardHooks = {
      card: (c) => this.onCard(c, interaction),
      detail: (c) => { this.detail = c; this.render(); },
      player: (id) => this.onPlayer(id, interaction),
      toggle: (key, closing) => {
        if (closing === undefined) {
          this.open.add(key);
          this.dismissed.delete(key);
        } else {
          this.open.delete(key);
          if (closing) this.dismissed.set(key, closing);
        }
        this.render();
      },
      toggleHoldStack: () => {
        this.holdStack = !this.holdStack;
        if (this.holdStack) this.macro = null;
        this.render();
      },
      toggleOrderStack: () => {
        this.orderStack = !this.orderStack;
        this.render();
        if (!this.orderStack) this.stepAutoOrder();
      },
    };
    const scroll = this.el.querySelector<HTMLElement>(".hand")?.scrollLeft ?? 0;
    const logScroll = this.el.querySelector<HTMLElement>(".log");
    const prevLogScrollTop = logScroll?.scrollTop ?? null;
    const stickLog = !logScroll || logScroll.scrollTop + logScroll.clientHeight >= logScroll.scrollHeight - 8;

    const header = h("header.bar", null,
      h("button.back", { type: "button", onclick: () => this.onBack(), title: t(this.opts.backTitleKey) }, t(this.opts.backKey)),
      h("strong.ptitle", null, s.puzzle ? puzzleTitle(s.puzzle) : "…"),
      h("span.chip.goal", { title: t(isPlaytest ? "header.playtestGoal.title" : "header.goal.title") }, t(isPlaytest ? "header.playtestGoal" : "header.goal")),
      view ? h("span.turn", null, t("header.turn", { turn: view.turn, phase: phaseName(view.phase) })) : null,
      h("span.spacer"),
      engineBadge(this.engineStatus),
      this.opts.onNewHand
        ? h("button", { type: "button", "data-action": "new-hand", onclick: () => { this.stopReplay(); this.opts.onNewHand?.(); }, disabled: s.phase === "loading" || s.phase === "busy", title: t("playtest.newHand.title") }, t("playtest.newHand"))
        : null,
      h("button", {
        type: "button",
        "data-action": "header-undo",
        onclick: () => {
          const entries = this.timelineEntries(s);
          void this.jumpToStep(s.stepLogs.length - 1, entries.map((x) => x.step));
        },
        disabled: s.stepLogs.length === 0 || s.phase === "loading" || s.phase === "busy",
        title: t("header.undo.title"),
      }, t("header.undo")),
      h("button", { type: "button", onclick: () => { this.stopReplay(); void this.session.reset(); }, disabled: !s.puzzle || s.phase === "loading" || s.phase === "busy", title: t("header.reset.title") }, t("header.reset")),
      h("button" + (this.solutionOpen ? ".on" : ""), { type: "button", "data-action": "toggle-solution", "aria-pressed": String(this.solutionOpen), title: t(isPlaytest ? "header.playtestSolution.title" : "header.solution.title"),
        onclick: () => { this.solutionOpen = !this.solutionOpen; this.solutionFeedback = null; this.render(); } }, t(isPlaytest ? "header.playtestSolution" : "header.solution")),
      h("button" + (this.logOpen || this.replay ? ".on" : ""), { type: "button", onclick: () => { this.logOpen = !this.logOpen; this.render(); }, title: t("header.log.title") }, "Log"),
      optionsButton(() => { this.images = imagesEnabled(); this.motion = motionEnabled(); this.render(); }),
    );

    // 盤面の上に浮かぶ小窓（mtgtable と同じ）: スタックは右上、戦闘は右の中ほど、カードの詳細は左上
    const board = view ? renderBoard(view, ui, hooks) : h("section.board");
    const targeting = this.currentTargeting(s.step?.pending ?? null, s.phase);
    const castingCards = view ? view.players.flatMap((p) => p.cards).filter((c) => c.zone === "Stack" && !view.stack.some((it) => it.sourceId === c.instanceId)) : [];
    const stackCount = (view?.stack.length ?? 0) + castingCards.length + (targeting && !castingCards.some((c) => c.instanceId === targeting.cardId) ? 1 : 0);
    if (view && stackCount > 0) {
      board.append(this.floatBox("stack", t("stack.title", { n: stackCount }), stackBody(view, ui, hooks, this.names, this.known, targeting)));
    }
    if (view && view.combat.length) board.append(this.floatBox("combat", t("combat.title"), combatBody(view, ui, hooks)));
    // カードの詳細は盤面の外（画面の一番上の層）に置く。盤面の中だと、狭い画面の下からのシートが操作パネルに隠れる
    let detail: HTMLElement | null = null;
    if (this.detail) {
      const d = this.detail;
      detail = (h("div.float.cdetail", { role: "dialog", "aria-label": t("card.detail") },
        h("div.fhead", null, h("span", null, displayName(d.name)),
          h("button", { type: "button", onclick: () => { this.detail = null; this.render(); }, title: t("card.close") }, "×")),
        h("div.fbody", null, detailBody(d, this.images ? cardImage(d.name)?.normal ?? null : null, cardImage(d.name)?.artist ?? null, printedText(d.name)))));
    }
    const main = h("main.layout" + (this.logOpen ? ".withlog" : "") + (this.debug ? ".withdebug" : ""), null,
      board,
      this.logOpen ? h("aside.logpane" + (this.debug ? ".debug" : ""), null, h("div.lphead", null, h("span", null, "Log"),
        h("button.dbgbtn" + (this.debug ? ".on" : ""), { type: "button", "aria-pressed": String(this.debug), title: t("header.debug.title"),
          onclick: () => { this.debug = !this.debug; setDebugEnabled(this.debug); this.render(); } }, t("header.debug")),
        h("button", { type: "button", onclick: () => { this.logOpen = false; this.render(); }, title: t("card.close") }, "×")),
        !this.debug ? this.renderLogReplaySection(s) : null,
        this.debug ? debugLogList(s) : this.renderUnifiedLog(s)) : null,
    );

    const panel = this.playPanel(s, interaction);
    this.el.classList.toggle("withpanelmin", this.minimized.has("play"));
    const buildMenu = () => {
      if (!this.menu) return [];
      // 盤面に無い選択肢のメニューには、決定・パスなどのボタンも入れる（メニューが見出しの盤面の操作に重なっても答えられるように）
      const foot = this.menu.soft && interaction && s.phase === "playing" ? this.decisionButtons(s, interaction) : [];
      return optionMenu(this.menu, this.selected, foot, (o) => this.choose(o, interaction, true),
        interaction?.decision.kind === "PRIORITY" ? (o) => this.choose(o, interaction) : null,
        () => { this.closeMenu(); this.render(); });
    };

    patchChildren(this.el, header, main, panel, ...(detail ? [detail] : []), ...buildMenu());
    if (!this.menu && interaction) {
      this.computeAutoMenu(interaction);
      if (this.menu) this.el.append(...buildMenu());
    }
    if (this.menu) fitMenu(this.el.querySelector<HTMLElement>(".menu"), this.menu);
    // 対象を選んでいる間は、スタックのその呪文・能力からカーソルへ矢印を出す（おまかせで対象が自動で決まるときは出さない）
    const autoTarget = this.macro && !this.macro.targetUsed && !!this.macro.targetKey;
    if (targeting?.aiming && !autoTarget) (this.arrow ??= new TargetArrow()).setOrigin(this.el.querySelector<HTMLElement>(".stackbox [data-targeting]"));
    else this.dropArrow();
    // 小窓は見出しのドラッグで動かせる（位置は小窓ごとに覚える）。手札は扇に整える
    for (const [sel, key] of [[".cdetail", "detail"], [".stackbox", "stack"], [".combatbox", "combat"]] as const) {
      const f = this.el.querySelector<HTMLElement>(sel);
      if (f) setupFloat(f, key);
    }
    fitHands(this.el);
    const hand = this.el.querySelector<HTMLElement>(".hand");
    if (hand) hand.scrollLeft = scroll;
    const log = this.el.querySelector<HTMLElement>(".log");
    if (log) {
      if (this.debug) {
        if (stickLog) log.scrollTop = log.scrollHeight;
      } else {
        if (prevLogScrollTop !== null) log.scrollTop = prevLogScrollTop;
        if (s.stepLogs.length !== this.lastStepCount) {
          this.lastStepCount = s.stepLogs.length;
          const curEl = log.querySelector<HTMLElement>(".logstep.cur");
          if (curEl) {
            const top = curEl.offsetTop - log.offsetTop;
            const bottom = top + curEl.offsetHeight;
            if (top < log.scrollTop) {
              log.scrollTop = Math.max(0, top - 8);
            } else if (bottom > log.scrollTop + log.clientHeight) {
              log.scrollTop = bottom - log.clientHeight + 12;
            }
          }
        }
      }
    }
  }

  /** 盤面の上に浮かぶ小窓（見出しの「–」で畳む） */
  private floatBox(key: string, title: string, body: HTMLElement): HTMLElement {
    const min = this.minimized.has(key);
    return h(`div.float.${key}box` + (min ? ".min" : ""), null,
      h("div.fhead", null, h("span", null, title),
        h("button", { type: "button", title: t("panel.min"), "aria-expanded": String(!min),
          onclick: () => { min ? this.minimized.delete(key) : this.minimized.add(key); this.render(); } }, min ? "+" : "–")),
      h("div.fbody", null, body));
  }

  /** 操作パネル（mtgtable の「p1 として操作」）。広い画面では右下に浮かせ、狭い画面では下に固定する */
  private playPanel(s: SessionState, i: Interaction | null): HTMLElement {
    const min = this.minimized.has("play");
    return h("div.float.playpanel" + (min ? ".min" : ""), { "data-phase": s.phase },
      h("div.fhead", null, h("span", null, t("panel.play")),
        h("button", { type: "button", title: t("panel.min"), "aria-expanded": String(!min),
          onclick: () => { min ? this.minimized.delete("play") : this.minimized.add("play"); this.render(); } }, min ? "+" : "–")),
      this.actionPanel(s, i));
  }

  /** 操作パネルの中身（いま求められている選択） */
  private actionPanel(s: SessionState, i: Interaction | null): HTMLElement {
    const bar = h("div.fbody.actions", { "data-phase": s.phase });
    switch (s.phase) {
      case "idle":
      case "loading":
        bar.append(h("div.prompt", null, h("span.spin"), this.engineStatus === "ready" ? t("status.loading") : t("status.preparing", { status: statusText(this.engineStatus) })));
        break;
      case "busy":
        bar.append(h("div.prompt", null, h("span.spin"), t("status.busy")));
        break;
      case "finished": {
        const cleared = s.verdict.result === "CLEARED";
        bar.classList.add(cleared ? "cleared" : "failed");
        bar.append(h("div.result", null, verdictText(s.verdict)),
          h("div.btns", null,
            h("button.on.big", { type: "button", onclick: () => { this.stopReplay(); void this.session.reset(); } }, t("action.again")),
            this.opts.onNewHand
              ? h("button.big", { type: "button", "data-action": "new-hand", onclick: () => { this.stopReplay(); this.opts.onNewHand?.(); } }, t("playtest.newHand"))
              : null,
            h("button.big", { type: "button", onclick: () => this.onBack() }, t(this.opts.toBackKey))));
        if (cleared && s.puzzle) {
          const hasSteps = s.solutionSteps.length > 0;
          const isSameRegistered = hasSteps && this.isSameSteps(this.registeredSolution, s.solutionSteps);
          bar.append(
            h("div.solcleared", null,
              h("button.on", {
                type: "button",
                "data-action": "sns-share-clear",
                title: t("sns.btn.clear.title"),
                onclick: () => this.openSnsShare("clear"),
              }, t("sns.btn.clear")),
              hasSteps
                ? h("button" + (isSameRegistered ? ".on" : ""), {
                    type: "button",
                    "data-action": "register-solution",
                    onclick: () => this.registerSolution(s.solutionSteps),
                  }, t(isSameRegistered ? "solution.registered" : "solution.register", { n: s.solutionSteps.length }))
                : null,
              hasSteps
                ? h("button", {
                    type: "button",
                    "data-action": "share-solution",
                    onclick: () => void this.shareSolution(s.solutionSteps),
                  }, t("solution.share"))
                : null,
            ),
          );
        }
        break;
      }
      case "error":
        bar.classList.add("error");
        bar.append(h("div.result", null, t("status.cannotContinue")),
          h("ul.errors", null, s.errors.map((e) => h("li", null, e))),
          h("div.btns", null,
            s.puzzle ? h("button.on.big", { type: "button", onclick: () => void this.session.reset() }, t("action.reset")) : null,
            h("button.big", { type: "button", onclick: () => location.reload() }, t("action.reload")),
            h("button.big", { type: "button", onclick: () => this.onBack() }, t(this.opts.toBackKey))));
        break;
      case "playing":
        if (i) this.decisionBar(bar, s, i);
        break;
    }
    if (s.notice) bar.prepend(h("div.notice", null, s.notice));
    if (this.macro && (s.phase === "playing" || s.phase === "busy")) {
      bar.prepend(h("div.quick", null, h("span", null, t("quick.running", { card: displayName(this.names.get(this.macro.cardId) ?? "") })),
        h("button", { type: "button", onclick: () => { this.macro = null; this.render(); } }, t("quick.stop"))));
    }
    if (this.solutionOpen) {
      bar.append(this.renderSolutionSection(s));
    }
    const desc = s.puzzle && puzzleDescription(s.puzzle);
    if (desc) bar.prepend(h("details.pdesc", null, h("summary", null, puzzleTitle(s.puzzle!)), h("div.muted", null, desc)));
    return bar;
  }

  private decisionBar(bar: HTMLElement, s: SessionState, i: Interaction) {
    bar.append(h("div.prompt", null, manaNodes(decisionPrompt(i.decision))));
    // 盤面に無い選択肢（モード・数・見えない領域のカード）はここに並べる
    if (i.listed.length) {
      const list = h("div.listed");
      for (const o of i.listed) {
        const on = this.selected.has(o.id);
        list.append(h("button.opt" + (on ? ".on" : ""), { type: "button", "data-option": o.id, onclick: () => this.choose(o, i) }, manaNodes(optionLabel(o))));
      }
      bar.append(list);
    }
    bar.append(h("div.btns", null, this.decisionButtons(s, i)));
  }

  /** 決定（複数を選ぶとき）と、パス・自動で支払う・取りやめ・はい・いいえのボタン */
  private decisionButtons(s: SessionState, i: Interaction): HTMLElement[] {
    const d = i.decision;
    const view = s.step!.view;
    const btns: HTMLElement[] = [];
    if (!i.single && d.kind !== "PRIORITY") {
      const n = this.selected.size;
      const ok = n >= d.min && n <= d.max;
      const label = d.kind === "ATTACKERS" ? (n ? t("action.attackN", { n }) : t("action.noAttack")) : t("action.confirm", { n });
      btns.push(h("button.on.big", { type: "button", "data-confirm": "1", disabled: !ok, onclick: () => this.send([...this.selected]) }, label));
      if (n) btns.push(h("button", { type: "button", "data-clear": "1", onclick: () => { this.selected.clear(); this.render(); } }, t("action.clear")));
    }
    for (const o of i.specials) {
      const value = o.ref?.type === "special" ? o.ref.value : "";
      const text = value === "pass" ? passLabel(view.phase, view.stack.length) : optionLabel(o);
      const ic: IconName | null = value === "pass" ? passIcon(view.phase, view.stack.length) : null;
      btns.push(h("button.big" + (value === "pass" || value === "yes" ? ".on" : ""), {
        type: "button", "data-special": value, title: value === "cancel" ? t("board.cancel.title") : null, onclick: () => this.send([o.id]),
      }, ic ? icon(ic) : null, manaNodes(text)));
    }
    return btns;
  }

  // ---------------------------------------------------------------- 入力

  private onCard(c: CardView, i: Interaction | null) {
    const opts = i?.onBoard.get(c.instanceId);
    if (!i || !opts) {
      this.detail = c;
      this.render();
      return;
    }
    this.pick(opts, i, c.instanceId, c);
  }

  private onPlayer(id: string, i: Interaction | null) {
    const opts = i?.onBoard.get(id);
    if (i && opts) this.pick(opts, i, id);
  }

  /** 1 つの盤面の要素に複数の選択肢があればメニューを出す */
  private pick(opts: Option[], i: Interaction, key: string, card?: CardView) {
    if (this.menu?.locked) return; // 色を選ぶまでは、ほかのカードを押しても変えない
    // 起動型能力・マナ能力は、1 つしか無くてもメニューから選ぶ（単一マナしか出ず他の起動効果もない土地は、タップでそのままマナを出す）
    const activated = i.decision.kind === "PRIORITY"
      && opts.some((o) => o.ref?.type === "ability" && (o.ref.abilityKind === "activated" || o.ref.abilityKind === "mana"))
      && !isDirectManaLand(card, opts);
    if (opts.length === 1 && !activated) {
      this.choose(opts[0], i);
      return;
    }
    const el = this.el.querySelector<HTMLElement>(`[data-id="${CSS.escape(key)}"], [data-player="${CSS.escape(key)}"]`);
    const r = el?.getBoundingClientRect();
    this.menu = { x: r ? r.left : 20, y: r ? r.bottom + 4 : 80, options: opts, locked: false, soft: false, title: null };
    this.render();
  }

  /**
   * 盤面で押せない選択は、選んでいる呪文・能力の近くに自分でメニューを出す（操作パネルを見なくても答えられるように）。
   * - 色の問い合わせ: 能力の持ち主のカードの上に色の記号。取りやめられないので、外を押しても閉じない
   * - 盤面に無い選択肢（モード・X の値・見えない領域のカードなど）: 下に幕を敷かないメニュー（盤面のカードも押せる）。
   *   × か Esc で閉じれば、その選択要求の間は開き直さない（盤面の操作の「選択肢」で開き直す）
   */
  private computeAutoMenu(i: Interaction | null) {
    if (this.menu || !i || this.session.state.phase !== "playing") return;
    const d = i.decision;
    const title = decisionPrompt(d);
    if (isColorAsk(d)) {
      const key = d.options[0].ref?.type === "color" ? d.options[0].ref.cardId : null;
      this.menu = { ...this.menuAnchor(key ? [key] : []), options: d.options, locked: true, soft: false, title };
    } else {
      if (!this.orderStack && !this.replay && d.promptKey === "orderSimultaneous") return;
      const options = autoListed(i);
      if (!options.length || this.menuDismissed === d.seq) return;
      const view = this.session.state.step!.view;
      const casting = view.players.flatMap((p) => p.cards).filter((c) => c.zone === "Stack").map((c) => c.instanceId);
      const ids = [d.source, this.casting?.cardId, this.resolving?.sourceId, ...casting, view.stack[0]?.sourceId].filter((x): x is string => !!x);
      this.menu = { ...this.menuAnchor(ids), options, locked: false, soft: true, title };
    }
  }

  /**
   * メニューを出す所: ids の順に、盤面（スタックの小窓を含む）に見えているカード・スタックの項目の下（入らなければ上）。
   * どれも無ければ盤面の真ん中
   */
  private menuAnchor(ids: string[]): { x: number; y: number; above?: number } {
    for (const id of ids) {
      const sel = `.board [data-id="${CSS.escape(id)}"], .board [data-source="${CSS.escape(id)}"]`;
      for (const el of this.el.querySelectorAll<HTMLElement>(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width && r.height) return { x: r.left, y: r.bottom + 4, above: r.top - 4 };
      }
    }
    const b = this.el.querySelector<HTMLElement>(".board")?.getBoundingClientRect();
    return b ? { x: b.left + b.width / 2 - 160, y: b.top + b.height * 0.3 } : { x: 20, y: 80 };
  }

  private closeMenu() {
    if (this.menu?.soft) this.menuDismissed = this.decisionSeq;
    this.menu = null;
  }

  private choose(o: Option, i: Interaction | null, stackOnly = false) {
    if (!i) {
      this.menu = null;
      return;
    }
    if (!stackOnly && i.decision.kind === "PRIORITY" && !this.holdStack
      && o.ref?.type === "ability" && (o.ref.abilityKind === "spell" || o.ref.abilityKind === "activated")) {
      this.startQuick(o.ref.cardId, null, o.id);
      return;
    }
    if (i.single || (i.decision.kind === "CHOOSE_MODE" && i.decision.max === 1)) {
      this.send([o.id]);
      return;
    }
    if (!this.menu?.soft) this.menu = null;
    if (this.selected.has(o.id)) this.selected.delete(o.id);
    else if (this.selected.size < i.decision.max) this.selected.add(o.id);
    this.render();
  }

  /** 対象選択中・唱えている途中（支払いなど）・解決の選択待ちの項目をスタックに出すための情報 */
  private currentTargeting(d: Decision | null, phase: SessionState["phase"]): Targeting | null {
    if (!d || d.kind === "PRIORITY") return null;
    const direct = targetingOf(d);
    if (direct) {
      return {
        ...direct,
        targets: this.casting?.cardId === direct.cardId ? this.casting.targets : [],
        aiming: phase === "playing",
      };
    }
    if (this.casting) {
      const text = localized(this.casting.desc.replace(/\s*\(\d+\)/g, ""), this.casting.descJa) || t("stack.casting");
      return { cardId: this.casting.cardId, text, targets: this.casting.targets, aiming: false };
    }
    if (this.resolving) {
      const it = this.resolving;
      const text = localized(it.description.replace(/\s*\(\d+\)/g, ""), it.descriptionJa);
      return { cardId: it.sourceId, text, targets: it.targets, aiming: false };
    }
    return null;
  }

  private send(ids: string[]) {
    const s = this.session.state;
    const d = s.step?.pending;
    if (d?.kind === "PRIORITY") {
      const o = d.options.find((x) => ids.includes(x.id));
      const isCastOrAct = o?.ref?.type === "ability" && (o.ref.abilityKind === "spell" || o.ref.abilityKind === "activated");
      this.activating = o?.ref?.type === "ability" && o.ref.abilityKind !== "mana" ? o.ref.cardId : null;
      if (isCastOrAct && o.ref?.type === "ability") {
        const after = (str: string) => (str.includes(" | ") ? str.slice(str.indexOf(" | ") + 3).trim() : str);
        this.casting = { cardId: o.ref.cardId, desc: after(o.label), descJa: o.labelJa ? after(o.labelJa) : null, targets: [] };
      } else {
        this.casting = null;
      }
      const top = s.step?.view.stack[0] ?? null;
      this.resolving = o?.ref?.type === "special" && o.ref.value === "pass" ? top : null;
      this.promptedTriggers.clear();
    } else if (d?.options.some((x) => ids.includes(x.id) && x.ref?.type === "special" && x.ref.value === "cancel")) {
      this.activating = null;
      this.casting = null;
    } else if (d?.kind === "TARGETS") {
      const picked: string[] = [];
      for (const id of ids) {
        const o = d.options.find((x) => x.id === id);
        if (o?.ref?.type === "card") picked.push(o.ref.cardId);
        else if (o?.ref?.type === "player") picked.push(o.ref.player);
      }
      if (picked.length && this.casting && (!d.source || d.source === this.casting.cardId)) {
        for (const t of picked) if (!this.casting.targets.includes(t)) this.casting.targets.push(t);
      }
    }
    this.selected.clear();
    this.menu = null;
    void this.session.answer(ids);
  }

  // ---------------------------------------------------------------- 解答手順の登録・公開・再生

  private puzzleStorageKey(): string {
    const p = this.session.state.puzzle;
    if (p?.goal.deadline === "none" || this.puzzleId.startsWith("playtest-")) {
      const handSig = (p?.game.players[0]?.hand ?? []).map((c) => c.cardId).join(",");
      return `${this.puzzleId}:${handSig}`;
    }
    if (this.puzzleId && this.puzzleId !== "shared" && this.puzzleId !== "editor-test") {
      return this.puzzleId;
    }
    const title = p?.title?.trim();
    return title ? `custom:${title}` : this.puzzleId;
  }

  private isSameSteps(a: SolutionStep[] | null | undefined, b: SolutionStep[] | null | undefined): boolean {
    if (!a || !b || a.length !== b.length) return false;
    return a.every((s, i) => s.kind === b[i].kind && s.labels.join("|") === b[i].labels.join("|"));
  }

  private isStepEqual(a: SolutionStep | undefined, b: SolutionStep | undefined): boolean {
    if (!a || !b) return false;
    return a.kind === b.kind && a.labels.join("|") === b.labels.join("|");
  }

  private isPrefixSteps(prefix: SolutionStep[], full: SolutionStep[]): boolean {
    if (prefix.length > full.length) return false;
    return prefix.every((st, idx) => this.isStepEqual(st, full[idx]));
  }

  /**
   * 統合ログに表示する全手番（#1..#M）を組み立てる。
   * - 1..curCount 手目は常に実行済みの s.stepLogs
   * - それ以降は Undo 後の s.futureSteps、または現在と一致する共有・登録・公開済み公式解答の残り手番を繋げる
   */
  private timelineEntries(s: SessionState): SessionLogStep[] {
    const executed = s.stepLogs;
    const executedSteps = executed.map((e) => e.step);

    if (this.replay && this.isPrefixSteps(executedSteps, this.replay.steps)) {
      const rest = this.replay.steps.slice(executed.length).map((step, idx) => {
        const f = s.futureSteps[idx];
        return f && this.isStepEqual(f.step, step) ? f : { step, optionIds: [], events: [] };
      });
      return [...executed, ...rest];
    }

    if (s.futureSteps.length > 0) {
      return [...executed, ...s.futureSteps];
    }

    const candidates: (SolutionStep[] | null)[] = [
      this.sharedSolution,
      this.registeredSolution,
      this.bundledRevealed ? this.bundledSolution : null,
    ];
    for (const cand of candidates) {
      if (cand && cand.length > executed.length && this.isPrefixSteps(executedSteps, cand)) {
        const rest = cand.slice(executed.length).map((step) => ({ step, optionIds: [], events: [] }));
        return [...executed, ...rest];
      }
    }

    return [...executed];
  }

  private async jumpToStep(targetCount: number, externalSteps?: SolutionStep[]) {
    const s = this.session.state;
    if (s.phase === "loading" || s.phase === "busy" || s.phase === "idle" || s.phase === "error") return;
    this.stopReplay();
    this.macro = null;
    this.replayError = null;
    const curCount = s.stepLogs.length;
    const isSingleStepForward = targetCount === curCount + 1 && s.phase === "playing";
    this.seeking = !isSingleStepForward;
    try {
      const ok = await this.session.seekTo(targetCount, externalSteps);
      if (!ok && this.session.state.notice) {
        this.replayError = this.session.state.notice;
      }
    } finally {
      this.seeking = false;
      this.render();
    }
  }

  private activeSolution(s: SessionState): { source: "shared" | "registered" | "recorded" | "bundled"; steps: SolutionStep[] } | null {
    if (this.sharedSolution && this.sharedSolution.length > 0) {
      return { source: "shared", steps: this.sharedSolution };
    }
    if (this.registeredSolution && this.registeredSolution.length > 0) {
      return { source: "registered", steps: this.registeredSolution };
    }
    if (s.verdict.result === "CLEARED" && s.solutionSteps.length > 0) {
      return { source: "recorded", steps: s.solutionSteps };
    }
    if (this.bundledSolution && this.bundledSolution.length > 0) {
      return { source: "bundled", steps: this.bundledSolution };
    }
    if (s.solutionSteps.length > 0) {
      return { source: "recorded", steps: s.solutionSteps };
    }
    return null;
  }

  private getCurrentBoardPuzzle(): PuzzleJson | null {
    const s = this.session.state;
    if (!s.puzzle) return null;
    const view = s.step?.view;
    return view ? snapshotPuzzleFromView(s.puzzle, view) : s.puzzle;
  }

  private async shareBoard(useCurrentView: boolean) {
    const s = this.session.state;
    if (!s.puzzle) return;
    const targetPuzzle = useCurrentView ? (this.getCurrentBoardPuzzle() ?? s.puzzle) : s.puzzle;
    try {
      const url = await buildShareUrl(targetPuzzle, "play");
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // クリップボード権限がない環境でも続行
      }
      const toastKey = useCurrentView ? "solution.board.sharedCurrentToast" : "solution.board.sharedInitialToast";
      this.solutionFeedback = { text: t(toastKey, { n: url.length }), isError: false };
      this.solutionOpen = true;
      this.render();
    } catch (e) {
      this.solutionFeedback = { text: String(e), isError: true };
      this.solutionOpen = true;
      this.render();
    }
  }

  private openCurrentBoardInEditor() {
    const snap = this.getCurrentBoardPuzzle();
    if (!snap || !this.opts.onOpenEditor) return;
    this.stopReplay();
    this.opts.onOpenEditor(snap);
  }

  private openSnsShare(shareKind: SnsShareKind) {
    const s = this.session.state;
    if (!s.puzzle) return;
    const steps = s.solutionSteps.length > 0 ? s.solutionSteps : (this.activeSolution(s)?.steps ?? null);
    openSnsShareDialog({
      puzzleId: this.puzzleId,
      puzzle: s.puzzle,
      initialView: previewView(s.puzzle),
      currentView: s.step?.view ?? null,
      shareKind,
      steps,
    });
  }

  private registerSolution(steps: SolutionStep[]) {
    if (!steps.length) return;
    const copy = steps.map((s) => ({ kind: s.kind, indexes: [...s.indexes], labels: [...s.labels] }));
    saveRegisteredSolution(this.puzzleStorageKey(), copy);
    this.registeredSolution = copy;
    if (this.session.state.puzzle) {
      this.session.state.puzzle.solution = copy;
    }
    this.opts.onRegisterSolution(copy);
    this.solutionFeedback = { text: t("solution.registeredToast", { n: copy.length }), isError: false };
    this.solutionOpen = true;
    this.render();
  }

  private deleteSolution() {
    deleteRegisteredSolution(this.puzzleStorageKey());
    this.registeredSolution = null;
    if (this.session.state.puzzle) {
      delete this.session.state.puzzle.solution;
    }
    this.opts.onRegisterSolution([]);
    this.solutionFeedback = null;
    this.render();
  }

  private async shareSolution(steps: SolutionStep[]) {
    const p = this.session.state.puzzle;
    if (!p || !steps.length) return;
    // 公開する手順がまだ未登録なら端末にも登録しておく
    if (!this.registeredSolution) {
      const copy = steps.map((s) => ({ kind: s.kind, indexes: [...s.indexes], labels: [...s.labels] }));
      saveRegisteredSolution(this.puzzleStorageKey(), copy);
      this.registeredSolution = copy;
      p.solution = copy;
      this.opts.onRegisterSolution(copy);
    }
    try {
      const url = await buildSolutionShareUrl({ puzzleId: this.puzzleId, puzzle: p, steps });
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        // クリップボード権限がない環境でも続行
      }
      this.solutionFeedback = { text: t("solution.sharedToast", { n: url.length }), isError: false };
      this.solutionOpen = true;
      this.render();
    } catch (e) {
      this.solutionFeedback = { text: String(e), isError: true };
      this.solutionOpen = true;
      this.render();
    }
  }

  private canContinueReplay(s: SessionState, steps: SolutionStep[]): boolean {
    if (s.phase !== "playing" || s.solutionSteps.length >= steps.length) return false;
    for (let i = 0; i < s.solutionSteps.length; i++) {
      const a = s.solutionSteps[i];
      const b = steps[i];
      if (a.kind !== b.kind || a.labels.join("|") !== b.labels.join("|")) return false;
    }
    return true;
  }

  private startReplay(steps: SolutionStep[], auto: boolean) {
    if (!steps.length) return;
    if (this.bundledSolution && this.isSameSteps(steps, this.bundledSolution)) {
      this.bundledRevealed = true;
    }
    this.macro = null;
    this.solutionFeedback = null;
    this.replayError = null;
    this.logOpen = true;
    const s = this.session.state;
    if (!auto) {
      const nextTarget = this.canContinueReplay(s, steps) ? s.stepLogs.length + 1 : 1;
      void this.jumpToStep(nextTarget, steps);
      return;
    }
    if (this.canContinueReplay(s, steps)) {
      this.replay = { steps, index: s.solutionSteps.length, auto: true, timer: 0 };
      this.render();
      this.stepReplayOnce();
      return;
    }
    this.replay = { steps, index: 0, auto: true, timer: 0, stepOnceAfterReset: false, resetting: true };
    this.render();
    void this.session.seekTo(0, steps);
  }

  private stopReplay() {
    if (!this.replay) return;
    window.clearTimeout(this.replay.timer);
    this.replay = null;
  }

  private scheduleReplayStep(delayMs: number) {
    if (!this.replay || !this.replay.auto) return;
    window.clearTimeout(this.replay.timer);
    this.replay.timer = window.setTimeout(() => {
      this.stepReplayOnce();
    }, delayMs);
  }

  private stepReplayOnce() {
    const r = this.replay;
    const s = this.session.state;
    if (!r || s.phase !== "playing" || !s.step?.pending) return;
    window.clearTimeout(r.timer);
    if (r.index >= r.steps.length) {
      this.stopReplay();
      this.render();
      return;
    }
    const step = r.steps[r.index];
    const ids = matchSolutionStep(s.step.pending, step);
    if (!ids) {
      this.stopReplay();
      this.replayError = t("solution.replayMismatch");
      this.logOpen = true;
      this.render();
      return;
    }
    r.index++;
    this.send(ids);
  }

  /** Log 画面の手番操作バー（最初へ・1手戻す・1手進める・自動再生） */
  private renderLogReplaySection(s: SessionState): HTMLElement {
    const busy = s.phase === "loading" || s.phase === "busy";
    const entries = this.timelineEntries(s);
    const timelineSteps = entries.map((e) => e.step);
    const curCount = s.stepLogs.length;
    const totalSteps = entries.length;
    const active = this.activeSolution(s);
    const box = h("div.logreplay");

    if (this.replayError) {
      box.append(h("div.solnote.err", null, this.replayError));
    }

    if (this.replay && (s.phase === "playing" || s.phase === "busy" || s.phase === "loading")) {
      const curIdx = Math.min(this.replay.index, this.replay.steps.length - 1);
      const stepText = curIdx >= 0 && this.replay.steps[curIdx]
        ? formatSolutionStep(this.replay.steps[curIdx], (n) => displayName(n))
        : "";
      const statusMsg = t(this.replay.auto ? "solution.replaying" : "solution.replayPaused", {
        cur: Math.min(this.replay.index + 1, this.replay.steps.length),
        total: this.replay.steps.length,
        step: stepText,
      });
      box.append(
        h("div.quick.replaybar", null,
          h("span", null, statusMsg),
          h("div.rbtns", null,
            this.replay.auto
              ? h("button", {
                  type: "button",
                  "data-action": "replay-pause",
                  onclick: () => {
                    if (!this.replay) return;
                    window.clearTimeout(this.replay.timer);
                    this.replay.auto = false;
                    this.render();
                  },
                }, t("solution.replayPause"))
              : h("button.on", {
                  type: "button",
                  "data-action": "replay-resume",
                  onclick: () => {
                    if (!this.replay) return;
                    this.replay.auto = true;
                    this.render();
                    this.scheduleReplayStep(0);
                  },
                }, t("solution.replayResume")),
            h("button", {
              type: "button",
              "data-action": "replay-stop",
              onclick: () => { this.stopReplay(); this.render(); },
            }, t("solution.replayStop")),
          ),
        ),
      );
    }

    const replayTargetSteps = timelineSteps.length > 0 ? timelineSteps : (active?.steps ?? []);
    const canUndo = !busy && curCount > 0;
    const canStepForward = !busy && (curCount < totalSteps || (totalSteps === 0 && !!active));
    const canAutoReplay = !busy && replayTargetSteps.length > 0;

    let subSourceLabel: string | null = null;
    if (active && (active.source === "shared" || active.source === "registered" || (active.source === "bundled" && this.bundledRevealed))) {
      if (this.isSameSteps(timelineSteps, active.steps)) {
        subSourceLabel = t(`solution.source.${active.source}` as MessageKey, { n: active.steps.length });
      }
    }

    box.append(
      h("div.solhead", null,
        h("div.solpos", null,
          h("strong.solsrc", null, t("log.position", { cur: curCount, total: totalSteps })),
          subSourceLabel ? h("span.muted.solsub", null, subSourceLabel) : null,
        ),
        h("div.solbtns", null,
          h("button", {
            type: "button",
            "data-action": "seek-start",
            disabled: !canUndo,
            title: t("log.seekStart.title"),
            onclick: () => void this.jumpToStep(0, timelineSteps),
          }, t("log.seekStart")),
          h("button", {
            type: "button",
            "data-action": "undo-step",
            disabled: !canUndo,
            title: t("log.undo.title"),
            onclick: () => void this.jumpToStep(curCount - 1, timelineSteps),
          }, t("log.undo")),
          h("button", {
            type: "button",
            "data-action": "replay-step",
            disabled: !canStepForward,
            title: t("log.redo.title"),
            onclick: () => {
              if (curCount < totalSteps) {
                void this.jumpToStep(curCount + 1, timelineSteps);
              } else if (active) {
                this.startReplay(active.steps, false);
              }
            },
          }, t("solution.replayStep")),
          h("button" + (canAutoReplay && !this.replay?.auto ? ".on" : ""), {
            type: "button",
            "data-action": "replay-auto",
            disabled: !canAutoReplay,
            onclick: () => this.startReplay(replayTargetSteps, true),
          }, t("solution.replayAuto")),
        ),
      ),
    );

    if (this.bundledSolution && this.bundledSolution.length > 0 && !this.bundledRevealed && totalSteps === 0) {
      box.append(
        h("div.solcur", null,
          h("button", {
            type: "button",
            "data-action": "load-bundled",
            disabled: busy,
            onclick: () => {
              this.bundledRevealed = true;
              this.render();
            },
          }, t("log.loadBundled", { n: this.bundledSolution.length })),
        ),
      );
    } else if (active && active.source !== "recorded" && totalSteps > 0 && !this.isSameSteps(timelineSteps, active.steps)) {
      const savedLabel = t(`solution.source.${active.source}` as MessageKey, { n: active.steps.length });
      box.append(
        h("div.solcur", null,
          h("span.solsrc", null, savedLabel),
          h("div.solbtns", null,
            h("button", {
              type: "button",
              "data-action": "replay-saved-auto",
              disabled: busy,
              onclick: () => this.startReplay(active.steps, true),
            }, t("solution.replayAuto")),
            h("button", {
              type: "button",
              "data-action": "replay-saved-step",
              disabled: busy,
              onclick: () => {
                this.bundledRevealed = true;
                void this.jumpToStep(0, active.steps);
              },
            }, t("log.seekStart")),
          ),
        ),
      );
    } else if (totalSteps === 0 && !active) {
      box.append(h("div.muted.solnote", null, t("log.replay.empty")));
    }

    return box;
  }

  /** 手順と出来事（Log）を統合したタイムライン。各手番をクリックするとその位置へ移動できる */
  private renderUnifiedLog(s: SessionState): HTMLElement {
    const busy = s.phase === "loading" || s.phase === "busy";
    const entries = this.timelineEntries(s);
    const timelineSteps = entries.map((e) => e.step);
    const curCount = s.stepLogs.length;
    const formatEv = (e: GameEvent) => eventText(e, (id) => displayName(this.names.get(id) ?? id), VIEWER);

    const initLines = s.initialEvents.map(formatEv).filter((x): x is string => !!x);
    const isAtInit = curCount === 0;
    const canClickInit = !isAtInit && !busy;

    const nodes: HTMLElement[] = [
      h(
        "div.logstep.init" + (isAtInit ? ".cur" : ".done") + (canClickInit ? ".clickable" : ""),
        {
          "data-step-index": "0",
          title: canClickInit ? t("log.jumpHere") : null,
          onclick: () => {
            if (canClickInit) void this.jumpToStep(0, timelineSteps);
          },
        },
        h(
          "div.stephead",
          null,
          h("span.stepnum", null, "#0"),
          h("span.steplabel", null, t("log.step0")),
          isAtInit
            ? h("span.stepcur", null, t("log.here"))
            : h("span.stepjump", null, t("log.jumpHere")),
        ),
        initLines.length
          ? h(
              "div.stepevs",
              null,
              initLines.map((l) => h("div.ev" + (l.startsWith("──") ? ".turnline" : ""), null, l)),
            )
          : null,
      ),
    ];

    entries.forEach((entry, idx) => {
      const stepNum = idx + 1;
      const isCur = stepNum === curCount;
      const isDone = stepNum < curCount;
      const stateCls = isCur ? ".cur" : isDone ? ".done" : ".future";
      const canClick = !isCur && !busy;
      const labelText = formatSolutionStep(entry.step, (n) => displayName(n));
      const evLines = entry.events.map(formatEv).filter((x): x is string => !!x);

      nodes.push(
        h(
          "div.logstep" + stateCls + (canClick ? ".clickable" : ""),
          {
            "data-step-index": String(stepNum),
            title: canClick ? t("log.jumpHere") : null,
            onclick: () => {
              if (canClick) void this.jumpToStep(stepNum, timelineSteps);
            },
          },
          h(
            "div.stephead",
            null,
            h("span.stepnum", null, `#${stepNum}`),
            h("span.steplabel", null, manaNodes(labelText)),
            isCur
              ? h("span.stepcur", null, t("log.here"))
              : h("span.stepjump", null, t("log.jumpHere")),
          ),
          evLines.length
            ? h(
                "div.stepevs",
                null,
                evLines.map((l) => h("div.ev" + (l.startsWith("──") ? ".turnline" : ""), null, l)),
              )
            : null,
        ),
      );
    });

    return h("div.log.unified", null, ...nodes);
  }

  private renderSolutionSection(s: SessionState): HTMLElement {
    const isPlaytest = s.puzzle?.goal.deadline === "none";
    const busy = s.phase === "loading" || s.phase === "busy";
    const active = this.activeSolution(s);
    const box = h("div.solbox");
    if (this.solutionFeedback) {
      box.append(h("div.solnote" + (this.solutionFeedback.isError ? ".err" : ".ok"), null, this.solutionFeedback.text));
    }
    if (s.puzzle) {
      box.append(
        h("div.solboard", null,
          h("strong.solsrc", null, t("solution.board.title")),
          h("div.solbtns", null,
            h("button.on", {
              type: "button",
              "data-action": "sns-share-board",
              disabled: busy,
              title: t(isPlaytest ? "sns.btn.playtest.title" : "sns.btn.puzzle.title"),
              onclick: () => this.openSnsShare(s.verdict.result === "CLEARED" ? "clear" : isPlaytest ? "playtest" : "puzzle"),
            }, t(s.verdict.result === "CLEARED" ? "sns.btn.clear" : isPlaytest ? "sns.btn.playtest" : "sns.btn.puzzle")),
            h("button", {
              type: "button",
              "data-action": "share-current-board",
              disabled: busy,
              title: t("solution.board.shareCurrent.title"),
              onclick: () => void this.shareBoard(true),
            }, t("solution.board.shareCurrent")),
            h("button", {
              type: "button",
              "data-action": "share-initial-board",
              disabled: busy,
              title: t("solution.board.shareInitial.title"),
              onclick: () => void this.shareBoard(false),
            }, t("solution.board.shareInitial")),
            this.opts.onOpenEditor
              ? h("button", {
                  type: "button",
                  "data-action": "edit-current-board",
                  disabled: busy,
                  title: t("solution.board.editCurrent.title"),
                  onclick: () => this.openCurrentBoardInEditor(),
                }, t("solution.board.editCurrent"))
              : null,
          ),
        ),
      );
    }
    if (!active) {
      box.append(h("div.muted.solnote", null, t(isPlaytest ? "solution.emptyPlaytest" : "solution.empty")));
      return box;
    }
    const { source, steps } = active;
    const isInProgressRecord = source === "recorded" && s.verdict.result !== "CLEARED";
    const sourceLabel = isInProgressRecord
      ? t("solution.source.inProgress", { n: steps.length })
      : t(`solution.source.${source}` as MessageKey, { n: steps.length });
    const hasDifferentCurrentSteps = s.solutionSteps.length > 0 && !this.isSameSteps(steps, s.solutionSteps);

    box.append(
      h("div.solhead", null,
        h("strong.solsrc", null, sourceLabel),
        h("div.solbtns", null,
          source === "recorded"
            ? h("button", {
                type: "button",
                "data-action": "register-solution",
                onclick: () => this.registerSolution(steps),
              }, t(isPlaytest ? "solution.registerSteps" : "solution.register", { n: steps.length }))
            : null,
          h("button", {
            type: "button",
            "data-action": "share-solution",
            onclick: () => void this.shareSolution(steps),
          }, t(isPlaytest ? "solution.shareSteps" : "solution.share")),
          source === "registered"
            ? h("button", {
                type: "button",
                "data-action": "delete-solution",
                onclick: () => this.deleteSolution(),
              }, t("solution.delete"))
            : null,
        ),
      ),
    );
    if (hasDifferentCurrentSteps) {
      box.append(
        h("div.solcur", null,
          h("span.solsrc", null, t("solution.currentStepsLabel", { n: s.solutionSteps.length })),
          h("div.solbtns", null,
            h("button", {
              type: "button",
              "data-action": "register-current-steps",
              onclick: () => this.registerSolution(s.solutionSteps),
            }, t(isPlaytest ? "solution.registerSteps" : "solution.register", { n: s.solutionSteps.length })),
            h("button", {
              type: "button",
              "data-action": "share-current-steps",
              onclick: () => void this.shareSolution(s.solutionSteps),
            }, t(isPlaytest ? "solution.shareSteps" : "solution.share")),
          ),
        ),
      );
    }
    return box;
  }
}

// ---------------------------------------------------------------- 部品

/** パスのボタンのアイコン（mtgtable の操作パネルと同じ: 解決・次へ・ターン終了） */
function passIcon(phase: GameView["phase"], stackSize: number): IconName {
  if (stackSize > 0) return "pass";
  return phase === "END_OF_TURN" ? "endTurn" : "next";
}

export function engineBadge(s: EngineStatus): HTMLElement {
  return h(`span.engine.${s}`, { title: t("engine.title") }, statusText(s));
}

function statusText(s: EngineStatus): string {
  return t(`engine.${s}` as MessageKey);
}

const DEBUG_KEY = "mtg-puzzle.debug";

function debugEnabled(): boolean {
  try { return localStorage.getItem(DEBUG_KEY) === "1"; } catch { return false; }
}

function setDebugEnabled(on: boolean): void {
  try { localStorage.setItem(DEBUG_KEY, on ? "1" : "0"); } catch { /* ignore */ }
}

function debugLineClass(l: string): string {
  if (l.startsWith("[Load]") || l.startsWith("[Submit]") || l.startsWith("[Reset]") || l.startsWith("[Restart")) return ".dbg-action";
  if (l.startsWith("[Step]")) return ".dbg-step";
  if (l.startsWith("[Decision")) return ".dbg-decision";
  if (l.startsWith("  [Option")) return ".dbg-option";
  if (l.startsWith("[GameLog:")) return ".dbg-gamelog";
  if (l.startsWith("[AdapterEvent]")) return ".dbg-adapter";
  if (l.startsWith("[Event]")) return ".dbg-event";
  if (l.startsWith("[Fallback]") || l.startsWith("[Error]") || l.startsWith("[ValidationError]") || l.startsWith("[RestartError]")) return ".dbg-warn";
  return "";
}

function debugLogList(s: SessionState): HTMLElement {
  const stateJson = s.step ? JSON.stringify({
    phase: s.phase,
    verdict: s.verdict,
    engine: s.step.engine,
    javaJudge: s.step.javaJudge,
    elapsedMs: s.step.elapsedMs,
    fallback: s.step.fallback,
    pending: s.step.pending,
    view: s.step.view,
  }, null, 2) : null;
  return h("div.log.debug", null,
    stateJson ? h("details.dbgstate", null, h("summary", null, t("log.debugState")), h("pre", null, stateJson)) : null,
    s.debugHistory.length
      ? s.debugHistory.map((l) => h("div.ev.dbgev" + debugLineClass(l), null, l))
      : h("div.muted", null, t("log.empty")),
  );
}

/**
 * 同じカードの選択肢のメニュー。外（下に敷いた透明の幕）を押すと閉じる。
 * スタックを使う能力・呪文の項目は 2 つに分かれた 1 つの行: 左（能力の文）を押すと起動して解決まで進め、
 * 右の「積む」はスタックに積むだけ（相手の対応を待つ・さらに積むとき）
 */
interface OptionMenu {
  x: number;
  y: number;
  /** 下に入らないときに、メニューの下の端を合わせる所（出した元の上の端） */
  above?: number;
  options: Option[];
  /** 取りやめられない選択（外を押しても閉じない） */
  locked: boolean;
  /** 盤面に無い選択肢を自分で出したもの: 幕を敷かず、見出しの × で閉じる */
  soft: boolean;
  /** 一番上に出す説明（色の問い合わせ・盤面に無い選択肢） */
  title: string | null;
}

/** 盤面に無い選択肢のうち、メニューに出すもの（優先権のときは出さない。色は色の問い合わせのメニューで出す） */
function autoListed(i: Interaction): Option[] {
  if (i.decision.kind === "PRIORITY") return [];
  return i.listed.filter((o) => o.ref?.type !== "color");
}

/** 描いたメニューが画面の下にはみ出すなら、出した元の上に出す（それでも入らなければ画面の上の端から） */
function fitMenu(el: HTMLElement | null, m: OptionMenu) {
  if (!el || m.above === undefined) return;
  const r = el.getBoundingClientRect();
  if (r.bottom <= window.innerHeight - 8) return;
  el.style.top = `${Math.max(8, Math.min(m.above - r.height, window.innerHeight - 8 - r.height))}px`;
}

function optionMenu(m: OptionMenu, selected: Set<string>, foot: HTMLElement[], choose: (o: Option) => void,
  quick: ((o: Option) => void) | null, close: () => void): HTMLElement[] {
  const x = Math.min(m.x, window.innerWidth - 328); // メニューの幅は最大 320px
  // 出した元が分かるときは、はみ出しを描いた後に直す（fitMenu）。分からなければ高さを見積もって収める
  const y = m.above !== undefined ? m.y : Math.min(m.y, window.innerHeight - 52 * (m.options.length + (m.title ? 1 : 0)) - 20);
  const usesStack = (o: Option) => o.ref?.type === "ability" && (o.ref.abilityKind === "activated" || o.ref.abilityKind === "spell");
  // 色ごとに分けたマナ能力（同じ能力）と、色の問い合わせの選択肢は、1 行の色の記号にまとめる
  const colorOf = (o: Option) => (o.ref?.type === "color" ? o.ref.color : o.ref?.type === "ability" && o.ref.abilityKind === "mana" ? o.ref.color ?? null : null);
  const pip = (o: Option) => h("button.mpip", { type: "button", role: "menuitem", title: colorName(colorOf(o)!), "aria-label": colorName(colorOf(o)!),
    "data-option": o.id, onclick: () => choose(o) }, manaNodes(`{${colorOf(o)}}`));
  const rows: HTMLElement[] = [];
  const pipRows = new Map<string, HTMLElement>(); // 能力のラベル（色の問い合わせは ""）→ 色の記号を並べる所
  for (const o of m.options) {
    if (colorOf(o)) {
      const label = o.ref?.type === "color" ? "" : manaLabel(o);
      let pips = pipRows.get(label);
      if (!pips) {
        pips = h("div.mpips");
        pipRows.set(label, pips);
        rows.push(h("div.mcolor", null, label ? h("span.mlabel", null, manaNodes(label)) : null, pips));
      }
      pips.append(pip(o));
      continue;
    }
    rows.push(quick && usesStack(o)
      ? h("div.mrow", null,
        h("button.mmain", { type: "button", role: "menuitem", title: t("menu.resolve.title"), "data-quick": o.id, onclick: () => quick(o) }, manaNodes(optionLabel(o))),
        h("button.mstack", { type: "button", role: "menuitem", title: t("menu.stack.title"), "aria-label": t("menu.stack.title"), "data-option": o.id, onclick: () => choose(o) },
          icon("stack"), h("span", null, t("menu.stack"))))
      : h("button" + (selected.has(o.id) ? ".on" : ""), { type: "button", role: "menuitem", "data-option": o.id, "aria-checked": selected.has(o.id) ? "true" : null,
        onclick: () => choose(o) }, manaNodes(optionLabel(o))));
  }
  const title = m.title ? h("div.mtitle", null, h("span", null, manaNodes(m.title)),
    m.soft ? h("button.mclose", { type: "button", title: t("card.close"), "aria-label": t("card.close"), onclick: close }, "×") : null) : null;
  const menu = h("div.menu" + (m.locked ? ".locked" : "") + (m.soft ? ".soft" : ""), { role: "menu", style: `left:${Math.max(8, x)}px;top:${Math.max(8, y)}px` } as never,
    title, ...rows, foot.length ? h("div.mfoot", null, foot) : null);
  if (m.locked || m.soft) return [menu]; // 外を押しても閉じない（下の盤面はそのまま見られ、押せる）
  // 押した所の下のカードを押したことにしない（閉じるだけ）
  const back = h("div.menuback", {
    "aria-hidden": "true",
    onpointerdown: (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); close(); },
  });
  return [back, menu];
}

/** 出来事で変わったカード */
function changedCards(events: GameEvent[], triggered: string[] = []): Set<string> {
  const out = new Set<string>(triggered);
  for (const e of events) {
    if (e.type === "zoneChange" || e.type === "tapped" || e.type === "counters") out.add(e.cardId);
    if (e.type === "damage") out.add(e.target);
    if (e.type === "life") out.add(e.player);
    if (e.type === "cast") out.add(e.sourceId);
  }
  return out;
}

/** スタックに積む前の選択（対象・モード・同時誘発の順・任意誘発）で今誘発した発生源を返す */
function preStackTriggers(prev: SessionState["step"], next: SessionState["step"], activating: string | null, prompted: Set<string>): string[] {
  const d = next?.pending;
  if (!prev || !next || !d || d.seq === prev.pending?.seq) return [];
  const out: string[] = [];
  if (d.promptKey === "orderSimultaneous") {
    for (const o of d.options) {
      if (o.ref?.type === "card" && !prompted.has(o.ref.cardId) && !out.includes(o.ref.cardId)) {
        prompted.add(o.ref.cardId);
        out.push(o.ref.cardId);
      }
    }
    return out;
  }
  const src = d.source;
  if (!src || src === activating || prompted.has(src)) return [];
  const onBoard = next.view.players.some((p) => p.cards.some((c) => c.instanceId === src && c.zone !== "Stack" && c.zone !== "Hand"));
  if (!onBoard) return [];
  if (d.kind === "TARGETS" || d.promptKey === "mode" || d.promptKey === "optionalTrigger") {
    prompted.add(src);
    out.push(src);
  }
  return out;
}

const BASIC_LANDS = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes"]);

/** エンジンの準備ができる前に、問題データから盤面を仮に描く（A1 の所見: 準備中も盤面を見て考えられるように。エディタでは includeHidden: true で全領域を描く） */
export function previewView(p: PuzzleJson, opts?: { includeHidden?: boolean }): GameView {
  const includeHidden = opts?.includeHidden ?? false;
  const zones = includeHidden ? ZONES : (["hand", "battlefield", "graveyard", "exile"] as const);
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
      manaPool: parseManaPool(pl.manaPool),
      handCount: pl.hand?.length ?? 0,
      libraryCount: pl.library?.length ?? 0,
      cards: zones.flatMap((zone) =>
        (!includeHidden && pl.id !== p.goal.player && zone === "hand") ? [] : (pl[zone] ?? []).map((c): CardView => {
          const meta = cardMeta(c.cardId);
          const counters = c.counters ? { ...c.counters } : {};
          if (meta?.loyalty !== undefined && zone === "battlefield" && counters.LOYALTY === undefined) {
            counters.LOYALTY = meta.loyalty;
          }
          if (meta?.defense !== undefined && zone === "battlefield" && counters.DEFENSE === undefined) {
            counters.DEFENSE = meta.defense;
          }
          const delta = (counters.P1P1 ?? 0) - (counters.M1M1 ?? 0);
          const isToken = zone === "battlefield" && !!c.token;
          const isOffspringToken = isToken && (meta?.text?.includes("Offspring") ?? false);
          const baseP = isOffspringToken ? 1 : (meta?.basePower ?? null);
          const baseT = isOffspringToken ? 1 : (meta?.baseToughness ?? null);
          return {
            instanceId: c.id,
            name: c.cardId,
            zone: (zone[0].toUpperCase() + zone.slice(1)) as CardView["zone"],
            owner: pl.id,
            controller: pl.id,
            kinds: meta ? meta.kinds : (BASIC_LANDS.has(c.cardId) ? ["land"] : []),
            typeLine: meta?.typeLine ?? "",
            manaCost: meta?.manaCost ?? "",
            text: meta?.text ?? "",
            power: baseP !== null ? baseP + delta : null,
            toughness: baseT !== null ? baseT + delta : null,
            basePower: baseP,
            baseToughness: baseT,
            damage: 0,
            tapped: !!c.tapped,
            sick: !!c.summoningSick,
            token: isToken,
            faceDown: false,
            counters,
            attachedTo: null,
            exiledBy: null,
          };
        })),
    })),
  };
}

/** 対象の選択なら、選んでいる呪文・能力（Adapter が source を返したとき） */
function targetingOf(d: Decision | null): Targeting | null {
  if (!d || d.kind !== "TARGETS" || !d.source) return null;
  const a = d.promptArgs ?? {};
  return { cardId: d.source, text: localized(a.desc ?? "", a.descJa ?? null) };
}
