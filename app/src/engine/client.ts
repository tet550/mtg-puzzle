// ForgeEngine: Worker の中の Forge（CheerpJ）を呼ぶクライアント。
// 呼び出しは 1 つずつ順に行う（Java 側は並行に呼ばれる前提になっていない）。

import {
  API_VERSION,
  type ApiError,
  type ErrorCode,
  type GameView,
  type InitResult,
  type StepResult,
  type VersionInfo,
  type WorkerMethod,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol";

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
  /** res バンドルの zip（/app/...）と展開先（/files/...。IndexedDB に残るので 2 回目以降は展開しない） */
  resZip?: string;
  resDir?: string;
  /** CheerpJ のランタイムのプリロード一覧（無ければ使わない） */
  preloadUrl?: string;
  workerUrl?: string;
  bootTimeoutMs?: number;
  callTimeoutMs?: number;
}

const BASE = import.meta.env.BASE_URL;

const DEFAULTS: Required<EngineOptions> = {
  jar: `/app${BASE}engine/forge-adapter.jar`,
  resZip: `/app${BASE}engine/res-mini.zip`,
  resDir: "/files/forge-res",
  preloadUrl: `${BASE}engine/preload.json`,
  workerUrl: `${BASE}engine/worker.js`,
  bootTimeoutMs: 90_000,
  callTimeoutMs: 30_000,
};

type Listener = (status: EngineStatus, detail?: string) => void;

export class ForgeEngine {
  private readonly opts: Required<EngineOptions>;
  private worker: Worker | null = null;
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void; timer: number }>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<Listener>();
  private starting: Promise<void> | null = null;
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

  /** Worker を起動して Forge を初期化する。失敗したら 1 回だけやり直す（CheerpJ の初期化がまれに返らないため） */
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
    this.worker.onerror = (e) => this.failAll(new EngineError("WORKER", e.message || "Worker のエラー"));
    let preload: unknown;
    try {
      const res = await fetch(this.opts.preloadUrl);
      if (res.ok) preload = await res.json();
    } catch {
      // プリロード一覧は無くても動く
    }
    await this.raw("boot", { jar: this.opts.jar, preload }, this.opts.bootTimeoutMs);
    this.metrics.bootMs = Math.round(performance.now() - t0);
    this.setStatus("initializing");
    const version = parse<VersionInfo>(await this.raw("version", {}, this.opts.callTimeoutMs));
    if (version.api !== API_VERSION) {
      throw new EngineError("VERSION", `エンジンの API のバージョンが違います（${version.api}、必要なのは ${API_VERSION}）`);
    }
    const init = parse<InitResult>(await this.raw("init", { zip: this.opts.resZip, dir: this.opts.resDir }, this.opts.bootTimeoutMs));
    this.metrics.initMs = init.initMs;
    this.metrics.readyMs = Math.round(performance.now() - t0);
    this.setStatus("ready");
  }

  load(puzzle: unknown): Promise<StepResult> {
    return this.call<StepResult>("load", { json: JSON.stringify(puzzle) });
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
    this.failAll(new EngineError("WORKER", "エンジンを停止しました"));
    this.setStatus("idle");
  }

  /** エンジンを作り直す（タイムアウトや Worker の異常の後の復帰用） */
  async restart(): Promise<void> {
    this.terminate();
    await this.start();
  }

  private async call<T>(method: WorkerMethod, args: Record<string, unknown> = {}): Promise<T> {
    await this.start();
    // 呼び出しを 1 つずつ順に流す
    const run = this.queue.then(async () => parse<T>(await this.raw(method, args, this.opts.callTimeoutMs)));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private raw(method: WorkerMethod, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new EngineError("WORKER", "エンジンが起動していません"));
    return new Promise<string>((resolve, reject) => {
      const id = ++this.seq;
      const timer = window.setTimeout(() => {
        this.waiting.delete(id);
        reject(new EngineError("TIMEOUT", `エンジンが応答しません（${method}、${Math.round(timeoutMs / 1000)} 秒）`));
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
    throw new EngineError("WORKER", `エンジンの応答を読めません: ${raw.slice(0, 200)}`);
  }
  if (v && typeof v === "object" && "error" in v) {
    const { code, message } = (v as ApiError).error;
    throw new EngineError(code, message);
  }
  return v as T;
}
