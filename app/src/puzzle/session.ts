// パズルの進行状態。エンジンへの呼び出しとクリア判定をまとめ、UI に状態の変化を知らせる。

import type { GameEvent, StepResult } from "../engine/protocol";
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
      this.set({ ...INITIAL, phase: "error", errors: v.errors });
      return;
    }
    this.set({ ...INITIAL, phase: "loading", puzzle: v.puzzle });
    await this.run(() => this.engine.load(v.puzzle), true);
  }

  async answer(optionIds: string[]): Promise<void> {
    if (this.s.phase !== "playing") return;
    this.set({ phase: "busy", notice: null });
    await this.run(() => this.engine.submit(optionIds), false);
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
        this.set({ phase: "error", errors: [message(e)] });
        return;
      }
      await this.run(() => this.engine.load(puzzle), true);
      return;
    }
    this.set({ ...INITIAL, phase: "loading", puzzle });
    await this.run(() => this.engine.reset(), true);
  }

  private async run(call: () => Promise<StepResult>, fresh: boolean) {
    let step: StepResult;
    try {
      step = await call();
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "INVALID_ANSWER" && !fresh) {
        // 回答が受け付けられなかった。選択待ちの状態は残っているので続けられる
        this.set({ phase: "playing", notice: message(e) });
        return;
      }
      this.set({ phase: "error", errors: [message(e)] });
      return;
    }
    const startTurn = fresh ? step.view.turn : this.s.startTurn;
    const goal = this.s.puzzle!.goal;
    const verdict = judge({ goal, startTurn, events: step.events, engine: step.engine });
    const history = fresh ? step.events : [...this.s.history, ...step.events];
    const phase: SessionPhase =
      verdict.result === "IN_PROGRESS" ? (step.pending ? "playing" : "error")
        : verdict.result === "ERROR" ? "error" : "finished";
    this.set({
      phase,
      step,
      verdict,
      startTurn,
      history,
      errors: phase === "error" ? [verdict.result === "ERROR" ? verdict.message : "エンジンが選択を求めずに止まりました"] : [],
      notice: step.fallback.length ? `この問題には未対応の選択が含まれています（${step.fallback.join(", ")}）` : null,
    });
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
