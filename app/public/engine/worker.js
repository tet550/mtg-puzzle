// エンジンの Worker（classic Worker）。CheerpJ を Worker の中で動かし、メインスレッドとは postMessage でやり取りする。
// CheerpJ の loader.js は importScripts で読むので、Vite のモジュール Worker にはせず public/ に置く。
// やり取りの形は src/engine/protocol.ts の WorkerRequest / WorkerResponse。
importScripts("https://cjrtnc.leaningtech.com/4.3/loader.js");

let api;

const handlers = {
  async boot({ jar, preload }) {
    const opts = { version: 17, status: "none" };
    if (preload) opts.preloadResources = preload;
    await cheerpjInit(opts);
    const lib = await cheerpjRunLibrary(jar);
    api = await lib.mtgpuzzle.adapter.WebApi;
    return "ok";
  },
  init: ({ zip, dir }) => api.init(zip, dir),
  version: () => api.version(),
  load: ({ json }) => api.load(json),
  submit: ({ ids }) => api.submit(ids),
  reset: () => api.reset(),
  state: () => api.state(),
  heap: () => api.heap(),
};

self.onmessage = async (e) => {
  const { id, method, args } = e.data;
  try {
    const result = await handlers[method](args || {});
    self.postMessage({ id, result: String(result) });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.stack) || err) });
  }
};
