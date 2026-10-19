// DOM を組み立てる小さな道具。フレームワークは使わない（D7）。

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

/** h("div.card.tapped", { title: "x", onclick: fn }, ...children) */
export function h<K extends keyof HTMLElementTagNameMap>(tagAndClasses: K | `${K}.${string}`, attrs?: Attrs | null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K];
export function h(tagAndClasses: string, attrs?: Attrs | null, ...children: (Child | Child[])[]): HTMLElement;
export function h(tagAndClasses: string, attrs?: Attrs | null, ...children: (Child | Child[])[]): HTMLElement {
  const [tag, ...classes] = tagAndClasses.split(".");
  const el = document.createElement(tag);
  if (classes.length) el.className = classes.join(" ");
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2), v as EventListener);
      } else if (k === "class") {
        el.className = [el.className, String(v)].filter(Boolean).join(" ");
      } else if (k.startsWith("data-") || k.startsWith("aria-") || k === "role" || k === "title" || k === "type" || k === "disabled") {
        el.setAttribute(k, v === true ? "" : String(v));
      } else {
        (el as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: (Child | Child[])[]) {
  for (const c of children) {
    if (Array.isArray(c)) append(el, c);
    else if (c === null || c === undefined || c === false) continue;
    else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * 長押し（タッチ）と右クリックで詳細を出し、ふつうのタップ・クリックは onTap に渡す。
 * 長押しの後のクリックは捨てる。
 */
export function onTapOrHold(el: HTMLElement, onTap: (ev: Event) => void, onHold: () => void) {
  let timer = 0;
  let held = false;
  el.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType !== "touch") return;
    held = false;
    timer = window.setTimeout(() => { held = true; onHold(); }, 450);
  });
  const cancel = () => window.clearTimeout(timer);
  el.addEventListener("pointerup", cancel);
  el.addEventListener("pointerleave", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); onHold(); });
  el.addEventListener("click", (ev) => {
    if (held) { held = false; ev.preventDefault(); return; }
    onTap(ev);
  });
}
