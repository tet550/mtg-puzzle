import { describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { indexCardData, type RawCardData } from "../puzzle/carddb";
import { deckColorIcons } from "./deck";
import { displayTypeLine } from "./images";

const SAMPLE_RAW_DB: RawCardData = {
  keys: {},
  cards: [
    {
      f: "l/lightning_bolt.txt",
      s: "Name:Lightning Bolt\nManaCost:R\nTypes:Instant\nOracle:Lightning Bolt deals 3 damage to any target.",
      j: "Lightning Bolt|稲妻|インスタント|稲妻は任意の対象１つに３点のダメージを与える。",
    },
    {
      f: "c/counterspell.txt",
      s: "Name:Counterspell\nManaCost:U U\nTypes:Instant\nOracle:Counter target spell.",
      j: "Counterspell|対抗呪文|インスタント|呪文１つを対象とし、それを打ち消す。",
    },
    {
      f: "f/forest.txt",
      s: "Name:Forest\nManaCost:no cost\nTypes:Basic Land Forest\nOracle:({T}: Add {G}.)",
      j: "Forest|森|基本土地 — 森|（{T}：{G}を加える。）",
    },
  ],
};

describe("deck UI pure helpers", () => {
  it("deckColorIcons computes canonical WUBRG mana symbol string from spells and basic lands", () => {
    indexCardData(SAMPLE_RAW_DB);
    expect(deckColorIcons([])).toBe("{C}");
    expect(
      deckColorIcons([
        { cardId: "Lightning Bolt", count: 4 },
        { cardId: "Counterspell", count: 4 },
        { cardId: "Forest", count: 10 },
      ]),
    ).toBe("{U}{R}{G}");
  });

  it("displayTypeLine localizes card typeLine in JA and preserves English in EN", () => {
    indexCardData(SAMPLE_RAW_DB);
    setLang("ja");
    expect(displayTypeLine("Lightning Bolt", "Instant")).toBe("インスタント");
    expect(displayTypeLine("Forest", "Basic Land — Forest")).toBe("基本土地 — 森");
    setLang("en");
    expect(displayTypeLine("Lightning Bolt", "Instant")).toBe("Instant");
    expect(displayTypeLine("Forest", "Basic Land — Forest")).toBe("Basic Land — Forest");
    setLang("ja");
  });
});
