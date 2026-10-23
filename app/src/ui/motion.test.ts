import { describe, expect, it } from "vitest";
import type { CardView, GameEvent, GameView } from "../engine/protocol";
import { beatOrder, isTriggerCast } from "./motion";

const baseView = (cards: Partial<CardView>[] = [], stack: GameView["stack"] = []): GameView => ({
  turn: 1,
  phase: "MAIN1",
  activePlayer: "p1",
  priorityPlayer: "p1",
  stack,
  combat: [],
  players: [{
    id: "p1", life: 20, poison: 0, manaPool: {}, handCount: 0, libraryCount: 0,
    cards: cards.map((c, i) => ({
      instanceId: c.instanceId ?? `c${i}`, name: c.name ?? "Card", zone: c.zone ?? "Battlefield",
      owner: "p1", controller: "p1", kinds: [], typeLine: "", manaCost: "", text: "",
      power: null, toughness: null, basePower: null, baseToughness: null, damage: 0,
      tapped: false, sick: false, token: false, faceDown: false, counters: {}, attachedTo: null, exiledBy: null,
    })),
  }],
});

describe("beatOrder", () => {
  it("解決の効果より前に resolved を出す（光弾が飛んでから壊れる）", () => {
    const events: GameEvent[] = [
      { type: "zoneChange", cardId: "o2", from: "Battlefield", to: "Graveyard" },
      { type: "resolved", sourceId: "h3", description: "Murder", fizzled: false },
      { type: "zoneChange", cardId: "h3", from: "Stack", to: "Graveyard" },
    ];
    expect(beatOrder(events).map((e) => e.type === "zoneChange" ? e.cardId : e.type)).toEqual(["resolved", "o2", "h3"]);
  });

  it("前の解決・唱えた呪文の効果は、後の resolved の前に移さない", () => {
    const events: GameEvent[] = [
      { type: "tapped", cardId: "l1", tapped: true },
      { type: "cast", sourceId: "c1", controller: "p1", description: "Bolt" },
      { type: "damage", sourceId: "c1", target: "p2", amount: 3, combat: false },
      { type: "life", player: "p2", from: 3, to: 0 },
      { type: "resolved", sourceId: "c1", description: "Bolt", fizzled: false },
    ];
    expect(beatOrder(events).map((e) => e.type)).toEqual(["tapped", "cast", "resolved", "damage", "life"]);
  });
});

describe("isTriggerCast", () => {
  it("戦場のカードの誘発型能力は true を返す", () => {
    const cast: Extract<GameEvent, { type: "cast" }> = {
      type: "cast", sourceId: "h3", controller: "p1",
      description: "When Guac & Marshmallow Pizza enters, it deals 3 damage to any target.",
    };
    const next = baseView(
      [{ instanceId: "h3", zone: "Battlefield" }],
      [{ index: 0, description: cast.description, descriptionJa: null, sourceId: "h3", controller: "p1", spell: false, targets: ["p2"] }],
    );
    const events: GameEvent[] = [{ type: "zoneChange", cardId: "h3", from: "Stack", to: "Battlefield" }, cast];
    expect(isTriggerCast(cast, events, next)).toBe(true);
  });

  it("呪文の詠唱・プレイヤーが起動した能力・前段で演出済みの誘発は false を返す", () => {
    const spellCast: Extract<GameEvent, { type: "cast" }> = {
      type: "cast", sourceId: "h1", controller: "p1", description: "Lightning Bolt",
    };
    const spellEvents: GameEvent[] = [{ type: "zoneChange", cardId: "h1", from: "Hand", to: "Stack" }, spellCast];
    expect(isTriggerCast(spellCast, spellEvents, baseView([{ instanceId: "h1", zone: "Stack" }]))).toBe(false);

    const actCast: Extract<GameEvent, { type: "cast" }> = {
      type: "cast", sourceId: "c1", controller: "p1", description: "{T}: Add {G}.",
    };
    const bf = baseView([{ instanceId: "c1", zone: "Battlefield" }]);
    expect(isTriggerCast(actCast, [actCast], bf, "c1")).toBe(false);
    expect(isTriggerCast(actCast, [actCast], bf)).toBe(false);

    const trigCast: Extract<GameEvent, { type: "cast" }> = {
      type: "cast", sourceId: "c1", controller: "p1", description: "Whenever this creature attacks, draw a card.",
    };
    expect(isTriggerCast(trigCast, [trigCast], bf, null, new Set(["c1"]))).toBe(false);
    expect(isTriggerCast(trigCast, [trigCast], baseView())).toBe(false);
  });
});
