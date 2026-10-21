// 対象を選んでいる間、スタックの呪文・能力からカーソルへ矢印を出す。
// 候補（.cand のカード・プレイヤー）の上では、その中心に吸い付く。カーソルの無いタッチでは出さない。
// 矢印は body の直下の層（押せない）に描き、盤面の描き直しとは別に、カーソルの動きに合わせて描き直す。

const SVG = "http://www.w3.org/2000/svg";

export class TargetArrow {
  private readonly svg: SVGSVGElement;
  private readonly line: SVGPathElement;
  private readonly head: SVGPathElement;
  private origin: HTMLElement | null = null;
  private cursor: { x: number; y: number } | null = null;
  private frame = 0;

  constructor() {
    this.svg = document.createElementNS(SVG, "svg");
    this.svg.classList.add("targetarrow");
    this.svg.setAttribute("aria-hidden", "true");
    this.line = document.createElementNS(SVG, "path");
    this.line.classList.add("line");
    this.head = document.createElementNS(SVG, "path");
    this.head.classList.add("head");
    this.svg.append(this.line, this.head);
    document.body.append(this.svg);
    window.addEventListener("pointermove", this.onMove, { passive: true });
    window.addEventListener("scroll", this.schedule, { passive: true, capture: true });
  }

  /** 矢印の元（スタックの項目）。描き直しで要素が入れ替わるたびに渡す */
  setOrigin(el: HTMLElement | null) {
    this.origin = el;
    this.schedule();
  }

  dispose() {
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("scroll", this.schedule, { capture: true });
    cancelAnimationFrame(this.frame);
    this.svg.remove();
  }

  private readonly onMove = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    this.cursor = { x: e.clientX, y: e.clientY };
    this.schedule();
  };

  private readonly schedule = () => {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  };

  private draw() {
    const from = this.origin?.isConnected ? (this.origin.querySelector<HTMLElement>(".card") ?? this.origin).getBoundingClientRect() : null;
    const sx = from ? from.left + from.width / 2 : 0;
    const sy = from ? from.top + from.height / 2 : 0;
    // 元が見えないとき（小窓を畳んだ・狭い画面の Log の引き出しに隠れた）は出さない
    const covered = from && !this.origin!.contains(document.elementFromPoint(sx, sy));
    if (!from || !from.width || !this.cursor || covered) {
      this.svg.classList.add("off");
      return;
    }
    this.svg.classList.remove("off");
    // 候補の上なら、その中心に吸い付く
    const hit = document.elementFromPoint(this.cursor.x, this.cursor.y) as HTMLElement | null;
    const cand = hit?.closest<HTMLElement>(".board .card.cand, .board .phead.cand");
    // プレイヤーの見出しは横に長く、中心が小窓に隠れやすいので、ライフの所を指す
    const aim = cand?.classList.contains("phead") ? cand.querySelector<HTMLElement>(".life") ?? cand : cand;
    const to = aim && !aim.closest("[data-targeting]") ? aim.getBoundingClientRect() : null;
    const ex = to ? to.left + to.width / 2 : this.cursor.x;
    const ey = to ? to.top + to.height / 2 : this.cursor.y;
    this.svg.classList.toggle("snap", !!to);
    // 少し上に膨らむ曲線。制御点は中点から、線に垂直に距離の 1/4 だけ上へ
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy) || 1;
    const lift = Math.min(160, len / 4);
    let nx = -dy / len;
    let ny = dx / len;
    if (ny > 0) { nx = -nx; ny = -ny; } // いつも上側に膨らませる
    const cx = (sx + ex) / 2 + nx * lift;
    const cy = (sy + ey) / 2 + ny * lift;
    // 矢じりは、終点での接線の向きに置く（線は矢じりの根元で止める）
    const tx = ex - cx;
    const ty = ey - cy;
    const tl = Math.hypot(tx, ty) || 1;
    const ux = tx / tl;
    const uy = ty / tl;
    const size = 18;
    const bx = ex - ux * size;
    const by = ey - uy * size;
    this.line.setAttribute("d", `M${sx},${sy} Q${cx},${cy} ${bx},${by}`);
    const w = size * 0.6;
    this.head.setAttribute("d", `M${ex},${ey} L${bx - uy * w},${by + ux * w} L${bx + uy * w},${by - ux * w} Z`);
  }
}
