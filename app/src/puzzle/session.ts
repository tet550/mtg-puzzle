// パズルの進行状態。エンジンへの呼び出しとクリア判定をまとめ、UI に状態の変化を知らせる。

import type { GameEvent, StepResult } from "../engine/protocol";
import { t } from "../i18n";
import { judge, type Verdict } from "./judge";
import { validatePuzzle, type PuzzleJson } from "./schema";
import { matchSolutionStep, recordDecisionStep, type SolutionStep } from "./solution";

/** エンジンのうちセッションが使う部分（テストで差し替える） */
export interface EngineLike {
  load(puzzle: unknown): Promise<StepResult>;
  submit(optionIds: string[]): Promise<StepResult>;
  reset(): Promise<StepResult>;
  restart?(): Promise<void>;
}

/** 1 手分の選択と、その結果として発生した出来事の組（統合ログの 1 項目） */
export interface SessionLogStep {
  /** プレイヤーが行った選択 */
  step: SolutionStep;
  /** 送信した選択肢 ID */
  optionIds: string[];
  /** この 1 手で発生した出来事 */
  events: GameEvent[];
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
  /** 初期盤面読み込み時の出来事（#0 開始時） */
  initialEvents: GameEvent[];
  /** 初期盤面から現在位置までの各手番と出来事の記録 */
  stepLogs: SessionLogStep[];
  /** Undo やログ移動で現在位置より後ろに残っている手番の記録 */
  futureSteps: SessionLogStep[];
  /** 開いてからの出来事（Log に出す） */
  history: GameEvent[];
  /** 開いてからプレイヤーが行った選択手順の記録（解答登録・公開・再生用） */
  solutionSteps: SolutionStep[];
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
  initialEvents: [],
  stepLogs: [],
  futureSteps: [],
  history: [],
  solutionSteps: [],
  debugHistory: [],
  notice: null,
  errors: [],
};

