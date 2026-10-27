import { beforeEach, describe, expect, it } from "vitest";
import { puzzleTitle, setLang } from "../i18n";
import { indexCardData, type RawCardData } from "./carddb";
import {
  buildPlaytestPuzzle,
  canKeepHand,
  deckDescription,
  deckTitle,
  deckTotalCount,
  finalizeKeep,
  formatDeckList,
  mulliganAgain,
  parseDeckList,
  SAMPLE_DECKS,
  startMulligan,
  toggleBottomCard,
} from "./deck";
import { validatePuzzle } from "./schema";

const SAMPLE_RAW_DB: RawCardData = {
  keys: {},
  cards: [
    {
      f: "l/lightning_bolt.txt",
      s: "Name:Lightning Bolt\nManaCost:R\nTypes:Instant\nOracle:Lightning Bolt deals 3 damage to any target.",
      j: "Lightning Bolt|稲妻|インスタント|稲妻は任意の対象１つに３点のダメージを与える。",
    },
    {
      f: "m/mountain.txt",
      s: "Name:Mountain\nManaCost:no cost\nTypes:Basic Land Mountain\nOracle:({T}: Add {R}.)",
      j: "Mountain|山|基本土地 — 山|（{T}：{R}を加える。）",
    },
    {
      f: "m/monastery_swiftspear.txt",
      s: "Name:Monastery Swiftspear\nManaCost:R\nTypes:Creature Human Monk\nPT:1/2\nOracle:Haste\\nProwess",
      j: "Monastery Swiftspear|僧院の速槍|クリーチャー — 人間・モンク|速攻\\n果敢",
    },
    {
      f: "b/bonecrusher_giant.txt",
      s: "Name:Bonecrusher Giant\nManaCost:2 R\nTypes:Creature Giant\nPT:4/3\nAlternateMode:Adventure\nOracle:...\nALTERNATE\nName:Stomp\nManaCost:1 R\nTypes:Instant Adventure\nOracle:...",
      j: "Bonecrusher Giant|砕骨の巨人|クリーチャー — 巨人|...\nStomp|踏みつけ|インスタント — 出来事|...",
    },
  ],
};

describe("deck", () => {
  beforeEach(() => {
    indexCardData(SAMPLE_RAW_DB);
  });

  it("parseDeckList: 英語・日本語・MTGアリーナ形式・サイドボードを正しく解析する", () => {
    const raw = `
      // メインデッキ
      Deck
      4 Lightning Bolt (STA) 42
      4x 僧院の速槍
      砕骨の巨人 // 踏みつけ x2
      20 山 (FDN) 279 *F*
      1 Unknown Mystery Card

      Sideboard
      2 稲妻
      SB: 1 Monastery Swiftspear
    `;
    const res = parseDeckList(raw);
    expect(res.cards).toEqual([
      { cardId: "Lightning Bolt", count: 4 },
      { cardId: "Monastery Swiftspear", count: 4 },
      { cardId: "Bonecrusher Giant", count: 2 },
      { cardId: "Mountain", count: 20 },
    ]);
    expect(deckTotalCount(res.cards)).toBe(30);
    expect(res.sideboard).toEqual([
      { cardId: "Lightning Bolt", count: 2 },
      { cardId: "Monastery Swiftspear", count: 1 },
    ]);
    expect(res.unknown).toEqual([{ line: 8, raw: "1 Unknown Mystery Card" }]);
  });

  it("formatDeckList: 日本語・英語それぞれの形式でテキスト出力できる", () => {
    const deck = {
      cards: [
        { cardId: "Lightning Bolt", count: 4 },
        { cardId: "Mountain", count: 20 },
      ],
      sideboard: [{ cardId: "Monastery Swiftspear", count: 2 }],
    };
    expect(formatDeckList(deck, "ja")).toBe("4 稲妻\n20 山\n\nSideboard\n2 僧院の速槍");
    expect(formatDeckList(deck, "en")).toBe("4 Lightning Bolt\n20 Mountain\n\nSideboard\n2 Monastery Swiftspear");
  });

  it("ロンドン・マリガンとボトム送りが正しく動作する", () => {
    const entries = [
      { cardId: "Lightning Bolt", count: 4 },
      { cardId: "Mountain", count: 6 },
    ];
    let state = startMulligan(entries, () => 0.5);
    expect(state.hand).toHaveLength(7);
    expect(state.library).toHaveLength(3);
    expect(state.mulliganCount).toBe(0);
    expect(canKeepHand(state)).toBe(true);

    // 1回マリガン
    state = mulliganAgain(state, () => 0.2);
    expect(state.mulliganCount).toBe(1);
    expect(state.hand).toHaveLength(7);
    expect(canKeepHand(state)).toBe(false);

    // 1枚ボトム送りを選ぶ
    const chosenCard = state.hand[2];
    state = toggleBottomCard(state, 2);
    expect(canKeepHand(state)).toBe(true);

    const kept = finalizeKeep(state);
    expect(kept.hand).toHaveLength(6);
    expect(kept.library).toHaveLength(4);
    expect(kept.library[kept.library.length - 1]).toBe(chosenCard);
  });

  it("buildPlaytestPuzzle: validatePuzzle を通過する有効な PuzzleJson を生成する", () => {
    const puzzle = buildPlaytestPuzzle(
      { name: "赤単テスト" },
      ["Lightning Bolt", "Mountain", "Mountain", "Monastery Swiftspear", "Mountain", "Lightning Bolt", "Mountain"],
      ["Mountain", "Lightning Bolt", "Mountain"],
    );
    const v = validatePuzzle(puzzle);
    expect(v.ok).toBe(true);
    expect(puzzle.goal.deadline).toBe("none");
    expect(puzzle.game.players[0].hand).toHaveLength(7);
    expect(puzzle.game.players[0].library).toHaveLength(3);
    expect(puzzle.game.players[1].life).toBe(20);
    expect(puzzle.game.players[1].library).toHaveLength(60);
  });

  it("サンプルデッキのタイトル・説明・プレイテストタイトルが言語切替（JA/EN）に対応する", () => {
    const sample = SAMPLE_DECKS[0];
    setLang("ja");
    expect(deckTitle(sample)).toBe("赤単バーン (サンプル)");
    expect(deckDescription(sample)).toContain("軽量火力");

    setLang("en");
    expect(deckTitle(sample)).toBe("Mono-Red Burn (Sample)");
    expect(deckDescription(sample)).toContain("Classic aggro deck");

    const puzzle = buildPlaytestPuzzle(sample, ["Lightning Bolt"], ["Mountain"]);
    setLang("ja");
    expect(puzzleTitle(puzzle)).toBe("赤単バーン (サンプル) — 一人回し");
    setLang("en");
    expect(puzzleTitle(puzzle)).toBe("Mono-Red Burn (Sample) — Playtest");
    setLang("ja");
  });
});
