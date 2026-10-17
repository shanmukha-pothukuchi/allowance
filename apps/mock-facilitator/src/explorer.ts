/**
 * Tiny inline-CSS explorer pages. Shown on a projector for a few seconds, so: big,
 * legible, no framework. `/explorer` polls `/txs` and `/balances` every 3 s.
 */
import type { Tx } from "./ledger.js";

const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; background: #f6f7f9; color: #111827; font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 32px 0 10px; color: #374151; }
  .sub { color: #6b7280; margin: 0 0 24px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; }
  .badge.settle { background: #dbeafe; color: #1e40af; }
  .badge.mint { background: #dcfce7; color: #166534; }
  .badge.transfer { background: #fef3c7; color: #92400e; }
  .badge.mock { background: #e5e7eb; color: #374151; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid #eef0f3; white-space: nowrap; }
  th { background: #f9fafb; font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: .04em; }
  tr:last-child td { border-bottom: 0; }
  td.amt { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; }
  th.amt { text-align: right; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #9ca3af; text-align: center; padding: 28px; }
  .kv { display: grid; grid-template-columns: 160px 1fr; gap: 10px 16px; background: #fff; padding: 20px 24px; border-radius: 12px; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  .kv dt { color: #6b7280; } .kv dd { margin: 0; word-break: break-all; }
  .live { color: #16a34a; font-size: 13px; }
`;

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function shortHash(h: string): string {
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function explorerPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Mock USDC Explorer</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head>
<body>
<h1>Mock USDC Explorer <span class="badge mock">mock · eip155:84532</span></h1>
<p class="sub">In-memory USDC ledger used by Allowance in <code>CHAIN_MODE=mock</code>. Signatures are real; settlement is simulated. <span class="live" id="live">● live</span></p>
<h2>Recent transactions</h2>
<table><thead><tr><th>Hash</th><th>Kind</th><th>From</th><th>To</th><th class="amt">Amount</th><th>Time</th></tr></thead>
<tbody id="txs"><tr><td class="empty" colspan="6">Loading…</td></tr></tbody></table>
<h2>Balances</h2>
<table><thead><tr><th>Address</th><th class="amt">Balance</th></tr></thead>
<tbody id="bals"><tr><td class="empty" colspan="2">Loading…</td></tr></tbody></table>
<script>
const esc = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const short = (h, a, b) => h.slice(0, a) + "…" + h.slice(-b);
async function refresh() {
  try {
    const [t, b] = await Promise.all([fetch("/txs?limit=40").then(r => r.json()), fetch("/balances").then(r => r.json())]);
    const txs = t.txs || [];
    document.getElementById("txs").innerHTML = txs.length ? txs.map(tx =>
      '<tr><td><a class="mono" href="/tx/' + esc(tx.hash) + '">' + esc(short(tx.hash, 10, 6)) + '</a></td>' +
      '<td><span class="badge ' + esc(tx.kind) + '">' + esc(tx.kind) + '</span></td>' +
      '<td class="mono" title="' + esc(tx.from) + '">' + esc(short(tx.from, 6, 4)) + '</td>' +
      '<td class="mono" title="' + esc(tx.to) + '">' + esc(short(tx.to, 6, 4)) + '</td>' +
      '<td class="amt">$' + esc(tx.amount) + '</td>' +
      '<td>' + esc(new Date(tx.at).toLocaleTimeString()) + (tx.memo ? ' <span style="color:#6b7280">· ' + esc(tx.memo) + '</span>' : '') + '</td></tr>'
    ).join("") : '<tr><td class="empty" colspan="6">No transactions yet</td></tr>';
    const bals = b.balances || [];
    document.getElementById("bals").innerHTML = bals.length ? bals.map(x =>
      '<tr><td class="mono">' + esc(x.address) + '</td><td class="amt">$' + esc(x.balance) + '</td></tr>'
    ).join("") : '<tr><td class="empty" colspan="2">No accounts yet</td></tr>';
    document.getElementById("live").textContent = "● live · " + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById("live").textContent = "○ offline";
  }
}
refresh(); setInterval(refresh, 3000);
</script>
</body></html>`;
}

export function txPage(tx: Tx): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Tx ${esc(shortHash(tx.hash))}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head>
<body>
<h1>Transaction <span class="badge ${esc(tx.kind)}">${esc(tx.kind)}</span></h1>
<p class="sub"><a href="/explorer">← Explorer</a> · mock ledger, eip155:84532</p>
<dl class="kv">
  <dt>Hash</dt><dd class="mono">${esc(tx.hash)}</dd>
  <dt>Status</dt><dd>✅ Confirmed (simulated)</dd>
  <dt>From</dt><dd class="mono">${esc(tx.from)}</dd>
  <dt>To</dt><dd class="mono">${esc(tx.to)}</dd>
  <dt>Amount</dt><dd><strong>$${esc(tx.amount)} USDC</strong> <span style="color:#6b7280">(${esc(tx.amountBaseUnits)} base units)</span></dd>
  <dt>Time</dt><dd>${esc(tx.at)}</dd>
  ${tx.memo ? `<dt>Memo</dt><dd>${esc(tx.memo)}</dd>` : ""}
</dl>
</body></html>`;
}

export function notFoundPage(hash: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title><style>${CSS}</style></head>
<body><h1>Transaction not found</h1><p class="sub"><code>${esc(hash)}</code></p><p><a href="/explorer">← Explorer</a></p></body></html>`;
}
