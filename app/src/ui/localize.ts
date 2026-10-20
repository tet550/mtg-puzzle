// エンジン（Forge）由来の文を、画面の言語で出す（design/option-i18n.md の方式 A）。
// 日本語の画面では、Adapter が返す日本語の文（Forge の訳。labelJa / descriptionJa）を使う。
// Forge の訳が無い文は、よく出るキーワード能力・与えられる能力だけ、ここの雛形で日本語にする。
// それでも訳せない文は英語のまま（カード名は画面の言語の名前に差し替える）。

import { lang } from "../i18n";

const JA_CHARS = /[ぁ-んァ-ヶ一-龠]/;
/** 英語の語が 2 つ続く所があれば、本文が英語のまま（カード名だけ日本語に差し替わった文など） */
const ENGLISH_PHRASE = /[A-Za-z]{3,} [a-z]{2,}/;

/** 雛形（英語の文 → 日本語の文）。Forge の訳の対応表に無い、与えられる能力・キーワードの注釈など */
const SUPPLEMENT: [RegExp, (m: RegExpMatchArray) => string][] = [
  // 搭乗（注釈つき）
  [/^Crew (\d+)(?: \(.*\))?$/, (m) => `搭乗${m[1]}`],
  // 装備
  [/^Equip (\{[^}]+\}(?:\{[^}]+\})*)(?: \(.*\))?$/, (m) => `装備${m[1]}`],
  // 食物
  [/^\{2\}, \{T\}, Sacrifice this (?:permanent|artifact|creature): You gain 3 life\.$/, () => "{2}, {T}, これを生け贄に捧げる：あなたは3点のライフを得る。"],
  // 宝物
  [/^\{T\}, Sacrifice this (?:permanent|artifact): Add one mana of any color\.$/, () => "{T}, これを生け贄に捧げる：好きな色1色のマナ1点を加える。"],
  // 手掛かり
  [/^\{2\}, Sacrifice this (?:permanent|artifact): Draw a card\.$/, () => "{2}, これを生け贄に捧げる：カードを1枚引く。"],
  // マナ能力
  [/^\{T\}: Add (\{[^}]+\}(?:\{[^}]+\})*)\.$/, (m) => `{T}：${m[1]}を加える。`],
  [/^\{T\}: Add (\{[^}]+\}) or (\{[^}]+\})\.$/, (m) => `{T}：${m[1]}か${m[2]}を加える。`],
];

/** 英語の文を雛形で日本語にする（当てはまらなければ null） */
export function supplementJa(text: string): string | null {
  const s = text.replace(/\s+/g, " ").trim();
  for (const [re, f] of SUPPLEMENT) {
    const m = s.match(re);
    if (m) return f(m);
  }
  return null;
}

/** 画面の言語の文。ja は Adapter が返した日本語の文（無ければ null） */
export function localized(en: string, ja: string | null | undefined): string {
  if (lang() !== "ja") return en;
  if (ja && JA_CHARS.test(ja) && !ENGLISH_PHRASE.test(ja)) return ja;
  return supplementJa(en) ?? ja ?? en;
}
