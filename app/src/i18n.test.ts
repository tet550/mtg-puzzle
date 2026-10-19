import { describe, expect, it } from "vitest";
import { lang, setLang, t } from "./i18n";
import { en } from "./i18n/en";
import { ja } from "./i18n/ja";

describe("i18n", () => {
  it("日本語と英語の辞書のキーがそろっている", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ja).sort());
    for (const [k, v] of Object.entries(en)) expect(v, k).not.toBe("");
  });

  it("言語を切り替えると文が変わり、{名前} を置き換える", () => {
    setLang("en");
    expect(lang()).toBe("en");
    expect(t("opp.lands", { n: 4, untapped: 2 })).toBe("Lands 4 (2 untapped)");
    setLang("ja");
    expect(t("opp.lands", { n: 4, untapped: 2 })).toBe("土地 4（アンタップ 2）");
  });

  it("どちらの辞書でも、文の中の {名前} が同じ", () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(ja) as (keyof typeof ja)[]) expect(names(en[k]), k).toEqual(names(ja[k]));
  });
});
