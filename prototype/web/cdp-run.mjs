// ヘッドレス Chrome を CDP で操作して、検証ページを実時間で計測する。
// 同じプロファイルのまま N 回読み込み、初回と 2 回目以降（キャッシュあり）の挙動を比べる。
// 使い方: node cdp-run.mjs <chrome.exe> <profileDir> <url> [回数=2]
import { spawn } from "node:child_process";

const [chrome, profile, url, times = "2"] = process.argv.slice(2);
const PORT = 9333;
const proc = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`, "about:blank"], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = tabs.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 起動待ち */ }
    await sleep(200);
  }
  throw new Error("Chrome に接続できません");
}

const ws = new WebSocket(await connect());
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const pending = new Map();
const consoleLines = [];
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.consoleAPICalled") consoleLines.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  if (msg.method === "Log.entryAdded") consoleLines.push(`[${msg.params.entry.level}] ${msg.params.entry.text}`);
});
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send("Runtime.enable");
if (process.env.THROTTLE) {
  // モバイル相当の目安として CPU を遅くする（例: THROTTLE=4 で 4 倍遅い）。実機の代わりにはならない
  await send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.THROTTLE) });
}
await send("Log.enable");

for (let i = 1; i <= Number(times); i++) {
  consoleLines.length = 0;
  await send("Page.navigate", { url: `${url}${url.includes("?") ? "&" : "?"}n=${i}` });
  const t0 = Date.now();
  let m;
  while (Date.now() - t0 < 120_000) {
    await sleep(1000);
    m = await evaluate("JSON.stringify(window.__metrics || null)");
    if (m && m !== "null" && (JSON.parse(m).readyMs || JSON.parse(m).error)) break;
  }
  const waited = Date.now() - t0;
  let play = null;
  if (m && m !== "null" && JSON.parse(m).readyMs) {
    play = await evaluate(`__harness.play("s1-bolt", ["Lightning Bolt", "player:p2", "Pass"]).then(r => r.status + " " + r.reason)`);
    m = await evaluate("JSON.stringify(window.__metrics || null)"); // 操作後の計測値（load / submit / longTasks）も含める
  }
  let extra = null;
  if (process.env.EVAL && play) {
    // 追加の計測（例: EVAL='__harness.benchState(20)'）
    extra = await evaluate(`Promise.resolve(${process.env.EVAL}).then(r => JSON.stringify(r))`);
  }
  if (process.env.CAPTURE_PRELOAD && play) {
    // CheerpJ が実際に読んだランタイムと jar の範囲。preloadResources に渡す一覧になる
    const res = await evaluate("cjGetRuntimeResources()");
    (await import("node:fs")).writeFileSync(process.env.CAPTURE_PRELOAD, typeof res === "string" ? res : JSON.stringify(res));
  }
  // 配信元ごとの転送量（KB）。transferSize が 0 のものはブラウザのキャッシュから読んでいる
  const transfer = await evaluate(`(() => { const t = {}; for (const r of performance.getEntriesByType("resource")) {
    const k = new URL(r.name).host + (r.name.endsWith(".jar") ? " (jar)" : ""); t[k] = (t[k] || 0) + Math.round(r.transferSize / 1024); } return t; })()`);
  console.log(JSON.stringify({ run: i, waitedMs: waited, extra, transferKB: transfer, metrics: m && JSON.parse(m), s1: play,
    warnings: consoleLines.filter((l) => /warn|error|postMessage/i.test(l)).slice(0, 5) }));
}
ws.close();
proc.kill();
process.exit(0);
