// パズルの進行状態。エンジンへの呼び出しとクリア判定をまとめ、UI に状態の変化を知らせる。

import type { GameEvent, StepResult } from "../engine/protocol";
import { t } from "../i18n";
import { judge, type Verdict } from "./judge";
import { validatePuzzle, type PuzzleJson } from "./schema";

/** エンジンのうちセッションが使う部分（テストで差し替える） */
export interface EngineLike {
  load(puzzle: unknown): Promise<StepResult>;
  submit(optionIds: string[]): Promise<StepResult>;
  reset(): Promise<StepResult>;
  restart?(): Promise<void>;
}

export type SessionPhase =
  | "idle"      // 問題を開いていない
  | "loading"   // 問題を読み込み中（エンジンの準備待ちを含む）
  | "playing"   // 選択を待っている
  | "busy"      // 回答をエンジンが処理中
  | "finished"  // クリア / 失敗
  | "error";    // 問題データの誤り、またはエンジンの異常

export interface SessionState {
  phase: SessionPhase;
  puzzle: PuzzleJson | null;
  step: StepResult | null;
  verdict: Verdict;
  /** 問題を開始したターン（期限の判定に使う） */
  startTurn: number;
  /** 開いてからの出来事（Log に出す） */
  history: GameEvent[];
  /** デバッグ用の全記録（アクション・生イベント・GameLog・選択要求・判定・経過時間など） */
  debugHistory: string[];
  /** 直前の回答が受け付けられなかったときなど、続けられる問題のお知らせ */
  notice: string | null;
  /** phase が error のときの内容 */
  errors: string[];
}

const INITIAL: SessionState = {
  phase: "idle",
  puzzle: null,
  step: null,
  verdict: { result: "IN_PROGRESS" },
  startTurn: 0,
  history: [],
  debugHistory: [],
  notice: null,
  errors: [],
};

export class PuzzleSession {
  private s: SessionState = INITIAL;
  private readonly listeners = new Set<(s: SessionState) => void>();

  constructor(private readonly engine: EngineLike) {}

  get state(): SessionState {
    return this.s;
  }

  subscribe(fn: (s: SessionState) => void): () => void {
    this.listeners.add(fn);
    fn(this.s);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<SessionState>) {
    this.s = { ...this.s, ...patch };
    for (const fn of this.listeners) fn(this.s);
  }

  /** 問題を開く。形の誤りはエンジンを呼ぶ前に返す */
  async open(data: unknown): Promise<void> {
    const v = validatePuzzle(data);
    if (!v.ok) {
      this.set({ ...INITIAL, phase: "error", errors: v.errors, debugHistory: v.errors.map((e) => `[ValidationError] ${e}`) });
      return;
    }
    const p = v.puzzle;
    this.set({ ...INITIAL, phase: "loading", puzzle: p });
    await this.run(() => this.engine.load(p), true, [`[Load] title=${JSON.stringify(p.title)} active=${p.game.activePlayer} phase=${p.game.phase}`]);
  }

  async answer(optionIds: string[]): Promise<void> {
    if (this.s.phase !== "playing") return;
    const d = this.s.step?.pending;
    const detail = optionIds.map((id) => {
      const o = d?.options.find((x) => x.id === id);
      return o ? `${id} (${o.label})` : id;
    }).join(", ");
    this.set({ phase: "busy", notice: null });
    await this.run(() => this.engine.submit(optionIds), false, [`[Submit] seq=${d?.seq ?? "?"} ids=[${detail}]`]);
  }

  /** 初期盤面からやり直す。エンジンが異常のときは、エンジンを作り直してから読み込み直す */
  async reset(): Promise<void> {
    const puzzle = this.s.puzzle;
    if (!puzzle) return;
    if (this.s.phase === "error" && this.engine.restart) {
      this.set({ ...INITIAL, phase: "loading", puzzle });
      try {
        await this.engine.restart();
      } catch (e) {
        this.set({ phase: "error", errors: [message(e)], debugHistory: [`[RestartError] ${message(e)}`] });
        return;
      }
      await this.run(() => this.engine.load(puzzle), true, [`[Restart+Load] title=${JSON.stringify(puzzle.title)}`]);
      return;
    }
    this.set({ ...INITIAL, phase: "loading", puzzle });
    await this.run(() => this.engine.reset(), true, [`[Reset] title=${JSON.stringify(puzzle.title)}`]);
  }

