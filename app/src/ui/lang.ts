// 言語の切り替え（日本語・English）。言語の名前は訳さない。
import { lang, setLang, t, type Lang } from "../i18n";
import { h } from "./dom";

const NAMES: Record<Lang, string> = { ja: "日本語", en: "English" };

export function langSwitch(): HTMLElement {
  const box = h("span.lang", { role: "group", "aria-label": t("lang.label") });
  for (const l of ["ja", "en"] as Lang[]) {
    box.append(h("button" + (lang() === l ? ".on" : ""), {
      type: "button", lang: l, "aria-pressed": String(lang() === l), onclick: () => setLang(l),
    }, NAMES[l]));
  }
  return box;
}
