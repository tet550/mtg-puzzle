// SNS 投稿・盤面画像（Canvas 2D）生成モーダル。
// - パズル出題時（初期盤面）やパズルクリア時（クリア報告＋盤面画像）、一人回し盤面の共有に対応。
// - 1200×675 (16:9) の高解像度盤面スナップショット PNG を Canvas 2D で描画し、
//   X (Twitter) 投稿、Web Share API（画像ファイル添付）、クリップボード画像コピー、PNG 保存を提供する。

import type { CardView, GameView, PlayerView } from "../engine/protocol";
import { onLangChange, puzzleTitle, t, type MessageKey } from "../i18n";
import { cardMeta } from "../puzzle/carddb";
import type { PuzzleJson } from "../puzzle/schema";
import { buildShareUrl, buildSolutionShareUrl, snapshotPuzzleFromView } from "../puzzle/share";
import type { SolutionStep } from "../puzzle/solution";
import { h } from "./dom";
import { cardImage, displayName, ensureCardImages, imagesEnabled } from "./images";
import { previewView } from "./play";
import { phaseName } from "./text";

export const BOARD_IMAGE_WIDTH = 1200;
export const BOARD_IMAGE_HEIGHT = 675;

export type SnsShareKind = "clear" | "puzzle" | "playtest";
export type SnsBoardMode = "initial" | "current";
export type SnsOpponentBoardMode = "important" | "none" | "all";
export type SnsUrlMode = "puzzle" | "solution";

export interface BoardImageOptions {
  view: GameView;
  title: string;
  shareKind: SnsShareKind;
  boardMode?: SnsBoardMode;
  opponentBoardMode?: SnsOpponentBoardMode;
  stepsCount?: number;
  isPlaytest?: boolean;
  useCardArt?: boolean;
}

export interface SnsPostTextOptions {
  title: string;
  shareKind: SnsShareKind;
  stepsCount?: number;
  isPlaytest?: boolean;
}

export interface OpenSnsShareDialogOptions {
  puzzleId?: string;
  puzzle: PuzzleJson;
  initialView?: GameView;
  currentView?: GameView | null;
  shareKind: SnsShareKind;
  steps?: SolutionStep[] | null;
  defaultBoardMode?: SnsBoardMode;
}

interface CardGroup {
  card: CardView;
  count: number;
}

/** 投稿本文（URL を除くメッセージ＋ハッシュタグ）を組み立てる */
export function buildSnsPostText(opts: SnsPostTextOptions): string {
  const title = opts.title.trim() || t("editor.defaultTitle");
  if (opts.shareKind === "clear") {
    if (opts.stepsCount && opts.stepsCount > 0) {
      return t("sns.template.clear", { title, n: opts.stepsCount });
    }
    return t("sns.template.clearNoSteps", { title });
  }
  if (opts.shareKind === "playtest" || opts.isPlaytest) {
    return t("sns.template.playtest", { title });
  }
  return t("sns.template.puzzle", { title });
}