  private async run(call: () => Promise<StepResult>, fresh: boolean, actionLines: string[] = []) {
    const prevStep = this.s.step;
    let step: StepResult;
    try {
      step = await call();
    } catch (e) {
      const code = (e as { code?: string }).code;
      const errLine = `[Error] code=${code ?? "-"} ${message(e)}`;
      const debugHistory = fresh ? [...actionLines, errLine] : [...this.s.debugHistory, ...actionLines, errLine];
      if (code === "INVALID_ANSWER" && !fresh) {
        // 回答が受け付けられなかった。選択待ちの状態は残っているので続けられる
        this.set({ phase: "playing", notice: message(e), debugHistory });
        return;
      }
      this.set({ phase: "error", errors: [message(e)], debugHistory });
      return;
    }
    const startTurn = fresh ? step.view.turn : this.s.startTurn;
    const goal = this.s.puzzle!.goal;
    const verdict = judge({ goal, startTurn, events: step.events, engine: step.engine });
    const history = fresh ? step.events : [...this.s.history, ...step.events];
    const stepDebug = formatStepDebug(actionLines, fresh ? null : prevStep, step, verdict);
    const debugHistory = fresh ? stepDebug : [...this.s.debugHistory, ...stepDebug];
    const phase: SessionPhase =
      verdict.result === "IN_PROGRESS" ? (step.pending ? "playing" : "error")
        : verdict.result === "ERROR" ? "error" : "finished";
    this.set({
      phase,
      step,
      verdict,
      startTurn,
      history,
      debugHistory,
      errors: phase === "error" ? [verdict.result === "ERROR" ? verdict.message : t("status.stalled")] : [],
      notice: noticeOf(step.fallback, goal.player),
    });
  }
}

function formatStepDebug(actionLines: string[], prevStep: StepResult | null, step: StepResult, verdict: Verdict): string[] {
  const out: string[] = [...actionLines];
  if (step.debug) {
    for (const line of step.debug) out.push(line);
  }
  for (const ev of step.events) {
    out.push(`[AdapterEvent] ${JSON.stringify(ev)}`);
  }
  const prevFb = prevStep?.fallback.length ?? 0;
  for (const fb of step.fallback.slice(prevFb)) {
    out.push(`[Fallback] ${fb}`);
  }
  const eng = step.engine.state === "GAME_OVER"
    ? `GAME_OVER(winner=${step.engine.outcome.winner}, draw=${step.engine.outcome.draw}, winCondition=${step.engine.outcome.winCondition})`
    : step.engine.state === "ERROR" ? `ERROR(${step.engine.message})` : step.engine.state;
  out.push(
    `[Step] turn=${step.view.turn} phase=${step.view.phase} active=${step.view.activePlayer} priority=${step.view.priorityPlayer ?? "-"} ` +
    `stack=${step.view.stack.length} engine=${eng} javaJudge=${step.javaJudge.status}(${step.javaJudge.reason}) verdict=${verdict.result} elapsed=${step.elapsedMs}ms`,
  );
  if (step.pending) {
    const d = step.pending;
    out.push(`[Decision #${d.seq}] kind=${d.kind} min=${d.min} max=${d.max} source=${d.source ?? "-"} key=${d.promptKey ?? "-"} prompt=${JSON.stringify(d.prompt)}`);
    for (const o of d.options) {
      out.push(`  [Option ${o.id}] label=${JSON.stringify(o.label)}${o.labelJa ? ` labelJa=${JSON.stringify(o.labelJa)}` : ""}${o.ref ? ` ref=${JSON.stringify(o.ref)}` : ""}`);
    }
  }
  return out;
}

/**
 * 既定の答えを使った選択のうち、問題を解くプレイヤーのものだけを知らせる。
 * 相手の強制的な選択は「問題で定めた方針」（既定は先頭）で答える仕様なので知らせない（要件 4.3）
 */
function noticeOf(fallback: string[], player: string): string | null {
  const mine = [...new Set(fallback.filter((f) => f.startsWith(`${player}:`)))];
  return mine.length ? t("status.fallback", { list: mine.join(", ") }) : null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
