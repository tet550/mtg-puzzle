// DOM を組み立てる小さな道具。フレームワークは使わない（D7）。

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

const listenerMap = new WeakMap<Element, Map<string, EventListener>>();
const boundTypes = new WeakMap<Element, Set<string>>();

interface TapHold {
  onTap: (ev: Event) => void;
  onHold: () => void;
}
const tapHoldMap = new WeakMap<HTMLElement, TapHold>();
const tapHoldBound = new WeakSet<HTMLElement>();

/** 描画の外（float.ts / play.ts / motion.ts / board.ts）で付け外しされる実行時クラス */
const RUNTIME_CLASSES = new Set(["moved", "dragging", "dropover", "noimg", "mv"]);

/** 状態を表す修飾クラス（要素の構造的な同一性の判定から除外する） */
const STATE_CLASSES = new Set([
  "cand", "chosen", "flash", "tapped", "withart", "mod", "on", "off", "cur",
  "dead", "low", "active", "min", "withlog", "withpanelmin", "overlap", "kgap",
  "empty", "open", "locked", "soft", "targeting", "cleared", "failed", "error",
  "moved", "dragging", "dropover", "noimg", "mv",
]);

function setListener(el: Element, type: string, fn: EventListener) {
  let map = listenerMap.get(el);
  if (!map) {
    map = new Map();
    listenerMap.set(el, map);
  }
  map.set(type, fn);
  let bound = boundTypes.get(el);
  if (!bound) {
    bound = new Set();
    boundTypes.set(el, bound);
  }
  if (!bound.has(type)) {
    bound.add(type);
    el.addEventListener(type, (ev) => {
      listenerMap.get(el)?.get(type)?.(ev);
    });
  }
}

function syncListeners(dom: Element, next: Element) {
  const nextMap = listenerMap.get(next);
  const domMap = listenerMap.get(dom);
  if (!nextMap || nextMap.size === 0) {
    domMap?.clear();
    return;
  }
  if (domMap) {
    for (const k of [...domMap.keys()]) {
      if (!nextMap.has(k)) domMap.delete(k);
    }
  }
  for (const [type, fn] of nextMap) {
    setListener(dom, type, fn);
  }
}

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
        setListener(el, k.slice(2), v as EventListener);
      } else if (k === "class") {
        el.className = [el.className, String(v)].filter(Boolean).join(" ");
      } else {
        el.setAttribute(k, v === true ? "" : String(v));
        if (k === "disabled" && "disabled" in el) (el as HTMLButtonElement).disabled = true;
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
  tapHoldMap.set(el, { onTap, onHold });
  ensureTapOrHold(el);
}

function ensureTapOrHold(el: HTMLElement) {
  if (tapHoldBound.has(el)) return;
  tapHoldBound.add(el);
  let timer = 0;
  let held = false;
  let sx = 0, sy = 0;
  el.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType !== "touch") return;
    held = false;
    sx = ev.clientX;
    sy = ev.clientY;
    timer = window.setTimeout(() => { held = true; tapHoldMap.get(el)?.onHold(); }, 450);
  });
  // 指を動かしたら長押しにしない（手札のドラッグ）
  el.addEventListener("pointermove", (ev) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) window.clearTimeout(timer); });
  const cancel = () => window.clearTimeout(timer);
  el.addEventListener("pointerup", cancel);
  el.addEventListener("pointerleave", cancel);
  el.addEventListener("pointercancel", cancel);
  el.addEventListener("contextmenu", (ev) => { ev.preventDefault(); tapHoldMap.get(el)?.onHold(); });
  el.addEventListener("click", (ev) => {
    if (held) { held = false; ev.preventDefault(); return; }
    tapHoldMap.get(el)?.onTap(ev);
  });
}

function syncTapOrHold(dom: Element, next: Element) {
  if (!(dom instanceof HTMLElement) || !(next instanceof HTMLElement)) return;
  const th = tapHoldMap.get(next);
  if (th) {
    tapHoldMap.set(dom, th);
    ensureTapOrHold(dom);
  } else {
    tapHoldMap.delete(dom);
  }
}

// ---------------------------------------------------------------- 差分更新（Reconciliation）

type MoveableParent = Element & { moveBefore?: (node: Node, child: Node | null) => void };

/**
 * 既存の DOM 要素を移動するとき、対応ブラウザでは moveBefore を使って CSS アニメーション（candPulse）や
 * :hover などの要素状態を失わずに移動する。
 */
function moveOrInsertBefore(parent: Element, node: Node, referenceNode: Node | null) {
  if (node === referenceNode || (node.parentNode === parent && node.nextSibling === referenceNode)) return;
  if (
    referenceNode !== undefined &&
    node.parentNode &&
    node.ownerDocument === parent.ownerDocument &&
    parent.isConnected &&
    node.isConnected &&
    "moveBefore" in Element.prototype &&
    node instanceof Element
  ) {
    try {
      (parent as MoveableParent).moveBefore!(node, referenceNode);
      return;
    } catch {
      // 階層制約などで失敗した場合は insertBefore にフォールバック
    }
  }
  parent.insertBefore(node, referenceNode);
}

