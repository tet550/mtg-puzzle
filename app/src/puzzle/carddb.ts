// Forge のカードデータ（carddata-<hash>.json.gz）を読み込み、カードの検索とメタ情報の取得を行う。
// 英語名・日本語名の両方でインクリメンタル検索でき、盤面エディタやプレビュー表示に使う。

import type { CardKind } from "../engine/protocol";
import { isTokenName, setJaFallback } from "../ui/images";

export interface RawCardEntry {
  f: string;
  s: string;
  e?: string;
  d?: string[];
  t?: string[];
  j?: string;
}

export interface RawTokenEntry {
  s: string;
  t?: string[];
  j?: string;
}

export interface RawCardData {
  forge?: string;
  keys: Record<string, number>;
  cards: RawCardEntry[];
  tokens?: Record<string, RawTokenEntry>;
}

export interface CardMeta {
  /** Forge の主カード名（PuzzleJson の cardId に入れる名前） */
  name: string;
  /** 2 面目以降の名前（出来事・分割・両面など） */
  altNames: string[];
  /** 主面の日本語名 */
  jaName?: string;
  /** 2 面目以降の日本語名 */
  altJaNames: string[];
  /** カード種別（land / creature / artifact / enchantment / planeswalker / battle / instant / sorcery） */
  kinds: CardKind[];
  /** 英語のタイプ行 */
  typeLine: string;
  /** 日本語のタイプ行 */
  jaTypeLine?: string;
  /** マナ・コスト（"{2}{R}" の形式。コスト無しは ""） */
  manaCost: string;
  /** クリーチャーの元々のパワー・タフネス */
  basePower: number | null;
  baseToughness: number | null;
  /** プレインズウォーカーの初期忠誠度 */
  loyalty?: number;
  /** バトルの初期守備値 */
  defense?: number;
  /** 英語のオラクル文 */
  text: string;
  /** 日本語のルール文 */
  jaText?: string;
}

interface IndexedCard {
  meta: CardMeta;
  enLower: string;
  jaNorm: string;
  altEnLowers: string[];
  altJaNorms: string[];
}

const BASE = import.meta.env.BASE_URL;

const KIND_MAP: [string, CardKind][] = [
  ["Land", "land"],
  ["Creature", "creature"],
  ["Artifact", "artifact"],
  ["Enchantment", "enchantment"],
  ["Planeswalker", "planeswalker"],
  ["Battle", "battle"],
  ["Instant", "instant"],
  ["Sorcery", "sorcery"],
];

const SUPERTYPES = new Set(["Basic", "Legendary", "Snow", "World", "Ongoing", "Host"]);
const MAIN_TYPES = new Set(KIND_MAP.map(([k]) => k).concat(["Tribal", "Kindred", "Dungeon", "Phenomenon", "Plane", "Scheme", "Vanguard", "Conspiracy"]));

/** 検索クエリが空のときに出す定番カード（基本土地＋代表的なカード） */
const DEFAULT_CARDS = [
  "Plains",
  "Island",
  "Swamp",
  "Mountain",
  "Forest",
  "Wastes",
  "Lightning Bolt",
  "Shock",
  "Giant Growth",
  "Llanowar Elves",
  "Grizzly Bears",
  "Swords to Plowshares",
  "Path to Exile",
  "Counterspell",
  "Unsummon",
  "Dark Ritual",
  "Doom Blade",
  "Divination",
  "goblin guide",
  "Monastery Swiftspear",
];

let indexed: IndexedCard[] = [];
const byName = new Map<string, CardMeta>();
const faceJaByName = new Map<string, { name?: string; text?: string; typeLine?: string }>();
const tokenJaByName = new Map<string, { name?: string; text?: string; typeLine?: string }>();
let loadPromise: Promise<CardMeta[]> | null = null;

