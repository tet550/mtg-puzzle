import { describe, expect, it } from "vitest";
import type { Decision, GameView } from "../engine/protocol";
import { macroAnswer, startMacro } from "./quick";

const view = (stack: string[] = []): GameView => ({
  turn: 1, phase: "MAIN1", activePlayer: "p1", priorityPlayer: "p1", combat: [], players: [],
  stack: stack.map((sourceId, index) => ({ index, sourceId, controller: "p1", description: "", spell: true, targets: [] })),
});
const priority: Decision = { seq: 1, kind: "PRIORITY", prompt: "", min: 1, max: 1, options: [
  { id: "pass", label: "Pass", ref: { type: "special", value: "pass" } },
  { id: "a0", label: "Bolt | Bolt deals 3", ref: { type: "ability", cardId: "c1", abilityKind: "spell" } },
] };
const targets: Decision = { seq: 2, kind: "TARGETS", prompt: "", min: 1, max: 1, options: [
  { id: "p0", label: "player:p1", ref: { type: "player", player: "p1" } },
  { id: "p1", label: "player:p2", ref: { type: "player", player: "p2" } },
] };
const pay: Decision = { seq: 3, kind: "PAY_MANA", prompt: "", min: 1, max: 1, options: [
  { id: "auto", label: "Auto pay", ref: { type: "special", value: "auto" } },
  { id: "cancel", label: "Cancel", ref: { type: "special", value: "cancel" } },
] };

describe("おまかせ（ドラッグ・ダブルクリック）", () => {
  it("唱える → ドラッグした対象 → 自動で支払う → 一番上に来たら解決 → 終わる", () => {
    const m = startMacro("c1", "p2");
    expect(macroAnswer(m, priority, view())).toEqual(["a0"]);
    expect(macroAnswer(m, targets, view())).toEqual(["p1"]);
    expect(macroAnswer(m, pay, view())).toEqual(["auto"]);
    expect(macroAnswer(m, { ...priority, seq: 4 }, view(["c1"]))).toEqual(["pass"]);
    expect(macroAnswer(m, { ...priority, seq: 5 }, view())).toBe("end");
  });

  it("ダブルクリック（対象なし）は、対象を人が選ぶまで待つ", () => {
    const m = startMacro("c1", null);
    macroAnswer(m, priority, view());
    expect(macroAnswer(m, targets, view())).toBeNull();
  });

  it("支払いを取りやめて戻ってきたら、もう一度は唱えない", () => {
    const m = startMacro("c1", null);
    macroAnswer(m, priority, view());
    expect(macroAnswer(m, { ...priority, seq: 9 }, view())).toBe("end");
  });

  it("唱えられないカードなら何もしない", () => {
    expect(macroAnswer(startMacro("zz", null), priority, view())).toBe("end");
  });

  it("ほかの物（誘発など）が一番上なら、人に任せて終える", () => {
    const m = startMacro("c1", null);
    macroAnswer(m, priority, view());
    expect(macroAnswer(m, { ...priority, seq: 6 }, view(["t9", "c1"]))).toBe("end");
  });

  it("メニューで選んだ起動型能力を起動して、解決まで進める（能力が複数あっても選んだものを使う）", () => {
    const abilities: Decision = { seq: 6, kind: "PRIORITY", prompt: "", min: 1, max: 1, options: [
      { id: "pass", label: "Pass", ref: { type: "special", value: "pass" } },
      { id: "a0", label: "Card | first", ref: { type: "ability", cardId: "c9", abilityKind: "activated" } },
      { id: "a1", label: "Card | second", ref: { type: "ability", cardId: "c9", abilityKind: "activated" } },
    ] };
    expect(macroAnswer(startMacro("c9", null), abilities, view())).toBe("end"); // 選んでいなければ、どれか決められない
    const m = startMacro("c9", null, "a1");
    expect(macroAnswer(m, abilities, view())).toEqual(["a1"]);
    expect(macroAnswer(m, { ...abilities, seq: 7 }, view(["c9"]))).toEqual(["pass"]);
    expect(macroAnswer(m, { ...abilities, seq: 8 }, view())).toBe("end");
  });
});
