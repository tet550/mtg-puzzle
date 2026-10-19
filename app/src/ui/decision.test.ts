import { describe, expect, it } from "vitest";
import type { Decision, GameView } from "../engine/protocol";
import { buildInteraction, marksOf, optionLabel } from "./decision";

const view: GameView = {
  turn: 1, phase: "MAIN1", activePlayer: "p1", priorityPlayer: "p1", stack: [], combat: [],
  players: [
    { id: "p1", life: 20, poison: 0, manaPool: {}, handCount: 1, libraryCount: 0, cards: [
      { instanceId: "c1", name: "Kolaghan's Command", zone: "Hand" } as never,
      { instanceId: "m0", name: "Mountain", zone: "Battlefield" } as never,
    ] },
    { id: "p2", life: 2, poison: 0, manaPool: {}, handCount: 1, libraryCount: 3, cards: [] },
  ],
};

describe("buildInteraction", () => {
  it("盤面のカード・プレイヤー・盤面に無いもの・特別な選択肢に振り分ける", () => {
    const d: Decision = { seq: 1, kind: "TARGETS", prompt: "", min: 1, max: 1, options: [
      { id: "p1", label: "player:p2", ref: { type: "player", player: "p2" } },
      { id: "c9", label: "Hidden (Library, p1)", ref: { type: "card", cardId: "x9" } },
      { id: "cancel", label: "Cancel", ref: { type: "special", value: "cancel" } },
    ] };
    const i = buildInteraction(d, view);
    expect([...i.onBoard.keys()]).toEqual(["p2"]);
    expect(i.listed.map((o) => o.id)).toEqual(["c9"]);
    expect(i.specials.map((o) => o.id)).toEqual(["cancel"]);
    expect(i.single).toBe(true);
  });

  it("同じカードの複数の能力は 1 つの要素にまとめる", () => {
    const d: Decision = { seq: 2, kind: "PRIORITY", prompt: "", min: 1, max: 1, options: [
      { id: "pass", label: "Pass priority", ref: { type: "special", value: "pass" } },
      { id: "a0", label: "Kolaghan's Command | Choose two", ref: { type: "ability", cardId: "c1", abilityKind: "spell" } },
      { id: "a1", label: "Kolaghan's Command | Cycling", ref: { type: "ability", cardId: "c1", abilityKind: "activated" } },
    ] };
    const i = buildInteraction(d, view);
    expect(i.onBoard.get("c1")?.map((o) => o.id)).toEqual(["a0", "a1"]);
    expect(marksOf(i, new Set(["a1"])).get("c1")).toBe("chosen");
    expect(marksOf(i, new Set()).get("c1")).toBe("cand");
  });
});

describe("optionLabel", () => {
  it("能力の種類ごとの短い文", () => {
    expect(optionLabel({ id: "a", label: "Mountain | Play land", ref: { type: "ability", cardId: "m", abilityKind: "land" } })).toBe("土地として出す");
    expect(optionLabel({ id: "a", label: "X | Deal 2", ref: { type: "ability", cardId: "m", abilityKind: "activated" } })).toBe("起動: Deal 2");
    expect(optionLabel({ id: "c", label: "Ornithopter (Battlefield, p2)", ref: { type: "card", cardId: "o1" } })).toBe("Ornithopter");
    expect(optionLabel({ id: "auto", label: "Auto pay", ref: { type: "special", value: "auto" } })).toBe("自動で支払う");
  });
});
