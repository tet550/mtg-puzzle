import { describe, expect, it } from "vitest";
import { judge } from "./judge";
import type { PuzzleGoal } from "./schema";

const goal: PuzzleGoal = { type: "win", player: "p1", deadline: "current_turn" };
const base = { goal, startTurn: 1 };

describe("judge", () => {
  it("S1: 勝利が確定したらクリア", () => {
    const v = judge({ ...base, engine: { state: "GAME_OVER", outcome: { winner: "p1", draw: false, winCondition: "AllOpponentsLost" } },
      events: [{ type: "life", player: "p2", from: 3, to: 0 }, { type: "gameOver", winner: "p1" }] });
    expect(v).toEqual({ result: "CLEARED", reason: "win" });
  });

  it("S3: 次のターンが始まったら失敗（期限切れ）", () => {
    const v = judge({ ...base, engine: { state: "HALTED" },
      events: [{ type: "phase", phase: "CLEANUP", player: "p1" }, { type: "turnBegan", turn: 2, player: "p2" }] });
    expect(v).toEqual({ result: "FAILED", reason: "deadline" });
  });

  it("S3b: 自分が負けたら失敗", () => {
    const v = judge({ ...base, engine: { state: "GAME_OVER", outcome: { winner: "p2", draw: false, winCondition: "x" } },
      events: [{ type: "gameOver", winner: "p2" }] });
    expect(v).toEqual({ result: "FAILED", reason: "lost" });
  });

  it("期限を過ぎた後の勝利はクリアにしない（先に起きた出来事が優先）", () => {
    const v = judge({ ...base, engine: { state: "GAME_OVER", outcome: { winner: "p1", draw: false, winCondition: "x" } },
      events: [{ type: "turnBegan", turn: 2, player: "p2" }, { type: "gameOver", winner: "p1" }] });
    expect(v.result).toBe("FAILED");
  });

  it("引き分けは失敗", () => {
    const v = judge({ ...base, engine: { state: "GAME_OVER", outcome: { winner: null, draw: true, winCondition: "x" } }, events: [] });
    expect(v).toEqual({ result: "FAILED", reason: "draw" });
  });

  it("エンジンの異常はクリアにしない", () => {
    const v = judge({ ...base, engine: { state: "ERROR", message: "boom" }, events: [{ type: "life", player: "p2", from: 3, to: 0 }] });
    expect(v).toEqual({ result: "ERROR", message: "boom" });
  });

  it("選択待ちならプレイ中（同じターンの turnBegan は期限切れにしない）", () => {
    const v = judge({ ...base, engine: { state: "AWAITING" }, events: [{ type: "turnBegan", turn: 1, player: "p1" }] });
    expect(v).toEqual({ result: "IN_PROGRESS" });
  });
});
