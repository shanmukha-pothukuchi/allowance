/**
 * Tiny inline-CSS explorer pages, no framework. `/explorer` polls `/txs` and `/balances` every 3 s.
 * Look: the Allowance tokens (dark by default, light on `prefers-color-scheme: light`), one row per
 * transaction with the amount right-aligned.
 */
import type { Tx } from "./ledger.js";

const CSS = `
  :root {
    color-scheme: dark;
    --bg: #101114; --hover: rgba(255, 255, 255, 0.045);
    --text: #ececee; --text-2: #a4a6ad; --text-3: #7e8189;
    --line: #22242a; --fill-2: #222328;
    --accent: #6e79e0; --card: #15161a; --card-line: #24262c;
    --green: #4cb782; --green-ink: #5fc592; --green-bg: rgba(76, 183, 130, 0.12); --red: #eb6a6a;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    --font: "Google Sans", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #ffffff; --hover: rgba(15, 15, 20, 0.045);
      --text: #1c1d21; --text-2: #55565f; --text-3: #74767f;
      --line: #ebebee; --fill-2: #ebebee;
      --accent: #5e6ad2; --card: #ffffff; --card-line: #e6e6ea;
      --green: #1e8e52; --green-ink: #1f7a4d; --green-bg: #e8f4ed; --red: #d64545;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 var(--font); -webkit-font-smoothing: antialiased; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  code, .mono { font-family: var(--mono); font-size: 12.5px; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 32px 16px 40px; }
  .head { display: flex; align-items: center; gap: 12px; }
  h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
  .lede { margin: 2px 0 0; color: var(--text-3); font-size: 13px; }
  .lede code { font-size: 12px; color: var(--text-2); }
  .back { display: inline-block; color: var(--text-3); font-size: 13px; margin-bottom: 10px; }
  .back:hover { color: var(--text-2); text-decoration: none; }
  h2 { display: flex; align-items: baseline; gap: 8px; margin: 28px 0 8px; font-size: 13px; font-weight: 500; color: var(--text-2); }
  h2 .n { color: var(--text-3); font-variant-numeric: tabular-nums; }
  .kind { font-size: 11.5px; font-weight: 500; padding: 0 7px; border-radius: 6px; background: var(--fill-2); color: var(--text-2); white-space: nowrap; justify-self: start; }
  .live { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-3); white-space: nowrap; }
  .live .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); }
  .live.on .dot { background: var(--green); box-shadow: 0 0 0 3px var(--green-bg); }
  .live.off .dot { background: var(--red); }
  .list { background: var(--card); border: 1px solid var(--card-line); border-radius: 10px; overflow: hidden; }
  .list > * + * { border-top: 1px solid var(--line); }
  .tx { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto 128px 64px 84px; gap: 12px; align-items: center; min-height: 38px; padding: 7px 14px; color: inherit; font-size: 13px; }
  a.tx:hover { background: var(--hover); text-decoration: none; }
  .tx .w { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tx .p, .tx .h { color: var(--text-3); font-family: var(--mono); font-size: 12px; white-space: nowrap; }
  .tx .t { color: var(--text-3); font-size: 12.5px; white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
  .amt { font-variant-numeric: tabular-nums; font-weight: 500; text-align: right; white-space: nowrap; }
  .bal { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 38px; padding: 7px 14px; font-size: 13px; }
  .bal .mono { color: var(--text-2); overflow-wrap: anywhere; }
  .short { display: none; }
  .empty { color: var(--text-3); font-size: 13px; padding: 10px 14px; }
  .kv { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 0; margin: 16px 0 0; padding: 4px 14px; background: var(--card); border: 1px solid var(--card-line); border-radius: 10px; font-size: 13px; }
  .kv dt, .kv dd { padding: 8px 0; margin: 0; }
  .kv dt { color: var(--text-3); padding-right: 16px; }
  .kv dd { overflow-wrap: anywhere; }
  .kv dt:not(:first-of-type), .kv dt:not(:first-of-type) + dd { border-top: 1px solid var(--line); }
  .muted { color: var(--text-3); }
  .ok { display: inline-flex; align-items: center; gap: 0 6px; flex-wrap: wrap; }
  .ok svg { color: var(--green-ink); }
  @media (max-width: 640px) {
    .wrap { padding-top: 20px; }
    .tx { grid-template-columns: 60px minmax(0, 1fr) auto; grid-template-areas: "k w a" "p p t"; gap: 0 10px; padding: 8px 12px; }
    .tx .kind { grid-area: k; } .tx .w { grid-area: w; } .tx .amt { grid-area: a; }
    .tx .p { grid-area: p; } .tx .t { grid-area: t; } .tx .h { display: none; }
    .bal { padding: 7px 12px; }
    .full { display: none; } .short { display: inline; }
    .kv { grid-template-columns: 1fr; padding: 4px 12px; }
    .kv dt { padding-bottom: 0; } .kv dd { padding-top: 0; }
    .kv dt:not(:first-of-type) + dd { border-top: 0; }
  }
`;

