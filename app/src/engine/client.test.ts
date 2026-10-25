import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForgeEngine } from "./client";
import { API_VERSION, type WorkerRequest, type WorkerResponse } from "./protocol";

class FakeWorker {
  static instances: FakeWorker[] = [];
  static failFirstUseCards = false;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;

  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }

  postMessage(req: WorkerRequest) {
    queueMicrotask(() => {
      if (this.terminated) return;
      const reply = (result: unknown) => {
        this.onmessage?.({ data: { id: req.id, result: JSON.stringify(result) } } as MessageEvent<WorkerResponse>);
      };
      switch (req.method) {
        case "boot":
          this.onmessage?.({ data: { id: req.id, result: "ok" } } as MessageEvent<WorkerResponse>);
          break;
        case "version":
          reply({ api: API_VERSION, forge: "2.0.15" });
          break;
        case "prepare":
          reply({ extractCached: true, extractMs: 1 });
          break;
        case "useCards":
          if (FakeWorker.failFirstUseCards) {
            FakeWorker.failFirstUseCards = false;
            reply({ error: { code: "INTERNAL", message: "NoSuchFileException: /files/res-base/cardsfolder/bolt.txt" } });
            return;
          }
          reply({ reused: false, cards: 1, initMs: 10 });
          break;
        case "load":
          reply({
            engine: { state: "AWAITING" },
            pending: null,
            events: [],
            debug: [],
            elapsedMs: 5,
            view: { turn: 1, phase: "MAIN1", activePlayer: "p0", priorityPlayer: "p0", stack: [], combat: [], players: [] },
          });
          break;
      }
    });
  }

  terminate() {
    this.terminated = true;
  }
}

describe("ForgeEngine", () => {
  const origWorker = globalThis.Worker;
  const origWindow = globalThis.window;

  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.failFirstUseCards = false;
    (globalThis as unknown as { Worker: typeof FakeWorker }).Worker = FakeWorker;
    if (!globalThis.window) {
      (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
    }
  });

  afterEach(() => {
    globalThis.Worker = origWorker;
    globalThis.window = origWindow;
  });

  it("useCards が INTERNAL エラーで失敗したとき Worker を再起動して load をやり直す", async () => {
    FakeWorker.failFirstUseCards = true;
    const engine = new ForgeEngine({
      jar: "/app/engine/test.jar",
      resZip: "/app/engine/res.zip",
      resDir: "/files/res",
      cardsUrl: "http://localhost/cards.json.gz",
    });

    const step = await engine.load({
      game: { players: [{ hand: [{ cardId: "Lightning Bolt" }] }] },
    });
    expect(step.engine.state).toBe("AWAITING");
    expect(FakeWorker.instances.length).toBe(2);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(FakeWorker.instances[1].terminated).toBe(false);
  });

  it("CheerpJ の cacheRefCount タイマー例外で Worker を落とさない", async () => {
    const engine = new ForgeEngine({
      jar: "/app/engine/test.jar",
      resZip: "/app/engine/res.zip",
      resDir: "/files/res",
      cardsUrl: "http://localhost/cards.json.gz",
    });
    await engine.start();
    const w = FakeWorker.instances[0];
    let prevented = false;
    w.onerror?.({
      message: "Uncaught TypeError: Cannot read properties of undefined (reading 'cacheRefCount')",
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as ErrorEvent);

    expect(prevented).toBe(true);
    expect(w.terminated).toBe(false);
    expect(engine.status).toBe("ready");
  });
});
