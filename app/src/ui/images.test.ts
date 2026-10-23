import { describe, expect, it, vi } from "vitest";
import { cardImage, ensureCardImages, imageOf, isTokenName, japaneseOf, tokenBaseName, tokenImageOf, type ScryfallCard } from "./images";
import { puzzleCardNames } from "../engine/client";

const uris = (k: string) => ({ normal: `https://img/${k}/normal.jpg`, small: `https://img/${k}/small.jpg` });

describe("Scryfall の応答から画像を取り出す", () => {
  it("1 面のカードは image_uris、両面カードは指定した面（無ければ 1 面目）の画像", () => {
    expect(imageOf({ name: "Chrome Dome", artist: "A", image_uris: uris("cd") })).toEqual({ ...uris("cd"), artist: "A" });
    expect(imageOf({ name: "A // B", card_faces: [{ name: "A", image_uris: uris("a") }, { name: "B", image_uris: uris("b") }] })).toEqual(uris("a"));
    expect(imageOf({ name: "Food // Squirrel", card_faces: [{ name: "Food", image_uris: uris("f") }, { name: "Squirrel", image_uris: uris("s") }] }, "Squirrel")).toEqual(uris("s"));
    expect(imageOf({ name: "No Image" })).toBeNull();
  });

  it("日本語版は通常の版を優先し、無ければ特殊な版。日本語の名前の無い版は使わない", () => {
    const promo: ScryfallCard = { name: "X", printed_name: "プロモ", promo: true, image_uris: uris("p") };
    const plain: ScryfallCard = { name: "X", printed_name: "通常", printed_text: "文", image_uris: uris("n") };
    const noName: ScryfallCard = { name: "X", image_uris: uris("e") };
    expect(japaneseOf({ data: [noName, promo, plain] })).toEqual({ name: "通常", text: "文", ...uris("n") });
    expect(japaneseOf({ data: [promo] })?.name).toBe("プロモ");
    expect(japaneseOf({ data: [noName] })).toBeUndefined();
    expect(japaneseOf(null)).toBeUndefined();
  });

  it("トークンは '<Name> Token' から元の名前を取り出し、片面・通常版を優先して画像を取り出す", () => {
    expect(isTokenName("Squirrel Token")).toBe(true);
    expect(isTokenName("Lightning Bolt")).toBe(false);
    expect(tokenBaseName("Eldrazi Spawn Token")).toBe("Eldrazi Spawn");

    const dfc: ScryfallCard = { name: "Food // Squirrel", card_faces: [{ name: "Food", image_uris: uris("f") }, { name: "Squirrel", image_uris: uris("s-dfc") }] };
    const promo: ScryfallCard = { name: "Squirrel", promo: true, image_uris: uris("s-promo") };
    const plain: ScryfallCard = { name: "Squirrel", artist: "B", image_uris: uris("s-plain") };
    expect(tokenImageOf({ data: [dfc, promo, plain] }, "Squirrel")).toEqual({ ...uris("s-plain"), artist: "B" });
    expect(tokenImageOf({ data: [dfc] }, "Squirrel")).toEqual(uris("s-dfc"));
  });

  it("トークンの日本語版は printed_name が無くても画像があれば採用する", () => {
    const jaToken: ScryfallCard = { name: "Food", artist: "T", image_uris: uris("food-ja") };
    expect(japaneseOf({ data: [jaToken] }, true, "Food")).toEqual({ ...uris("food-ja"), artist: "T" });
  });

  it("ensureCardImages は '<Name> Token' を is:token で検索してキャッシュする", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const s = String(url);
      if (s.includes("lang%3Aja")) {
        return new Response(JSON.stringify({ data: [{ name: "Otter", artist: "JA", image_uris: uris("otter-ja") }] }), { status: 200 });
      }
      if (s.includes("is%3Atoken")) {
        return new Response(JSON.stringify({ data: [{ name: "Otter", artist: "EN", image_uris: uris("otter-en") }] }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const changed = await ensureCardImages(["Otter Token"]);
      expect(changed).toBe(true);
      expect(cardImage("Otter Token")?.normal).toMatch(/otter-(ja|en)\/normal\.jpg$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("問題で使うカード名", () => {
  it("どのゾーンのカードも重複なく集め、形の違うところは飛ばす", () => {
    const puzzle = {
      game: {
        players: [
          { hand: [{ cardId: "Island" }], battlefield: [{ cardId: "Redshift, Rocketeer Chief" }, { cardId: "Island" }] },
          { graveyard: [{ cardId: "Murder" }], library: [{ cardId: "" }, {}], exile: "x" },
        ],
      },
    };
    expect(puzzleCardNames(puzzle).sort()).toEqual(["Island", "Murder", "Redshift, Rocketeer Chief"]);
    expect(puzzleCardNames(null)).toEqual([]);
  });
});
