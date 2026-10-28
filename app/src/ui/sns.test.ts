import { describe, expect, it } from "vitest";
import type { CardView } from "../engine/protocol";
import { setLang } from "../i18n";
import { addCardToPuzzle, adjustPlayerMana, createEmptyPuzzle, setCardCounter } from "./edit";
import { previewView } from "./play";
import {
  BOARD_IMAGE_HEIGHT,
  BOARD_IMAGE_WIDTH,
  buildSnsPostText,
  canvasToPngBlob,
  computeAvailableMana,
  drawBoardToCanvas,
  filterOpponentBoardCards,
  filterPlayerBoardCards,
  groupBoardCards,
} from "./sns";

function makeCardView(overrides: Partial<CardView> & Pick<CardView, "instanceId" | "name" | "zone">): CardView {
  return {
    owner: "p1",
    controller: "p1",
    kinds: [],
    typeLine: "",
    manaCost: "",
    text: "",
    power: null,
    toughness: null,
    basePower: null,
    baseToughness: null,
    damage: 0,
    tapped: false,
    sick: false,
    token: false,
    faceDown: false,
    counters: {},
    attachedTo: null,
    exiledBy: null,
    ...overrides,
  };
}

function createMockCanvas() {
  const texts: string[] = [];
  const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
  const ctx: Record<string, unknown> = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    arc: () => {},
    arcTo: () => {},
    clip: () => {},
    fill: () => {},
    stroke: () => {},
    translate: () => {},
    rotate: () => {},
    clearRect: () => {},
    strokeRect: () => {},
    setLineDash: () => {},
    fillRect: (x: number, y: number, w: number, h: number) => {
      rects.push({ x, y, w, h });
    },
    fillText: (text: string) => {
      texts.push(String(text));
    },
    measureText: (text: string) => ({ width: String(text).length * 8 }),
    createLinearGradient: () => ({
      addColorStop: () => {},
    }),
    createRadialGradient: () => ({
      addColorStop: () => {},
    }),
    drawImage: () => {},
  };

  const canvas = {
    width: 0,
    height: 0,
    getContext: (type: string) => (type === "2d" ? (ctx as unknown as CanvasRenderingContext2D) : null),
    toBlob: (cb: BlobCallback, type?: string) => {
      cb(new Blob([new Uint8Array([137, 80, 78, 71])], { type: type ?? "image/png" }));
    },
  } as unknown as HTMLCanvasElement;

  return { canvas, texts, rects };
}

