import { describe, expect, it } from "vitest";
import { imageOf, japaneseOf, type ScryfallCard } from "./images";
import { puzzleCardNames } from "../engine/client";

const uris = (k: string) => ({ normal: `https://img/${k}/normal.jpg`, small: `https://img/${k}/small.jpg` });

describe("Scryfall の応答から画像を取り出す", () => {
  it("1 面のカードは image_uris、両面カードは 1 面目の画像", () => {
    expect(imageOf({ name: "Chrome Dome", artist: "A", image_uris: uris("cd") })).toEqual({ ...uris("cd"), artist: "A" });
    expect(imageOf({ name: "A // B", card_faces: [{ image_uris: uris("a") }, { image_uris: uris("b") }] })).toEqual(uris("a"));
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
