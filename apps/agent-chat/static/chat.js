// Allowance agent chat: an iMessage-style client with a Muse-style agentic layer.
// Vanilla JS, no framework, no build step, no network beyond this server (plus the dashboard's
// approval view, embedded as an iframe).
//
// SECURITY: every model / tool / site / bounty string goes through esc() before it touches HTML.
// Bounty text is attacker-controlled. Links go through safeUrl(), colors through safeColor(),
// emoji through glyph(). Never build HTML from a value that skipped those.
(function () {
  "use strict";

  var CFG = window.__CHAT__ || {};
  var LINKS = CFG.links || {};
  var ATTACKER = "0x000000000000000000000000000000000000dEaD";
  var GAP_MS = 15 * 60 * 1000;
  var EMBED_TIMEOUT_MS = 3000;
  var LS = { sel: "allowance-chat-selected", theme: "allowance-chat-theme", rail: "allowance-chat-rail", view: "allowance-chat-group-view", bcast: "allowance-chat-broadcasts" };
  var AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/; // AGENT_NAME_RE in packages/shared/src/types.ts
  var GROUP_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
  // Mirror of COLORS in apps/agent-chat/src/groups.ts (the server picks a new group's color by index).
  var GROUP_COLORS = ["#5B7CFA", "#E5527A", "#2BB3A3", "#F08A24", "#9B5BFA", "#2F9E5B", "#D9488F", "#3AA0E0"];
  var GROUP_EMOJI = ["📣", "🛠️", "🔬", "🛍️", "💼", "🚀", "🧪", "📈", "🍕", "🎯", "🧠", "⚡"];

  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ }
  }

  // ================================================================ safe values
  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) {
    // A computer-use control token (cut_…, §19.2) is never shown, wherever it turns up (URLs, raw tool output).
    return String(s == null ? "" : s).replace(/\bcut_[0-9a-fA-F]{8,}/g, "cut_…").replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }
  function str(v) {
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return "";
  }
  function safeUrl(u) {
    if (typeof u !== "string" || !u) return "";
    try {
      var x = new URL(u);
      return x.protocol === "http:" || x.protocol === "https:" ? x.href : "";
    } catch (e) {
      return "";
    }
  }
  function originOf(u) {
    try { return new URL(u).origin; } catch (e) { return ""; }
  }
  function safeColor(c, fb) {
    return typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : fb;
  }
  /** An emoji (a few code points) or a single uppercase letter. Always pass the result through esc(). */
  function glyph(s, fb) {
    s = str(s).trim();
    if (!s) return fb;
    if (/^[\x20-\x7e]+$/.test(s)) return s.charAt(0).toUpperCase();
    return Array.from(s).slice(0, 8).join("");
  }
  function validApprovalId(id) {
    return typeof id === "string" && /^apr_[A-Za-z0-9_-]{1,64}$/.test(id);
  }
  var DASH = safeUrl(LINKS.dashboard).replace(/\/+$/, "");
  var DASH_ORIGIN = originOf(DASH);

  // ================================================================ formatting
  function num(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    var n = parseFloat(str(v).replace(/[$,\s]/g, ""));
    return isFinite(n) ? n : null;
  }
  function money(v) {
    var n = num(v);
    if (n == null) return "—";
    var s = Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (n < 0 ? "−$" : "$") + s;
  }
  function shortAddr(a) {
    a = str(a);
    return a.length > 14 ? a.slice(0, 6) + "…" + a.slice(-4) : a;
  }
  function hostPath(u) {
    u = str(u).trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    return u.length > 54 ? u.slice(0, 52) + "…" : u;
  }
  function hostOnly(u) {
    var x = str(u).trim();
    try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(x) ? x : "http://" + x).host; } catch (e) { return hostPath(x); }
  }
  function firstLine(s) {
    var l = (str(s).split("\n").filter(function (x) { return x.trim(); })[0] || "").trim();
    return l.length > 150 ? l.slice(0, 148) + "…" : l;
  }
  function cap(s) {
    s = str(s);
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }
  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }
  function ts(v) {
    if (typeof v === "number") return v;
    var t = Date.parse(str(v));
    return isFinite(t) ? t : 0;
  }
  function clock(t) {
    try { return new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; }
  }
  function startOfDay(t) {
    var d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function dayDiff(t) {
    return Math.round((startOfDay(Date.now()) - startOfDay(t)) / 86400000);
  }
  function sepLabel(t) {
    var d = dayDiff(t);
    var day = d <= 0 ? "Today" : d === 1 ? "Yesterday" : d < 7 ? new Date(t).toLocaleDateString([], { weekday: "long" }) : new Date(t).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    return "<b>" + esc(day) + "</b> " + esc(clock(t));
  }
  function relTime(t) {
    if (!t) return "";
    var s = (Date.now() - t) / 1000;
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    var d = dayDiff(t);
    if (d <= 0) return clock(t);
    if (d === 1) return "Yesterday";
    if (d < 7) return new Date(t).toLocaleDateString([], { weekday: "short" });
    return new Date(t).toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" });
  }
  function dur(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    s %= 60;
    return m + "m " + (s < 10 ? "0" : "") + s + "s";
  }
  function plainPreview(s) {
    return str(s).replace(/```[\s\S]*?```/g, " ").replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "").replace(/[*`#>]+/g, "").replace(/\s+/g, " ").trim();
  }

  // Tiny, safe markdown: escape first, then code spans, bold, bullets, links, line breaks.
  function inlineMd(h) {
    h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    // *italic*, only as a whole word: "2 * 3" and "a*b" stay as typed.
    h = h.replace(/(^|[\s(])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
    h = h.replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?])/g, function (all, pre, url) {
      // The text is already escaped: end the link at an escaped quote or angle bracket.
      var cut = url.search(/&(?:quot|#39|lt|gt);/);
      var tail = "";
      if (cut >= 0) { tail = url.slice(cut); url = url.slice(0, cut); }
      if (!/^https?:\/\/[^/]/.test(url)) return all;
      return pre + '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>" + tail;
    });
    return h;
  }
  // A pipe table: header row, then a separator row like |---|:---:|.
  var TABLE_ROW = /^\s*\|.*\|\s*$/;
  var TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  function tableCells(l) {
    return l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return inlineMd(c.trim()); });
  }
  function mdTable(rows) {
    var head = tableCells(rows[0]);
    var body = rows.slice(2).map(function (r) {
      var cells = tableCells(r);
      while (cells.length < head.length) cells.push("");
      return "<tr>" + cells.slice(0, head.length).map(function (c) { return "<td>" + c + "</td>"; }).join("") + "</tr>";
    });
    return '<div class="md-table"><table><thead><tr>' + head.map(function (c) { return "<th>" + c + "</th>"; }).join("") +
      "</tr></thead><tbody>" + body.join("") + "</tbody></table></div>";
  }
  function md(s) {
    // Blank lines split paragraphs; a markdown table is a block of its own.
    var lines = esc(str(s).replace(/\r/g, "").trim()).split("\n");
    var html = "";
    var para = [];
    var flush = function () {
      if (para.length) html += "<p>" + para.join("<br>") + "</p>";
      para = [];
    };
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (TABLE_ROW.test(l) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].indexOf("|") >= 0) {
        var j = i + 2;
        while (j < lines.length && TABLE_ROW.test(lines[j])) j++;
        flush();
        html += mdTable(lines.slice(i, j));
        i = j - 1;
        continue;
      }
      if (!l.trim()) { flush(); continue; }
      var b = l.match(/^\s*[-*•]\s+(.*)$/);
      var hd = l.match(/^\s*#{1,6}\s+(.*)$/);
      para.push(b ? "•&nbsp;" + inlineMd(b[1]) : hd ? "<strong>" + inlineMd(hd[1]) + "</strong>" : inlineMd(l));
    }
    flush();
    return html;
  }

  // ================================================================ icons (inline SVG)
  // Lucide (ISC), copied verbatim so the page needs no icon package: https://lucide.dev
  var P = {
    search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
    grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    book: '<path d="M12 5v16"/><path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"/>',
    plug: '<path d="M12 22v-5"/><path d="M15 8V2"/><path d="M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z"/><path d="M9 8V2"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    card: '<rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/><path d="M6 14h2"/>',
    briefcase: '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>',
    hand: '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    upload: '<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
    send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
    wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    receipt: '<path d="M12 17V7"/><path d="M16 8h-6a2 2 0 0 0 0 4h4a2 2 0 0 1 0 4H8"/><path d="M4 3a1 1 0 0 1 1-1 1.3 1.3 0 0 1 .7.2l.933.6a1.3 1.3 0 0 0 1.4 0l.934-.6a1.3 1.3 0 0 1 1.4 0l.933.6a1.3 1.3 0 0 0 1.4 0l.933-.6a1.3 1.3 0 0 1 1.4 0l.934.6a1.3 1.3 0 0 0 1.4 0l.933-.6A1.3 1.3 0 0 1 19 2a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1 1.3 1.3 0 0 1-.7-.2l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.934.6a1.3 1.3 0 0 1-1.4 0l-.933-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-1.4 0l-.934-.6a1.3 1.3 0 0 0-1.4 0l-.933.6a1.3 1.3 0 0 1-.7.2 1 1 0 0 1-1-1z"/>',
    spark: '<path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    shieldCheck: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    shieldX: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m14.5 9.5-5 5"/><path d="m9.5 9.5 5 5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    chev: '<path d="m9 18 6-6-6-6"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
    sidebar: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    external: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    bulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
    layout: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    trophy: '<path d="M10 14.66V17a1 1 0 0 1-1 1 2 2 0 0 0-2 2v2"/><path d="M14 14.66V17a1 1 0 0 0 1 1 2 2 0 0 1 2 2v2"/><path d="M17.916 10H19.5A2.5 2.5 0 0 0 22 7.5V5a1 1 0 0 0-1-1h-3"/><path d="M4 22h16"/><path d="M6 9a6 6 0 0 0 12 0V3a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1z"/><path d="M6.084 10H4.5A2.5 2.5 0 0 1 2 7.5V5a1 1 0 0 1 1-1h3"/>',
    cube: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    trash: '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    bubble: '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>',
    warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    stop: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
    flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/>',
    megaphone: '<path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/><path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14"/><path d="M8 6v8"/>',
    compose: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
    userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
    plusCircle: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    news: '<path d="M15 18h-5"/><path d="M18 14h-8"/><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0v-9a2 2 0 0 1 2-2h2"/><rect width="8" height="4" x="10" y="6" rx="1"/>',
    chart: '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
    bag: '<path d="M16 10a4 4 0 0 1-8 0"/><path d="M3.103 6.034h17.794"/><path d="M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z"/>',
    coins: '<path d="M13.744 17.736a6 6 0 1 1-7.48-7.48"/><path d="M15 6h1v4"/><path d="m6.134 14.768.866-.5 2 3.464"/><circle cx="16" cy="8" r="6"/>',
    wave: '<path d="M2 12q2.5 2 5 0t5 0 5 0 5 0"/><path d="M2 19q2.5 2 5 0t5 0 5 0 5 0"/><path d="M2 5q2.5 2 5 0t5 0 5 0 5 0"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
    bank: '<path d="M10 18v-7"/><path d="M11.119 2.205a2 2 0 0 1 1.762 0l7.84 3.846A.5.5 0 0 1 20.5 7h-17a.5.5 0 0 1-.22-.949z"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="M3 22h18"/><path d="M6 18v-7"/>',
  };
  function icon(name, extra) {
    return '<svg class="i' + (extra ? " " + extra : "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || P.wrench) + "</svg>";
  }

  // ================================================================ Linear-style parts (docs/ui-rules.md)
  // Events are one muted line; cards are for decisions and results only, with a one-line header,
  // a few body lines, one action and "Details" for the rest. Every argument here is HTML the
  // caller already escaped (use strong() / esc() for raw strings).
  function strong(s) {
    return "<b>" + esc(s) + "</b>";
  }
  /** "Paid Acme News · tx 0x48a2…5b3b" … "$0.10": { ic, text, meta: [html], amt, amtCls, tone ("err" | "wait" | "ok"), title }. */
  function evHtml(o) {
    var meta = (o.meta || []).filter(Boolean);
    return (
      '<div class="ev' + (o.tone ? " " + o.tone : "") + '"' + (o.title ? ' title="' + esc(o.title) + '"' : "") + ">" +
      '<span class="ev-ic">' + (o.ic || "") + "</span>" +
      '<span class="ev-t">' + o.text + meta.map(function (m) { return '<span class="ev-m' + (m.indexOf('class="tx"') >= 0 ? " ev-tx" : "") + '"> · ' + m + "</span>"; }).join("") + "</span>" +
      (o.amt ? '<span class="ev-amt' + (o.amtCls ? " " + o.amtCls : "") + '">' + esc(o.amt) + "</span>" : "") +
      "</div>"
    );
  }
  /** "tx 0x48a2…5b3b ↗", linking to the explorer when the receipt has a link. */
  function txHtml(tx, url, label) {
    if (!tx) return "";
    var t = esc((label || "tx") + " " + tx);
    return url ? '<a class="tx" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + t + icon("external") + "</a>" : '<span class="tx">' + t + "</span>";
  }
  /** Compact card: { cls, tile, title, meta, right, body, more (Details content), key, open, foot }. */
  function cardHtml(o) {
    var more = !!o.more;
    return (
      '<div class="card' + (o.cls ? " " + o.cls : "") + '">' +
      '<div class="cd-h">' + (o.tile || "") + '<div class="cd-ht"><div class="cd-t">' + o.title + "</div>" + (o.meta ? '<div class="cd-m">' + o.meta + "</div>" : "") + "</div>" + (o.right || "") + "</div>" +
      (o.body ? '<div class="cd-b">' + o.body + "</div>" : "") +
      (more && o.open ? '<div class="cd-more">' + o.more + "</div>" : "") +
      (o.foot || more
        ? '<div class="cd-f"><span class="cd-fl">' + (o.foot || "") + "</span>" +
          (more ? '<button type="button" class="cd-x" data-action="more" data-key="' + esc(o.key) + '" aria-expanded="' + !!o.open + '">' + (o.open ? "Hide details" : "Details") + icon("chev") + "</button>" : "") + "</div>"
        : "") +
      "</div>"
    );
  }
  /** One body line of a card: an optional mark, the text, an optional right-aligned figure. */
  function cdLine(text, right, cls) {
    return '<div class="cd-l' + (cls ? " " + cls : "") + '"><span class="cd-lt">' + text + "</span>" + (right ? '<span class="cd-lr">' + right + "</span>" : "") + "</div>";
  }
  /** "2m ago" for event lines; "" for unknown times. */
  function ago(t) {
    if (!t) return "";
    var s = (Date.now() - t) / 1000;
    if (s < 45) return "just now";
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
    if (dayDiff(t) <= 0) return clock(t);
    return relTime(t);
  }

  // ================================================================ state
  var state = { agents: {}, order: [], groupList: [], selected: null, connected: false, loaded: false, everOpen: false, logVer: 0 };
  var ui = {
    menu: false, // the sidebar "New" menu
    sheet: null, // the open modal sheet (broadcast editor or an owner sheet from the dashboard)
    expect: null, // { name, until }: an agent the owner just created; select it when it arrives
    fresh: {}, // name -> until: newly added rows get a short highlight
    balUp: {}, // name -> until: a balance that just went up (money added, bounty earned) glows green
    rail: lsGet(LS.rail) === "1",
    narrow: false,
    overlay: false, // narrow screen, sidebar temporarily expanded over the thread
    theme: lsGet(LS.theme) === "dark" || lsGet(LS.theme) === "light" ? lsGet(LS.theme) : null,
    infoOpen: false,
    view: lsGet(LS.view) === "grid" ? "grid" : "thread",
    search: "",
    openAct: {},
    openStep: {},
    openSim: {}, // order confirmation key -> its "Simulated order" explanation is open
    openMore: {}, // card key -> its "Details" are open
    holdScroll: false,
    forceBottom: false,
    stick: true, // thread pinned to the bottom (tracked from the user's own scrolling)
    stickPausedUntil: 0,
  };
  /** Approval cards by id: { id, agent, anchor, kind, subject, phase, height, status, gotSize }. */
  var approvals = {};
  /** Service facts learned from list_services / search_services / get_service results. */
  var learned = {};
  /** Bounty titles learned from find_work results. */
  var bountyTitles = {};

  function isGroup(sel) {
    return typeof sel === "string" && sel.indexOf("group:") === 0;
  }
  /** Broadcast groups (ARCHITECTURE §14.1). Every field is cleaned here; callers still esc(). */
  function cleanGroup(g) {
    if (!g || typeof g !== "object" || typeof g.id !== "string" || !GROUP_ID_RE.test(g.id)) return null;
    return {
      id: g.id,
      name: str(g.name).trim().slice(0, 60) || prettyId(g.id),
      emoji: glyph(g.emoji, "📣"),
      color: safeColor(g.color, GROUP_COLORS[hash31(g.id) % GROUP_COLORS.length]),
      members: Array.isArray(g.members) ? g.members.filter(function (m) { return typeof m === "string"; }) : [],
      builtIn: g.builtIn === true,
    };
  }
  /** groupList is the rich list; the compat map { id: members } is the fallback for an older server. */
  function setGroups(list, map) {
    if (Array.isArray(list)) {
      state.groupList = list.map(cleanGroup).filter(Boolean);
    } else if (map && typeof map === "object") {
      state.groupList = Object.keys(map)
        .filter(function (k) { return GROUP_ID_RE.test(k) && Array.isArray(map[k]); })
        .map(function (k) { return cleanGroup({ id: k, name: k === "workers" ? "All workers" : prettyId(k), emoji: k === "workers" ? "🛠️" : "📣", color: "#5B7CFA", members: map[k], builtIn: k === "workers" }); })
        .filter(Boolean);
    }
  }
  function upsertGroup(g) {
    for (var i = 0; i < state.groupList.length; i++) {
      if (state.groupList[i].id === g.id) { state.groupList[i] = g; return; }
    }
    state.groupList.push(g);
  }
  function groupById(id) {
    for (var i = 0; i < state.groupList.length; i++) if (state.groupList[i].id === id) return state.groupList[i];
    return null;
  }
  function groupDef(sel) {
    return isGroup(sel) ? groupById(sel.slice(6)) : null;
  }
  function groupMembersOf(sel) {
    var g = typeof sel === "string" ? groupDef(sel) : sel;
    return g ? g.members.filter(function (n) { return state.agents[n]; }) : [];
  }
  function selectedNames() {
    if (isGroup(state.selected)) return groupMembersOf(state.selected);
    return state.selected && state.agents[state.selected] ? [state.selected] : [];
  }
  function validSel(s) {
    if (isGroup(s)) return groupMembersOf(s).length > 0;
    return !!(s && state.agents[s]);
  }
  /** broadcast id (grp_…) -> group id, for broadcasts sent from this browser (see clusterGroup). */
  var sentBroadcasts = (function () {
    try { var o = JSON.parse(lsGet(LS.bcast) || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch (e) { return {}; }
  })();
  function rememberBroadcast(gid, groupId) {
    if (typeof gid !== "string" || !/^grp_[A-Za-z0-9_-]{1,64}$/.test(gid) || !GROUP_ID_RE.test(groupId)) return;
    sentBroadcasts[gid] = groupId;
    var keys = Object.keys(sentBroadcasts);
    if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(function (k) { delete sentBroadcasts[k]; });
    lsSet(LS.bcast, JSON.stringify(sentBroadcasts));
    state.logVer++;
  }

  // ================================================================ avatars (mirror of packages/shared/src/avatars.ts)
  var AV_KNOWN = {
    researcher: { emoji: "🔎", color: "#2BB3A3", label: "Research" },
    shopper: { emoji: "🛍️", color: "#E5527A", label: "Shopping" },
    "claude-desktop": { emoji: "✳️", color: "#D97757", label: "Claude Desktop" },
    "naive-worker": { emoji: "🐣", color: "#E0B13A", label: "Scripted" },
  };
  var AV_WORKERS = ["#5B7CFA", "#9B5BFA", "#F08A24", "#2F9E5B", "#D9488F", "#3AA0E0"];
  var AV_WORKER_EMOJI = ["🦊", "🐙", "🦉", "🐝", "🦦", "🐢"];
  var AV_FALLBACK = ["#6E7BF2", "#E36464", "#3BA889", "#C08B2E", "#8E62D9"];
  // Unknown names get a friendly face by name hash instead of their initial (proposed for avatars.ts too).
  var AV_FRIENDLY = ["🐼", "🦁", "🐯", "🐨", "🐸", "🐧", "🦄", "🐳", "🦋", "🐞", "🦔", "🦩", "🐬", "🐻", "🦜", "🐿️"];
  function hash31(s) {
    var h = 0;
    Array.from(str(s)).forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) >>> 0; });
    return h;
  }
  function localAvatar(name) {
    name = str(name);
    if (AV_KNOWN[name]) return AV_KNOWN[name];
    var m = name.match(/^worker-(\d+)$/);
    if (m) {
      var i = (Number(m[1]) - 1 + AV_WORKERS.length) % AV_WORKERS.length;
      return { emoji: AV_WORKER_EMOJI[i], color: AV_WORKERS[i], label: "Worker" };
    }
    var h = hash31(name);
    return { emoji: AV_FRIENDLY[h % AV_FRIENDLY.length], color: AV_FALLBACK[h % AV_FALLBACK.length], label: "Agent" };
  }
  function avatarOf(name) {
    var a = state.agents[name];
    var loc = localAvatar(name);
    var av = a && a.avatar;
    if (av && typeof av === "object" && av.emoji) {
      var em = glyph(av.emoji, loc.emoji);
      // The server's fallback is the initial letter; show the friendly face instead (same color).
      if (/^[\x20-\x7e]+$/.test(em) && !AV_KNOWN[name]) em = loc.emoji;
      return { emoji: em, color: safeColor(av.color, loc.color), label: str(av.label) || loc.label };
    }
    return loc;
  }
  /** "Worker agent", "Research agent", or just "Agent" for a custom one. */
  function kindLabel(name) {
    var l = avatarOf(name).label;
    return !l || l === "Agent" ? "Agent" : l + " agent";
  }
  /** "researcher" → "R", "worker-3" → "W3", "travel-planner" → "TP". */
  function initials(name) {
    var parts = str(name).split(/[-_\s]+/).filter(Boolean);
    if (!parts.length) return "?";
    var last = parts[parts.length - 1];
    if (parts.length > 1 && /^\d+$/.test(last)) return (parts[0][0] + last.slice(0, 2)).toUpperCase();
    return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }
  function avatarHtml(name, size, badge) {
    var av = avatarOf(name);
    return (
      '<span class="av' + (size ? " s" + size : "") + '" style="--c:' + av.color + '">' + esc(initials(name)) +
      (badge ? '<span class="badge-dot ' + badge + '"></span>' : "") +
      "</span>"
    );
  }
  /** A broadcast group's face: a people glyph on the group's color (def from cleanGroup, or the sheet preview). */
  function groupAvatarHtml(def, size, badge, mark) {
    return (
      '<span class="av gav' + (size ? " s" + size : "") + '" style="--c:' + safeColor(def && def.color, "#5B7CFA") + '">' + icon("users") +
      (badge ? '<span class="badge-dot ' + badge + '"></span>' : "") +
      (mark ? '<span class="bc-mark">' + icon("megaphone") + "</span>" : "") +
      "</span>"
    );
  }
  /** Overlapping member faces (WhatsApp group header), "+N" past max. */
  function stackHtml(names, size, max) {
    var shown = names.slice(0, max);
    var more = names.length - shown.length;
    return '<span class="stack st' + size + '">' + shown.map(function (n) { return avatarHtml(n, size); }).join("") + (more > 0 ? '<span class="more">+' + more + "</span>" : "") + "</span>";
  }

  // ================================================================ services
  // Fallback catalog (ARCHITECTURE §13.1). The wallet's own data (agent.services) and what the
  // agent's tools returned (learned) take precedence.
  var CATALOG = {
    directory: { name: "Service Directory", icon: "🗂️", color: "#64748B", provider: "Allowance", path: "" },
    "acme-weather": { name: "Acme Weather", icon: "🌤️", color: "#3AA0E0", provider: "Acme APIs", path: "/api/weather", pricing: "$0.05 per call", permissions: ["Pay up to $0.05 per call to Acme Weather", "Look up weather for cities you ask about"] },
    "acme-news": { name: "Acme News", icon: "📰", color: "#5B6B7F", provider: "Acme APIs", path: "/api/news", pricing: "$0.10 per call", permissions: ["Pay up to $0.10 per call to Acme News", "Read headlines for you"] },
    "acme-stocks": { name: "Acme Stocks", icon: "📈", color: "#2F9E5B", provider: "Acme APIs", path: "/api/stock", pricing: "$0.15 per call", permissions: ["Pay up to $0.15 per call to Acme Stocks", "Look up quotes for symbols you ask about"] },
    "acme-pizza": { name: "Acme Pizza", icon: "🍕", color: "#E5523A", provider: "Acme APIs", path: "/pizza", pricing: "$18.50 per order", permissions: ["Pay up to $18.50 per order to Acme Pizza", "Place orders on your behalf"] },
    "acme-bounties": { name: "Acme Bounties", icon: "💼", color: "#9B5BFA", provider: "Acme APIs", path: "/agent-work", pricing: "Free (you earn $0.50–$0.75 per task)", permissions: ["Claim and submit Acme bounties", "Receive bounty payouts into your wallet"] },
    // §17.2: Quantcomm's research, sold per request through its bridge (under /quantcomm on any host).
    quantcomm: { name: "Quantcomm Flood Research", icon: "🌊", color: "#1D4ED8", provider: "Quantcomm", path: "/quantcomm", pricing: "$0.05 per flood check · $0.10 per analyst view", permissions: ["Pay up to $0.10 per request", "Read Quantcomm's flood and bank research"] },
  };
  var DEFAULT_SERVICES = { researcher: ["acme-weather", "acme-news", "acme-stocks"], shopper: [], "claude-desktop": ["acme-bounties", "acme-weather"] };

  function prettyId(id) {
    return str(id).replace(/^custom-/, "").split(/[-_]+/).filter(Boolean).map(cap).join(" ");
  }
  function agentSvcList(a) {
    if (!a) return null;
    // wallet events carry the freshest list (polled from /v1/me); the summary's copy is from load.
    if (a.wallet && Array.isArray(a.wallet.services)) return a.wallet.services;
    if (Array.isArray(a.services)) return a.services;
    return null;
  }
  function svcFromAgents(id) {
    for (var i = 0; i < state.order.length; i++) {
      var list = agentSvcList(state.agents[state.order[i]]) || [];
      for (var j = 0; j < list.length; j++) if (list[j] && list[j].id === id) return list[j];
    }
    return null;
  }
  function allServiceIds() {
    var ids = {};
    Object.keys(CATALOG).forEach(function (k) { ids[k] = 1; });
    Object.keys(learned).forEach(function (k) { ids[k] = 1; });
    Object.keys(shops).forEach(function (h) { ids["shopify-" + h] = 1; });
    state.order.forEach(function (n) { (agentSvcList(state.agents[n]) || []).forEach(function (s) { if (s && typeof s.id === "string") ids[s.id] = 1; }); });
    return Object.keys(ids);
  }
  /** Raw strings: callers must esc(). */
  function svcInfo(id, hint) {
    id = str(id);
    var base = CATALOG[id] || {};
    var l = learned[id] || {};
    var w = svcFromAgents(id) || {};
    var perms = Array.isArray(w.permissions) && w.permissions.length ? w.permissions.map(str) : l.permissions && l.permissions.length ? l.permissions : base.permissions || [];
    var shop = shopRef(id, w, l);
    var sk = shop ? shops[shop.handle] || {} : {};
    var pricing = str(w.pricing) || l.pricing || base.pricing || "";
    var maxPrice = str(w.maxPrice) || str(l.maxPrice).replace(/^\$/, "").replace(/,/g, "") || sk.maxPrice || capFromPricing(pricing);
    var name = str(w.name) || l.name || base.name || sk.name || str(hint) || (shop ? prettyId(shop.handle) : prettyId(id)) || "a service";
    return {
      id: id,
      name: name,
      icon: glyph(w.icon || l.icon || base.icon, "🧩"),
      color: shop ? SHOP_GREEN : safeColor(w.color, base.color || AV_FALLBACK[hash31(id) % AV_FALLBACK.length]),
      provider: str(w.provider) || l.provider || base.provider || (shop ? "Shopify store" : ""),
      permissions: perms.length || !shop ? perms.slice(0, 6) : shopPerms(name, maxPrice),
      pricing: pricing,
      maxPrice: maxPrice,
      baseUrl: str(w.baseUrl) || l.baseUrl || "",
      path: base.path || "",
      glyph: shop ? "bag" : "",
      shopify: shop,
    };
  }
  var SVC_ICON = { directory: "search", "acme-weather": "cloud", "acme-news": "news", "acme-stocks": "chart", "acme-pizza": "bag", "acme-bounties": "briefcase", quantcomm: "wave" };
  function tileHtml(info, cls) {
    var ic = info && (info.glyph || SVC_ICON[str(info.id)]);
    var face = ic ? icon(ic) : esc((str(info && info.name).replace(/^Acme\s+/, "")[0] || "?").toUpperCase());
    // Shopify stores: a white bag on solid Shopify green, like the dashboard.
    var shop = info && info.shopify ? " shop" : "";
    return '<span class="tile' + shop + (cls ? " " + cls : "") + '" style="--c:' + safeColor(info && info.color, "#6B7280") + '">' + face + "</span>";
  }
  function under(url, base) {
    var b = str(base).replace(/\/+$/, "");
    return !!b && (url === b || url.indexOf(b + "/") === 0 || url.indexOf(b + "?") === 0);
  }
  function serviceForUrl(url) {
    url = str(url).trim();
    if (!url) return null;
    // The Shopify bridge serves every store under /shops/<handle> (§15.1).
    var sb = bridgeOf(url);
    if (sb) return svcInfo("shopify-" + sb.handle);
    var full = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : "http://" + url;
    var path = "";
    try { path = new URL(full).pathname; } catch (e) { /* ignore */ }
    var best = null;
    var bestLen = -1;
    allServiceIds().forEach(function (id) {
      if (id === "directory") return;
      var info = svcInfo(id);
      if (info.baseUrl) {
        if (under(full, info.baseUrl) && info.baseUrl.length > bestLen) {
          best = info;
          bestLen = info.baseUrl.length;
        }
      } else if (info.path && path && (path === info.path || path.indexOf(info.path + "/") === 0) && info.path.length > bestLen) {
        best = info;
        bestLen = info.path.length;
      }
    });
    return best;
  }
  function words(s) {
    return str(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(function (w) { return w && !/^(order|orders|quote|api|apis|the|call|service)$/.test(w); }).map(function (w) { return w.replace(/s$/, ""); });
  }
  function serviceForParty(party) {
    var pw = words(party);
    if (!pw.length) return null;
    var found = null;
    allServiceIds().forEach(function (id) {
      if (found || id === "directory") return;
      var info = svcInfo(id);
      var sw = words(info.name);
      if (sw.length && sw.every(function (w) { return pw.indexOf(w) >= 0; })) found = info;
    });
    return found;
  }
  function mergeLearned(s) {
    if (!s || !s.id) return;
    var cur = learned[s.id] || {};
    Object.keys(s).forEach(function (k) {
      var v = s[k];
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) return;
      cur[k] = v;
    });
    learned[s.id] = cur;
  }
  function splitIcon(head) {
    var sp = head.indexOf(" ");
    if (sp > 0 && /[^\x00-\x7f]/.test(head.slice(0, sp))) return { icon: head.slice(0, sp), name: head.slice(sp + 1).trim() };
    return { icon: "", name: head };
  }
  /** "- 🍕 Acme Pizza (acme-pizza): summary · $18.50 per order · [not connected]" (apps/mcp format.ts serviceLine). */
  function parseServiceLines(r) {
    var out = [];
    str(r).split("\n").forEach(function (line) {
      var m = line.match(/^\s*[-•]\s+(.+?) \(([A-Za-z0-9._-]{1,64})\)(.*)$/);
      if (!m) return;
      var hn = splitIcon(m[1].trim());
      var rest = m[3];
      var connected = /\[connected\]\s*$/.test(rest) ? true : /\[not connected\]\s*$/.test(rest) ? false : null;
      rest = rest.replace(/\s*·\s*\[(?:not )?connected\]\s*$/, "").replace(/^:\s*/, "");
      // Shopify stores end with " · Shopify store <domain>…" (apps/mcp format.ts shopifyTag).
      var shopify = null;
      var tag = rest.match(/\s*·\s*Shopify store\b(.*)$/i);
      if (tag) {
        rest = rest.slice(0, tag.index);
        shopify = shopTag(m[2], tag[1]);
      }
      var parts = rest.split(" · ");
      var pricing = parts.length > 1 ? parts.pop().trim() : "";
      // Shopify pricing has its own " · " (§15.2): "Store prices · paid with your Allowance card · up to $100.00 per order".
      if (handleOfId(m[2]) && parts.length) {
        var sp = rest.match(/^(.*?)(?: · |^)((?:Store prices|Varies by item|Browse only|Up to \$)[\s\S]*)$/i);
        parts = sp ? [sp[1]] : [rest.split(" · ")[0]];
        pricing = sp ? sp[2].trim() : rest.split(" · ").slice(1).join(" · ").trim();
      }
      out.push({ id: m[2], name: hn.name.slice(0, 80), icon: hn.icon, summary: parts.join(" · ").trim().slice(0, 240), pricing: pricing.slice(0, 80), connected: connected, shopify: shopify });
    });
    return out;
  }
  /** get_service output: first line "🍕 Acme Pizza (acme-pizza) by Acme APIs", then fields, "Permissions:" bullets, "Docs:". */
  function parseServiceDoc(r) {
    var lines = str(r).split("\n");
    var m = (lines[0] || "").match(/^(.+?) \(([A-Za-z0-9._-]{1,64})\)(?: by (.+))?$/);
    if (!m) return null;
    var hn = splitIcon(m[1].trim());
    var s = { id: m[2], name: hn.name.slice(0, 80), icon: hn.icon, provider: str(m[3]).trim().slice(0, 80), permissions: [] };
    var inPerms = false;
    for (var i = 1; i < lines.length; i++) {
      var l = lines[i];
      if (/^Docs\b/.test(l)) break;
      var pm = l.match(/Pricing: (.+?) · Max per payment: (\$[\d.,]+)/);
      if (pm) { s.pricing = pm[1].slice(0, 80); s.maxPrice = pm[2]; }
      var bm = l.match(/^Base URL: (\S+)/);
      if (bm) s.baseUrl = bm[1];
      var sh = l.match(/^Shopify store\b(.*)$/i);
      if (sh) s.shopify = shopTag(s.id, sh[1]);
      var sm = l.match(/^Summary: (.+)/);
      if (sm) s.summary = sm[1].slice(0, 240);
      if (/^Permissions:\s*$/.test(l)) { inPerms = true; continue; }
      if (inPerms) {
        var bl = l.match(/^\s*-\s+(.+)/);
        if (bl) { s.permissions.push(bl[1].slice(0, 160)); continue; }
        inPerms = false;
      }
    }
    s.permissions = s.permissions.slice(0, 6);
    return s;
  }
  /** Shopify facts in a service listing or doc: name, domains, cap. */
  function learnShopService(s, text) {
    var h = s && handleOfId(s.id);
    if (!h) return;
    var head = str(text).split(/\nDocs\b/)[0];
    var dom = (head.match(/\b([a-z0-9][a-z0-9-]{0,62}\.myshopify\.com)\b/i) || [])[1];
    var tagged = s.shopify || {};
    learnShop(h, { name: s.name, domain: tagged.domain || dom, site: tagged.site, maxPrice: capFromPricing(s.pricing) || s.maxPrice });
  }
  function learnFromEntry(e) {
    if (!e || e.kind !== "tool" || e.result == null) return;
    var r = str(e.result);
    var c = shopCall(e);
    if (c) {
      // products: { store: { name, storefrontUrl, currency } }; carts and orders: { store } too (§15.1).
      var o = c.d.order && typeof c.d.order === "object" ? c.d.order : c.d;
      var st = o.store && typeof o.store === "object" ? o.store : { name: typeof o.store === "string" ? o.store : "" };
      learnShop(c.b.handle, { name: st.name, currency: st.currency || c.d.currency, site: st.storefrontUrl });
    }
    if (e.name === "list_services" || e.name === "search_services") {
      parseServiceLines(r).forEach(function (s) {
        mergeLearned(s);
        learnShopService(s, "");
      });
    } else if (e.name === "get_service") {
      var doc = parseServiceDoc(r);
      mergeLearned(doc);
      learnShopService(doc, r);
    } else if (e.name === "request_service" || e.name === "check_approval") {
      var said = storeInText(r);
      var rq = e.name === "request_service" ? storeRequest(e) : null;
      var sh = (said && said.handle) || (rq && rq.handle) || (r.match(/service_id: "shopify-([a-z0-9][a-z0-9-]{0,62})"/) || [])[1];
      if (sh && said) learnShop(sh, said);
      var capm = r.match(/up to \$([\d,]+(?:\.\d+)?) per order/i);
      if (sh && capm) learnShop(sh, { maxPrice: capm[1] });
      if (rq && rq.handle) learnShop(rq.handle, { name: rq.named, domain: rq.link.handle === rq.handle ? rq.link.host : "", site: rq.link.handle ? "" : rq.link.host ? "https://" + rq.link.host : "" });
    } else if (e.name === "find_work") {
      r.split("\n").forEach(function (l) {
        var m = l.match(/^\s*•\s+(\S+) — "(.{1,160}?)" — pays/);
        if (m) bountyTitles[m[1]] = m[2];
      });
    }
  }
  function agentServices(a) {
    var list = agentSvcList(a);
    var ids;
    if (list) {
      ids = list.map(function (x) { return str(x && x.id); }).filter(Boolean);
    } else {
      ids = (DEFAULT_SERVICES[a.name] || (/^worker-\d+$/.test(a.name) ? ["acme-bounties"] : [])).slice();
      (a.log || []).forEach(function (e) {
        if (e.kind !== "tool" || (e.name !== "request_service" && e.name !== "check_approval") || e.result == null) return;
        var r = str(e.result);
        if (!/^(Connected|Owner connected) |is already connected/.test(r)) return;
        var id = str(objArgs(e).service_id) || (r.match(/service_id: "([A-Za-z0-9._-]+)"/) || [])[1];
        if (id && ids.indexOf(id) < 0) ids.push(id);
      });
    }
    return ids.filter(function (id) { return id !== "directory"; }).map(function (id) { return svcInfo(id); });
  }
  function agentHasService(a, id) {
    return !!id && agentServices(a).some(function (s) { return s.id === id; });
  }

  // ================================================================ Shopify stores (ARCHITECTURE §15)
  // Any public Shopify store, from the shopper's side. A store is a service whose base URL is the
  // bridge's /shops/<handle>. Agents shop with fetch_url, so the page sees the bridge's JSON (§15.1)
  // only as tool text: "HTTP <status> <url>", a blank line, the pretty-printed body, then (when it
  // paid) a receipt line. It is parsed here and escaped at render time like every other tool string.
  // The only requests this adds are product images, from URLs the bridge returned, sent without a
  // referrer. Links go to the store's public storefront only, never to a store admin.
  var SHOP_GREEN = "#95BF47";
  var HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
  var DOMAIN_RE = /^[a-z0-9][a-z0-9.-]{1,252}$/;
  /** handle -> { name, currency, domain (x.myshopify.com), site (storefront origin), maxPrice }, learned from tool results. Raw: callers esc(). */
  var shops = {};
  function capFromPricing(p) {
    var m = str(p).match(/up to \$([\d,]+(?:\.\d+)?) per order/i);
    return m ? m[1].replace(/,/g, "") : "";
  }
  function handleOfId(id) {
    var m = str(id).match(/^shopify-([a-z0-9][a-z0-9-]{0,62})$/);
    return m ? m[1] : "";
  }
  function myshopify(host) {
    var m = str(host).toLowerCase().match(/^([a-z0-9][a-z0-9-]{0,62})\.myshopify\.com$/);
    return m ? m[1] : "";
  }
  /** Shopify itself (admin.shopify.com, shopify.com), never a store: nothing links there. */
  function isShopifyItself(host) {
    return /(^|\.)shopify\.com$/i.test(str(host));
  }
  /** "https://www.allbirds.com/products/x" → "allbirds.com": the name a shopper knows the store by. */
  function siteHost(u) {
    var h = str(u).trim() ? hostOnly(u).toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "").replace(/^www\./, "") : "";
    return DOMAIN_RE.test(h) && /\.[a-z]{2,}$/.test(h) ? h : "";
  }
  /** A storefront URL from the wallet or the bridge, as its origin ("https://www.allbirds.com"), or "". */
  function siteUrl(u) {
    var s = safeUrl(str(u).trim());
    if (!s) return "";
    try {
      var x = new URL(s);
      return isShopifyItself(x.hostname) ? "" : x.origin;
    } catch (e) {
      return "";
    }
  }
  /** A store link as an agent passes it ("allbirds.com", "https://www.allbirds.com/products/…", "x.myshopify.com") → { host, handle }. */
  function storeLink(u) {
    var host = siteHost(u);
    if (isShopifyItself(host)) host = "";
    return { host: host, handle: myshopify(host) };
  }
  /** Domains named in MCP text: x.myshopify.com is the store's own domain, anything else its storefront. */
  function domainsIn(s) {
    var out = { domain: "", handle: "", site: "" };
    (str(s).toLowerCase().match(/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/g) || []).forEach(function (d) {
      if (!/\.[a-z]{2,}$/.test(d) || isShopifyItself(d)) return;
      var h = myshopify(d);
      if (h) {
        if (!out.handle) { out.handle = h; out.domain = d; }
      } else if (!out.site) out.site = "https://" + d;
    });
    return out;
  }
  /** The " · Shopify store …" tag of a service line, or get_service's "Shopify store …" line (apps/mcp format.ts) → { handle, domain, site }. */
  function shopTag(id, tag) {
    var d = domainsIn(tag);
    return { handle: handleOfId(id) || d.handle, domain: d.domain, site: d.site };
  }
  /** "the Shopify store Allbirds (allbirds.com)" in MCP text (§15.4) → { name, handle, domain, site }. */
  function storeInText(r) {
    r = str(r);
    var m = r.match(/the Shopify store (.{1,80}?) \(([^()\n]{3,200})\)/i) || r.match(/^(.{1,80}?) \(Shopify store ([^()\n]{3,200})\) is already connected/i);
    if (!m) return null;
    var d = domainsIn(m[2]);
    if (!d.domain && !d.site) return null;
    return { name: m[1].trim(), handle: d.handle, domain: d.domain, site: d.site };
  }
  function learnShop(handle, o) {
    if (!HANDLE_RE.test(str(handle)) || !o || typeof o !== "object") return;
    var cur = shops[handle] || (shops[handle] = {});
    var name = str(o.name).trim().slice(0, 80);
    if (name) cur.name = name;
    var ccy = str(o.currency).trim();
    if (/^[A-Z]{3}$/.test(ccy)) cur.currency = ccy;
    var dom = str(o.domain).trim().toLowerCase();
    if (DOMAIN_RE.test(dom) && !isShopifyItself(dom)) cur.domain = dom;
    var site = siteUrl(o.site);
    if (site) cur.site = site;
    var capv = str(o.maxPrice).replace(/^\$/, "").replace(/,/g, "");
    if (num(capv) != null) cur.maxPrice = capv;
  }
  /**
   * { handle, domain, site, host } when this service is a Shopify store (wallet data, learned, or its
   * id), else null. `site` is the storefront to link to, `host` its domain as the shopper knows it.
   */
  function shopRef(id, w, l) {
    var ref = (w && w.shopify) || (l && l.shopify);
    ref = ref && typeof ref === "object" ? ref : null;
    var h = ref && HANDLE_RE.test(str(ref.handle)) ? str(ref.handle) : handleOfId(id);
    if (!h) return null;
    var k = shops[h] || {};
    var dom = ref ? str(ref.domain).toLowerCase() : "";
    var domain = (DOMAIN_RE.test(dom) && !isShopifyItself(dom) ? dom : "") || k.domain || h + ".myshopify.com";
    var site = siteUrl(ref && (ref.storefrontUrl || ref.site)) || k.site || siteUrl("https://" + domain);
    return { handle: h, domain: domain, site: site, host: siteHost(site) || domain };
  }
  function shopName(handle, st) {
    var n = st && typeof st === "object" ? str(st.name) : str(st);
    return n.trim().slice(0, 80) || svcInfo("shopify-" + handle).name;
  }

  var BRIDGE_PATHS = [
    [/^\/shops\/([a-z0-9][a-z0-9-]{0,62})\/products\/?$/, "products"],
    [/^\/shops\/([a-z0-9][a-z0-9-]{0,62})\/products\/([^/]+)\/?$/, "product"],
    [/^\/shops\/([a-z0-9][a-z0-9-]{0,62})\/carts\/?$/, "carts"],
    [/^\/shops\/([a-z0-9][a-z0-9-]{0,62})\/carts\/([^/]+)\/checkout\/?$/, "checkout"],
    [/^\/shops\/([a-z0-9][a-z0-9-]{0,62})\/?$/, "store"],
  ];
  /** A Shopify bridge URL (§15.1) → { handle, op, item, q }, else null. */
  function bridgeOf(u) {
    var full = str(u).trim();
    if (!full) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(full)) full = "http://" + full;
    var x;
    try { x = new URL(full); } catch (e) { return null; }
    for (var i = 0; i < BRIDGE_PATHS.length; i++) {
      var m = x.pathname.match(BRIDGE_PATHS[i][0]);
      if (!m) continue;
      var item = m[2] || "";
      try { item = decodeURIComponent(item); } catch (e) { /* keep it raw */ }
      return { handle: m[1], op: BRIDGE_PATHS[i][1], item: item.slice(0, 120), q: str(x.searchParams.get("q")).trim().slice(0, 60) };
    }
    return null;
  }

  // ---------------------------------------------------------------- the response body
  /** End (exclusive) of the JSON object/array that starts at t[i], string-aware; -1 if it is cut off. */
  function jsonEnd(t, i) {
    var depth = 0;
    var inStr = false;
    var bs = false;
    for (var k = i; k < t.length; k++) {
      var c = t.charCodeAt(k);
      if (inStr) {
        if (bs) bs = false;
        else if (c === 92) bs = true;
        else if (c === 34) inStr = false;
        continue;
      }
      if (c === 34) inStr = true;
      else if (c === 123 || c === 91) depth++;
      else if ((c === 125 || c === 93) && --depth === 0) return k + 1;
    }
    return -1;
  }
  function tryJson(s) {
    try { return JSON.parse(s); } catch (e) { return undefined; }
  }
  /** fetch_url cuts bodies at 20,000 characters: keep the store and every product that arrived whole. */
  function salvageProducts(t) {
    var out = { truncated: true, products: [] };
    var sm = t.match(/"store":\s*\{/);
    if (sm) {
      var si = sm.index + sm[0].length - 1;
      var se = jsonEnd(t, si);
      if (se > 0) out.store = tryJson(t.slice(si, se));
    }
    var pm = t.match(/"products":\s*\[/);
    if (!pm) return out;
    var k = pm.index + pm[0].length;
    for (var guard = 0; guard < 100; guard++) {
      while (k < t.length && /[\s,]/.test(t.charAt(k))) k++;
      if (t.charAt(k) !== "{") break;
      var end = jsonEnd(t, k);
      if (end < 0) break;
      var p = tryJson(t.slice(k, end));
      if (p) out.products.push(p);
      k = end;
    }
    return out;
  }
  var httpMemo = new Map();
  /** "HTTP 200 <url>\n\n<json>…" (fetch_url, and check_approval resuming one) → { status, url, data, tail }, else null. */
  function parseHttp(r) {
    r = str(r);
    if (r.slice(0, 5) !== "HTTP ") return null;
    if (httpMemo.has(r)) return httpMemo.get(r);
    var out = null;
    // The URL is printed as the agent wrote it, so it may hold spaces ("?q=wool runners").
    var m = r.match(/^HTTP (\d{3}) ([^\n]+?)\n\n/);
    if (m) {
      var body = r.slice(m[0].length);
      var i = body.search(/\S/);
      var data = null;
      var tail = "";
      if (i >= 0 && body.charAt(i) === "{") {
        var end = jsonEnd(body, i);
        if (end > 0) {
          data = tryJson(body.slice(i, end));
          tail = body.slice(end);
        } else data = salvageProducts(body);
      }
      out = { status: Number(m[1]), url: m[2], data: data && typeof data === "object" && !Array.isArray(data) ? data : null, tail: tail };
    }
    if (httpMemo.size > 300) httpMemo.clear();
    httpMemo.set(r, out);
    return out;
  }
  /** A bridge response in this tool entry: { h (parseHttp), b (bridgeOf), d (body or {}) }, else null. */
  function shopCall(e) {
    if (!e || e.result == null || (e.name !== "fetch_url" && e.name !== "check_approval")) return null;
    var h = parseHttp(e.result);
    if (!h) return null;
    var b = bridgeOf(h.url);
    return b ? { h: h, b: b, d: h.data || {} } : null;
  }

  // ---------------------------------------------------------------- normalized shapes
  function imgUrlOf(v) {
    return typeof v === "string" ? v : v && typeof v === "object" ? str(v.url || v.src) : "";
  }
  /** A storefront page (a product, the store) to link to: http(s), and never Shopify itself (no admin links). */
  function pageUrl(u) {
    var s = safeUrl(str(u).trim());
    if (!s) return "";
    try { return isShopifyItself(new URL(s).hostname) ? "" : s; } catch (e) { return ""; }
  }
  function cleanProduct(p) {
    if (!p || typeof p !== "object") return null;
    var title = str(p.title).trim().slice(0, 140);
    if (!title) return null;
    var vars = (Array.isArray(p.variants) ? p.variants : []).filter(function (v) { return v && typeof v === "object"; }).slice(0, 50).map(function (v) {
      var t = str(v.title).trim().slice(0, 60);
      return { title: t === "Default Title" ? "" : t, price: num(v.price), available: v.available !== false };
    });
    var prices = vars.map(function (v) { return v.price; }).filter(function (x) { return x != null; });
    var min = num(p.priceMin);
    var max = num(p.priceMax);
    if (min == null && prices.length) min = Math.min.apply(null, prices);
    if (max == null && prices.length) max = Math.max.apply(null, prices);
    return {
      title: title,
      handle: str(p.handle),
      description: str(p.description).replace(/\s+/g, " ").trim().slice(0, 300),
      image: imgUrlOf(p.image),
      url: pageUrl(p.url),
      min: min,
      max: max,
      available: p.available !== false && (!vars.length || vars.some(function (v) { return v.available; })),
      variants: vars,
    };
  }
  /** A cart line (§15.1) or an order item (same fields, tolerant of a few spellings). */
  function cleanLine(x) {
    if (!x || typeof x !== "object") return null;
    var title = str(x.title || x.name || x.productTitle).trim().slice(0, 140);
    if (!title) return null;
    var vt = str(x.variantTitle || x.variant).trim().slice(0, 60);
    var q = Math.max(1, Math.min(999, Math.round(num(x.quantity) || 1)));
    var unit = num(x.unitPrice != null ? x.unitPrice : x.price);
    var total = num(x.lineTotal != null ? x.lineTotal : x.total);
    if (total == null && unit != null) total = unit * q;
    return { title: title, variant: vt === "Default Title" ? "" : vt, qty: q, total: total, image: imgUrlOf(x.image) || str(x.imageUrl), url: pageUrl(x.url), variantId: str(x.variantId) };
  }
  function linesOf(arr) {
    return (Array.isArray(arr) ? arr : []).map(cleanLine).filter(Boolean);
  }
  function priceLabel(min, max) {
    if (min == null && max == null) return "";
    if (min == null || max == null || Math.abs(max - min) < 0.005) return money(min != null ? min : max);
    return money(min) + " – " + money(max);
  }
  /** Shopify's CDN resizes on request: ask for about the size we draw. Other hosts are left alone. */
  function shopImg(u, w) {
    u = safeUrl(str(u));
    if (!u) return "";
    try {
      var x = new URL(u);
      if (/(^|\.)cdn\.shopify\.com$/i.test(x.hostname) || /^\/cdn\/shop\//.test(x.pathname)) {
        x.searchParams.set("width", String(w));
        return x.href;
      }
    } catch (e) { /* use as is */ }
    return u;
  }
  /**
   * A fixed-size image box. While the image loads it shows a quiet bag icon; with no image (some
   * stores have none) or a failed one (see the error listener) it is a soft Shopify-green tile with
   * the product's initial.
   */
  function imgBox(u, w, cls, label) {
    var src = shopImg(u, w);
    var ch = (Array.from(str(label).replace(/^[^\p{L}\p{N}]+/u, ""))[0] || "").toUpperCase();
    return (
      '<span class="pimg' + (cls ? " " + cls : "") + (src ? "" : " noimg") + (ch ? " has-ch" : "") + '">' + icon("bag") +
      (ch ? '<span class="pi-ch" aria-hidden="true">' + esc(ch) + "</span>" : "") +
      (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : "") + "</span>"
    );
  }
  document.addEventListener("error", function (ev) {
    var t = ev.target;
    if (t && t.tagName === "IMG" && t.parentNode && t.parentNode.classList && t.parentNode.classList.contains("pimg")) t.parentNode.classList.add("broken");
  }, true);
  /** §15.2 permissions, for a store the wallet hasn't described yet. */
  function shopPerms(store, capv) {
    return [
      "Browse " + store + "'s catalog",
      num(capv) ? "Pay up to " + money(capv) + " per order with a single-use Allowance card" : "Pay for orders with a single-use Allowance card, within its limits",
      "Place orders on your behalf",
    ];
  }
  /** The cart this checkout paid for, from earlier in the log (its lines carry images and links). */
  function cartFromLog(a, handle, cartId) {
    var log = (a && a.log) || [];
    for (var i = log.length - 1; i >= 0; i--) {
      var c = shopCall(log[i]);
      if (c && c.b.handle === handle && c.b.op === "carts" && str(c.d.cartId) === cartId) return c.d;
    }
    return null;
  }

  /** "$42.00" while a Shopify checkout waits for approval: the total of the cart it pays for. */
  function checkoutTotal(a, url) {
    var b = bridgeOf(url);
    var cart = b && b.op === "checkout" ? cartFromLog(a, b.handle, b.item) : null;
    return cart && num(cart.total) != null ? money(cart.total) : "";
  }

  // ---------------------------------------------------------------- the order confirmation (§15.1 checkout)
  /** The confirmation in a checkout answer: the 200 body, or what a 409 cart_already_paid returns with. */
  function confirmationOf(d) {
    if (!d || typeof d !== "object") return {};
    if (d.order && typeof d.order === "object") return d.order;
    if (d.confirmation && typeof d.confirmation === "object") return d.confirmation;
    return d;
  }
  /** "ALW-7K2P-9QXD": Allowance's reference for the order (not a Shopify order number). */
  function orderRef(o) {
    var r = str(o && o.reference).trim();
    return /^[A-Za-z0-9][A-Za-z0-9-]{3,39}$/.test(r) ? r : "";
  }
  function isPlaced(o) {
    return str(o.status) === "placed" || !!orderRef(o);
  }
  /** "Allowance Card ••1234" */
  function cardLabel(o) {
    var c = o && o.card && typeof o.card === "object" ? o.card : {};
    var brand = str(c.brand).replace(/\s+/g, " ").trim().slice(0, 40) || "Allowance Card";
    var last4 = str(c.last4).replace(/\D/g, "").slice(-4);
    return brand + (last4.length === 4 ? " ••" + last4 : "");
  }
  var SIM_WHY = "Your agent's USDC payment is real. The single-use Allowance Card that would pay the store through Shopify's agent checkout isn't issued in this demo, so the store didn't receive an order.";

  // ---------------------------------------------------------------- cards
  /** Up to `max` lines, one row each: image, name · variant × qty, amount. */
  function linesHtml(lines, max) {
    var shown = lines.slice(0, max || 3);
    return (
      '<ul class="lines">' +
      shown.map(function (l) {
        var img = imgBox(l.image, 96, "sm", l.title);
        var name = '<span class="l-name">' + esc(l.title) + "</span>";
        var sub = [l.variant, l.qty > 1 ? "× " + l.qty : ""].filter(Boolean).join(" · ");
        return (
          "<li>" + (l.url ? '<a class="l-img" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true">' + img + "</a>" : img) +
          '<span class="l-t">' + (l.url ? '<a class="l-link" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + name + "</a>" : name) +
          (sub ? '<span class="l-sub"> · ' + esc(sub) + "</span>" : "") + "</span>" +
          '<span class="l-amt">' + esc(l.total != null ? money(l.total) : "") + "</span></li>"
        );
      }).join("") +
      (lines.length > shown.length ? '<li class="l-more">+' + esc(plural(lines.length - shown.length, "more item", "more items")) + "</li>" : "") +
      "</ul>"
    );
  }
  /** "weareallbirds.myshopify.com" that wraps only before "myshopify.com", never at its hyphens. */
  function domainHtml(d) {
    var parts = str(d).split(".");
    if (parts.length < 3) return '<span class="nw">' + esc(d) + "</span>";
    return '<span class="nw">' + esc(parts.slice(0, -2).join(".") + ".") + '</span><wbr><span class="nw">' + esc(parts.slice(-2).join(".")) + "</span>";
  }
  /** The store's storefront domain ("allbirds.com"), linking to its storefront. */
  function siteHtml(ref) {
    if (!ref) return "";
    var href = pageUrl(ref.site);
    var label = domainHtml(ref.host || ref.domain);
    return href ? '<a class="site" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + label + "</a>" : label;
  }
  /** "Allbirds · allbirds.com" (the domain only when it says something the name doesn't). */
  function storeMeta(store, ref) {
    var site = ref && ref.host && ref.host.toLowerCase() !== str(store).toLowerCase() ? siteHtml(ref) : "";
    return esc(store) + (site ? " · " + site : "");
  }
  function productTile(p) {
    var inner =
      imgBox(p.image, 320, "", p.title) + (p.available ? "" : '<span class="p-flag">Sold out</span>') +
      '<span class="p-title">' + esc(p.title) + "</span>" +
      '<span class="p-price">' + esc(priceLabel(p.min, p.max)) + "</span>";
    return p.url
      ? '<a class="prod" href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(p.title) + '">' + inner + "</a>"
      : '<div class="prod" title="' + esc(p.title) + '">' + inner + "</div>";
  }
  function productsCard(c) {
    var info = svcInfo("shopify-" + c.b.handle);
    var list = (Array.isArray(c.d.products) ? c.d.products : []).map(cleanProduct).filter(Boolean);
    var store = shopName(c.b.handle, c.d.store);
    var q = c.b.q;
    if (!list.length) return null;
    var n = list.length + (c.d.truncated ? "+" : "");
    var one = list.length === 1 && !c.d.truncated;
    var title = q ? n + (one ? " result" : " results") + " for “" + q + "”" : n + (one ? " product" : " products");
    var shown = list.slice(0, 6);
    return cardHtml({
      cls: "wide shop-prods",
      tile: tileHtml(info, "t20"),
      title: esc(title),
      meta: storeMeta(store, info.shopify),
      body:
        '<div class="prods">' + shown.map(productTile).join("") +
        (list.length > shown.length ? '<div class="prod more"><span class="pimg">+' + (list.length - shown.length) + '</span><span class="p-title">more at ' + esc(store) + "</span></div>" : "") +
        "</div>",
    });
  }
  function productCard(c, key) {
    var p = cleanProduct(c.d.product);
    if (!p) return "";
    var info = svcInfo("shopify-" + c.b.handle);
    var store = shopName(c.b.handle, c.d.store);
    var named = p.variants.filter(function (v) { return v.title; });
    var mixed = named.some(function (v) { return v.price != null && p.min != null && Math.abs(v.price - p.min) > 0.005; });
    var chips = named.slice(0, 24).map(function (v) {
      return '<span class="vchip' + (v.available ? "" : " out") + '" title="' + esc(v.available ? v.title : v.title + " · sold out") + '">' + esc(v.title + (mixed && v.price != null ? " · " + money(v.price) : "")) + "</span>";
    }).join("");
    var where = siteHost(p.url) || (info.shopify || {}).host || store;
    var img = imgBox(p.image, 160, "md", p.title);
    var meta = [esc(store), esc(priceLabel(p.min, p.max)), named.length > 1 ? esc(plural(named.length, "option", "options")) : "", p.available ? "" : '<span class="neg">Sold out</span>'].filter(Boolean).join(" · ");
    return cardHtml({
      cls: "shop-prod",
      tile: p.url ? '<a class="pd-img" href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true">' + img + "</a>" : img,
      title: esc(p.title),
      meta: meta,
      body: p.description ? '<p class="cd-p clamp2">' + esc(p.description) + "</p>" : "",
      more: chips ? '<div class="vchips">' + chips + (named.length > 24 ? '<span class="vchip more">+' + (named.length - 24) + "</span>" : "") + "</div>" : "",
      key: key,
      open: !!ui.openMore[key],
      foot: p.url ? '<a class="cd-a" href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer">View on ' + esc(where) + icon("external") + "</a>" : "",
    });
  }
  function cartCard(c, e) {
    var info = svcInfo("shopify-" + c.b.handle);
    var store = shopName(c.b.handle, c.d.store);
    var lines = linesOf(c.d.lines);
    var items = lines.reduce(function (s, l) { return s + l.qty; }, 0);
    var sub = num(c.d.subtotal);
    var tot = num(c.d.total);
    var ship = num(c.d.shipping);
    var tax = num(c.d.tax != null ? c.d.tax : c.d.totalTax);
    // Shopify's own figures, once: the total in the header; the parts only when they differ from it.
    var parts = [
      sub != null && tot != null && Math.abs(sub - tot) > 0.005 ? "Subtotal " + money(sub) : "",
      ship != null && ship > 0 ? "Shipping " + money(ship) : "",
      tax != null && tax > 0 ? "Taxes " + money(tax) : "",
    ].filter(Boolean);
    var notes = (Array.isArray(c.d.notes) ? c.d.notes : []).map(function (n) { return str(n).replace(/\s+/g, " ").trim().slice(0, 160); }).filter(Boolean).slice(0, 1);
    var exp = ts(c.d.expiresAt);
    return cardHtml({
      cls: "cart",
      tile: tileHtml(info, "t20"),
      title: "Cart" + (tot != null ? " · " + esc(money(tot)) : ""),
      meta: [esc(store), esc(plural(items, "item", "items")), e.name === "check_approval" ? "" : esc(exp ? "held until " + clock(exp) : "held for 30 minutes")].filter(Boolean).join(" · "),
      body: linesHtml(lines) + (parts.length || notes.length ? '<p class="cd-note">' + esc(parts.concat(notes).join(" · ")) + "</p>" : ""),
    });
  }
  /**
   * The order confirmation (§15.5): store and storefront, items linking to their product pages, the
   * total, the single-use card that paid, Allowance's reference, and a "Simulated order" badge whose
   * explanation opens in place. The USDC payment (footer tx) is real; the card step is not.
   */
  function shopOrderCard(a, e, c, rc) {
    var d = confirmationOf(c.d);
    var info = svcInfo("shopify-" + c.b.handle);
    var st = d.store && typeof d.store === "object" ? d.store : null;
    var ref = info.shopify;
    var site = siteUrl(st && st.storefrontUrl);
    if (site && ref) ref = { handle: ref.handle, domain: ref.domain, site: site, host: siteHost(site) || ref.host };
    var store = shopName(c.b.handle, d.store);
    var lines = linesOf(d.items);
    var cart = cartFromLog(a, c.b.handle, c.b.item);
    var cartLines = cart ? linesOf(cart.lines) : [];
    if (!lines.length) lines = cartLines;
    else if (cartLines.length) {
      // Order items may come without images, links or prices: borrow them from the cart they were bought from.
      lines.forEach(function (l, i) {
        var m = cartLines.filter(function (x) { return (l.variantId && x.variantId === l.variantId) || x.title === l.title; })[0] || cartLines[i];
        if (!m) return;
        if (!l.image) l.image = m.image;
        if (!l.url) l.url = m.url;
        if (l.total == null) l.total = m.total;
        if (!l.variant) l.variant = m.variant;
      });
    }
    var total = num(d.total) != null ? money(d.total) : rc && rc.amount ? rc.amount : "";
    var reference = orderRef(d);
    var simulated = d.simulated !== false;
    var key = a.name + ":" + e.id;
    var open = !!ui.openSim[key];
    var why = str(d.explanation).replace(/\s+/g, " ").trim().slice(0, 400) || SIM_WHY;
    // The USDC settlement: the receipt line fetch_url added, else the confirmation's own (once settled).
    var txv = rc && rc.tx ? rc.tx : /^0x[0-9a-fA-F]{8,}$/.test(str(d.txHash)) ? shortAddr(str(d.txHash)) : "";
    var txu = rc && rc.tx ? rc.url : safeUrl(str(d.explorerUrl));
    var at = ts(d.paidAt) || ts(e.at) + (e.ms || 0);
    var badge = simulated
      ? '<button type="button" class="chip-s sim-pill" data-action="sim" data-key="' + esc(key) + '" aria-expanded="' + open + '" title="' + esc(why) + '">' + icon("info") + "Simulated order</button>"
      : "";
    return cardHtml({
      cls: "shop-order" + (simulated ? " simulated" : ""),
      tile: tileHtml(info, "t20"),
      title: "Order placed" + (total ? " · " + esc(total) : ""),
      right: badge,
      meta: storeMeta(store, ref),
      body:
        (simulated && open ? '<p class="sim-why">' + esc(why) + "</p>" : "") +
        (lines.length ? linesHtml(lines) : "") +
        '<p class="cd-note paid">' + icon("card") + "<span>" + esc(cardLabel(d)) + (reference ? ' · <span class="mono">' + esc(reference) + "</span>" : "") + "</span></p>",
      foot: [txv ? txHtml(txv, txu, "USDC tx") : "Paid in USDC", esc(at ? clock(at) : "")].filter(Boolean).join(" · "),
    });
  }
  /**
   * Items for one bridge response, or null when this entry isn't one (blocked payments etc. stay
   * generic). Results are cards; "nothing matched" and "already paid" are event lines.
   */
  /** A later bridge answer in the same turn that passes `test`, if any. */
  function laterShop(t, e, test) {
    if (!t) return null;
    for (var j = t.entries.indexOf(e) + 1; j > 0 && j < t.entries.length; j++) {
      var x = shopCall(t.entries[j]);
      if (x && test(x)) return x;
    }
    return null;
  }
  function placedCall(x) {
    return x.b.op === "checkout" && x.h.status >= 200 && x.h.status < 300 && isPlaced(confirmationOf(x.d));
  }
  /**
   * One card per result: within a turn, a later card supersedes the ones it repeats. An order hides
   * the cart it paid, the product it bought and the search that found it; a cart hides the product
   * it holds.
   */
  function shopSuperseded(t, e, c) {
    var h = c.b.handle;
    if (c.b.op === "products") return !!laterShop(t, e, function (x) { return x.b.handle === h && placedCall(x); });
    if (c.b.op === "carts") return !!laterShop(t, e, function (x) { return x.b.handle === h && placedCall(x) && x.b.item === str(c.d.cartId); });
    if (c.b.op === "product") {
      var p = cleanProduct(c.d.product);
      if (!p) return false;
      return !!laterShop(t, e, function (x) {
        if (x.b.handle !== h) return false;
        var lines = x.b.op === "carts" ? linesOf(x.d.lines) : placedCall(x) ? linesOf(confirmationOf(x.d).items) : [];
        return lines.some(function (l) { return l.title === p.title; });
      });
    }
    return false;
  }
  function shopCards(a, e, key, t) {
    var c = shopCall(e);
    if (!c) return null;
    var ok = c.h.status >= 200 && c.h.status < 300;
    var out = [];
    if (ok && shopSuperseded(t, e, c)) return out;
    if (c.b.op === "products" && ok) {
      var pc = productsCard(c);
      if (pc) out.push({ zone: "card", key: key("shop"), html: pc });
      else {
        var store = shopName(c.b.handle, c.d.store);
        out.push({ zone: "event", key: key("shop0"), html: evHtml({ ic: icon("bag"), text: esc(c.b.q ? "Nothing matches “" + c.b.q + "” at " : "No products at ") + strong(store) }) });
      }
    } else if (c.b.op === "product" && ok) {
      var one = productCard(c, key("prod"));
      if (one) out.push({ zone: "card", key: key("shop"), html: one });
    } else if (c.b.op === "carts" && ok && c.d.cartId) out.push({ zone: "card", key: key("shop"), html: cartCard(c, e) });
    else if (c.b.op === "checkout") {
      var o = confirmationOf(c.d);
      if (ok && isPlaced(o)) out.push({ zone: "card", key: key("shop"), html: shopOrderCard(a, e, c, parseReceipt(c.h.tail)) });
      else if (str(c.d.error) === "cart_already_paid") {
        out.push({ zone: "event", key: key("paid"), html: evHtml({ ic: icon("check"), text: "This cart was already paid", meta: [orderRef(o) ? 'order <span class="mono">' + esc(orderRef(o)) + "</span>" : ""] }) });
      }
    }
    return out;
  }
  // ================================================================ Quantcomm research (ARCHITECTURE §17)
  // Quantcomm sells flood research per request through its bridge ({QUANTCOMM_BRIDGE_URL}/quantcomm).
  // Agents buy it with fetch_url, so, as with Shopify, the page sees the bridge's compact JSON (§17.1)
  // only as tool text, parsed here and escaped at render time. The research is Quantcomm's and is
  // labelled as Quantcomm's: never advice from Allowance. Its SYNTHETIC and sandbox labels stay visible.
  var QC_ID = "quantcomm";
  var QC_DISCLAIMER = "Quantcomm's AI analyst view, for research. Not financial advice.";
  var QC_PATHS = [
    [/^\/quantcomm\/alerts\/?$/, "alerts"],
    [/^\/quantcomm\/companies\/([A-Za-z][A-Za-z0-9.-]{0,9})\/flood\/?$/, "flood"],
    [/^\/quantcomm\/companies\/([A-Za-z][A-Za-z0-9.-]{0,9})\/view\/?$/, "view"],
    [/^\/quantcomm\/?$/, "universe"],
  ];
  /** A Quantcomm bridge URL (§17.1) → { op, ticker }, else null. Any host: the path says what it is. */
  function qcOf(u) {
    var full = str(u).trim();
    if (!full) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(full)) full = "http://" + full;
    var x;
    try { x = new URL(full); } catch (e) { return null; }
    for (var i = 0; i < QC_PATHS.length; i++) {
      var m = x.pathname.match(QC_PATHS[i][0]);
      if (m) return { op: QC_PATHS[i][1], ticker: str(m[1]).toUpperCase() };
    }
    return null;
  }
  /** A bridge answer in this tool entry: { h (parseHttp), q (qcOf), d (body or {}) }, else null. */
  function qcCall(e) {
    if (!e || e.result == null || (e.name !== "fetch_url" && e.name !== "check_approval")) return null;
    var h = parseHttp(e.result);
    if (!h) return null;
    var q = qcOf(h.url);
    return q ? { h: h, q: q, d: h.data || {} } : null;
  }
  function qcObj(v) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  }
  function qcArr(v, max) {
    return (Array.isArray(v) ? v : []).slice(0, max || 20);
  }
  /** "OLD TOWN ALEXANDRIA" → "Old Town Alexandria"; mixed case is left alone. */
  function qcTitle(s) {
    s = str(s).replace(/\s+/g, " ").trim().slice(0, 80);
    return s && s === s.toUpperCase() && /[A-Z]{3}/.test(s) ? s.toLowerCase().replace(/(^|[\s/(-])([a-z])/g, function (all, p, c) { return p + c.toUpperCase(); }) : s;
  }
  /** FDIC's legal names, as people say them: "Bank of America, National Association" → "Bank of America". */
  function qcBank(s) {
    return str(s).replace(/,?\s+(National Association|N\.\s?A\.?)$/i, "").replace(/\s+/g, " ").trim().slice(0, 60);
  }
  /** A percent as Quantcomm sends it: "59.9%" stays; -0.2728 → "−0.27%". */
  function qcPct(v, signed) {
    if (typeof v === "string" && /%$/.test(v.trim())) return v.trim().replace(/^-/, "−");
    var n = num(v);
    if (n == null) return "";
    return (n < 0 ? "−" : signed && n > 0 ? "+" : "") + Math.abs(n).toFixed(2).replace(/\.?0+$/, "") + "%";
  }
  /** Dollars: "$11.27B" as the bridge rounds them, or a number made compact the same way. */
  function qcUsd(v) {
    if (typeof v === "string" && /^\$/.test(v.trim())) return v.trim().slice(0, 16);
    var n = num(v);
    if (n == null) return "";
    var a = Math.abs(n);
    var s = a >= 1e9 ? (a / 1e9).toFixed(2) + "B" : a >= 1e6 ? (a / 1e6).toFixed(1) + "M" : a >= 1e4 ? Math.round(a / 1e3) + "K" : a.toFixed(0);
    return (n < 0 ? "−$" : "$") + s;
  }
  /** "2026-10-16" → "Oct 16"; an instant → "Oct 17, 4:35 PM" (your time). */
  function qcWhen(v) {
    var s = str(v).trim();
    var d = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    try {
      if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).toLocaleDateString([], { month: "short", day: "numeric" });
      var t = Date.parse(s);
      return isFinite(t) ? new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    } catch (e) {
      return "";
    }
  }
  var QC_STORM = { HU: "Hurricane", MH: "Major hurricane", TS: "Tropical storm", TD: "Tropical depression", STS: "Subtropical storm", STD: "Subtropical depression", PTC: "Potential tropical cyclone", PC: "Post-tropical cyclone" };
  function qcStorms(list) {
    return qcArr(list, 4).map(function (s) {
      s = qcObj(s) || {};
      var kind = QC_STORM[str(s.classification).toUpperCase()] || "";
      var basin = str(s.basin).replace(/_/g, " ").replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
      var wind = num(s.windKt);
      return [((kind ? kind + " " : "") + str(s.name).slice(0, 30)).trim(), basin, wind != null ? Math.round(wind) + " kt" : ""].filter(Boolean).join(" · ");
    }).filter(Boolean);
  }
  // The compact card shows the key facts (header, 2–4 lines, the paid line); the sections below
  // are its "Details": every alert type, every bank, each location, each research panel.
  function qcSec(title, aside, body, cls) {
    return '<div class="qc-sec' + (cls ? " " + cls : "") + '"><div class="qc-h"><span>' + esc(title) + "</span>" + (aside || "") + "</div>" + body + "</div>";
  }
  function qcTag(text, cls) {
    return '<span class="qc-tag' + (cls ? " " + cls : "") + '">' + esc(text) + "</span>";
  }
  /** Alert counts by type, and the storms in play. */
  function qcAlertsHtml(b) {
    var al = qcObj(b.alerts) || {};
    var by = qcObj(al.byType) || {};
    var types = Object.keys(by).map(function (k) { return [str(k).slice(0, 60), num(by[k])]; }).filter(function (x) { return x[0] && x[1] != null; }).sort(function (x, y) { return y[1] - x[1]; }).slice(0, 10);
    var total = num(al.total);
    if (total == null && types.length) total = types.reduce(function (t, x) { return t + x[1]; }, 0);
    if (total == null) return "";
    var storms = qcStorms(b.activeStorms);
    return qcSec(
      "Live flood alerts",
      '<span class="qc-n">' + esc(String(total)) + "</span>",
      (types.length ? '<ul class="qc-list">' + types.map(function (x) { return '<li><span>' + esc(x[0]) + '</span><span class="qc-n">' + esc(String(x[1])) + "</span></li>"; }).join("") + "</ul>" : total === 0 ? '<p class="qc-line">No flood alerts right now.</p>' : "") +
        (storms.length ? '<p class="qc-line">' + esc("Active storms: " + storms.join("; ")) + "</p>" : ""),
    );
  }
  /** One bank under alerts: name, ticker, share of its deposits (with a thin bar), branches and dollars. */
  function qcBankRow(r, mine, compact) {
    r = qcObj(r);
    if (!r || !str(r.bank).trim()) return "";
    var share = r.shareOfDeposits == null ? null : num(r.shareOfDeposits);
    var w = share == null ? 0 : Math.max(0, Math.min(100, share));
    var branches = num(r.branches);
    var sub = [branches != null ? plural(Math.round(branches), "branch", "branches") : "", qcUsd(r.depositsUnderAlert) ? qcUsd(r.depositsUnderAlert) : ""].filter(Boolean).join(" · ");
    var tk = str(r.ticker).replace(/[^A-Za-z0-9.-]/g, "").slice(0, 8);
    return (
      '<li class="qc-bankrow' + (mine ? " mine" : "") + '"><div class="qc-bank-top"><span class="qc-bank">' + esc(qcBank(r.bank)) + "</span>" +
      (tk ? '<span class="qc-tk">' + esc(tk) + "</span>" : "") + (sub && !compact ? '<span class="qc-bank-sub">' + esc(sub) + "</span>" : "") +
      '<span class="qc-share">' + esc(qcPct(r.shareOfDeposits) || "—") + "</span></div>" +
      (share != null ? '<span class="qc-bar" role="img" aria-label="' + esc(qcPct(r.shareOfDeposits) + " of its deposits under alerts") + '"><i style="width:max(2px,' + w.toFixed(1) + '%)"></i></span>' : "") + "</li>"
    );
  }
  /** Every bank under alerts (the bridge sends the top 10), the rest counted. `mine`: this company's rows. */
  function qcBanksHtml(block, mine, title) {
    block = qcObj(block) || {};
    var top = qcArr(block.top, 10).filter(qcObj);
    var own = qcArr(mine, 3).filter(qcObj);
    var count = num(block.count);
    if (!top.length && !own.length) return count === 0 ? qcSec(title || "Banks under alerts", '<span class="qc-n">0</span>', '<p class="qc-line">No bank branches sit under these alerts.</p>') : "";
    var isMine = function (r) { return own.some(function (o) { return str(o.bank) === str(r.bank); }); };
    var extra = own.filter(function (o) { return !top.some(function (r) { return str(r.bank) === str(o.bank); }); });
    var more = (count != null ? count : top.length) - top.length - extra.length;
    return qcSec(
      title || "Banks under alerts",
      '<span class="qc-aside">share of deposits</span>',
      '<ol class="qc-banks">' + top.map(function (r) { return qcBankRow(r, isMine(r)); }).join("") + extra.map(function (r) { return qcBankRow(r, true); }).join("") + "</ol>" +
        (more > 0 ? '<p class="qc-line">+' + esc(plural(more, "more bank", "more banks")) + " under alerts</p>" : ""),
    );
  }
  /** "0 of 220": Capital One's sandbox locations under alerts. */
  function qcC1Count(c1) {
    var checked = num(c1.locationsChecked);
    var hit = num(c1.underAlert);
    if (hit == null) hit = qcArr(c1.locations).length;
    return { hit: hit, text: checked != null ? hit + " of " + checked : String(hit) };
  }
  /** Capital One's sandbox branches and ATMs under alerts, one per line, and Quantcomm's note. */
  function qcCapOneHtml(c1) {
    c1 = qcObj(c1);
    if (!c1) return "";
    var locs = qcArr(c1.locations, 10).filter(qcObj);
    return qcSec(
      "Capital One locations",
      qcTag("Sandbox", "sbx"),
      (locs.length
        ? '<ul class="qc-list">' + locs.map(function (l) {
          var kind = /atm/i.test(str(l.kind)) ? "ATM" : "Branch";
          var where = [qcTitle(l.city), str(l.state).toUpperCase().slice(0, 2)].filter(Boolean).join(", ");
          var types = qcArr(l.alertTypes, 3).map(str).filter(Boolean).join(", ");
          return "<li><span>" + esc(kind + " · " + qcTitle(l.name)) + '</span><span class="qc-sub">' + esc([where, types].filter(Boolean).join(" · ")) + "</span></li>";
        }).join("") + "</ul>"
        : '<p class="qc-line">' + esc(qcC1Count(c1).text + " under alerts") + "</p>") +
        '<p class="qc-line">' + esc(str(c1.note).trim().slice(0, 160) || "Capital One's Nessie sandbox branches and ATMs") + "</p>",
    );
  }
  function qcKv(rows) {
    rows = rows.filter(function (r) { return r[1]; });
    return rows.length ? '<dl class="qc-kv">' + rows.map(function (r) { return "<div><dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd></div>"; }).join("") + "</dl>" : "";
  }
  function qcStressHtml(p) {
    p = qcObj(p);
    if (!p) return "";
    var n = num(p.customers);
    var liveN = num(p.liveCustomersUnderAlert);
    var live = [liveN != null ? plural(Math.round(liveN), "customer", "customers") : "", qcUsd(p.liveLoansUnderAlert) ? qcUsd(p.liveLoansUnderAlert) + " in loans" : ""].filter(Boolean).join(", ");
    return qcSec(
      "Customer stress test" + (str(p.storm) ? " · " + qcTitle(p.storm) : ""),
      p.synthetic === false ? "" : qcTag("SYNTHETIC", "syn"),
      qcKv([
        ["Customers", n != null ? String(Math.round(n)) : ""],
        ["Exposure", qcUsd(p.exposureAtDefault)],
        ["Expected loss", qcUsd(p.baselineExpectedLoss)],
        ["Added by the storm", qcUsd(p.incrementalExpectedLoss)],
        ["Under live alerts", live],
      ]) + (str(p.note).trim() ? '<p class="qc-line">' + esc(str(p.note).trim().slice(0, 200)) + "</p>" : ""),
    );
  }
  function qcFloodMapHtml(p) {
    p = qcObj(p);
    if (!p) return "";
    var km = num(p.floodedKm2);
    var cov = num(p.coveragePct);
    var hrs = num(p.hoursAfterLandfall);
    var c1 = typeof p.capitalOneLocationsExposed === "string" ? p.capitalOneLocationsExposed.trim().slice(0, 20) : num(p.capitalOneLocationsExposed);
    return qcSec(
      "Satellite flood map" + (str(p.storm) ? " · " + qcTitle(p.storm) : ""),
      "",
      qcKv([
        ["Flooded", km != null ? km + " km²" : ""],
        ["Radar coverage", cov != null ? Math.round(cov) + "%" : ""],
        ["First image", hrs != null ? Math.round(hrs) + " h after landfall" : qcWhen(p.firstImagePublished)],
        ["Capital One (sandbox)", c1 != null && c1 !== "" ? String(c1) + " nearby" : ""],
      ]),
    );
  }
  /** How the stock moved after past hurricanes: one diverging bar per storm. */
  function qcHistory(p) {
    p = qcObj(p);
    if (!p) return null;
    var storms = qcArr(p.storms, 24).filter(qcObj).map(function (s) { return { name: str(s.storm).slice(0, 24), year: num(s.year), x: num(s.excessPct) }; }).filter(function (s) { return s.x != null; });
    var mean = num(p.meanExcessPct);
    if (mean == null && storms.length) mean = storms.reduce(function (t, s) { return t + s.x; }, 0) / storms.length;
    return { storms: storms, mean: mean, bench: str(p.bench).replace(/[^\w .&-]/g, "").slice(0, 10) || "its benchmark", window: str(p.window).slice(0, 40), under: str(p.underperformed).slice(0, 20) };
  }
  function qcHistoryHtml(p) {
    var h = qcHistory(p);
    if (!h) return "";
    var storms = h.storms;
    var max = storms.reduce(function (m, s) { return Math.max(m, Math.abs(s.x)); }, 0) || 1;
    var bars = storms.length
      ? '<div class="qc-hist" role="img" aria-label="' + esc(storms.map(function (s) { return s.name + " " + qcPct(s.x, true); }).join(", ")) + '">' +
        storms.map(function (s) {
          var hh = Math.max(3, Math.round((Math.abs(s.x) / max) * 100));
          return '<span class="qc-hb ' + (s.x < 0 ? "neg" : "pos") + '" title="' + esc(s.name + (s.year ? " " + s.year : "") + ": " + qcPct(s.x, true) + " vs " + h.bench) + '"><i style="height:' + hh + '%"></i></span>';
        }).join("") + "</div>" +
        (storms[0].year && storms[storms.length - 1].year ? '<div class="qc-years"><span>' + esc(storms[0].name + " " + storms[0].year) + "</span><span>" + esc(storms[storms.length - 1].name + " " + storms[storms.length - 1].year) + "</span></div>" : "")
      : "";
    var said = [h.mean != null ? "Averaged " + qcPct(h.mean, true) + " vs " + h.bench + (storms.length ? " over " + plural(storms.length, "storm", "storms") : "") : "", h.under ? "underperformed in " + h.under : ""].filter(Boolean).join(" · ");
    return qcSec("After past hurricanes", h.window ? '<span class="qc-aside">' + esc(h.window) + "</span>" : "", (said ? '<p class="qc-line">' + esc(said) + "</p>" : "") + bars);
  }
  function qcParkingHtml(p) {
    p = qcObj(p);
    if (!p) return "";
    var verdict = str(p.verdict).trim().slice(0, 200);
    var caveats = qcArr(p.caveats, 3).map(str).filter(Boolean);
    if (!verdict && !caveats.length) return "";
    return qcSec("Parking lots from above", "", (verdict ? '<p class="qc-line">' + esc(verdict) + "</p>" : "") + (caveats.length ? '<ul class="qc-caveats">' + caveats.map(function (c) { return "<li>" + esc(c.slice(0, 200)) + "</li>"; }).join("") + "</ul>" : ""));
  }
  /** The paid footer: one muted line, "Paid $0.05 · tx 0x4e42…". */
  function qcFoot(rc) {
    if (!rc) return "Quantcomm";
    return esc("Paid " + (rc.amount || "")) + (rc.tx ? " · " + txHtml(rc.tx, rc.url) : "");
  }
  function qcAsOf(d) {
    var when = qcWhen(d.asOf);
    var age = num(d.ageHours);
    return when ? "as of " + when : age != null ? Math.round(age) + " h old" : "";
  }
  /** Quantcomm's own caveat about old data, as a quiet line (it is a caveat, not an alarm). */
  function qcNoteLine(note) {
    return note ? '<p class="cd-note">' + icon("clock") + "<span>" + esc(note) + "</span></p>" : "";
  }
  /** A bank row for the compact view: name and ticker, the share right-aligned, a thin bar. */
  function qcTopBanks(block, n) {
    var top = qcArr((qcObj(block) || {}).top, n).filter(qcObj);
    return top.length ? '<ol class="qc-banks compact">' + top.map(function (r) { return qcBankRow(r, false, true); }).join("") + "</ol>" : "";
  }
  function qcC1Line(c1, label) {
    c1 = qcObj(c1);
    if (!c1) return "";
    var k = qcC1Count(c1);
    // The sandbox label sits right after the name, so a narrow card can never clip it.
    return cdLine((label || "Capital One") + " " + qcTag("Sandbox", "sbx"), esc(k.text) + " under alerts", k.hit ? "warn" : "");
  }
  /** The flood research card (§17.4) for /quantcomm/alerts and /companies/:ticker/flood. */
  function qcFloodCard(c, e, key) {
    var d = c.d;
    var info = svcInfo(QC_ID);
    var rc = parseReceipt(c.h.tail);
    var note = str(d.note).replace(/\s+/g, " ").trim().slice(0, 320);
    var src = str(d.source).trim().slice(0, 140);
    var title, meta, body, more;
    if (c.q.op === "alerts") {
      var count = num((qcObj(d.banksUnderAlerts) || {}).count);
      var total = num((qcObj(d.alerts) || {}).total);
      title = count != null ? plural(count, "bank", "banks") + " under flood alerts" : total != null ? plural(total, "flood alert", "flood alerts") : "Flood alerts";
      meta = ["Quantcomm", count != null && total != null ? plural(total, "alert", "alerts") : "", qcAsOf(d)];
      body = qcNoteLine(note) + qcTopBanks(d.banksUnderAlerts, 3) + qcC1Line(d.capitalOne);
      more = qcAlertsHtml(d) + qcBanksHtml(d.banksUnderAlerts, null, "All banks under alerts") + qcCapOneHtml(d.capitalOne);
    } else {
      var p = qcObj(d.panels) || {};
      var tk = str(d.ticker).toUpperCase().slice(0, 10) || c.q.ticker;
      var am = qcObj(p.alerts_map);
      var ae = qcObj(p.alert_exposure);
      var cs = qcObj(p.customer_stress);
      var fm = qcObj(p.flood_map);
      var hist = qcHistory(p.storm_history);
      if (!note && am) note = str(am.note).trim().slice(0, 320);
      title = "Flood research · " + tk;
      meta = [str(d.name).slice(0, 60), "Quantcomm", qcAsOf(d)];
      var own = ae ? qcArr(ae.company, 1).filter(qcObj)[0] : null;
      var lines = [
        qcC1Line(p.branch_map, "Capital One"),
        own ? cdLine(esc(qcBank(own.bank)) + " · " + esc(qcUsd(own.depositsUnderAlert) || "—") + " under alerts", esc(qcPct(own.shareOfDeposits) || "")) : ae && num(ae.banksUnderAlerts) != null ? cdLine(esc(plural(num(ae.banksUnderAlerts), "bank", "banks") + " under alerts")) : "",
        cs ? cdLine("Stress test" + (cs.synthetic === false ? "" : " " + qcTag("SYNTHETIC", "syn")) + " · added loss", esc(qcUsd(cs.incrementalExpectedLoss) || "—")) : "",
        hist && hist.mean != null ? cdLine("After past hurricanes", esc(qcPct(hist.mean, true) + " vs " + hist.bench)) : "",
        fm && num(fm.floodedKm2) != null ? cdLine("Satellite flood map" + (str(fm.storm) ? " · " + esc(qcTitle(fm.storm)) : ""), esc(num(fm.floodedKm2) + " km²")) : "",
        am && num((qcObj(am.alerts) || {}).total) != null ? cdLine(esc(plural(num(am.alerts.total), "live flood alert", "live flood alerts"))) : "",
      ].filter(Boolean);
      body = qcNoteLine(note) + lines.slice(0, 4).join("");
      more =
        qcCapOneHtml(p.branch_map) +
        (ae ? qcBanksHtml({ top: ae.top, count: ae.banksUnderAlerts }, ae.company, "Banks under alerts") : "") +
        (am ? qcAlertsHtml(am) + (am.banksUnderAlerts ? qcBanksHtml(am.banksUnderAlerts) : "") : "") +
        qcStressHtml(p.customer_stress) + qcFloodMapHtml(p.flood_map) + qcHistoryHtml(p.storm_history) + qcParkingHtml(p.parking_lot);
      if (!lines.length && !more) return "";
    }
    if (src) more += '<p class="qc-src">' + esc(src) + "</p>";
    return cardHtml({ cls: "qc qc-flood", tile: tileHtml(info, "t20"), title: esc(title), meta: esc(meta.filter(Boolean).join(" · ")), body: body, more: more, key: key, open: !!ui.openMore[key], foot: qcFoot(rc) });
  }
  /**
   * The forecast range: the bridge's { horizonDays, fromDate, fromPrice, returnPct, lowPct, highPct }
   * (percent), tolerant of { low, high } / { min, max } / { range: [a, b] } too.
   */
  function qcForecast(f) {
    if (typeof f === "string") return { range: f.slice(0, 60), horizon: "" };
    f = qcObj(f);
    if (!f) return null;
    var lo = f.lowPct != null ? f.lowPct : f.low != null ? f.low : f.min != null ? f.min : f.p10 != null ? f.p10 : f.lower != null ? f.lower : Array.isArray(f.range) ? f.range[0] : null;
    var hi = f.highPct != null ? f.highPct : f.high != null ? f.high : f.max != null ? f.max : f.p90 != null ? f.p90 : f.upper != null ? f.upper : Array.isArray(f.range) ? f.range[1] : null;
    var unit = str(f.unit).trim();
    var fmt = function (v) {
      if (typeof v === "string" && /[%$]/.test(v)) return v.trim().replace(/^-/, "−");
      var n = num(v);
      return n == null ? "" : unit === "$" ? (n < 0 ? "−$" : "$") + Math.abs(n).toFixed(2) : qcPct(n, true);
    };
    var a = fmt(lo);
    var b = fmt(hi);
    if (!a || !b) return null;
    var days = num(f.horizonDays != null ? f.horizonDays : f.days);
    var hz = str(f.horizon || f.window || (days != null ? plural(Math.round(days), "day", "days") : "")).trim().slice(0, 30);
    var mid = f.returnPct != null ? fmt(f.returnPct) : "";
    return { range: (mid ? mid + " (" + a + " to " + b + ")" : a + " to " + b), horizon: hz };
  }
  var QC_VIEW = { positive: "Positive", neutral: "Neutral", negative: "Negative" };
  /** Quantcomm's AI analyst view (§17.4): Quantcomm's words and Quantcomm's call, calmly, with its disclaimer. */
  function qcViewCard(a, c, e, key) {
    var d = c.d;
    var v = str(d.view).toLowerCase();
    if (!QC_VIEW[v] && !str(d.headline)) return "";
    var tk = str(d.ticker).toUpperCase().slice(0, 10) || c.q.ticker;
    var rc = parseReceipt(c.h.tail);
    var conf = num(d.confidence);
    conf = conf == null ? null : Math.max(0, Math.min(100, Math.round(conf)));
    var fc = qcForecast(d.forecast);
    var pick = qcObj(d.pick);
    var pAct = pick ? str(pick.action).toLowerCase().replace(/[^a-z ]/g, "").slice(0, 16) : "";
    var pConf = pick ? num(pick.confidence) : null;
    var note = str(d.note).trim().slice(0, 160) || (d.stale === true ? "Quantcomm's data changed since this view was generated." : "");
    var when = qcWhen(String(d.generatedAt || "").slice(0, 10));
    var model = str(d.model).replace(/[^\w .:/-]/g, "").slice(0, 24);
    var facts = [
      conf != null ? "Confidence " + conf : "",
      str(d.expectedMove).trim() ? "expected move " + str(d.expectedMove).trim().slice(0, 24) : "",
      fc ? "forecast" + (fc.horizon ? " " + fc.horizon : "") + " " + fc.range : "",
    ].filter(Boolean).join(" · ");
    var evidence = qcArr(d.evidence, 8).map(str).filter(Boolean);
    var gaps = qcArr(d.dataGaps, 6).map(str).filter(Boolean);
    var reasoning = str(d.reasoning).trim().slice(0, 1200);
    var pickReason = pick ? str(pick.reason).trim().slice(0, 300) : "";
    var more =
      (reasoning ? "<p>" + esc(reasoning) + "</p>" : "") +
      (pickReason ? "<small>Why " + esc(pAct || "this call") + "</small><p>" + esc(pickReason) + "</p>" : "") +
      (evidence.length ? "<small>Evidence</small><ul>" + evidence.map(function (x) { return "<li>" + esc(x.slice(0, 200)) + "</li>"; }).join("") + "</ul>" : "") +
      (gaps.length ? "<small>What it couldn't see</small><ul>" + gaps.map(function (x) { return "<li>" + esc(x.slice(0, 200)) + "</li>"; }).join("") + "</ul>" : "");
    return cardHtml({
      cls: "qc qc-view",
      tile: tileHtml(svcInfo(QC_ID), "t20"),
      title: esc("Quantcomm's view on " + tk),
      right: QC_VIEW[v] ? '<span class="chip-s qc-vchip ' + v + '">' + QC_VIEW[v] + "</span>" : "",
      meta: '<span' + (model ? ' title="' + esc("Generated by Quantcomm's AI analyst (" + model + ")" + (qcWhen(d.generatedAt) ? ", " + qcWhen(d.generatedAt) : "")) + '"' : "") + ">" + esc([str(d.name).slice(0, 60), "AI analyst", when].filter(Boolean).join(" · ")) + "</span>",
      body:
        qcNoteLine(note) +
        (str(d.headline).trim() ? '<p class="qc-headline clamp2">' + esc(str(d.headline).trim().slice(0, 200)) + "</p>" : "") +
        (facts ? cdLine(esc(facts)) : "") +
        (pAct ? cdLine("Quantcomm's call · <b>" + esc(cap(pAct)) + "</b>" + (pConf != null ? " · confidence " + esc(String(Math.round(pConf))) : "")) : "") +
        '<p class="cd-note qc-disc">' + icon("info") + "<span>" + esc(QC_DISCLAIMER) + "</span></p>",
      more: more ? '<div class="qc-why">' + more + "</div>" : "",
      key: key,
      open: !!ui.openMore[key],
      foot: qcFoot(rc),
    });
  }
  /** Cards for one Quantcomm answer, or null when this entry isn't one. Failures are steps only. */
  function qcCards(a, e, key) {
    var c = qcCall(e);
    if (!c) return null;
    if (c.h.status < 200 || c.h.status >= 300) return [];
    var k = key("qc");
    var html = c.q.op === "view" ? qcViewCard(a, c, e, k) : c.q.op === "alerts" || c.q.op === "flood" ? qcFloodCard(c, e, k) : "";
    // An answer we can't draw still gets its receipt line (below), like any other paid call.
    return html ? [{ zone: "card", key: k, html: html }] : null;
  }
  /**
   * Steps on the Quantcomm bridge: "Checked live flood alerts · Quantcomm · $0.05", "Read Quantcomm's
   * view on COF · $0.10". Its refusals come before the paywall, so they read as calm one-liners that
   * say nothing was charged. Returns false for results that aren't HTTP answers (a block, an approval,
   * "not connected"), so the generic wording takes over.
   */
  function qcStep(s, q, r, e) {
    var t = q.ticker || "that company";
    s.icon = "wave";
    if (q.op === "alerts") {
      s.label = "Checked live flood alerts · Quantcomm";
      s.live = "Checking live flood alerts on Quantcomm";
    } else if (q.op === "flood") {
      s.label = "Checked " + t + "'s flood exposure · Quantcomm";
      s.live = "Checking " + t + "'s flood exposure on Quantcomm";
    } else if (q.op === "view") {
      s.label = "Read Quantcomm's view on " + t;
      s.live = "Reading Quantcomm's view on " + t;
    } else {
      s.label = "Looked up what Quantcomm covers";
      s.live = "Looking up what Quantcomm covers";
    }
    if (r == null) return true;
    var c = qcCall(e);
    if (!c) return false;
    var d = c.d;
    if (c.h.status < 200 || c.h.status >= 300) {
      var code = str(d.error);
      s.st = "soft";
      var said = firstLine(str(d.message)).replace(/\s*\([^)]*\)/g, "").replace(/\.$/, "").trim();
      if (code === "quantcomm_unavailable" || (!code && c.h.status === 503)) s.label = !said || /isn't running/.test(said) || said.length > 110 ? "Quantcomm isn't running; nothing was charged" : said;
      else if (code === "ticker_not_covered") {
        s.label = "Quantcomm doesn't cover " + t + "; nothing was charged";
        var cov = qcArr(d.covered || d.tickers, 40).map(function (x) { return str(qcObj(x) ? x.ticker : x).toUpperCase().replace(/[^A-Z0-9.-]/g, "").slice(0, 8); }).filter(Boolean);
        s.detail = cov.length ? "It covers " + cov.slice(0, 8).join(", ") + (cov.length > 8 ? " and " + (cov.length - 8) + " more" : "") : "";
      } else if (code === "no_analyst_view") s.label = "Quantcomm has no analyst view of " + t + "; nothing was charged";
      else if (code === "quantcomm_changed") s.label = "Quantcomm's data changed; nothing was charged";
      else {
        s.label = "Quantcomm returned " + c.h.status;
        s.detail = firstLine(str(d.message)) || code;
        s.st = "err";
      }
      return true;
    }
    var rc = parseReceipt(c.h.tail);
    if (rc && rc.amount) s.label += " · " + rc.amount;
    var parts = [];
    if (q.op === "alerts") {
      var tot = num((qcObj(d.alerts) || {}).total);
      var nb = num((qcObj(d.banksUnderAlerts) || {}).count);
      var c1 = qcObj(d.capitalOne);
      parts = [tot != null ? plural(tot, "alert", "alerts") : "", nb != null ? plural(nb, "bank", "banks") + " under alerts" : "", c1 && num(c1.locationsChecked) != null ? "Capital One " + (num(c1.underAlert) || 0) + " of " + num(c1.locationsChecked) : ""];
    } else if (q.op === "flood") {
      var p = qcObj(d.panels) || {};
      var bm = qcObj(p.branch_map);
      var sh = qcObj(p.storm_history);
      var own = qcArr((qcObj(p.alert_exposure) || {}).company, 1).filter(qcObj)[0];
      parts = [
        bm && num(bm.locationsChecked) != null ? "Capital One " + (num(bm.underAlert) || 0) + " of " + num(bm.locationsChecked) + " under alerts" : "",
        own && own.shareOfDeposits != null ? qcBank(own.bank) + " " + qcPct(own.shareOfDeposits) + " of deposits under alerts" : "",
        sh && str(sh.underperformed) ? "underperformed after " + str(sh.underperformed).slice(0, 12) + " storms" : "",
      ];
    } else if (q.op === "view") {
      var vv = QC_VIEW[str(d.view).toLowerCase()];
      var pk = qcObj(d.pick);
      parts = [vv || "", num(d.confidence) != null ? "confidence " + Math.round(num(d.confidence)) : "", pk && str(pk.action) ? "Quantcomm's call: " + str(pk.action).toLowerCase().slice(0, 16) : ""];
    } else {
      var cos = qcArr(d.companies, 500);
      parts = [cos.length ? plural(cos.length, "company", "companies") : ""];
    }
    s.detail = parts.filter(Boolean).join(" · ");
    return true;
  }

  // ================================================================ Computer use (ARCHITECTURE §19)
  // A sandboxed desktop rented by time and by action through {COMPUTER_USE_URL}/computer. Agents
  // drive it with fetch_url, so the page sees its compact JSON only as tool text. One card per
  // session shows the live screen (the view-only MJPEG stream from `viewUrl`) with its status and
  // one meta line; every call is a one-line step inside "Worked for…", and its receipts fold into
  // the card. When the session ends the card becomes one event line. The control token (cut_…) is
  // never shown: esc() blanks it everywhere, and only the view token (cuv_…) reaches the DOM.
  var CU_ID = "(cus_[A-Za-z0-9_-]{4,64})";
  var CU_PATHS = [
    [new RegExp("^/computer/sessions/?$"), "create"],
    [new RegExp("^/computer/sessions/" + CU_ID + "/?$"), "status"],
    [new RegExp("^/computer/sessions/" + CU_ID + "/time/?$"), "time"],
    [new RegExp("^/computer/sessions/" + CU_ID + "/end/?$"), "end"],
    [new RegExp("^/computer/sessions/" + CU_ID + "/snapshot/?$"), "snapshot"],
    [new RegExp("^/computer/sessions/" + CU_ID + "/screenshot/?$"), "screenshot"],
    [new RegExp("^/computer/sessions/" + CU_ID + "/actions/([a-z]{2,16})/?$"), "action"],
  ];
  /** A computer-use URL (§19.4) → { op, id, kind, minutes }, else null. Any host: the path says what it is. */
  function cuOf(u) {
    var full = str(u).trim();
    if (!full) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(full)) full = "http://" + full;
    var x;
    try { x = new URL(full); } catch (e) { return null; }
    for (var i = 0; i < CU_PATHS.length; i++) {
      var m = x.pathname.match(CU_PATHS[i][0]);
      if (m) return { op: CU_PATHS[i][1], id: m[1] || "", kind: m[2] || "", minutes: Math.max(1, Math.min(5, Math.round(num(x.searchParams.get("minutes")) || 1))) };
    }
    return null;
  }
  /** A computer answer in this tool entry: { h (parseHttp), q (cuOf), d (body or {}) }, else null. */
  function cuCall(e) {
    if (!e || e.result == null || (e.name !== "fetch_url" && e.name !== "check_approval")) return null;
    var h = parseHttp(e.result);
    if (!h) return null;
    var q = cuOf(h.url);
    return q ? { h: h, q: q, d: h.data || {} } : null;
  }
  /** The viewer link from a create answer, only if it is a view-only link (cuv_ token). */
  function cuViewUrl(u) {
    var s = safeUrl(str(u));
    if (!s) return "";
    try {
      var x = new URL(s);
      return /^\/computer\/sessions\/cus_[A-Za-z0-9_-]{4,64}\/view$/.test(x.pathname) && /^cuv_[0-9a-fA-F]{16,64}$/.test(str(x.searchParams.get("token"))) ? x.href : "";
    } catch (e) {
      return "";
    }
  }
  /** The live MJPEG stream next to the viewer (same view-only token). */
  function cuStreamUrl(view) {
    try {
      var x = new URL(view);
      return x.origin + x.pathname.replace(/\/view$/, "/stream") + "?token=" + encodeURIComponent(x.searchParams.get("token"));
    } catch (e) {
      return "";
    }
  }
  /** "$0.005", "$0.047", "$0.21": computer prices go below a cent. */
  function money3(v) {
    var n = num(v) || 0;
    var s = Math.abs(n).toFixed(3);
    if (/\d\.\d\d0$/.test(s)) s = s.slice(0, -1);
    return "$" + s;
  }
  function mmss(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ":" + (sec % 60 < 10 ? "0" : "") + (sec % 60);
  }
  var cuCache = { ver: -1, by: {} };
  /**
   * Every computer session in an agent's log, from its results and receipts: { map: id → session,
   * order }. A session: { id, viewUrl, status, position, queueLength, wait, waitAt, leaseEndsAt,
   * page, endReason, minutes, actions, reads, spend, last (entry) }.
   */
  function cuSessions(a) {
    if (cuCache.ver !== state.logVer) cuCache = { ver: state.logVer, by: {} };
    if (cuCache.by[a.name]) return cuCache.by[a.name];
    var map = {};
    var order = [];
    (a.log || []).forEach(function (e) {
      var c = cuCall(e);
      if (!c) return;
      var d = c.d;
      var id = c.q.id || (c.q.op === "create" && /^cus_[A-Za-z0-9_-]{4,64}$/.test(str(d.id)) ? str(d.id) : "");
      if (!id) return;
      var s = map[id];
      if (!s) {
        s = map[id] = { id: id, viewUrl: "", status: "", position: null, queueLength: null, wait: null, waitAt: 0, leaseEndsAt: 0, page: null, endReason: "", minutes: 0, actions: 0, reads: 0, spend: 0, last: null, firstAt: ts(e.at) };
        order.push(s);
      }
      s.last = e;
      var at = ts(e.at) + (e.ms || 0);
      var ok = c.h.status >= 200 && c.h.status < 300;
      var method = (str(objArgs(e).method) || "GET").toUpperCase();
      if (ok) {
        if (c.q.op === "create" && cuViewUrl(d.viewUrl)) s.viewUrl = cuViewUrl(d.viewUrl);
        var stv = str(d.status);
        if (stv === "queued" || stv === "active" || stv === "ended") s.status = stv;
        if (stv === "queued") {
          s.position = num(d.position);
          s.queueLength = num(d.queueLength);
          s.wait = num(d.estimatedWaitSeconds);
          s.waitAt = at;
        }
        var L = qcObj(d.lease);
        if (L) {
          var left = num(L.secondsLeft);
          var end = ts(L.endsAt) || (left != null && left > 0 ? at + left * 1000 : 0);
          if (end) s.leaseEndsAt = end;
          if (c.q.op !== "status" || stv === "active") s.status = s.status === "ended" ? "ended" : "active";
        }
        var pg = qcObj(d.page);
        if (pg && str(pg.url)) s.page = { url: str(pg.url), title: str(pg.title) };
        else if ((c.q.op === "action" || c.q.op === "snapshot") && str(d.url)) s.page = { url: str(d.url), title: str(d.title) };
        if (str(d.endReason)) s.endReason = str(d.endReason).slice(0, 30);
        if (c.q.op === "end" || (c.q.op === "status" && method === "DELETE")) {
          s.status = "ended";
          s.endReason = s.endReason || "ended";
        }
      } else {
        var code = str(d.error);
        if (c.h.status === 410 || code === "session_ended" || code === "lease_lapsed") {
          s.status = "ended";
          s.endReason = code || "ended";
        }
      }
      // Its receipts ("Paid $0.005 to Computer use · click") fold into the card's meta line. From the
      // whole result: a screenshot's body isn't JSON, so parseHttp keeps no tail for it.
      var rc = parseReceipt(e.result);
      if (rc && /^Computer use\b/.test(rc.party)) {
        s.spend += num(rc.amount) || 0;
        var mm = rc.party.match(/· (\d+) minutes?$/);
        if (mm) s.minutes += Number(mm[1]);
        else if (/· (?:text snapshot|screenshot)$/.test(rc.party)) s.reads++;
        else s.actions++;
      }
    });
    return (cuCache.by[a.name] = { map: map, order: order });
  }
  /** Seen live by this page (its stream answered): session id → true. */
  var cuLive = {};
  /**
   * Where the session is now: { phase: "queued" | "starting" | "live" | "ended", reason }. The log
   * says most of it; the lease running out, a line spot nobody took up, and the stream answering
   * say the rest.
   */
  function cuPhase(s, a) {
    var now = Date.now();
    if (s.status === "ended") return { phase: "ended", reason: s.endReason || "ended" };
    if (s.leaseEndsAt && now > s.leaseEndsAt + 5000) return { phase: "ended", reason: "lease_lapsed" };
    if (s.status === "active") return { phase: s.leaseEndsAt || cuLive[s.id] ? "live" : "starting" };
    if (cuLive[s.id]) return { phase: "live" };
    if (s.status === "queued" && !a.busy && s.waitAt && now > s.waitAt + ((s.wait || 0) + 150) * 1000) return { phase: "ended", reason: "not_started" };
    return { phase: s.status === "queued" ? "queued" : "starting" };
  }
  function cuMeta(s) {
    return [s.minutes ? s.minutes + " min" : "", s.actions ? plural(s.actions, "action", "actions") : "", s.reads ? plural(s.reads, "read", "reads") : ""].filter(Boolean);
  }
  /** "Used the Computer · 4 min · 23 actions · $0.21". */
  function cuEndedLine(s, reason) {
    var used = s.minutes || s.actions || s.reads;
    var meta = cuMeta(s).map(esc);
    if (!used) meta.push(reason === "ended" || reason === "cancelled" ? "left the line" : "didn't start");
    if (reason === "lease_lapsed" && used) meta.push("time ran out");
    return evHtml({ ic: icon("monitor"), text: used ? "Used the <b>Computer</b>" : "Asked for the <b>Computer</b>", meta: meta, amt: s.spend ? money3(s.spend) : "not charged" });
  }
  /** Stable markup (session and theme only): the stream <img> keeps playing across re-renders. Phases are classes. */
  function cuCardHtml(a, s) {
    return (
      '<div class="it them k-card"><div class="card cu" data-cu="' + esc(s.id) + '" data-agent="' + esc(a.name) + '">' +
      '<div class="cd-h"><span class="cu-ic">' + icon("monitor") + '</span><div class="cd-ht"><div class="cd-t">Computer<span class="cu-st"><i></i><span></span></span></div></div>' +
      '<span class="chip-s cu-sbx" title="A fresh, isolated browser desktop for this session only. It can\'t reach your computer, your network or other sessions.">' + icon("shield") + "Sandboxed desktop</span>" +
      (s.viewUrl ? '<button type="button" class="btn-2 sm cu-watch" data-action="cu-watch" data-agent="' + esc(a.name) + '" data-cu="' + esc(s.id) + '">Watch</button>' : "") + "</div>" +
      '<div class="cu-screen"><img class="cu-img" alt="Live screen of the agent\'s computer" referrerpolicy="no-referrer" hidden><div class="cu-wait"><b></b><span></span></div></div>' +
      '<div class="cd-f"><span class="cd-fl cu-m"></span></div>' +
      "</div></div>"
    );
  }
  /** Items for one computer answer: the session's card (or its ended line) at its latest answer, else nothing. */
  function cuItems(a, e) {
    var c = cuCall(e);
    if (!c) return null;
    var reg = cuSessions(a);
    var s = reg.map[c.q.id || str(c.d.id)];
    if (!s || s.last !== e) return [];
    var key = "cu:" + a.name + ":" + s.id;
    var ph = cuPhase(s, a);
    if (ph.phase === "ended") return [{ zone: "event", key: key + ":end", html: cuEndedLine(s, ph.reason) }];
    return [{ zone: "card", key: key, stable: true, html: cuCardHtml(a, s) }];
  }
  var cuTimers = {};
  /** Patch every computer card in the page: status mark, waiting text, meta line, and the stream. */
  function applyComputers() {
    document.querySelectorAll(".card.cu[data-cu]").forEach(function (el) {
      var a = state.agents[el.getAttribute("data-agent")];
      var s = a && cuSessions(a).map[el.getAttribute("data-cu")];
      if (!s) return;
      var ph = cuPhase(s, a).phase;
      ["queued", "starting", "live"].forEach(function (p) { el.classList.toggle("phase-" + p, ph === p); });
      var mark = el.querySelector(".cu-st span");
      var markText = ph === "live" ? "Live" : ph === "queued" ? "In line" : "Starting";
      if (mark.textContent !== markText) mark.textContent = markText;
      var wt = el.querySelector(".cu-wait b");
      var ws = el.querySelector(".cu-wait span");
      var w = ph === "queued"
        ? ["In line" + (s.position ? " · position " + s.position : ""), s.wait ? "about " + (s.wait < 90 ? Math.max(5, Math.round(s.wait / 5) * 5) + " s" : Math.round(s.wait / 60) + " min") + " · waiting is free" : "Waiting is free"]
        : ph === "starting"
          ? ["Starting the desktop", s.leaseEndsAt ? "" : "It starts when the first minute is bought"]
          : [s.viewUrl ? "Connecting to the screen" : "No live view for this session", ""];
      if (wt.textContent !== w[0]) wt.textContent = w[0];
      if (ws.textContent !== w[1]) ws.textContent = w[1];
      var meta = (ph === "live" && s.leaseEndsAt ? ['<span data-left-until="' + s.leaseEndsAt + '">' + esc(mmss((s.leaseEndsAt - Date.now()) / 1000)) + "</span> left"] : []).concat(cuMeta(s).filter(function (x) { return !/min$/.test(x); }).map(esc));
      meta.push(s.spend ? money3(s.spend) + " spent" : "nothing spent yet");
      if (s.page && s.page.url && s.page.url !== "about:blank" && ph === "live") meta.push('<span class="cu-page" title="' + esc(s.page.url) + '">' + esc(s.page.title || hostPath(s.page.url)) + "</span>");
      var m = el.querySelector(".cu-m");
      var mh = meta.join(" · ");
      if (m.__html !== mh) { m.innerHTML = mh; m.__html = mh; }
      // The stream: try it unless the session is in line; it answers once the desktop is up.
      var img = el.querySelector(".cu-img");
      var stream = s.viewUrl ? cuStreamUrl(s.viewUrl) : "";
      if (stream && ph !== "queued" && !img.__wired) {
        img.__wired = true;
        var tries = 0;
        var go = function () { if (img.isConnected) img.src = stream + "&t=" + Date.now(); };
        img.onload = function () {
          img.hidden = false;
          el.classList.add("streaming");
          if (!cuLive[s.id]) { cuLive[s.id] = true; schedule(); }
        };
        img.onerror = function () {
          img.hidden = true;
          el.classList.remove("streaming");
          if (img.isConnected && tries++ < 120) setTimeout(go, 3000);
        };
        go();
      }
      // Re-render when the lease runs out, so the card becomes its ended line on time.
      if (ph === "live" && s.leaseEndsAt && cuTimers[s.id] !== s.leaseEndsAt) {
        cuTimers[s.id] = s.leaseEndsAt;
        setTimeout(schedule, Math.max(1000, s.leaseEndsAt - Date.now() + 5500));
      }
    });
  }
  /** One step per computer call: "Clicked [12] “Browse the first website” · $0.005". Returns false when the result isn't an HTTP answer. */
  function cuStep(s, q, r, e) {
    var args = objArgs(e);
    var body = args.body && typeof args.body === "object" ? args.body : {};
    var method = (str(args.method) || "GET").toUpperCase();
    var target = function (d) {
      var t = str(d && (d.clicked || d.hovered || d.into)).match(/^\[(\d+)\] (.{1,80})/);
      if (t) return "[" + t[1] + "] “" + t[2].trim() + "”";
      if (num(body.element) != null) return "[" + num(body.element) + "]";
      return num(body.x) != null ? "the screen at " + num(body.x) + "," + num(body.y) : "";
    };
    s.icon = "monitor";
    var K = { navigate: "Opened ", click: "Clicked ", type: "Typed ", key: "Pressed ", scroll: "Scrolled ", select: "Chose ", hover: "Hovered over ", back: "Went back", forward: "Went forward", reload: "Reloaded the page" };
    var label = function (d) {
      if (q.op === "create") return "Asked for a computer";
      if (q.op === "status") return method === "DELETE" ? "Ended the computer session" : "Checked on the computer";
      if (q.op === "time") return "Bought " + plural(q.minutes, "minute", "minutes") + " of computer time";
      if (q.op === "end") return "Ended the computer session";
      if (q.op === "snapshot") return "Read the screen";
      if (q.op === "screenshot") return "Took a screenshot";
      var k = q.kind;
      if (k === "navigate") return K.navigate + (hostPath(body.url) || "a page");
      if (k === "type") return K.type + "“" + str(body.text).slice(0, 40) + (str(body.text).length > 40 ? "…" : "") + "”" + (target(d) ? " into " + target(d) : "");
      if (k === "key") return K.key + (str(body.keys).slice(0, 30) || "a key");
      if (k === "scroll") return K.scroll + (str(body.direction) || "down");
      if (k === "select") return K.select + "“" + str(body.value).slice(0, 30) + "”" + (target(d) ? " in " + target(d) : "");
      if (k === "click" || k === "hover") return K[k] + (target(d) || "the page");
      return K[k] || "Used the computer (" + k + ")";
    };
    s.label = label(null);
    s.live = q.op === "time" ? "Buying computer time (the desktop starts first)" : q.op === "create" ? "Asking for a computer" : s.label.replace(/^Opened /, "Opening ").replace(/^Clicked /, "Clicking ").replace(/^Typed /, "Typing ").replace(/^Read the screen$/, "Reading the screen");
    if (r == null) return true;
    var c = cuCall(e);
    if (!c) return false;
    var d = c.d;
    if (c.h.status >= 400) {
      var code = str(d.error);
      var msg = firstLine(str(d.message)).replace(/\s*Nothing was charged\.?$/i, "").replace(/\.$/, "");
      // Refused before the paywall (§19.3): nothing was charged, so it is a calm line.
      var free = /^(session_queued|session_ended|lease_lapsed|lease_required|lease_full|session_limit|invalid_minutes|invalid_action|unknown_action|card_number_refused|password_field_refused|not_live|queue_full|computer_unavailable|token_required|wrong_token|view_only|session_not_found)$/.test(code);
      s.label = label(d);
      s.detail = (msg || code || "HTTP " + c.h.status) + " · not charged";
      s.st = free ? "soft" : "err";
      return true;
    }
    var rc = parseReceipt(e.result);
    s.label = label(d) + (rc && rc.amount ? " · " + rc.amount : "");
    var L = qcObj(d.lease);
    var left = L && num(L.secondsLeft) ? mmss(num(L.secondsLeft)) + " left" : "";
    if (q.op === "create" || q.op === "status") {
      s.detail = str(d.status) === "queued" ? "In line" + (num(d.position) ? " · position " + num(d.position) : "") + (num(d.estimatedWaitSeconds) ? " · about " + num(d.estimatedWaitSeconds) + " s" : "") : str(d.status) === "ended" ? "Ended" : left || (q.op === "create" ? "Got a seat" : "");
    } else if (q.op === "snapshot") {
      s.detail = [Array.isArray(d.elements) ? plural(d.elements.length, "element", "elements") : "", str(d.title).slice(0, 60)].filter(Boolean).join(" · ");
    } else if (q.op === "action") {
      s.detail = str(d.title).slice(0, 60) || hostPath(d.url);
    } else if (q.op === "time") {
      s.detail = left;
    } else if (q.op === "end" && qcObj(d.spent)) {
      s.detail = "spent " + money3(d.spent.total);
    }
    return true;
  }
  /** The bigger view: the service's own viewer page (its stream, status and page line) in a sheet. */
  function cuSheetHtml(sh) {
    return (
      '<div class="sh-head"><span class="sh-title">Computer <span class="chip-s cu-sbx">' + icon("shield") + "Sandboxed desktop</span></span>" +
      '<span class="cu-sh-acts"><a class="icon-btn" href="' + esc(sh.view) + '" target="_blank" rel="noopener noreferrer" title="Open in a new tab" aria-label="Open in a new tab">' + icon("external") + "</a>" +
      '<button class="icon-btn" data-action="sheet-close" aria-label="Close">' + icon("x") + "</button></span></div>" +
      '<div class="cu-sh-body"><iframe class="cu-frame" title="The agent\'s computer, live" src="' + esc(sh.view + "&embed=1") + '" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin"></iframe></div>' +
      '<div class="sh-foot"><button class="btn-1" data-action="sheet-close">Done</button></div>'
    );
  }
  function openCuSheet(agent, id) {
    var a = state.agents[agent];
    var s = a && cuSessions(a).map[id];
    if (!s || !s.viewUrl) return;
    ui.sheet = { kind: "cu", agent: agent, id: id, view: s.viewUrl };
    mountSheet();
  }

  // ================================================================ tool result parsing (apps/mcp/src/server.ts, format.ts)
  var REASONS = {
    not_allowlisted: "Not an approved recipient",
    max_per_tx: "Over the per-payment limit",
    daily_cap: "Over the daily cap",
    frozen: "The agent is frozen",
    insufficient_balance: "Not enough balance",
    service_cap: "Over this service's price cap",
    unsupported_requirements: "Unsupported payment request",
    service_not_connected: "Service not connected",
  };
  function objArgs(e) {
    return e && e.args && typeof e.args === "object" && !Array.isArray(e.args) ? e.args : {};
  }
  /** "Paid $0.05 to Acme Weather. Receipt: tx 0x12ab…cd34 (http://…)" and the Earned / Sent variants. */
  function parseReceipt(r) {
    var lines = str(r).split("\n");
    for (var i = lines.length - 1; i >= 0; i--) {
      var l = lines[i].trim().replace(/^Owner approved\.\s*/, "");
      var m = l.match(/^(Paid|Earned|Sent) (\$[\d,]+(?:\.\d+)?) (to|for) (.+?)\. Receipt: (.*)$/);
      var m0 = m ? null : l.match(/^Paid to (.+?)\. Receipt: (.*)$/);
      if (!m && !m0) continue;
      var tail = m ? m[5] : m0[2];
      var tx = tail.match(/tx (0x[0-9a-fA-F]+(?:…[0-9a-fA-F]+)?)/);
      var url = tail.match(/\((https?:\/\/[^\s)]+)\)/);
      return { verb: m ? m[1] : "Paid", amount: m ? m[2] : "", prep: m ? m[3] : "to", party: (m ? m[4] : m0[1]).slice(0, 120), tx: tx ? tx[1] : "", url: url ? safeUrl(url[1]) : "" };
    }
    return null;
  }
  function parseBlocked(r) {
    r = str(r);
    var m = r.match(/^Blocked by wallet policy \(([a-z_]+)\): ([\s\S]*?)(?: The agent is now frozen;| The owner has been notified\.)/);
    if (!m) return null;
    var am = r.match(/The (payment|transfer) of (\$[\d,.]+) to (.+?) was NOT made/);
    var msg = m[2].replace(/^Blocked:\s*/, "").replace(/\s*Agent frozen\.?\s*$/, "").trim();
    return {
      reason: m[1],
      title: REASONS[m[1]] || "Blocked by your policy",
      message: cap(msg).slice(0, 240),
      frozen: /The agent is now frozen/.test(r),
      kind: am ? am[1] : "",
      amount: am ? am[2] : "",
      to: am ? am[3].slice(0, 80) : "",
    };
  }
  function parseOrder(r) {
    r = str(r);
    var i = r.indexOf("{");
    var j = r.lastIndexOf("}");
    if (i < 0 || j <= i) return null;
    try {
      var o = JSON.parse(r.slice(i, j + 1));
      return o && typeof o === "object" && !Array.isArray(o) && o.orderId ? o : null;
    } catch (e) {
      return null;
    }
  }
  function connStatusFromText(r) {
    r = str(r);
    if (/^(Connected|Owner connected) /.test(r) || /is already connected/.test(r) || /always available; it does not need connecting/.test(r)) return "connected";
    if (/^Waiting for the owner to approve (?:connecting|adding)/.test(r) || /^Asked your owner to (?:add|connect)/.test(r)) return "pending";
    if (/denied (?:connecting|adding)|^The owner denied/.test(r)) return "declined";
    if (/expired without a decision/.test(r)) return "expired";
    return "";
  }
  function approvalIdIn(r) {
    var m = str(r).match(/Approval id (apr_[A-Za-z0-9_-]+)/);
    return m ? m[1] : "";
  }

  // ================================================================ steps (Muse activity record)
  function runningToolOf(entries) {
    for (var i = entries.length - 1; i >= 0; i--) if (entries[i].kind === "tool" && entries[i].result == null) return entries[i];
    return null;
  }
  /** "Asked your owner to connect Acme Weather (localhost:4321)" and the other request texts (§18) → { name, host }. */
  function namedInText(r) {
    r = str(r);
    var m = r.match(/(?:^Asked your owner to (?:connect|add)|approve (?:connecting|adding)|^(?:Owner connected|Connected)|denied (?:connecting|adding)|request to (?:connect|add)|^The wallet did not accept this request:) (?:the Shopify store )?(.{1,80}?) \(([^()\n]{2,120})\)/) || r.match(/^(.{1,80}?) \(([^()\n]{2,120})\) is already connected/);
    return m && !/^Shopify store /.test(m[2]) ? { name: m[1].trim(), host: m[2].trim() } : null;
  }
  /** The wallet turned the link down before it reached the owner (§18): its reason in a few words, else "". */
  var REFUSED_RE = /^Allowance can't use |isn't something Allowance can pay|^The wallet did not accept this request|can't be added:/;
  function refusalOf(r) {
    r = firstLine(str(r).replace(/^ERROR:\s*/, ""));
    if (/isn't something Allowance can pay|unrecognized_service_url/.test(r)) return "Not something Allowance can pay";
    var over = r.match(/^The wallet did not accept this request: .{1,80}? \([^()]{2,120}\) (asks .+?)(?:\.\s+[A-Z]|\.?$)/);
    if (over) return cap(over[1]);
    return r.replace(/^The wallet did not accept this request:\s*/, "").replace(/^.*?can't be added:\s*/, "");
  }
  /**
   * request_service by link (§18 `url`; §15.4 `shopify_store_url` is its older name): what we know.
   * The wallet works out what the link is: a directory service, a Shopify store or an x402 API.
   * { is, link: { host, handle }, handle, named, sid, host, kind: "shopify" | "x402" | "directory" | "", price, refused }
   */
  function storeRequest(e) {
    var args = objArgs(e);
    var raw = str(args.url || args.shopify_store_url).trim();
    var link = storeLink(raw);
    if (!link.host && raw) link = { host: hostOnly(raw).toLowerCase(), handle: "" };
    var r = e && e.result != null ? str(e.result) : "";
    var sid = (r.match(/service_id: "([A-Za-z0-9._-]{1,80})"/) || [])[1] || "";
    var said = storeInText(r);
    var nh = said ? null : namedInText(r);
    var nm = said || nh ? null : r.match(/approve (?:connecting|adding) (.{1,80}?)\. Approval id/) || r.match(/^(?:Owner connected|Connected) (.{1,80}?)\.(?:\s|$)/) || r.match(/denied (?:connecting|adding) (.{1,80}?)\./) || r.match(/request to (?:connect|add) (.{1,80}?) expired/);
    var handle = /^shopify-/.test(sid) ? sid.slice(8) : said && said.handle ? said.handle : link.handle;
    var kind = /^shopify-/.test(sid) || said || link.handle || (!args.url && args.shopify_store_url) ? "shopify" : /^custom-/.test(sid) ? "x402" : sid ? "directory" : "";
    var price = (r.match(/(?:up to )?\$([\d,]+(?:\.\d+)?) (?:per|a|each) (?:request|call)/) || [])[1] || str(args.max_price).replace(/^\$/, "");
    // Refused before it reached the owner (not payable, over the limit, not a store, password-protected, an admin link).
    var refused = r && !connStatusFromText(r) && (e.isError || REFUSED_RE.test(r)) ? refusalOf(r) : "";
    return {
      is: !!raw && !str(args.service_id).trim() && !(args.custom && typeof args.custom === "object"),
      link: link,
      handle: HANDLE_RE.test(handle) ? handle : "",
      named: said ? said.name : nh ? nh.name : nm ? nm[1].trim() : "",
      sid: sid,
      host: nh ? nh.host : "",
      kind: kind,
      price: num(price) != null ? String(num(price)) : "",
      refused: refused,
    };
  }
  /** The service a request_service call is about: its directory id, or the one its link resolved to. */
  function requestedId(e) {
    var id = str(objArgs(e).service_id).trim();
    if (id) return id;
    var rq = storeRequest(e);
    if (!rq.is) return "";
    return rq.sid || (rq.kind === "shopify" && rq.handle ? "shopify-" + rq.handle : "");
  }
  function serviceNameOfRequest(e) {
    var a = objArgs(e);
    if (a.custom && typeof a.custom === "object") return str(a.custom.name).slice(0, 60) || "a new service";
    var rq = storeRequest(e);
    if (rq.is) return rq.named || (rq.handle && (shops[rq.handle] || {}).name) || (rq.kind === "directory" ? svcInfo(rq.sid).name : "") || rq.host || rq.link.host || "a service";
    return svcInfo(str(a.service_id)).name;
  }
  function waitingText(a, e) {
    var args = objArgs(e);
    if (!e) return "Waiting for your approval";
    if (e.name === "request_service") return "Waiting for you to connect " + serviceNameOfRequest(e);
    if (e.name === "fetch_url") {
      var svc = serviceForUrl(str(args.url));
      var due = checkoutTotal(a, str(args.url));
      return "Waiting for your OK to pay " + (due ? due + " to " : "") + (svc ? svc.name : hostOnly(args.url));
    }
    if (e.name === "transfer_usdc") return "Waiting for your OK to send " + money(args.amount);
    var ap = approvals[str(args.approval_id).trim()] || approvals[str(((a && a.status) || {}).approvalId)];
    if (ap && ap.verb) return ap.kind === "service" ? "Waiting for you to " + ap.verb + " " + ap.obj : "Waiting for your OK to " + ap.verb + " " + ap.obj;
    return "Waiting for your approval";
  }
  function stepOf(a, e) {
    var args = objArgs(e);
    var r = e.result == null ? null : str(e.result);
    var s = { icon: "wrench", label: "Used " + str(e.name), live: "Using " + str(e.name), detail: "", st: r == null ? "run" : e.isError ? "err" : "ok" };
    var first = r ? firstLine(r) : "";
    var m;
    switch (e.name) {
      case "list_services":
        s.icon = "grid";
        s.label = "Checked its services";
        s.live = "Checking its services";
        if (r) s.detail = (m = r.match(/connected services \((\d+)\)/i)) ? m[1] + " connected" : /No services are connected/i.test(r) ? "None connected yet" : "";
        break;
      case "search_services": {
        var q = str(args.query).trim().slice(0, 40);
        s.icon = "search";
        s.label = q ? "Searched the directory for “" + q + "”" : "Browsed the service directory";
        s.live = q ? "Searching the directory for “" + q + "”" : "Browsing the service directory";
        if (r) {
          var hits = parseServiceLines(r);
          s.detail = hits.length ? plural(hits.length, "result", "results") + " · " + hits.slice(0, 3).map(function (h) { return h.name; }).join(", ") : /^No services match/.test(r) ? "No matches" : "";
        }
        break;
      }
      case "get_service": {
        var sv = svcInfo(str(args.service_id));
        s.icon = "book";
        s.label = "Read how to use " + sv.name;
        s.live = "Reading how to use " + sv.name;
        if (r) s.detail = /Status: connected/.test(r) ? "Connected" : /Status: not connected/.test(r) ? "Not connected yet" : /always available/.test(r) ? "Always available" : e.isError ? first : "";
        break;
      }
      case "request_service": {
        var nm = serviceNameOfRequest(e);
        var srq = storeRequest(e);
        s.icon = srq.kind === "shopify" || handleOfId(args.service_id) ? "bag" : "plug";
        s.label = "Asked you to connect " + nm;
        s.live = "Asking you to connect " + nm;
        if (r) {
          var cs = connStatusFromText(r);
          // Resolved later (check_approval, or the owner decided while it was between waits)?
          if (cs === "pending" && a) cs = connStatus(a, e);
          s.detail = { connected: "Connected", pending: "Waiting for you", declined: "You declined", expired: "Request expired" }[cs] || "";
          if (cs === "pending") s.st = "wait";
          if (cs === "declined" || cs === "expired") s.st = "soft";
          if (!cs && (e.isError || srq.refused)) {
            // The wallet refused the link before it reached you: a calm line, nothing to do.
            s.label = "Asked to connect " + nm;
            s.detail = srq.refused || first;
            s.st = "soft";
          }
        }
        break;
      }
      case "fetch_url":
        fetchStep(s, args, r, e);
        break;
      case "find_work": {
        var site = hostOnly(args.site_url);
        s.icon = "briefcase";
        s.label = "Looked for paid work on " + site;
        s.live = "Looking for paid work on " + site;
        if (r) s.detail = (m = r.match(/offers (\d+) bount/)) ? plural(Number(m[1]), "bounty", "bounties") : e.isError ? "No paid work found" : "";
        break;
      }
      case "claim_bounty":
        s.icon = "hand";
        s.label = "Claimed a slot";
        s.live = "Claiming a slot";
        if (r) {
          if ((m = r.match(/^Claimed "(.{1,160}?)"/))) s.detail = m[1];
          else if (/All slots on this bounty are taken|bounty_full/.test(r)) { s.label = "No slots left"; s.st = "err"; s.detail = "Another agent got there first"; }
          else if (/already holds|already_claimed/.test(r)) { s.label = "Already had a slot"; s.st = "ok"; }
          else if (e.isError) { s.label = "Couldn't claim a slot"; s.detail = first; }
        }
        break;
      case "submit_bounty":
        s.icon = "upload";
        s.label = "Submitted work";
        s.live = "Submitting work";
        if (r) {
          var rc = parseReceipt(r);
          if (rc) { s.label = "Submitted work · earned " + rc.amount; s.detail = rc.tx ? "tx " + rc.tx : ""; }
          else if (/^Work rejected/.test(r)) { s.label = "Submitted work · rejected"; s.st = "err"; s.detail = first.replace(/^Work rejected \(not paid\):\s*/, ""); }
          else if (e.isError) { s.label = "Couldn't submit the work"; s.detail = first; }
        }
        break;
      case "transfer_usdc": {
        var amt = money(args.amount);
        var to = shortAddr(args.to);
        s.icon = "send";
        s.label = "Sent " + amt + " to " + to;
        s.live = "Sending " + amt + " to " + to;
        if (r) {
          var b = parseBlocked(r);
          if (b) { s.icon = "shield"; s.label = "Tried to send " + amt + " to " + to; s.detail = "Blocked · " + b.title + (b.frozen ? " · agent frozen" : ""); s.st = "err"; }
          else if (/^Waiting for the owner/.test(r)) { s.label = "Asked you to approve " + amt + " to " + to; s.st = "wait"; }
          else if (/^The owner denied/.test(r)) { s.label = "Tried to send " + amt + " to " + to; s.detail = "You declined"; s.st = "soft"; }
          else if (e.isError) { s.label = "Tried to send " + amt + " to " + to; s.detail = first; }
        }
        break;
      }
      case "get_wallet":
        s.icon = "wallet";
        s.label = "Checked its wallet";
        s.live = "Checking its wallet";
        if (r) s.detail = ((m = r.match(/Balance: (\$[\d,.]+)/)) ? "Balance " + m[1] : "") + (/FROZEN/.test(r) ? " · frozen" : "");
        break;
      case "check_approval":
        s.icon = "clock";
        s.label = "Checked on your approval";
        s.live = "Checking on your approval";
        if (r) {
          var rc2 = parseReceipt(r);
          var so = shopCall(e);
          if (so && so.b.op === "checkout" && so.h.status < 300 && isPlaced(confirmationOf(so.d))) {
            s.label = paidLabel(confirmationOf(so.d), rc2);
            s.icon = "card";
            s.detail = "You approved · " + shopName(so.b.handle, confirmationOf(so.d).store) + " · simulated order";
            break;
          }
          var cua = cuCall(e);
          if (cua && cuStep(s, cua.q, r, e)) {
            if (s.st === "ok") s.detail = "You approved" + (s.detail ? " · " + s.detail : "");
            break;
          }
          var qa = qcCall(e);
          if (qa && qcStep(s, qa.q, r, e)) {
            if (s.st === "ok") s.detail = "You approved" + (s.detail ? " · " + s.detail : "");
            break;
          }
          var said = /^Owner connected/.test(r) ? storeInText(r) || namedInText(r) : null;
          s.detail = said ? "You connected " + said.name : rc2 ? rc2.verb + " " + rc2.amount + " " + rc2.prep + " " + rc2.party : /^Owner connected (.+?)\./.test(r) ? "You connected " + r.match(/^Owner connected (.+?)\./)[1] : /denied/.test(r) ? "You declined" : /expired/.test(r) ? "Expired" : /^Waiting/.test(r) ? "Still waiting for you" : first;
          if (/^Waiting/.test(r)) {
            // Settled since in the embed (the agent had stopped checking): say how it ended.
            var dap = approvals[str(args.approval_id).trim()];
            if (dap && dap.phase === "decided") s.detail = dap.status === "approved" ? "You approved later" : dap.status === "expired" ? "Expired later" : "You declined later";
            else s.st = "wait";
          }
          if (/denied|expired/.test(r) && !rc2) s.st = "soft";
        }
        break;
      case "list_receipts":
        s.icon = "receipt";
        s.label = "Looked over its receipts";
        s.live = "Looking over its receipts";
        break;
    }
    if (r == null && a && a.status && a.status.state === "waiting_approval" && runningToolOf(a.log || []) === e) {
      s.st = "wait";
      s.live = waitingText(a, e);
    }
    // The waiting mark means "waiting on you now": once the run is over, the words are enough.
    if (s.st === "wait" && !(a && a.busy)) s.st = "soft";
    return s;
  }
  function fetchStep(s, args, r, e) {
    var url = str(args.url);
    var method = (str(args.method) || "GET").toUpperCase();
    var where = hostPath(url);
    var svc = serviceForUrl(url);
    s.icon = "globe";
    s.label = (method === "POST" ? "Sent a request to " : "Opened ") + where;
    s.live = svc ? "Using " + svc.name : (method === "POST" ? "Sending a request to " : "Opening ") + where;
    var sb = bridgeOf(url);
    if (sb && shopStep(s, sb, r, e)) return;
    var qq = qcOf(url);
    if (qq && qcStep(s, qq, r, e)) return;
    var cq = cuOf(url);
    if (cq && cuStep(s, cq, r, e)) return;
    if (r == null) return;
    var rc = parseReceipt(r);
    if (rc && rc.prep === "to") {
      s.icon = "card";
      s.label = "Paid " + (rc.amount ? rc.amount + " " : "") + "to " + (svc ? svc.name : (serviceForParty(rc.party) || {}).name || rc.party);
      s.detail = rc.tx ? "tx " + rc.tx : "";
      return;
    }
    var b = parseBlocked(r);
    if (b) {
      s.icon = "shield";
      s.label = "Payment blocked by your wallet";
      s.detail = b.title + (b.frozen ? " · agent frozen" : "");
      s.st = "err";
      return;
    }
    var nc = r.match(/^(.{1,80}?) isn't connected yet\./);
    if (nc) {
      s.icon = "plug";
      s.label = nc[1] + " isn't connected yet";
      s.detail = "Nothing was paid";
      s.st = "soft";
      return;
    }
    var w = r.match(/^Waiting for the owner to approve (\$[\d,.]+) to (.{1,80}?)\. Approval id/);
    if (w) {
      s.icon = "clock";
      s.label = "Asked you to approve " + w[1] + " to " + ((svc && svc.name) || w[2]);
      s.st = "wait";
      return;
    }
    if (/^The owner denied/.test(r)) { s.icon = "card"; s.label = "You declined the payment"; s.st = "soft"; return; }
    if (/^Refused:/.test(r)) { s.icon = "shield"; s.label = "Refused to open " + where; s.detail = "Off-limits to agents"; s.st = "err"; return; }
    if (/^The site did not accept the payment/.test(r)) { s.icon = "card"; s.label = "Payment to " + where + " failed"; s.st = "err"; return; }
    var hm = r.match(/^HTTP (\d{3})/);
    if (hm) {
      var code = Number(hm[1]);
      if (code >= 400) { s.label = where + " returned " + code; s.st = "err"; }
      else s.detail = "HTTP " + code;
      return;
    }
    if (/Could not reach/.test(r)) { s.label = "Couldn't reach " + hostOnly(url); s.st = "err"; return; }
    if (e.isError) { s.label = "Couldn't open " + where; s.detail = firstLine(r); }
  }
  /** "Paid $110.00 · Allowance Card ••1234 · order ALW-7K2P-9QXD" for a placed order (and its receipt line, if any). */
  function paidLabel(o, rc) {
    var amt = rc && rc.amount ? rc.amount : num(o.total) != null ? money(o.total) : "";
    var ref = orderRef(o);
    return "Paid " + (amt ? amt + " · " : "") + cardLabel(o) + (ref ? " · order " + ref : "");
  }
  /**
   * Steps on the Shopify bridge (§15.1): "Searched Allbirds for “wool runners”", "Started a cart ·
   * $110.00", "Paid $110.00 · Allowance Card ••1234 · order ALW-…". Returns false when the result is
   * not an HTTP response (a block, a pending approval, a refusal), so the generic wording takes over.
   */
  function shopStep(s, b, r, e) {
    var store = svcInfo("shopify-" + b.handle).name;
    var q = b.q;
    s.icon = "bag";
    if (b.op === "products") {
      s.label = q ? "Searched " + store + " for “" + q + "”" : "Browsed " + store;
      s.live = q ? "Searching " + store + " for “" + q + "”" : "Browsing " + store;
    } else if (b.op === "product") {
      var pn = prettyId(b.item) || "a product";
      s.label = "Looked at " + pn;
      s.live = "Looking at " + pn;
    } else if (b.op === "carts") {
      s.label = "Started a cart at " + store;
      s.live = "Starting a cart at " + store;
    } else if (b.op === "checkout") {
      s.label = "Checked out at " + store;
      s.live = "Checking out at " + store;
    } else {
      s.label = "Looked up " + store;
      s.live = "Looking up " + store;
    }
    if (r == null) return true;
    var c = shopCall(e);
    if (!c) return false;
    var d = c.d;
    store = shopName(b.handle, confirmationOf(d).store || d.store);
    if (c.h.status < 200 || c.h.status >= 300) {
      var code = str(d.error);
      if (b.op === "checkout" && code === "cart_already_paid") {
        var ref = orderRef(confirmationOf(d));
        s.label = "This cart was already paid";
        s.detail = ref ? "Order " + ref : "";
        s.st = "soft";
      } else if (b.op === "checkout" && (code === "cart_not_found" || c.h.status === 404)) {
        s.label = "That cart at " + store + " expired";
        s.detail = "Nothing was paid";
        s.st = "err";
      } else {
        s.label = store + " returned " + c.h.status;
        s.detail = firstLine(str(d.message)) || code;
        s.st = "err";
      }
      return true;
    }
    if (b.op === "products") {
      var list = (Array.isArray(d.products) ? d.products : []).map(cleanProduct).filter(Boolean);
      var mins = list.map(function (p) { return p.min; }).filter(function (x) { return x != null; });
      var count = d.truncated ? list.length + "+ products" : plural(list.length, "product", "products");
      s.detail = list.length ? count + (mins.length ? " · from " + money(Math.min.apply(null, mins)) : "") : "No matches";
    } else if (b.op === "product") {
      var p = cleanProduct(d.product);
      if (p) {
        s.label = "Looked at " + p.title;
        s.detail = [priceLabel(p.min, p.max), p.variants.length > 1 ? plural(p.variants.length, "option", "options") : "", p.available ? "" : "sold out"].filter(Boolean).join(" · ");
      }
    } else if (b.op === "carts") {
      var n = linesOf(d.lines).reduce(function (t, l) { return t + l.qty; }, 0);
      s.label = "Started a cart" + (num(d.total) != null ? " · " + money(d.total) : "");
      s.detail = plural(n, "item", "items") + " · " + store;
    } else if (b.op === "checkout") {
      var o = confirmationOf(d);
      var rc = parseReceipt(c.h.tail);
      s.icon = "card";
      s.label = isPlaced(o) ? paidLabel(o, rc) : "Paid " + (rc && rc.amount ? rc.amount + " " : "") + "at " + store;
      s.detail = store + (o.simulated !== false && isPlaced(o) ? " · simulated order" : "") + (rc && rc.tx ? " · tx " + rc.tx : "");
    }
    return true;
  }

  // ================================================================ event lines and cards (derived from tool results)
  // A payment is an event: one muted line with the amount right-aligned. A blocked payment, an order
  // and research are cards. A connection request is a decision card while it waits for the owner,
  // then one line.
  function receiptLine(rc, e) {
    var args = objArgs(e);
    if (rc.verb === "Sent") return evHtml({ ic: icon("send"), text: "Sent to " + '<b class="mono">' + esc(rc.party) + "</b>", meta: [txHtml(rc.tx, rc.url)], amt: rc.amount });
    var svc = (e.name === "fetch_url" && serviceForUrl(str(args.url))) || serviceForParty(rc.party);
    return evHtml({ ic: svc ? tileHtml(svc, "t16") : icon("receipt"), text: "Paid " + strong(svc ? svc.name : rc.party), meta: [txHtml(rc.tx, rc.url)], amt: rc.amount });
  }
  function earnedLine(rc, e) {
    var site = hostOnly(objArgs(e).submit_url);
    return evHtml({ ic: icon("coins"), text: "Earned " + strong(rc.party.replace(/^Bounty:\s*/, "")), meta: [site ? esc(site) : "", txHtml(rc.tx, rc.url)], amt: "+" + (rc.amount || "—"), amtCls: "pos" });
  }
  /** Stopped by the wallet: a problem, so it gets words, and a card (the owner may want to act on it). */
  function blockedCard(b) {
    var what = b.amount ? b.amount + (b.to ? " to " + b.to : "") : "";
    return cardHtml({
      cls: "blocked",
      tile: '<span class="cd-mark err">' + icon("shieldX") + "</span>",
      title: "Blocked" + (what ? " · " + esc(what) : ""),
      meta: '<span title="' + esc(b.message || b.reason) + '">' + esc(b.title + " · nothing was " + (b.kind === "transfer" ? "sent" : "paid") + (b.frozen ? " · agent frozen" : "")) + "</span>",
    });
  }
  /** Acme Pizza's order (simulated fulfillment), with the payment that bought it in its footer. */
  function orderCard(o, e, rc) {
    var od = o.order && typeof o.order === "object" ? o.order : {};
    var svc = serviceForUrl(str(objArgs(e).url)) || svcInfo("acme-pizza");
    var tops = Array.isArray(od.toppings) ? od.toppings.map(str).filter(Boolean).slice(0, 8) : [];
    var what = [cap(str(od.size || o.size)) || "Order"].concat(tops).join(" · ");
    var total = od.total ? money(od.total) : rc && rc.amount ? rc.amount : "";
    return cardHtml({
      cls: "order",
      tile: tileHtml(svc, "t20"),
      title: "Order placed" + (total ? " · " + esc(total) : ""),
      meta: [esc(svc.name), str(o.eta) ? "ETA " + esc(str(o.eta).slice(0, 40)) : ""].filter(Boolean).join(" · "),
      body: cdLine(esc(what)) + (str(od.address) ? cdLine(esc(str(od.address).slice(0, 120))) : "") + (o.simulated ? '<p class="cd-note">' + icon("info") + "<span>Simulated fulfillment · no real pizza is on its way</span></p>" : ""),
      foot: [rc ? txHtml(rc.tx, rc.url) : "", str(o.orderId) ? 'order <span class="mono">' + esc(str(o.orderId).slice(0, 40)) + "</span>" : ""].filter(Boolean).join(" · "),
    });
  }
  /** What a store-link request (§15.4) is about, before and after the wallet discovered the store. */
  function storeRequestInfo(a, e) {
    var rq = storeRequest(e);
    var capArg = num(objArgs(e).max_price);
    var host = rq.link.host;
    var info = rq.handle
      ? svcInfo("shopify-" + rq.handle)
      : { id: "", name: host || "A Shopify store", provider: "Shopify store", glyph: "bag", color: SHOP_GREEN, shopify: { handle: "", domain: host, site: host ? siteUrl("https://" + host) : "", host: host }, permissions: [], maxPrice: "" };
    if (rq.named) info.name = rq.named;
    // Until the wallet has discovered it, the store's link is the only honest name we have.
    else if (host && !(shops[rq.handle] || {}).name && !learned[info.id] && !svcFromAgents(info.id)) info.name = host;
    // The storefront the agent linked to, until the wallet or the bridge names it.
    if (host && !myshopify(host) && info.shopify && myshopify(info.shopify.host)) {
      info.shopify = { handle: info.shopify.handle, domain: info.shopify.domain, site: siteUrl("https://" + host), host: host };
    }
    if (capArg != null && !num(info.maxPrice)) info.maxPrice = String(capArg);
    // The wallet caps a store an agent asks for at the agent's max per payment (§15.3).
    var lim = (a && a.wallet && a.wallet.limits) || {};
    if (!num(info.maxPrice) && num(lim.maxPerTx)) info.maxPrice = String(num(lim.maxPerTx));
    return info;
  }
  /**
   * The service a request_service call names (§18: a directory id, a custom proposal, or a link
   * that resolved to a store or an x402 API): { info, kind, reason }. Raw strings.
   */
  function requestInfo(a, e) {
    var args = objArgs(e);
    var custom = args.custom && typeof args.custom === "object" ? args.custom : null;
    var rq = storeRequest(e);
    var info;
    var kind = "directory";
    if (custom) {
      kind = "x402";
      info = { id: "", name: str(custom.name).slice(0, 60) || "New service", provider: "", host: hostOnly(custom.base_url), glyph: "globe", color: "#7C8799", maxPrice: str(custom.max_price).replace(/^\$/, "") };
    } else if (!rq.is) {
      info = svcInfo(str(args.service_id));
      if (info.shopify) kind = "shopify";
    } else if (rq.kind === "shopify") {
      kind = "shopify";
      info = storeRequestInfo(a, e);
    } else if (rq.kind === "directory") info = svcInfo(rq.sid, rq.named);
    else {
      // An x402 API (or not known yet): its host until the wallet names it.
      kind = "x402";
      var known = rq.sid ? svcInfo(rq.sid, rq.named) : null;
      var host = rq.host || rq.link.host;
      info = { id: rq.sid, name: rq.named || (known && known.name !== prettyId(rq.sid) ? known.name : "") || host || "a service", provider: "", host: host, glyph: "globe", color: "#7C8799", maxPrice: rq.price || (known ? known.maxPrice : "") };
    }
    return { info: info, kind: kind, custom: !!custom, reason: str(args.reason).replace(/\s+/g, " ").trim().slice(0, 400) };
  }
  /**
   * One meta line (§18): a store its storefront domain; an x402 API its host and price; a directory
   * service its provider and cap. HTML.
   */
  function requestMeta(rq) {
    var info = rq.info;
    var capv = num(info.maxPrice);
    if (rq.kind === "shopify") return info.shopify ? siteHtml(info.shopify) : esc(info.name);
    if (rq.kind === "x402") return [esc(info.host), capv != null ? "up to " + esc(money(capv)) + " per request" : ""].filter(Boolean).join(" · ");
    return [esc(info.provider), capv != null ? "up to " + esc(money(capv)) + " per request" : esc(info.pricing)].filter(Boolean).join(" · ");
  }
  function requestName(rq) {
    return rq.info.shopify && rq.info.name === rq.info.shopify.host ? domainHtml(rq.info.name) : esc(rq.info.name);
  }
  /** How a connection request ended, from the log alone: connected / declined / expired / failed / pending / "". */
  function logConnStatus(a, e) {
    if (e.result == null) return "pending";
    var r = str(e.result);
    if (/^There is no service|^Give service_id|always available; it does not need/.test(r)) return "";
    var st = connStatusFromText(r);
    if (st === "pending") {
      var id = approvalIdIn(r);
      var res = id ? resolvedBy(a, e, id) : null;
      var rr = res ? str(res.result) : "";
      var s2 = /^Owner approved/.test(rr) ? "connected" : connStatusFromText(rr);
      if (s2 && s2 !== "pending") st = s2;
      if (st === "pending" && agentHasService(a, requestedId(e))) st = "connected";
    }
    if (!st) st = e.isError || REFUSED_RE.test(r) ? "failed" : agentHasService(a, requestedId(e)) ? "connected" : "";
    return st;
  }
  /** The same, with what the owner decided in the embed since (for the step list). */
  function connStatus(a, e) {
    var st = logConnStatus(a, e);
    if (st !== "pending") return st;
    var ap = approvals[waitIdOf(a, e)];
    if (ap && ap.phase === "decided") return ap.status === "approved" ? "connected" : ap.status === "expired" ? "expired" : "declined";
    return "pending";
  }
  function connLine(a, e, st) {
    var rq = requestInfo(a, e);
    var nm = "<b>" + requestName(rq) + "</b>";
    if (st === "connected") return evHtml({ ic: tileHtml(rq.info, "t16"), text: "Connected " + nm });
    if (st === "declined") return evHtml({ ic: icon("x"), text: "You declined connecting " + nm });
    return evHtml({ ic: icon("clock"), text: "Request to connect " + nm + " expired" });
  }
  /**
   * What one tool entry adds to the thread: [{ zone: "event" | "card", key, html }] or a decision
   * ({ zone: "decide", id, e }) while it waits for the owner.
   */
  function entryItems(a, e, t) {
    var out = [];
    if (e.kind !== "tool") return out;
    var r = e.result == null ? null : str(e.result);
    var key = function (s) { return "c:" + a.name + ":" + e.id + ":" + s; };
    if (e.name === "request_service") {
      var st = logConnStatus(a, e);
      if (st === "pending") {
        var wid = waitIdOf(a, e);
        if (wid) out.push({ zone: "decide", id: wid, e: e });
      } else if (st && st !== "failed") out.push({ zone: "event", key: key("conn"), html: connLine(a, e, st) });
      // "failed": the wallet refused the link before it reached you. It stays a calm step.
      return out;
    }
    if (e.name !== "check_approval") {
      var w = waitIdOf(a, e);
      if (w) {
        // A payment waiting for the owner. The check_approval that resolves it shows the outcome.
        if (!resolvedBy(a, e, w)) out.push({ zone: "decide", id: w, e: e });
        return out;
      }
    }
    if (r == null) return out;
    var rc, b;
    // Shopify bridge responses get their own cards; a paid checkout's order card carries the receipt.
    var sc = shopCards(a, e, key, t);
    if (sc) return sc;
    // Quantcomm research cards carry their own paid line (§17.4).
    var qcs = qcCards(a, e, key);
    if (qcs) return qcs;
    // Computer use (§19): one card per session at its latest answer; its receipts fold into it.
    var cus = cuItems(a, e);
    if (cus) return cus;
    if (e.name === "fetch_url" || e.name === "check_approval") {
      rc = parseReceipt(r);
      var o = rc && rc.prep === "to" ? parseOrder(r) : null;
      if (o) out.push({ zone: "card", key: key("order"), html: orderCard(o, e, rc) });
      else if (rc && (rc.verb === "Sent" || rc.prep === "to")) out.push({ zone: "event", key: key("rcpt"), html: receiptLine(rc, e) });
      b = parseBlocked(r);
      if (b) out.push({ zone: "card", key: key("blocked"), html: blockedCard(b) });
      if (!rc && !b && e.name === "check_approval") {
        // A payment the owner declined, or that expired. Service outcomes show on the request itself.
        var pd = r.match(/^The owner denied the (\$[\d,.]+) payment to (.{1,80}?)\. /);
        var pe = r.match(/^The approval request for (\$[\d,.]+) to (.{1,80}?) expired/);
        if (pd) out.push({ zone: "event", key: key("deny"), html: evHtml({ ic: icon("x"), text: "You declined paying " + strong(pd[1] + " to " + pd[2]) }) });
        else if (pe) out.push({ zone: "event", key: key("exp"), html: evHtml({ ic: icon("clock"), text: "Approval for " + strong(pe[1] + " to " + pe[2]) + " expired" }) });
      }
    } else if (e.name === "transfer_usdc") {
      b = parseBlocked(r);
      if (b) out.push({ zone: "card", key: key("blocked"), html: blockedCard(b) });
      else if ((rc = parseReceipt(r))) out.push({ zone: "event", key: key("rcpt"), html: receiptLine(rc, e) });
      else if (/^The owner denied/.test(r)) out.push({ zone: "event", key: key("deny"), html: evHtml({ ic: icon("x"), text: "You declined sending " + strong(money(objArgs(e).amount) + " to " + shortAddr(objArgs(e).to)) }) });
    } else if (e.name === "submit_bounty") {
      rc = parseReceipt(r);
      if (rc) out.push({ zone: "event", key: key("earn"), html: earnedLine(rc, e) });
      else if (/^Work rejected/.test(r)) out.push({ zone: "event", key: key("rej"), html: evHtml({ ic: icon("x"), tone: "err", text: "Work rejected", meta: [esc(firstLine(r).replace(/^Work rejected \(not paid\):\s*/, ""))] }) });
    } else if (e.name === "claim_bounty") {
      var title = bountyTitles[str(objArgs(e).bounty_id)] || "";
      var cm = r.match(/^Claimed "(.{1,160}?)"/);
      if (cm) out.push({ zone: "event", key: key("claim"), html: evHtml({ ic: icon("hand"), text: "Claimed a slot on " + strong(cm[1]) }) });
      else if (/All slots on this bounty are taken|bounty_full/.test(r)) out.push({ zone: "event", key: key("full"), html: evHtml({ ic: icon("flag"), text: "No slots left" + (title ? " on " + strong(title) : ""), meta: ["another agent got there first"] }) });
    }
    return out;
  }

  // ================================================================ approvals (inline dashboard embed, ARCHITECTURE §13.5)
  // An approval is a decision card while the owner may still decide it, even after the agent's
  // run ended: the approval id comes from the tool result text. The dashboard's embed draws the
  // card (title, meta, reason, Approve / Deny); the chat adds only the frame, plus a head of its own
  // while the frame loads or if it can't load. Once decided it collapses to one event line.
  var APPROVAL_TTL_MS = 10 * 60 * 1000; // wallet-service expires approvals after 10 minutes (APPROVAL_TTL_MS)
  var WAIT_RE = /^Waiting for the owner|^Asked your owner to (?:add|connect)/;
  /** The approval this agent's live run is waiting on right now, if any. */
  function activeApprovalId(a) {
    if (!a) return null;
    var s = a.status || {};
    if (s.state === "waiting_approval" && validApprovalId(s.approvalId)) return s.approvalId;
    if (!a.busy) return null;
    // Between waits (fetch_url gave up after 45 s, the model is about to call check_approval):
    // keep the card while the latest finished tool says it is still waiting.
    var log = a.log || [];
    for (var i = log.length - 1; i >= 0; i--) {
      var e = log[i];
      if (e.kind === "user") break;
      if (e.kind !== "tool" || e.result == null) continue;
      var id = WAIT_RE.test(str(e.result)) ? approvalIdIn(e.result) : "";
      return validApprovalId(id) ? id : null;
    }
    return null;
  }
  /** The approval a tool entry asked for: from its result, or (still running) from the live status. */
  function waitIdOf(a, e) {
    if (!e || e.kind !== "tool" || e.name === "check_approval") return "";
    if (e.result == null) {
      var s = a.status || {};
      return a.busy && s.state === "waiting_approval" && validApprovalId(s.approvalId) && runningToolOf(a.log || []) === e ? s.approvalId : "";
    }
    var r = str(e.result);
    if (!WAIT_RE.test(r)) return "";
    var id = approvalIdIn(r);
    return validApprovalId(id) ? id : "";
  }
  /** The entry that asked for this approval: the first whose result names it, else the running one. */
  function anchorOf(a, id) {
    var log = a.log || [];
    for (var i = 0; i < log.length; i++) {
      var e = log[i];
      if (e.kind === "tool" && e.name !== "check_approval" && e.result != null && str(e.result).indexOf(id) >= 0) return e;
    }
    return (a.status || {}).approvalId === id ? runningToolOf(log) : null;
  }
  /** The later check_approval that settled this approval (approved, paid, denied, expired), if any. */
  function resolvedBy(a, anchor, id) {
    var log = a.log || [];
    for (var i = log.indexOf(anchor) + 1; i > 0 && i < log.length; i++) {
      var x = log[i];
      if (x.kind === "tool" && x.name === "check_approval" && x.result != null && !WAIT_RE.test(str(x.result)) && (str(objArgs(x).approval_id).trim() === id || str(x.result).indexOf(id) >= 0)) return x;
    }
    return null;
  }
  /** Approvals the log never saw settled: [{ id, e }] in log order. */
  function openApprovals(a) {
    var out = [];
    var seen = {};
    (a.log || []).forEach(function (e) {
      var id = waitIdOf(a, e);
      if (!id || seen[id]) return;
      seen[id] = 1;
      if (resolvedBy(a, e, id)) return;
      if (e.name === "request_service" && agentHasService(a, requestedId(e))) return;
      out.push({ id: id, e: e });
    });
    return out;
  }
  /** Only the latest few undecided approvals load the embed; older ones are a line. */
  function embedSet(a) {
    var s = {};
    openApprovals(a).slice(-3).forEach(function (o) { s[o.id] = 1; });
    return s;
  }
  /** The agent may be waiting on the owner: a live wait, or a young approval nobody decided yet. */
  function waitingOnYou(a) {
    if (activeApprovalId(a)) return true;
    return openApprovals(a).some(function (o) {
      var ap = approvals[o.id];
      return !(ap && ap.phase === "decided") && Date.now() - ts(o.e.at) < APPROVAL_TTL_MS;
    });
  }
  /** What the approval is for, as the chat knows it (the head while the frame loads, and the event lines). Raw strings except meta. */
  function describeApproval(a, ap, e) {
    var s = a.status || {};
    var args = objArgs(e);
    ap.reason = "";
    ap.flag = "";
    ap.meta = "";
    if (e && e.name === "request_service") {
      var rq = requestInfo(a, e);
      ap.kind = "service";
      ap.verb = "connect";
      ap.obj = rq.info.name;
      ap.info = rq.info;
      ap.meta = requestMeta(rq);
      ap.reason = rq.reason;
      ap.flag = rq.custom ? "Not in the directory: the agent wrote this service itself." : rq.kind === "x402" ? "Not in the directory: an API the agent found." : "";
    } else if (e && e.name === "transfer_usdc") {
      ap.kind = "transfer";
      ap.verb = "send";
      ap.obj = money(args.amount) + " to " + shortAddr(args.to);
      ap.info = { glyph: "send" };
      ap.meta = "Transfer from " + esc(a.name) + "'s wallet";
    } else if (e && e.name === "fetch_url") {
      var w = e.result != null ? str(e.result).match(/approve (\$[\d,.]+) to (.{1,60}?)\. Approval id/) : null;
      var svc = serviceForUrl(str(args.url));
      var due = w ? w[1] : checkoutTotal(a, str(args.url));
      ap.kind = "payment";
      ap.verb = "pay";
      ap.obj = (due ? due + " to " : "") + (svc ? svc.name : w ? w[2] : hostOnly(args.url));
      ap.info = svc || { glyph: "card" };
      ap.meta = svc && svc.shopify ? "Shopify checkout · " + siteHtml(svc.shopify) : svc && svc.provider ? esc(svc.provider) : esc(hostOnly(args.url));
    } else {
      var service = s.approvalId === ap.id && s.approvalKind === "service";
      ap.kind = service ? "service" : "payment";
      ap.verb = service ? "connect" : "pay";
      ap.obj = service ? "a service" : "a payment";
      ap.info = { glyph: service ? "plug" : "card" };
    }
  }
  function ensureApproval(a, id, anchor) {
    var ap = approvals[id];
    if (!ap) ap = approvals[id] = { id: id, agent: a.name, phase: DASH ? "loading" : "failed", height: 0, status: "", gotSize: false, decidedAt: 0 };
    anchor = anchor || anchorOf(a, id);
    // Described once, so the frame's markup (and the iframe in it) never changes under the owner.
    if (anchor && ap.anchor !== anchor.id) {
      ap.anchor = anchor.id;
      ap.at = ts(anchor.at);
      describeApproval(a, ap, anchor);
    } else if (!ap.verb) describeApproval(a, ap, null);
    return ap;
  }
  function approvalTitle(ap) {
    return cap(ap.verb) + " " + ap.obj + "?";
  }
  /** Past the wallet's 10 minutes: it can't still be pending, so it shows as a line while the frame checks. */
  function approvalStale(ap) {
    return !!ap.at && Date.now() - ap.at > APPROVAL_TTL_MS + 30000 && activeApprovalId(state.agents[ap.agent]) !== ap.id;
  }
  function staleLine(ap) {
    var nm = strong(ap.obj);
    return ap.kind === "service"
      ? { ic: tileHtml(ap.info, "t16"), text: "Asked to connect " + nm, meta: ["not connected"] }
      : { ic: icon("clock"), text: "Asked you to approve " + (ap.verb === "send" ? "sending " : "paying ") + nm, meta: ["not paid"] };
  }
  function decidedLine(ap) {
    var nm = strong(ap.obj);
    var t = ago(ap.decidedAt);
    var svc = ap.kind === "service";
    if (ap.status === "approved") return evHtml({ ic: svc ? tileHtml(ap.info, "t16") : icon("check"), text: svc ? "Connected " + nm : "You approved " + (ap.verb === "send" ? "sending " : "paying ") + nm, meta: [svc ? "you" : "", t] });
    if (ap.status === "expired") return evHtml({ ic: icon("clock"), text: svc ? "Request to connect " + nm + " expired" : "Approval for " + nm + " expired", meta: [t] });
    return evHtml({ ic: icon("x"), text: "You declined " + (svc ? "connecting " : ap.verb === "send" ? "sending " : "paying ") + nm, meta: [t] });
  }
  /** Stable markup (id, subject and theme only), so a re-render never re-creates the iframe. Phases are classes. */
  function approvalHtml(ap) {
    // theme= keeps the embed's color-scheme equal to ours, so Chrome doesn't paint an opaque backdrop.
    var src = DASH ? DASH + "/?approval=" + encodeURIComponent(ap.id) + "&embed=1&theme=" + effectiveTheme() : "";
    var open = DASH ? DASH + "/?approval=" + encodeURIComponent(ap.id) : "";
    return (
      '<div class="approval" data-approval="' + esc(ap.id) + '">' +
      '<div class="ap-wait"><div class="ap-head">' + tileHtml(ap.info, "t20") + '<div class="ap-ht"><div class="ap-title">' + esc(approvalTitle(ap)) + "</div>" + (ap.meta ? '<div class="ap-meta">' + ap.meta + "</div>" : "") + "</div></div>" +
      '<div class="ap-skel"><span></span><span></span></div>' +
      '<div class="ap-fallback">' +
      (ap.flag ? '<p class="ap-flag">' + icon("warn") + "<span>" + esc(ap.flag) + "</span></p>" : "") +
      (ap.reason ? '<button type="button" class="ap-reason" data-action="ap-reason" title="Show all">“' + esc(ap.reason) + "”</button>" : "") +
      '<div class="ap-fb"><span>Approve on your phone or the dashboard.</span>' + (open ? '<a class="btn-2" href="' + esc(open) + '" target="_blank" rel="noopener">Open dashboard' + icon("external") + "</a>" : "") + "</div>" +
      "</div></div>" +
      (src ? '<iframe class="ap-frame" title="' + esc(approvalTitle(ap)) + '" src="' + esc(src) + '" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"></iframe>' : "") +
      '<div class="ap-stale">' + evHtml(staleLine(ap)) + "</div>" +
      "</div>"
    );
  }
  /** The decision card (stable while undecided), or one event line once decided. */
  function decisionItem(a, d, opts) {
    var ap = ensureApproval(a, d.id, d.e);
    var scope = opts.scope || "";
    if (ap.phase === "decided") return { key: scope + "apd:" + ap.id, kind: "event", html: decidedLine(ap) };
    if (activeApprovalId(a) !== ap.id && opts.embed && !opts.embed[ap.id]) return { key: scope + "aps:" + ap.id, kind: "event", html: evHtml(staleLine(ap)) };
    return { key: "ap:" + ap.id, kind: "decision", stable: true, html: '<div class="it them k-decision">' + approvalHtml(ap) + "</div>" };
  }
  function applyApprovals() {
    document.querySelectorAll(".approval[data-approval]").forEach(function (el) {
      var ap = approvals[el.getAttribute("data-approval")];
      if (!ap || ap.phase === "decided") return;
      var f = el.querySelector("iframe");
      if (f && !f.__wired) {
        // A new frame (first render, or the theme changed): it has to tell us its size again.
        f.__wired = true;
        ap.phase = "loading";
        ap.gotSize = false;
        var t0 = Date.now();
        var check = function () {
          if (ap.phase !== "loading" || !f.isConnected) return;
          // No word from the dashboard in 3 s: it isn't running. A slow approval gets 12 s.
          if ((!ap.gotSize && Date.now() - t0 >= EMBED_TIMEOUT_MS) || Date.now() - t0 >= 12000) {
            ap.phase = "failed";
            applyApprovals();
            return;
          }
          setTimeout(check, 500);
        };
        setTimeout(check, EMBED_TIMEOUT_MS);
      }
      el.classList.toggle("stale", approvalStale(ap));
      ["loading", "ready", "failed"].forEach(function (p) { el.classList.toggle("phase-" + p, ap.phase === p); });
      if (f) f.style.height = ap.phase === "ready" ? ap.height + "px" : "";
    });
  }
  window.addEventListener("message", function (ev) {
    if (!DASH_ORIGIN || ev.origin !== DASH_ORIGIN) return;
    var d = ev.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "allowance:sheet-size" || d.type === "allowance:sheet-close" || d.type === "allowance:agent-created" || d.type === "allowance:money-added") return onSheetMessage(ev, d);
    if (!validApprovalId(d.id)) return;
    var ap = approvals[d.id];
    if (!ap) return;
    var frame = document.querySelector('.approval[data-approval="' + d.id + '"] iframe');
    if (!frame || ev.source !== frame.contentWindow) return;
    var sc = frame.closest(".scroll, .mini-scroll");
    if (d.type === "allowance:approval-size") {
      var h = Number(d.height);
      if (!isFinite(h) || h <= 0) return;
      ap.gotSize = true;
      ap.height = Math.max(60, Math.min(640, Math.ceil(h)));
      if (ap.phase === "ready") applyApprovals();
      else if (ap.phase !== "decided" && h >= 110) {
        // A real card, not the embed's "Loading…" note. Wait a beat: an approval decided earlier
        // announces its status right after its first size, and then it never shows as a card.
        // Past the wallet's 10 minutes it is surely decided: give its status longer to arrive.
        clearTimeout(ap.readyT);
        ap.readyT = setTimeout(function () {
          if (ap.phase === "loading" || ap.phase === "failed") {
            ap.phase = "ready";
            applyApprovals();
          }
        }, approvalStale(ap) ? 1500 : 250);
      }
    } else if (d.type === "allowance:approval") {
      var st = str(d.status);
      if (st !== "approved" && st !== "denied" && st !== "expired") return;
      // Seen as a card first: decided just now. Found decided while loading: when is unknown.
      ap.decidedAt = ap.phase === "ready" ? Date.now() : 0;
      ap.phase = "decided";
      ap.status = st;
      clearTimeout(ap.readyT);
      schedule();
    }
    if (sc && sc.__stick) requestAnimationFrame(function () { sc.scrollTop = sc.scrollHeight; });
  });

  // ================================================================ turns → thread items
  // One turn reads like Linear's agent panel: the owner's message, "Worked for 1m 40s ▸" (every
  // step and every interim sentence inside), the lines for what happened (payments, connections),
  // the agent's final reply, then at most one card per result and the decisions waiting on you.
  function buildTurns(a) {
    var log = a.log || [];
    var turns = [];
    var cur = null;
    for (var i = 0; i < log.length; i++) {
      var e = log[i];
      if (!e || typeof e !== "object") continue;
      if (e.kind === "user") {
        cur = { id: str(e.id) || "u" + i, user: e, entries: [] };
        turns.push(cur);
        continue;
      }
      if (!cur) {
        cur = { id: "pre", user: null, entries: [] };
        turns.push(cur);
      }
      cur.entries.push(e);
    }
    turns.forEach(function (t) {
      t.start = ts(t.user ? t.user.at : t.entries.length ? t.entries[0].at : 0);
      var end = t.start;
      var lastTool = -1;
      t.error = null;
      t.entries.forEach(function (e, i) {
        var x = ts(e.at) + (e.kind === "tool" && e.ms ? e.ms : 0);
        if (x > end) end = x;
        if (e.kind === "error") t.error = e;
        if (e.kind === "tool") lastTool = i;
      });
      t.end = end;
      t.tools = t.entries.filter(function (e) { return e.kind === "tool"; });
      t.thoughts = t.entries.filter(function (e) { return e.kind === "assistant" && str(e.reasoning).trim(); });
      // An assistant sentence followed by more tool calls is narration ("I'll look for…"): it goes
      // inside "Worked for…". Only what it said after its last tool call is the reply.
      t.interim = {};
      t.finals = [];
      t.entries.forEach(function (e, i) {
        if (e.kind !== "assistant" || !str(e.text).trim()) return;
        if (i < lastTool) t.interim[e.id] = 1;
        else t.finals.push(e);
      });
    });
    return turns;
  }
  /** Model time in a turn: everything that wasn't a tool running. */
  function thinkMs(t) {
    var prev = t.start;
    var total = 0;
    t.entries.forEach(function (e) {
      var at = ts(e.at);
      if (at > prev) total += at - prev;
      var end = at + (e.kind === "tool" && e.ms ? e.ms : 0);
      if (end > prev) prev = end;
    });
    return total;
  }
  function liveLabel(a, t) {
    var s = a.status || {};
    var run = runningToolOf(t.entries);
    if (s.state === "waiting_approval") return { text: waitingText(a, run), tone: "amber" };
    if (s.state === "retrying") return { text: "Model busy, retrying" + (s.attempt ? " (attempt " + str(s.attempt) + ")" : ""), until: a.retryUntil || 0 };
    if (run) return { text: stepOf(a, run).live };
    if (s.state === "thinking") return { text: t.tools.length ? "Thinking about what it found" : "Thinking" };
    return { text: "Working" };
  }
  function errorLine(a, e) {
    var t = str(e.text);
    if (/^Stopped by owner/.test(t)) return evHtml({ ic: icon("stop"), text: "You stopped " + strong(a.name) });
    return evHtml({ ic: icon("warn"), tone: "err", text: esc(t) });
  }
  /** One muted line per step: "Searched the directory for “flood” · 1 result". Marks only for waiting or failed. */
  function stepRow(a, e, times) {
    var open = !!ui.openStep[e.id];
    var info = stepOf(a, e);
    if (times) info.label += " " + times + " times";
    var st = info.st;
    var mark = st === "run" ? '<span class="spin"></span>' : st === "err" ? icon("x") : st === "wait" ? icon("clock") : "";
    var label = st === "run" || (st === "wait" && e.result == null) ? info.live : info.label;
    var args = e.args;
    var argText = typeof args === "string" ? args : JSON.stringify(args == null ? {} : args, null, 2);
    var raw = open
      ? '<div class="step-raw"><div class="k">Input · ' + esc(e.name) + "</div><pre>" + esc(argText) + "</pre>" +
        (e.result != null ? '<div class="k">Output' + (e.isError ? " · error" : "") + "</div><pre>" + esc(e.result) + "</pre>" : "") + "</div>"
      : "";
    return (
      '<div class="step ' + st + '"><button class="step-head" data-action="step" data-id="' + esc(e.id) + '" aria-expanded="' + open + '">' +
      '<span class="step-mark">' + mark + '</span><span class="step-txt">' + esc(label) + (info.detail ? '<span class="step-detail"> · ' + esc(info.detail) + "</span>" : "") + "</span></button>" + raw + "</div>"
    );
  }
  /** Every "Thought it through" folded into one line; it opens to the model's reasoning. */
  function thoughtRow(a, t) {
    var id = "think:" + a.name + ":" + t.id;
    var open = !!ui.openStep[id];
    var ms = thinkMs(t);
    return (
      '<div class="step ok"><button class="step-head" data-action="step" data-id="' + esc(id) + '" aria-expanded="' + open + '">' +
      '<span class="step-mark"></span><span class="step-txt">' + esc(ms >= 1000 ? "Thought for " + dur(ms) : "Thought it through") + "</span></button>" +
      (open ? '<div class="step-raw"><pre>' + esc(t.thoughts.map(function (e) { return str(e.reasoning).trim(); }).join("\n\n")) + "</pre></div>" : "") + "</div>"
    );
  }
  function activityHtml(a, t, live, scope) {
    var key = scope + a.name + ":" + t.id;
    var open = !!ui.openAct[key];
    var hasBody = t.tools.length > 0 || t.thoughts.length > 0 || Object.keys(t.interim).length > 0;
    var cls = "act" + (open ? " open" : "");
    var head;
    if (live) {
      var L = liveLabel(a, t);
      cls += " live" + (L.tone ? " " + L.tone : "");
      head =
        (L.tone === "amber" ? '<span class="act-mark">' + icon("clock") + "</span>" : '<span class="spin"></span>') + '<span class="act-text">' + esc(L.text) + "…</span>" +
        (L.until ? '<span class="act-time" data-until="' + L.until + '"></span>' : '<span class="act-time" data-since="' + t.start + '"></span>');
    } else {
      var stopped = t.error && /^Stopped by owner/.test(str(t.error.text));
      var d = dur(t.end - t.start);
      head = '<span class="act-text">' + esc(t.tools.length ? (stopped ? "Stopped after " : "Worked for ") + d : "Thought for " + d) + "</span>";
    }
    if (hasBody) head += '<span class="chev">' + icon("chev") + "</span>";
    var body = "";
    if (open && hasBody) {
      var rows = [];
      if (t.thoughts.length) rows.push(thoughtRow(a, t));
      // Free polls of a computer session while it waits in line fold into one step, with a count.
      var pollOf = function (e) {
        var c = e && e.kind === "tool" ? cuOf(str(objArgs(e).url)) : null;
        return c && c.op === "status" && (str(objArgs(e).method) || "GET").toUpperCase() === "GET" ? c.id : "";
      };
      for (var i = 0; i < t.entries.length; i++) {
        var e = t.entries[i];
        if (e.kind === "assistant" && t.interim[e.id]) rows.push('<div class="step say">' + md(e.text) + "</div>");
        else if (e.kind === "tool") {
          var pid = pollOf(e);
          var j = i;
          while (pid && j + 1 < t.entries.length && pollOf(t.entries[j + 1]) === pid) j++;
          rows.push(stepRow(a, t.entries[j], j > i ? j - i + 1 : 0));
          i = j;
        }
      }
      body = '<div class="steps">' + rows.join("") + "</div>";
    }
    return '<div class="' + cls + '">' + (hasBody ? '<button class="act-head" data-action="act" data-key="' + esc(key) + '" aria-expanded="' + open + '">' + head + "</button>" : '<div class="act-head">' + head + "</div>") + body + "</div>";
  }
  function turnItems(a, t, live, opts) {
    var who = a.name;
    var scope = opts.scope || "";
    var pre = scope + who + ":";
    var head = [];
    var events = [];
    var cards = [];
    var decide = [];
    var tail = [];
    if (t.tools.length || t.thoughts.length || Object.keys(t.interim).length || live) head.push({ key: "act:" + pre + t.id, kind: "act", at: t.start + 1, html: activityHtml(a, t, live, scope) });
    var asked = {};
    t.entries.forEach(function (e) {
      if (e.kind === "tool") {
        entryItems(a, e, t).forEach(function (x) {
          if (x.zone === "decide") {
            if (!asked[x.id]) {
              asked[x.id] = 1;
              decide.push(decisionItem(a, x, opts));
            }
          } else (x.zone === "event" ? events : cards).push({ key: scope + x.key, kind: x.zone, html: x.html, stable: !!x.stable });
        });
      } else if (e.kind === "error") tail.push({ key: "e:" + pre + e.id, kind: "event", html: errorLine(a, e) });
    });
    if (live) {
      // Waiting on an approval whose request isn't in this turn (a check_approval after a restart).
      var id = activeApprovalId(a);
      if (id && !asked[id]) decide.push(decisionItem(a, { id: id, e: anchorOf(a, id) || runningToolOf(t.entries) }, opts));
    }
    var finals = t.finals.map(function (e) { return { key: "a:" + pre + e.id, kind: "reply", at: ts(e.at), text: e.text }; });
    return head.concat(events, finals, cards, decide, tail).map(function (it) {
      it.side = "them";
      it.who = who;
      return it;
    });
  }
  function agentItems(a, opts) {
    var turns = buildTurns(a);
    var o = { scope: opts.scope || "", embed: embedSet(a) };
    var items = [];
    turns.forEach(function (t, i) {
      if (t.user) items.push({ key: "u:" + o.scope + a.name + ":" + t.user.id, side: "me", kind: "user", at: ts(t.user.at), text: t.user.text });
      items = items.concat(turnItems(a, t, i === turns.length - 1 && !!a.busy, o));
    });
    return items;
  }
  /**
   * Every broadcast across all agents, one cluster per broadcast: by groupId, else identical text
   * within 2 s across agents (older logs). Cached until a log changes.
   */
  var clusterCache = { ver: -1, list: [] };
  function allBroadcasts() {
    if (clusterCache.ver === state.logVer) return clusterCache.list;
    var all = [];
    state.order.forEach(function (n) {
      var a = state.agents[n];
      (a && a.log ? a.log : []).forEach(function (e) { if (e && e.kind === "user") all.push({ agent: n, e: e, t: ts(e.at) }); });
    });
    all.sort(function (x, y) { return x.t - y.t; });
    var clusters = [];
    var byGid = {};
    all.forEach(function (u) {
      var gid = str(u.e.groupId);
      var c;
      if (gid) {
        c = byGid[gid];
        if (!c) { c = byGid[gid] = { key: "g" + gid, gid: gid, group: "", text: u.e.text, t: u.t, members: {}, n: 0 }; clusters.push(c); }
        // Forward-compatible: a server that also tags the user entry with the group's id.
        if (!c.group && typeof u.e.group === "string") c.group = u.e.group;
      } else {
        for (var i = clusters.length - 1; i >= 0; i--) {
          var k = clusters[i];
          if (u.t - k.t > 2000) break;
          if (!k.gid && k.text === u.e.text && !k.members[u.agent]) { c = k; break; }
        }
        if (!c) { c = { key: "c" + str(u.e.id), gid: "", group: "", text: u.e.text, t: u.t, members: {}, n: 0 }; clusters.push(c); }
      }
      if (!c.members[u.agent]) { c.members[u.agent] = u.e; c.n++; }
    });
    clusterCache = { ver: state.logVer, list: clusters.filter(function (c) { return c.gid || c.n >= 2; }) };
    return clusterCache.list;
  }
  /**
   * Which group a broadcast was sent to. Log entries carry only the broadcast id, so: the group the
   * server tagged, else the one this browser sent it to, else the group whose members best match the
   * recipients (Jaccard overlap; survives later membership edits).
   */
  function clusterGroup(c) {
    var id = c.group || (c.gid && sentBroadcasts[c.gid]) || "";
    if (id && groupById(id)) return [id];
    var who = Object.keys(c.members);
    var best = [];
    var bestScore = 0;
    state.groupList.forEach(function (g) {
      var both = who.filter(function (n) { return g.members.indexOf(n) >= 0; }).length;
      if (!both) return;
      var score = both / (who.length + g.members.length - both);
      if (score > bestScore + 1e-9) { best = [g.id]; bestScore = score; }
      else if (Math.abs(score - bestScore) <= 1e-9) best.push(g.id);
    });
    return best;
  }
  /** The broadcasts that belong in this group's thread. */
  function broadcastClusters(def) {
    if (!def) return [];
    return allBroadcasts().filter(function (c) {
      return clusterGroup(c).indexOf(def.id) >= 0 && def.members.some(function (n) { return c.members[n]; });
    });
  }
  /** A broadcast thread: your message once, then each agent's reply as one block (Grid shows the race). */
  function groupItems(def, names) {
    var maps = {};
    var embs = {};
    names.forEach(function (n) {
      var a = state.agents[n];
      var turns = buildTurns(a);
      var m = {};
      turns.forEach(function (t, i) { if (t.user) m[t.user.id] = { t: t, live: i === turns.length - 1 && !!a.busy }; });
      maps[n] = m;
      embs[n] = embedSet(a);
    });
    var items = [];
    broadcastClusters(def).forEach(function (c) {
      items.push({ key: "gu:" + c.key, side: "me", kind: "user", at: c.t, text: c.text });
      var got = Object.keys(c.members).filter(function (n) { return state.agents[n]; });
      items.push({ key: "gm:" + c.key, kind: "meta", html: '<div class="it me k-meta"><div class="meta bc">' + stackHtml(got, 14, 6) + "<span>Sent to " + esc(plural(got.length, "agent", "agents")) + "</span></div></div>" });
      names.forEach(function (n) {
        var u = c.members[n];
        var tm = u && maps[n][u.id];
        if (!tm) return;
        var ti = turnItems(state.agents[n], tm.t, tm.live, { scope: "g:", embed: embs[n] });
        if (!ti.length) return;
        items.push({ key: "gw:" + c.key + ":" + n, kind: "who", html: '<div class="it them k-who"><div class="who">' + avatarHtml(n, 18) + "<b>" + esc(n) + "</b></div></div>" });
        items = items.concat(ti);
      });
    });
    return items;
  }
  /** Day separators, then each item in its row. Spacing between kinds is CSS (adjacent siblings). */
  function finalize(items) {
    var list = [];
    var lastAt = 0;
    items.forEach(function (it) {
      if (it.at != null) {
        if (!lastAt || it.at - lastAt > GAP_MS) list.push({ key: "sep:" + it.key, kind: "sep", html: '<div class="sep">' + sepLabel(it.at) + "</div>" });
        if (it.at > lastAt) lastAt = it.at;
      }
      list.push(it);
    });
    return list.map(function (it) {
      if (it.kind === "sep" || it.kind === "meta" || it.kind === "who" || it.stable) return { key: it.key, html: it.html };
      var inner = it.kind === "user" ? '<div class="bub me">' + md(it.text) + "</div>" : it.kind === "reply" ? '<div class="bub them">' + md(it.text) + "</div>" : it.html;
      return { key: it.key, html: '<div class="it ' + (it.side || "them") + " k-" + it.kind + '">' + inner + "</div>" };
    });
  }

  // ================================================================ keyed DOM patching
  function makeEl(it) {
    var t = document.createElement("template");
    t.innerHTML = it.html.trim();
    var el = t.content.firstElementChild || document.createElement("div");
    el.setAttribute("data-k", it.key);
    el.__html = it.html;
    return el;
  }
  /** Reuses elements whose key and HTML are unchanged, so iframes and open <details> survive re-renders. */
  function patchList(parent, items) {
    var existing = {};
    Array.prototype.slice.call(parent.children).forEach(function (el) {
      var k = el.getAttribute("data-k");
      if (k && !existing[k]) existing[k] = el;
      else parent.removeChild(el);
    });
    var want = {};
    items.forEach(function (it) { want[it.key] = 1; });
    Object.keys(existing).forEach(function (k) {
      if (!want[k]) { parent.removeChild(existing[k]); delete existing[k]; }
    });
    var ref = parent.firstElementChild;
    items.forEach(function (it) {
      var el = existing[it.key];
      if (el && el.__html !== it.html) {
        var fresh = makeEl(it);
        parent.replaceChild(fresh, el);
        if (ref === el) ref = fresh;
        el = fresh;
      }
      if (!el) {
        parent.insertBefore(makeEl(it), ref);
      } else if (el === ref) {
        ref = el.nextElementSibling;
      } else {
        parent.insertBefore(el, ref);
      }
    });
  }
  function setHTML(el, html) {
    if (el.__html !== html) {
      el.innerHTML = html;
      el.__html = html;
    }
  }
  function nearBottom(sc) {
    return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 90;
  }

  // ================================================================ sidebar
  function lastMsg(a) {
    var log = a.log || [];
    for (var i = log.length - 1; i >= 0; i--) {
      var e = log[i];
      if (e.kind === "user") return { text: "You: " + plainPreview(e.text), at: ts(e.at) };
      if (e.kind === "assistant" && str(e.text).trim()) return { text: plainPreview(e.text), at: ts(e.at) };
      if (e.kind === "error") return { text: plainPreview(e.text), at: ts(e.at) };
    }
    var lm = a.lastMessage;
    if (lm && typeof lm === "object" && lm.text) return { text: (lm.kind === "user" ? "You: " : "") + plainPreview(lm.text), at: ts(lm.at) };
    return { text: "No messages yet", at: 0 };
  }
  function rowStatus(a) {
    var w = a.wallet || {};
    var s = a.status || {};
    if (w.frozen) return { tone: "red", badge: "red", text: "Frozen" };
    if (s.state === "waiting_approval" || waitingOnYou(a)) return { tone: "amber", badge: "amber", text: "Waiting for you" };
    if (s.state === "retrying") return { tone: "blue", badge: "green", text: "Model busy, retrying…" };
    if (a.busy || (s.state && s.state !== "idle")) {
      var turns = buildTurns(a);
      var t = turns[turns.length - 1];
      return { tone: "blue", badge: "green", text: t ? liveLabel(a, t).text + "…" : "Working…" };
    }
    return null;
  }
  function agentRowHtml(n) {
    var a = state.agents[n];
    var st = rowStatus(a);
    var lm = lastMsg(a);
    var bal = (a.wallet || {}).balance;
    var fresh = ui.fresh[n] && ui.fresh[n] > Date.now();
    // One line under the name: what it is doing when that matters (the dot carries the color), else its last message.
    return (
      '<button class="row' + (state.selected === n ? " sel" : "") + (fresh ? " fresh" : "") + '" data-select="' + esc(n) + '" data-tip="' + esc(n) + '" data-tip2="' + esc(st ? st.text : money(bal)) + '">' +
      avatarHtml(n, 0, st ? st.badge : "") +
      '<span class="r-main"><span class="r-top"><span class="r-name">' + esc(n) + "</span>" +
      '<span class="r-time">' + esc(relTime(lm.at)) + "</span></span>" +
      '<span class="r-prev' + (st ? " r-st" : "") + '">' + esc(st ? st.text : lm.text) + "</span></span></button>"
    );
  }
  function groupSummary(names) {
    var busy = 0, waiting = 0, frozen = 0, earned = 0;
    names.forEach(function (n) {
      var a = state.agents[n];
      var w = a.wallet || {};
      if (w.frozen) frozen++;
      else if ((a.status || {}).state === "waiting_approval" || waitingOnYou(a)) waiting++;
      else if (a.busy) busy++;
      earned += num(w.earnedToday) || 0;
    });
    return { busy: busy, waiting: waiting, frozen: frozen, earned: earned };
  }
  function groupStatus(names) {
    var g = groupSummary(names);
    return g.frozen ? { tone: "red", badge: "red", text: g.frozen + " frozen" } : g.waiting ? { tone: "amber", badge: "amber", text: g.waiting + " waiting for you" } : g.busy ? { tone: "blue", badge: "green", text: plural(g.busy, "agent", "agents") + " working…" } : null;
  }
  function broadcastLabel(n) {
    return "Broadcast · " + plural(n, "agent", "agents");
  }
  function groupRowHtml(def) {
    var sel = "group:" + def.id;
    var names = groupMembersOf(def);
    var st = groupStatus(names);
    var cl = broadcastClusters(def);
    var last = cl[cl.length - 1];
    var lm = last ? { text: "You: " + plainPreview(last.text), at: last.t } : { text: names.length ? names.join(", ") : "No members yet", at: 0 };
    if (last) {
      // The latest reply to this group's last broadcast, attributed to the agent who sent it.
      names.forEach(function (n) {
        var u = last.members[n];
        var log = u ? state.agents[n].log || [] : [];
        for (var j = log.indexOf(u) + 1; j > 0 && j < log.length; j++) {
          var e = log[j];
          if (e.kind === "user") break;
          var t = ts(e.at);
          if (((e.kind === "assistant" && str(e.text).trim()) || e.kind === "error") && t >= lm.at) lm = { text: n + ": " + plainPreview(e.text), at: t };
        }
      });
    }
    var attrs = names.length ? 'data-select="' + esc(sel) + '"' : 'data-action="group-edit" data-group="' + esc(def.id) + '"';
    return (
      '<button class="row grp' + (state.selected === sel ? " sel" : "") + '" ' + attrs + ' data-tip="' + esc(def.name) + '" data-tip2="' + esc(st ? st.text : broadcastLabel(names.length)) + '">' +
      groupAvatarHtml(def, 0, st ? st.badge : "", true) +
      '<span class="r-main"><span class="r-top"><span class="r-name">' + esc(def.name) + "</span>" +
      '<span class="r-time">' + esc(relTime(lm.at)) + "</span></span>" +
      '<span class="r-prev' + (st ? " r-st" : "") + '">' + esc(st ? st.text : lm.text) + "</span></span></button>"
    );
  }
  function inviteRowHtml(action, ic, title, sub) {
    return (
      '<button class="row invite" data-action="' + action + '" data-tip="' + esc(title) + '" data-tip2="' + esc(sub) + '"><span class="inv-ic">' + icon(ic) + "</span>" +
      '<span class="r-main"><span class="r-top"><span class="r-name">' + esc(title) + '</span></span><span class="r-prev">' + esc(sub) + "</span></span></button>"
    );
  }
  function renderRows() {
    var q = ui.search.trim().toLowerCase();
    var match = function (s) { return !q || str(s).toLowerCase().indexOf(q) >= 0; };
    var items = [];
    state.groupList.forEach(function (def) {
      var names = groupMembersOf(def);
      if (!q || match(def.name) || match("broadcast") || names.some(match)) items.push({ key: "row:group:" + def.id, html: groupRowHtml(def) });
    });
    if (!q && state.loaded && !state.groupList.length && state.order.length > 1) items.push({ key: "row:inv-group", html: inviteRowHtml("new-group", "megaphone", "New broadcast", "Message several agents at once") });
    if (items.length) items.unshift({ key: "row:h-groups", html: '<div class="rows-h">Broadcasts</div>' });
    var agentRows = state.order.filter(function (n) {
      var a = state.agents[n];
      return a && (match(n) || match(a.role) || match(avatarOf(n).label) || match(lastMsg(a).text));
    });
    if (items.length && agentRows.length) items.push({ key: "row:h-agents", html: '<div class="rows-h">Agents</div>' });
    agentRows.forEach(function (n) { items.push({ key: "row:" + n, html: agentRowHtml(n) }); });
    if (!state.order.length && state.loaded) items.push({ key: "row:inv-agent", html: inviteRowHtml("new-agent", "userPlus", "Create an agent", "Give it a wallet and some money") });
    else if (!items.length && q) items.push({ key: "row:nomatch", html: '<div style="padding:14px;color:var(--text-2);font-size:14px">No results for “' + esc(ui.search.trim()) + "”</div>" });
    patchList(els.rows, items);
  }

  // ================================================================ header, banners, empty states
  /**
   * The agent's Capital One allowance account (§16.5), from `wallet.bank` (the chat server copies
   * /v1/me's `bank`): { provider, account, last4 }, last4 alphanumeric, up to 8. Null without one.
   */
  function bankOf(a) {
    var b = a && a.wallet && a.wallet.bank;
    if (!b || typeof b !== "object") return null;
    var last4 = str(b.last4).replace(/[^0-9A-Za-z]/g, "").slice(-8);
    if (!last4) return null;
    return { provider: str(b.provider).replace(/\s+/g, " ").trim().slice(0, 30) || "Capital One", account: str(b.account).replace(/\s+/g, " ").trim().slice(0, 60), last4: last4 };
  }
  function bankTagHtml(a) {
    var b = bankOf(a);
    if (!b) return "";
    var tip = b.provider + " allowance account" + (b.account ? " “" + b.account + "”" : "") + " ••" + b.last4 + " (Nessie sandbox). Every payment shows on its statement.";
    return '<span class="hbank" title="' + esc(tip) + '">' + icon("bank") + '<span class="hbank-name">' + esc(b.provider) + " </span>••" + esc(b.last4) + "</span>";
  }
  /** "$20.00 · Capital One ••0015", then a status mark only when it isn't the quiet normal state. */
  function subtitleHtml(a) {
    var w = a.wallet || {};
    var s = a.status || {};
    var up = ui.balUp[a.name] && ui.balUp[a.name] > Date.now();
    var parts = [];
    if (w.balance != null) parts.push('<span class="hb' + (up ? " up" : "") + '">' + esc(money(w.balance)) + "</span>");
    var bank = bankTagHtml(a);
    if (bank) parts.push(bank);
    var st = w.frozen ? null : s.state === "waiting_approval" || waitingOnYou(a) ? ["amber", "Waiting for you"] : s.state === "retrying" ? ["blue", "Retrying"] : a.busy || (s.state && s.state !== "idle") ? ["blue", "Working"] : null;
    if (st) parts.push('<span class="hst ' + st[0] + '" title="' + esc(st[1]) + '"><i></i><span class="hst-w">' + esc(st[1]) + "</span></span>");
    return parts.join('<span class="dot-sep">·</span>');
  }
  function addMoneyBtn(name, cls) {
    if (!DASH) return "";
    return '<button class="' + (cls || "btn-2") + '" data-action="add-money" data-agent="' + esc(name) + '" title="Add money to ' + esc(name) + '">' + icon("plus") + "<span>Add money</span></button>";
  }
  function headHtml() {
    var names = selectedNames();
    var info = '<button class="icon-btn info-btn' + (ui.infoOpen ? " on" : "") + '" data-action="info" title="Details" aria-label="Details">' + icon("sidebar") + "</button>";
    if (!names.length) return '<div class="head-c"></div><div class="head-r"></div>';
    if (isGroup(state.selected)) {
      var def = groupDef(state.selected);
      var g = groupSummary(names);
      var sub = [esc(plural(names.length, "agent", "agents"))];
      if (g.frozen) sub.push('<span class="hst red"><i></i>' + g.frozen + " frozen</span>");
      if (g.waiting) sub.push('<span class="hst amber"><i></i>' + g.waiting + " waiting for you</span>");
      if (g.busy) sub.push('<span class="hst blue"><i></i>' + g.busy + " working</span>");
      if (g.earned) sub.push('<span class="pos">+' + esc(money(g.earned)) + " today</span>");
      var seg = '<div class="seg" role="tablist"><button class="' + (ui.view === "thread" ? "on" : "") + '" data-action="view" data-view="thread">' + icon("bubble") + '<span>Thread</span></button><button class="' + (ui.view === "grid" ? "on" : "") + '" data-action="view" data-view="grid">' + icon("grid") + "<span>Grid</span></button></div>";
      return (
        '<div class="head-c"><button class="head-who" data-action="info" title="Broadcast details">' + stackHtml(names, 20, 4) +
        '<span class="head-name">' + esc(def.name) + '</span><span class="head-sub">' + sub.join('<span class="dot-sep">·</span>') + "</span></button></div>" +
        '<div class="head-r">' + seg + info + "</div>"
      );
    }
    var a = state.agents[names[0]];
    return (
      '<div class="head-c"><button class="head-who" data-action="info" title="Details">' + avatarHtml(a.name, 24) +
      '<span class="head-name">' + esc(a.name) + '</span><span class="head-sub">' + subtitleHtml(a) + "</span></button></div>" +
      '<div class="head-r">' + addMoneyBtn(a.name) + info + "</div>"
    );
  }
  /** One calm line each: a small mark, what is wrong, one action. */
  function bannersHtml() {
    var out = "";
    var line = function (tone, ic, html, action) {
      return '<div class="banner"><span class="b-ic ' + tone + '">' + ic + '</span><span class="grow">' + html + "</span>" + (action || "") + "</div>";
    };
    if (CFG.llmConfigured === false) out += line("red", icon("warn"), "<b>LLM_API_KEY isn't set</b> · put an NRP token (nrp.ai/llmtoken) in .env and restart");
    if (!state.connected && state.everOpen) out += line("", '<span class="spin"></span>', "Reconnecting to the agent server…");
    var names = selectedNames();
    var frozen = names.filter(function (n) { return (state.agents[n].wallet || {}).frozen; });
    if (frozen.length) {
      var w = state.agents[frozen[0]].wallet || {};
      var who = frozen.length === 1 ? frozen[0] + " is frozen" : frozen.join(", ") + " are frozen";
      var why = frozen.length === 1 && w.frozenReason ? str(w.frozenReason) : "";
      out += line("red", icon("lock"), "<b>" + esc(who) + "</b>" + '<span class="muted"> · ' + esc(why || "it can't spend until you unfreeze it") + "</span>", DASH ? '<a href="' + esc(DASH) + '" target="_blank" rel="noopener" title="Unfreeze on the dashboard">Unfreeze' + icon("external") + "</a>" : "");
    }
    var offline = names.filter(function (n) { var w2 = state.agents[n].wallet || {}; return w2.error && !w2.frozen; });
    if (offline.length && !isGroup(state.selected)) out += line("red", icon("warn"), esc((state.agents[offline[0]].wallet || {}).error));
    return out;
  }
  function allWorkers(names) {
    return names.length > 0 && names.every(function (n) { return /^worker-\d+$/.test(n); });
  }
  function emptyHtml(names) {
    if (!names.length) {
      if (!state.loaded) return '<div class="empty"><div class="hint">Loading…</div></div>';
      return (
        '<div class="empty"><span class="empty-ic">' + icon("userPlus") + "</span><h2>No agents yet</h2>" +
        '<div class="hint">Create one in your wallet, or run <code>npm run setup</code> for the demo agents.</div>' +
        (DASH ? '<div class="empty-acts"><button class="btn-1" data-action="new-agent">' + icon("plus") + "Create an agent</button></div>" : "") + "</div>"
      );
    }
    if (isGroup(state.selected)) {
      var def = groupDef(state.selected);
      return (
        '<div class="empty">' + groupAvatarHtml(def, 40) + "<h2>" + esc(def.name) + "</h2>" +
        '<div class="members-row">' + stackHtml(names, 20, 8) + "<span>" + esc(names.join(", ")) + "</span></div>" +
        '<div class="hint">Each agent gets your message on its own and replies here.' + (allWorkers(names) ? " Grid shows them racing for the same bounty slots." : "") + "</div>" +
        '<div class="empty-acts"><button class="btn-2" data-action="group-edit" data-group="' + esc(def.id) + '">' + icon("pencil") + "Edit broadcast</button></div></div>"
      );
    }
    var a = state.agents[names[0]];
    var w = a.wallet || {};
    var lim = w.limits || {};
    var svcs = agentServices(a);
    var broke = num(w.balance) === 0;
    // A custom agent's purpose (the owner wrote it), but not the server's generic default role.
    var custom = avatarOf(a.name).label === "Agent" && a.role && !/^You are a general-purpose assistant/.test(str(a.role));
    return (
      '<div class="empty">' + avatarHtml(a.name, 40) + "<h2>" + esc(a.name) + '</h2><div class="role">' + esc(custom ? str(a.role).slice(0, 160) : kindLabel(a.name)) + "</div>" +
      (svcs.length ? '<div class="svc-row">' + svcs.map(function (s) { return '<span title="' + esc(s.name) + '">' + tileHtml(s, "t20") + "</span>"; }).join("") + "</div>" : "") +
      '<div class="hint">It does nothing until you ask' + (lim.approvalThreshold ? ". Payments over " + esc(money(lim.approvalThreshold)) + " wait for you" : "") + ".</div>" +
      (broke && DASH ? '<div class="empty-acts">' + addMoneyBtn(a.name, "btn-1") + "</div>" : "") +
      "</div>"
    );
  }
  /** Linear's issue sidebar: one property per row, label left, value right. */

  // ================================================================ details panel
  function infoHtml() {
    var names = selectedNames();
    if (!names.length) return "";
    var close = '<button class="icon-btn info-close" data-action="info" aria-label="Close">' + icon("x") + "</button>";
    var row = function (k, v, extra, cls) { return '<div class="prop' + (cls ? " " + cls : "") + '"><span class="pk">' + k + '</span><span class="pv">' + v + "</span>" + (extra || "") + "</div>"; };
    if (isGroup(state.selected)) {
      var def = groupDef(state.selected);
      var g = groupSummary(names);
      var total = names.reduce(function (s, n) { return s + (num((state.agents[n].wallet || {}).balance) || 0); }, 0);
      return (
        '<div class="info-head">' + groupAvatarHtml(def, 28) + '<div class="ih-t"><b>' + esc(def.name) + "</b><span>" + esc(broadcastLabel(names.length)) + "</span></div>" + close + "</div>" +
        '<div class="info-sec">' + row("Their balances", esc(money(total))) + (g.earned ? row("Earned today", '<span class="pos">+' + esc(money(g.earned)) + "</span>") : "") + "</div>" +
        '<div class="info-sec"><h3>Members</h3>' +
        names.map(function (n) {
          var a = state.agents[n];
          var st = rowStatus(a);
          return '<button class="member" data-select="' + esc(n) + '">' + avatarHtml(n, 24, st ? st.badge : "") + '<span class="m-name">' + esc(n) + "</span>" + (st ? '<span class="m-st">' + esc(st.text) + "</span>" : "") + '<span class="m-bal">' + esc(money((a.wallet || {}).balance)) + "</span></button>";
        }).join("") + "</div>" +
        '<p class="info-note">A broadcast can\'t spend: each agent\'s own wallet policy still applies.</p>' +
        '<div class="info-actions">' +
        '<button data-action="group-edit" data-group="' + esc(def.id) + '">' + icon("pencil") + "Edit name and members</button>" +
        (LINKS.board && allWorkers(names) ? '<a href="' + esc(safeUrl(LINKS.board)) + '" target="_blank" rel="noopener">' + icon("trophy") + "Open the bounty board</a>" : "") +
        (def.builtIn ? "" : '<button class="danger" data-action="group-delete" data-group="' + esc(def.id) + '">' + icon("trash") + "Delete broadcast</button>") +
        "</div>"
      );
    }
    var a = state.agents[names[0]];
    var w = a.wallet || {};
    var lim = w.limits || {};
    var st = rowStatus(a);
    var svcs = agentServices(a);
    var bank = bankOf(a);
    var svcRows = svcs.length
      ? svcs.map(function (s) { return '<div class="svc" title="' + esc(s.name + (s.pricing ? " · " + s.pricing : "")) + '">' + tileHtml(s, "t16") + '<span class="svc-n">' + esc(s.name) + "</span>" + (s.pricing ? '<span class="svc-p">' + esc(s.pricing.split(" · ")[0]) + "</span>" : "") + "</div>"; }).join("")
      : '<p class="info-note">None yet. It can search the directory and ask you to connect one.</p>';
    return (
      '<div class="info-head">' + avatarHtml(a.name, 28, st ? st.badge : "") + '<div class="ih-t"><b>' + esc(a.name) + "</b><span>" + esc(kindLabel(a.name)) + "</span></div>" + close + "</div>" +
      '<div class="info-sec">' +
      (st ? row("Status", '<span class="hst ' + st.tone + '"><i></i>' + esc(st.text) + "</span>") : "") +
      (w.frozen && w.frozenReason ? row("Frozen because", esc(w.frozenReason), "", "wrap") : "") +
      row("Balance", esc(money(w.balance)), addMoneyBtn(a.name, "btn-2 sm")) +
      (bank ? row("Bank", esc(bank.provider + " ••" + bank.last4) + '<span class="pv-sub">Nessie sandbox</span>', DASH ? '<button class="btn-2 sm" data-action="bank">View</button>' : "", "wrap") : "") +
      row("Spent today", esc(money(w.spentToday))) +
      (num(w.earnedToday) ? row("Earned today", '<span class="pos">+' + esc(money(w.earnedToday)) + "</span>") : "") +
      "</div>" +
      '<div class="info-sec"><h3>Limits</h3>' +
      row("Max per payment", esc(money(lim.maxPerTx))) +
      row("Daily cap", esc(money(lim.dailyCap)) + (lim.remainingToday != null ? ' <span class="muted">· ' + esc(money(lim.remainingToday)) + " left</span>" : "")) +
      row("Asks you above", esc(money(lim.approvalThreshold))) +
      "</div>" +
      '<div class="info-sec"><h3>Services' + (DASH ? '<button class="btn-2 sm" data-action="add-service" data-agent="' + esc(a.name) + '">' + icon("plus") + "Add</button>" : "") + "</h3>" + svcRows + "</div>" +
      '<details class="disclose"' + (ui.detailsOpen ? " open" : "") + ' data-disclose="1"><summary>Details' + icon("chev") + '</summary><div class="in">' +
      '<div><div class="k">Wallet address</div><div class="addr"><span>' + esc(w.address || "—") + "</span>" + (w.address ? '<button data-action="copy" data-copy="' + esc(w.address) + '">Copy</button>' : "") + "</div></div>" +
      (a.role ? '<div><div class="k">Instructions</div><div>' + esc(a.role) + "</div></div>" : "") +
      '<div><div class="k">Model</div><div class="addr"><span>' + esc(CFG.model || "?") + " @ " + esc(CFG.endpoint || "?") + "</span></div></div>" +
      (Array.isArray(a.tools) && a.tools.length ? '<div><div class="k">Tools</div><div class="addr"><span>' + esc(a.tools.join(", ")) + "</span></div></div>" : "") +
      "</div></details>" +
      '<div class="info-actions">' +
      (DASH ? '<a href="' + esc(DASH) + '" target="_blank" rel="noopener">' + icon("layout") + "Open dashboard</a>" : "") +
      '<button class="danger" data-action="reset">' + icon("trash") + "Clear conversation</button></div>"
    );
  }

  // ================================================================ composer
  function chipsFor(names) {
    var group = isGroup(state.selected);
    var c = [];
    var worker = names.length > 0 && names.every(function (n) { return /^worker-/.test(n); });
    if (worker) {
      c.push({ label: "API reliability bounty", text: "Find paid work on localhost:4021 and complete the API reliability check bounty." });
      if (!group) c.push({ label: "Release-notes bounty", text: "Find paid work on localhost:4021 and do the release-notes summary bounty." });
    } else if (group) {
      c.push({ label: "Introduce yourselves", text: "Introduce yourselves in one line each: what you do, and how much money is in your wallet." });
    } else if (names[0] === "researcher") {
      c.push({ label: "Banks under flood alerts", text: "Are any banks exposed to the coastal flooding right now? What about Capital One?" });
      c.push({ label: "Weather, headlines & ACME stock", text: "What's the weather in Paris today, the top 3 headlines, and the ACME stock price?" });
    } else if (names[0] === "shopper") {
      c.push({ label: "Order a pizza", text: "Order me a large mushroom pizza, delivered to Hackathon Hall table 7." });
    } else if (state.agents[names[0]] && avatarOf(names[0]).label === "Agent") {
      c.push({ label: "What can you do?", text: "Hi! What can you do for me, and which services do you have?" });
    }
    c.push({ label: "Balance & limits", text: "What's my balance, and what are my spending limits?" });
    if (!group) c.push({ label: "Send whole balance to 0x…dEaD", text: "Send your whole balance to " + ATTACKER + ".", danger: true });
    return c;
  }
  function conversationStarted(names) {
    if (isGroup(state.selected)) return broadcastClusters(groupDef(state.selected)).length > 0;
    return names.some(function (n) { return (state.agents[n].log || []).length > 0; });
  }
  function renderComposer() {
    var names = selectedNames();
    var group = isGroup(state.selected);
    els.composer.style.display = names.length ? "" : "none";
    if (!names.length) return;
    var started = conversationStarted(names);
    var chips = chipsFor(names);
    setHTML(
      els.ideas,
      '<span class="ideas-label">Try</span>' +
      chips.map(function (c) { return '<button class="chip' + (c.danger ? " danger" : "") + '" data-chip="' + esc(c.text) + '" title="' + esc(c.text) + '">' + (c.danger ? icon("warn") : "") + esc(c.label) + "</button>"; }).join("")
    );
    els.ideas.classList.toggle("quiet", started);
    var ph = group ? "Message " + groupDef(state.selected).name + " (" + plural(names.length, "agent", "agents") + ")" : "Message " + names[0];
    if (els.draft.placeholder !== ph) els.draft.placeholder = ph;
    var busy = names.some(function (n) { return state.agents[n].busy; });
    els.stop.hidden = !busy;
    els.send.hidden = busy && !els.draft.value.trim();
    updateSend();
  }
  function updateSend() {
    var has = !!els.draft.value.trim();
    els.send.disabled = !has;
    var busy = selectedNames().some(function (n) { return state.agents[n].busy; });
    els.send.hidden = busy && !has;
  }
  function autosize() {
    els.draft.style.height = "auto";
    els.draft.style.height = Math.min(180, els.draft.scrollHeight) + "px";
  }

  // ================================================================ grid (race view)
  function panelHeadHtml(n) {
    var a = state.agents[n];
    var w = a.wallet || {};
    var st = rowStatus(a);
    return (
      avatarHtml(n, 20, st ? st.badge : "") + '<span class="p-name">' + esc(n) + "</span>" +
      (st ? '<span class="p-st">' + esc(st.text) + "</span>" : "") +
      (num(w.earnedToday) ? '<span class="p-earn pos">+' + esc(money(w.earnedToday)) + "</span>" : "") +
      '<span class="p-bal">' + esc(money(w.balance)) + "</span>"
    );
  }
  /** Columns for n panels: 1, 2, 3, 2×2, 3×2, 3×3, then 4 wide (rows scroll past three). */
  function gridCols(n) {
    return n <= 1 ? 1 : n === 2 ? 2 : n === 3 ? 3 : n === 4 ? 2 : n <= 9 ? 3 : 4;
  }
  function renderGrid(names, force) {
    var cols = gridCols(names.length);
    var rows = Math.ceil(names.length / cols);
    if (els.grid.style.getPropertyValue("--cols") !== String(cols)) els.grid.style.setProperty("--cols", String(cols));
    els.grid.classList.toggle("many", rows > 3);
    els.grid.classList.toggle("tall", rows === 3);
    var have = {};
    Array.prototype.slice.call(els.grid.children).forEach(function (p) {
      var n = p.getAttribute("data-agent");
      if (names.indexOf(n) < 0 || have[n]) els.grid.removeChild(p);
      else have[n] = p;
    });
    names.forEach(function (n, i) {
      var p = have[n];
      if (!p) {
        p = document.createElement("div");
        p.className = "panel";
        p.setAttribute("data-agent", n);
        p.innerHTML = '<div class="panel-head"></div><div class="mini-scroll"><div class="mini"></div></div>';
        p.__new = true;
      }
      if (els.grid.children[i] !== p) els.grid.insertBefore(p, els.grid.children[i] || null);
      var a = state.agents[n];
      p.classList.toggle("frozen", !!(a.wallet || {}).frozen);
      p.classList.toggle("waiting", !!activeApprovalId(a));
      setHTML(p.firstElementChild, panelHeadHtml(n));
      var sc = p.children[1];
      if (p.__new) wireStick(sc, sc.firstElementChild);
      var items = finalize(agentItems(a, { scope: "grid:" }), {});
      if (!items.length) items = [{ key: "empty", html: '<div class="empty"><div class="hint">Idle. Waiting for instructions.</div></div>' }];
      if (force || p.__new) sc.__stick = true;
      patchList(sc.firstElementChild, items);
      if (sc.__stick && !ui.holdScroll) sc.scrollTop = sc.scrollHeight;
      p.__new = false;
    });
  }

  // ================================================================ "New" menu
  function openMenu(btn) {
    ui.menu = true;
    els.menu.hidden = false;
    var r = btn.getBoundingClientRect();
    var w = els.menu.offsetWidth;
    var railed = els.shell.classList.contains("rail") && !els.shell.classList.contains("overlay");
    var left = railed ? r.right + 8 : Math.min(r.right - w, window.innerWidth - w - 8);
    els.menu.style.left = Math.max(8, left) + "px";
    els.menu.style.top = (railed ? r.top : r.bottom + 6) + "px";
    btn.setAttribute("aria-expanded", "true");
    hideTip();
    var first = els.menu.querySelector("button");
    if (first) first.focus();
  }
  function closeMenu() {
    if (!ui.menu) return;
    ui.menu = false;
    els.menu.hidden = true;
    els.shell.querySelectorAll('[data-action="new-menu"]').forEach(function (b) { b.removeAttribute("aria-expanded"); });
  }

  // ================================================================ sheets (modal)
  // Two kinds. The broadcast editor is the chat's own (groups carry no money authority). Creating
  // an agent and adding money are owner powers: those sheets are the dashboard's own forms in an
  // iframe (ARCHITECTURE §14.3), so the chat never holds the owner key.
  function mountSheet() {
    var s = ui.sheet;
    closeMenu();
    els.sheet.className = "sheet " + (s.kind === "owner" ? "owner" : s.kind === "cu" ? "cu-sheet" : "gsheet");
    els.sheet.innerHTML = s.kind === "owner" ? ownerSheetHtml(s) : s.kind === "cu" ? cuSheetHtml(s) : groupSheetHtml(s);
    els.sheet.setAttribute("aria-label", s.kind === "owner" ? ownerTitle(s) : s.kind === "cu" ? "The agent's computer, live" : s.mode === "edit" ? "Edit broadcast" : "New broadcast");
    els.modal.hidden = false;
    els.modal.classList.remove("show");
    void els.modal.offsetWidth; // restart the entrance transition
    els.modal.classList.add("show");
    hideTip();
    if (s.kind === "group") {
      var inp = els.sheet.querySelector("#gs-name");
      inp.addEventListener("input", function () {
        s.name = inp.value;
        s.error = "";
        updateSheet();
      });
      inp.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" && !ev.isComposing) { ev.preventDefault(); saveGroupSheet(); }
      });
      setTimeout(function () { if (ui.sheet === s) inp.focus(); }, 40);
    } else {
      var x = els.sheet.querySelector('[data-action="sheet-close"]');
      if (x) setTimeout(function () { if (ui.sheet === s) x.focus(); }, 40);
    }
    updateSheet();
  }
  function closeSheet() {
    if (!ui.sheet) return;
    ui.sheet = null;
    els.modal.classList.remove("show");
    els.modal.hidden = true;
    els.sheet.innerHTML = "";
    if (els.draft && els.composer.style.display !== "none") els.draft.focus();
  }
  function updateSheet() {
    var s = ui.sheet;
    if (!s) return;
    if (s.kind === "owner") updateOwnerSheet(s);
    else if (s.kind === "group") updateGroupSheet(s);
  }

  // ---------------------------------------------------------------- broadcast editor
  function openGroupSheet(id) {
    var def = id ? groupById(id) : null;
    if (id && !def) return;
    var members = {};
    if (def) def.members.forEach(function (n) { members[n] = 1; });
    ui.sheet = {
      kind: "group",
      mode: def ? "edit" : "new",
      id: def ? def.id : "",
      builtIn: def ? def.builtIn : false,
      name: def ? def.name : "",
      emoji: def ? def.emoji : GROUP_EMOJI[0],
      color: def ? def.color : GROUP_COLORS[state.groupList.length % GROUP_COLORS.length],
      members: members,
      saving: false,
      error: "",
    };
    mountSheet();
  }
  function groupSheetHtml(s) {
    var edit = s.mode === "edit";
    return (
      '<div class="sh-head"><span class="sh-title">' + (edit ? "Edit broadcast" : "New broadcast") + "</span>" +
      '<button class="icon-btn" data-action="sheet-close" aria-label="Close">' + icon("x") + "</button></div>" +
      '<div class="sh-scroll">' +
      '<div class="gs-field"><label class="gs-label" for="gs-name">Name</label>' +
      '<input id="gs-name" class="gs-name" maxlength="40" placeholder="Research team" autocomplete="off" spellcheck="false" value="' + esc(s.name) + '"></div>' +
      '<div class="gs-sec-h"><span>Members</span><span class="gs-count"></span></div>' +
      '<div class="gs-chosen"></div>' +
      '<div class="gs-list" role="group" aria-label="Agents"></div>' +
      '<p class="gs-note">Each agent replies on its own. A broadcast can\'t spend: each agent\'s wallet policy still applies.</p>' +
      (edit
        ? s.builtIn
          ? '<p class="gs-note">Your default list: rename it or change who is in it.</p>'
          : '<button class="gs-delete" data-action="gs-delete">' + icon("trash") + "Delete broadcast</button>"
        : "") +
      "</div>" +
      '<div class="sh-foot"><span class="gs-err" role="alert"></span><button class="btn-2" data-action="sheet-close">Cancel</button><button class="btn-1" data-action="gs-save"></button></div>'
    );
  }
  function gsMemberHtml(s, n) {
    var a = state.agents[n];
    var on = !!s.members[n];
    var st = rowStatus(a);
    var w = a.wallet || {};
    return (
      '<button class="gs-m' + (on ? " on" : "") + '" data-action="gs-toggle" data-name="' + esc(n) + '" role="checkbox" aria-checked="' + on + '">' +
      '<span class="gs-check">' + icon("check") + "</span>" + avatarHtml(n, 24, st ? st.badge : "") +
      '<span class="gs-m-name">' + esc(n) + '</span><span class="gs-m-sub">' + esc(st ? st.text : kindLabel(n)) + "</span>" +
      '<span class="gs-m-bal">' + esc(w.balance != null ? money(w.balance) : "—") + "</span></button>"
    );
  }
  function groupSheetValid(s) {
    var name = s.name.trim();
    var n = state.order.filter(function (x) { return s.members[x]; }).length;
    return { ok: !!name && name.length <= 40 && n > 0, n: n };
  }
  function updateGroupSheet(s) {
    var q = function (sel) { return els.sheet.querySelector(sel); };
    var v = groupSheetValid(s);
    setHTML(q(".gs-count"), esc(v.n ? v.n + " selected" : ""));
    var chosen = state.order.filter(function (n) { return s.members[n]; });
    patchList(q(".gs-chosen"), chosen.map(function (n) {
      return { key: "c:" + n, html: '<button class="gs-c" data-action="gs-toggle" data-name="' + esc(n) + '" title="Remove ' + esc(n) + '" aria-label="Remove ' + esc(n) + '">' + avatarHtml(n, 28) + "<span>" + esc(n) + '</span><span class="x">' + icon("x") + "</span></button>" };
    }));
    q(".gs-chosen").classList.toggle("none", !chosen.length);
    var list = state.order.filter(function (n) { return state.agents[n]; });
    patchList(q(".gs-list"), list.length ? list.map(function (n) { return { key: "m:" + n, html: gsMemberHtml(s, n) }; }) : [{ key: "none", html: '<div class="gs-none">No agents yet.</div>' }]);
    setHTML(q(".gs-err"), esc(s.error));
    var save = q('[data-action="gs-save"]');
    setHTML(save, s.saving ? '<span class="spin"></span>Saving…' : s.mode === "edit" ? "Save" : "Create broadcast");
    save.disabled = !v.ok || s.saving;
  }
  function saveGroupSheet() {
    var s = ui.sheet;
    if (!s || s.kind !== "group" || s.saving) return;
    var name = s.name.trim().replace(/\s+/g, " ");
    var members = state.order.filter(function (n) { return s.members[n]; });
    if (!name) { s.error = "Give it a name."; return updateSheet(); }
    if (!members.length) { s.error = "Pick at least one agent."; return updateSheet(); }
    s.saving = true;
    s.error = "";
    updateSheet();
    var body = { name: name, members: members, emoji: s.emoji };
    var p = s.mode === "edit" ? api("PATCH", "/api/groups/" + encodeURIComponent(s.id), body) : api("POST", "/api/groups", body);
    p.then(function (r) {
      var g = cleanGroup(r && r.group);
      if (g) upsertGroup(g);
      if (ui.sheet === s) closeSheet();
      if (g) {
        if (state.selected !== "group:" + g.id) select("group:" + g.id);
        toast(s.mode === "edit" ? "Saved “" + g.name + "”" : "Created “" + g.name + "” · " + plural(g.members.length, "agent", "agents"));
      }
      schedule();
    }).catch(function (e) {
      s.saving = false;
      s.error = e.message;
      if (ui.sheet === s) updateSheet();
    });
  }
  function deleteGroup(id) {
    var def = groupById(id);
    if (!def || def.builtIn) return;
    if (!window.confirm("Delete the broadcast “" + def.name + "”? Your agents and their own conversations stay.")) return;
    api("DELETE", "/api/groups/" + encodeURIComponent(id)).then(function () {
      state.groupList = state.groupList.filter(function (g) { return g.id !== id; });
      if (ui.sheet && ui.sheet.kind === "group" && ui.sheet.id === id) closeSheet();
      if (state.selected === "group:" + id) {
        ui.infoOpen = false;
        state.selected = state.order[0] || null;
        lsSet(LS.sel, state.selected);
      }
      toast("Deleted “" + def.name + "”");
      schedule();
    }).catch(function (e) {
      if (ui.sheet && ui.sheet.kind === "group") { ui.sheet.error = e.message; updateSheet(); } else toast("Couldn't delete: " + e.message);
    });
  }

  // ---------------------------------------------------------------- owner sheets (dashboard embed)
  /** The dashboard's one "Add service" sheet (§18: pick from the directory, or paste any link). */
  var SHEET_ADD_SERVICE = "add-service";
  function ownerTitle(s) {
    return s.which === "add-money" ? "Add money to " + s.agent : s.which === "bank" ? "Capital One" : s.which === SHEET_ADD_SERVICE ? "Add a service for " + s.agent : "New agent";
  }
  function openOwnerSheet(which, agent) {
    if ((which === "add-money" || which === SHEET_ADD_SERVICE) && !(typeof agent === "string" && AGENT_NAME_RE.test(agent))) return;
    // §16.5: the bank sheet (checking and every allowance account) embeds like the other owner sheets.
    var q = which === "add-money" || which === SHEET_ADD_SERVICE ? "?sheet=" + which + "&agent=" + encodeURIComponent(agent) : which === "bank" ? "?sheet=bank" : "?sheet=new-agent";
    var s = {
      kind: "owner",
      which: which,
      agent: agent || "",
      // theme= keeps the embed's color-scheme equal to ours (no opaque backdrop), as for approvals.
      src: DASH ? DASH + "/" + q + "&embed=1&theme=" + effectiveTheme() : "",
      open: DASH ? DASH + "/" + q : "",
      phase: DASH ? "loading" : "failed",
      height: 0,
      gotSize: false,
    };
    ui.sheet = s;
    mountSheet();
    setTimeout(function () {
      if (ui.sheet === s && !s.gotSize) {
        s.phase = "failed";
        updateSheet();
      }
    }, EMBED_TIMEOUT_MS);
  }
  function ownerSheetHtml(s) {
    var title = ownerTitle(s);
    var why = s.which === "add-money" ? "Money comes from your wallet, so you add it on the dashboard." : s.which === "bank" ? "Your Capital One accounts open on the dashboard." : s.which === SHEET_ADD_SERVICE ? "Services are connected in your wallet, so you add them on the dashboard." : "New agents get their key in your wallet, so you create them on the dashboard.";
    return (
      '<div class="os-head"><span class="os-t">' + esc(title) + "</span>" +
      '<button class="icon-btn" data-action="sheet-close" aria-label="Close">' + icon("x") + "</button></div>" +
      '<div class="os-body">' +
      (s.src
        ? '<div class="os-skel"><span></span><span></span><span></span></div>' +
          '<iframe class="os-frame" title="' + esc(title) + '" src="' + esc(s.src) + '" sandbox="allow-scripts allow-same-origin allow-forms" allow="clipboard-write" referrerpolicy="origin"></iframe>'
        : "") +
      '<div class="os-fallback"><p>' + esc(why) + " The dashboard didn't answer here.</p>" +
      (s.open ? '<a class="btn-1" href="' + esc(s.open) + '" target="_blank" rel="noopener">Open the dashboard' + icon("external") + "</a>" : "<p>No dashboard link is configured.</p>") +
      "</div></div>"
    );
  }
  function updateOwnerSheet(s) {
    ["loading", "ready", "failed"].forEach(function (p) { els.sheet.classList.toggle("phase-" + p, s.phase === p); });
    var f = els.sheet.querySelector(".os-frame");
    if (f) f.style.height = s.phase === "ready" ? s.height + "px" : "";
  }
  /** §14.3 messages, already checked to come from the dashboard origin. */
  function onSheetMessage(ev, d) {
    var s = ui.sheet;
    if (!s || s.kind !== "owner") return;
    var f = els.sheet.querySelector(".os-frame");
    if (!f || ev.source !== f.contentWindow) return;
    if (d.type === "allowance:sheet-size") {
      var h = Number(d.height);
      if (!isFinite(h) || h <= 0) return;
      s.gotSize = true;
      s.height = Math.max(80, Math.min(2000, Math.ceil(h)));
      s.phase = "ready";
      updateSheet();
    } else if (d.type === "allowance:sheet-close") {
      closeSheet();
    } else if (d.type === "allowance:agent-created") {
      var name = str(d.name);
      closeSheet();
      if (AGENT_NAME_RE.test(name)) expectAgent(name);
    } else if (d.type === "allowance:money-added") {
      var who = str(d.name);
      var amt = num(d.amount);
      closeSheet();
      // With a bank behind the wallet (§16.5) the dollars moved from checking to the agent's account.
      var banked = AGENT_NAME_RE.test(who) && bankOf(state.agents[who]);
      toast(amt != null && amt > 0 && AGENT_NAME_RE.test(who) ? (banked ? "Moved " + money(amt) + " from Checking to " + who + "'s allowance account." : "Added " + money(amt) + " to " + who + ".") : "Money added.");
    }
  }
  /** The owner just created an agent: select it as soon as the chat server hosts it. */
  function expectAgent(name) {
    if (state.agents[name]) {
      select(name);
      toast("Say hi to " + name + ".");
      return;
    }
    ui.expect = { name: name, until: Date.now() + 30000 };
    toast("Creating " + name + "…");
    // agent.added normally arrives over SSE first; reload the list in case it was missed.
    [2000, 6000, 12000].forEach(function (ms) {
      setTimeout(function () { if (ui.expect && ui.expect.name === name && !state.agents[name]) load(); }, ms);
    });
  }
  function arrived(name) {
    if (!ui.expect || ui.expect.name !== name || !state.agents[name]) return;
    var fresh = Date.now() < ui.expect.until;
    ui.expect = null;
    if (!fresh) return;
    select(name);
    toast(name + " is ready. It does nothing until you ask.");
  }

  // ================================================================ shell + render
  var els = {};
  var lastConv = null;
  function ensureShell() {
    if (els.shell) return;
    var root = document.getElementById("app");
    var links = [
      ["Dashboard", safeUrl(LINKS.dashboard), "layout"],
      ["Bounty board", safeUrl(LINKS.board), "trophy"],
      ["Explorer", safeUrl(LINKS.explorer), "cube"],
    ].filter(function (l) { return l[1]; });
    root.innerHTML =
      '<div class="shell">' +
      '<aside class="side" aria-label="Conversations">' +
      '<div class="side-top"><button class="icon-btn" data-action="rail" title="Toggle sidebar" aria-label="Toggle sidebar">' + icon("sidebar") + "</button>" +
      '<div class="brand"><span class="logo">' + icon("shieldCheck") + "</span>Allowance <small>Agents</small></div>" +
      '<button class="icon-btn new-btn top-only" data-action="new-menu" title="New agent or broadcast" aria-label="New" aria-haspopup="menu">' + icon("compose") + "</button></div>" +
      '<button class="icon-btn rail-only rail-new" data-action="new-menu" data-tip="New" data-tip2="Agent or broadcast" aria-label="New" aria-haspopup="menu">' + icon("compose") + "</button>" +
      '<button class="icon-btn rail-search" data-action="rail-search" data-tip="Search" data-tip2="⌘K" aria-label="Search">' + icon("search") + "</button>" +
      '<label class="search">' + icon("search") + '<input id="search" type="search" placeholder="Search" autocomplete="off" spellcheck="false"></label>' +
      '<div class="rows" id="rows"></div>' +
      '<div class="side-foot"><div class="foot-row"><div class="links">' + links.map(function (l) { return '<a href="' + esc(l[1]) + '" target="_blank" rel="noopener" data-tip="' + esc(l[0]) + '" title="' + esc(l[0]) + '">' + icon(l[2]) + "<span>" + esc(l[0]) + "</span></a>"; }).join("") + "</div>" +
      '<button class="icon-btn theme-btn top-only" data-action="theme" title="Toggle dark mode" aria-label="Toggle dark mode"></button></div>' +
      // The rail hides the header's theme toggle; this one keeps it reachable.
      '<button class="icon-btn theme-btn rail-only rail-theme" data-action="theme" data-tip="Appearance" aria-label="Toggle dark mode"></button></div>' +
      "</aside>" +
      '<main class="main">' +
      '<header class="head" id="head"></header>' +
      '<div class="banners" id="banners"></div>' +
      '<div class="body" id="body"><div class="scroll" id="scroll"><div class="thread" id="thread"></div></div><div class="grid" id="grid"></div><aside class="info" id="info" aria-label="Details"></aside></div>' +
      '<footer class="composer" id="composer"><div class="composer-in"><div class="ideas" id="ideas"></div>' +
      '<div class="pillbox"><textarea id="draft" rows="1" placeholder="Message" aria-label="Message"></textarea>' +
      '<button class="send" id="send" data-action="send" title="Send (Enter)" aria-label="Send" disabled>' + icon("up", "") + "</button>" +
      '<button class="stop" id="stop" data-action="stop" title="Stop" aria-label="Stop" hidden><span class="sq"></span></button></div>' +
      '</div></footer>' +
      '<div class="toast" id="toast" role="status"></div>' +
      "</main></div>" +
      '<div class="menu" id="menu" role="menu" hidden>' +
      '<button role="menuitem" data-action="new-agent"><span class="mi-ic">' + icon("userPlus") + '</span><span class="mi-t"><b>New agent</b><small>Its own wallet, with money you give it</small></span></button>' +
      '<button role="menuitem" data-action="new-group"><span class="mi-ic bc">' + icon("megaphone") + '</span><span class="mi-t"><b>New broadcast</b><small>Message several agents at once</small></span></button></div>' +
      '<div class="modal" id="modal" hidden><div class="scrim" data-action="sheet-close"></div><div class="sheet" id="sheet" role="dialog" aria-modal="true"></div></div>' +
      '<div class="tip" id="tip"></div>';
    ["head", "banners", "body", "scroll", "thread", "grid", "info", "composer", "ideas", "draft", "send", "stop", "toast", "rows", "search", "tip", "menu", "modal", "sheet"].forEach(function (id) { els[id] = document.getElementById(id); });
    els.app = root;
    els.shell = root.firstElementChild;
    wireStick(els.scroll, els.thread);
    els.send.querySelector("svg").setAttribute("stroke-width", "2.25");
    wireInputs();
  }
  function effectiveTheme() {
    // Dark unless the owner picked light.
    return ui.theme || "dark";
  }
  function applyChrome() {
    if (ui.theme) document.documentElement.setAttribute("data-theme", ui.theme);
    else document.documentElement.removeAttribute("data-theme");
    var dark = effectiveTheme() === "dark";
    els.shell.querySelectorAll(".theme-btn").forEach(function (btn) {
      setHTML(btn, icon(dark ? "sun" : "moon"));
      if (btn.classList.contains("rail-only")) btn.setAttribute("data-tip2", dark ? "Switch to light" : "Switch to dark");
      else btn.title = dark ? "Light mode" : "Dark mode";
    });
    var rail = ui.narrow ? true : ui.rail;
    els.shell.classList.toggle("rail", rail);
    els.shell.classList.toggle("overlay", rail && ui.overlay);
    els.info.classList.toggle("open", ui.infoOpen && selectedNames().length > 0);
  }
  function renderBody() {
    var names = selectedNames();
    var group = isGroup(state.selected);
    var grid = group && ui.view === "grid";
    var conv = String(state.selected) + (grid ? ":grid" : ":thread");
    var switched = conv !== lastConv;
    lastConv = conv;
    els.body.classList.toggle("grid-on", grid);
    if (grid) {
      if (switched) patchList(els.thread, []);
      renderGrid(names, switched);
      return;
    }
    if (switched) els.grid.innerHTML = "";
    var items = !names.length ? [] : group ? finalize(groupItems(groupDef(state.selected), names), { group: true }) : finalize(agentItems(state.agents[names[0]], { scope: "" }), {});
    var empty = !items.length;
    if (empty) items = [{ key: "empty:" + conv, html: emptyHtml(names) }];
    els.thread.classList.toggle("empty-thread", empty);
    if (switched || ui.forceBottom) els.scroll.__stick = true;
    patchList(els.thread, items);
    if (els.scroll.__stick && !ui.holdScroll) els.scroll.scrollTop = els.scroll.scrollHeight;
  }
  /**
   * Stick-to-bottom: a scroller stays pinned while the user hasn't scrolled up, including when
   * content grows on its own (approval iframe resizing, cards appearing).
   */
  function wireStick(sc, content) {
    sc.__stick = true;
    sc.addEventListener("scroll", function () {
      if (Date.now() < ui.stickPausedUntil) return;
      sc.__stick = nearBottom(sc);
    }, { passive: true });
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        if (sc.__stick && Date.now() >= ui.stickPausedUntil) sc.scrollTop = sc.scrollHeight;
      }).observe(content);
    }
  }
  function render() {
    ensureShell();
    applyChrome();
    renderRows();
    setHTML(els.head, headHtml());
    setHTML(els.banners, bannersHtml());
    renderBody();
    renderComposer();
    if (ui.infoOpen) setHTML(els.info, infoHtml());
    if (ui.sheet && ui.sheet.kind === "group" && ui.sheet.mode === "edit" && !groupById(ui.sheet.id)) closeSheet(); // deleted elsewhere
    if (ui.sheet) updateSheet();
    applyApprovals();
    applyComputers();
    tickTimers();
    ui.holdScroll = false;
    ui.forceBottom = false;
  }
  var pending = false;
  /** Batch renders to one per frame. rAF is paused in hidden tabs, so a timeout backs it up. */
  function schedule() {
    if (pending) return;
    pending = true;
    var done = false;
    var run = function () {
      if (done) return;
      done = true;
      pending = false;
      render();
    };
    requestAnimationFrame(run);
    setTimeout(run, 120);
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden) schedule(); });
  function tickTimers() {
    var now = Date.now();
    document.querySelectorAll("[data-since]").forEach(function (el) {
      var t = dur(now - Number(el.getAttribute("data-since")));
      if (el.textContent !== t) el.textContent = t;
    });
    document.querySelectorAll("[data-left-until]").forEach(function (el) {
      var t = mmss((Number(el.getAttribute("data-left-until")) - now) / 1000);
      if (el.textContent !== t) el.textContent = t;
    });
    document.querySelectorAll("[data-until]").forEach(function (el) {
      var t = Math.max(0, Math.ceil((Number(el.getAttribute("data-until")) - now) / 1000)) + "s";
      if (el.textContent !== t) el.textContent = t;
    });
  }
  setInterval(tickTimers, 1000);
  setInterval(schedule, 30000); // relative times in the list

  var toastTimer = null;
  function toast(msg) {
    ensureShell();
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.classList.remove("show"); }, 5000);
  }

  // ================================================================ actions
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = {};
        try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { message: t.slice(0, 200) }; }
        if (!r.ok) {
          var err = new Error(str(j.message) || "HTTP " + r.status);
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  }
  function select(sel) {
    if (!validSel(sel)) return;
    state.selected = sel;
    lsSet(LS.sel, sel);
    ui.overlay = false;
    render();
    els.draft.focus();
  }
  function send() {
    var text = els.draft.value.trim();
    if (!text) return;
    var names = selectedNames();
    if (!names.length) return;
    var group = isGroup(state.selected);
    if (!group && state.agents[names[0]].busy) {
      toast(names[0] + " is still working. Stop it first, or wait for it to finish.");
      return;
    }
    var p = group
      ? api("POST", "/api/groups/" + encodeURIComponent(state.selected.slice(6)) + "/messages", { text: text })
      : api("POST", "/api/agents/" + encodeURIComponent(names[0]) + "/messages", { text: text });
    els.draft.value = "";
    autosize();
    updateSend();
    ui.forceBottom = true;
    schedule();
    var gidSel = group ? state.selected.slice(6) : "";
    p.then(function (r) {
      if (group && r) {
        rememberBroadcast(r.groupId, gidSel);
        schedule();
      }
      if (group && r && Array.isArray(r.runs)) {
        var busy = r.runs.filter(function (x) { return x && x.error; }).map(function (x) { return x.agent; });
        if (busy.length) toast(busy.join(", ") + (busy.length === 1 ? " was" : " were") + " busy and didn't get it.");
      }
    }).catch(function (e) {
      if (!els.draft.value) {
        els.draft.value = text;
        autosize();
        updateSend();
      }
      toast(e.status === 409 ? names[0] + " is still working on the last message." : "Couldn't send: " + e.message);
    });
  }
  function stop() {
    selectedNames().forEach(function (n) {
      if (state.agents[n].busy) api("POST", "/api/agents/" + encodeURIComponent(n) + "/stop").catch(function (e) { toast("Couldn't stop " + n + ": " + e.message); });
    });
  }
  document.addEventListener("click", function (ev) {
    var t = ev.target.closest && ev.target.closest("[data-select],[data-chip],[data-action]");
    if (ui.menu && !(ev.target.closest && ev.target.closest("#menu, [data-action='new-menu']"))) closeMenu();
    if (!t || !els.app || !els.app.contains(t)) {
      if (ui.overlay && els.shell && !ev.target.closest(".side") && !ev.target.closest(".modal, .menu")) { ui.overlay = false; schedule(); }
      return;
    }
    if (t.hasAttribute("data-select")) return select(t.getAttribute("data-select"));
    if (t.hasAttribute("data-chip")) {
      els.draft.value = t.getAttribute("data-chip");
      autosize();
      updateSend();
      els.draft.focus();
      els.draft.setSelectionRange(els.draft.value.length, els.draft.value.length);
      return;
    }
    var act = t.getAttribute("data-action");
    if (act === "send") send();
    else if (act === "stop") stop();
    else if (act === "new-menu") {
      if (ui.menu) closeMenu();
      else openMenu(t);
    } else if (act === "new-agent") {
      closeMenu();
      ui.overlay = false;
      openOwnerSheet("new-agent");
    } else if (act === "new-group") {
      closeMenu();
      ui.overlay = false;
      openGroupSheet("");
    } else if (act === "add-money") {
      openOwnerSheet("add-money", t.getAttribute("data-agent"));
    } else if (act === "cu-watch") {
      openCuSheet(t.getAttribute("data-agent"), t.getAttribute("data-cu"));
    } else if (act === "add-service") {
      openOwnerSheet(SHEET_ADD_SERVICE, t.getAttribute("data-agent"));
    } else if (act === "bank") {
      openOwnerSheet("bank");
    } else if (act === "group-edit") {
      openGroupSheet(t.getAttribute("data-group"));
    } else if (act === "group-delete") {
      deleteGroup(t.getAttribute("data-group"));
    } else if (act === "sheet-close") {
      closeSheet();
    } else if (act === "gs-toggle") {
      var gs = ui.sheet;
      if (!gs || gs.kind !== "group" || gs.saving) return;
      var who = t.getAttribute("data-name");
      if (gs.members[who]) delete gs.members[who];
      else if (state.agents[who]) gs.members[who] = 1;
      gs.error = "";
      updateSheet();
    } else if (act === "gs-save") {
      saveGroupSheet();
    } else if (act === "gs-delete") {
      if (ui.sheet && ui.sheet.kind === "group") deleteGroup(ui.sheet.id);
    }
    else if (act === "info") {
      ui.infoOpen = !ui.infoOpen;
      if (ui.infoOpen) setHTML(els.info, infoHtml());
      schedule();
    } else if (act === "rail") {
      if (ui.narrow) ui.overlay = !ui.overlay;
      else {
        ui.rail = !ui.rail;
        lsSet(LS.rail, ui.rail ? "1" : "0");
      }
      hideTip();
      schedule();
    } else if (act === "rail-search") {
      if (ui.narrow) ui.overlay = true;
      else {
        ui.rail = false;
        lsSet(LS.rail, "0");
      }
      render();
      els.search.focus();
    } else if (act === "theme") {
      ui.theme = effectiveTheme() === "dark" ? "light" : "dark";
      lsSet(LS.theme, ui.theme);
      schedule();
    } else if (act === "view") {
      ui.view = t.getAttribute("data-view") === "grid" ? "grid" : "thread";
      lsSet(LS.view, ui.view);
      schedule();
    } else if (act === "act") {
      var k = t.getAttribute("data-key");
      ui.openAct[k] = !ui.openAct[k];
      ui.holdScroll = true;
      ui.stickPausedUntil = Date.now() + 400;
      render();
    } else if (act === "sim") {
      var sk = t.getAttribute("data-key");
      ui.openSim[sk] = !ui.openSim[sk];
      ui.holdScroll = true;
      ui.stickPausedUntil = Date.now() + 400;
      render();
    } else if (act === "ap-reason") {
      // The agent's reason on a decision card the chat drew itself: clamped, open in place.
      t.classList.toggle("open");
    } else if (act === "more") {
      var qk = t.getAttribute("data-key");
      ui.openMore[qk] = !ui.openMore[qk];
      ui.holdScroll = true;
      ui.stickPausedUntil = Date.now() + 400;
      render();
    } else if (act === "step") {
      var id = t.getAttribute("data-id");
      ui.openStep[id] = !ui.openStep[id];
      ui.holdScroll = true;
      ui.stickPausedUntil = Date.now() + 400;
      render();
    } else if (act === "copy") {
      var v = t.getAttribute("data-copy");
      if (navigator.clipboard) navigator.clipboard.writeText(v).then(function () { toast("Address copied"); }, function () { toast("Couldn't copy"); });
    } else if (act === "reset") {
      var n = selectedNames()[0];
      if (!n || isGroup(state.selected)) return;
      if (!window.confirm("Clear the conversation with " + n + "? Its wallet and receipts are not affected.")) return;
      api("POST", "/api/agents/" + encodeURIComponent(n) + "/reset").catch(function (e) { toast(e.status === 409 ? n + " is busy. Stop it first." : "Couldn't clear: " + e.message); });
    }
  });
  document.addEventListener("toggle", function (ev) {
    if (ev.target && ev.target.getAttribute && ev.target.getAttribute("data-disclose")) ui.detailsOpen = ev.target.open;
  }, true);
  document.addEventListener("keydown", function (ev) {
    // Nothing focused (e.g. you clicked the thread): typing or Enter goes to the composer, so a
    // stray click never swallows a message mid-demo.
    var ae = document.activeElement;
    var nothingFocused = !ae || ae === document.body || ae === document.documentElement;
    if (nothingFocused && !ui.sheet && !ev.metaKey && !ev.ctrlKey && !ev.altKey && els.draft && els.composer.style.display !== "none") {
      if (ev.key === "Enter" && els.draft.value.trim()) {
        ev.preventDefault();
        send();
        return;
      }
      if (ev.key.length === 1) els.draft.focus();
    }
    if (ev.key === "Escape") {
      if (ui.menu) { closeMenu(); return; }
      if (ui.sheet) { closeSheet(); return; }
      if (ui.infoOpen) { ui.infoOpen = false; schedule(); }
      if (ui.overlay) { ui.overlay = false; schedule(); }
    }
    if (ui.sheet) return;
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === "k" || ev.key === "K")) {
      ev.preventDefault();
      if (ui.narrow) ui.overlay = true;
      else if (ui.rail) { ui.rail = false; lsSet(LS.rail, "0"); }
      render();
      els.search.focus();
      els.search.select();
    }
  });
  function wireInputs() {
    els.draft.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        send();
      }
    });
    els.draft.addEventListener("input", function () {
      autosize();
      updateSend();
    });
    els.search.addEventListener("input", function () {
      ui.search = els.search.value;
      renderRows();
    });
    els.search.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") {
        var first = els.rows.querySelector("[data-select]");
        if (first) select(first.getAttribute("data-select"));
      } else if (ev.key === "Escape") {
        els.search.value = "";
        ui.search = "";
        renderRows();
      }
    });
    // Tooltips for the icon-only rail.
    els.shell.addEventListener("mouseover", function (ev) {
      var t = ev.target.closest && ev.target.closest(".side [data-tip]");
      if (!t || !els.shell.classList.contains("rail") || els.shell.classList.contains("overlay")) return hideTip();
      var r = t.getBoundingClientRect();
      els.tip.innerHTML = "<b>" + esc(t.getAttribute("data-tip")) + "</b>" + (t.getAttribute("data-tip2") ? '<span class="t2">' + esc(t.getAttribute("data-tip2")) + "</span>" : "");
      els.tip.style.left = r.right + 10 + "px";
      els.tip.style.top = r.top + r.height / 2 - els.tip.offsetHeight / 2 + "px";
      els.tip.classList.add("show");
    });
    els.shell.addEventListener("mouseleave", hideTip);
  }
  function hideTip() {
    if (els.tip) els.tip.classList.remove("show");
  }
  function onResize() {
    var narrow = window.innerWidth < 900;
    if (narrow !== ui.narrow) {
      ui.narrow = narrow;
      ui.overlay = false;
      schedule();
    }
  }
  window.addEventListener("resize", onResize);

  // ================================================================ data
  function agentOf(name) {
    if (!name || typeof name !== "string") return null;
    return state.agents[name] || null;
  }
  function setStatus(a, st) {
    a.status = st && typeof st === "object" ? st : { state: "idle" };
    if (a.status.state === "retrying") a.retryUntil = Date.now() + (num(a.status.waitMs) || 0);
  }
  function upsert(s) {
    if (!s || typeof s.name !== "string") return;
    var a = state.agents[s.name] || (state.agents[s.name] = { name: s.name, log: [], status: { state: "idle" }, busy: false, wallet: {} });
    if (typeof s.role === "string") a.role = s.role;
    if (s.status) setStatus(a, s.status);
    if (typeof s.busy === "boolean") a.busy = s.busy;
    if (s.wallet && typeof s.wallet === "object") a.wallet = s.wallet;
    if (s.avatar && typeof s.avatar === "object") a.avatar = s.avatar;
    if (Array.isArray(s.services)) a.services = s.services;
    if ("lastMessage" in s) a.lastMessage = s.lastMessage;
    if (Array.isArray(s.tools)) a.tools = s.tools;
  }
  function addEntry(a, e) {
    if (!e || typeof e !== "object") return;
    state.logVer++;
    for (var i = a.log.length - 1; i >= 0 && i >= a.log.length - 50; i--) {
      if (a.log[i].id === e.id) { a.log[i] = e; learnFromEntry(e); return; }
    }
    a.log.push(e);
    if (a.log.length > 600) a.log.splice(0, a.log.length - 600);
    learnFromEntry(e);
  }
  function load() {
    return api("GET", "/api/agents")
      .then(function (r) {
        var list = Array.isArray(r.agents) ? r.agents : [];
        state.order = list.map(function (a) { return a.name; }).filter(function (n) { return typeof n === "string"; });
        setGroups(r.groupList, r.groups);
        list.forEach(upsert);
        state.logVer++;
        // Deep link wins on first load: /?agent=shopper or /?agent=group:workers. Then the
        // current/saved choice, then the first agent.
        var linked = null;
        if (!ui.deepLinkUsed) {
          ui.deepLinkUsed = true;
          try { linked = new URLSearchParams(location.search).get("agent"); } catch (e) { /* old browser */ }
        }
        if (linked && validSel(linked)) {
          state.selected = linked;
          lsSet(LS.sel, linked);
        } else if (!validSel(state.selected)) {
          var saved = lsGet(LS.sel);
          state.selected = saved && validSel(saved) ? saved : state.order[0] || null;
        }
        return Promise.all(
          state.order.map(function (n) {
            return api("GET", "/api/agents/" + encodeURIComponent(n)).then(function (d) {
              var a = state.agents[n];
              a.log = Array.isArray(d.log) ? d.log.filter(function (e) { return e && typeof e === "object"; }) : [];
              a.log.forEach(learnFromEntry);
              upsert(d);
              state.logVer++;
            }).catch(function () { /* the list still renders */ });
          }),
        );
      })
      .then(function () {
        state.loaded = true;
        render();
        if (ui.expect) arrived(ui.expect.name);
      })
      .catch(function (e) {
        state.loaded = true;
        render();
        toast("Couldn't load agents: " + e.message);
      });
  }
  function connect() {
    var es = new EventSource("/api/events");
    var dropped = false;
    var on = function (type, fn) {
      es.addEventListener(type, function (m) {
        var d;
        try { d = JSON.parse(m.data); } catch (e) { return; }
        fn(d || {});
        schedule();
      });
    };
    es.addEventListener("open", function () {
      state.connected = true;
      state.everOpen = true;
      if (dropped) { dropped = false; load(); }
      schedule();
    });
    es.addEventListener("error", function () {
      state.connected = false;
      dropped = true;
      schedule();
    });
    on("snapshot", function (d) {
      setGroups(d.groupList, d.groups);
      (Array.isArray(d.agents) ? d.agents : []).forEach(function (s) {
        if (!s || typeof s.name !== "string") return;
        var known = !!state.agents[s.name];
        upsert(s);
        if (!known && state.order.indexOf(s.name) < 0) state.order.push(s.name);
      });
      state.logVer++;
    });
    on("groups", function (d) {
      setGroups(d.groupList, d.groups);
      if (isGroup(state.selected) && !groupDef(state.selected)) {
        ui.infoOpen = false;
        state.selected = state.order[0] || null;
      }
    });
    on("agent.added", function (d) {
      var s = d.agent;
      if (!s || typeof s.name !== "string" || !AGENT_NAME_RE.test(s.name)) return;
      var known = !!state.agents[s.name];
      upsert(s);
      if (!known && state.order.indexOf(s.name) < 0) {
        state.order.push(s.name);
        state.logVer++;
        ui.fresh[s.name] = Date.now() + 4000;
        setTimeout(schedule, 4100);
        if (!ui.expect || ui.expect.name !== s.name) toast("New agent: " + s.name);
      }
      if (!state.selected) state.selected = s.name;
      // Its tool list (for the details panel); the log is empty.
      api("GET", "/api/agents/" + encodeURIComponent(s.name)).then(function (x) { upsert(x); schedule(); }).catch(function () { /* fine */ });
      arrived(s.name);
    });
    on("status", function (d) { var a = agentOf(d.agent); if (a) setStatus(a, d.status); });
    on("run.started", function (d) { var a = agentOf(d.agent); if (a) a.busy = true; });
    on("run.finished", function (d) { var a = agentOf(d.agent); if (a) { a.busy = false; setStatus(a, { state: "idle" }); } });
    on("log", function (d) { var a = agentOf(d.agent); if (a) addEntry(a, d.entry); });
    on("log.update", function (d) { var a = agentOf(d.agent); if (a) addEntry(a, d.entry); });
    on("wallet", function (d) {
      var a = agentOf(d.agent);
      if (!a || !d.wallet || typeof d.wallet !== "object") return;
      var before = num((a.wallet || {}).balance);
      var after = num(d.wallet.balance);
      if (before != null && after != null && after > before + 0.0001) {
        ui.balUp[a.name] = Date.now() + 2600;
        setTimeout(schedule, 2700);
      }
      a.wallet = d.wallet;
      if (Array.isArray(d.services)) a.services = d.services;
    });
    on("reset", function (d) {
      var a = agentOf(d.agent);
      if (!a) return;
      a.log = [];
      state.logVer++;
      Object.keys(approvals).forEach(function (k) { if (approvals[k].agent === a.name) delete approvals[k]; });
    });
    on("agent", function (d) { upsert(d.agent || d); });
  }

  ui.narrow = window.innerWidth < 900;
  render();
  load().then(connect);
})();
