import { describe, expect, it } from "vitest";
import { setLang } from "../i18n";

setLang("ja"); // 文を確かめるテストは日本語で
import { validatePuzzle } from "./schema";

const valid = () => ({
  schemaVersion: 1,
  title: "S1",
  engine: { type: "forge", version: "2.0.15" },
  game: {
    activePlayer: "p1",
    phase: "main1",
    players: [
      { id: "p1", life: 5, hand: [{ id: "c1", cardId: "Lightning Bolt" }], battlefield: [{ id: "c2", cardId: "Mountain" }] },
      { id: "p2", life: 3 },
    ],
  },
  goal: { type: "win", player: "p1", deadline: "current_turn" },
});

describe("validatePuzzle", () => {
  it("正しい問題を通す", () => {
    expect(validatePuzzle(valid()).ok).toBe(true);
  });

  it("プレイテスト用の deadline: none を通す", () => {
    expect(validatePuzzle({ ...valid(), goal: { type: "win", player: "p1", deadline: "none" } }).ok).toBe(true);
  });

  it("未対応の schemaVersion を弾く", () => {
    const r = validatePuzzle({ ...valid(), schemaVersion: 99 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("schemaVersion 99");
  });

  it("Forge のバージョン違いを弾く", () => {
    const r = validatePuzzle({ ...valid(), engine: { type: "forge", version: "1.0" } });
    expect(r.ok).toBe(false);
  });

  it("カードの id の重複を弾く", () => {
    const p = valid();
    p.game.players[1] = { id: "p2", life: 3, hand: [{ id: "c1", cardId: "Island" }] } as never;
    const r = validatePuzzle(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain("重複");
  });

  it("未対応の勝利条件を弾く", () => {
    const r = validatePuzzle({ ...valid(), goal: { type: "survive", player: "p1", deadline: "next_turn" } });
    expect(r.ok).toBe(false);
  });

  it("オブジェクトでないものを弾く", () => {
    expect(validatePuzzle("x").ok).toBe(false);
    expect(validatePuzzle(null).ok).toBe(false);
  });
});
