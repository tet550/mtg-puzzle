// 浮かぶ小窓を見出しのドラッグで動かす（mtgtable の setupFloat と同じ考え方）。動かした位置は小窓ごとにこの端末に覚え、
// 描き直しても同じ所に出す。位置は近い方の端（左右・上下）からの距離で覚えるので、窓の大きさが変わっても端に付いたまま。

interface Pos { x: number; y: number; right: boolean; bottom: boolean }

const PREFIX = "mtg-puzzle.float.";
const cache = new Map<string, Pos | null>();
const boundHeads = new WeakSet<HTMLElement>();
const activeFloats = new Map<string, HTMLElement>();

function load(key: string): Pos | null {
  if (cache.has(key)) return cache.get(key)!;
  let p: Pos | null = null;
  try {
    p = JSON.parse(localStorage.getItem(PREFIX + key) || "null") as Pos | null;
  } catch {
    p = null;
  }
  cache.set(key, p);
  return p;
}

function save(key: string, p: Pos) {
  cache.set(key, p);
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(p));
  } catch {
    // 覚えられなくても、この表示の間は効く
  }
}

/** 小窓が置かれる範囲（position: fixed なら画面、absolute なら親の箱） */
function area(el: HTMLElement): DOMRect {
  if (getComputedStyle(el).position === "fixed") return new DOMRect(0, 0, document.documentElement.clientWidth, window.innerHeight);
  return (el.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

function place(el: HTMLElement, p: Pos) {
  const b = area(el);
  const w = el.offsetWidth, h = el.offsetHeight;
  if (b.width < 60 || b.height < 60 || !w) return;
  const x = Math.max(0, Math.min(p.right ? b.width - w - p.x : p.x, b.width - w));
  const y = Math.max(0, Math.min(p.bottom ? b.height - h - p.y : p.y, b.height - h));
  Object.assign(el.style, { left: `${x}px`, top: `${y}px`, right: "auto", bottom: "auto" });
  el.classList.add("moved");
}

/** 小窓（.float）を動かせるようにする。DOM に入れた後に呼ぶ */
export function setupFloat(el: HTMLElement, key: string) {
  activeFloats.set(key, el);
  const head = el.querySelector<HTMLElement>(".fhead");
  const saved = load(key);
  if (saved && !el.classList.contains("dragging")) place(el, saved);
  if (!head || boundHeads.has(head)) return;
  boundHeads.add(head);
  head.addEventListener("pointerdown", (ev) => {
    if ((ev.target as HTMLElement).closest("button")) return;
    ev.preventDefault();
    const b = area(el);
    const r = el.getBoundingClientRect();
    const dx = ev.clientX - r.left, dy = ev.clientY - r.top;
    el.classList.add("dragging");
    head.setPointerCapture(ev.pointerId);
    const move = (e: PointerEvent) => {
      const x = Math.max(0, Math.min(e.clientX - b.left - dx, b.width - el.offsetWidth));
      const y = Math.max(0, Math.min(e.clientY - b.top - dy, b.height - el.offsetHeight));
      Object.assign(el.style, { left: `${x}px`, top: `${y}px`, right: "auto", bottom: "auto" });
      el.classList.add("moved");
    };
    const up = () => {
      head.removeEventListener("pointermove", move);
      el.classList.remove("dragging");
      const nb = area(el), w = el.offsetWidth, h = el.offsetHeight;
      const x = el.offsetLeft, y = el.offsetTop;
      const right = x + w / 2 > nb.width / 2, bottom = y + h / 2 > nb.height / 2;
      save(key, { x: right ? nb.width - w - x : x, y: bottom ? nb.height - h - y : y, right, bottom });
    };
    head.addEventListener("pointermove", move);
    head.addEventListener("pointerup", up, { once: true });
    head.addEventListener("pointercancel", up, { once: true });
  });
}

// ---------------------------------------------------------------- 手札の扇

/** 扇の傾き: 中央からの位置を、端が ±3 になるように縮める（枚数が多くても傾きすぎない） */
export function fanTilt(row: HTMLElement) {
  const n = row.children.length, mid = (n - 1) / 2;
  [...row.children].forEach((c, i) => (c as HTMLElement).style.setProperty("--off", ((i - mid) * 3 / Math.max(3, mid)).toFixed(2)));
}

/** 横にスクロールさせず、重なりを詰めて幅に収める（--ov）。入るなら CSS の既定の重なりのまま */
export function fitHand(row: HTMLElement) {
  row.style.removeProperty("--ov");
  const cards = row.children as HTMLCollectionOf<HTMLElement>, n = cards.length;
  if (n < 2) return;
  const cs = getComputedStyle(row);
  const room = row.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const first = cards[0], last = cards[n - 1];
  if (last.offsetLeft - first.offsetLeft + last.offsetWidth <= room) return;
  const w = Math.max(...[...cards].map((c) => c.offsetWidth));
  const gap = parseFloat(cs.columnGap) || 0;
  row.style.setProperty("--ov", `${Math.floor((room - w) / (n - 1) - w - gap)}px`);
}

const watched = new WeakSet<HTMLElement>();
const observer = typeof ResizeObserver === "function" ? new ResizeObserver((es) => es.forEach((e) => fitHand(e.target as HTMLElement))) : null;

/** 描いた後に、手札の扇を整える（画像が読み込まれて幅が変わったときも） */
export function fitHands(root: ParentNode) {
  for (const row of root.querySelectorAll<HTMLElement>(".hand.fan")) {
    fanTilt(row);
    if (!watched.has(row)) {
      watched.add(row);
      observer?.observe(row);
      row.addEventListener("load", () => fitHand(row), true);
    }
    fitHand(row);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    for (const [key, el] of activeFloats) {
      if (!el.isConnected) {
        activeFloats.delete(key);
        continue;
      }
      const saved = load(key);
      if (saved && !el.classList.contains("dragging")) place(el, saved);
    }
    for (const row of document.querySelectorAll<HTMLElement>(".hand.fan")) fitHand(row);
  });
}
