// 問題データの URL 共有（圧縮・Base64URL エンコード / デコード）。要件 7 章。
// - Web 標準の CompressionStream / DecompressionStream ("deflate-raw") を用い、バックエンド不要で URL フラグメントに格納する
// - "#/play?p=<data>" / "#p=<data>"（プレイ用）および "#/edit?p=<data>"（編集用）の双方に対応する

import type { CardView, GameView } from "../engine/protocol";
import { cardMeta } from "./carddb";
import { validatePuzzle, ZONES, type CardDef, type PlayerDef, type PuzzleJson, type ValidationResult } from "./schema";
import { validateSolutionSteps, type SolutionStep } from "./solution";

/** 一般的なブラウザ・チャットツール等で安全に共有できる URL 長の上限目安 */
export const MAX_SHARE_URL_LENGTH = 8000;

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(str: string): Uint8Array {
  const clean = str.trim().replace(/-/g, "+").replace(/_/g, "/");
  const pad = clean.length % 4 === 0 ? "" : "=".repeat(4 - (clean.length % 4));
  const bin = atob(clean + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

async function deflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const writer = cs.writable.getWriter();
  void writer.write(input as unknown as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function inflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  void writer.write(input as unknown as BufferSource);
  void writer.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

/** URL を短くするため、空の領域配列や空の説明文を省略したオブジェクトを作る */
function compactPuzzle(p: PuzzleJson): PuzzleJson {
  const copy = JSON.parse(JSON.stringify(p)) as PuzzleJson;
  if (!copy.description) delete copy.description;
  for (const pl of copy.game.players) {
    for (const z of ZONES) {
      if (Array.isArray(pl[z]) && pl[z]!.length === 0) {
        delete pl[z];
      }
    }
  }
  return copy;
}

/** 省略された空の領域配列を [] に補完してエディタ・エンジン双方で扱いやすくする */
function expandPuzzleZones(p: PuzzleJson): PuzzleJson {
  const copy = JSON.parse(JSON.stringify(p)) as PuzzleJson;
  copy.game.players = copy.game.players.map((pl: PlayerDef) => ({
    ...pl,
    hand: pl.hand ?? [],
    battlefield: pl.battlefield ?? [],
    graveyard: pl.graveyard ?? [],
    exile: pl.exile ?? [],
    library: pl.library ?? [],
  }));
  return copy;
}

/** PuzzleJson を deflate-raw 圧縮 + Base64URL 文字列に変換する */
export async function encodePuzzleToParam(puzzle: PuzzleJson): Promise<string> {
  const json = JSON.stringify(compactPuzzle(puzzle));
  const rawBytes = new TextEncoder().encode(json);
  const compressed = await deflateRaw(rawBytes);
  return toBase64Url(compressed);
}

/** Base64URL 文字列（deflate-raw 圧縮または非圧縮 JSON）から PuzzleJson を復元・検証する */
export async function decodePuzzleFromParam(param: string): Promise<ValidationResult> {
  const bytes = fromBase64Url(param);
  let jsonBytes: Uint8Array;
  // 先頭が '{' (0x7b) の場合は非圧縮 UTF-8 JSON として扱う
  if (bytes[0] === 0x7b) {
    jsonBytes = bytes;
  } else {
    jsonBytes = await inflateRaw(bytes);
  }
  const text = new TextDecoder().decode(jsonBytes);
  const parsed: unknown = JSON.parse(text);
  const res = validatePuzzle(parsed);
  if (!res.ok) return res;
  return { ok: true, puzzle: expandPuzzleZones(res.puzzle) };
}

/** SolutionStep 配列を deflate-raw 圧縮 + Base64URL 文字列に変換する */
export async function encodeSolutionToParam(steps: SolutionStep[]): Promise<string> {
  const clean = steps.map((s) => ({
    kind: s.kind,
    indexes: s.indexes,
    labels: s.labels,
  }));
  const json = JSON.stringify(clean);
  const rawBytes = new TextEncoder().encode(json);
  const compressed = await deflateRaw(rawBytes);
  return toBase64Url(compressed);
}

/** Base64URL 文字列から SolutionStep 配列を復元・検証する（不正なら null） */
export async function decodeSolutionFromParam(param: string): Promise<SolutionStep[] | null> {
  try {
    const bytes = fromBase64Url(param);
    let jsonBytes: Uint8Array;
    // 先頭が '[' (0x5b) または '{' (0x7b) の場合は非圧縮 UTF-8 JSON として扱う
    if (bytes[0] === 0x5b || bytes[0] === 0x7b) {
      jsonBytes = bytes;
    } else {
      jsonBytes = await inflateRaw(bytes);
    }
    const text = new TextDecoder().decode(jsonBytes);
    const parsed: unknown = JSON.parse(text);
    return validateSolutionSteps(parsed);
  } catch {
    return null;
  }
}

/** 共有用 URL（play または edit）を生成する */
export async function buildShareUrl(
  puzzle: PuzzleJson,
  mode: "play" | "edit" = "play",
  baseHref?: string,
  solutionSteps?: SolutionStep[],
): Promise<string> {
  const param = await encodePuzzleToParam(puzzle);
  const sParam = solutionSteps && solutionSteps.length > 0 ? await encodeSolutionToParam(solutionSteps) : null;
  const base = (baseHref ?? (typeof location !== "undefined" ? `${location.origin}${location.pathname}${location.search}` : "")).replace(/#.*$/, "");
  const route = mode === "edit" ? "#/edit" : "#/play";
  const hash = sParam ? `${route}?p=${param}&s=${sParam}` : `${route}?p=${param}`;
  return `${base}${hash}`;
}

/**
 * 解答手順を公開する共有 URL を生成する。
 * - 同梱パズル（id が "shared" / "editor-test" 以外）: "#/play/<id>?s=<solution>"
 * - カスタム・共有パズル: "#/play?p=<puzzle>&s=<solution>"
 */
export async function buildSolutionShareUrl(
  optsOrId:
    | { puzzleId: string; puzzle?: PuzzleJson; steps: SolutionStep[]; baseHref?: string }
    | string,
  stepsArg?: SolutionStep[],
  baseHrefArg?: string,
): Promise<string> {
  const opts = typeof optsOrId === "string"
    ? { puzzleId: optsOrId, steps: stepsArg ?? [], baseHref: baseHrefArg }
    : optsOrId;
  const base = (opts.baseHref ?? (typeof location !== "undefined" ? `${location.origin}${location.pathname}${location.search}` : "")).replace(/#.*$/, "");
  const sParam = await encodeSolutionToParam(opts.steps);
  const isPlaytest = opts.puzzle?.goal.deadline === "none";
  if (opts.puzzleId && isBundledPuzzleId(opts.puzzleId) && !isPlaytest) {
    return `${base}#/play/${opts.puzzleId}?s=${sParam}`;
  }
  if (!opts.puzzle) {
    throw new Error("Custom puzzle requires puzzle data to build share URL");
  }
  const pParam = await encodePuzzleToParam(opts.puzzle);
  return `${base}#/play?p=${pParam}&s=${sParam}`;
}

/**
 * URL 文字列や location.hash から共有パラメータ（mode, p, 任意の s）を取り出す。
 * 対応形式:
 * - "#p=<data>" / "https://.../#p=<data>" -> { mode: "play", param: "<data>" }
 * - "#/play?p=<data>(&s=<sol>)" -> { mode: "play", param: "<data>", solutionParam?: "<sol>" }
 * - "#/edit?p=<data>(&s=<sol>)" -> { mode: "edit", param: "<data>", solutionParam?: "<sol>" }
 */
export function parseShareLocation(input: string): { mode: "play" | "edit"; param: string; solutionParam?: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hashIdx = trimmed.indexOf("#");
  const frag = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : trimmed.startsWith("/") ? trimmed : "";
  if (!frag) return null;

  if (frag.startsWith("p=")) {
    const sp = new URLSearchParams(frag);
    const param = sp.get("p");
    const sParam = sp.get("s");
    return param ? { mode: "play", param, ...(sParam ? { solutionParam: sParam } : {}) } : null;
  }

  const qIdx = frag.indexOf("?");
  if (qIdx >= 0) {
    const path = frag.slice(0, qIdx);
    const qs = frag.slice(qIdx + 1);
    const sp = new URLSearchParams(qs);
    const param = sp.get("p");
    const sParam = sp.get("s");
    if (!param) return null;
    if (path === "/edit" || path === "edit") {
      return { mode: "edit", param, ...(sParam ? { solutionParam: sParam } : {}) };
    }
    if (path === "/play" || path === "play" || path === "/" || path === "") {
      return { mode: "play", param, ...(sParam ? { solutionParam: sParam } : {}) };
    }
  }
  return null;
}

/**
 * 同梱パズルのプレイ URL（"#/play/<id>" または "#/play/<id>?s=<sol>"）を解析する。
 */
export function parsePlayRouteLocation(input: string): { id: string; solutionParam?: string } | null {
  const trimmed = input.trim();
  const hashIdx = trimmed.indexOf("#");
  const frag = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : trimmed;
  const m = /^\/play\/([\w-]+)(?:\?(.*))?$/.exec(frag);
  if (!m) return null;
  const id = m[1];
  const qs = m[2];
  const sParam = qs ? new URLSearchParams(qs).get("s") : null;
  return { id, ...(sParam ? { solutionParam: sParam } : {}) };
}

/**
 * エディタの入力欄に貼り付けられた文字列（JSON 文字列・共有 URL・エンコード済み文字列）から PuzzleJson を復元する。
 */
export async function parsePuzzleInput(text: string): Promise<ValidationResult> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, errors: ["Empty input"] };

  // 1. JSON オブジェクト文字列の場合
  if (trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    const res = validatePuzzle(parsed);
    return res.ok ? { ok: true, puzzle: expandPuzzleZones(res.puzzle) } : res;
  }

  // 2. 共有 URL（https://...#/play?p=... や #p=...）の場合
  const share = parseShareLocation(trimmed);
  if (share) {
    const res = await decodePuzzleFromParam(share.param);
    if (res.ok && share.solutionParam) {
      const sol = await decodeSolutionFromParam(share.solutionParam);
      if (sol && sol.length > 0) res.puzzle.solution = sol;
    }
    return res;
  }

  // 3. p=<data> または生の Base64URL パラメータの場合
  const rawParam = trimmed.startsWith("p=") ? trimmed.slice(2) : trimmed;
  return decodePuzzleFromParam(rawParam);
}

/** 同梱パズル（public/puzzles/<id>.json）の ID かどうかを判定する */
export function isBundledPuzzleId(id: string): boolean {
  if (!id || !/^[\w-]+$/.test(id)) return false;
  if (id === "shared" || id === "editor-test" || id.startsWith("playtest-")) return false;
  return true;
}

function normalizeSnapshotPhase(phase: GameView["phase"]): string {
  switch (phase) {
    case "UNTAP":
      return "upkeep";
    case "COMBAT_FIRST_STRIKE_DAMAGE":
      return "combat_damage";
    case "CLEANUP":
      return "end_of_turn";
    default:
      return phase.toLowerCase();
  }
}

/**
 * 初期盤面 PuzzleJson と現在の GameView から、進行中の現在の盤面を表す PuzzleJson スナップショットを生成する。
 * - 手札・戦場・墓地・追放領域は GameView の状態（タップ・召喚酔い・カウンター・ライフ・マナプール等）を反映する
 * - 非公開領域（ライブラリー、相手の手札）は初期盤面のカード順序から GameView に出ている ID を除いて正確に復元する
 */
export function snapshotPuzzleFromView(puzzle: PuzzleJson, view: GameView): PuzzleJson {
  const copy = JSON.parse(JSON.stringify(puzzle)) as PuzzleJson;
  delete copy.solution;

  const initialCardNames = new Set<string>();
  for (const pl of puzzle.game.players) {
    for (const z of ZONES) {
      for (const c of pl[z] ?? []) {
        initialCardNames.add(c.cardId);
      }
    }
  }

  const visibleIds = new Set<string>();
  for (const pv of view.players) {
    for (const cv of pv.cards) {
      visibleIds.add(cv.instanceId);
    }
  }

  copy.game.activePlayer = view.activePlayer || copy.game.activePlayer;
  copy.game.phase = normalizeSnapshotPhase(view.phase);
  copy.game.turn = view.turn || copy.game.turn || 1;

  const toCardDef = (cv: CardView, onBattlefield: boolean): CardDef | null => {
    // プレイ中に生成されたトークン名（"Elemental Token" 等）で Forge の commonCards に存在しないものは除外する
    // （新生 / コピートークン等の実在カード名トークンは保持する）
    if (cv.token && !initialCardNames.has(cv.name) && !cardMeta(cv.name)) {
      return null;
    }
    const def: CardDef = {
      id: cv.instanceId,
      cardId: cv.name,
    };
    if (onBattlefield) {
      if (cv.tapped) def.tapped = true;
      if (cv.sick) def.summoningSick = true;
      if (cv.token) def.token = true;
      if (cv.counters) {
        const counters: Record<string, number> = {};
        let hasCounters = false;
        for (const [k, v] of Object.entries(cv.counters)) {
          if (typeof v === "number" && v > 0) {
            counters[k] = v;
            hasCounters = true;
          }
        }
        if (hasCounters) def.counters = counters;
      }
    }
    return def;
  };

  const manaOrder = ["W", "U", "B", "R", "G", "C"] as const;

  copy.game.players = copy.game.players.map((pl: PlayerDef): PlayerDef => {
    const pv = view.players.find((p) => p.id === pl.id);
    if (!pv) return pl;

    // 初期盤面のうち GameView の公開領域に現れていないカード（ライブラリーや相手手札に残っているカード）を元の順序で抽出
    const initialOrdered = [
      ...(pl.hand ?? []),
      ...(pl.library ?? []),
      ...(pl.battlefield ?? []),
      ...(pl.graveyard ?? []),
      ...(pl.exile ?? []),
    ];
    const remainingHidden = initialOrdered
      .filter((c) => !visibleIds.has(c.id))
      .map((c): CardDef => ({ id: c.id, cardId: c.cardId }));

    // 手札（スタック上の呪文カードも手札に戻して欠損を防ぐ）
    const visibleHand = pv.cards
      .filter((c) => c.zone === "Hand" || c.zone === "Stack")
      .map((c) => toCardDef(c, false))
      .filter((c): c is CardDef => c !== null);

    let hand: CardDef[];
    let library: CardDef[];
    if (visibleHand.length === 0 && pv.handCount > 0) {
      const hiddenHandCount = Math.min(pv.handCount, remainingHidden.length);
      hand = remainingHidden.slice(0, hiddenHandCount);
      library = remainingHidden.slice(hiddenHandCount);
    } else {
      hand = visibleHand;
      library = remainingHidden;
    }

    const battlefield = pv.cards
      .filter((c) => c.zone === "Battlefield")
      .map((c) => toCardDef(c, true))
      .filter((c): c is CardDef => c !== null);

    const graveyard = pv.cards
      .filter((c) => c.zone === "Graveyard" && !c.token)
      .map((c) => toCardDef(c, false))
      .filter((c): c is CardDef => c !== null);

    const exile = pv.cards
      .filter((c) => c.zone === "Exile" && !c.token)
      .map((c) => toCardDef(c, false))
      .filter((c): c is CardDef => c !== null);

    let manaPoolStr = "";
    for (const col of manaOrder) {
      const n = pv.manaPool?.[col] ?? 0;
      if (n > 0) manaPoolStr += col.repeat(n);
    }

    const nextPl: PlayerDef = {
      id: pl.id,
      life: pv.life,
      ...(manaPoolStr ? { manaPool: manaPoolStr } : {}),
      hand,
      battlefield,
      graveyard,
      exile,
      library,
    };
    return nextPl;
  });

  return copy;
}