describe("SNS share text & board snapshot rendering", () => {
  it("builds Japanese and English post text for clear, puzzle, and playtest modes", () => {
    setLang("ja");
    const title = "稲妻の詰めパズル";

    const clearWithSteps = buildSnsPostText({
      title,
      shareKind: "clear",
      stepsCount: 5,
    });
    expect(clearWithSteps).toContain("稲妻の詰めパズル");
    expect(clearWithSteps).toContain("5 手");
    expect(clearWithSteps).toContain("#MTGPuzzle");

    const clearNoSteps = buildSnsPostText({
      title,
      shareKind: "clear",
      stepsCount: 0,
    });
    expect(clearNoSteps).toContain("クリアしました");

    const puzzleText = buildSnsPostText({
      title,
      shareKind: "puzzle",
    });
    expect(puzzleText).toContain("稲妻の詰めパズル");
    expect(puzzleText).toContain("#MTGPuzzle");

    const boardText = buildSnsPostText({
      title,
      shareKind: "playtest",
    });
    expect(boardText).toContain("一人回し盤面");

    setLang("en");
    const enClear = buildSnsPostText({
      title,
      shareKind: "clear",
      stepsCount: 3,
    });
    expect(enClear).toContain("solved");
    expect(enClear).toContain("3 steps");
    setLang("ja");
  });

  it("groups identical board cards into ×N stacks while keeping distinct states separate", () => {
    const m1 = makeCardView({ instanceId: "c1", name: "Mountain", zone: "Battlefield", kinds: ["land"] });
    const m2 = makeCardView({ instanceId: "c2", name: "Mountain", zone: "Battlefield", kinds: ["land"] });
    const mTapped = makeCardView({
      instanceId: "c3",
      name: "Mountain",
      zone: "Battlefield",
      kinds: ["land"],
      tapped: true,
    });
    const bearCounter = makeCardView({
      instanceId: "c4",
      name: "Grizzly Bears",
      zone: "Battlefield",
      kinds: ["creature"],
      counters: { P1P1: 1 },
    });

    const grouped = groupBoardCards([m1, m2, mTapped, bearCounter]);
    expect(grouped).toHaveLength(3);
    expect(grouped[0].count).toBe(2);
    expect(grouped[0].card.name).toBe("Mountain");
    expect(grouped[0].card.tapped).toBe(false);
    expect(grouped[1].count).toBe(1);
    expect(grouped[1].card.tapped).toBe(true);
    expect(grouped[2].count).toBe(1);
    expect(grouped[2].card.name).toBe("Grizzly Bears");
  });

  it("filters out unimportant opponent lands by default while preserving creatures and special lands", () => {
    const forest = makeCardView({ instanceId: "l1", name: "Forest", zone: "Battlefield", kinds: ["land"] });
    const tappedIsland = makeCardView({
      instanceId: "l2",
      name: "Island",
      zone: "Battlefield",
      kinds: ["land"],
      tapped: true,
    });
    const counterLand = makeCardView({
      instanceId: "l3",
      name: "Inkmoth Nexus",
      zone: "Battlefield",
      kinds: ["land"],
      counters: { P1P1: 1 },
    });
    const elf = makeCardView({
      instanceId: "c1",
      name: "Llanowar Elves",
      zone: "Battlefield",
      kinds: ["creature"],
    });

    const important = filterOpponentBoardCards([forest, tappedIsland, counterLand, elf], "important");
    expect(important.nonLandGroups.map((g) => g.card.instanceId)).toEqual(["c1"]);
    expect(important.landGroups.map((g) => g.card.instanceId)).toEqual(["l3"]);

    const none = filterOpponentBoardCards([forest, tappedIsland, counterLand, elf], "none");
    expect(none.nonLandGroups).toHaveLength(0);
    expect(none.landGroups).toHaveLength(0);

    const all = filterOpponentBoardCards([forest, tappedIsland, counterLand, elf], "all");
    expect(all.nonLandGroups).toHaveLength(1);
    expect(all.landGroups).toHaveLength(3);
  });

  it("converts untapped basic lands into available mana and keeps special lands on the battlefield", () => {
    let p = createEmptyPuzzle("マナと特殊土地テスト");
    p = adjustPlayerMana(p, "p1", "U", 1);
    p = addCardToPuzzle(p, "p1", "battlefield", "Island").puzzle;
    p = addCardToPuzzle(p, "p1", "battlefield", "Mountain").puzzle;
    p = addCardToPuzzle(p, "p1", "battlefield", "Forest").puzzle;
    p = addCardToPuzzle(p, "p1", "battlefield", "Steam Vents").puzzle;
    p = addCardToPuzzle(p, "p1", "battlefield", "Grizzly Bears").puzzle;

    const view = previewView(p);
    const p1 = view.players[0];
    const mana = computeAvailableMana(p1);
    expect(mana).toEqual({ W: 0, U: 2, B: 0, R: 1, G: 1, C: 0 });

    const myBfCards = p1.cards
      .filter((c) => c.zone === "Battlefield")
      .map((c) => (c.name === "Steam Vents" ? { ...c, kinds: ["land" as const] } : c));
    const filtered = filterPlayerBoardCards(myBfCards);
    expect(filtered.nonLandGroups.map((g) => g.card.name)).toEqual(["Grizzly Bears"]);
    expect(filtered.landGroups.map((g) => g.card.name)).toEqual(["Steam Vents"]);
  });

  it("renders a tight minimal-whitespace board snapshot and collapses unimportant opponent boards", () => {
    setLang("ja");
    let p = createEmptyPuzzle("赤単リーサル");
    p.game.players[0].life = 14;
    p.game.players[1].life = 3;
    p = adjustPlayerMana(p, "p1", "R", 2);
    p = addCardToPuzzle(p, "p1", "hand", "Lightning Bolt").puzzle;
    p = addCardToPuzzle(p, "p1", "battlefield", "Mountain").puzzle;
    p = addCardToPuzzle(p, "p1", "battlefield", "Mountain").puzzle;
    const bearRes = addCardToPuzzle(p, "p1", "battlefield", "Grizzly Bears");
    p = setCardCounter(bearRes.puzzle, bearRes.added.id, "P1P1", 2);
    p = addCardToPuzzle(p, "p2", "battlefield", "Forest").puzzle;
    p = addCardToPuzzle(p, "p2", "battlefield", "Forest").puzzle;

    const view = previewView(p);
    const { canvas, texts } = createMockCanvas();

    drawBoardToCanvas(
      canvas,
      {
        view,
        title: p.title,
        shareKind: "puzzle",
      },
      new Map(),
    );

    // 相手は基本土地のみのため、相手の戦場行が省略され高さがコンパクトになる
    expect(canvas.width).toBeLessThanOrEqual(BOARD_IMAGE_WIDTH);
    expect(canvas.height).toBeLessThan(BOARD_IMAGE_HEIGHT);
    const compactHeight = canvas.height;
    expect(texts.some((t) => t.includes("赤単リーサル"))).toBe(true);
    expect(texts).toContain("Life");
    expect(texts).toContain("VS");
    // こちらのライフ(14)は省略され、相手ライフ(3)のみ表示される
    expect(texts).not.toContain("14");
    expect(texts).toContain("3");
    expect(texts.some((t) => t.includes("土地 2（アンタップ 2）"))).toBe(true);
    // 浮き赤マナ2 + アンタップ状態の山2枚 = ×4 が使用可能マナバーに表示される
    expect(texts.some((t) => t.includes("×4"))).toBe(true);
    expect(texts.some((t) => t.includes("+1/+1 ×2"))).toBe(true);

    // 相手の戦場を「すべて表示」にした場合は相手戦場行が追加され高さが増える
    const allCanvas = createMockCanvas();
    drawBoardToCanvas(
      allCanvas.canvas,
      {
        view,
        title: p.title,
        shareKind: "puzzle",
        opponentBoardMode: "all",
      },
      new Map(),
    );
    expect(allCanvas.canvas.height).toBeGreaterThan(compactHeight);

    // クリア時の盤面（shareKind: "clear"）は 2:1〜3:4 に収まり、
    // 戦場・墓地・追放の自軍カードを×でまとめずすべて重ねて表示し、CLEARED! や TAP は表示しない
    p = addCardToPuzzle(p, "p1", "graveyard", "Lava Spike").puzzle;
    p = addCardToPuzzle(p, "p1", "exile", "Light Up the Stage").puzzle;
    p.game.players[0].battlefield![0].tapped = true;
    const clearView = previewView(p);

    const clearCanvas = createMockCanvas();
    drawBoardToCanvas(
      clearCanvas.canvas,
      {
        view: clearView,
        title: p.title,
        shareKind: "clear",
        stepsCount: 4,
      },
      new Map(),
    );
    const ratio = clearCanvas.canvas.width / clearCanvas.canvas.height;
    expect(ratio).toBeGreaterThanOrEqual(0.75);
    expect(ratio).toBeLessThanOrEqual(2.0);
    // CLEARED! バナー・相手ライフ・VS・使用可能マナバー・TAPバッジ・×Nバッジは描画されない
    expect(clearCanvas.texts.some((t) => t.includes("CLEARED"))).toBe(false);
    expect(clearCanvas.texts).not.toContain("Life");
    expect(clearCanvas.texts).not.toContain("VS");
    expect(clearCanvas.texts).not.toContain("TAP");
    expect(clearCanvas.texts.some((t) => /^×\d+$/.test(t))).toBe(false);
    // 戦場・墓地・追放のカードがそれぞれ個別に描画される（山2枚も×2にまとめず2回描画される）
    expect(clearCanvas.texts.filter((t) => t.includes("Mountain") || t.includes("山")).length).toBeGreaterThanOrEqual(2);
    expect(clearCanvas.texts.some((t) => t.includes("Lava Spike") || t.includes("溶岩の撃ち込み"))).toBe(true);
    expect(clearCanvas.texts.some((t) => t.includes("Light Up the Stage") || t.includes("舞台照らし"))).toBe(true);
  });

  it("exports canvas to PNG blob", async () => {
    const { canvas } = createMockCanvas();
    const blob = await canvasToPngBlob(canvas);
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBeGreaterThan(0);
  });
});