function isSameSolutionStep(a: SolutionStep | undefined, b: SolutionStep | undefined): boolean {
  if (!a || !b) return false;
  return a.kind === b.kind && a.labels.join("|") === b.labels.join("|");
}

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
    const recordedStep = d ? recordDecisionStep(d, optionIds) : null;
    const detail = optionIds.map((id) => {
      const o = d?.options.find((x) => x.id === id);
      return o ? `${id} (${o.label})` : id;
    }).join(", ");
    this.set({ phase: "busy", notice: null });
    await this.run(() => this.engine.submit(optionIds), false, [`[Submit] seq=${d?.seq ?? "?"} ids=[${detail}]`], recordedStep, optionIds);
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

  /** 1 手前に戻す（Undo） */
  async undo(): Promise<boolean> {
    if (this.s.stepLogs.length === 0) return false;
    return this.seekTo(this.s.stepLogs.length - 1);
  }

  /** 1 手先に進める（Redo / ステップ再生） */
  async redo(externalSteps?: SolutionStep[]): Promise<boolean> {
    return this.seekTo(this.s.stepLogs.length + 1, externalSteps);
  }

  /**
   * 指定した手数位置（0 = 開始時、1..N = 各手番の直後）へ盤面を移動する。
   * 現在位置より前へ戻る場合はエンジンを reset して targetCount 手目まで再実行し、
   * 後ろの手番は futureSteps に残すため、後から Redo や再ジャンプができる。
   */
  async seekTo(targetCount: number, externalSteps?: SolutionStep[]): Promise<boolean> {
    const puzzle = this.s.puzzle;
    if (!puzzle || this.s.phase === "loading" || this.s.phase === "busy" || this.s.phase === "idle" || this.s.phase === "error") {
      return false;
    }
    const existing = [...this.s.stepLogs, ...this.s.futureSteps];
    let allEntries: SessionLogStep[];
    if (externalSteps && externalSteps.length > 0) {
      let prefixMatches = true;
      allEntries = externalSteps.map((st, idx) => {
        if (prefixMatches && existing[idx] && isSameSolutionStep(existing[idx].step, st)) {
          return existing[idx];
        }
        prefixMatches = false;
        return { step: st, optionIds: [], events: [] };
      });
    } else {
      allEntries = existing;
    }

    const target = Math.max(0, Math.min(targetCount, allEntries.length));
    if (target === this.s.stepLogs.length) {
      const samePrefix = this.s.stepLogs.every((e, idx) => isSameSolutionStep(e.step, allEntries[idx]?.step));
      if (samePrefix) {
        const nextFuture = allEntries.slice(target);
        if (nextFuture.length !== this.s.futureSteps.length) {
          this.set({ futureSteps: nextFuture });
        }
        return true;
      }
    }

    const canAdvanceInPlace =
      target > this.s.stepLogs.length &&
      this.s.phase === "playing" &&
      !!this.s.step &&
      this.s.stepLogs.every((e, idx) => isSameSolutionStep(e.step, allEntries[idx]?.step));

    const goal = puzzle.goal;
    this.set({ phase: "busy", notice: null });

    try {
      let step: StepResult;
      let startTurn: number;
      let initialEvents: GameEvent[];
      let stepLogs: SessionLogStep[];
      let verdict: Verdict;
      let debugHistory: string[];
      let mismatch = false;

      if (canAdvanceInPlace) {
        step = this.s.step!;
        startTurn = this.s.startTurn;
        initialEvents = this.s.initialEvents;
        stepLogs = [...this.s.stepLogs];
        verdict = this.s.verdict;
        debugHistory = [...this.s.debugHistory];
      } else {
        step = await this.engine.reset();
        startTurn = step.view.turn;
        initialEvents = step.events;
        stepLogs = [];
        verdict = judge({ goal, startTurn, events: step.events, engine: step.engine });
        debugHistory = [...this.s.debugHistory, ...formatStepDebug([`[Seek reset -> target=${target}]`], null, step, verdict)];
      }

      for (let i = stepLogs.length; i < target; i++) {
        if (verdict.result !== "IN_PROGRESS" || !step.pending) break;
        const d = step.pending;
        const entry = allEntries[i];
        const ids =
          matchSolutionStep(d, entry.step) ??
          (entry.optionIds.length > 0 && entry.optionIds.every((id) => d.options.some((o) => o.id === id))
            ? entry.optionIds
            : null);
        if (!ids) {
          mismatch = true;
          break;
        }
        const prev = step;
        step = await this.engine.submit(ids);
        stepLogs.push({ step: entry.step, optionIds: ids, events: step.events });
        verdict = judge({ goal, startTurn, events: step.events, engine: step.engine });
        debugHistory.push(...formatStepDebug([`[SeekSubmit #${i + 1}] ids=[${ids.join(", ")}]`], prev, step, verdict));
      }

      const futureSteps = allEntries.slice(stepLogs.length).map((e, idx) => {
        const origIdx = stepLogs.length + idx;
        return existing[origIdx] && isSameSolutionStep(existing[origIdx].step, e.step) ? existing[origIdx] : e;
      });
      const history = [...initialEvents, ...stepLogs.flatMap((x) => x.events)];
      const solutionSteps = stepLogs.map((x) => x.step);
      const phase: SessionPhase =
        verdict.result === "IN_PROGRESS" ? (step.pending ? "playing" : "error")
          : verdict.result === "ERROR" ? "error" : "finished";
      const fallbackNotice = noticeOf(step.fallback, goal.player);
      this.set({
        phase,
        step,
        verdict,
        startTurn,
        initialEvents,
        stepLogs,
        futureSteps,
        history,
        solutionSteps,
        debugHistory,
        errors: phase === "error" ? [verdict.result === "ERROR" ? verdict.message : t("status.stalled")] : [],
        notice: mismatch ? t("solution.replayMismatch") : fallbackNotice,
      });
      return !mismatch && stepLogs.length === target;
    } catch (e) {
      const code = (e as { code?: string }).code;
      const errLine = `[Error] code=${code ?? "-"} ${message(e)}`;
      this.set({ phase: "error", errors: [message(e)], debugHistory: [...this.s.debugHistory, errLine] });
      return false;
    }
  }

  private async run(
    call: () => Promise<StepResult>,
    fresh: boolean,
    actionLines: string[] = [],
    recordedStep: SolutionStep | null = null,
    optionIds: string[] = [],
  ) {
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
    const initialEvents = fresh ? step.events : this.s.initialEvents;
    const stepLogs: SessionLogStep[] = fresh
      ? []
      : recordedStep
        ? [...this.s.stepLogs, { step: recordedStep, optionIds, events: step.events }]
        : this.s.stepLogs;
    const futureSteps: SessionLogStep[] = fresh
      ? []
      : recordedStep && this.s.futureSteps.length > 0 && isSameSolutionStep(recordedStep, this.s.futureSteps[0].step)
        ? this.s.futureSteps.slice(1)
        : [];
    const history = fresh ? step.events : [...this.s.history, ...step.events];
    const solutionSteps = fresh ? [] : (recordedStep ? [...this.s.solutionSteps, recordedStep] : this.s.solutionSteps);
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
      initialEvents,
      stepLogs,
      futureSteps,
      history,
      solutionSteps,
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
