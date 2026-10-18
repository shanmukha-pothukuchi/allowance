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
 * Descriptions are shown in full on purpose: a board that hides what agents read hides attacks.
 * Look: the Allowance tokens (dark by default, light on `prefers-color-scheme: light`), rows not
 * cards, and one muted line per event.
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
    color-scheme: dark;
    --bg: #101114; --hover: rgba(255, 255, 255, 0.045);
    --text: #ececee; --text-2: #a4a6ad; --text-3: #7e8189;
    --line: #22242a; --line-2: #2e3036; --fill: #1a1b1f; --fill-2: #222328;
    --accent: #6e79e0; --card: #15161a; --card-line: #24262c;
    --green: #4cb782; --green-bg: rgba(76, 183, 130, 0.12);
    --red: #eb6a6a;
    --amber: #e5a54b;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    --font: "Google Sans", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #ffffff; --hover: rgba(15, 15, 20, 0.045);
      --text: #1c1d21; --text-2: #55565f; --text-3: #74767f;
      --line: #ebebee; --line-2: #dddde2; --fill: #f4f4f6; --fill-2: #ebebee;
      --accent: #5e6ad2; --card: #ffffff; --card-line: #e6e6ea;
      --green: #1e8e52; --green-bg: #e8f4ed;
      --red: #d64545;
      --amber: #d98a17;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); }
  body { font: 14px/1.5 var(--font); -webkit-font-smoothing: antialiased; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  code { font-family: var(--mono); font-size: 12px; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 32px 16px 40px; }
  header { margin-bottom: 20px; }
  .head { display: flex; align-items: center; gap: 12px; }
  h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; flex: 1; min-width: 0; }
  .lede { margin: 2px 0 0; color: var(--text-3); font-size: 13px; font-variant-numeric: tabular-nums; }
  .live { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-3); white-space: nowrap; }
  .live .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); }
  .live.on .dot { background: var(--green); box-shadow: 0 0 0 3px var(--green-bg); }
  .live.poll .dot { background: var(--amber); }
  h2 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 8px; font-size: 13px; font-weight: 500; color: var(--text-2); }
  h2 .n { color: var(--text-3); font-variant-numeric: tabular-nums; }
  section + section { margin-top: 28px; }
  .list { background: var(--card); border: 1px solid var(--card-line); border-radius: 10px; overflow: hidden; }
  .bounty { padding: 12px 14px; transition: background .4s ease; }
  .bounty + .bounty { border-top: 1px solid var(--line); }
  .bounty.flash { background: color-mix(in srgb, var(--green) 9%, transparent); transition: none; }
  .bounty.closed { opacity: .55; }
  .b-top { display: flex; align-items: baseline; gap: 8px; }
  .b-title { margin: 0; font-size: 14px; font-weight: 500; flex: 1; min-width: 0; }
  .pill { font-size: 12px; font-weight: 500; padding: 1px 8px; border-radius: 6px; background: var(--fill-2); color: var(--text-2); }
  .pill[hidden] { display: none; }
  .b-pay { font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .b-meta { color: var(--text-3); font-size: 12.5px; font-variant-numeric: tabular-nums; margin-top: 1px; }
  .b-meta .type { font-family: var(--mono); font-size: 11.5px; }
  .desc { margin: 8px 0 0; color: var(--text-2); font-size: 13.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
  .b-more { margin-top: 6px; }
  .b-more > summary { display: inline-flex; align-items: center; gap: 4px; list-style: none; cursor: pointer; color: var(--text-3); font-size: 12.5px; }
  .b-more > summary::-webkit-details-marker { display: none; }
  .b-more > summary:hover { color: var(--text-2); }
  .b-more > summary svg { transition: transform .15s ease; }
  .b-more[open] > summary svg { transform: rotate(90deg); }
  .b-more dl { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 4px 12px; margin: 8px 0 2px; font-size: 13px; }
  .b-more dt { color: var(--text-3); }
  .b-more dd { margin: 0; color: var(--text-2); overflow-wrap: anywhere; }
  .feed { list-style: none; margin: 0; padding: 0; }
  .feed li { display: grid; grid-template-columns: 8px minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 6px 2px; color: var(--text-2); font-size: 13px; animation: in .3s ease-out; }
  .feed li + li { border-top: 1px solid var(--line); }
  @keyframes in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
  .feed .d { width: 7px; height: 7px; border-radius: 50%; background: var(--text-3); position: relative; top: -1px; }
  .feed .d.paid { background: var(--green); }
  .feed .d.rejected, .feed .d.payout_failed { background: var(--red); }
  .feed .d.expired { background: transparent; box-shadow: inset 0 0 0 1.5px var(--text-3); }
  .feed b { color: var(--text); font-weight: 500; }
  .feed .m { color: var(--text-3); }
  .feed .m a { color: inherit; font-family: var(--mono); font-size: 12px; }
  .feed .m a:hover { color: var(--text-2); }
  .feed .amt { color: var(--text); font-weight: 500; font-variant-numeric: tabular-nums; }
  .empty { color: var(--text-3); font-size: 13px; padding: 6px 2px; }
  footer { margin-top: 28px; color: var(--text-3); font-size: 12px; }
  footer b { font-weight: 500; color: var(--text-2); }
  footer a { color: var(--text-2); }
  footer code { font-size: 11.5px; }
  @media (max-width: 560px) {
    .wrap { padding-top: 20px; }
    .bounty { padding: 12px; }
    .b-more dl { grid-template-columns: 1fr; gap: 0; }
    .b-more dd + dt { margin-top: 6px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="head">
      <h1 id="site-name"></h1>
      <span class="live" id="live" role="status"><span class="dot"></span><span id="live-text">Connecting…</span></span>
    </div>
    <p class="lede">Paid work for agents · <span id="summary"></span></p>
  </header>
  <section>
    <h2>Bounties <span class="n" id="count"></span></h2>
    <div class="list" id="cards"></div>
  </section>
  <section>
    <h2>Activity</h2>
    <ul class="feed" id="feed"></ul>
    <div class="empty" id="feed-empty">Waiting for agents…</div>
  </section>
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
  var SVG = "http://www.w3.org/2000/svg";

  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = String(text);
    return el;
  }
  function chevron() {
    var svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 16 16"); svg.setAttribute("width", "12"); svg.setAttribute("height", "12"); svg.setAttribute("aria-hidden", "true");
    var p = document.createElementNS(SVG, "path");
    p.setAttribute("d", "M6 4l4 4-4 4"); p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.6"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p);
    return svg;
  }
  function money(amount) {
    var n = Number(amount);
    return isFinite(n) ? "$" + n.toFixed(2) : "$" + amount;
  }
  function shortWallet(a) { return a ? a.slice(0, 6) + "\\u2026" + a.slice(-4) : ""; }
  function shortHash(a) { return a ? a.slice(0, 10) + "\\u2026" : ""; }
  function duration(s) { return s % 60 === 0 ? s / 60 + " min" : s + " s"; }
  function ago(iso) {
    var t = iso ? new Date(iso).getTime() : Date.now();
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 10) return "just now";
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return new Date(t).toLocaleDateString();
  }
  function detail(dl, label, value) {
    dl.appendChild(h("dt", null, label));
    var dd = h("dd");
    if (typeof value === "string") dd.textContent = value; else dd.appendChild(value);
    dl.appendChild(dd);
  }

  function buildCard(b) {
    var card = h("article", "bounty");
    card.dataset.id = b.id;
    var top = h("div", "b-top");
    top.appendChild(h("h3", "b-title", b.title));
    var state = h("span", "pill"); state.hidden = true;
    top.appendChild(state);
    top.appendChild(h("span", "b-pay"));
    card.appendChild(top);
    var meta = h("div", "b-meta");
    meta.appendChild(h("span", "type", b.taskType));
    meta.appendChild(document.createTextNode(" \\u00b7 "));
    meta.appendChild(h("span", "slots"));
    card.appendChild(meta);
    card.appendChild(h("p", "desc", b.description));
    var more = h("details", "b-more");
    var sum = h("summary"); sum.appendChild(chevron()); sum.appendChild(document.createTextNode("Details"));
    more.appendChild(sum);
    var dl = h("dl");
    detail(dl, "Verified", b.verification);
    detail(dl, "Claim held", duration(b.claimTtlSeconds));
    detail(dl, "Paid in", b.payout.asset + " \\u00b7 " + b.payout.network);
    var claim = h("span"); claim.appendChild(document.createTextNode("POST ")); claim.appendChild(h("code", null, b.claimUrl));
    detail(dl, "Claim", claim);
    more.appendChild(dl);
    card.appendChild(more);
    return card;
  }

  function updateCard(card, b) {
    card.className = "bounty " + b.status;
    var state = card.querySelector(".pill");
    state.hidden = b.status === "open";
    state.textContent = b.status === "full" ? "Full" : b.status === "closed" ? "Closed" : "";
    var pay = card.querySelector(".b-pay");
    pay.textContent = money(b.payout.amount);
    pay.title = b.payout.amount + " " + b.payout.asset + " per task";
    card.querySelector(".slots").textContent = b.slots.remaining + " of " + b.slots.total + " slots open";
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
    document.getElementById("count").textContent = String(doc.bounties.length);
    document.getElementById("summary").textContent = open + " of " + total + " slots open \\u00b7 " + money(totalPay) + " on the table";
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

  // One muted line per event: "<agent> <did> <bounty> · tx · 2m ago", the amount on the right.
  var VERB = { claimed: "claimed", paid: "was paid for", rejected: "had work rejected on", expired: "let a claim expire on", payout_failed: "wasn't paid for", submitted: "submitted work for" };
  function pushFeed(e, b) {
    var li = h("li");
    li.appendChild(h("span", "d " + e.type));
    var body = h("div");
    var who = h("b", null, e.agentName || shortWallet(e.walletAddress) || "An agent");
    if (e.walletAddress) who.title = e.walletAddress;
    body.appendChild(who);
    body.appendChild(document.createTextNode(" " + (VERB[e.type] || e.type) + " "));
    body.appendChild(h("b", null, b ? b.title : e.bountyId));
    if (e.message && e.type !== "paid") {
      body.appendChild(document.createTextNode(" \\u00b7 "));
      body.appendChild(h("span", null, e.message));
    }
    var m = h("span", "m");
    if (e.txHash) {
      m.appendChild(document.createTextNode(" \\u00b7 "));
      if (e.explorerUrl) {
        var a = h("a", null, "tx " + shortHash(e.txHash));
        a.href = e.explorerUrl; a.target = "_blank"; a.rel = "noopener";
        m.appendChild(a);
      } else {
        m.appendChild(h("span", null, "tx " + shortHash(e.txHash)));
      }
    }
    m.appendChild(document.createTextNode(" \\u00b7 "));
    var t = h("time", null, ago(e.at));
    t.dateTime = e.at || new Date().toISOString();
    t.title = new Date(t.dateTime).toLocaleString();
    m.appendChild(t);
    body.appendChild(m);
    li.appendChild(body);
    li.appendChild(h("span", "amt", e.type === "paid" ? money(e.amount) : ""));
    feedEl.insertBefore(li, feedEl.firstChild);
    while (feedEl.children.length > 60) feedEl.removeChild(feedEl.lastChild);
    feedEmpty.style.display = "none";
  }
  setInterval(function () {
    var ts = feedEl.querySelectorAll("time");
    for (var i = 0; i < ts.length; i++) ts[i].textContent = ago(ts[i].dateTime);
  }, 15000);

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
    setLive("poll", "Polling every 2 s");
    poll();
    pollTimer = setInterval(poll, 2000);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function connect() {
    if (!window.EventSource) { startPolling(); return; }
    var es = new EventSource(BASE + "/events");
    es.onopen = function () { stopPolling(); setLive("on", "Live"); };
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
