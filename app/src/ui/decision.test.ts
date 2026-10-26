import { describe, expect, it } from "vitest";
import { setLang } from "../i18n";

setLang("ja"); // 文を確かめるテストは日本語で
import type { CardView, Decision, GameView, Option } from "../engine/protocol";
import { splitManaPool } from "./board";
import { buildInteraction, colorName, isColorAsk, isDirectManaLand, manaLabel, marksOf, optionLabel } from "./decision";
import { decisionPrompt } from "./text";

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

  it("マナ能力しか無いカードは押せるが、候補の印を付けない", () => {
    const d: Decision = { seq: 3, kind: "PRIORITY", prompt: "", min: 1, max: 1, options: [
      { id: "pass", label: "Pass priority", ref: { type: "special", value: "pass" } },
      { id: "a0", label: "Kolaghan's Command | Choose two", ref: { type: "ability", cardId: "c1", abilityKind: "spell" } },
      { id: "a1", label: "Mountain | {T}: Add {R}.", ref: { type: "ability", cardId: "m0", abilityKind: "mana" } },
    ] };
    const i = buildInteraction(d, view);
    expect(i.onBoard.get("m0")?.map((o) => o.id)).toEqual(["a1"]);
    expect(marksOf(i, new Set()).has("m0")).toBe(false);
    expect(marksOf(i, new Set()).get("c1")).toBe("cand");
  });
});

describe("マナの色", () => {
  it("色ごとに分けたマナ能力は、色を付けたラベル。メニューの行のラベルは色を除く", () => {
    const o = { id: "a2", label: "Birds | {T}: Add one mana of any color. [G]", labelJa: null,
      ref: { type: "ability", cardId: "m0", abilityKind: "mana", color: "G" } } as const;
    expect(optionLabel(o)).toBe("マナを出す: {T}: Add one mana of any color.（緑）");
    expect(manaLabel(o)).toBe("マナを出す: {T}: Add one mana of any color.");
  });

  it("色の問い合わせは取りやめられない選択。カードの上で選び、操作の欄にも並べる", () => {
    const d: Decision = { seq: 4, kind: "CHOOSE_MODE", prompt: "", promptKey: "color", promptArgs: { card: "Mountain" }, min: 1, max: 1, options: [
      { id: "k0", label: "red", ref: { type: "color", color: "R", cardId: "m0" } },
      { id: "k1", label: "green", ref: { type: "color", color: "G", cardId: "m0" } },
    ] };
    expect(isColorAsk(d)).toBe(true);
    const i = buildInteraction(d, view);
    expect(i.onBoard.get("m0")?.map((o) => o.id)).toEqual(["k0", "k1"]);
    expect(i.listed.map((o) => o.id)).toEqual(["k0", "k1"]);
    expect(optionLabel(d.options[1])).toBe("緑");
    expect(isColorAsk({ ...d, options: [{ id: "m0", label: "Destroy", ref: null }] })).toBe(false);
  });
});

describe("optionLabel", () => {
  it("能力の種類ごとの短い文", () => {
    expect(optionLabel({ id: "a", label: "Mountain | Play land", ref: { type: "ability", cardId: "m", abilityKind: "land" } })).toBe("土地として出す");
    expect(optionLabel({ id: "a", label: "X | Deal 2", ref: { type: "ability", cardId: "m", abilityKind: "activated" } })).toBe("起動: Deal 2");
    expect(optionLabel({ id: "a", label: "Mountain | {T}: Add {R}.", ref: { type: "ability", cardId: "m", abilityKind: "mana" } })).toBe("マナを出す: {T}：{R}を加える。");
    expect(optionLabel({ id: "c", label: "Ornithopter (Battlefield, p2)", ref: { type: "card", cardId: "o1" } })).toBe("Ornithopter");
    expect(optionLabel({ id: "auto", label: "Auto pay", ref: { type: "special", value: "auto" } })).toBe("自動で支払う");
    expect(colorName("C")).toBe("無色");
  });

  it("スタック参照と新しい選択要求の説明文", () => {
    const viewWithStack: GameView = {
      ...view,
      stack: [{ index: 0, sourceId: "c1", controller: "p1", description: "Spell", spell: true, targets: [] }],
    };
    const d: Decision = {
      seq: 5, kind: "TARGETS", prompt: "", promptKey: "divide",
      promptArgs: { target: "Mountain", left: "3" }, min: 1, max: 1,
      options: [{ id: "s0", label: "Kolaghan's Command", ref: { type: "stack", index: 0 } }],
    };
    const i = buildInteraction(d, viewWithStack);
    expect(i.onBoard.get("c1")?.map((o) => o.id)).toEqual(["s0"]);
    expect(decisionPrompt(d)).toBe("Mountain に割り振る数を選んでください（残り 3）");
    expect(decisionPrompt({ ...d, promptKey: "scryBottom" })).toBe("占術: ライブラリーの一番下に置くカードを選んでください");
    expect(decisionPrompt({ ...d, promptKey: "surveilGrave" })).toBe("諜報: 墓地に置くカードを選んでください");
    expect(decisionPrompt({ ...d, promptKey: "convoke" })).toBe("コストの支払いに使うカードを選んでください");
  });
});

