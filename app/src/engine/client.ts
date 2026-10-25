// ForgeEngine: Worker の中の Forge（CheerpJ）を呼ぶクライアント。
// 呼び出しは 1 つずつ順に行う（Java 側は並行に呼ばれる前提になっていない）。

import {
  API_VERSION,
  type ApiError,
  type ErrorCode,
  type GameView,
  type PrepareResult,
  type StepResult,
  type UseCardsResult,
  type VersionInfo,
  type WorkerMethod,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";
import { t, type MessageKey } from "../i18n";

export type EngineStatus = "idle" | "booting" | "initializing" | "ready" | "failed";

/** Java が返したエラー（code 付き）か、Worker・通信の異常（code は "WORKER" / "TIMEOUT"） */
export class EngineError extends Error {
  constructor(
    readonly code: ErrorCode | "WORKER" | "TIMEOUT" | "VERSION",
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface EngineOptions {
  /** CheerpJ から見た jar のパス（/app/ はサイトのルート） */
  jar?: string;
  /** 共通の res バンドル（カードを含まない zip。/app/...）と展開先（/files/...。IndexedDB に残るので 2 回目以降は展開しない） */
  resZip?: string;
  resDir?: string;
  /** 全カードのデータ（.json.gz）の URL。問題を開くたびに、そこから問題のカードだけを抜き出して Forge に渡す */
  cardsUrl?: string;
  /** CheerpJ のランタイムのプリロード一覧（無ければ使わない） */
  preloadUrl?: string;
  workerUrl?: string;
  bootTimeoutMs?: number;
  callTimeoutMs?: number;
}

const BASE = import.meta.env.BASE_URL;

const DEFAULTS: Required<EngineOptions> = {
  jar: "",
  resZip: "",
  resDir: "",
  cardsUrl: "",
  preloadUrl: "",
  workerUrl: `${BASE}engine/worker.js`,
  bootTimeoutMs: 90_000,
  callTimeoutMs: 30_000,
};

type Listener = (status: EngineStatus, detail?: string) => void;

interface EngineFiles {
  jar: string;
  resZip: string;
  resDir: string;
  cardsUrl: string;
  preloadUrl: string;
}

/** 問題で使うカード名（どのゾーンのカードも）。形が違うところは飛ばす（問題データの検査は Puzzle Core と Java が行う） */
export function puzzleCardNames(puzzle: unknown): string[] {
  const names = new Set<string>();
  const players = (puzzle as { game?: { players?: unknown } })?.game?.players;
  if (!Array.isArray(players)) return [];
  for (const p of players as Record<string, unknown>[]) {
    for (const zone of ["hand", "battlefield", "graveyard", "exile", "library"]) {
      const cards = p?.[zone];
      if (!Array.isArray(cards)) continue;
      for (const c of cards as { cardId?: unknown }[]) {
        if (typeof c?.cardId === "string" && c.cardId) names.add(c.cardId);
      }
    }
  }
  return [...names];
}

export class ForgeEngine {
  private readonly opts: Required<EngineOptions>;
  private worker: Worker | null = null;
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void; timer: number }>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<Listener>();
  private starting: Promise<void> | null = null;
  private files: EngineFiles | null = null;
  /** いま Forge に読ませているカードの組（小文字の名前を並べたもの） */
  private cardsKey: string | null = null;
  status: EngineStatus = "idle";
  /** 準備にかかった時間（ms）。計測用 */
  readonly metrics: Record<string, number> = {};

  constructor(opts: EngineOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  onStatus(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: EngineStatus, detail?: string) {
    this.status = s;
    for (const fn of this.listeners) fn(s, detail);
  }

  /**
   * Worker を起動して、共通の res を展開する。失敗したら 1 回だけやり直す（CheerpJ の初期化がまれに返らないため）。
   * Forge の初期化は、問題を読み込むときに問題のカードで行う（useCards）
   */
  start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.startOnce().catch(async (e) => {
        console.warn("[engine] 初期化に失敗したのでやり直します", e);
        this.terminate();
        return this.startOnce();
      }).catch((e) => {
        this.starting = null;
        this.setStatus("failed", String(e instanceof Error ? e.message : e));
        throw e;
      });
    }
    return this.starting;
  }

  private async startOnce(): Promise<void> {
    const t0 = performance.now();
    this.setStatus("booting");
    this.worker = new Worker(this.opts.workerUrl);
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      e.preventDefault();
      if (String(e.message || "").includes("cacheRefCount")) return;
      this.failAll(new EngineError("WORKER", e.message || t("error.worker")));
      this.terminate();
    };
    // どのファイルを読むかは manifest.json（tools/build-engine.sh が作る。ファイル名に中身のハッシュが付いている）
    const files = await this.resolveFiles();
    this.files = files;
    let preload: unknown;
    try {
      const res = await fetch(files.preloadUrl);
      if (res.ok) preload = await res.json();
    } catch {
      // プリロード一覧は無くても動く
    }
    await this.raw("boot", { jar: files.jar, preload }, this.opts.bootTimeoutMs);
    this.metrics.bootMs = Math.round(performance.now() - t0);
    this.setStatus("initializing");
    const version = parse<VersionInfo>(await this.raw("version", {}, this.opts.callTimeoutMs));
    if (version.api !== API_VERSION) {
      throw new EngineError("VERSION", t("error.version", { got: version.api, want: API_VERSION }));
    }
    parse<PrepareResult>(await this.raw("prepare", { zip: files.resZip, dir: files.resDir }, this.opts.bootTimeoutMs));
    this.metrics.readyMs = Math.round(performance.now() - t0);
    this.setStatus("ready");
  }

  private async resolveFiles(): Promise<EngineFiles> {
    if (this.opts.jar && this.opts.resZip && this.opts.cardsUrl) {
      return {
        jar: this.opts.jar, resZip: this.opts.resZip, resDir: this.opts.resDir || "/files/forge-res",
        cardsUrl: this.opts.cardsUrl, preloadUrl: this.opts.preloadUrl,
      };
    }
    const res = await fetch(`${BASE}engine/manifest.json`, { cache: "no-cache" });
    if (!res.ok) throw new EngineError("WORKER", t("error.manifest", { status: res.status }));
    const m = (await res.json()) as { jar: string; res: string; cards: string; preload?: string };
    // GitHub Pages のサブパス配信（/<repo>/）や相対 BASE（"./"）でも CheerpJ の /app/... パスが常にオリジン基準の絶対パスになるよう解決する
    const engineBase = new URL(`${BASE}engine/`, location.href);
    const enginePath = engineBase.pathname;
    return {
      jar: `/app${enginePath}${m.jar}`,
      resZip: `/app${enginePath}${m.res}`,
      // 展開先もバンドルごとに分ける（古いバンドルの展開物を使わない）
      resDir: `/files/${m.res.replace(/\.zip$/, "")}`,
      // Worker が fetch で読む（CheerpJ のファイルではない）ので、普通の URL
      cardsUrl: new URL(m.cards, engineBase).href,
      preloadUrl: new URL(m.preload ?? "preload.json", engineBase).href,
    };
  }

  /** 問題を読み込む。前の問題とカードの組が違えば、先に問題のカードで Forge を初期化し直す */
  async load(puzzle: unknown): Promise<StepResult> {
    try {
      return await this.loadOnce(puzzle);
    } catch (e) {
      if (e instanceof EngineError && (e.code === "WORKER" || e.code === "TIMEOUT" || e.code === "INTERNAL")) {
        console.warn("[engine] 問題の読み込みに失敗したため Worker を再起動してやり直します", e);
        await this.restart();
        return this.loadOnce(puzzle);
      }
      throw e;
    }
  }

  private async loadOnce(puzzle: unknown): Promise<StepResult> {
    await this.start();
    return this.enqueue(async () => {
      await this.useCards(puzzleCardNames(puzzle));
      return parse<StepResult>(await this.raw("load", { json: JSON.stringify(puzzle) }, this.opts.callTimeoutMs));
    });
  }

  private async useCards(names: string[]) {
    const key = [...new Set(names.map((n) => n.toLowerCase()))].sort().join(",");
    if (key === this.cardsKey) return;
    this.setStatus("initializing");
    try {
      const r = parse<UseCardsResult>(await this.raw("useCards", { names, url: this.files!.cardsUrl }, this.opts.bootTimeoutMs));
      this.cardsKey = key;
      if (r.initMs !== undefined) this.metrics.initMs = r.initMs;
      if (r.fetchMs !== undefined) this.metrics.cardsFetchMs = r.fetchMs;
      if (r.totalMs !== undefined) this.metrics.cardsMs = r.totalMs;
    } catch (e) {
      // 初期化の途中で止まった Forge は使えないので、次の読み込みは作り直しから
      this.terminate();
      this.setStatus("failed", String(e instanceof Error ? e.message : e));
      throw e;
    }
    this.setStatus("ready");
  }

  submit(optionIds: string[]): Promise<StepResult> {
    return this.call<StepResult>("submit", { ids: JSON.stringify(optionIds) });
  }

  reset(): Promise<StepResult> {
    return this.call<StepResult>("reset");
  }

  state(): Promise<GameView> {
    return this.call<GameView>("state");
  }

  /** Worker を止める。次に start() を呼べば作り直す */
  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.starting = null;
    this.cardsKey = null;
    this.failAll(new EngineError("WORKER", t("error.stopped")));
    this.setStatus("idle");
  }

  /** エンジンを作り直す（タイムアウトや Worker の異常の後の復帰用） */
  async restart(): Promise<void> {
    this.terminate();
    await this.start();
  }

  private async call<T>(method: WorkerMethod, args: Record<string, unknown> = {}): Promise<T> {
    await this.start();
    return this.enqueue(async () => parse<T>(await this.raw(method, args, this.opts.callTimeoutMs)));
  }

  /** 呼び出しを 1 つずつ順に流す */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private raw(method: WorkerMethod, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new EngineError("WORKER", t("error.notStarted")));
    return new Promise<string>((resolve, reject) => {
      const id = ++this.seq;
      const timer = window.setTimeout(() => {
        this.waiting.delete(id);
        reject(new EngineError("TIMEOUT", t("error.timeout", { method, sec: Math.round(timeoutMs / 1000) })));
        // ゲームスレッドが止まっている可能性があるので、Worker ごと作り直す必要がある
        this.setStatus("failed", "timeout");
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      const req: WorkerRequest = { id, method, args };
      worker.postMessage(req);
    });
  }

  private onMessage(res: WorkerResponse) {
    const w = this.waiting.get(res.id);
    if (!w) return;
    this.waiting.delete(res.id);
    window.clearTimeout(w.timer);
    if (res.error !== undefined) w.reject(new EngineError("WORKER", res.error));
    else w.resolve(res.result ?? "");
  }

  private failAll(e: Error) {
    for (const [id, w] of this.waiting) {
      window.clearTimeout(w.timer);
      w.reject(e);
      this.waiting.delete(id);
    }
  }
}

function parse<T>(raw: string): T {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new EngineError("WORKER", t("error.response", { raw: raw.slice(0, 200) }));
  }
  if (v && typeof v === "object" && "error" in v) {
    const { code, message } = (v as ApiError).error;
    // Java の文は開発者向け（日本語）なので、種類ごとの説明を画面の言語で前に付ける
    throw new EngineError(code, t(`error.${code}` as MessageKey, { message }));
  }
  return v as T;
}