const CHECK = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function shortHash(h: string): string {
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head>
<body><div class="wrap">
${body}
</div></body></html>`;
}

export function explorerPage(): string {
  return page(
    "Mock USDC Explorer",
    `<div class="head">
  <h1>Mock USDC Explorer</h1>
  <span class="live" id="live" role="status"><span class="dot"></span><span id="live-text">Connecting…</span></span>
</div>
<p class="lede">In-memory ledger for <code>CHAIN_MODE=mock</code> · eip155:84532 · signatures are real, settlement is simulated</p>
<h2>Transactions <span class="n" id="tx-n"></span></h2>
<div class="list" id="txs"><div class="empty">Loading…</div></div>
<h2>Balances <span class="n" id="bal-n"></span></h2>
<div class="list" id="bals"><div class="empty">Loading…</div></div>
<script>
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const short = (h, a, b) => h.slice(0, a) + "…" + h.slice(-b);
const ago = iso => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return new Date(iso).toLocaleDateString();
};
const live = document.getElementById("live"), liveText = document.getElementById("live-text");
async function refresh() {
  try {
    const [t, b] = await Promise.all([fetch("/txs?limit=40").then(r => r.json()), fetch("/balances").then(r => r.json())]);
    const txs = t.txs || [];
    document.getElementById("tx-n").textContent = txs.length ? String(txs.length) : "";
    document.getElementById("txs").innerHTML = txs.length ? txs.map(tx =>
      '<a class="tx" href="/tx/' + esc(tx.hash) + '">' +
      '<span class="kind">' + esc(tx.kind) + '</span>' +
      '<span class="w">' + esc(tx.memo || "") + '</span>' +
      '<span class="p" title="' + esc(tx.from) + ' → ' + esc(tx.to) + '">' + esc(short(tx.from, 6, 4)) + ' → ' + esc(short(tx.to, 6, 4)) + '</span>' +
      '<span class="h">' + esc(short(tx.hash, 8, 4)) + '</span>' +
      '<time class="t" datetime="' + esc(tx.at) + '" title="' + esc(new Date(tx.at).toLocaleString()) + '">' + esc(ago(tx.at)) + '</time>' +
      '<span class="amt">$' + esc(tx.amount) + '</span></a>'
    ).join("") : '<div class="empty">No transactions yet</div>';
    const bals = b.balances || [];
    document.getElementById("bal-n").textContent = bals.length ? String(bals.length) : "";
    document.getElementById("bals").innerHTML = bals.length ? bals.map(x =>
      '<div class="bal"><span class="mono" title="' + esc(x.address) + '"><span class="full">' + esc(x.address) + '</span><span class="short">' + esc(short(x.address, 8, 6)) + '</span></span>' +
      '<span class="amt">$' + esc(x.balance) + '</span></div>'
    ).join("") : '<div class="empty">No accounts yet</div>';
    live.className = "live on"; liveText.textContent = "Live"; live.title = "Updated " + new Date().toLocaleTimeString();
  } catch (e) {
    live.className = "live off"; liveText.textContent = "Offline"; live.title = "";
  }
}
refresh(); setInterval(refresh, 3000);
</script>`,
  );
}

export function txPage(tx: Tx): string {
  const at = tx.at.replace("T", " ").replace(/(\.\d+)?Z$/, " UTC");
  return page(
    `Tx ${esc(shortHash(tx.hash))}`,
    `<a class="back" href="/explorer">← Explorer</a>
<h1>Transaction <span class="kind">${esc(tx.kind)}</span></h1>
<p class="lede">Mock ledger · eip155:84532</p>
<dl class="kv">
  <dt>Status</dt><dd><span class="ok">${CHECK}Confirmed<span class="muted">· simulated</span></span></dd>
  <dt>Amount</dt><dd><span class="amt">$${esc(tx.amount)} USDC</span> <span class="muted">· ${esc(tx.amountBaseUnits)} base units</span></dd>
  ${tx.memo ? `<dt>Memo</dt><dd>${esc(tx.memo)}</dd>` : ""}
  <dt>From</dt><dd class="mono">${esc(tx.from)}</dd>
  <dt>To</dt><dd class="mono">${esc(tx.to)}</dd>
  <dt>Hash</dt><dd class="mono">${esc(tx.hash)}</dd>
  <dt>Time</dt><dd>${esc(at)}</dd>
</dl>`,
  );
}

export function notFoundPage(hash: string): string {
  return page(
    "Not found",
    `<a class="back" href="/explorer">← Explorer</a>
<h1>Transaction not found</h1>
<p class="lede"><code>${esc(hash)}</code></p>`,
  );
}
