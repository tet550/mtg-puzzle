import { describe, expect, it } from "vitest";
import type { GameEvent } from "../engine/protocol";
import { beatOrder } from "./motion";

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
