import { describe, expect, it } from "vitest";
import { indexCardData } from "../puzzle/carddb";
import { validatePuzzle } from "../puzzle/schema";
import {
  addCardToPuzzle,
  adjustPlayerMana,
  clearPlayerMana,
  createEmptyPuzzle,
  defaultBattlefieldCounters,
  duplicateCardInPuzzle,
  findCardLocation,
  isPermanentCard,
  moveCardInPuzzle,
  moveCardOrderInZone,
  nextCardInstanceId,
  normalizePuzzleForEngine,
  removeCardFromPuzzle,
  setCardCounter,
  setPlayerLife,
  toggleCardProp,
} from "./edit";

describe("edit pure puzzle mutations", () => {
  it("creates a valid empty puzzle", () => {
    const p = createEmptyPuzzle("Test Puzzle");
    const res = validatePuzzle(p);
    expect(res.ok).toBe(true);
    expect(p.title).toBe("Test Puzzle");
    expect(p.game.players).toHaveLength(2);
  });

  it("adds, duplicates, moves, reorders, and removes cards while maintaining unique IDs", () => {
    let p = createEmptyPuzzle("Card Ops");
    expect(nextCardInstanceId(p)).toBe("c1");

    const r1 = addCardToPuzzle(p, "p1", "hand", "Lightning Bolt");
    p = r1.puzzle;
    expect(r1.added).toEqual({ id: "c1", cardId: "Lightning Bolt" });

    const r2 = addCardToPuzzle(p, "p1", "battlefield", "Grizzly Bears");
    p = r2.puzzle;
    expect(r2.added.id).toBe("c2");

    // Toggle tapped & summoningSick on battlefield card
    p = toggleCardProp(p, "c2", "tapped");
    p = toggleCardProp(p, "c2", "summoningSick");
    expect(findCardLocation(p, "c2")?.card.tapped).toBe(true);
    expect(findCardLocation(p, "c2")?.card.summoningSick).toBe(true);

    // Duplicate c2
    const dup = duplicateCardInPuzzle(p, "c2");
    p = dup.puzzle;
    expect(dup.duplicated?.id).toBe("c3");
    expect(dup.duplicated?.tapped).toBe(true);

    // Move c3 to p2 graveyard -> tapped & summoningSick should be cleared
    p = moveCardInPuzzle(p, "c3", "p2", "graveyard");
    const loc3 = findCardLocation(p, "c3");
    expect(loc3?.playerId).toBe("p2");
    expect(loc3?.zone).toBe("graveyard");
    expect(loc3?.card.tapped).toBeUndefined();
    expect(loc3?.card.summoningSick).toBeUndefined();

    // Add another card to p2 graveyard and test reordering
    p = addCardToPuzzle(p, "p2", "graveyard", "Mountain").puzzle; // c4
    expect(p.game.players[1].graveyard?.map((c) => c.id)).toEqual(["c3", "c4"]);
    p = moveCardOrderInZone(p, "c4", "top");
    expect(p.game.players[1].graveyard?.map((c) => c.id)).toEqual(["c4", "c3"]);
    p = moveCardOrderInZone(p, "c4", "bottom");
    expect(p.game.players[1].graveyard?.map((c) => c.id)).toEqual(["c3", "c4"]);

    // Remove c1
    p = removeCardFromPuzzle(p, "c1");
    expect(findCardLocation(p, "c1")).toBeNull();
    expect(validatePuzzle(p).ok).toBe(true);
  });

  it("updates counters, player life, and mana pool", () => {
    let p = createEmptyPuzzle("Stats");
    const added = addCardToPuzzle(p, "p1", "battlefield", "Grizzly Bears");
    p = added.puzzle;

    p = setCardCounter(p, added.added.id, "P1P1", 2);
    expect(findCardLocation(p, added.added.id)?.card.counters).toEqual({ P1P1: 2 });

    p = setCardCounter(p, added.added.id, "P1P1", 0);
    expect(findCardLocation(p, added.added.id)?.card.counters).toBeUndefined();

    p = setPlayerLife(p, "p2", 7);
    expect(p.game.players[1].life).toBe(7);

    p = adjustPlayerMana(p, "p1", "R", 2);
    p = adjustPlayerMana(p, "p1", "G", 1);
    expect(p.game.players[0].manaPool).toBe("R R G");

    p = adjustPlayerMana(p, "p1", "R", -1);
    expect(p.game.players[0].manaPool).toBe("R G");

    p = clearPlayerMana(p, "p1");
    expect(p.game.players[0].manaPool).toBeUndefined();
    expect(validatePuzzle(p).ok).toBe(true);
  });

  it("prevents non-permanent spells on battlefield, populates default PW/Battle counters, and normalizes split card names", () => {
    indexCardData({
      keys: {
        "jace's machinations": 0,
        "jace beleren": 1,
        "invasion of gobakhan": 2,
        fire: 3,
        ice: 3,
      },
      cards: [
        {
          f: "jaces_machinations.txt",
          s: "Name:Jace's Machinations\nManaCost:2 U\nTypes:Instant\nOracle:Empower Jace 8.\n",
        },
        {
          f: "jace_beleren.txt",
          s: "Name:Jace Beleren\nManaCost:1 U U\nTypes:Legendary Planeswalker Jace\nLoyalty:3\nOracle:[+2]: Each player draws a card.\n",
        },
        {
          f: "invasion_of_gobakhan.txt",
          s: "Name:Invasion of Gobakhan\nManaCost:1 W\nTypes:Battle Siege\nDefense:3\nOracle:When Invasion of Gobakhan enters, look at target opponent's hand.\n",
        },
        {
          f: "fire_ice.txt",
          s: "Name:Fire\nManaCost:1 R\nTypes:Instant\nAlternateMode:Split\nOracle:Fire deals 2 damage divided as you choose among one or two targets.\n\nALTERNATE\n\nName:Ice\nManaCost:1 U\nTypes:Instant\nOracle:Tap target permanent.\n",
        },
      ],
    });

    expect(isPermanentCard("Jace's Machinations")).toBe(false);
    expect(isPermanentCard("Jace Beleren")).toBe(true);
    expect(defaultBattlefieldCounters("Jace Beleren")).toEqual({ LOYALTY: 3 });
    expect(defaultBattlefieldCounters("Invasion of Gobakhan")).toEqual({ DEFENSE: 3 });

    let p = createEmptyPuzzle("Engine Normalization");

    // 1. Adding an Instant to battlefield redirects to hand
    const rSpell = addCardToPuzzle(p, "p1", "battlefield", "Jace's Machinations");
    p = rSpell.puzzle;
    expect(findCardLocation(p, rSpell.added.id)?.zone).toBe("hand");

    // 2. Trying to move an Instant to battlefield is ignored
    p = moveCardInPuzzle(p, rSpell.added.id, "p1", "battlefield");
    expect(findCardLocation(p, rSpell.added.id)?.zone).toBe("hand");

    // 3. Adding a Planeswalker to battlefield sets initial LOYALTY counters
    const rPw = addCardToPuzzle(p, "p1", "battlefield", "Jace Beleren");
    p = rPw.puzzle;
    expect(rPw.added.counters).toEqual({ LOYALTY: 3 });

    // 4. Adding a Split card by single face name canonicalizes to "Fire // Ice"
    const rSplit = addCardToPuzzle(p, "p1", "hand", "Fire");
    p = rSplit.puzzle;
    expect(rSplit.added.cardId).toBe("Fire // Ice");

    // 5. normalizePuzzleForEngine fixes legacy drafts (Instant on battlefield, PW without counters, Split card short name)
    const rawDraft = createEmptyPuzzle("Legacy Draft");
    rawDraft.game.players[0].battlefield = [
      { id: "c1", cardId: "Jace's Machinations", tapped: true },
      { id: "c2", cardId: "Jace Beleren" },
      { id: "c3", cardId: "Invasion of Gobakhan" },
    ];
    rawDraft.game.players[0].hand = [{ id: "c4", cardId: "Fire" }];

    const norm = normalizePuzzleForEngine(rawDraft);
    expect(norm.game.players[0].battlefield?.map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(norm.game.players[0].battlefield?.[0].counters).toEqual({ LOYALTY: 3 });
    expect(norm.game.players[0].battlefield?.[1].counters).toEqual({ DEFENSE: 3 });
    expect(norm.game.players[0].hand?.map((c) => ({ id: c.id, cardId: c.cardId }))).toEqual([
      { id: "c4", cardId: "Fire // Ice" },
      { id: "c1", cardId: "Jace's Machinations" },
    ]);
  });
});