/** 戦場や手札の同種・同状態カードを束ねる */
export function groupBoardCards(cards: CardView[]): CardGroup[] {
  const groups: CardGroup[] = [];
  const map = new Map<string, CardGroup>();
  for (const c of cards) {
    const countersKey = Object.entries(c.counters)
      .filter(([, v]) => v !== 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(",");
    const key = [
      c.name,
      c.tapped ? "T" : "U",
      c.sick ? "S" : "R",
      c.power ?? "",
      c.toughness ?? "",
      c.damage,
      countersKey,
      c.attachedTo ?? "",
    ].join("|");
    const existing = map.get(key);
    if (existing) {
      existing.count++;
    } else {
      const g: CardGroup = { card: c, count: 1 };
      map.set(key, g);
      groups.push(g);
    }
  }
  return groups;
}

function isLandCard(c: CardView): boolean {
  if (c.kinds.includes("land")) return true;
  if (c.typeLine && /\bland\b/i.test(c.typeLine)) return true;
  const norm = c.name.trim().toLowerCase();
  if (norm in BASIC_LAND_COLOR_BY_NAME) return true;
  const meta = cardMeta(c.name);
  return meta ? meta.kinds.includes("land") : false;
}

function isCreatureCard(c: CardView): boolean {
  if (c.kinds.includes("creature")) return true;
  if (c.typeLine && /\bcreature\b/i.test(c.typeLine)) return true;
  const meta = cardMeta(c.name);
  return meta ? meta.kinds.includes("creature") : false;
}

export type ManaColorKey = "W" | "U" | "B" | "R" | "G" | "C";

const BASIC_LAND_COLOR_BY_NAME: Record<string, ManaColorKey> = {
  plains: "W",
  "snow-covered plains": "W",
  island: "U",
  "snow-covered island": "U",
  swamp: "B",
  "snow-covered swamp": "B",
  mountain: "R",
  "snow-covered mountain": "R",
  forest: "G",
  "snow-covered forest": "G",
  wastes: "C",
  "snow-covered wastes": "C",
};

/**
 * 基本土地であれば対応するマナ色 ("W" | "U" | "B" | "R" | "G" | "C") を返す。
 * 特殊土地（デュアルランド・フェッチランド・ミシュラランド等）や非土地は null を返す。
 */
export function basicLandManaColor(c: CardView): ManaColorKey | null {
  if (!isLandCard(c)) return null;
  const norm = c.name.trim().toLowerCase();
  if (norm in BASIC_LAND_COLOR_BY_NAME) {
    return BASIC_LAND_COLOR_BY_NAME[norm];
  }
  const typeLine = (c.typeLine || cardMeta(c.name)?.typeLine || "").toLowerCase();
  if (typeLine.includes("basic")) {
    if (typeLine.includes("plains")) return "W";
    if (typeLine.includes("island")) return "U";
    if (typeLine.includes("swamp")) return "B";
    if (typeLine.includes("mountain")) return "R";
    if (typeLine.includes("forest")) return "G";
    return "C";
  }
  return null;
}

/**
 * カウンター・オーラ・クリーチャー化を伴わない純粋な基本土地かどうかを判定する。
 * 純粋な基本土地は戦場カード列には置かず、使用可能マナバーに集約する。
 */
export function isPlainBasicLand(c: CardView, allBfCards: readonly CardView[]): boolean {
  if (basicLandManaColor(c) === null) return false;
  if (isCreatureCard(c)) return false;
  if (Object.values(c.counters).some((v) => v !== 0)) return false;
  if (allBfCards.some((o) => o.attachedTo === c.instanceId)) return false;
  return true;
}

/**
 * プレイヤーの使用可能マナ（浮きマナプール＋アンタップ状態の基本土地から出るマナ）を集計する。
 */
export function computeAvailableMana(player: PlayerView): Record<ManaColorKey, number> {
  const out: Record<ManaColorKey, number> = {
    W: player.manaPool.W ?? 0,
    U: player.manaPool.U ?? 0,
    B: player.manaPool.B ?? 0,
    R: player.manaPool.R ?? 0,
    G: player.manaPool.G ?? 0,
    C: player.manaPool.C ?? 0,
  };
  const bfCards = player.cards.filter((c) => c.zone === "Battlefield");
  for (const c of bfCards) {
    if (!c.tapped && isPlainBasicLand(c, bfCards)) {
      const col = basicLandManaColor(c);
      if (col) out[col] += 1;
    }
  }
  return out;
}

function loadCorsImage(url: string, timeoutMs = 2200): Promise<HTMLImageElement | null> {
  if (typeof Image === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (res: HTMLImageElement | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    img.crossOrigin = "anonymous";
    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    img.src = url;
  });
}

async function preloadViewImages(view: GameView, enabled: boolean): Promise<Map<string, HTMLImageElement>> {
  const map = new Map<string, HTMLImageElement>();
  if (!enabled) return map;
  const names = new Set<string>();
  for (const p of view.players) {
    for (const c of p.cards) {
      if (
        c.zone === "Battlefield" ||
        c.zone === "Hand" ||
        c.zone === "Graveyard" ||
        c.zone === "Exile"
      ) {
        names.add(c.name);
      }
    }
  }
  if (names.size === 0) return map;
  try {
    await ensureCardImages([...names]);
  } catch {
    // オフライン環境等ではスキップ
  }
  await Promise.all(
    [...names].map(async (name) => {
      const info = cardImage(name);
      const url = info?.normal;
      if (!url) return;
      const img = await loadCorsImage(url);
      if (img) map.set(name, img);
    }),
  );
  return map;
}

/**
 * 相手の戦場カードを重要度モードに応じてフィルタリングする。
 * - "important"（既定）: 非土地パーマネントと特殊土地（またはカウンター・オーラ・クリーチャー化を伴う基本土地）を残し、
 *   通常の基本土地は戦場カードから省略する。
 * - "none": 相手の戦場をすべて省略（Life 表示のみ）。
 * - "all": 基本土地を含め相手の戦場カードをすべて表示。
 */
export function filterOpponentBoardCards(
  oppBfCards: CardView[],
  mode: SnsOpponentBoardMode = "important",
): { nonLandGroups: CardGroup[]; landGroups: CardGroup[] } {
  if (mode === "none") {
    return { nonLandGroups: [], landGroups: [] };
  }
  const nonLands = oppBfCards.filter((c) => !isLandCard(c));
  const lands = oppBfCards.filter((c) => isLandCard(c));
  if (mode === "all") {
    return {
      nonLandGroups: groupBoardCards(nonLands),
      landGroups: groupBoardCards(lands),
    };
  }
  const specialOrImportantLands = lands.filter((c) => !isPlainBasicLand(c, oppBfCards));
  return {
    nonLandGroups: groupBoardCards(nonLands),
    landGroups: groupBoardCards(specialOrImportantLands),
  };
}

/**
 * 自分の戦場カードを分類する。
 * 純粋な基本土地は使用可能マナバーに集約するため戦場からは除外し、
 * 非土地パーマネントと特殊土地（および状態を持つ基本土地）のみ戦場に並べる。
 */
export function filterPlayerBoardCards(
  myBfCards: CardView[],
): { nonLandGroups: CardGroup[]; landGroups: CardGroup[] } {
  const nonLands = myBfCards.filter((c) => !isLandCard(c));
  const specialLands = myBfCards.filter((c) => isLandCard(c) && !isPlainBasicLand(c, myBfCards));
  return {
    nonLandGroups: groupBoardCards(nonLands),
    landGroups: groupBoardCards(specialLands),
  };
}

/**
 * 盤面 (`GameView`) をリファレンスレイアウト（Life｜戦場 / VS / Life｜戦場 / 使用可能マナバー / 扇形手札）で `<canvas>` に描画する。
 */
export async function renderBoardImageCanvas(
  opts: BoardImageOptions,
  targetCanvas?: HTMLCanvasElement,
): Promise<HTMLCanvasElement> {
  const canvas = targetCanvas ?? (document.createElement("canvas") as HTMLCanvasElement);
  const useArt = opts.useCardArt ?? imagesEnabled();
  const artMap = await preloadViewImages(opts.view, useArt);
  drawBoardToCanvas(canvas, opts, artMap);
  return canvas;
}

/** 同期的に Canvas 2D コンテキストへ盤面を描画する（テストや再描画からも直接呼べる） */
export function drawBoardToCanvas(
  canvas: HTMLCanvasElement,
  opts: BoardImageOptions,
  artMap: ReadonlyMap<string, HTMLImageElement> = new Map(),
): void {
  // クリア時の盤面（shareKind === "clear" かつ boardMode !== "initial"）は
  // 戦場・墓地・追放の自軍カードを×でまとめずすべて重なり表示する概要画像（2:1〜3:4）にする
  if (opts.shareKind === "clear" && (opts.boardMode ?? "current") === "current") {
    drawClearSummaryToCanvas(canvas, opts, artMap);
    return;
  }

  const { view } = opts;
  const p1 = view.players.find((p) => p.id === "p1") ?? view.players[0];
  const p2 = view.players.find((p) => p.id === "p2") ?? view.players[1] ?? p1;

  const oppMode = opts.opponentBoardMode ?? "important";
  const oppBfAll = p2.cards.filter((c) => c.zone === "Battlefield");
  const { nonLandGroups: oppNonLandGroups, landGroups: oppLandGroups } = filterOpponentBoardCards(oppBfAll, oppMode);
  const oppGroups = [...oppNonLandGroups, ...oppLandGroups];
  const showOppCards = oppGroups.length > 0;

  const myBfAll = p1.cards.filter((c) => c.zone === "Battlefield");
  const { nonLandGroups: myNonLandGroups, landGroups: mySpecialLandGroups } = filterPlayerBoardCards(myBfAll);
  const myGroups = [...myNonLandGroups, ...mySpecialLandGroups];

  const myHandCards = p1.cards.filter((c) => c.zone === "Hand");
  const myHandGroups: CardGroup[] =
    myHandCards.length > 7
      ? groupBoardCards(myHandCards)
      : myHandCards.map((card) => ({ card, count: 1 }));

  const availMana = computeAvailableMana(p1);

  // レイアウト定数（リファレンス画像準拠のダークスレート枠＋最小余白）
  const PAD = 8;
  const HEADER_H = 24;
  const LIFE_COL_W = 112;
  const BF_PAD_X = 14;
  const BF_PAD_Y = 7;
  const CARD_W = 124;
  const CARD_H = 168;
  const CARD_GAP = 12;
  const VS_H = 18;
  const GAP_Y = 3;
  const MANA_BAR_H = 34;
  const HAND_CARD_W = 126;
  const HAND_CARD_H = 170;

  const oppCardSlots = Math.max(oppGroups.length, 4);
  const myCardSlots = Math.max(myGroups.length, 4);
  const oppBfNeededW = showOppCards
    ? LIFE_COL_W + BF_PAD_X * 2 + oppCardSlots * CARD_W + (oppCardSlots - 1) * CARD_GAP
    : 0;
  // 自分のライフ表示は省略するため、自分戦場は LIFE_COL_W を含めない
  const myBfNeededW = BF_PAD_X * 2 + myCardSlots * CARD_W + (myCardSlots - 1) * CARD_GAP;
  const handFanStepX = Math.round(HAND_CARD_W * 0.72);
  const handNeededW =
    myHandGroups.length > 0
      ? (myHandGroups.length - 1) * handFanStepX + HAND_CARD_W + 48
      : 0;

  const panelW = Math.max(
    640,
    Math.min(BOARD_IMAGE_WIDTH - PAD * 2, Math.max(oppBfNeededW, myBfNeededW, handNeededW)),
  );
  const W = panelW + PAD * 2;

  const oppBoxH = showOppCards ? CARD_H + BF_PAD_Y * 2 : 54;
  const myBoxH = myGroups.length > 0 ? CARD_H + BF_PAD_Y * 2 : 56;
  const handBoxH = myHandGroups.length > 0 ? HAND_CARD_H + 18 : 44;

  const H =
    PAD +
    HEADER_H +
    GAP_Y +
    oppBoxH +
    VS_H +
    myBoxH +
    GAP_Y +
    MANA_BAR_H +
    GAP_Y +
    handBoxH +
    PAD;

  canvas.width = W;
  canvas.height = H;

  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return;

  ctx.save();
  ctx.clearRect(0, 0, W, H);

  // 1. 全体背景（リファレンス画像の重厚なダークチャコール）
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, "#10151d");
  bgGrad.addColorStop(0.5, "#0c1017");
  bgGrad.addColorStop(1, "#090c12");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // 2. 上部スリムヘッダー（パズル名・クリア手数/目標・ターン）
  drawTopHeaderStrip(ctx, opts, PAD, PAD, panelW, HEADER_H);
  let curY = PAD + HEADER_H + GAP_Y;

  // 3. 相手ボックス（左：Life / 右：戦場カード または省略サマリー）
  const oppLandsAll = oppBfAll.filter((c) => isLandCard(c));
  const oppUntappedLands = oppLandsAll.filter((c) => !c.tapped).length;
  drawBattlefieldPanel(ctx, {
    player: p2,
    isViewer: false,
    groups: oppGroups,
    x: PAD,
    y: curY,
    w: panelW,
    h: oppBoxH,
    lifeColW: LIFE_COL_W,
    cardW: CARD_W,
    cardH: CARD_H,
    cardGap: CARD_GAP,
    padX: BF_PAD_X,
    artMap,
    omittedSummary:
      !showOppCards && oppLandsAll.length > 0
        ? t("opp.lands", { n: oppLandsAll.length, untapped: oppUntappedLands })
        : undefined,
  });
  curY += oppBoxH;

  // 4. 中央 VS ディバイダー（────────── VS ──────────）
  drawVsDivider(ctx, PAD, curY, panelW, VS_H);
  curY += VS_H;

  // 5. 自分ボックス（左：Life / 右：非土地パーマネント＋特殊土地）
  drawBattlefieldPanel(ctx, {
    player: p1,
    isViewer: true,
    groups: myGroups,
    x: PAD,
    y: curY,
    w: panelW,
    h: myBoxH,
    lifeColW: LIFE_COL_W,
    cardW: CARD_W,
    cardH: CARD_H,
    cardGap: CARD_GAP,
    padX: BF_PAD_X,
    artMap,
  });
  curY += myBoxH + GAP_Y;

  // スタックに呪文・能力がある場合は自分ボックス右上にバッジ表示
  if (view.stack.length > 0) {
    const topItem = view.stack[0];
    const stackLabel = `${t("stack.title", { n: view.stack.length })}: ${displayName(topItem.description)}`;
    ctx.font = "700 11px system-ui, -apple-system, 'Segoe UI', sans-serif";
    const sw = Math.min(panelW - 24, Math.ceil(ctx.measureText(stackLabel).width) + 18);
    fillRoundRect(ctx, PAD + panelW - sw - 8, curY - GAP_Y - 26, sw, 22, 11, "rgba(22, 39, 68, 0.95)", "#3b82f6");
    ctx.fillStyle = "#dbeafe";
    ctx.textBaseline = "middle";
    ctx.fillText(fitText(ctx, stackLabel, sw - 14), PAD + panelW - sw + 1, curY - GAP_Y - 15);
  }

  // 6. 使用可能マナバー（浮きマナ＋アンタップ基本土地をマナシンボル＋×Nで中央表示）
  drawAvailableManaBar(ctx, availMana, p1, PAD, curY, panelW, MANA_BAR_H);
  curY += MANA_BAR_H + GAP_Y;

  // 7. 手札ボックス（扇形ファン配置）
  drawHandFanPanel(ctx, myHandGroups, {
    x: PAD,
    y: curY,
    w: panelW,
    h: handBoxH,
    cardW: HAND_CARD_W,
    cardH: HAND_CARD_H,
    artMap,
  });

  ctx.restore();
}

