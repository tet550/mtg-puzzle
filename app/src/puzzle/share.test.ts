import { describe, expect, it } from "vitest";
import { createEmptyPuzzle, addCardToPuzzle, setCardCounter, adjustPlayerMana } from "../ui/edit";
import { buildPlaytestPuzzle, extractDeckFromPlaytestPuzzle } from "./deck";
import {
  buildShareUrl,
  buildSolutionShareUrl,
  decodePuzzleFromParam,
  decodeSolutionFromParam,
  encodePuzzleToParam,
  encodeSolutionToParam,
  fromBase64Url,
  parsePlayRouteLocation,
  parsePuzzleInput,
  parseShareLocation,
  snapshotPuzzleFromView,
  toBase64Url,
} from "./share";
import type { SolutionStep } from "./solution";
import type { CardView, GameView } from "../engine/protocol";

function makeCardView(overrides: Partial<CardView> & Pick<CardView, "instanceId" | "name" | "zone">): CardView {
  return {
    owner: "p1",
    controller: "p1",
    kinds: [],
    typeLine: "",
    manaCost: "",
    text: "",
    power: null,
    toughness: null,
    basePower: null,
    baseToughness: null,
    damage: 0,
    tapped: false,
    sick: false,
    token: false,
    faceDown: false,
    counters: {},
    attachedTo: null,
    exiledBy: null,
    ...overrides,
  };
}

