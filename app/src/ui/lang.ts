// 言語の切り替え（日本語・English）。言語の名前も画面の言語で出す（英語の画面では Japanese / English）。
import { lang, setLang, t, type Lang } from "../i18n";
import { h } from "./dom";

export function langSwitch(): HTMLElement {
  const box = h("span.lang", { role: "group", "aria-label": t("lang.label") });
  for (const l of ["ja", "en"] as Lang[]) {
    box.append(h("button" + (lang() === l ? ".on" : ""), {
      type: "button", "data-key": `lang-${l}`, "aria-pressed": String(lang() === l), onclick: () => setLang(l),
    }, t(l === "ja" ? "lang.ja" : "lang.en")));
  }
  return box;
}