/**
 * クリア時の盤面概要描画:
 * - アスペクト比 2:1 (W/H = 2.0) 〜 3:4 (W/H = 0.75) の範囲に収める。
 * - CLEARED!（x手）等のテキストバナーは表示しない。
 * - こちらの戦場・墓地・追放領域のカードを ×N でまとめずすべて個別に重ねて表示（タップ状態は反映しない）。
 */
function drawClearSummaryToCanvas(
  canvas: HTMLCanvasElement,
  opts: BoardImageOptions,
  artMap: ReadonlyMap<string, HTMLImageElement>,
): void {
  const { view } = opts;
  const p1 = view.players.find((p) => p.id === "p1") ?? view.players[0];
  const allP1Cards = p1 ? p1.cards : [];

  const bfCards = allP1Cards.filter((c) => c.zone === "Battlefield");
  const gyCards = allP1Cards.filter((c) => c.zone === "Graveyard");
  const exileCards = allP1Cards.filter((c) => c.zone === "Exile");

  const bfBasicLands = bfCards.filter((c) => isPlainBasicLand(c, bfCards));
  const bfSpecialLands = bfCards.filter((c) => isLandCard(c) && !isPlainBasicLand(c, bfCards));
  const bfNonLands = bfCards.filter((c) => !isLandCard(c));
  const gyExileLands = [...exileCards, ...gyCards].filter((c) => isLandCard(c));
  const gyExileNonLands = [...exileCards, ...gyCards].filter((c) => !isLandCard(c));

  // 奥（背面）に土地、中間に墓地・追放の呪文や特殊土地、最前面に戦場の非土地パーマネントが来るよう順序付け
  // タップ表示は反映しない（tapped: false に統一）
  const orderedCards: CardView[] = [
    ...bfBasicLands,
    ...gyExileLands,
    ...bfSpecialLands,
    ...gyExileNonLands,
    ...bfNonLands,
  ].map((c) => ({ ...c, tapped: false }));

  const n = orderedCards.length;
  const PAD = 6;
  const CARD_W = 156;
  const CARD_H = 212;

  // 1列で重要な後半のカードが中央（最前面）に来るよう左右交互に振り分ける
  const arranged: CardView[] = new Array(n);
  let left = 0;
  let right = n - 1;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      arranged[left++] = orderedCards[i];
    } else {
      arranged[right--] = orderedCards[i];
    }
  }

  const maxCols = Math.max(1, n);
  const innerPadX = 24;
  const innerPadY = 20;

  const H = CARD_H + innerPadY * 2 + PAD * 2;
  // アスペクト比を 3:4 (0.75) 〜 2:1 (2.0) に厳密に収める
  const minW = Math.ceil(H * 0.75);
  const maxW = Math.floor(H * 2.0);
  const idealStepX = Math.round(CARD_W * 0.54);
  const idealW = (maxCols - 1) * idealStepX + CARD_W + innerPadX * 2 + PAD * 2;
  const W = Math.max(minW, Math.min(maxW, idealW));
  const panelW = W - PAD * 2;
  const panelH = H - PAD * 2;

  canvas.width = W;
  canvas.height = H;

  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return;

  ctx.save();
  ctx.clearRect(0, 0, W, H);

  // 背景
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, "#10151d");
  bgGrad.addColorStop(1, "#090c12");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // 外枠パネル
  const panelGrad = ctx.createLinearGradient(0, PAD, 0, PAD + panelH);
  panelGrad.addColorStop(0, "#131821");
  panelGrad.addColorStop(1, "#0d1118");
  fillRoundRect(ctx, PAD, PAD, panelW, panelH, 12, panelGrad, "#2a3442", 1.5);

  if (n > 0) {
    const availSpreadW = Math.max(0, panelW - innerPadX * 2 - CARD_W);
    const stepX = n > 1 ? Math.min(idealStepX, availSpreadW / (n - 1)) : 0;
    const maxAngleDeg = n > 1 ? Math.min(8, (n - 1) * 2.2) : 0;
    const maxDrop = n > 1 ? Math.min(10, (n - 1) * 2.5) : 0;
    const centerIdx = (n - 1) / 2;
    const rowCy = PAD + innerPadY + CARD_H / 2 - maxDrop * 0.4;

    // 外側から内側（中央が最前面）の順で重ねて描画
    const indices = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => Math.abs(b - centerIdx) - Math.abs(a - centerIdx),
    );

    for (const i of indices) {
      const card = arranged[i];
      const rel = i - centerIdx;
      const norm = centerIdx > 0 ? rel / centerIdx : 0;
      const angleRad = (norm * maxAngleDeg * Math.PI) / 180;
      const arcDrop = norm * norm * maxDrop;
      const cardCx = PAD + panelW / 2 + rel * stepX;
      const cardCy = rowCy + arcDrop;

      ctx.save();
      ctx.translate(cardCx, cardCy);
      ctx.rotate(angleRad);
      drawCardOnCanvas(ctx, card, {
        x: Math.round(-CARD_W / 2),
        y: Math.round(-CARD_H / 2),
        w: CARD_W,
        h: CARD_H,
        count: 1,
        art: artMap.get(card.name) ?? null,
      });
      ctx.restore();
    }
  }

  ctx.restore();
}

function drawTopHeaderStrip(
  ctx: CanvasRenderingContext2D,
  opts: BoardImageOptions,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const { view } = opts;
  const hCy = y + h / 2;
  let rightX = x + w;

  // ターン・フェイズ
  const turnText = t("header.turn", { turn: view.turn, phase: phaseName(view.phase) });
  ctx.font = "600 11px system-ui, -apple-system, 'Segoe UI', sans-serif";
  const turnW = Math.ceil(ctx.measureText(turnText).width) + 14;
  rightX -= turnW;
  fillRoundRect(ctx, rightX, hCy - 10, turnW, 20, 6, "#141a23", "#2b3544");
  ctx.fillStyle = "#94a3b8";
  ctx.textBaseline = "middle";
  ctx.fillText(turnText, rightX + 7, hCy);
  rightX -= 6;

  if (opts.shareKind === "clear") {
    const clearBadgeText =
      opts.stepsCount && opts.stepsCount > 0
        ? t("sns.canvas.clearedBadge", { n: opts.stepsCount })
        : t("sns.canvas.clearedBadgeSimple");
    ctx.font = "800 11.5px system-ui, -apple-system, 'Segoe UI', sans-serif";
    const badgeW = Math.ceil(ctx.measureText(clearBadgeText).width) + 16;
    rightX -= badgeW;
    fillRoundRect(ctx, rightX, hCy - 10, badgeW, 20, 6, "#113327", "#34d399");
    ctx.fillStyle = "#a7f3d0";
    ctx.fillText(clearBadgeText, rightX + 8, hCy);
    rightX -= 6;
  } else {
    const goalText =
      opts.isPlaytest || opts.shareKind === "playtest"
        ? t("sns.canvas.playtestBadge")
        : t("sns.canvas.challengeBadge");
    ctx.font = "700 11px system-ui, -apple-system, 'Segoe UI', sans-serif";
    const goalW = Math.ceil(ctx.measureText(goalText).width) + 14;
    rightX -= goalW;
    fillRoundRect(ctx, rightX, hCy - 10, goalW, 20, 6, "#18202c", "#3b495e");
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(goalText, rightX + 7, hCy);
    rightX -= 6;
  }

  const maxTitleW = Math.max(80, rightX - x - 8);
  ctx.font = "800 14.5px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.fillStyle = "#e2e8f0";
  ctx.textBaseline = "middle";
  ctx.fillText(fitText(ctx, opts.title || t("editor.defaultTitle"), maxTitleW), x + 2, hCy);
}