/** ひらがなをカタカナに揃え、全角英数を半角小文字に揃える（日本語・英語のあいまい検索用） */
export function normalizeQuery(s: string): string {
  return s
    .trim()
    .replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

/** Forge の ManaCost 行（"2 R" や "1 GW" や "no cost"）を "{2}{R}" の形に変える */
export function formatForgeManaCost(raw: string): string {
  const s = raw.trim();
  if (!s || s === "no cost") return "";
  return s
    .split(/\s+/)
    .map((part) => `{${part}}`)
    .join("");
}

/** Forge の Types 行（"Legendary Creature Human Wizard"）から kinds と表示用 typeLine を作る */
export function parseForgeTypes(raw: string): { kinds: CardKind[]; typeLine: string } {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const kinds: CardKind[] = [];
  for (const [word, kind] of KIND_MAP) {
    if (tokens.includes(word)) kinds.push(kind);
  }
  const main: string[] = [];
  const sub: string[] = [];
  for (const tok of tokens) {
    if (SUPERTYPES.has(tok) || MAIN_TYPES.has(tok)) main.push(tok);
    else sub.push(tok);
  }
  const typeLine = sub.length ? `${main.join(" ")} — ${sub.join(" ")}` : main.join(" ");
  return { kinds, typeLine };
}

/** entry.j の各行（"English Name|日本語名|日本語タイプ|日本語テキスト"）を解析する */
function parseJaLines(rawJa: string): { enKey: string; jName: string; jType: string; jTxt: string }[] {
  const out: { enKey: string; jName: string; jType: string; jTxt: string }[] = [];
  for (const line of rawJa.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("|");
    if (parts.length < 2) continue;
    const enKey = parts[0].split(/\s*\$/)[0].trim().toLowerCase();
    const jName = parts[1]?.trim() ?? "";
    const jType = parts[2]?.trim() ?? "";
    const jTxt = (parts[3]?.trim() ?? "").replace(/\\n/g, "\n");
    if (enKey && jName) {
      out.push({ enKey, jName, jType, jTxt });
    }
  }
  return out;
}

/** 1 枚の RawCardEntry から CardMeta を作る */
export function parseCardEntry(entry: RawCardEntry): CardMeta | null {
  const faces = entry.s.split(/\nALTERNATE\n/);
  const primary = faces[0] ?? "";
  let name = "";
  let manaCost = "";
  let kinds: CardKind[] = [];
  let typeLine = "";
  let basePower: number | null = null;
  let baseToughness: number | null = null;
  let loyalty: number | undefined;
  let defense: number | undefined;
  let text = "";
  let alternateMode = "";

  for (const line of primary.split(/\r?\n/)) {
    if (line.startsWith("Name:") && !name) {
      name = line.slice(5).trim();
    } else if (line.startsWith("ManaCost:")) {
      manaCost = formatForgeManaCost(line.slice(9));
    } else if (line.startsWith("Types:")) {
      const parsed = parseForgeTypes(line.slice(6));
      kinds = parsed.kinds;
      typeLine = parsed.typeLine;
    } else if (line.startsWith("PT:")) {
      const [p, t] = line.slice(3).trim().split("/");
      const pn = Number(p);
      const tn = Number(t);
      basePower = Number.isFinite(pn) ? pn : 0;
      baseToughness = Number.isFinite(tn) ? tn : 0;
    } else if (line.startsWith("Loyalty:")) {
      const n = Number(line.slice(8).trim());
      if (Number.isFinite(n)) loyalty = n;
    } else if (line.startsWith("Defense:")) {
      const n = Number(line.slice(8).trim());
      if (Number.isFinite(n)) defense = n;
    } else if (line.startsWith("Oracle:")) {
      text = line.slice(7).trim().replace(/\\n/g, "\n");
    } else if (line.startsWith("AlternateMode:")) {
      alternateMode = line.slice(14).trim();
    }
  }
  if (!name) return null;

  const primaryName = name;
  const altNames: string[] = [];
  const altTexts: string[] = [];
  for (let i = 1; i < faces.length; i++) {
    let fName = "";
    let fText = "";
    for (const line of faces[i].split(/\r?\n/)) {
      if (line.startsWith("Name:") && !fName) {
        fName = line.slice(5).trim();
      } else if (line.startsWith("Oracle:")) {
        fText = line.slice(7).trim().replace(/\\n/g, "\n");
      }
    }
    if (fName && fName !== primaryName && !altNames.includes(fName)) {
      altNames.push(fName);
      if (fText) altTexts.push(fText);
    }
  }

  const isSplit = alternateMode === "Split" && altNames.length > 0;
  if (isSplit) {
    // 分割カード（AlternateMode: Split）は Forge の Card.getName() が "Face1 // Face2" になる
    name = [primaryName, ...altNames].join(" // ");
    altNames.unshift(primaryName);
    if (altTexts.length > 0) {
      text = [text, ...altTexts].filter(Boolean).join("\n//\n");
    }
  }

  let jaName: string | undefined;
  let jaTypeLine: string | undefined;
  let jaText: string | undefined;
  const altJaNames: string[] = [];
  const altJaTexts: string[] = [];

  if (entry.j) {
    const primaryLower = primaryName.toLowerCase();
    for (const { enKey, jName, jType, jTxt } of parseJaLines(entry.j)) {
      if (enKey === primaryLower && !jaName) {
        jaName = jName;
        if (jType) jaTypeLine = jType;
        if (jTxt) jaText = jTxt;
      } else if (jName !== jaName && !altJaNames.includes(jName)) {
        altJaNames.push(jName);
        if (jTxt) altJaTexts.push(jTxt);
      }
    }
    if (isSplit && jaName && altJaNames.length > 0) {
      const firstJa = jaName;
      jaName = [firstJa, ...altJaNames].join(" // ");
      altJaNames.unshift(firstJa);
      if (altJaTexts.length > 0) {
        jaText = [jaText ?? "", ...altJaTexts].filter(Boolean).join("\n//\n");
      }
    }
  }

  return {
    name,
    altNames,
    ...(jaName ? { jaName } : {}),
    altJaNames,
    kinds,
    typeLine,
    ...(jaTypeLine ? { jaTypeLine } : {}),
    manaCost,
    basePower,
    baseToughness,
    ...(loyalty !== undefined ? { loyalty } : {}),
    ...(defense !== undefined ? { defense } : {}),
    text,
    ...(jaText ? { jaText } : {}),
  };
}

/** 展開済みの RawCardData をインデックスに登録する（テストからも直接呼べる） */
export function indexCardData(data: RawCardData): CardMeta[] {
  indexed = [];
  byName.clear();
  faceJaByName.clear();
  tokenJaByName.clear();
  for (const raw of data.cards) {
    const meta = parseCardEntry(raw);
    if (!meta) continue;
    const enLower = meta.name.toLowerCase();
    const jaNorm = meta.jaName ? normalizeQuery(meta.jaName) : "";
    const altEnLowers = meta.altNames.map((n) => n.toLowerCase());
    const altJaNorms = meta.altJaNames.map((n) => normalizeQuery(n));
    indexed.push({ meta, enLower, jaNorm, altEnLowers, altJaNorms });
    if (!byName.has(enLower)) byName.set(enLower, meta);
    for (const alt of altEnLowers) {
      if (!byName.has(alt)) byName.set(alt, meta);
    }
    if (meta.jaName && !faceJaByName.has(enLower)) {
      faceJaByName.set(enLower, {
        name: meta.jaName,
        ...(meta.jaText ? { text: meta.jaText } : {}),
        ...(meta.jaTypeLine ? { typeLine: meta.jaTypeLine } : {}),
      });
    }
    if (raw.j) {
      for (const { enKey, jName, jType, jTxt } of parseJaLines(raw.j)) {
        if (!faceJaByName.has(enKey)) {
          faceJaByName.set(enKey, {
            name: jName,
            ...(jTxt ? { text: jTxt } : {}),
            ...(jType ? { typeLine: jType } : {}),
          });
        }
      }
    }
  }
  for (const tk of Object.values(data.tokens ?? {})) {
    if (!tk.j) continue;
    for (const { enKey, jName, jType, jTxt } of parseJaLines(tk.j)) {
      if (!tokenJaByName.has(enKey)) {
        tokenJaByName.set(enKey, {
          name: jName,
          ...(jTxt ? { text: jTxt } : {}),
          ...(jType ? { typeLine: jType } : {}),
        });
      }
    }
  }
  setJaFallback((cardName: string) => {
    const key = cardName.trim().toLowerCase();
    if (isTokenName(cardName)) {
      return tokenJaByName.get(key) ?? null;
    }
    const faceJa = faceJaByName.get(key);
    if (faceJa) return faceJa;
    const m = cardMeta(cardName);
    if (!m) return null;
    return { name: m.jaName, text: m.jaText, typeLine: m.jaTypeLine };
  });
  return indexed.map((x) => x.meta);
}

/** カードデータがすでに読み込まれているか */
export function isCardDbLoaded(): boolean {
  return indexed.length > 0;
}

/** 登録されている全カード数 */
export function cardDbCount(): number {
  return indexed.length;
}

/** 名前（英語名）から CardMeta を引く（大文字小文字を区別しない） */
export function cardMeta(name: string): CardMeta | null {
  if (!name) return null;
  const front = name.split(" // ")[0].trim().toLowerCase();
  return byName.get(name.trim().toLowerCase()) ?? byName.get(front) ?? null;
}

/**
 * カードを英語名・日本語名で検索する。
 * クエリが空のときは基本土地と代表的なカードを返す。
 */
export function searchCards(query: string, limit = 40): CardMeta[] {
  if (!indexed.length) return [];
  const q = normalizeQuery(query);
  if (!q) {
    const out: CardMeta[] = [];
    for (const name of DEFAULT_CARDS) {
      const m = cardMeta(name);
      if (m && !out.includes(m)) out.push(m);
      if (out.length >= limit) break;
    }
    return out;
  }

  const hits: { meta: CardMeta; rank: number; len: number }[] = [];
  for (const item of indexed) {
    const { meta, enLower, jaNorm, altEnLowers, altJaNorms } = item;
    let rank = 99;
    if (enLower === q || (jaNorm && jaNorm === q)) {
      rank = 0;
    } else if (altEnLowers.includes(q) || altJaNorms.includes(q)) {
      rank = 1;
    } else if (enLower.startsWith(q) || (jaNorm && jaNorm.startsWith(q))) {
      rank = 2;
    } else if (altEnLowers.some((a) => a.startsWith(q)) || altJaNorms.some((a) => a.startsWith(q))) {
      rank = 3;
    } else if (enLower.includes(q) || (jaNorm && jaNorm.includes(q))) {
      rank = 4;
    } else if (altEnLowers.some((a) => a.includes(q)) || altJaNorms.some((a) => a.includes(q))) {
      rank = 5;
    }
    if (rank < 99) {
      const len = jaNorm && jaNorm.includes(q) ? meta.jaName!.length : meta.name.length;
      hits.push({ meta, rank, len });
    }
  }

  hits.sort((a, b) => a.rank - b.rank || a.len - b.len || a.meta.name.localeCompare(b.meta.name));
  return hits.slice(0, limit).map((h) => h.meta);
}

/** ブラウザ上で manifest.json から carddata-<hash>.json.gz を読み込んで展開・インデックス化する */
export async function loadCardDb(): Promise<CardMeta[]> {
  if (indexed.length > 0) return indexed.map((x) => x.meta);
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const mRes = await fetch(`${BASE}engine/manifest.json`);
      if (!mRes.ok) throw new Error(`manifest.json load failed: ${mRes.status}`);
      const manifest = (await mRes.json()) as { cards?: string; cardData?: string };
      const cardsFile = manifest.cards ?? manifest.cardData;
      if (!cardsFile) throw new Error("cards missing in manifest.json");
      const res = await fetch(`${BASE}engine/${cardsFile}`);
      if (!res.ok) throw new Error(`cardData load failed: ${res.status}`);
      let body: Uint8Array = new Uint8Array(await res.arrayBuffer());
      if (body[0] === 0x1f && body[1] === 0x8b) {
        const stream = new Blob([body as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
        body = new Uint8Array(await new Response(stream).arrayBuffer());
      }
      const raw = JSON.parse(new TextDecoder().decode(body)) as RawCardData;
      return indexCardData(raw);
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}
