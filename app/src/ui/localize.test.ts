import { describe, expect, it } from "vitest";
import { setLang } from "../i18n";
import { localized, supplementJa } from "./localize";

describe("選択肢の日本語（方式 A）", () => {
  it("日本語の画面では Forge の訳を使い、英語の画面では英語のまま", () => {
    setLang("ja");
    expect(localized("Destroy target artifact.", "アーティファクト１つを対象とし、それを破壊する。")).toBe("アーティファクト１つを対象とし、それを破壊する。");
    setLang("en");
    expect(localized("Destroy target artifact.", "アーティファクト１つを対象とし、それを破壊する。")).toBe("Destroy target artifact.");
    setLang("ja");
  });

  it("訳が無い（または英語のまま返ってきた）文は雛形で補う", () => {
    expect(localized("Crew 1 (Tap any number of creatures you control with total power 1 or more: Adrestia becomes an artifact creature until end of turn.)",
      "Crew 1 (Tap any number of creatures you control with total power 1 or more: アドレスティア号 becomes an artifact creature until end of turn.)")).toBe("搭乗1");
    expect(supplementJa("{2}, {T}, Sacrifice this permanent: You gain 3 life.")).toBe("{2}, {T}, これを生け贄に捧げる：あなたは3点のライフを得る。");
    expect(supplementJa("{T}: Add {B}.")).toBe("{T}：{B}を加える。");
    expect(supplementJa("{T}: Add {U} or {B}.")).toBe("{T}：{U}か{B}を加える。");
    expect(supplementJa("Equip {2}")).toBe("装備{2}");
  });

  it("雛形にも当てはまらなければ、Forge の文（英語）のまま", () => {
    expect(localized("Look at target opponent's hand.", null)).toBe("Look at target opponent's hand.");
  });
});
