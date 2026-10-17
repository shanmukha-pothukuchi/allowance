import type { AgentWorkDoc } from "@allowance/shared";

export interface BoardOptions {
  doc: AgentWorkDoc;
  basePath: string;
  wellKnownPath: string;
}

/** Escape for safe embedding inside an HTML text node / attribute. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** JSON that is safe inside a <script> tag: no `<`, `>`, `&` or U+2028/9 can break out. */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The live bounty board. Vanilla JS, inline CSS, one file. Everything from the document is
 * rendered through `textContent`, so bounty descriptions (untrusted) can never inject markup.
 */
export function renderBoard({ doc, basePath, wellKnownPath }: BoardOptions): string {
  const title = escapeHtml(doc.site.name);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Bounties</title>
<link rel="alternate" type="application/json" href="${escapeHtml(wellKnownPath)}">
<style>
  :root {
    --bg: #0a0d14; --bg-2: #10151f; --card: #141a26; --line: #222c3d; --line-2: #2f3b52;
    --fg: #eef2f8; --fg-2: #9aa7bd; --fg-3: #65728a;
    --green: #35d07f; --green-2: #0f3b2a; --blue: #5aa2ff; --blue-2: #10233f;
    --amber: #f5b642; --amber-2: #3d2d0d; --red: #ff5d6c; --red-2: #3f1419; --violet: #b48cff;
    --radius: 18px; --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
    font-size: 18px; line-height: 1.45; -webkit-font-smoothing: antialiased;
    background: radial-gradient(1200px 600px at 10% -10%, #182238 0%, transparent 60%), var(--bg);
    min-height: 100vh;
  }
  a { color: var(--blue); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 1480px; margin: 0 auto; padding: 32px 24px 48px; }
  header { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; flex-wrap: wrap; margin-bottom: 28px; }
  .brand h1 { margin: 0; font-size: clamp(36px, 5vw, 60px); letter-spacing: -0.03em; font-weight: 800; line-height: 1; }
  .brand p { margin: 10px 0 0; color: var(--fg-2); font-size: 20px; }
  .brand p b { color: var(--fg); font-weight: 600; }
  .live { display: inline-flex; align-items: center; gap: 10px; padding: 10px 16px; border-radius: 999px; background: var(--bg-2); border: 1px solid var(--line); font-size: 15px; color: var(--fg-2); font-variant-numeric: tabular-nums; }
  .live .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--fg-3); box-shadow: 0 0 0 0 rgba(53,208,127,.5); }
  .live.on .dot { background: var(--green); animation: pulse 2s infinite; }
  .live.poll .dot { background: var(--amber); }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(53,208,127,.55);} 70% { box-shadow: 0 0 0 10px rgba(53,208,127,0);} 100% { box-shadow: 0 0 0 0 rgba(53,208,127,0);} }
  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 24px; align-items: start; }
  @media (max-width: 1100px) { .layout { grid-template-columns: 1fr; } }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 20px; }
  @media (max-width: 480px) { .cards { grid-template-columns: 1fr; } }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 24px 26px; display: flex; flex-direction: column; gap: 14px; position: relative; overflow: hidden; transition: border-color .3s; }
  .card.flash { border-color: var(--green); }
  .card.full { border-color: var(--line-2); }
  .card.closed { opacity: .55; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .chip { font-family: var(--mono); font-size: 13px; color: var(--fg-2); background: var(--bg-2); border: 1px solid var(--line); padding: 4px 10px; border-radius: 8px; }
  .badge { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; padding: 5px 12px; border-radius: 999px; }
  .badge.open { color: var(--green); background: var(--green-2); }
  .badge.full { color: var(--amber); background: var(--amber-2); }
  .badge.closed { color: var(--fg-2); background: var(--bg-2); }
  .card h2 { margin: 0; font-size: 28px; letter-spacing: -0.02em; line-height: 1.15; font-weight: 700; }
  .pay { font-size: 56px; font-weight: 800; letter-spacing: -0.04em; line-height: 1; font-variant-numeric: tabular-nums; }
  .pay small { font-size: 16px; font-weight: 600; color: var(--fg-2); letter-spacing: 0; margin-left: 10px; }
  .slots { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .pills { display: flex; gap: 6px; }
  .pill { width: 34px; height: 12px; border-radius: 999px; background: var(--line-2); transition: background .3s, box-shadow .3s; }
  .pill.open { background: var(--green); box-shadow: 0 0 12px rgba(53,208,127,.45); }
  .slots .label { font-size: 18px; color: var(--fg-2); font-variant-numeric: tabular-nums; }
  .slots .label b { color: var(--fg); font-weight: 700; }
  .desc { margin: 0; color: var(--fg-2); font-size: 17px; white-space: pre-wrap; word-break: break-word; }
  .meta { display: grid; gap: 6px; color: var(--fg-3); font-size: 14px; border-top: 1px solid var(--line); padding-top: 12px; }
  .meta span { color: var(--fg-2); }
  .meta code { font-family: var(--mono); font-size: 13px; color: var(--fg-2); word-break: break-all; }
  aside { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 22px 24px; position: sticky; top: 24px; max-height: calc(100vh - 48px); display: flex; flex-direction: column; }
  aside h3 { margin: 0 0 14px; font-size: 15px; text-transform: uppercase; letter-spacing: .12em; color: var(--fg-2); font-weight: 700; }
  .feed { list-style: none; margin: 0; padding: 0; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
  .feed li { display: grid; grid-template-columns: 12px 1fr auto; gap: 12px; align-items: baseline; padding: 10px 12px; border-radius: 12px; background: var(--bg-2); border: 1px solid var(--line); font-size: 16px; animation: slide .35s ease-out; }
  @keyframes slide { from { opacity: 0; transform: translateY(-6px);} to { opacity: 1; transform: none;} }
  .feed .d { width: 10px; height: 10px; border-radius: 50%; background: var(--fg-3); position: relative; top: -1px; }
  .feed .d.claimed { background: var(--blue); } .feed .d.paid { background: var(--green); }
  .feed .d.rejected { background: var(--amber); } .feed .d.payout_failed { background: var(--red); }
  .feed .d.expired { background: var(--fg-3); } .feed .d.submitted { background: var(--violet); }
  .feed .t { color: var(--fg-3); font-size: 13px; font-variant-numeric: tabular-nums; }
  .feed .who { font-family: var(--mono); font-size: 15px; color: var(--fg); }
  .feed .amt { color: var(--green); font-weight: 700; }
  .feed .tx { font-family: var(--mono); font-size: 13px; }
  .feed .msg { display: block; color: var(--fg-3); font-size: 14px; margin-top: 2px; }
  .empty { color: var(--fg-3); font-size: 15px; padding: 10px 0; }
  footer { margin-top: 36px; color: var(--fg-3); font-size: 15px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  footer code { font-family: var(--mono); color: var(--fg-2); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      <h1 id="site-name"></h1>
      <p>Paid work for agents · <b id="summary"></b></p>
    </div>
    <div class="live" id="live"><span class="dot"></span><span id="live-text">connecting…</span></div>
  </header>
  <div class="layout">
    <section class="cards" id="cards"></section>
    <aside>
      <h3>Live activity</h3>
      <ul class="feed" id="feed"></ul>
      <div class="empty" id="feed-empty">Waiting for agents…</div>
    </aside>
  </div>
  <footer>
    This site pays agents via the <b>agent-work</b> protocol ·
    <a id="json-link" href="${escapeHtml(wellKnownPath)}"><code>GET ${escapeHtml(wellKnownPath)}</code></a>
  </footer>
</div>
<script id="initial" type="application/json">${safeJson(doc)}</script>
<script>
(function () {
  var BASE = ${safeJson(basePath)};
  var WK = ${safeJson(wellKnownPath)};
  var doc = JSON.parse(document.getElementById("initial").textContent);
  var cards = document.getElementById("cards");
  var feedEl = document.getElementById("feed");
  var feedEmpty = document.getElementById("feed-empty");
  var live = document.getElementById("live");
  var liveText = document.getElementById("live-text");
  var cardEls = {};

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = String(text);
    return el;
  }
  function money(amount) {
    var n = Number(amount);
    return isFinite(n) ? "$" + n.toFixed(2) : "$" + amount;
  }
  function shortWallet(a) { return a ? a.slice(0, 6) + "\\u2026" + a.slice(-4) : ""; }
  function shortHash(a) { return a ? a.slice(0, 10) + "\\u2026" : ""; }
  function time(iso) {
    var d = iso ? new Date(iso) : new Date();
    return d.toTimeString().slice(0, 8);
  }

  function buildCard(b) {
    var card = h("article", "card");
    card.dataset.id = b.id;
    var top = h("div", "row");
    top.appendChild(h("span", "chip", b.taskType));
    top.appendChild(h("span", "badge"));
    card.appendChild(top);
    card.appendChild(h("h2", null, b.title));
    var pay = h("div", "pay");
    pay.appendChild(document.createTextNode(""));
    pay.appendChild(h("small", null, ""));
    card.appendChild(pay);
    var slots = h("div", "slots");
    slots.appendChild(h("div", "pills"));
    slots.appendChild(h("div", "label"));
    card.appendChild(slots);
    card.appendChild(h("p", "desc", b.description));
    var meta = h("div", "meta");
    var v = h("div"); v.appendChild(document.createTextNode("Verified: ")); v.appendChild(h("span", null, b.verification)); meta.appendChild(v);
    var t = h("div"); t.appendChild(document.createTextNode("Claim held for ")); t.appendChild(h("span", null, b.claimTtlSeconds + " s")); meta.appendChild(t);
    var c = h("div"); c.appendChild(document.createTextNode("POST ")); c.appendChild(h("code", null, b.claimUrl)); meta.appendChild(c);
    card.appendChild(meta);
    return card;
  }

  function updateCard(card, b) {
    card.className = "card " + b.status;
    var badge = card.querySelector(".badge");
    badge.className = "badge " + b.status;
    badge.textContent = b.status === "full" ? "all slots taken" : b.status;
    var pay = card.querySelector(".pay");
    pay.firstChild.textContent = money(b.payout.amount);
    pay.querySelector("small").textContent = b.payout.asset + " per task";
    var pills = card.querySelector(".pills");
    while (pills.firstChild) pills.removeChild(pills.firstChild);
    for (var i = 0; i < b.slots.total; i++) {
      pills.appendChild(h("span", "pill" + (i < b.slots.remaining ? " open" : "")));
    }
    var label = card.querySelector(".label");
    while (label.firstChild) label.removeChild(label.firstChild);
    label.appendChild(h("b", null, b.slots.remaining));
    label.appendChild(document.createTextNode(" of " + b.slots.total + " slots open"));
    card.querySelector(".desc").textContent = b.description;
  }

  function render() {
    document.getElementById("site-name").textContent = doc.site.name;
    document.title = doc.site.name + " \\u00b7 Bounties";
    var open = 0, total = 0, totalPay = 0;
    doc.bounties.forEach(function (b) {
      if (b.status !== "closed") { open += b.slots.remaining; total += b.slots.total; }
      totalPay += Number(b.payout.amount) * b.slots.total;
    });
    document.getElementById("summary").textContent =
      doc.bounties.length + " bount" + (doc.bounties.length === 1 ? "y" : "ies") + " \\u00b7 " + open + " of " + total + " slots open \\u00b7 " + money(totalPay) + " on the table";
    var seen = {};
    doc.bounties.forEach(function (b) {
      seen[b.id] = true;
      var card = cardEls[b.id];
      if (!card) { card = buildCard(b); cardEls[b.id] = card; cards.appendChild(card); }
      updateCard(card, b);
    });
    Object.keys(cardEls).forEach(function (id) {
      if (!seen[id]) { cards.removeChild(cardEls[id]); delete cardEls[id]; }
    });
  }

  function flash(id) {
    var card = cardEls[id];
    if (!card) return;
    card.classList.add("flash");
    setTimeout(function () { card.classList.remove("flash"); }, 900);
  }

  function applyEvent(e) {
    var b = null;
    for (var i = 0; i < doc.bounties.length; i++) if (doc.bounties[i].id === e.bountyId) b = doc.bounties[i];
    if (b && e.slots) {
      b.slots = e.slots;
      if (b.status !== "closed") b.status = e.slots.remaining === 0 ? "full" : "open";
    }
    render();
    if (e.type === "paid" || e.type === "claimed") flash(e.bountyId);
    pushFeed(e, b);
  }

  var VERB = { claimed: "claimed a slot on", paid: "was paid", rejected: "work rejected on", expired: "claim expired on", payout_failed: "payout failed on", submitted: "submitted work for" };
  function pushFeed(e, b) {
    var li = h("li");
    li.appendChild(h("span", "d " + e.type));
    var body = h("div");
    var who = h("span", "who", e.agentName ? e.agentName + " " : "");
    if (e.walletAddress) {
      who.appendChild(h("span", null, e.agentName ? "(" + shortWallet(e.walletAddress) + ")" : shortWallet(e.walletAddress)));
    }
    body.appendChild(who);
    body.appendChild(document.createTextNode(" " + (VERB[e.type] || e.type) + " "));
    if (e.type === "paid") {
      body.appendChild(h("span", "amt", money(e.amount)));
      body.appendChild(document.createTextNode(" for "));
    }
    body.appendChild(h("b", null, b ? b.title : e.bountyId));
    if (e.txHash) {
      body.appendChild(document.createTextNode(" \\u00b7 "));
      if (e.explorerUrl) {
        var a = h("a", "tx", "tx " + shortHash(e.txHash));
        a.href = e.explorerUrl; a.target = "_blank"; a.rel = "noopener";
        body.appendChild(a);
      } else {
        body.appendChild(h("span", "tx", "tx " + shortHash(e.txHash)));
      }
    }
    if (e.message && e.type !== "paid") body.appendChild(h("span", "msg", e.message));
    li.appendChild(body);
    li.appendChild(h("span", "t", time(e.at)));
    feedEl.insertBefore(li, feedEl.firstChild);
    while (feedEl.children.length > 60) feedEl.removeChild(feedEl.lastChild);
    feedEmpty.style.display = "none";
  }

  // --- live updates: SSE first, polling as the fallback ----------------------------------
  var pollTimer = null;
  function setLive(mode, text) { live.className = "live " + mode; liveText.textContent = text; }
  function poll() {
    fetch(WK, { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.protocol === "agent-work") { doc = d; render(); } })
      .catch(function () {});
  }
  function startPolling() {
    if (pollTimer) return;
    setLive("poll", "polling every 2 s");
    poll();
    pollTimer = setInterval(poll, 2000);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function connect() {
    if (!window.EventSource) { startPolling(); return; }
    var es = new EventSource(BASE + "/events");
    es.onopen = function () { stopPolling(); setLive("on", "live"); };
    es.onerror = function () { startPolling(); };
    es.addEventListener("snapshot", function (ev) {
      try { doc = JSON.parse(ev.data); render(); } catch (e) {}
    });
    ["claimed", "expired", "submitted", "rejected", "paid", "payout_failed"].forEach(function (type) {
      es.addEventListener(type, function (ev) {
        try { applyEvent(JSON.parse(ev.data)); } catch (e) {}
      });
    });
  }

  render();
  connect();
})();
</script>
</body>
</html>`;
}
