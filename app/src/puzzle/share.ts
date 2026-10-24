// 問題データの URL 共有（圧縮・Base64URL エンコード / デコード）。要件 7 章。
// - Web 標準の CompressionStream / DecompressionStream ("deflate-raw") を用い、バックエンド不要で URL フラグメントに格納する
// - "#/play?p=<data>" / "#p=<data>"（プレイ用）および "#/edit?p=<data>"（編集用）の双方に対応する

import { validatePuzzle, ZONES, type PlayerDef, type PuzzleJson, type ValidationResult } from "./schema";

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

/** 共有用 URL（play または edit）を生成する */
export async function buildShareUrl(
  puzzle: PuzzleJson,
  mode: "play" | "edit" = "play",
  baseHref?: string,
): Promise<string> {
  const param = await encodePuzzleToParam(puzzle);
  const base = (baseHref ?? (typeof location !== "undefined" ? `${location.origin}${location.pathname}${location.search}` : "")).replace(/#.*$/, "");
  const hash = mode === "edit" ? `#/edit?p=${param}` : `#/play?p=${param}`;
  return `${base}${hash}`;
}

/**
 * URL 文字列や location.hash から共有パラメータ（mode と p）を取り出す。
 * 対応形式:
 * - "#p=<data>" / "https://.../#p=<data>" -> { mode: "play", param: "<data>" }
 * - "#/play?p=<data>" / "https://.../#/play?p=<data>" -> { mode: "play", param: "<data>" }
 * - "#/edit?p=<data>" / "https://.../#/edit?p=<data>" -> { mode: "edit", param: "<data>" }
 */
export function parseShareLocation(input: string): { mode: "play" | "edit"; param: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hashIdx = trimmed.indexOf("#");
  const frag = hashIdx >= 0 ? trimmed.slice(hashIdx + 1) : trimmed.startsWith("/") ? trimmed : "";
  if (!frag) return null;

  if (frag.startsWith("p=")) {
    const param = new URLSearchParams(frag).get("p");
    return param ? { mode: "play", param } : null;
  }

  const qIdx = frag.indexOf("?");
  if (qIdx >= 0) {
    const path = frag.slice(0, qIdx);
    const qs = frag.slice(qIdx + 1);
    const param = new URLSearchParams(qs).get("p");
    if (!param) return null;
    if (path === "/edit" || path === "edit") return { mode: "edit", param };
    if (path === "/play" || path === "play" || path === "/" || path === "") return { mode: "play", param };
  }
  return null;
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
    return decodePuzzleFromParam(share.param);
  }

  // 3. p=<data> または生の Base64URL パラメータの場合
  const rawParam = trimmed.startsWith("p=") ? trimmed.slice(2) : trimmed;
  return decodePuzzleFromParam(rawParam);
}