function drawBattlefieldPanel(
  ctx: CanvasRenderingContext2D,
  box: {
    player: PlayerView;
    isViewer: boolean;
    groups: CardGroup[];
    x: number;
    y: number;
    w: number;
    h: number;
    lifeColW: number;
    cardW: number;
    cardH: number;
    cardGap: number;
    padX: number;
    artMap: ReadonlyMap<string, HTMLImageElement>;
    omittedSummary?: string;
  },
): void {
  const { player, isViewer, groups, x, y, w, h, lifeColW, cardW, cardH, cardGap, padX, artMap, omittedSummary } =
    box;

  // パネル外枠（角丸ダークスレート）
  const panelGrad = ctx.createLinearGradient(0, y, 0, y + h);
  panelGrad.addColorStop(0, "#131821");
  panelGrad.addColorStop(1, "#0f141c");
  fillRoundRect(ctx, x, y, w, h, 10, panelGrad, "#2a3442", 1.5);

  // 1) こちらの戦場（isViewer === true）: ライフ表示は省略し、パネル全幅の中央に戦場カードを配置
  if (isViewer) {
    if (groups.length === 0) {
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "600 12px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.fillStyle = "rgba(148, 163, 184, 0.55)";
      ctx.fillText(omittedSummary || t("sns.canvas.emptyBattlefield"), x + w / 2, y + h / 2);
      ctx.restore();
      return;
    }

    drawCardRow(ctx, groups, {
      x,
      y,
      w,
      h,
      cardW,
      cardH,
      padX,
      gap: cardGap,
      artMap,
    });
    return;
  }

  // 2) 相手の戦場カードがない場合: 相手ライフ（"Life" と数値）を横並びでパネル中央にセンタリング
  if (groups.length === 0) {
    const cy = y + h / 2;
    const lifeStr = `${player.life}`;
    ctx.save();
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";

    const labelFont = "700 20px Georgia, 'Times New Roman', 'Noto Serif JP', serif";
    const numFont = "800 38px Georgia, 'Times New Roman', 'Noto Serif JP', serif";
    ctx.font = labelFont;
    const labelW = Math.ceil(ctx.measureText("Life").width);
    ctx.font = numFont;
    const numW = Math.ceil(ctx.measureText(lifeStr).width);
    const gap = 14;
    const totalW = labelW + gap + numW;
    const startX = x + Math.round((w - totalW) / 2);

    ctx.font = labelFont;
    ctx.fillStyle = "#cfd8e3";
    ctx.fillText("Life", startX, cy + 1);

    ctx.font = numFont;
    ctx.fillStyle = "#f8fafc";
    ctx.fillText(lifeStr, startX + labelW + gap, cy + 1);

    if (player.poison > 0) {
      ctx.font = "700 11px system-ui, sans-serif";
      ctx.fillStyle = "#86efac";
      ctx.fillText(t("player.poison", { n: player.poison }), startX + totalW + 12, cy + 1);
    }

    if (omittedSummary) {
      ctx.textAlign = "right";
      ctx.font = "600 11.5px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.fillStyle = "rgba(148, 163, 184, 0.55)";
      ctx.fillText(omittedSummary, x + w - 16, cy);
    }
    ctx.restore();
    return;
  }

  // 3) 相手の戦場カードがある場合: 左カラムに Life、右エリアに戦場カード列
  const lifeCx = x + lifeColW / 2;
  const lifeCy = y + h / 2;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#cfd8e3";
  ctx.font = "700 20px Georgia, 'Times New Roman', 'Noto Serif JP', serif";
  ctx.fillText("Life", lifeCx, lifeCy - 26);

  ctx.fillStyle = "#f8fafc";
  ctx.font = "800 56px Georgia, 'Times New Roman', 'Noto Serif JP', serif";
  ctx.fillText(`${player.life}`, lifeCx, lifeCy + 16);

  if (player.poison > 0) {
    ctx.font = "700 10px system-ui, sans-serif";
    ctx.fillStyle = "#86efac";
    ctx.fillText(t("player.poison", { n: player.poison }), lifeCx, y + h - 10);
  }
  ctx.restore();

  // 縦の仕切り線 (Life カラムと戦場カード列の間)
  ctx.save();
  ctx.strokeStyle = "#2a3442";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + lifeColW, y + 12);
  ctx.lineTo(x + lifeColW, y + h - 12);
  ctx.stroke();
  ctx.restore();

  // 右エリア: 戦場カード列
  const rightX = x + lifeColW;
  const rightW = w - lifeColW;

  drawCardRow(ctx, groups, {
    x: rightX,
    y,
    w: rightW,
    h,
    cardW,
    cardH,
    padX,
    gap: cardGap,
    artMap,
  });
}

function drawVsDivider(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const cy = y + h / 2;
  const cx = x + w / 2;
  ctx.save();
  ctx.strokeStyle = "#26303d";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + 4, cy);
  ctx.lineTo(cx - 24, cy);
  ctx.moveTo(cx + 24, cy);
  ctx.lineTo(x + w - 4, cy);
  ctx.stroke();

  ctx.font = "800 15px Georgia, 'Times New Roman', serif";
  ctx.fillStyle = "#b8c4d4";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("VS", cx, cy + 1);
  ctx.restore();
}

function drawAvailableManaBar(
  ctx: CanvasRenderingContext2D,
  availMana: Record<ManaColorKey, number>,
  player: PlayerView,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const barGrad = ctx.createLinearGradient(0, y, 0, y + h);
  barGrad.addColorStop(0, "#131821");
  barGrad.addColorStop(1, "#0e131b");
  fillRoundRect(ctx, x, y, w, h, 8, barGrad, "#2a3442", 1.5);

  const colors: ManaColorKey[] = ["W", "U", "B", "R", "G", "C"];
  const active = colors.filter((c) => availMana[c] > 0);
  const cy = y + h / 2;

  if (active.length === 0) {
    // アンタップ基本土地・浮きマナともに 0 の場合、タップ状態の基本土地があれば薄く表示
    const bfCards = player.cards.filter((c) => c.zone === "Battlefield");
    const tappedBasics = bfCards.filter((c) => c.tapped && isPlainBasicLand(c, bfCards));
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "600 12.5px Georgia, 'Times New Roman', system-ui, sans-serif";
    ctx.fillStyle = "rgba(148, 163, 184, 0.55)";
    const label =
      tappedBasics.length > 0
        ? `Mana ×0 (${t("card.tapped")} ×${tappedBasics.length})`
        : "Mana ×0";
    ctx.fillText(label, x + w / 2, cy);
    ctx.restore();
    return;
  }

  const iconR = 12;
  const itemGap = 28;
  ctx.save();
  ctx.font = "700 19px Georgia, 'Times New Roman', serif";
  const items = active.map((col) => {
    const countText = `×${availMana[col]}`;
    const textW = Math.ceil(ctx.measureText(countText).width);
    const itemW = iconR * 2 + 7 + textW;
    return { col, countText, itemW };
  });
  const totalW = items.reduce((acc, it) => acc + it.itemW, 0) + Math.max(0, items.length - 1) * itemGap;
  let curX = x + Math.round((w - totalW) / 2);

  for (const it of items) {
    drawDetailedManaSymbol(ctx, it.col, curX + iconR, cy, iconR);
    ctx.font = "700 19px Georgia, 'Times New Roman', serif";
    ctx.fillStyle = "#f1f5f9";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(it.countText, curX + iconR * 2 + 7, cy + 1);
    curX += it.itemW + itemGap;
  }
  ctx.restore();
}