describe("isDirectManaLand", () => {
  const land = (overrides: Partial<CardView> = {}): CardView => ({
    instanceId: "m0", name: "Mountain", zone: "Battlefield", owner: "p1", controller: "p1",
    kinds: ["land"], typeLine: "Basic Land — Mountain", manaCost: "", text: "({T}: Add {R}.)",
    power: null, toughness: null, basePower: null, baseToughness: null, damage: 0,
    tapped: false, sick: false, token: false, faceDown: false, counters: {}, attachedTo: null, exiledBy: null,
    ...overrides,
  });
  const manaOpt = (label: string, color?: "W" | "U" | "B" | "R" | "G" | "C"): Option => ({
    id: "a0", label, ref: { type: "ability", cardId: "m0", abilityKind: "mana", ...(color ? { color } : {}) },
  });

  it("単一マナしか出ず他の起動効果もない戦場の土地は true", () => {
    expect(isDirectManaLand(land(), [manaOpt("Mountain | {T}: Add {R}.")])).toBe(true);
    expect(isDirectManaLand(land({
      name: "Urza's Mine",
      text: "{T}: Add {C}. If you control an Urza's Power-Plant and an Urza's Tower, add {C}{C} instead.",
    }), [manaOpt("Urza's Mine | {T}: Add {C}. If you control an Urza's Power-Plant and an Urza's Tower, add {C}{C} instead.")])).toBe(true);
  });

  it("複数色のマナが出る土地・色を選ぶ土地は false", () => {
    expect(isDirectManaLand(land({ name: "Submerged Boneyard", text: "{T}: Add {U} or {B}." }), [
      manaOpt("Submerged Boneyard | {T}: Add {U} or {B}. [U]", "U"),
      manaOpt("Submerged Boneyard | {T}: Add {U} or {B}. [B]", "B"),
    ])).toBe(false);
    expect(isDirectManaLand(land({ name: "Gateway Plaza", text: "{T}: Add one mana of any color." }), [
      manaOpt("Gateway Plaza | {T}: Add one mana of any color."),
    ])).toBe(false);
  });

  it("他の起動型能力を持つ土地・追加コストのある土地・土地以外は false", () => {
    expect(isDirectManaLand(land({
      name: "Castle Ardenvale",
      text: "{T}: Add {W}.\n{2}{W}{W}, {T}: Create a 1/1 white Human creature token.",
    }), [manaOpt("Castle Ardenvale | {T}: Add {W}.")])).toBe(false);
    expect(isDirectManaLand(land({ name: "Pain Land", text: "{T}, Pay 1 life: Add {B}." }), [
      manaOpt("Pain Land | {T}, Pay 1 life: Add {B}."),
    ])).toBe(false);
    expect(isDirectManaLand(land({ name: "Llanowar Elves", kinds: ["creature"], text: "{T}: Add {G}." }), [
      manaOpt("Llanowar Elves | {T}: Add {G}."),
    ])).toBe(false);
  });
});

describe("splitManaPool", () => {
  it("通常マナと用途制限付きマナを分けて並べる", () => {
    const items = splitManaPool({
      manaPool: { U: 5, G: 2 },
      restrictedMana: [{ color: "U", count: 2, restriction: "Activated" }],
    });
    expect(items).toEqual([
      { color: "U", count: 3, title: "{U} ×3" },
      { color: "U", count: 2, restriction: "Activated", label: "起動能力限定", title: "{U} ×2（用途制限: 起動能力限定）" },
      { color: "G", count: 2, title: "{G} ×2" },
    ]);
  });

  it("すべて用途制限付きマナの場合は通常マナのチップを出さない", () => {
    const items = splitManaPool({
      manaPool: { U: 2 },
      restrictedMana: [{ color: "U", count: 2, restriction: "Activated" }],
    });
    expect(items).toEqual([
      { color: "U", count: 2, restriction: "Activated", label: "起動能力限定", title: "{U} ×2（用途制限: 起動能力限定）" },
    ]);
  });
});