describe("puzzle URL sharing", () => {
  it("round-trips Base64URL byte encoding", () => {
    const bytes = new Uint8Array([0, 1, 2, 62, 63, 254, 255]);
    const b64 = toBase64Url(bytes);
    expect(b64).not.toMatch(/[+/=]/);
    expect(Array.from(fromBase64Url(b64))).toEqual(Array.from(bytes));
  });

  it("compresses and decodes a puzzle with Japanese text, cards, and counters", async () => {
    let p = createEmptyPuzzle("テスト詰めマジック");
    p.description = "このターン中に相手を倒せ";
    p = addCardToPuzzle(p, "p1", "hand", "Lightning Bolt").puzzle;
    const r2 = addCardToPuzzle(p, "p1", "battlefield", "Grizzly Bears");
    p = setCardCounter(r2.puzzle, r2.added.id, "P1P1", 2);
    p = adjustPlayerMana(p, "p1", "R", 1);

    const param = await encodePuzzleToParam(p);
    expect(param.length).toBeGreaterThan(10);
    expect(param.length).toBeLessThan(JSON.stringify(p).length);

    const decoded = await decodePuzzleFromParam(param);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.puzzle.title).toBe("テスト詰めマジック");
      expect(decoded.puzzle.description).toBe("このターン中に相手を倒せ");
      expect(decoded.puzzle.game.players[0].manaPool).toBe("R");
      expect(decoded.puzzle.game.players[0].hand).toEqual([
        { id: "c1", cardId: "Lightning Bolt" },
      ]);
      expect(decoded.puzzle.game.players[0].battlefield).toEqual([
        { id: "c2", cardId: "Grizzly Bears", counters: { P1P1: 2 } },
      ]);
      // Compacted empty zones are restored to empty arrays
      expect(decoded.puzzle.game.players[0].graveyard).toEqual([]);
      expect(decoded.puzzle.game.players[1].hand).toEqual([]);
    }
  });

  it("decodes uncompressed Base64URL JSON payloads", async () => {
    const p = createEmptyPuzzle("Uncompressed Puzzle");
    const rawBytes = new TextEncoder().encode(JSON.stringify(p));
    const param = toBase64Url(rawBytes);

    const decoded = await decodePuzzleFromParam(param);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.puzzle.title).toBe("Uncompressed Puzzle");
    }
  });

  it("builds and parses play and edit share URLs", async () => {
    const p = createEmptyPuzzle("Share URL Test");
    const playUrl = await buildShareUrl(p, "play", "https://example.com/mtg-puzzle/#/");
    const editUrl = await buildShareUrl(p, "edit", "https://example.com/mtg-puzzle/#/edit");

    expect(playUrl).toMatch(/^https:\/\/example\.com\/mtg-puzzle\/#\/play\?p=[A-Za-z0-9_-]+$/);
    expect(editUrl).toMatch(/^https:\/\/example\.com\/mtg-puzzle\/#\/edit\?p=[A-Za-z0-9_-]+$/);

    const parsedPlay = parseShareLocation(playUrl);
    expect(parsedPlay?.mode).toBe("play");

    const parsedEdit = parseShareLocation(editUrl);
    expect(parsedEdit?.mode).toBe("edit");

    const parsedShort = parseShareLocation(`#p=${parsedPlay!.param}`);
    expect(parsedShort).toEqual({ mode: "play", param: parsedPlay!.param });
  });

  it("parses JSON, full share URLs, hash fragments, and raw tokens via parsePuzzleInput", async () => {
    let p = createEmptyPuzzle("Multi Input");
    p = addCardToPuzzle(p, "p1", "hand", "Mountain").puzzle;

    const playUrl = await buildShareUrl(p, "play", "https://example.com/mtg-puzzle/");
    const param = await encodePuzzleToParam(p);

    const fromJson = await parsePuzzleInput(JSON.stringify(p, null, 2));
    expect(fromJson.ok).toBe(true);

    const fromUrl = await parsePuzzleInput(playUrl);
    expect(fromUrl.ok).toBe(true);
    if (fromUrl.ok) {
      expect(fromUrl.puzzle.title).toBe("Multi Input");
      expect(fromUrl.puzzle.game.players[0].hand?.[0].cardId).toBe("Mountain");
    }

    const fromToken = await parsePuzzleInput(param);
    expect(fromToken.ok).toBe(true);
  });

  it("encodes and decodes solution steps in bundled, shared, and playtest URLs", async () => {
    const steps: SolutionStep[] = [
      { kind: "PRIORITY", indexes: [1], labels: ["Mountain [1] — {T}: Add {R}."] },
      { kind: "PRIORITY", indexes: [1], labels: ["Burst Lightning [2] — Burst Lightning deals 2 damage to any target."] },
      { kind: "TARGET", indexes: [1], labels: ["p2 (2 life)"] },
      { kind: "PRIORITY", indexes: [0], labels: ["Pass"] },
    ];

    const sParam = await encodeSolutionToParam(steps);
    const decodedSteps = await decodeSolutionFromParam(sParam);
    expect(decodedSteps).toEqual(steps);

    const bundledUrl = await buildSolutionShareUrl("t01-burn", steps, "https://example.com/mtg-puzzle/#/");
    expect(bundledUrl).toMatch(/^https:\/\/example\.com\/mtg-puzzle\/#\/play\/t01-burn\?s=[A-Za-z0-9_-]+$/);
    const playRoute = parsePlayRouteLocation(bundledUrl);
    expect(playRoute?.id).toBe("t01-burn");
    expect(playRoute?.solutionParam).toBe(sParam);

    const p = createEmptyPuzzle("With Solution");
    const sharedUrl = await buildShareUrl(p, "play", "https://example.com/mtg-puzzle/", steps);
    expect(sharedUrl).toContain("&s=");
    const parsedShared = parseShareLocation(sharedUrl);
    expect(parsedShared?.mode).toBe("play");
    expect(parsedShared?.solutionParam).toBe(sParam);

    // Playtest puzzle ID ("playtest-*") must encode full puzzle + solution (#/play?p=...&s=...)
    const playtestUrl = await buildSolutionShareUrl({
      puzzleId: "playtest-deck-1",
      puzzle: p,
      steps,
      baseHref: "https://example.com/mtg-puzzle/#/",
    });
    expect(playtestUrl).toContain("#/play?p=");
    expect(playtestUrl).toContain("&s=");
    expect(parseShareLocation(playtestUrl)?.solutionParam).toBe(sParam);

    const imported = await parsePuzzleInput(sharedUrl);
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.puzzle.solution).toEqual(steps);
    }
  });

  it("snapshots current board from GameView and extracts deck from shared playtest puzzle", () => {
    const deck = {
      id: "deck-test",
      name: "Burn Playtest",
      cards: [
        { cardId: "Mountain", count: 3 },
        { cardId: "Lightning Bolt", count: 2 },
      ],
      updatedAt: 1000,
    };
    const initial = buildPlaytestPuzzle(
      deck,
      ["Mountain", "Lightning Bolt"],
      ["Mountain", "Mountain", "Lightning Bolt"],
    );

    const view: GameView = {
      turn: 3,
      phase: "MAIN2",
      activePlayer: "p1",
      priorityPlayer: "p1",
      stack: [],
      combat: [],
      players: [
        {
          id: "p1",
          life: 18,
          poison: 0,
          manaPool: { R: 1 },
          handCount: 1,
          libraryCount: 2,
          cards: [
            makeCardView({ instanceId: "h1", name: "Mountain", zone: "Battlefield", tapped: true }),
            makeCardView({ instanceId: "tok1", name: "Goblin Token", zone: "Battlefield", token: true }),
            makeCardView({ instanceId: "h2", name: "Lightning Bolt", zone: "Graveyard" }),
            makeCardView({ instanceId: "l1", name: "Mountain", zone: "Hand" }),
          ],
        },
        {
          id: "p2",
          life: 17,
          poison: 0,
          manaPool: {},
          handCount: 0,
          libraryCount: 0,
          cards: [],
        },
      ],
    };

    const snap = snapshotPuzzleFromView(initial, view);
    expect(snap.game.turn).toBe(3);
    expect(snap.game.phase).toBe("main2");
    expect(snap.game.players[0].life).toBe(18);
    expect(snap.game.players[0].manaPool).toBe("R");
    // Pure token ("Goblin Token") is excluded so Forge validation does not fail
    expect(snap.game.players[0].battlefield).toEqual([
      { id: "h1", cardId: "Mountain", tapped: true },
    ]);
    expect(snap.game.players[0].hand).toEqual([
      { id: "l1", cardId: "Mountain" },
    ]);
    expect(snap.game.players[0].graveyard).toEqual([
      { id: "h2", cardId: "Lightning Bolt" },
    ]);
    // Remaining library cards (l2, l3) are preserved in order
    expect(snap.game.players[0].library?.map((c) => c.id)).toEqual(["l2", "l3"]);

    const extracted = extractDeckFromPlaytestPuzzle(snap);
    expect(extracted).not.toBeNull();
    expect(extracted?.cards).toEqual([
      { cardId: "Mountain", count: 3 },
      { cardId: "Lightning Bolt", count: 2 },
    ]);
  });
});
