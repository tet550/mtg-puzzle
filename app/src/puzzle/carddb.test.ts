import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { displayName, printedText } from "../ui/images";
import { cardMeta, formatForgeManaCost, indexCardData, normalizeQuery, parseCardEntry, parseForgeTypes, searchCards, type RawCardData } from "./carddb";

const SAMPLE_DATA: RawCardData = {
  keys: {
    "lightning bolt": 0,
    "llanowar elves": 1,
    mountain: 2,
    "bonecrusher giant": 3,
    stomp: 3,
  },
  cards: [
    {
      f: "lightning_bolt.txt",
      s: "Name:Lightning Bolt\nManaCost:R\nTypes:Instant\nOracle:Lightning Bolt deals 3 damage to any target.\n",
      j: "Lightning Bolt|稲妻|インスタント|クリーチャーやプレインズウォーカーやプレイヤーのうち１つを対象とする。稲妻はそれに３点のダメージを与える。\n",
    },
    {
      f: "llanowar_elves.txt",
      s: "Name:Llanowar Elves\nManaCost:G\nTypes:Creature Elf Druid\nPT:1/1\nOracle:{T}: Add {G}.\n",
      j: "Llanowar Elves|ラノワールのエルフ|クリーチャー — エルフ・ドルイド|{T}：{G}を加える。\n",
    },
    {
      f: "mountain.txt",
      s: "Name:Mountain\nManaCost:no cost\nTypes:Basic Land Mountain\nOracle:({T}: Add {R}.)\n",
      j: "Mountain|山|基本土地 — 山|{R}\n",
    },
    {
      f: "bonecrusher_giant.txt",
      s: "Name:Bonecrusher Giant\nManaCost:2 R\nTypes:Creature Giant\nPT:4/3\nOracle:Whenever Bonecrusher Giant becomes the target of a spell, Bonecrusher Giant deals 2 damage to that spell's controller.\n\nALTERNATE\n\nName:Stomp\nManaCost:1 R\nTypes:Instant Adventure\nOracle:Damage can't be prevented this turn. Stomp deals 2 damage to any target.\n",
      j: "Bonecrusher Giant|砕骨の巨人|クリーチャー — 巨人|砕骨の巨人が呪文の対象になるたび、砕骨の巨人はその呪文のコントローラーに２点のダメージを与える。\nStomp|踏みつけ|インスタント — 出来事|このターン、ダメージは軽減できない。\n",
    },
  ],
  tokens: {
    c_a_treasure_sac: {
      s: "Name:Treasure Token\nTypes:Artifact Treasure\nOracle:{T}, Sacrifice this token: Add one mana of any color.\n",
      j: "Treasure Token|宝物・トークン|トークン・アーティファクト — 宝物|{T}, このトークンを生け贄に捧げる：好きな色のマナ１点を加える。\n",
    },
  },
};

describe("carddb", () => {
  it("Forge のマナコストとタイプ行を変換する", () => {
    expect(formatForgeManaCost("2 R")).toBe("{2}{R}");
    expect(formatForgeManaCost("no cost")).toBe("");
    expect(parseForgeTypes("Legendary Creature Human Wizard")).toEqual({
      kinds: ["creature"],
      typeLine: "Legendary Creature — Human Wizard",
    });
    expect(parseForgeTypes("Basic Land Mountain")).toEqual({
      kinds: ["land"],
      typeLine: "Basic Land — Mountain",
    });
  });

  it("カード定義（出来事の裏面・日本語名つき）を解析する", () => {
    const meta = parseCardEntry(SAMPLE_DATA.cards[3]);
    expect(meta).not.toBeNull();
    expect(meta?.name).toBe("Bonecrusher Giant");
    expect(meta?.altNames).toEqual(["Stomp"]);
    expect(meta?.jaName).toBe("砕骨の巨人");
    expect(meta?.altJaNames).toEqual(["踏みつけ"]);
    expect(meta?.manaCost).toBe("{2}{R}");
    expect(meta?.kinds).toEqual(["creature"]);
    expect(meta?.basePower).toBe(4);
    expect(meta?.baseToughness).toBe(3);
  });

  it("英語名・日本語名・ひらがな・2面目の名前で検索できる", () => {
    indexCardData(SAMPLE_DATA);
    expect(cardMeta("lightning bolt")?.name).toBe("Lightning Bolt");
    expect(cardMeta("Stomp")?.name).toBe("Bonecrusher Giant");

    expect(searchCards("Bolt").map((c) => c.name)).toEqual(["Lightning Bolt"]);
    expect(searchCards("稲妻").map((c) => c.name)).toEqual(["Lightning Bolt"]);
    // ひらがな「らのわーる」でも「ラノワールのエルフ」にヒットする
    expect(normalizeQuery("らのわーる")).toBe("ラノワール");
    expect(searchCards("らのわーる").map((c) => c.name)).toEqual(["Llanowar Elves"]);
    // 出来事の面「踏みつけ」で探しても主カード名 Bonecrusher Giant が返る
    expect(searchCards("踏みつけ").map((c) => c.name)).toEqual(["Bonecrusher Giant"]);

    // images.ts の displayName / printedText のフォールバックとしても働く（2面目やトークンも含む）
    setLang("ja");
    expect(displayName("Lightning Bolt")).toBe("稲妻");
    expect(printedText("Llanowar Elves")).toContain("{G}を加える");
    expect(displayName("Stomp")).toBe("踏みつけ");
    expect(printedText("Stomp")).toBe("このターン、ダメージは軽減できない。");
    expect(displayName("Treasure Token")).toBe("宝物・トークン");
    expect(printedText("Treasure Token")).toContain("好きな色のマナ１点を加える");
  });

  it("public/engine/manifest.json の cards から実データを展開・インデックス化できる", () => {
    const engineDir = resolve(__dirname, "../../public/engine");
    const manifest = JSON.parse(readFileSync(resolve(engineDir, "manifest.json"), "utf-8")) as { cards?: string; cardData?: string };
    const cardsFile = manifest.cards ?? manifest.cardData;
    expect(cardsFile).toBeTruthy();

    const gz = readFileSync(resolve(engineDir, cardsFile!));
    const jsonText = gunzipSync(gz).toString("utf-8");
    const raw = JSON.parse(jsonText) as RawCardData;
    const list = indexCardData(raw);
    expect(list.length).toBeGreaterThan(20000);
    expect(cardMeta("Lightning Bolt")?.jaName).toBe("稲妻");
    expect(searchCards("稲妻", 5)[0]?.name).toBe("Lightning Bolt");
    // 分割カード（AlternateMode: Split）は Forge の Card.getName() と同じ "Fire // Ice" になる
    const fireIce = cardMeta("Fire");
    expect(fireIce?.name).toBe("Fire // Ice");
    expect(cardMeta("Ice")?.name).toBe("Fire // Ice");
    expect(cardMeta("Fire // Ice")?.name).toBe("Fire // Ice");
  });
});
