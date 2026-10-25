// エンジンの Worker（classic Worker）。CheerpJ を Worker の中で動かし、メインスレッドとは postMessage でやり取りする。
// CheerpJ の loader.js は importScripts で読むので、Vite のモジュール Worker にはせず public/ に置く。
// やり取りの形は src/engine/protocol.ts の WorkerRequest / WorkerResponse。
importScripts("https://cjrtnc.leaningtech.com/4.3/loader.js");

// CheerpJ 4.3 の cheerpOS.js にある fileCache / inodeCache の参照数ずれ（cacheRefCount が undefined で落ちる不具合）を無害化する
self.addEventListener("error", (e) => {
  if (String(e?.message || "").includes("cacheRefCount")) {
    e.preventDefault();
  }
});

/**
 * ページ更新や中断で IndexedDB（cjFS_/files/）のディレクトリ contents と実体レコードや nextInode が食い違うと、
 * 次の起動時に CheerpJ の idbResolve / cjGraceTimeExpire が例外を投げて止まるため、起動前に整合性を修復する。
 */
async function sanitizeCheerpjIdb() {
  if (typeof indexedDB === "undefined") return;
  const dbName = "cjFS_/files/";
  const deleteDb = () =>
    new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(dbName);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName);
      req.onupgradeneeded = (e) => {
        if (e.oldVersion === 0) e.target.transaction.abort();
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return;
  }
  try {
    if (!db.objectStoreNames.contains("files")) {
      db.close();
      await deleteDb();
      return;
    }
    const tx = db.transaction("files", "readwrite");
    const store = tx.objectStore("files");
    const [keys, vals] = await Promise.all([
      new Promise((resolve, reject) => {
        const r = store.getAllKeys();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }),
      new Promise((resolve, reject) => {
        const r = store.getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      }),
    ]);
    const map = new Map();
    for (let i = 0; i < keys.length; i++) {
      if (typeof keys[i] === "string" && vals[i] && typeof vals[i] === "object") {
        map.set(keys[i], vals[i]);
      } else {
        store.delete(keys[i]);
      }
    }
    const root = map.get("");
    if (!root || root.type !== "dir") {
      db.close();
      await deleteDb();
      return;
    }
    // 1. 展開途中で止まった res-base（.bundle-size が無い）と、問題ごとに書き直す一時ディレクトリを消す
    const removePrefixes = [];
    for (const [k, v] of map) {
      if (k.startsWith("/res-base-") && !k.includes("/", 1)) {
        const marker = map.get(`${k}/.bundle-size`);
        if (v.type !== "dir" || !marker || !(marker.contents instanceof Uint8Array) || marker.contents.length === 0) {
          removePrefixes.push(k);
        } else {
          removePrefixes.push(`${k}/cardsfolder`, `${k}/editions`, `${k}/tokenscripts`, `${k}/languages/cardnames-ja-JP.txt`);
        }
      }
    }
    if (removePrefixes.length) {
      for (const k of [...map.keys()]) {
        if (removePrefixes.some((p) => k === p || k.startsWith(`${p}/`))) {
          map.delete(k);
          store.delete(k);
        }
      }
    }
    // 2. 親ディレクトリが存在しない孤児キーや、書き込み途中で止まったファイルレコード（contents: null）を消す
    const sortedKeys = [...map.keys()].sort((a, b) => a.length - b.length);
    for (const k of sortedKeys) {
      if (k === "") continue;
      const slash = k.lastIndexOf("/");
      const parentKey = slash <= 0 ? "" : k.slice(0, slash);
      const parent = map.get(parentKey);
      const rec = map.get(k);
      const invalidFile = rec.type === "file" && !(rec.contents instanceof Uint8Array);
      if (!parent || parent.type !== "dir" || invalidFile) {
        map.delete(k);
        store.delete(k);
      }
    }
    // 3. すべてのディレクトリの contents を、実在する子キーから組み立て直す
    const childrenOf = new Map();
    for (const [k, v] of map) {
      if (v.type === "dir") childrenOf.set(k, []);
    }
    for (const k of map.keys()) {
      if (k === "") continue;
      const slash = k.lastIndexOf("/");
      const parentKey = slash <= 0 ? "" : k.slice(0, slash);
      const childEntry = k.slice(slash);
      const list = childrenOf.get(parentKey);
      if (list) list.push(childEntry);
    }
    // 4. inodeId の重複・欠損を直し、root.nextInode を最大値 + 1 に揃える
    let maxInode = 1;
    for (const v of map.values()) {
      if (Number.isInteger(v.inodeId) && v.inodeId > maxInode) maxInode = v.inodeId;
    }
    const seenInodes = new Set([1]);
    root.inodeId = 1;
    for (const [k, v] of map) {
      let dirty = false;
      if (k !== "") {
        if (!Number.isInteger(v.inodeId) || v.inodeId <= 1 || seenInodes.has(v.inodeId)) {
          v.inodeId = ++maxInode;
          dirty = true;
        }
        seenInodes.add(v.inodeId);
      }
      if (v.type === "dir") {
        const want = childrenOf.get(k) || [];
        const cur = Array.isArray(v.contents) ? v.contents : [];
        if (cur.length !== want.length || cur.some((c, i) => c !== want[i])) {
          v.contents = want;
          dirty = true;
        }
      }
      if (dirty && k !== "") store.put(v, k);
    }
    root.nextInode = Math.max(Number.isInteger(root.nextInode) ? root.nextInode : 2, maxInode + 1);
    store.put(root, "");
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    console.warn("[worker] IndexedDB の修復に失敗したため初期化し直します", e);
    try {
      db.close();
    } catch {}
    await deleteDb();
  }
}

/** CheerpJ の CheerpJFolder キャッシュ参照数の不整合を補正する */
function patchCheerpJ() {
  const proto = self.CheerpJFolder && self.CheerpJFolder.prototype;
  if (proto && !proto.__patched) {
    proto.__patched = true;
    proto.decRefCached = function (fileName, fileData) {
      if (!fileData || typeof fileData !== "object") return;
      fileData.cacheRefCount = (fileData.cacheRefCount - 1) | 0;
      if (fileData.cacheRefCount <= 0) {
        delete this.inodeCache[fileData.inodeId];
      }
    };
    proto.getCached = function (fileName) {
      const c = this.fileCache;
      if (!Object.prototype.hasOwnProperty.call(c, fileName)) return null;
      const inodeId = c[fileName];
      const ret = this.inodeCache[inodeId];
      if (!ret) {
        delete c[fileName];
        return null;
      }
      return ret;
    };
    proto.setCached = function (fileName, fileData) {
      if (!fileData) return;
      const c = this.fileCache;
      fileData.cacheRefCount = (fileData.cacheRefCount + 1) | 0;
      if (Object.prototype.hasOwnProperty.call(c, fileName)) {
        const prev = this.inodeCache[c[fileName]];
        if (prev) this.decRefCached(fileName, prev);
      }
      const inodeId = fileData.inodeId;
      c[fileName] = inodeId;
      this.inodeCache[inodeId] = fileData;
    };
    proto.clearCached = function (fileName) {
      const c = this.fileCache;
      if (Object.prototype.hasOwnProperty.call(c, fileName)) {
        const inodeId = c[fileName];
        const data = this.inodeCache[inodeId];
        if (data) this.decRefCached(fileName, data);
        delete c[fileName];
      }
    };
  }
}

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
    await sanitizeCheerpjIdb();
    const opts = { version: 17, status: "none" };
    if (preload) opts.preloadResources = preload;
    await cheerpjInit(opts);
    patchCheerpJ();
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
