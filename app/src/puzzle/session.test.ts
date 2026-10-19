import { describe, expect, it } from "vitest";
import { setLang } from "../i18n";

setLang("ja"); // 文を確かめるテストは日本語で
import type { StepResult } from "../engine/protocol";
import { PuzzleSession, type EngineLike } from "./session";

const puzzle = {
  schemaVersion: 1,
  title: "S1",
  engine: { type: "forge", version: "2.0.15" },
  game: { activePlayer: "p1", phase: "main1", players: [{ id: "p1" }, { id: "p2" }] },
  goal: { type: "win", player: "p1", deadline: "current_turn" },
};

function step(patch: Partial<StepResult>): StepResult {
  return {
    engine: { state: "AWAITING" },
    pending: { seq: 1, kind: "PRIORITY", prompt: "", min: 1, max: 1, options: [{ id: "pass", label: "Pass", ref: null }] },
    events: [],
    view: { turn: 1, phase: "MAIN1", activePlayer: "p1", priorityPlayer: "p1", stack: [], combat: [], players: [] },
    fallback: [],
    elapsedMs: 1,
    javaJudge: { status: "IN_PROGRESS", reason: "" },
    ...patch,
  };
}

function fakeEngine(steps: (StepResult | Error)[]): EngineLike & { calls: string[] } {
  const calls: string[] = [];
  const next = async () => {
    const s = steps.shift();
    if (!s) throw new Error("no more steps");
    if (s instanceof Error) throw s;
    return s;
  };
  return {
    calls,
    load: async () => { calls.push("load"); return next(); },
    submit: async (ids) => { calls.push(`submit ${ids.join(",")}`); return next(); },
    reset: async () => { calls.push("reset"); return next(); },
    restart: async () => { calls.push("restart"); },
  };
}

describe("PuzzleSession", () => {
  it("読み込み → 回答 → クリア", async () => {
    const engine = fakeEngine([
      step({}),
      step({ engine: { state: "GAME_OVER", outcome: { winner: "p1", draw: false, winCondition: "x" } }, pending: null,
        events: [{ type: "gameOver", winner: "p1" }] }),
    ]);
    const s = new PuzzleSession(engine);
    await s.open(puzzle);
    expect(s.state.phase).toBe("playing");
    await s.answer(["pass"]);
    expect(s.state.phase).toBe("finished");
    expect(s.state.verdict).toEqual({ result: "CLEARED", reason: "win" });
    expect(s.state.history).toHaveLength(1);
  });

  it("形の誤りはエンジンを呼ばずにエラー", async () => {
    const engine = fakeEngine([]);
    const s = new PuzzleSession(engine);
    await s.open({ ...puzzle, schemaVersion: 2 });
    expect(s.state.phase).toBe("error");
    expect(engine.calls).toEqual([]);
  });

  it("受け付けられなかった回答の後も続けられる", async () => {
    const err = Object.assign(new Error("選択肢にない ID: zzz"), { code: "INVALID_ANSWER" });
    const engine = fakeEngine([step({}), err]);
    const s = new PuzzleSession(engine);
    await s.open(puzzle);
    await s.answer(["zzz"]);
    expect(s.state.phase).toBe("playing");
    expect(s.state.notice).toContain("zzz");
  });

  it("エンジンの異常の後のリセットは、エンジンを作り直して読み込み直す", async () => {
    const engine = fakeEngine([step({}), Object.assign(new Error("timeout"), { code: "TIMEOUT" }), step({})]);
    const s = new PuzzleSession(engine);
    await s.open(puzzle);
    await s.answer(["pass"]);
    expect(s.state.phase).toBe("error");
    await s.reset();
    expect(engine.calls).toEqual(["load", "submit pass", "restart", "load"]);
    expect(s.state.phase).toBe("playing");
  });

  it("終わった後は回答を送らない", async () => {
    const engine = fakeEngine([step({ engine: { state: "HALTED" }, pending: null, events: [{ type: "turnBegan", turn: 2, player: "p2" }] })]);
    const s = new PuzzleSession(engine);
    await s.open(puzzle);
    expect(s.state.verdict).toEqual({ result: "FAILED", reason: "deadline" });
    await s.answer(["pass"]);
    expect(engine.calls).toEqual(["load"]);
  });

  it("未対応の選択の知らせは、問題を解くプレイヤーの分だけ（重ねて出さない）", async () => {
    const engine = fakeEngine([step({ fallback: ["p2: chooseCardsToDiscardFrom", "p1: assignCombatDamage", "p1: assignCombatDamage"] })]);
    const s = new PuzzleSession(engine);
    await s.open(puzzle);
    expect(s.state.notice).toContain("p1: assignCombatDamage");
    expect(s.state.notice).not.toContain("p2:");
    expect(s.state.notice!.match(/assignCombatDamage/g)).toHaveLength(1);
  });
});