function elementKey(el: Element): string | null {
  if (el instanceof HTMLElement) {
    const d = el.dataset;
    if (d.id) return `id:${d.id}`;
    if (d.key) return `key:${d.key}`;
    if (d.player) return `player:${d.player}`;
    if (d.pile) return `pile:${d.owner ?? ""}:${d.pile}`;
    if (d.group) return `group:${d.group}`;
    if (d.zone) return `zone:${d.zone}`;
    if (d.source) return `src:${d.source}`;
    if (d.option) return `opt:${d.option}`;
    if (d.quick) return `quick:${d.quick}`;
    if (d.special) return `special:${d.special}`;
    if (d.confirm) return `confirm:${d.confirm}`;
    if (d.clear) return `clear:${d.clear}`;
  }
  const lang = el.getAttribute("lang");
  if (lang) return `lang:${lang}`;
  return null;
}

function structuralSig(el: Element): string {
  const base: string[] = [];
  for (const c of el.classList) {
    if (!STATE_CLASSES.has(c)) base.push(c);
  }
  base.sort();
  return `${el.namespaceURI ?? ""}:${el.tagName}.${base.join(".")}`;
}

function canPatch(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType === Node.TEXT_NODE) return true;
  if (a instanceof Element && b instanceof Element) {
    const ka = elementKey(a);
    const kb = elementKey(b);
    if (ka !== null || kb !== null) return ka === kb;
    return structuralSig(a) === structuralSig(b);
  }
  return false;
}

function syncClasses(dom: Element, next: Element) {
  if (dom.getAttribute("class") === next.getAttribute("class")) return;
  for (const c of [...dom.classList]) {
    if (!next.classList.contains(c) && !RUNTIME_CLASSES.has(c)) {
      dom.classList.remove(c);
    }
  }
  for (const c of next.classList) {
    if (!dom.classList.contains(c)) {
      dom.classList.add(c);
    }
  }
}

function syncStyle(dom: HTMLElement, next: HTMLElement) {
  if (dom.classList.contains("moved") || dom.classList.contains("dragging")) return;
  const off = dom.style.getPropertyValue("--off");
  const ov = dom.style.getPropertyValue("--ov");
  const nextStyle = next.getAttribute("style");
  if (nextStyle !== null) {
    if (dom.getAttribute("style") !== nextStyle) dom.setAttribute("style", nextStyle);
  } else if (dom.hasAttribute("style")) {
    dom.removeAttribute("style");
  }
  if (off && !next.style.getPropertyValue("--off")) dom.style.setProperty("--off", off);
  if (ov && !next.style.getPropertyValue("--ov")) dom.style.setProperty("--ov", ov);
}

function syncAttributes(dom: Element, next: Element) {
  syncClasses(dom, next);
  if (dom instanceof HTMLElement && next instanceof HTMLElement) {
    syncStyle(dom, next);
  }
  for (const attr of [...dom.attributes]) {
    if (attr.name === "class" || attr.name === "style") continue;
    if (!next.hasAttribute(attr.name)) {
      dom.removeAttribute(attr.name);
      if (attr.name === "disabled" && "disabled" in dom) (dom as HTMLButtonElement).disabled = false;
    }
  }
  for (const attr of next.attributes) {
    if (attr.name === "class" || attr.name === "style") continue;
    if (dom.getAttribute(attr.name) !== attr.value) {
      dom.setAttribute(attr.name, attr.value);
    }
    if (attr.name === "disabled" && "disabled" in dom) (dom as HTMLButtonElement).disabled = true;
  }
}

function buildCardPool(domScope: Element, nextScope: Element, selector: string): Map<string, HTMLElement> {
  const nextIds = new Set<string>();
  for (const el of nextScope.querySelectorAll<HTMLElement>(selector)) {
    if (el.dataset.id) nextIds.add(el.dataset.id);
  }
  const pool = new Map<string, HTMLElement>();
  for (const el of domScope.querySelectorAll<HTMLElement>(selector)) {
    const id = el.dataset.id;
    if (id && nextIds.has(id) && !pool.has(id)) pool.set(id, el);
  }
  return pool;
}

