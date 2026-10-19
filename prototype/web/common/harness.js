// 方式ごとの engine（init / load / submit / reset を持つ）を受け取り、検証用の最小 UI を動かす共通ハーネス。
// engine の各メソッドは WebApi の JSON 文字列をそのまま返す。

const PUZZLES = ["s1-bolt", "s2-attack", "s3-self-bolt", "s4-etb-trigger", "s6-activated", "s8-sick-attacker"];

const $ = (id) => document.getElementById(id);
const metrics = {};

function log(line) {
  const el = $("log");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
  console.log("[harness] " + line);
}

function metric(name, value) {
  metrics[name] = value;
  $("metrics").textContent = JSON.stringify(metrics, null, 2);
  window.__metrics = metrics;
}

async function timed(name, fn) {
  const t0 = performance.now();
  const raw = await fn();
  const ms = Math.round(performance.now() - t0);
  metric(name, ms);
  const res = JSON.parse(raw);
  if (res.error) throw new Error(res.error);
  return res;
}

function render(step) {
  window.__lastStep = step;
  $("status").textContent = `${step.status} ${step.reason || ""}`;
  const st = step.state;
  const lines = [`turn ${st.turn} ${st.phase} active=${st.activePlayer} priority=${st.priorityPlayer} stack=${st.stackSize}`];
  for (const s of st.stack) lines.push(`  stack: ${s}`);
  for (const p of st.players) {
    lines.push(`${p.id} life=${p.life}`);
    for (const c of p.cards.filter((c) => c.zone !== "Library")) {
      lines.push(`  [${c.zone}] ${c.instanceId ?? "-"} ${c.name}${c.tapped ? " (T)" : ""}${c.sick ? " (sick)" : ""}`);
    }
  }
  $("state").textContent = lines.join("\n");
  for (const e of step.events) log("event: " + e);

  const box = $("decision");
  box.innerHTML = "";
  const d = step.pending;
  if (!d) return;
  const title = document.createElement("div");
  title.textContent = `${d.kind}: ${d.prompt} (min ${d.min}, max ${d.max})`;
  box.appendChild(title);
  const selected = new Set();
  for (const o of d.options) {
    const b = document.createElement("button");
    b.textContent = o.label;
    b.dataset.id = o.id;
    b.onclick = () => {
      if (d.max === 1 && d.min === 1) return submit([o.id]);
      selected.has(o.id) ? selected.delete(o.id) : selected.add(o.id);
      b.classList.toggle("on");
    };
    box.appendChild(b);
  }
  if (!(d.max === 1 && d.min === 1)) {
    const ok = document.createElement("button");
    ok.textContent = "決定";
    ok.className = "ok";
    ok.onclick = () => submit([...selected]);
    box.appendChild(ok);
  }
}

let engine;

// メインスレッドの Long Task（50 ms 超）を記録する。Java の処理で UI がかたまっていないかの指標（A1）
const longTasks = [];
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) longTasks.push(Math.round(e.duration));
    metric("longTasks", { count: longTasks.length, maxMs: Math.max(0, ...longTasks), totalMs: longTasks.reduce((a, b) => a + b, 0) });
  }).observe({ type: "longtask", buffered: true });
} catch { /* longtask 非対応のブラウザ */ }

async function submit(ids) {
  try {
    render(await timed("lastSubmitMs", () => engine.submit(JSON.stringify(ids))));
  } catch (e) {
    log("ERROR " + e.message);
  }
}

export async function start(engineImpl, name) {
  engine = engineImpl;
  document.title = `V2 ${name}`;
  $("engine").textContent = name;
  const sel = $("puzzle");
  for (const p of PUZZLES) sel.add(new Option(p, p));
  $("load").onclick = load;
  $("reset").onclick = async () => render(await timed("resetMs", () => engine.reset()));
  try {
    const t0 = performance.now();
    await engine.boot((msg) => log(msg));
    metric("bootMs", Math.round(performance.now() - t0));
    const init = await timed("initCallMs", () => engine.init());
    metric("javaInit", init);
    metric("readyMs", Math.round(performance.now() - t0));
    log("ready");
    $("load").disabled = false;
    $("reset").disabled = false;
  } catch (e) {
    log("BOOT ERROR " + (e.stack || e));
    metric("error", String(e));
  }
}

async function load() {
  const name = $("puzzle").value;
  const json = await (await fetch(`../../puzzles/${name}.json`)).text();
  try {
    render(await timed("loadMs", () => engine.load(json)));
  } catch (e) {
    log("ERROR " + e.message);
  }
}

// 自動検証用: ラベルの先頭一致で選択肢を選ぶ。例 await __harness.play("s1-bolt", ["Lightning Bolt", "player:p2", "Pass"])
window.__harness = {
  // A5: engine を直接呼ぶ（異常系の確認用）
  raw: (method, ...args) => engine[method](...args),
  async play(name, picks) {
    $("puzzle").value = name;
    await load();
    for (const pick of picks) {
      const d = window.__lastStep.pending;
      if (!d) break;
      const ids = pick === "" ? [] : [d.options.find((o) => o.label.startsWith(pick)).id];
      await submit(ids);
    }
    return { status: window.__lastStep.status, reason: window.__lastStep.reason, metrics };
  },
  // A4: 状態取得（JSON 文字列）を n 回呼んだときの 1 回あたりの時間とサイズ
  async benchState(n = 20) {
    const t0 = performance.now();
    let size = 0;
    for (let k = 0; k < n; k++) size = (await engine.state()).length;
    return { perCallMs: Math.round((performance.now() - t0) / n * 10) / 10, jsonBytes: size };
  },
  // A6: reset を n 回くり返し、ヒープ使用量の推移を見る
  async soak(n = 50) {
    const heaps = [];
    for (let k = 0; k < n; k++) {
      const step = JSON.parse(await engine.reset());
      if (step.error) return { error: step.error, at: k };
      if (k % 10 === 9) heaps.push(JSON.parse(await engine.heap?.() ?? "null"));
    }
    return { heaps, perf: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null };
  },
};
