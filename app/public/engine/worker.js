// エンジンの Worker（classic Worker）。CheerpJ を Worker の中で動かし、メインスレッドとは postMessage でやり取りする。
// CheerpJ の loader.js は importScripts で読むので、Vite のモジュール Worker にはせず public/ に置く。
// やり取りの形は src/engine/protocol.ts の WorkerRequest / WorkerResponse。
importScripts("https://cjrtnc.leaningtech.com/4.3/loader.js");

let api;
/** カードデータ（tools/build-engine.sh が作る .json.gz。CardData.java）。一度読んだら Worker の中に置いておく */
let cardData = null;
let cardDataUrl = null;

async function loadCardData(url) {
  if (cardData && cardDataUrl === url) return cardData;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`カードデータを読めません: ${res.status} ${url}`);
  let body = new Uint8Array(await res.arrayBuffer());
  // .gz をそのまま返すサーバーと、Content-Encoding を付けて展開済みで渡すサーバーの両方がある
  if (body[0] === 0x1f && body[1] === 0x8b) {
    body = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  }
  cardData = JSON.parse(new TextDecoder().decode(body));
  cardDataUrl = url;
  return cardData;
}

/**
 * カードデータから、names のカードと、それが依存するカード・トークンを抜き出して WebApi.useCards の引数を作る。
 * CardData.select（Java、JVM での確かめ用）と同じ処理
 */
function selectCards(data, names) {
  const lower = [...new Set(names.map((n) => n.split(" // ")[0].trim().toLowerCase()))].sort();
  const picked = new Set();
  const todo = [...lower];
  while (todo.length) {
    const i = data.keys[todo.pop()];
    if (i === undefined || picked.has(i)) continue;
    picked.add(i);
    for (const d of data.cards[i].d || []) todo.push(d);
  }
  const cards = [];
  const editions = {};
  let ja = "";
  const tokenTodo = [...data.alwaysTokens];
  for (const i of [...picked].sort((a, b) => a - b)) {
    const c = data.cards[i];
    cards.push({ f: c.f, s: c.s });
    if (c.e) editions[c.e] = data.editions[c.e];
    if (c.j) ja += c.j;
    if (c.t) tokenTodo.push(...c.t);
  }
  // トークンと、そのトークンが作るトークン
  const tokens = {};
  while (tokenTodo.length) {
    const name = tokenTodo.pop();
    const t = data.tokens[name];
    if (!t || name in tokens) continue;
    tokens[name] = t.s;
    if (t.t) tokenTodo.push(...t.t);
  }
  return { key: lower.join(","), cards, editions, tokens, ja };
}

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
  prepare: ({ zip, dir }) => api.prepare(zip, dir),
  async useCards({ names, url }) {
    const t0 = performance.now();
    const data = await loadCardData(url);
    const t1 = performance.now();
    const r = JSON.parse(String(await api.useCards(JSON.stringify(selectCards(data, names)))));
    // 計測用: カードデータの読み込み（初回だけ）と抜き出しの時間
    if (!r.error) Object.assign(r, { fetchMs: Math.round(t1 - t0), totalMs: Math.round(performance.now() - t0) });
    return JSON.stringify(r);
  },
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