function patchNode(dom: Node, next: Node, cardPool?: Map<string, HTMLElement>) {
  if (dom === next) return;
  if (dom.nodeType === Node.TEXT_NODE && next.nodeType === Node.TEXT_NODE) {
    if (dom.textContent !== next.textContent) dom.textContent = next.textContent;
    return;
  }
  if (!(dom instanceof Element) || !(next instanceof Element)) return;

  syncAttributes(dom, next);
  syncListeners(dom, next);
  syncTapOrHold(dom, next);

  // 画像の読み込み失敗で .noimg になっている枠は、同じ URL の画像で上書きしない
  if (dom.classList.contains("artbox") && dom.classList.contains("noimg") && next.classList.contains("artbox")) {
    return;
  }

  let scopedPool = cardPool;
  let ownsPool = false;
  if (dom.tagName === "SECTION" && dom.classList.contains("board")) {
    scopedPool = buildCardPool(dom, next, ":scope > .side .card[data-id]");
    ownsPool = true;
  } else if (dom.classList.contains("stackbox") || dom.classList.contains("combatbox")) {
    scopedPool = buildCardPool(dom, next, ".card[data-id]");
    ownsPool = true;
  }

  patchChildrenInternal(dom, next, scopedPool);

  if (ownsPool && scopedPool) {
    for (const leftover of scopedPool.values()) {
      leftover.remove();
    }
  }
}

function patchChildrenInternal(parent: Element, nextParent: Element, cardPool?: Map<string, HTMLElement>) {
  const existingNodes = Array.from(parent.childNodes);
  const keyed = new Map<string, Element>();
  const existingCounts = new Map<string, number>();
  const nodeKeys = new Map<Node, string>();

  for (const node of existingNodes) {
    if (node instanceof Element) {
      const raw = elementKey(node);
      if (raw) {
        const n = existingCounts.get(raw) ?? 0;
        existingCounts.set(raw, n + 1);
        const k = `${raw}#${n}`;
        keyed.set(k, node);
        nodeKeys.set(node, k);
      }
    }
  }

  const nextNodes = Array.from(nextParent.childNodes);
  const nextCounts = new Map<string, number>();
  const nextKeys: (string | null)[] = new Array(nextNodes.length).fill(null);
  const claimed = new Set<Node>();
  const targets: (Node | undefined)[] = new Array(nextNodes.length);

  // 1a. キー付き要素の引き当て（同じ親の子 → 領域内の cardPool の順）
  for (let i = 0; i < nextNodes.length; i++) {
    const next = nextNodes[i];
    if (!(next instanceof Element)) continue;
    const raw = elementKey(next);
    if (!raw) continue;
    const n = nextCounts.get(raw) ?? 0;
    nextCounts.set(raw, n + 1);
    const k = `${raw}#${n}`;
    nextKeys[i] = k;

    let t: Node | undefined = keyed.get(k);
    if (!t && next instanceof HTMLElement && next.dataset.id && cardPool) {
      t = cardPool.get(next.dataset.id);
    }
    if (t && !claimed.has(t)) {
      targets[i] = t;
      claimed.add(t);
      if (next instanceof HTMLElement && next.dataset.id && cardPool) {
        cardPool.delete(next.dataset.id);
      }
    }
  }

  // 1b. キーなし要素・テキストノードの引き当て
  let searchIdx = 0;
  for (let i = 0; i < nextNodes.length; i++) {
    if (targets[i] || nextKeys[i] !== null) continue;
    const next = nextNodes[i];
    for (let j = searchIdx; j < existingNodes.length; j++) {
      const cand = existingNodes[j];
      if (claimed.has(cand) || nodeKeys.has(cand)) continue;
      if (canPatch(cand, next)) {
        targets[i] = cand;
        claimed.add(cand);
        if (j === searchIdx) searchIdx++;
        break;
      }
    }
  }

  // 2a. 使われなくなった既存の子の削除（別の束へ moveBefore される cardPool 内のカードは残す）
  for (const node of existingNodes) {
    if (!claimed.has(node) && node.parentNode === parent) {
      if (node instanceof HTMLElement && node.dataset.id && cardPool?.get(node.dataset.id) === node) continue;
      parent.removeChild(node);
    }
  }

  // 2b. 順番どおりに配置・差分更新
  let cursor: ChildNode | null = parent.firstChild;
  for (let i = 0; i < nextNodes.length; i++) {
    while (cursor && !claimed.has(cursor)) {
      cursor = cursor.nextSibling;
    }
    const next = nextNodes[i];
    const target = targets[i];
    if (target) {
      if (target === cursor) {
        cursor = cursor.nextSibling;
      } else {
        moveOrInsertBefore(parent, target, cursor);
      }
      patchNode(target, next, cardPool);
    } else if (next instanceof Element && cardPool && cardPool.size > 0 && next.querySelector(".card[data-id]")) {
      // 新しく作られた束や行の中に既存のカード（cardPool）が含まれる場合は、外枠だけ先に繋いでから中身を差分更新する
      const shell = next.cloneNode(false) as Element;
      syncListeners(shell, next);
      syncTapOrHold(shell, next);
      moveOrInsertBefore(parent, shell, cursor);
      patchNode(shell, next, cardPool);
    } else {
      moveOrInsertBefore(parent, next, cursor);
    }
  }
}

/** 親要素の子を差分更新する（既存の DOM 要素・CSS アニメーション・ホバー状態を保つ） */
export function patchChildren(parent: Element, ...children: (Child | Child[])[]) {
  const temp = document.createElement(parent.tagName);
  append(temp, children);
  patchChildrenInternal(parent, temp);
}
