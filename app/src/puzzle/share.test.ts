import { describe, expect, it } from "vitest";
import { createEmptyPuzzle, addCardToPuzzle, setCardCounter, adjustPlayerMana } from "../ui/edit";
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
  toBase64Url,
} from "./share";
import type { SolutionStep } from "./solution";

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

  it("encodes and decodes solution steps in bundled and shared URLs", async () => {
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

    const imported = await parsePuzzleInput(sharedUrl);
    expect(imported.ok).toBe(true);
    if (imported.ok) {
      expect(imported.puzzle.solution).toEqual(steps);
    }
  });
});