function drawHandFanPanel(
  ctx: CanvasRenderingContext2D,
  groups: CardGroup[],
  box: {
    x: number;
    y: number;
    w: number;
    h: number;
    cardW: number;
    cardH: number;
    artMap: ReadonlyMap<string, HTMLImageElement>;
  },
): void {
  const { x, y, w, h, cardW, cardH, artMap } = box;
  const panelGrad = ctx.createLinearGradient(0, y, 0, y + h);
  panelGrad.addColorStop(0, "#131821");
  panelGrad.addColorStop(1, "#0d1118");
  fillRoundRect(ctx, x, y, w, h, 10, panelGrad, "#2a3442", 1.5);

  const n = groups.length;
  if (n === 0) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillStyle = "rgba(148, 163, 184, 0.45)";
    ctx.fillText(`${t("zone.Hand")} 0`, x + w / 2, y + h / 2);
    ctx.restore();
    return;
  }

  const availW = w - 44;
  const idealStepX = Math.round(cardW * 0.72);
  const stepX = n > 1 ? Math.min(idealStepX, Math.floor((availW - cardW) / (n - 1))) : 0;
  const stepAngleDeg = n > 1 ? Math.min(4.2, 17 / (n - 1)) : 0;
  const centerIdx = (n - 1) / 2;
  const baseCy = y + h / 2 - 2;

  // リファレンス画像と同じく、外側のカードから先に描き、中央のカードが最前面に来る対称ファン順で描画
  const indices = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => Math.abs(b - centerIdx) - Math.abs(a - centerIdx),
  );

  for (const i of indices) {
    const g = groups[i];
    const rel = i - centerIdx;
    const angleRad = (rel * stepAngleDeg * Math.PI) / 180;
    const arcDrop = Math.abs(rel) * 2.5 + rel * rel * 0.9;
    const cardCx = x + w / 2 + rel * stepX;
    const cardCy = baseCy + arcDrop;

    ctx.save();
    ctx.translate(cardCx, cardCy);
    ctx.rotate(angleRad);
    drawCardOnCanvas(ctx, g.card, {
      x: Math.round(-cardW / 2),
      y: Math.round(-cardH / 2),
      w: cardW,
      h: cardH,
      count: g.count,
      art: artMap.get(g.card.name) ?? null,
    });
    ctx.restore();
  }
}

function drawCardRow(
  ctx: CanvasRenderingContext2D,
  groups: CardGroup[],
  box: {
    x: number;
    y: number;
    w: number;
    h: number;
    cardW: number;
    cardH: number;
    padX: number;
    gap: number;
    artMap: ReadonlyMap<string, HTMLImageElement>;
  },
): void {
  const { x, y, w, h: height, padX, gap, artMap } = box;
  const totalGroups = groups.length;
  if (totalGroups === 0) return;

  const availW = w - padX * 2;
  const neededW = totalGroups * box.cardW + Math.max(0, totalGroups - 1) * gap;
  const scale = neededW > availW ? Math.max(0.68, availW / (totalGroups * (box.cardW + gap))) : 1;
  const cardH = Math.min(height - 14, Math.round(box.cardH * scale));
  const cardW = Math.round((cardH * box.cardW) / box.cardH);

  const stepX =
    totalGroups > 1
      ? Math.min(cardW + gap, Math.floor((availW - cardW) / Math.max(1, totalGroups - 1)))
      : cardW;

  const rowW = totalGroups === 1 ? cardW : (totalGroups - 1) * stepX + cardW;
  let curX = x + Math.max(padX, Math.round((w - rowW) / 2));
  const cardY = y + Math.round((height - cardH) / 2);

  for (const g of groups) {
    drawCardOnCanvas(ctx, g.card, {
      x: curX,
      y: cardY,
      w: cardW,
      h: cardH,
      count: g.count,
      art: artMap.get(g.card.name) ?? null,
    });
    curX += stepX;
  }
}

/**
 * 使用可能マナバー用のベクター・マナシンボル（W: 太陽 / U: 水滴 / B: 髑髏 / R: 炎 / G: 樹 / C: 菱形）を描画する。
 */
