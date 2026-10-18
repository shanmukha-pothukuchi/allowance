/**
 * The viewer page (GET /computer/sessions/:id/view?token=…): the live screen, the status, the queue
 * position, the lease time left and the spend so far. Follows docs/ui-rules.md with the tokens of
 * apps/agent-chat/static/chat.css. It polls the free status endpoint each second and shows the MJPEG
 * stream in an <img>. `&embed=1` drops the page chrome for an iframe (the chat, later).
 *
 * The page only ever holds the view-only token when opened from `viewUrl`; it never shows the token.
 */

export function viewerPage(opts: { id: string; token: string; embed: boolean; nonce: string }): string {
  const boot = JSON.stringify({ id: opts.id, token: opts.token, embed: opts.embed }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en" data-embed="${opts.embed ? "1" : "0"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Computer</title>
<style>
:root {
  color-scheme: dark;
  --bg: #101114; --text: #ececee; --text-2: #a4a6ad; --text-3: #7e8189;
  --line: #22242a; --line-2: #2e3036; --fill: #1a1b1f; --fill-2: #222328;
  --card: #15161a; --card-line: #24262c; --accent-fill: #5e6ad2;
  --green: #4cb782; --red: #eb6a6a; --red-ink: #f08585; --amber: #e5a54b; --amber-ink: #ecb867;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --font: "Google Sans", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) {
  color-scheme: light;
  --bg: #ffffff; --text: #1c1d21; --text-2: #55565f; --text-3: #74767f;
  --line: #ebebee; --line-2: #dddde2; --fill: #f4f4f6; --fill-2: #ebebee;
  --card: #ffffff; --card-line: #e6e6ea; --green: #1e8e52; --red: #d14343; --red-ink: #b93a3a; --amber: #b7791f; --amber-ink: #8a5a12;
} }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.45 var(--font); }
html[data-embed="1"], html[data-embed="1"] body { background: transparent; }
main { max-width: 1040px; margin: 0 auto; padding: 20px 16px 24px; }
html[data-embed="1"] main { padding: 0; max-width: none; }
.head { display: flex; align-items: center; gap: 10px; min-height: 32px; }
.title { font-size: 15px; font-weight: 600; }
html[data-embed="1"] .title { display: none; }
.chip { font-size: 12px; line-height: 20px; padding: 0 8px; border-radius: 999px; background: var(--fill-2); color: var(--text-2); display: inline-flex; align-items: center; gap: 6px; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); }
.chip[data-s="active"] .dot { background: var(--green); }
.chip[data-s="queued"] .dot, .chip[data-s="waiting"] .dot { background: var(--amber); }
.chip[data-s="ended"] .dot { background: var(--text-3); }
.left { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--text-2); }
.left.low { color: var(--amber-ink); }
.meta { color: var(--text-3); margin: 2px 0 12px; font-variant-numeric: tabular-nums; }
.screen { position: relative; aspect-ratio: 1280 / 800; background: var(--card); border: 1px solid var(--card-line); border-radius: 10px; overflow: hidden; }
.screen img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; }
.empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: var(--text-3); text-align: center; padding: 16px; }
.empty b { color: var(--text); font-size: 15px; font-weight: 600; }
.page { margin-top: 8px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.page span { color: var(--text-2); }
.problem { color: var(--red-ink); }
</style>
</head>
<body>
<main>
  <div class="head">
    <span class="title">Computer</span>
    <span class="chip" id="chip" data-s="loading"><span class="dot"></span><span id="state">Loading</span></span>
    <span class="left" id="left"></span>
  </div>
  <div class="meta" id="meta"></div>
  <div class="screen">
    <img id="stream" alt="Live screen" hidden>
    <div class="empty" id="empty"><b id="emptyTitle">Connecting</b><span id="emptyText"></span></div>
  </div>
  <div class="page" id="page"></div>
</main>
<script nonce="${opts.nonce}">
(() => {
  const boot = ${boot};
  const base = "/computer/sessions/" + encodeURIComponent(boot.id);
  const q = "?token=" + encodeURIComponent(boot.token);
  const $ = (id) => document.getElementById(id);
  let last = null, leaseEndsAt = 0, streaming = false, retry = 0;

  const usd = (s) => "$" + (s || "0");
  const clock = (sec) => { sec = Math.max(0, Math.round(sec)); return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0"); };

  function setEmpty(title, text) {
    $("empty").hidden = false; $("emptyTitle").textContent = title; $("emptyText").textContent = text || "";
  }
  function startStream() {
    if (streaming) return;
    streaming = true;
    const img = $("stream");
    img.onload = () => { $("empty").hidden = true; img.hidden = false; };
    img.onerror = () => { streaming = false; img.hidden = true; img.removeAttribute("src"); if (retry++ < 30) setTimeout(tick, 2000); };
    img.src = base + "/stream" + q + "&t=" + Date.now();
  }
  function stopStream() {
    streaming = false;
    const img = $("stream"); img.hidden = true; img.removeAttribute("src");
  }
  function renderLeft() {
    const el = $("left");
    if (!last || last.status !== "active") { el.textContent = ""; return; }
    if (!leaseEndsAt) { el.textContent = last.lease && last.lease.payWithinSeconds ? "Starts when time is bought" : ""; el.className = "left"; return; }
    const sec = (leaseEndsAt - Date.now()) / 1000;
    el.textContent = clock(sec) + " left";
    el.className = "left" + (sec < 20 ? " low" : "");
  }
  function render(s) {
    last = s;
    const chip = $("chip"), state = $("state");
    const meta = [];
    if (s.label) meta.push(s.label);
    if (s.status === "queued") {
      chip.dataset.s = "queued"; state.textContent = "In line";
      meta.push("Position " + s.position + " of " + s.queueLength);
      if (s.estimatedWaitSeconds) meta.push("about " + clock(s.estimatedWaitSeconds) + " wait");
      leaseEndsAt = 0; stopStream();
      setEmpty("Waiting for a seat", "The screen appears when this session starts.");
    } else if (s.status === "active") {
      const live = s.lease && s.lease.secondsLeft > 0;
      chip.dataset.s = live ? "active" : "waiting"; state.textContent = live ? "Live" : "Starting";
      meta.push("Seat " + s.seat);
      leaseEndsAt = live ? Date.now() + s.lease.secondsLeft * 1000 : 0;
      if (s.desktop === "ready") startStream();
      else setEmpty("Starting the desktop", "");
    } else {
      chip.dataset.s = "ended"; state.textContent = "Ended";
      leaseEndsAt = 0; stopStream();
      setEmpty("Session ended", s.message || "");
    }
    if (s.spent) {
      meta.push(usd(s.spent.total) + " spent");
      if (s.spent.minutesBought) meta.push(s.spent.minutesBought + " min");
      if (s.spent.actionCount) meta.push(s.spent.actionCount + " action" + (s.spent.actionCount === 1 ? "" : "s"));
      if (s.spent.readCount) meta.push(s.spent.readCount + " read" + (s.spent.readCount === 1 ? "" : "s"));
    }
    $("meta").textContent = meta.join(" · ");
    const page = $("page");
    page.textContent = "";
    if (s.page && s.page.url && s.page.url !== "about:blank") {
      const t = document.createElement("span"); t.textContent = s.page.title || s.page.url;
      page.append(t, document.createTextNode(s.page.title ? " · " + s.page.url : ""));
    }
    if (s.lastAction && !s.lastAction.ok) {
      const p = document.createElement("div"); p.className = "problem";
      p.textContent = s.lastAction.kind + " failed" + (s.lastAction.message ? ": " + s.lastAction.message : "");
      page.append(p);
    }
    renderLeft();
  }
  async function tick() {
    try {
      const r = await fetch(base + q, { headers: { accept: "application/json" }, cache: "no-store" });
      const s = await r.json();
      if (!r.ok) { $("chip").dataset.s = "ended"; $("state").textContent = "Unavailable"; setEmpty("Can't show this session", s.message || ""); stopStream(); return; }
      render(s);
      if (s.status !== "ended") setTimeout(tick, 1000);
    } catch { setTimeout(tick, 2000); }
  }
  setInterval(renderLeft, 500);
  tick();
})();
</script>
</body>
</html>`;
}

/** A small error page for a viewer link that doesn't work. */
export function viewerErrorPage(message: string): string {
  const esc = message.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Computer</title>
<style>html,body{margin:0;background:#101114;color:#ececee;font:13px/1.45 system-ui,sans-serif}main{max-width:640px;margin:0 auto;padding:24px 16px}p{color:#7e8189}</style></head>
<body><main><b>Can't show this session</b><p>${esc}</p></main></body></html>`;
}
