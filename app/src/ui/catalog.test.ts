import { describe, expect, it } from "vitest";
import type { CatalogEntry } from "../puzzle/catalog";
import { matchesCatalogFilter, selectNextPuzzle } from "./catalog";
import { avatarUrl, heroArtUrl, portraitUrl } from "./icons";

const SAMPLE: CatalogEntry[] = [
  { id: "t01-burn", title: "チュートリアル 1：火力呪文を唱える", description: "手札の《ショック》を相手プレイヤーに唱えて、ライフを0にしましょう。", category: "tutorial", sourceFile: null },
  { id: "e01-prowess", title: "簡単な問題 1：果敢の連撃", description: "《僧院の速槍》の果敢で8点を削り切りましょう。", category: "easy", sourceFile: null },
];

describe("catalog helpers", () => {
  it("selects the first unsolved puzzle, or falls back to the first puzzle when all are cleared", () => {
    expect(selectNextPuzzle(SAMPLE, new Set())?.id).toBe("t01-burn");
    expect(selectNextPuzzle(SAMPLE, new Set(["t01-burn"]))?.id).toBe("e01-prowess");
    expect(selectNextPuzzle(SAMPLE, new Set(["t01-burn", "e01-prowess"]))?.id).toBe("t01-burn");
  });

  it("filters entries by category and solved status", () => {
    const cleared = new Set(["t01-burn"]);
    expect(SAMPLE.filter((e) => matchesCatalogFilter(e, "all", cleared)).map((e) => e.id)).toEqual(["t01-burn", "e01-prowess"]);
    expect(SAMPLE.filter((e) => matchesCatalogFilter(e, "tutorial", cleared)).map((e) => e.id)).toEqual(["t01-burn"]);
    expect(SAMPLE.filter((e) => matchesCatalogFilter(e, "easy", cleared)).map((e) => e.id)).toEqual(["e01-prowess"]);
    expect(SAMPLE.filter((e) => matchesCatalogFilter(e, "combo", cleared)).map((e) => e.id)).toEqual([]);
    expect(SAMPLE.filter((e) => matchesCatalogFilter(e, "unsolved", cleared)).map((e) => e.id)).toEqual(["e01-prowess"]);
    expect(SAMPLE.filter((e) => matchesCatalogFilter(e, "cleared", cleared)).map((e) => e.id)).toEqual(["t01-burn"]);
  });

  it("resolves character icon, portrait, and hero art URLs", () => {
    expect(avatarUrl("human")).toMatch(/icons\/avatar-human\.png$/);
    expect(avatarUrl("ai")).toMatch(/icons\/avatar-ai\.png$/);
    expect(portraitUrl("human")).toMatch(/icons\/portrait-human\.png$/);
    expect(portraitUrl("ai")).toMatch(/icons\/portrait-ai\.png$/);
    expect(heroArtUrl("human")).toMatch(/icons\/hero-human\.jpg$/);
    expect(heroArtUrl("ai")).toMatch(/icons\/hero-ai\.jpg$/);
  });
});