function drawDetailedManaSymbol(
  ctx: CanvasRenderingContext2D,
  col: ManaColorKey,
  cx: number,
  cy: number,
  r: number,
): void {
  const bgColors: Record<ManaColorKey, { fill: string; ring: string }> = {
    W: { fill: "#f4ecc4", ring: "#c7bc89" },
    U: { fill: "#5bb6e5", ring: "#3b8bb8" },
    B: { fill: "#9e92a4", ring: "#6e6374" },
    R: { fill: "#e86343", ring: "#b54227" },
    G: { fill: "#54a868", ring: "#387c49" },
    C: { fill: "#b4bec8", ring: "#7d8792" },
  };
  const palette = bgColors[col] ?? bgColors.C;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = palette.fill;
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = palette.ring;
  ctx.stroke();

  ctx.fillStyle = "#10141b";
  ctx.strokeStyle = "#10141b";

  if (col === "U") {
    // 水滴シルエット
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.62);
    ctx.quadraticCurveTo(cx + r * 0.56, cy + r * 0.05, cx + r * 0.38, cy + r * 0.42);
    ctx.quadraticCurveTo(cx, cy + r * 0.72, cx - r * 0.38, cy + r * 0.42);
    ctx.quadraticCurveTo(cx - r * 0.56, cy + r * 0.05, cx, cy - r * 0.62);
    ctx.closePath();
    ctx.fill();
    // ハイライト弧
    ctx.strokeStyle = palette.fill;
    ctx.lineWidth = Math.max(1.2, r * 0.12);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.16, cy + r * 0.06);
    ctx.quadraticCurveTo(cx - r * 0.24, cy + r * 0.28, cx - r * 0.06, cy + r * 0.4);
    ctx.stroke();
  } else if (col === "R") {
    // 炎シルエット
    ctx.beginPath();
    ctx.moveTo(cx + r * 0.06, cy - r * 0.64);
    ctx.quadraticCurveTo(cx + r * 0.58, cy - r * 0.12, cx + r * 0.44, cy + r * 0.36);
    ctx.quadraticCurveTo(cx + r * 0.18, cy + r * 0.68, cx - r * 0.18, cy + r * 0.56);
    ctx.quadraticCurveTo(cx - r * 0.54, cy + r * 0.34, cx - r * 0.42, cy - r * 0.12);
    ctx.quadraticCurveTo(cx - r * 0.15, cy + r * 0.14, cx - r * 0.1, cy - r * 0.22);
    ctx.quadraticCurveTo(cx - r * 0.04, cy - r * 0.48, cx + r * 0.06, cy - r * 0.64);
    ctx.closePath();
    ctx.fill();
  } else if (col === "G") {
    // 樹木シルエット
    ctx.beginPath();
    ctx.arc(cx, cy - r * 0.24, r * 0.32, 0, Math.PI * 2);
    ctx.arc(cx - r * 0.26, cy - r * 0.02, r * 0.26, 0, Math.PI * 2);
    ctx.arc(cx + r * 0.26, cy - r * 0.02, r * 0.26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - r * 0.11, cy + r * 0.04, r * 0.22, r * 0.52);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.3, cy + r * 0.56);
    ctx.lineTo(cx + r * 0.3, cy + r * 0.56);
    ctx.lineWidth = Math.max(1.5, r * 0.14);
    ctx.stroke();
  } else if (col === "W") {
    // 太陽シルエット
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.32, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(1.4, r * 0.13);
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r * 0.42, cy + Math.sin(a) * r * 0.42);
      ctx.lineTo(cx + Math.cos(a) * r * 0.66, cy + Math.sin(a) * r * 0.66);
      ctx.stroke();
    }
  } else if (col === "B") {
    // 髑髏シルエット
    ctx.beginPath();
    ctx.arc(cx, cy - r * 0.1, r * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - r * 0.22, cy + r * 0.18, r * 0.44, r * 0.32);
    ctx.fillStyle = palette.fill;
    ctx.beginPath();
    ctx.arc(cx - r * 0.16, cy - r * 0.1, r * 0.11, 0, Math.PI * 2);
    ctx.arc(cx + r * 0.16, cy - r * 0.1, r * 0.11, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // 無色マナ（凹み菱形）
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 0.6);
    ctx.quadraticCurveTo(cx + r * 0.14, cy - r * 0.14, cx + r * 0.6, cy);
    ctx.quadraticCurveTo(cx + r * 0.14, cy + r * 0.14, cx, cy + r * 0.6);
    ctx.quadraticCurveTo(cx - r * 0.14, cy + r * 0.14, cx - r * 0.6, cy);
    ctx.quadraticCurveTo(cx - r * 0.14, cy - r * 0.14, cx, cy - r * 0.6);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

interface CardColorTheme {
  border: string;
  frameFill: string;
  bgTop: string;
  bgBottom: string;
  artBg: string;
  accent: string;
}

function getCardColorTheme(c: CardView): CardColorTheme {
  const cost = c.manaCost || cardMeta(c.name)?.manaCost || "";
  const colors = new Set<string>();
  for (const col of ["W", "U", "B", "R", "G"]) {
    if (cost.includes(col)) colors.add(col);
  }
  if (colors.size > 1) {
    return {
      border: "#d8b45c",
      frameFill: "#c2ab73",
      bgTop: "#42351b",
      bgBottom: "#241d0f",
      artBg: "#5e4e2a",
      accent: "#f5d076",
    };
  }
  if (colors.has("W")) {
    return {
      border: "#d8d1be",
      frameFill: "#c8c1ae",
      bgTop: "#403d33",
      bgBottom: "#24221c",
      artBg: "#6a6558",
      accent: "#fef3c7",
    };
  }
  if (colors.has("U")) {
    return {
      border: "#68a8de",
      frameFill: "#92adc4",
      bgTop: "#19324d",
      bgBottom: "#101e30",
      artBg: "#3d5870",
      accent: "#93c5fd",
    };
  }
  if (colors.has("B")) {
    return {
      border: "#9284a8",
      frameFill: "#9e98a6",
      bgTop: "#2d253b",
      bgBottom: "#191522",
      artBg: "#4f4859",
      accent: "#d8b4fe",
    };
  }
  if (colors.has("R")) {
    return {
      border: "#dc7660",
      frameFill: "#bf958b",
      bgTop: "#4a201b",
      bgBottom: "#28110e",
      artBg: "#6b4740",
      accent: "#fca5a5",
    };
  }
  if (colors.has("G")) {
    return {
      border: "#6ab382",
      frameFill: "#93b09b",
      bgTop: "#193b27",
      bgBottom: "#0f2317",
      artBg: "#415e49",
      accent: "#86efac",
    };
  }
  if (isLandCard(c)) {
    return {
      border: "#b89b6c",
      frameFill: "#b5a68c",
      bgTop: "#362d22",
      bgBottom: "#1f1a14",
      artBg: "#5c5243",
      accent: "#e7ca8c",
    };
  }
  return {
    border: "#9eaab8",
    frameFill: "#b4afa4",
    bgTop: "#2c3542",
    bgBottom: "#191f26",
    artBg: "#65686e",
    accent: "#cbd5e1",
  };
}

function parseManaSymbols(cost: string): string[] {
  const out: string[] = [];
  for (const m of cost.matchAll(/\{([^{}]{1,5})\}/g)) {
    out.push(m[1].toUpperCase());
  }
  return out;
}

function drawManaSymbolCircle(
  ctx: CanvasRenderingContext2D,
  sym: string,
  cx: number,
  cy: number,
  r: number,
): void {
  const palette: Record<string, { bg: string; fg: string; border: string }> = {
    W: { bg: "#f8f4e3", fg: "#1e293b", border: "#d4c89e" },
    U: { bg: "#bae6fd", fg: "#0f172a", border: "#38bdf8" },
    B: { bg: "#cbd5e1", fg: "#0f172a", border: "#64748b" },
    R: { bg: "#fecaca", fg: "#450a0a", border: "#f87171" },
    G: { bg: "#bbf7d0", fg: "#052e16", border: "#4ade80" },
    C: { bg: "#e2e8f0", fg: "#0f172a", border: "#94a3b8" },
  };
  const p = palette[sym] ?? { bg: "#cbd5e1", fg: "#0f172a", border: "#94a3b8" };
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = p.bg;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = p.border;
  ctx.stroke();
  ctx.fillStyle = p.fg;
  ctx.font = `800 ${Math.max(8, Math.round(r * 1.18))}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(sym.slice(0, 2), cx, cy + 0.5);
  ctx.restore();
}

function drawCardOnCanvas(
  ctx: CanvasRenderingContext2D,
  card: CardView,
  opts: {
    x: number;
    y: number;
    w: number;
    h: number;
    count: number;
    art: HTMLImageElement | null;
  },
): void {
  const { x, y, w, h: height, count, art } = opts;
  const theme = getCardColorTheme(card);
  const locName = displayName(card.name);
  const manaCost = card.manaCost || cardMeta(card.name)?.manaCost || "";
  const symbols = parseManaSymbols(manaCost);

  ctx.save();
  if (card.tapped) {
    const cx = x + w / 2;
    const cy = y + height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((8 * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }

  // 1. 外側の黒縁カードフレーム（リファレンス画像準拠のシャープな黒枠＋ベゼル）
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.68)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  fillRoundRect(ctx, x, y, w, height, 6, "#0d1015", "#3b4554", 1.2);
  ctx.restore();

  // 2. 内側のクラシックカードフレーム（ストーンベージュ〜カード色調）
  const innerX = x + 4;
  const innerY = y + 4;
  const innerW = w - 8;
  const innerH = height - 8;
  fillRoundRect(ctx, innerX, innerY, innerW, innerH, 4, theme.frameFill, theme.border, 1);

  if (art) {
    // Scryfall カードアートがある場合は内枠にクリップ描画し、上部にネームバーを重ねる
    ctx.save();
    roundRectPath(ctx, innerX + 1, innerY + 1, innerW - 2, innerH - 2, 3);
    ctx.clip();
    try {
      ctx.drawImage(art, innerX + 1, innerY + 1, innerW - 2, innerH - 2);
    } catch {
      // 画像描画失敗時はそのまま継続
    }
    ctx.fillStyle = "rgba(12, 16, 23, 0.84)";
    ctx.fillRect(innerX + 1, innerY + 1, innerW - 2, 19);
    ctx.restore();
  } else {
    // リファレンス画像と同じ「タイトル帯＋アート窓＋下部テキスト窓」の3段構造
    const titleBarH = 18;
    fillRoundRect(
      ctx,
      innerX + 3,
      innerY + 3,
      innerW - 6,
      titleBarH,
      2,
      "rgba(20, 24, 31, 0.82)",
      "rgba(0, 0, 0, 0.45)",
      0.8,
    );

    const artY = innerY + titleBarH + 5;
    const artH = Math.max(36, Math.round(innerH * 0.47));
    fillRoundRect(ctx, innerX + 4, artY, innerW - 8, artH, 2, theme.artBg, "#353940", 1);

    // アート窓内の控えめなカード種別モチーフ
    ctx.save();
    ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
    ctx.font = `700 ${Math.round(Math.min(innerW, artH) * 0.38)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const glyph = isCreatureCard(card)
      ? "⚔"
      : isLandCard(card)
        ? "⛰"
        : card.kinds.includes("planeswalker")
          ? "✦"
          : card.kinds.includes("artifact") || card.kinds.includes("enchantment")
            ? "◈"
            : "⚡";
    ctx.fillText(glyph, x + w / 2, artY + artH / 2);
    ctx.restore();

    // 下部テキストボックス（リファレンス画像の下段パネル）
    const tbY = artY + artH + 5;
    const tbH = Math.max(20, innerY + innerH - tbY - 4);
    fillRoundRect(
      ctx,
      innerX + 4,
      tbY,
      innerW - 8,
      tbH,
      2,
      "rgba(232, 226, 213, 0.88)",
      "#47433b",
      0.9,
    );
    const typeLine = card.typeLine || cardMeta(card.name)?.typeLine || "";
    if (typeLine && tbH >= 16) {
      ctx.font = "700 8.5px system-ui, -apple-system, 'Segoe UI', sans-serif";
      ctx.fillStyle = "#1e293b";
      ctx.textBaseline = "top";
      ctx.fillText(fitText(ctx, typeLine, innerW - 14), innerX + 7, tbY + 3);
    }
  }

  // カード名＋マナシンボル（上部バー）
  const pipR = 5.5;
  const maxPips = Math.min(symbols.length, 4);
  const pipsW = maxPips > 0 ? maxPips * (pipR * 2 + 1.5) : 0;
  let pipX = x + w - 5 - pipR;
  for (let i = maxPips - 1; i >= 0; i--) {
    drawManaSymbolCircle(ctx, symbols[i], pipX, y + 12.5, pipR);
    pipX -= pipR * 2 + 1.5;
  }

  ctx.font = "700 10.5px system-ui, -apple-system, 'Segoe UI', sans-serif";
  ctx.fillStyle = "#f8fafc";
  ctx.textBaseline = "middle";
  const availNameW = Math.max(24, w - 12 - pipsW);
  ctx.fillText(fitText(ctx, locName, availNameW), x + 6, y + 12.5);

  // タップ時は暗めのベールと {T} バッジを添える
  if (card.tapped) {
    fillRoundRect(ctx, x + w - 24, y + 25, 19, 17, 4, "rgba(15, 23, 42, 0.88)", theme.border, 1);
    ctx.save();
    ctx.font = "800 10px system-ui, sans-serif";
    ctx.fillStyle = "#fde68a";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("T", x + w - 14.5, y + 33.5);
    ctx.restore();
  }

  // 左側バッジ列（枚数 ×N、召喚酔い、カウンター）
  let badgeY = y + 25;
  if (count > 1) {
    const cntText = `×${count}`;
    ctx.font = "800 11px system-ui, sans-serif";
    const bw = Math.ceil(ctx.measureText(cntText).width) + 10;
    fillRoundRect(ctx, x + 5, badgeY, bw, 18, 5, "rgba(15, 23, 42, 0.92)", "#f5b942", 1.2);
    ctx.fillStyle = "#fde68a";
    ctx.textBaseline = "middle";
    ctx.fillText(cntText, x + 10, badgeY + 9);
    badgeY += 20;
  }

  if (card.sick && isCreatureCard(card)) {
    const sickText = t("card.sick");
    ctx.font = "700 9.5px system-ui, sans-serif";
    const sw = Math.min(w - 12, Math.ceil(ctx.measureText(sickText).width) + 10);
    fillRoundRect(ctx, x + 5, badgeY, sw, 16, 4, "rgba(49, 46, 129, 0.88)", "#818cf8", 1);
    ctx.fillStyle = "#e0e7ff";
    ctx.textBaseline = "middle";
    ctx.fillText(fitText(ctx, sickText, sw - 8), x + 9, badgeY + 8);
    badgeY += 18;
  }

  for (const [k, v] of Object.entries(card.counters)) {
    if (!v) continue;
    const label = k === "P1P1" ? `+1/+1 ×${v}` : k === "LOYALTY" ? `忠誠 ${v}` : `${k} ×${v}`;
    ctx.font = "700 9.5px system-ui, sans-serif";
    const cw = Math.min(w - 12, Math.ceil(ctx.measureText(label).width) + 10);
    fillRoundRect(ctx, x + 5, badgeY, cw, 16, 4, "rgba(15, 23, 42, 0.9)", "#38bdf8", 1);
    ctx.fillStyle = "#bae6fd";
    ctx.textBaseline = "middle";
    ctx.fillText(fitText(ctx, label, cw - 8), x + 9, badgeY + 8);
    badgeY += 18;
  }

  // クリーチャーの P/T プレート（右下）
  if (card.power !== null && card.toughness !== null) {
    const effT = card.toughness - card.damage;
    const ptText = `${card.power}/${effT}`;
    const isMod =
      (card.basePower !== null && card.power !== card.basePower) ||
      (card.baseToughness !== null && card.toughness !== card.baseToughness);
    const isDmg = card.damage > 0;
    ctx.font = "800 11.5px system-ui, -apple-system, 'Segoe UI', sans-serif";
    const ptw = Math.max(32, Math.ceil(ctx.measureText(ptText).width) + 12);
    const pth = 20;
    const ptx = x + w - ptw - 4;
    const pty = y + height - pth - 4;
    fillRoundRect(
      ctx,
      ptx,
      pty,
      ptw,
      pth,
      5,
      isDmg ? "#451a18" : isMod ? "#163854" : "#252d37",
      isDmg ? "#f87171" : isMod ? "#38bdf8" : "rgba(215, 224, 234, 0.55)",
      1.2,
    );
    ctx.save();
    ctx.fillStyle = isDmg ? "#fca5a5" : isMod ? "#7dd3fc" : "#f8fafc";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(ptText, ptx + ptw / 2, pty + pth / 2 + 0.5);
    ctx.restore();
  }

  ctx.restore();
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string | CanvasGradient,
  stroke?: string,
  lineWidth = 1,
): void {
  ctx.save();
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
  ctx.restore();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ell = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + ell).width <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, Math.max(1, lo)) + ell;
}

