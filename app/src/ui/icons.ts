// 線画のアイコン（SVG の path。色は文字色に合わせる）とアバター。
// mtgtable（mtg-playtest の GUI、MIT。public/icons/LICENSE-mtgtable.txt）の render.js / play.js から取り込んだ。

const SVG = "http://www.w3.org/2000/svg";
const BASE = import.meta.env.BASE_URL;

export const ICON = {
  // フェイズ
  beginning: "M4 17h16M7 17a5 5 0 0 1 10 0M12 4v3M5.6 8.6l2.1 2.1M18.4 8.6l-2.1 2.1M2 13h3M19 13h3", // 日の出
  main1: "M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM9 7h6M9 10h6", // カード
  combat: "M4 4l11 11M15 15l-2 3M15 15l3-2M20 4L9 15M9 15l2 3M9 15l-3-2M3 21l3-3M21 21l-3-3", // 剣を交差
  main2: "M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM9 7h6M9 10h6",
  ending: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z", // 月
  // 優先権（挙げた手）
  priority: "M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5v-8a1.5 1.5 0 0 1 3 0V12M14 11.5V5a1.5 1.5 0 0 1 3 0v7"
    + "M17 9.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1.5a7 7 0 0 1-5.6-2.8L3.3 14.6a1.5 1.5 0 0 1 2.4-1.8L8 15.5",
  // 操作のボタン
  next: "M5 5l7 7-7 7M12 5l7 7-7 7", // 次へ（»）
  endTurn: "M5 5l9 7-9 7zM18 5v14", // 最後まで（▶|）
  pass: "M12 20V5M6 11l6-6 6 6", // 相手に渡す（↑）
  attack: "M4 4l11 11M15 15l-2 3M15 15l3-2M20 4L9 15M9 15l2 3M9 15l-3-2M3 21l3-3M21 21l-3-3",
  resolve: "M12 2l2.5 6.5L21 9l-5 4.5L17.5 21 12 17l-5.5 4L8 13.5 3 9l6.5-.5z", // 星
  stack: "M12 3l9 5-9 5-9-5zM3 12.5l9 5 9-5M3 17l9 5 9-5", // 積み重ね（スタックに積む）
} as const;

export type IconName = keyof typeof ICON;

export function icon(name: IconName, cls = ""): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", ICON[name]);
  svg.append(path);
  return svg;
}

/** プレイヤーのアイコン: あなたはフードの魔道士、相手（自動でパスする）は古のドラゴン */
export function avatarUrl(kind: "human" | "ai"): string {
  return `${BASE}icons/avatar-${kind}.png`;
}

/** プレイヤーの丸形ポートレート（トップ画面の対決表示など） */
export function portraitUrl(kind: "human" | "ai"): string {
  return `${BASE}icons/portrait-${kind}.png`;
}

/** トップ画面ヒーロー用の背景イラスト */
export function heroArtUrl(kind: "human" | "ai"): string {
  return `${BASE}icons/hero-${kind}.jpg`;
}
