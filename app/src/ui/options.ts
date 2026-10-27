// オプション画面（画像・演出・言語）。どの画面でも上の帯の「オプション」から開く <dialog>。
// 切り替えは localStorage に覚え、開いている画面には onChange で描き直してもらう（言語は onLangChange で全体が描き直る）。
import { onLangChange, t } from "../i18n";
import { h } from "./dom";
import { imagesEnabled, setImagesEnabled } from "./images";
import { langSwitch } from "./lang";
import { motionEnabled, setMotionEnabled } from "./motion";

export function optionsButton(onChange: () => void): HTMLElement {
  return h("button.opts-btn", {
    type: "button",
    "data-action": "open-options",
    title: t("options.title"),
    onclick: () => openOptionsDialog(onChange),
  }, "⚙ ", h("span.opts-label", null, t("options.button")));
}

export function openOptionsDialog(onChange: () => void): HTMLDialogElement {
  document.querySelectorAll("dialog.options-dialog").forEach((d) => d.remove());
  const dialog = h("dialog.options-dialog", { closedby: "any", "aria-labelledby": "options-dialog-title" }) as HTMLDialogElement;

  // <dialog closedby> に対応していないブラウザ向け: 外側のクリックで閉じる
  if (typeof HTMLDialogElement !== "undefined" && !("closedBy" in HTMLDialogElement.prototype)) {
    dialog.addEventListener("click", (event: MouseEvent) => {
      if (event.target === dialog) dialog.close();
    });
  }

  const unsubLang = onLangChange(() => {
    if (dialog.isConnected) render();
  });
  dialog.addEventListener("close", () => {
    unsubLang();
    dialog.remove();
  });

  const toggle = (key: string, on: boolean, set: (on: boolean) => void) =>
    h("button.opts-toggle" + (on ? ".on" : ""), {
      type: "button",
      role: "switch",
      "data-option": key,
      "aria-checked": String(on),
      onclick: () => { set(!on); onChange(); render(); },
    }, t(on ? "options.on" : "options.off"));

  const row = (label: string, desc: string, control: HTMLElement) =>
    h("div.opts-row", null,
      h("div.opts-text", null, h("div.opts-name", null, label), h("div.opts-desc.muted", null, desc)),
      control);

  const render = () => {
    dialog.replaceChildren(
      h("div.opts-box", null,
        h("div.opts-head", null,
          h("h2", { id: "options-dialog-title" }, t("options.title")),
          h("button.opts-close", { type: "button", title: t("card.close"), onclick: () => dialog.close() }, "×")),
        row(t("header.images"), t("header.images.title"), toggle("images", imagesEnabled(), setImagesEnabled)),
        row(t("header.motion"), t("header.motion.title"), toggle("motion", motionEnabled(), setMotionEnabled)),
        row(t("lang.label"), t("options.lang.desc"), langSwitch()),
      ),
    );
  };

  render();
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