const FALLBACK_PNG_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0,
  0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 96, 0, 2, 0, 0, 5, 0,
  1, 226, 38, 5, 155, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

/**
 * Canvas から PNG Blob を安全に取り出す。
 * 万一外部画像による CORS 汚染で SecurityError が発生した場合は、プロシージャル枠で再描画して確実に出力する。
 */
export async function canvasToPngBlob(
  canvas: HTMLCanvasElement,
  fallbackOpts?: BoardImageOptions,
): Promise<Blob> {
  const tryBlob = (c: HTMLCanvasElement): Promise<Blob | null> =>
    new Promise((resolve) => {
      if (typeof c.toBlob !== "function") {
        resolve(null);
        return;
      }
      try {
        c.toBlob((b) => resolve(b), "image/png");
      } catch {
        resolve(null);
      }
    });

  let blob = await tryBlob(canvas);
  if (!blob && fallbackOpts) {
    drawBoardToCanvas(canvas, { ...fallbackOpts, useCardArt: false }, new Map());
    blob = await tryBlob(canvas);
  }
  return blob ?? new Blob([FALLBACK_PNG_BYTES], { type: "image/png" });
}

// ---------------------------------------------------------------- SNS 投稿モーダル (<dialog>)

export function openSnsShareDialog(opts: OpenSnsShareDialogOptions): HTMLDialogElement {
  document.querySelectorAll("dialog.sns-dialog").forEach((d) => d.remove());

  const dialog = h("dialog.sns-dialog", {
    closedby: "any",
    "aria-labelledby": "sns-dialog-title",
  }) as HTMLDialogElement;

  // <dialog closedby="any"> 未対応ブラウザ向けのライトディスミス・フォールバック
  if (typeof HTMLDialogElement !== "undefined" && !("closedBy" in HTMLDialogElement.prototype)) {
    dialog.addEventListener("click", (event: MouseEvent) => {
      const rect = dialog.getBoundingClientRect();
      const hasRect = rect.width > 0 && rect.height > 0;
      const isInDialog = hasRect
        ? rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width
        : event.target !== dialog;
      if (!isInDialog || event.target === dialog) {
        dialog.close();
      }
    });
  }

  const isPlaytest = opts.puzzle.goal.deadline === "none" || opts.shareKind === "playtest";
  const initialView = opts.initialView ?? previewView(opts.puzzle);
  const currentView = opts.currentView ?? null;
  const hasDistinctCurrent = !!currentView && currentView !== initialView;
  const steps = opts.steps && opts.steps.length > 0 ? opts.steps : (opts.puzzle.solution ?? []);

  let boardMode: SnsBoardMode =
    opts.defaultBoardMode ??
    (opts.shareKind === "clear" ? "current" : hasDistinctCurrent ? "current" : "initial");
  let opponentBoardMode: SnsOpponentBoardMode = "important";
  let urlMode: SnsUrlMode = "puzzle";
  let shareUrl = "";
  let feedback: { text: string; isError: boolean } | null = null;
  let postText = buildSnsPostText({
    title: puzzleTitle(opts.puzzle),
    shareKind: opts.shareKind,
    stepsCount: steps.length,
    isPlaytest,
  });

  const previewCanvas = document.createElement("canvas");
  previewCanvas.width = BOARD_IMAGE_WIDTH;
  previewCanvas.height = BOARD_IMAGE_HEIGHT;
  previewCanvas.className = "sns-preview-canvas";

  const activeBoardOpts = (): BoardImageOptions => ({
    view: boardMode === "current" && currentView ? currentView : initialView,
    title: puzzleTitle(opts.puzzle),
    shareKind: opts.shareKind,
    boardMode,
    opponentBoardMode,
    stepsCount: steps.length,
    isPlaytest,
  });

  const refreshCanvas = async () => {
    await renderBoardImageCanvas(activeBoardOpts(), previewCanvas);
  };

  const refreshShareUrl = async () => {
    try {
      const targetPuzzle =
        boardMode === "current" && currentView && opts.shareKind !== "clear"
          ? snapshotPuzzleFromView(opts.puzzle, currentView)
          : opts.puzzle;
      if (urlMode === "solution" && steps.length > 0) {
        shareUrl = await buildSolutionShareUrl({
          puzzleId: opts.puzzleId ?? "shared",
          puzzle: targetPuzzle,
          steps,
        });
      } else {
        const isBundledCatalog =
          opts.puzzleId &&
          opts.puzzleId !== "shared" &&
          opts.puzzleId !== "editor-test" &&
          !opts.puzzleId.startsWith("playtest-") &&
          (boardMode === "initial" || opts.shareKind === "clear");
        if (isBundledCatalog) {
          const base = `${window.location.origin}${window.location.pathname}`;
          shareUrl = `${base}#/play/${encodeURIComponent(opts.puzzleId!)}`;
        } else {
          shareUrl = await buildShareUrl(targetPuzzle, "play");
        }
      }
      const urlInput = dialog.querySelector<HTMLInputElement>(".sns-url-preview");
      if (urlInput) urlInput.value = shareUrl;
    } catch {
      shareUrl = window.location.href;
    }
  };

  const copyImageToClipboard = async (): Promise<boolean> => {
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
      const blob = await canvasToPngBlob(previewCanvas, activeBoardOpts());
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      return true;
    } catch {
      return false;
    }
  };

  const onPostX = async () => {
    if (!shareUrl) await refreshShareUrl();
    const copiedImg = await copyImageToClipboard();
    const fullText = shareUrl ? `${postText.trim()}\n${shareUrl}` : postText.trim();
    const intentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(fullText)}`;
    try {
      window.open(intentUrl, "_blank", "noopener,noreferrer");
    } catch {
      // テスト環境等で window.open が制限されている場合は無視
    }
    feedback = {
      text: t(copiedImg ? "sns.feedback.openedXWithImg" : "sns.feedback.openedX"),
      isError: false,
    };
    renderFeedbackOnly();
  };

  const onNativeShare = async () => {
    try {
      if (!shareUrl) await refreshShareUrl();
      const blob = await canvasToPngBlob(previewCanvas, activeBoardOpts());
      const file = new File([blob], "mtg-puzzle-board.png", { type: "image/png" });
      const shareData: ShareData = {
        title: puzzleTitle(opts.puzzle),
        text: `${postText.trim()}\n${shareUrl}`,
      };
      if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
        shareData.files = [file];
      }
      await navigator.share(shareData);
      feedback = { text: t("sns.feedback.shared"), isError: false };
      renderFeedbackOnly();
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      feedback = { text: t("sns.feedback.error", { message: String(e) }), isError: true };
      renderFeedbackOnly();
    }
  };

  const onCopyImage = async () => {
    const ok = await copyImageToClipboard();
    if (ok) {
      feedback = { text: t("sns.feedback.copiedImage"), isError: false };
    } else {
      feedback = { text: t("sns.feedback.error", { message: "Clipboard API unavailable" }), isError: true };
    }
    renderFeedbackOnly();
  };

  const onDownloadImage = async () => {
    const blob = await canvasToPngBlob(previewCanvas, activeBoardOpts());
    const url = URL.createObjectURL(blob);
    const slug = (puzzleTitle(opts.puzzle) || "mtg-puzzle")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[\\/:*?"<>|]/g, "");
    const a = h("a", { href: url, download: `${slug || "mtg-puzzle"}-board.png` });
    a.click();
    URL.revokeObjectURL(url);
    feedback = { text: t("sns.feedback.downloaded"), isError: false };
    renderFeedbackOnly();
  };

  const onCopyText = async () => {
    if (!shareUrl) await refreshShareUrl();
    const fullText = shareUrl ? `${postText.trim()}\n${shareUrl}` : postText.trim();
    try {
      await navigator.clipboard.writeText(fullText);
      feedback = { text: t("sns.feedback.copiedText"), isError: false };
    } catch (e) {
      feedback = { text: t("sns.feedback.error", { message: String(e) }), isError: true };
    }
    renderFeedbackOnly();
  };

  const renderFeedbackOnly = () => {
    const slot = dialog.querySelector<HTMLElement>(".sns-feedback-slot");
    if (!slot) return;
    slot.replaceChildren(
      feedback
        ? h("div.sns-feedback" + (feedback.isError ? ".err" : ".ok"), null, feedback.text)
        : "",
    );
  };

  const render = () => {
    const titleKey: MessageKey =
      opts.shareKind === "clear"
        ? "sns.dialog.titleClear"
        : isPlaytest
          ? "sns.dialog.titlePlaytest"
          : "sns.dialog.titlePuzzle";

    const canNativeShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

    const boardToggleRow = hasDistinctCurrent
      ? h("div.sns-opt-row", null,
          h("span.sns-opt-label", null, t("sns.board.label")),
          h("div.sns-seg", null,
            h("button" + (boardMode === "initial" ? ".on" : ""), {
              type: "button",
              "data-board-mode": "initial",
              onclick: () => {
                boardMode = "initial";
                render();
                void refreshCanvas();
                void refreshShareUrl();
              },
            }, t(opts.shareKind === "clear" ? "sns.board.initial" : "sns.board.initialPlay")),
            h("button" + (boardMode === "current" ? ".on" : ""), {
              type: "button",
              "data-board-mode": "current",
              onclick: () => {
                boardMode = "current";
                render();
                void refreshCanvas();
                void refreshShareUrl();
              },
            }, t(opts.shareKind === "clear" ? "sns.board.current" : "sns.board.currentPlay")),
          ),
        )
      : null;

    const isClearSummaryMode = opts.shareKind === "clear" && boardMode === "current";
    const activeView = boardMode === "current" && currentView ? currentView : initialView;
    const p2View = activeView.players.find((p) => p.id === "p2") ?? activeView.players[1];
    const hasOppBoardCards = p2View ? p2View.cards.some((c) => c.zone === "Battlefield") : false;

    const oppBoardToggleRow = hasOppBoardCards && !isClearSummaryMode
      ? h("div.sns-opt-row", null,
          h("span.sns-opt-label", null, t("sns.oppBoard.label")),
          h("div.sns-seg", null,
            h("button" + (opponentBoardMode === "important" ? ".on" : ""), {
              type: "button",
              "data-opp-board-mode": "important",
              onclick: () => {
                opponentBoardMode = "important";
                render();
                void refreshCanvas();
              },
            }, t("sns.oppBoard.important")),
            h("button" + (opponentBoardMode === "none" ? ".on" : ""), {
              type: "button",
              "data-opp-board-mode": "none",
              onclick: () => {
                opponentBoardMode = "none";
                render();
                void refreshCanvas();
              },
            }, t("sns.oppBoard.none")),
            h("button" + (opponentBoardMode === "all" ? ".on" : ""), {
              type: "button",
              "data-opp-board-mode": "all",
              onclick: () => {
                opponentBoardMode = "all";
                render();
                void refreshCanvas();
              },
            }, t("sns.oppBoard.all")),
          ),
        )
      : null;

    const urlToggleRow = steps.length > 0
      ? h("div.sns-opt-row", null,
          h("span.sns-opt-label", null, t("sns.url.label")),
          h("div.sns-seg", null,
            h("button" + (urlMode === "puzzle" ? ".on" : ""), {
              type: "button",
              "data-url-mode": "puzzle",
              onclick: () => {
                urlMode = "puzzle";
                render();
                void refreshShareUrl();
              },
            }, t("sns.url.puzzleOnly")),
            h("button" + (urlMode === "solution" ? ".on" : ""), {
              type: "button",
              "data-url-mode": "solution",
              onclick: () => {
                urlMode = "solution";
                render();
                void refreshShareUrl();
              },
            }, t(isPlaytest ? "sns.url.withSteps" : "sns.url.withSolution", { n: steps.length })),
          ),
        )
      : null;

    const textArea = h("textarea.sns-textarea", {
      rows: 3,
      "data-sns-textarea": "1",
      oninput: (ev: Event) => {
        postText = (ev.target as HTMLTextAreaElement).value;
      },
    }, postText) as HTMLTextAreaElement;

    const urlPreview = h("input.sns-url-preview", {
      type: "text",
      readonly: "readonly",
      value: shareUrl,
      onclick: (ev: Event) => (ev.target as HTMLInputElement).select(),
    });

    dialog.replaceChildren(
      h("div.sns-box", null,
        h("div.sns-head", null,
          h("h2", { id: "sns-dialog-title" }, t(titleKey)),
          h("button.sns-close", {
            type: "button",
            title: t("card.close"),
            onclick: () => dialog.close(),
          }, "×"),
        ),
        h("div.sns-preview-wrap", null, previewCanvas),
        boardToggleRow,
        oppBoardToggleRow,
        urlToggleRow,
        h("div.sns-field", null,
          h("label.sns-opt-label", null, t("sns.text.label")),
          textArea,
          urlPreview,
        ),
        h("div.sns-feedback-slot", null,
          feedback
            ? h("div.sns-feedback" + (feedback.isError ? ".err" : ".ok"), null, feedback.text)
            : null,
        ),
        h("div.sns-actions", null,
          h("button.on.big.sns-x-btn", {
            type: "button",
            "data-sns-action": "post-x",
            title: t("sns.action.postX.title"),
            onclick: () => void onPostX(),
          }, t("sns.action.postX")),
          canNativeShare
            ? h("button.big", {
                type: "button",
                "data-sns-action": "native-share",
                onclick: () => void onNativeShare(),
              }, t("sns.action.nativeShare"))
            : null,
          h("button.big", {
            type: "button",
            "data-sns-action": "copy-image",
            onclick: () => void onCopyImage(),
          }, t("sns.action.copyImage")),
          h("button.big", {
            type: "button",
            "data-sns-action": "download-image",
            onclick: () => void onDownloadImage(),
          }, t("sns.action.downloadImage")),
          h("button.big", {
            type: "button",
            "data-sns-action": "copy-text",
            onclick: () => void onCopyText(),
          }, t("sns.action.copyText")),
        ),
      ),
    );
  };

  const unsubLang = onLangChange(() => {
    if (!dialog.isConnected) return;
    postText = buildSnsPostText({
      title: puzzleTitle(opts.puzzle),
      shareKind: opts.shareKind,
      stepsCount: steps.length,
      isPlaytest,
    });
    render();
    void refreshCanvas();
  });

  dialog.addEventListener("close", () => {
    unsubLang();
    dialog.remove();
  });

  render();
  document.body.append(dialog);
  dialog.showModal();
  void refreshCanvas();
  void refreshShareUrl();
  return dialog;
}
