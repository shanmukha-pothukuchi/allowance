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
  var LS = { sel: "allowance-chat-selected", theme: "allowance-chat-theme", rail: "allowance-chat-rail", view: "allowance-chat-group-view" };

  function lsGet(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function lsSet(k, v) {
    try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ }
  }

  // ================================================================ safe values
  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC[c]; });
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
  function md(s) {
    var lines = esc(str(s).replace(/\r/g, "").trim()).split("\n");
    return lines
      .map(function (l) {
        var b = l.match(/^\s*[-*•]\s+(.*)$/);
        if (b) return "•&nbsp;" + inlineMd(b[1]);
        var hd = l.match(/^\s*#{1,6}\s+(.*)$/);
        if (hd) return "<strong>" + inlineMd(hd[1]) + "</strong>";
        return inlineMd(l);
      })
      .join("<br>");
  }

  // ================================================================ icons (inline SVG)
  var P = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>',
    book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2.5"/><path d="M2 10h20"/><path d="M6 15h4"/>',
    briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/><path d="M2 13h20"/>',
    hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.3l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
    upload: '<path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M20 15v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    wallet: '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    receipt: '<path d="M4 2v20l3-2 2 2 3-2 3 2 2-2 3 2V2l-3 2-2-2-3 2-3-2-2 2z"/><path d="M8 9h8M8 13h6"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    shieldX: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    chev: '<path d="m9 18 6-6-6-6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    external: '<path d="M7 17 17 7M8 7h9v9"/>',
    bulb: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18M9 21V9"/>',
    trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
    cube: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    bubble: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"/>',
    warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    flag: '<path d="M4 22V4"/><path d="M4 4h13l-2 4 2 4H4"/>',
  };
  function icon(name, extra) {
    return '<svg class="i' + (extra ? " " + extra : "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || P.wrench) + "</svg>";
  }

  // ================================================================ state
  var state = { agents: {}, order: [], groups: { workers: [] }, selected: null, connected: false, loaded: false, everOpen: false };
  var ui = {
    rail: lsGet(LS.rail) === "1",
    narrow: false,
    overlay: false, // narrow screen, sidebar temporarily expanded over the thread
    theme: lsGet(LS.theme) === "dark" || lsGet(LS.theme) === "light" ? lsGet(LS.theme) : null,
    infoOpen: false,
    view: lsGet(LS.view) === "grid" ? "grid" : "thread",
    search: "",
    openAct: {},
    openStep: {},
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
  function groupMembersOf(sel) {
    var g = state.groups && state.groups[sel.slice(6)];
    return Array.isArray(g) ? g.filter(function (n) { return state.agents[n]; }) : [];
  }
  function selectedNames() {
    if (isGroup(state.selected)) return groupMembersOf(state.selected);
    return state.selected && state.agents[state.selected] ? [state.selected] : [];
  }
  function validSel(s) {
    if (isGroup(s)) return groupMembersOf(s).length > 0;
    return !!(s && state.agents[s]);
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
    return { emoji: name.slice(0, 1).toUpperCase(), color: AV_FALLBACK[hash31(name) % AV_FALLBACK.length], label: "Agent" };
  }
  function avatarOf(name) {
    var a = state.agents[name];
    var loc = localAvatar(name);
    var av = a && a.avatar;
    if (av && typeof av === "object" && av.emoji) return { emoji: glyph(av.emoji, loc.emoji), color: safeColor(av.color, loc.color), label: str(av.label) || loc.label };
    return loc;
  }
  function avatarHtml(name, size, badge) {
    var av = avatarOf(name);
    var letter = /^[\x20-\x7e]+$/.test(av.emoji);
    return (
      '<span class="av' + (size ? " s" + size : "") + (letter ? " letter" : "") + '" style="--c:' + av.color + '">' +
      (letter ? esc(av.emoji) : '<span class="em">' + esc(av.emoji) + "</span>") +
      (badge ? '<span class="badge-dot ' + badge + '"></span>' : "") +
      "</span>"
    );
  }
  function clusterHtml(names, cls, badge) {
    return '<span class="cluster' + (cls ? " " + cls : "") + '">' + names.slice(0, 4).map(function (n) { return avatarHtml(n); }).join("") + (badge ? '<span class="badge-dot ' + badge + '"></span>' : "") + "</span>";
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
    return {
      id: id,
      name: str(w.name) || l.name || base.name || str(hint) || prettyId(id) || "a service",
      icon: glyph(w.icon || l.icon || base.icon, "🧩"),
      color: safeColor(w.color, base.color || AV_FALLBACK[hash31(id) % AV_FALLBACK.length]),
      provider: str(w.provider) || l.provider || base.provider || "",
      permissions: perms.slice(0, 6),
      pricing: str(w.pricing) || l.pricing || base.pricing || "",
      baseUrl: str(w.baseUrl) || l.baseUrl || "",
      path: base.path || "",
    };
  }
  function tileHtml(info, cls) {
    var g = glyph(info && info.icon, "🧩");
    var letter = /^[\x20-\x7e]+$/.test(g);
    return '<span class="tile' + (cls ? " " + cls : "") + '" style="--c:' + safeColor(info && info.color, "#8E8E93") + (letter ? ";color:#fff;font-weight:700" : "") + '">' + esc(g) + "</span>";
  }
  function under(url, base) {
    var b = str(base).replace(/\/+$/, "");
    return !!b && (url === b || url.indexOf(b + "/") === 0 || url.indexOf(b + "?") === 0);
  }
  function serviceForUrl(url) {
    url = str(url).trim();
    if (!url) return null;
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
      var parts = rest.split(" · ");
      var pricing = parts.length > 1 ? parts.pop().trim() : "";
      out.push({ id: m[2], name: hn.name.slice(0, 80), icon: hn.icon, summary: parts.join(" · ").trim().slice(0, 240), pricing: pricing.slice(0, 80), connected: connected });
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
  function learnFromEntry(e) {
    if (!e || e.kind !== "tool" || e.result == null) return;
    var r = str(e.result);
    if (e.name === "list_services" || e.name === "search_services") parseServiceLines(r).forEach(mergeLearned);
    else if (e.name === "get_service") mergeLearned(parseServiceDoc(r));
    else if (e.name === "find_work") {
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
    if (/^Waiting for the owner to approve connecting/.test(r)) return "pending";
    if (/denied connecting|^The owner denied/.test(r)) return "declined";
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
  function serviceNameOfRequest(e) {
    var a = objArgs(e);
    if (a.custom && typeof a.custom === "object") return str(a.custom.name).slice(0, 60) || "a new service";
    return svcInfo(str(a.service_id)).name;
  }
  function waitingText(a, e) {
    var args = objArgs(e);
    if (!e) return "Waiting for your approval";
    if (e.name === "request_service") return "Waiting for you to connect " + serviceNameOfRequest(e);
    if (e.name === "fetch_url") {
      var svc = serviceForUrl(str(args.url));
      return "Waiting for your OK to pay " + (svc ? svc.name : hostOnly(args.url));
    }
    if (e.name === "transfer_usdc") return "Waiting for your OK to send " + money(args.amount);
    var ap = approvals[str(args.approval_id).trim()] || approvals[str(((a && a.status) || {}).approvalId)];
    if (ap && ap.subject) return ap.kind === "service" ? "Waiting for you to " + ap.subject.replace(/^Connect/, "connect") : "Waiting for your OK: " + ap.subject;
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
        s.icon = "plug";
        s.label = "Asked you to connect " + nm;
        s.live = "Asking you to connect " + nm;
        if (r) {
          var cs = connStatusFromText(r);
          s.detail = { connected: "Connected", pending: "Waiting for you", declined: "You declined", expired: "Request expired" }[cs] || (e.isError ? first : "");
          if (cs === "pending") s.st = "wait";
          if (cs === "declined" || cs === "expired") s.st = "err";
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
          else if (/^The owner denied/.test(r)) { s.label = "Tried to send " + amt + " to " + to; s.detail = "You declined"; s.st = "err"; }
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
          s.detail = rc2 ? rc2.verb + " " + rc2.amount + " " + rc2.prep + " " + rc2.party : /^Owner connected (.+?)\./.test(r) ? "You connected " + r.match(/^Owner connected (.+?)\./)[1] : /denied/.test(r) ? "You declined" : /expired/.test(r) ? "Expired" : /^Waiting/.test(r) ? "Still waiting for you" : first;
          if (/^Waiting/.test(r)) s.st = "wait";
          if (/denied|expired/.test(r) && !rc2) s.st = "err";
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
    if (/^The owner denied/.test(r)) { s.icon = "card"; s.label = "You declined the payment"; s.st = "err"; return; }
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

  // ================================================================ cards (rich attachments derived from tool results)
  function receiptFoot(rc, e) {
    var tx = rc.tx
      ? rc.url
        ? '<a href="' + esc(rc.url) + '" target="_blank" rel="noopener noreferrer">tx ' + esc(rc.tx) + icon("external") + "</a>"
        : '<span class="mono">tx ' + esc(rc.tx) + "</span>"
      : "<span>No tx hash yet</span>";
    return '<div class="c-foot">' + tx + "<span>" + esc(clock(ts(e.at) + (e.ms || 0))) + "</span></div>";
  }
  function receiptCard(rc, e) {
    var args = objArgs(e);
    var sent = rc.verb === "Sent";
    var svc = sent ? null : (e.name === "fetch_url" && serviceForUrl(str(args.url))) || serviceForParty(rc.party);
    var name = svc ? svc.name : rc.party;
    var tile = sent ? '<span class="tile" style="--c:#8E8E93;color:#fff">' + icon("send") + "</span>" : tileHtml(svc || { icon: "🧾", color: "#8E8E93" });
    var n = num(rc.amount);
    if (!sent && n != null && n < 1) {
      // Micropayments: one compact row, so a few API calls don't fill the screen.
      return (
        '<div class="card receipt compact"><div class="card-pad"><div class="c-row">' + tile +
        '<div class="c-who"><div class="c-k">Payment to</div><div class="c-name">' + esc(name) + "</div></div>" +
        '<div class="c-amt-sm">' + esc(rc.amount) + "</div></div></div>" + receiptFoot(rc, e) + "</div>"
      );
    }
    return (
      '<div class="card receipt"><div class="card-pad"><div class="c-row">' + tile +
      '<div class="c-who"><div class="c-k">' + (sent ? "Sent to" : "Payment to") + '</div><div class="c-name">' + esc(name) + "</div></div>" +
      '<span class="pill ok">' + icon("check") + (sent ? "Sent" : "Paid") + "</span></div>" +
      '<div class="c-amt">' + esc(rc.amount || "—") + "</div></div>" + receiptFoot(rc, e) + "</div>"
    );
  }
  function earnedCard(rc, e) {
    var title = rc.party.replace(/^Bounty:\s*/, "");
    var site = hostOnly(objArgs(e).submit_url);
    return (
      '<div class="card earned"><div class="card-pad"><div class="c-row"><span class="tile" style="--c:#34C759">💰</span>' +
      '<div class="c-who"><div class="c-k">Earned</div><div class="c-name">' + esc(title) + "</div></div>" +
      '<span class="pill ok">' + icon("check") + "Paid out</span></div>" +
      '<div class="c-amt">+' + esc(rc.amount || "—") + "</div>" + (site ? '<div class="c-sub">Bounty on ' + esc(site) + "</div>" : "") + "</div>" + receiptFoot(rc, e) + "</div>"
    );
  }
  function blockedCard(b) {
    var what = b.amount ? esc(b.amount) + (b.to ? " <span>to " + esc(b.to) + "</span>" : "") : "";
    return (
      '<div class="card blocked"><div class="card-pad"><div class="c-row"><span class="shield">' + icon("shieldX") + "</span>" +
      '<div class="c-who"><div class="c-title">Blocked by your wallet</div><div class="c-k">' + (b.kind === "transfer" ? "Transfer stopped" : "Payment stopped") + " · nothing was sent</div></div></div>" +
      (what ? '<div class="c-what">' + what + "</div>" : "") +
      '<div class="c-reason">' + esc(b.title) + "</div>" + (b.message ? '<div class="c-msg">' + esc(b.message) + "</div>" : "") + "</div>" +
      (b.frozen ? '<div class="c-foot"><span class="pill red">' + icon("lock") + "Agent frozen</span><span>Owner notified</span></div>" : '<div class="c-foot"><span>Policy: ' + esc(b.reason) + "</span><span>Owner notified</span></div>") +
      "</div>"
    );
  }
  function orderCard(o, e) {
    var od = o.order && typeof o.order === "object" ? o.order : {};
    var svc = serviceForUrl(str(objArgs(e).url)) || svcInfo("acme-pizza");
    var tops = Array.isArray(od.toppings) ? od.toppings.map(str).filter(Boolean).slice(0, 8) : [];
    var what = [cap(str(od.size || o.size)) || "Order"].concat(tops).join(" · ");
    var rows = [["Order", what], ["Deliver to", str(od.address)], ["ETA", str(o.eta)], ["Total", od.total ? money(od.total) : ""], ["Order id", str(o.orderId)]];
    return (
      '<div class="card order"><div class="card-pad"><div class="c-row">' + tileHtml(svc, "t48") +
      '<div class="c-who"><div class="c-title">Order placed</div><div class="c-k">' + esc(svc.name) + "</div></div>" +
      '<span class="pill ok">' + esc(cap(str(o.status) || "placed")) + "</span></div>" +
      '<dl class="c-lines">' + rows.filter(function (x) { return x[1]; }).map(function (x) { return "<dt>" + x[0] + "</dt><dd>" + esc(x[1]) + "</dd>"; }).join("") + "</dl></div>" +
      (o.simulated ? '<div class="c-foot"><span class="sim">' + icon("info") + "Simulated fulfillment · no real pizza is on its way</span></div>" : "") +
      "</div>"
    );
  }
  function connStatus(a, e) {
    var args = objArgs(e);
    var id = str(args.service_id);
    if (e.result == null) {
      var ap = approvalForAnchor(a, e.id);
      if (ap && ap.phase === "decided") return ap.status === "approved" ? "connected" : ap.status === "expired" ? "expired" : "declined";
      return "pending";
    }
    var r = str(e.result);
    var st = connStatusFromText(r);
    if (st === "pending") {
      var apr = approvalIdIn(r);
      var log = a.log || [];
      var idx = log.indexOf(e);
      for (var i = idx + 1; i < log.length; i++) {
        var x = log[i];
        if (x.kind === "tool" && x.name === "check_approval" && x.result != null && (!apr || str(objArgs(x).approval_id).trim() === apr)) {
          var s2 = connStatusFromText(x.result);
          if (s2 && s2 !== "pending") st = s2;
        }
      }
      if (st === "pending" && apr && approvals[apr] && approvals[apr].phase === "decided") st = approvals[apr].status === "approved" ? "connected" : approvals[apr].status === "expired" ? "expired" : "declined";
      if (st === "pending" && agentHasService(a, id)) st = "connected";
    }
    if (!st) st = e.isError ? "failed" : agentHasService(a, id) ? "connected" : "pending";
    return st;
  }
  function connCard(a, e) {
    var args = objArgs(e);
    var custom = args.custom && typeof args.custom === "object" ? args.custom : null;
    var info = custom
      ? { name: str(custom.name).slice(0, 60) || "New service", provider: "Proposed by " + a.name + " · " + hostOnly(custom.base_url), icon: "🧩", color: "#7C8799", permissions: ["Pay up to " + money(custom.max_price) + " per request under " + hostPath(custom.base_url)] }
      : svcInfo(str(args.service_id));
    var st = connStatus(a, e);
    var badge = { connected: ["ok", "check", "Connected"], pending: ["wait", "clock", "Pending"], declined: ["err", "x", "Declined"], expired: ["err", "clock", "Expired"], failed: ["err", "x", "Not sent"] }[st];
    var reason = str(args.reason).trim().slice(0, 240);
    var perms = info.permissions || [];
    return (
      '<div class="card conn ' + st + '"><div class="card-pad">' +
      '<div class="c-label">' + icon("plug") + "Connection request</div>" +
      '<div class="c-row">' + tileHtml(info, "t48") + '<div class="c-who"><div class="c-name">' + esc(info.name) + "</div>" + (info.provider ? '<div class="c-k">' + esc(custom ? info.provider : "by " + info.provider) + "</div>" : "") + "</div>" +
      '<span class="pill ' + badge[0] + '">' + icon(badge[1]) + badge[2] + "</span></div>" +
      (perms.length ? '<div class="c-asks">' + esc(a.name) + " will be able to</div>" + '<ul class="c-perms">' + perms.map(function (p) { return "<li>" + icon("check") + "<span>" + esc(p) + "</span></li>"; }).join("") + "</ul>" : "") +
      (reason ? '<div class="c-reason">“' + esc(reason) + "”</div>" : "") +
      (custom ? '<div class="c-flag">Not in the directory · proposed by the agent</div>' : "") +
      "</div></div>"
    );
  }
  function cardsFor(a, e) {
    var out = [];
    if (e.kind !== "tool") return out;
    var r = e.result == null ? null : str(e.result);
    var key = function (s) { return "c:" + a.name + ":" + e.id + ":" + s; };
    if (e.name === "request_service") {
      if (r == null || !/^There is no service|^Give service_id|always available; it does not need/.test(r)) out.push({ key: key("conn"), html: connCard(a, e) });
      return out;
    }
    if (r == null) return out;
    var rc, b;
    if (e.name === "fetch_url" || e.name === "check_approval") {
      rc = parseReceipt(r);
      if (rc && rc.verb === "Sent") out.push({ key: key("rcpt"), html: receiptCard(rc, e) });
      else if (rc && rc.prep === "to") {
        out.push({ key: key("rcpt"), html: receiptCard(rc, e) });
        var o = parseOrder(r);
        if (o) out.push({ key: key("order"), html: orderCard(o, e) });
      }
      b = parseBlocked(r);
      if (b) out.push({ key: key("blocked"), html: blockedCard(b) });
    } else if (e.name === "transfer_usdc") {
      b = parseBlocked(r);
      if (b) out.push({ key: key("blocked"), html: blockedCard(b) });
      else if ((rc = parseReceipt(r))) out.push({ key: key("rcpt"), html: receiptCard(rc, e) });
    } else if (e.name === "submit_bounty") {
      rc = parseReceipt(r);
      if (rc) out.push({ key: key("earn"), html: earnedCard(rc, e) });
      else if (/^Work rejected/.test(r)) out.push({ key: key("rej"), html: '<div class="chip-card warn">' + icon("x") + "<span>Work rejected · " + esc(firstLine(r).replace(/^Work rejected \(not paid\):\s*/, "")) + "</span></div>" });
    } else if (e.name === "claim_bounty") {
      var title = bountyTitles[str(objArgs(e).bounty_id)] || "";
      var cm = r.match(/^Claimed "(.{1,160}?)"/);
      if (cm) out.push({ key: key("claim"), html: '<div class="chip-card ok">' + icon("hand") + "<span>Claimed a slot · " + esc(cm[1]) + "</span></div>" });
      else if (/All slots on this bounty are taken|bounty_full/.test(r)) out.push({ key: key("full"), html: '<div class="chip-card lost">' + icon("flag") + "<span>No slots left" + (title ? " · " + esc(title) : "") + "</span></div>" });
    }
    return out;
  }

  // ================================================================ approvals (inline dashboard embed, ARCHITECTURE §13.5)
  /** The approval this agent is waiting on right now, if any. */
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
      var id = /^Waiting for the owner/.test(str(e.result)) ? approvalIdIn(e.result) : "";
      return validApprovalId(id) ? id : null;
    }
    return null;
  }
  function approvalSubject(a, anchor, kind, id) {
    var src = anchor;
    if (anchor && anchor.name === "check_approval") {
      (a.log || []).forEach(function (e) { if (e.kind === "tool" && e !== anchor && e.result != null && str(e.result).indexOf(id) >= 0 && e.name !== "check_approval") src = e; });
    }
    var args = objArgs(src);
    if (kind === "service") return "Connect " + (src && src.name === "request_service" ? serviceNameOfRequest(src) : "a service");
    if (src && src.name === "transfer_usdc") return "Send " + money(args.amount) + " to " + shortAddr(args.to);
    if (src && src.name === "fetch_url") {
      var w = str(src.result).match(/approve (\$[\d,.]+) to (.{1,60}?)\. Approval id/);
      var svc = serviceForUrl(str(args.url));
      return "Pay " + (w ? w[1] + " to " : "") + (svc ? svc.name : w ? w[2] : hostOnly(args.url));
    }
    return "Payment";
  }
  function ensureApproval(a, id) {
    if (approvals[id]) return approvals[id];
    var log = a.log || [];
    var anchor = null;
    for (var i = log.length - 1; i >= 0; i--) {
      var e = log[i];
      if (e.kind === "user") break;
      if (e.kind === "tool" && (e.result == null || str(e.result).indexOf(id) >= 0)) { anchor = e; break; }
    }
    var s = a.status || {};
    var kind = s.approvalId === id && s.approvalKind === "service" ? "service" : s.approvalId === id && s.approvalKind === "payment" ? "payment" : null;
    if (!kind) {
      if (anchor && anchor.name === "request_service") kind = "service";
      else if (anchor && anchor.name === "transfer_usdc") kind = "transfer";
      else {
        kind = "payment";
        log.forEach(function (x) { if (x.kind === "tool" && x.result != null && str(x.result).indexOf(id) >= 0 && /connecting|connect/.test(str(x.result))) kind = "service"; });
      }
    }
    approvals[id] = { id: id, agent: a.name, anchor: anchor ? anchor.id : null, kind: kind, subject: approvalSubject(a, anchor, kind, id), phase: DASH ? "loading" : "failed", height: 0, status: "", gotSize: false };
    return approvals[id];
  }
  function syncApprovals() {
    state.order.forEach(function (n) {
      var a = state.agents[n];
      var id = activeApprovalId(a);
      if (id) ensureApproval(a, id);
    });
  }
  function approvalVisible(ap) {
    return ap.phase === "decided" || activeApprovalId(state.agents[ap.agent]) === ap.id;
  }
  function approvalForAnchor(a, entryId) {
    for (var id in approvals) if (approvals[id].agent === a.name && approvals[id].anchor === entryId) return approvals[id];
    return null;
  }
  function approvalsAnchoredTo(a, entryId) {
    return Object.keys(approvals).map(function (k) { return approvals[k]; }).filter(function (ap) { return ap.agent === a.name && ap.anchor === entryId && approvalVisible(ap); });
  }
  function approvalHtml(ap) {
    if (ap.phase === "decided") {
      var d = ap.status === "approved" ? ["ok", "check", "You approved · "] : ap.status === "expired" ? ["exp", "clock", "This request expired · "] : ["err", "x", "You declined · "];
      return '<div class="it them k-approval"><div class="approval phase-decided" data-approval="' + esc(ap.id) + '"><div class="ap-body"><div class="ap-done ' + d[0] + '">' + icon(d[1]) + esc(d[2] + ap.subject) + "</div></div></div></div>";
    }
    // theme= keeps the embed's color-scheme equal to ours, so Chrome doesn't paint an opaque backdrop.
    var src = DASH ? DASH + "/?approval=" + encodeURIComponent(ap.id) + "&embed=1&theme=" + effectiveTheme() : "";
    var open = DASH ? DASH + "/?approval=" + encodeURIComponent(ap.id) : "";
    return (
      '<div class="it them k-approval"><div class="approval" data-approval="' + esc(ap.id) + '">' +
      '<div class="ap-head">' + icon("shieldCheck") + "<span>Needs your approval</span>" + '<span class="ap-sub">' + esc(ap.subject) + "</span></div>" +
      '<div class="ap-body">' +
      (src ? '<div class="ap-skel"><span></span><span></span><span></span></div><iframe class="ap-frame" title="Approve or deny" src="' + esc(src) + '" sandbox="allow-scripts allow-same-origin allow-forms" referrerpolicy="no-referrer"></iframe>' : "") +
      '<div class="ap-fallback"><div class="ap-fb-what">' + esc(ap.subject) + '</div><div class="ap-fb-text">Waiting for your approval. Approve on your phone or the dashboard.</div>' +
      (open ? '<a class="btn-pill" href="' + esc(open) + '" target="_blank" rel="noopener">' + icon("layout") + "Open dashboard</a>" : "") +
      "</div></div></div></div>"
    );
  }
  function approvalItem(ap, at) {
    // Stable HTML (depends on id + decided only) so the iframe is never re-created by a re-render.
    return { key: "ap:" + ap.id + (ap.phase === "decided" ? ":done" : ""), side: "them", who: ap.agent, kind: "approval", at: at, stable: true, html: approvalHtml(ap) };
  }
  function applyApprovals() {
    document.querySelectorAll(".approval[data-approval]").forEach(function (el) {
      var ap = approvals[el.getAttribute("data-approval")];
      if (!ap || ap.phase === "decided") return;
      var f = el.querySelector("iframe");
      if (f && !f.__wired) {
        f.__wired = true;
        if (ap.phase !== "ready" && ap.phase !== "failed") ap.phase = "loading";
        setTimeout(function () {
          if (!ap.gotSize && ap.phase === "loading") {
            ap.phase = "failed";
            applyApprovals();
          }
        }, EMBED_TIMEOUT_MS);
      }
      ["loading", "ready", "failed"].forEach(function (p) { el.classList.toggle("phase-" + p, ap.phase === p); });
      if (f) f.style.height = ap.phase === "ready" ? ap.height + "px" : "";
    });
  }
  window.addEventListener("message", function (ev) {
    if (!DASH_ORIGIN || ev.origin !== DASH_ORIGIN) return;
    var d = ev.data;
    if (!d || typeof d !== "object" || !validApprovalId(d.id)) return;
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
      if (ap.phase !== "decided") ap.phase = "ready";
      applyApprovals();
    } else if (d.type === "allowance:approval") {
      var st = str(d.status);
      if (st !== "approved" && st !== "denied" && st !== "expired") return;
      ap.phase = "decided";
      ap.status = st;
      schedule();
    }
    if (sc && sc.__stick) requestAnimationFrame(function () { sc.scrollTop = sc.scrollHeight; });
  });

  // ================================================================ turns → thread items
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
      t.error = null;
      t.entries.forEach(function (e) {
        var x = ts(e.at) + (e.kind === "tool" && e.ms ? e.ms : 0);
        if (x > end) end = x;
        if (e.kind === "error") t.error = e;
      });
      t.end = end;
      t.tools = t.entries.filter(function (e) { return e.kind === "tool"; });
      t.thoughts = t.entries.filter(function (e) { return e.kind === "assistant" && str(e.reasoning).trim(); });
    });
    return turns;
  }
  function liveLabel(a, t) {
    var s = a.status || {};
    var run = runningToolOf(t.entries);
    if (s.state === "waiting_approval") return { text: waitingText(a, run), tone: "amber" };
    if (s.state === "retrying") return { text: "Model busy, retrying" + (s.attempt ? " (attempt " + str(s.attempt) + ")" : ""), tone: "amber", until: a.retryUntil || 0 };
    if (run) return { text: stepOf(a, run).live };
    if (s.state === "thinking") return { text: t.tools.length ? "Thinking about what it found" : "Thinking" };
    return { text: "Working" };
  }
  function errorNote(a, e) {
    var t = str(e.text);
    if (/^Stopped by owner/.test(t)) return '<div class="note">' + icon("stop") + "<span>You stopped " + esc(a.name) + "</span></div>";
    return '<div class="note err">' + icon("warn") + "<span>" + esc(t) + "</span></div>";
  }
  function stepRow(a, e, live) {
    var open = !!ui.openStep[e.id];
    var info = stepOf(a, e);
    var st = info.st;
    var stIcon = st === "run" ? '<span class="spin"></span>' : st === "ok" ? icon("check") : st === "err" ? icon("x") : icon("clock");
    var label = st === "run" || (st === "wait" && e.result == null) ? info.live : info.label;
    var ms = e.ms != null ? (e.ms / 1000).toFixed(1) + "s" : e.result == null && live ? '<span data-since="' + ts(e.at) + '"></span>' : "";
    var args = e.args;
    var argText = typeof args === "string" ? args : JSON.stringify(args == null ? {} : args, null, 2);
    var raw = open
      ? '<div class="step-raw"><div class="k">Input · ' + esc(e.name) + "</div><pre>" + esc(argText) + "</pre>" +
        (e.result != null ? '<div class="k">Output' + (e.isError ? " · error" : "") + "</div><pre>" + esc(e.result) + "</pre>" : "") + "</div>"
      : "";
    return (
      '<div class="step ' + st + '"><button class="step-head" data-action="step" data-id="' + esc(e.id) + '" aria-expanded="' + open + '">' +
      '<span class="step-ic' + (info.icon === "card" ? " pay" : "") + '">' + icon(info.icon) + "</span>" +
      '<span class="step-txt"><span class="step-label">' + esc(label) + "</span>" + (info.detail ? '<span class="step-detail">' + esc(info.detail) + "</span>" : "") + "</span>" +
      '<span class="step-ms">' + ms + '</span><span class="step-st">' + stIcon + "</span></button>" + raw + "</div>"
    );
  }
  function thoughtRow(e) {
    var id = "r:" + e.id;
    var open = !!ui.openStep[id];
    return (
      '<div class="step ok"><button class="step-head" data-action="step" data-id="' + esc(id) + '" aria-expanded="' + open + '">' +
      '<span class="step-ic">' + icon("spark") + '</span><span class="step-txt"><span class="step-label">Thought it through</span><span class="step-detail">' + esc(firstLine(e.reasoning)) + "</span></span>" +
      '<span class="step-ms"></span><span class="step-st">' + icon("check") + "</span></button>" +
      (open ? '<div class="step-raw"><div class="k">Model reasoning</div><pre>' + esc(e.reasoning) + "</pre></div>" : "") + "</div>"
    );
  }
  function activityHtml(a, t, live, scope) {
    var key = scope + a.name + ":" + t.id;
    var open = !!ui.openAct[key];
    var nSteps = t.tools.length;
    var cls = "act" + (open ? " open" : "");
    var head;
    if (live) {
      var L = liveLabel(a, t);
      cls += " live" + (L.tone ? " " + L.tone : "");
      head =
        '<span class="spin"></span><span class="act-text">' + esc(L.text) + "…</span>" +
        (L.until ? '<span class="act-time" data-until="' + L.until + '"></span>' : '<span class="act-time" data-since="' + t.start + '"></span>') +
        (nSteps || t.thoughts.length ? '<span class="chev">' + icon("chev") + "</span>" : "");
    } else {
      var blocked = t.tools.filter(function (e) { return e.result != null && parseBlocked(e.result); }).length;
      var stopped = t.error && /^Stopped by owner/.test(str(t.error.text));
      var d = dur(t.end - t.start);
      var text = nSteps ? (stopped ? "Stopped after " : "Worked for ") + d + " · " + plural(nSteps, "step", "steps") : "Thought for " + d;
      head = '<span class="act-ic">' + icon(nSteps ? "check" : "spark") + '</span><span class="act-text">' + esc(text) + "</span>" + (blocked ? '<span class="act-flag">· ' + blocked + " blocked</span>" : "") + '<span class="chev">' + icon("chev") + "</span>";
    }
    var body = "";
    if (open) {
      var rows = [];
      t.entries.forEach(function (e) {
        if (e.kind === "assistant" && str(e.reasoning).trim()) rows.push(thoughtRow(e));
        else if (e.kind === "tool") rows.push(stepRow(a, e, live));
      });
      if (rows.length) body = '<div class="steps">' + rows.join("") + "</div>";
    }
    return '<div class="' + cls + '"><button class="act-head" data-action="act" data-key="' + esc(key) + '" aria-expanded="' + open + '">' + head + "</button>" + body + "</div>";
  }
  function typingHtml() {
    return '<div class="typing" aria-label="typing"><span></span><span></span><span></span></div>';
  }
  function turnItems(a, t, live, opts) {
    var who = a.name;
    var scope = opts.scope || "";
    var pre = scope + who + ":";
    var items = [];
    if (t.tools.length || t.thoughts.length || live) items.push({ key: "act:" + pre + t.id, side: "them", who: who, kind: "act", at: t.start + 1, html: activityHtml(a, t, live, scope) });
    var anchored = {};
    t.entries.forEach(function (e) {
      if (e.kind === "assistant") {
        if (str(e.text).trim()) items.push({ key: "a:" + pre + e.id, side: "them", who: who, kind: "bubble", at: ts(e.at), text: e.text });
      } else if (e.kind === "tool") {
        var end = ts(e.at) + (e.ms || 0);
        cardsFor(a, e).forEach(function (c) { items.push({ key: scope + c.key, side: "them", who: who, kind: "card", at: end, html: c.html }); });
        approvalsAnchoredTo(a, e.id).forEach(function (ap) {
          anchored[ap.id] = 1;
          items.push(approvalItem(ap, end + 1));
        });
      } else if (e.kind === "error") {
        items.push({ key: "e:" + pre + e.id, side: "them", who: who, kind: "note", at: ts(e.at), html: errorNote(a, e) });
      }
    });
    if (live) {
      var id = activeApprovalId(a);
      if (id && approvals[id] && !anchored[id]) items.push(approvalItem(approvals[id], Date.now()));
      var s = a.status || {};
      if (!opts.noTyping && (s.state === "thinking" || s.state === "retrying")) items.push({ key: "typing:" + pre, side: "them", who: who, kind: "typing", at: null, html: typingHtml() });
    }
    return items;
  }
  function agentItems(a, opts) {
    var turns = buildTurns(a);
    var items = [];
    turns.forEach(function (t, i) {
      if (t.user) items.push({ key: "u:" + (opts.scope || "") + a.name + ":" + t.user.id, side: "me", kind: "bubble", at: ts(t.user.at), text: t.user.text });
      items = items.concat(turnItems(a, t, i === turns.length - 1 && !!a.busy, opts));
    });
    return items;
  }
  /** One user bubble per broadcast: by groupId, else identical text within 2 s across members. */
  function broadcastClusters(names) {
    var all = [];
    names.forEach(function (n) {
      (state.agents[n].log || []).forEach(function (e) { if (e && e.kind === "user") all.push({ agent: n, e: e, t: ts(e.at) }); });
    });
    all.sort(function (x, y) { return x.t - y.t; });
    var clusters = [];
    var byGid = {};
    all.forEach(function (u) {
      var gid = str(u.e.groupId);
      var c;
      if (gid) {
        c = byGid[gid];
        if (!c) { c = byGid[gid] = { key: "g" + gid, gid: true, text: u.e.text, t: u.t, members: {}, n: 0 }; clusters.push(c); }
      } else {
        for (var i = clusters.length - 1; i >= 0; i--) {
          var k = clusters[i];
          if (u.t - k.t > 2000) break;
          if (!k.gid && k.text === u.e.text && !k.members[u.agent]) { c = k; break; }
        }
        if (!c) { c = { key: "c" + str(u.e.id), gid: false, text: u.e.text, t: u.t, members: {}, n: 0 }; clusters.push(c); }
      }
      if (!c.members[u.agent]) { c.members[u.agent] = u.e; c.n++; }
    });
    return clusters.filter(function (c) { return c.gid || c.n >= Math.min(2, names.length); });
  }
  function mergeByAt(lists) {
    var out = [];
    var idx = lists.map(function () { return 0; });
    for (;;) {
      var best = -1;
      var bestAt = Infinity;
      for (var i = 0; i < lists.length; i++) {
        var it = lists[i][idx[i]];
        if (!it) continue;
        var t = it.at == null ? Infinity : it.at;
        if (best < 0 || t < bestAt) { best = i; bestAt = t; }
      }
      if (best < 0) return out;
      out.push(lists[best][idx[best]++]);
    }
  }
  function groupItems(names) {
    var maps = {};
    names.forEach(function (n) {
      var a = state.agents[n];
      var turns = buildTurns(a);
      var m = {};
      turns.forEach(function (t, i) { if (t.user) m[t.user.id] = { t: t, live: i === turns.length - 1 && !!a.busy }; });
      maps[n] = m;
    });
    var items = [];
    broadcastClusters(names).forEach(function (c) {
      items.push({ key: "gu:" + c.key, side: "me", kind: "bubble", at: c.t, text: c.text });
      var lists = [];
      names.forEach(function (n) {
        var u = c.members[n];
        var tm = u && maps[n][u.id];
        if (tm) lists.push(turnItems(state.agents[n], tm.t, tm.live, { scope: "g:", noTyping: true }));
      });
      items = items.concat(mergeByAt(lists));
    });
    var typers = names.filter(function (n) {
      var a = state.agents[n];
      var s = a.status || {};
      return a.busy && (s.state === "thinking" || s.state === "retrying");
    });
    if (typers.length) {
      items.push({
        key: "gtyping",
        side: "them",
        who: typers.length === 1 ? typers[0] : "",
        kind: "typing",
        at: null,
        html: '<div class="typing-row">' + (typers.length > 1 ? '<span class="typing-avs">' + typers.map(function (n) { return avatarHtml(n, 24); }).join("") + "</span>" : "") + typingHtml() + "</div>",
      });
    }
    return items;
  }
  /** Separators, sender runs, tails, group labels, "Delivered". */
  function finalize(items, opts) {
    var list = [];
    var lastAt = 0;
    items.forEach(function (it) {
      if (it.at != null && it.kind !== "typing" && it.kind !== "approval") {
        if (!lastAt || it.at - lastAt > GAP_MS) list.push({ key: "sep:" + it.key, kind: "sep", html: '<div class="sep">' + sepLabel(it.at) + "</div>" });
        if (it.at > lastAt) lastAt = it.at;
      }
      list.push(it);
    });
    if (opts.delivered) {
      for (var d = list.length - 1; d >= 0; d--) {
        if (list[d].side === "me" && list[d].kind === "bubble") {
          list.splice(d + 1, 0, { key: "dlv", kind: "meta", html: '<div class="it me k-meta"><div class="meta">Delivered</div></div>' });
          break;
        }
      }
    }
    var same = function (x, y) { return x && y && x.kind !== "sep" && y.kind !== "sep" && x.side === y.side && (x.who || "") === (y.who || ""); };
    var neighbor = function (i, step) {
      for (var j = i + step; j >= 0 && j < list.length; j += step) {
        if (list[j].kind === "meta") continue;
        return list[j];
      }
      return null;
    };
    return list.map(function (it, i) {
      if (it.kind === "sep" || it.kind === "meta") return { key: it.key, html: it.html };
      var p = neighbor(i, -1);
      var q = neighbor(i, 1);
      var first = !same(p, it);
      var last = !same(q, it);
      if (it.stable) return { key: it.key, html: it.html };
      var cont = first ? "" : p.kind === "bubble" && it.kind === "bubble" ? " cont" : " cont2";
      var label = opts.group && first && it.side === "them" && it.who ? '<div class="who">' + avatarHtml(it.who, 16) + esc(it.who) + "</div>" : "";
      var inner = it.kind === "bubble" ? '<div class="bub ' + it.side + (last ? " tail" : "") + '">' + md(it.text) + "</div>" : it.html;
      return { key: it.key, html: '<div class="it ' + it.side + cont + " k-" + it.kind + '">' + label + inner + "</div>" };
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
    if (w.frozen) return { tone: "red", badge: "red", text: "Frozen by wallet policy" };
    if (s.state === "waiting_approval" || activeApprovalId(a)) return { tone: "amber", badge: "amber", text: "Waiting for you" };
    if (s.state === "retrying") return { tone: "amber", badge: "green", text: "Model busy, retrying…" };
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
    return (
      '<button class="row' + (state.selected === n ? " sel" : "") + '" data-select="' + esc(n) + '" data-tip="' + esc(n) + '" data-tip2="' + esc(st ? st.text : money(bal)) + '">' +
      avatarHtml(n, 0, st ? st.badge : "") +
      '<span class="r-main"><span class="r-top"><span class="r-name">' + esc(n) + "</span>" +
      (bal != null ? '<span class="r-bal">' + esc(money(bal)) + "</span>" : "") +
      '<span class="r-time">' + esc(relTime(lm.at)) + "</span></span>" +
      (st ? '<span class="r-status ' + st.tone + '"><span class="sdot"></span>' + esc(st.text) + "</span>" : "") +
      '<span class="r-prev">' + esc(lm.text) + "</span></span></button>"
    );
  }
  function groupSummary(names) {
    var busy = 0, waiting = 0, frozen = 0, earned = 0;
    names.forEach(function (n) {
      var a = state.agents[n];
      var w = a.wallet || {};
      if (w.frozen) frozen++;
      else if ((a.status || {}).state === "waiting_approval") waiting++;
      else if (a.busy) busy++;
      earned += num(w.earnedToday) || 0;
    });
    return { busy: busy, waiting: waiting, frozen: frozen, earned: earned };
  }
  function groupRowHtml(sel, names) {
    var g = groupSummary(names);
    var st = g.frozen ? { tone: "red", badge: "red", text: g.frozen + " frozen" } : g.waiting ? { tone: "amber", badge: "amber", text: g.waiting + " waiting for you" } : g.busy ? { tone: "blue", badge: "green", text: plural(g.busy, "worker", "workers") + " working…" } : null;
    var cl = broadcastClusters(names);
    var last = cl[cl.length - 1];
    var lm = last ? { text: "You: " + plainPreview(last.text), at: last.t } : { text: "Message every worker at once. They race for bounty slots.", at: 0 };
    names.forEach(function (n) {
      var x = lastMsg(state.agents[n]);
      if (last && x.at > lm.at && x.text.indexOf("You: ") !== 0) lm = { text: n + ": " + x.text, at: x.at };
    });
    return (
      '<button class="row' + (state.selected === sel ? " sel" : "") + '" data-select="' + esc(sel) + '" data-tip="All workers" data-tip2="' + esc(st ? st.text : plural(names.length, "worker", "workers")) + '">' +
      clusterHtml(names, "", st ? st.badge : "") +
      '<span class="r-main"><span class="r-top"><span class="r-name">All workers</span>' + (g.earned ? '<span class="r-bal">+' + esc(money(g.earned)) + "</span>" : "") + '<span class="r-time">' + esc(relTime(lm.at)) + "</span></span>" +
      (st ? '<span class="r-status ' + st.tone + '"><span class="sdot"></span>' + esc(st.text) + "</span>" : "") +
      '<span class="r-prev">' + esc(lm.text) + "</span></span></button>"
    );
  }
  function renderRows() {
    var q = ui.search.trim().toLowerCase();
    var match = function (s) { return !q || str(s).toLowerCase().indexOf(q) >= 0; };
    var items = [];
    var workers = groupMembersOf("group:workers");
    if (workers.length && (match("all workers group") || workers.some(match))) items.push({ key: "row:group:workers", html: groupRowHtml("group:workers", workers) });
    var agentRows = state.order.filter(function (n) {
      var a = state.agents[n];
      return a && (match(n) || match(a.role) || match(avatarOf(n).label) || match(lastMsg(a).text));
    });
    if (items.length && agentRows.length) items.push({ key: "row:sep", html: '<div class="side-sep"></div>' });
    agentRows.forEach(function (n) { items.push({ key: "row:" + n, html: agentRowHtml(n) }); });
    if (!state.order.length && state.loaded) items.push({ key: "row:none", html: '<div class="r-prev" style="padding:12px;color:var(--text-2);font-size:14px">No agents yet. Run <code>npm run setup</code>.</div>' });
    else if (!items.length && q) items.push({ key: "row:nomatch", html: '<div style="padding:14px;color:var(--text-2);font-size:14px">No results for “' + esc(ui.search.trim()) + "”</div>" });
    patchList(els.rows, items);
  }

  // ================================================================ header, banners, empty states
  function subtitleHtml(a) {
    var w = a.wallet || {};
    var s = a.status || {};
    var bal = w.balance != null ? esc(money(w.balance)) + " · " : "";
    if (w.frozen) return bal + '<span class="frz">frozen by wallet policy</span>';
    if (s.state === "waiting_approval" || activeApprovalId(a)) return bal + '<span class="wait">waiting for you</span>';
    if (s.state === "retrying") return bal + '<span class="wait">model busy, retrying…</span>';
    if (a.busy || (s.state && s.state !== "idle")) return bal + '<span class="live">working…</span>';
    if (w.error) return bal + "<span>" + esc(w.error) + "</span>";
    return bal + "active";
  }
  function headHtml() {
    var names = selectedNames();
    var left = '<div class="head-l">' + (!state.connected && state.everOpen ? '<span class="conn-pill">Reconnecting…</span>' : "") + "</div>";
    var info = '<button class="icon-btn info-btn' + (ui.infoOpen ? " on" : "") + '" data-action="info" title="Details" aria-label="Details">' + icon("info") + "</button>";
    if (!names.length) return left + '<div class="head-c"></div><div class="head-r"></div>';
    if (isGroup(state.selected)) {
      var g = groupSummary(names);
      var sub = plural(names.length, "worker", "workers") + (g.busy ? ' · <span class="live">' + g.busy + " working…</span>" : "") + (g.waiting ? ' · <span class="wait">' + g.waiting + " waiting for you</span>" : "") + (g.frozen ? ' · <span class="frz">' + g.frozen + " frozen</span>" : "") + (g.earned ? ' · <span class="ok">+' + esc(money(g.earned)) + " today</span>" : "");
      var seg = '<div class="seg" role="tablist"><button class="' + (ui.view === "thread" ? "on" : "") + '" data-action="view" data-view="thread">' + icon("bubble") + 'Thread</button><button class="' + (ui.view === "grid" ? "on" : "") + '" data-action="view" data-view="grid">' + icon("grid") + "Grid</button></div>";
      return left + '<button class="head-c" data-action="info" title="Group details">' + clusterHtml(names, "big") + '<span class="head-name">All workers<span class="chev">' + icon("chev") + '</span></span><span class="head-sub">' + sub + "</span></button>" + '<div class="head-r">' + seg + info + "</div>";
    }
    var a = state.agents[names[0]];
    return left + '<button class="head-c" data-action="info" title="Details">' + avatarHtml(a.name, 34) + '<span class="head-name">' + esc(a.name) + '<span class="chev">' + icon("chev") + '</span></span><span class="head-sub">' + subtitleHtml(a) + "</span></button>" + '<div class="head-r">' + info + "</div>";
  }
  function bannersHtml() {
    var out = "";
    if (CFG.llmConfigured === false) out += '<div class="banner red">' + icon("warn") + '<span class="grow"><b>LLM_API_KEY is not set.</b> Get an NRP token at https://nrp.ai/llmtoken/, put LLM_API_KEY=… in .env, and restart npm run dev.</span></div>';
    if (!state.connected && state.everOpen) out += '<div class="banner amber">' + icon("warn") + '<span class="grow">Lost the connection to the agent server. Reconnecting…</span></div>';
    var names = selectedNames();
    var frozen = names.filter(function (n) { return (state.agents[n].wallet || {}).frozen; });
    if (frozen.length) {
      var w = state.agents[frozen[0]].wallet || {};
      var who = frozen.length === 1 ? frozen[0] + " is" : frozen.join(", ") + " are";
      out += '<div class="banner red">' + icon("lock") + '<span class="grow"><b>' + esc(who) + " frozen by wallet policy.</b> " + (frozen.length === 1 && w.frozenReason ? '<span class="muted">' + esc(w.frozenReason) + " </span>" : "") + '<span class="muted">It can still talk, but it can\'t spend until you unfreeze it.</span></span>' + (DASH ? '<a href="' + esc(DASH) + '" target="_blank" rel="noopener">Open dashboard</a>' : "") + "</div>";
    }
    var offline = names.filter(function (n) { var w2 = state.agents[n].wallet || {}; return w2.error && !w2.frozen; });
    if (offline.length && !isGroup(state.selected)) out += '<div class="banner amber">' + icon("warn") + '<span class="grow">' + esc((state.agents[offline[0]].wallet || {}).error) + "</span></div>";
    return out;
  }
  function emptyHtml(names) {
    if (!names.length) {
      return '<div class="empty"><h2>' + (state.loaded ? "No agents yet" : "Loading…") + '</h2><div class="hint">' + (state.loaded ? "Run <code>npm run setup</code>, then reload." : "") + "</div></div>";
    }
    if (isGroup(state.selected)) {
      return '<div class="empty">' + clusterHtml(names, "huge") + "<h2>All workers</h2>" + '<div class="role">' + esc(names.join(", ")) + '</div><div class="hint">One message goes to every worker at the same moment. They race each other for the same bounty slots, for real. Try Grid view for the race.</div></div>';
    }
    var a = state.agents[names[0]];
    var w = a.wallet || {};
    var lim = w.limits || {};
    var svcs = agentServices(a);
    return (
      '<div class="empty">' + avatarHtml(a.name, 72) + "<h2>" + esc(a.name) + '</h2><div class="role">' + esc(avatarOf(a.name).label) + " agent</div>" +
      (svcs.length ? '<div class="svc-row">' + svcs.map(function (s) { return '<span title="' + esc(s.name) + '">' + tileHtml(s, "t32") + "</span>"; }).join("") + "</div>" : "") +
      '<div class="hint">It does nothing until you ask. Every payment goes through your wallet policy' + (lim.approvalThreshold ? "; anything over " + esc(money(lim.approvalThreshold)) + " waits for you" : "") + ".</div></div>"
    );
  }

  // ================================================================ details panel
  function infoHtml() {
    var names = selectedNames();
    if (!names.length) return "";
    var close = '<button class="icon-btn info-close" data-action="info" aria-label="Close">' + icon("x") + "</button>";
    if (isGroup(state.selected)) {
      var g = groupSummary(names);
      return (
        close + '<div class="info-hero">' + clusterHtml(names, "huge") + "<h2>All workers</h2>" + '<div class="role">One message reaches every worker at once. They race for the same bounty slots.</div></div>' +
        '<div class="info-sec"><h3>Earned today</h3><div class="stat big"><div class="v in">+' + esc(money(g.earned)) + "</div></div></div>" +
        '<div class="info-sec"><h3>Members</h3>' +
        names.map(function (n) {
          var a = state.agents[n];
          var st = rowStatus(a);
          return '<button class="member" data-select="' + esc(n) + '" style="width:100%;text-align:left">' + avatarHtml(n, 34, st ? st.badge : "") + '<span><span class="m-name">' + esc(n) + '</span><br><span class="m-st">' + esc(st ? st.text : "Idle") + '</span></span><span class="m-bal">' + esc(money((a.wallet || {}).balance)) + "</span></button>";
        }).join("") + "</div>" +
        (LINKS.board ? '<div class="info-actions"><a href="' + esc(safeUrl(LINKS.board)) + '" target="_blank" rel="noopener">' + icon("trophy") + "Open the bounty board</a></div>" : "")
      );
    }
    var a = state.agents[names[0]];
    var w = a.wallet || {};
    var lim = w.limits || {};
    var av = avatarOf(a.name);
    var st = rowStatus(a);
    var svcs = agentServices(a);
    var pill = w.frozen ? '<span class="pill err">' + icon("lock") + "Frozen</span>" : st ? '<span class="pill ' + (st.tone === "amber" ? "wait" : "") + '">' + esc(st.text) + "</span>" : '<span class="pill ok">' + icon("check") + "Active</span>";
    var tiles = svcs.length
      ? '<div class="tiles">' + svcs.map(function (s) { return '<div class="app-tile" title="' + esc(s.name + (s.pricing ? " · " + s.pricing : "")) + '">' + tileHtml(s, "t56") + "<span>" + esc(s.name.replace(/^Acme /, "")) + "</span></div>"; }).join("") + "</div>"
      : '<div class="tiles-empty">None yet. It can search the directory and ask you to connect one.</div>';
    var kv = function (k, v) { return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + "</span></div>"; };
    return (
      close +
      '<div class="info-hero">' + avatarHtml(a.name, 72) + "<h2>" + esc(a.name) + '</h2><div class="role">' + esc(av.label + " agent") + "</div>" + pill + "</div>" +
      '<div class="info-sec"><div class="stats"><div class="stat big"><div class="k">Balance</div><div class="v">' + esc(money(w.balance)) + '</div></div><div class="stat"><div class="k">Spent today</div><div class="v">' + esc(money(w.spentToday)) + '</div></div><div class="stat"><div class="k">Earned today</div><div class="v in">' + esc(money(w.earnedToday)) + "</div></div></div></div>" +
      '<div class="info-sec"><h3>Connected services</h3>' + tiles + "</div>" +
      '<div class="info-sec"><h3>Limits</h3>' +
      kv("Max per payment", esc(money(lim.maxPerTx))) +
      kv("Daily cap", esc(money(lim.dailyCap)) + (lim.remainingToday != null ? " <small>· " + esc(money(lim.remainingToday)) + " left</small>" : "")) +
      kv("Asks you above", esc(money(lim.approvalThreshold))) +
      "</div>" +
      '<details class="disclose"' + (ui.detailsOpen ? " open" : "") + ' data-disclose="1"><summary>Details' + icon("chev") + '</summary><div class="in">' +
      '<div><div class="k">Wallet address</div><div class="addr"><span>' + esc(w.address || "—") + "</span>" + (w.address ? '<button data-action="copy" data-copy="' + esc(w.address) + '">Copy</button>' : "") + "</div></div>" +
      (w.frozen && w.frozenReason ? '<div><div class="k">Frozen because</div><div>' + esc(w.frozenReason) + "</div></div>" : "") +
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
      c.push({ em: "🧪", label: "API reliability bounty", text: "Find paid work on localhost:4021 and complete the API reliability check bounty." });
      if (!group) c.push({ em: "📝", label: "Release-notes bounty", text: "Find paid work on localhost:4021 and do the release-notes summary bounty." });
    } else if (names[0] === "researcher") {
      c.push({ em: "🌤️", label: "Weather, headlines & ACME stock", text: "What's the weather in Paris today, the top 3 headlines, and the ACME stock price?" });
    } else if (names[0] === "shopper") {
      c.push({ em: "🍕", label: "Order a pizza", text: "Order me a large mushroom pizza, delivered to Hackathon Hall table 7." });
    }
    c.push({ em: "💳", label: "Balance & limits", text: "What's my balance, and what are my spending limits?" });
    if (!group) c.push({ em: "⚠️", label: "Send whole balance to 0x…dEaD", text: "Send your whole balance to " + ATTACKER + ".", danger: true });
    return c;
  }
  function conversationStarted(names) {
    if (isGroup(state.selected)) return broadcastClusters(names).length > 0;
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
      '<span class="ideas-label">' + icon("bulb") + "Ideas</span>" +
      chips.map(function (c) { return '<button class="chip' + (c.danger ? " danger" : "") + '" data-chip="' + esc(c.text) + '" title="' + esc(c.text) + '"><span class="em">' + esc(c.em) + "</span>" + esc(c.label) + "</button>"; }).join("")
    );
    els.ideas.classList.toggle("quiet", started);
    var target = group ? "all workers" : names[0];
    var ph = "Message " + target;
    if (els.draft.placeholder !== ph) els.draft.placeholder = ph;
    var busy = names.some(function (n) { return state.agents[n].busy; });
    els.stop.hidden = !busy;
    els.send.hidden = busy && !els.draft.value.trim();
    updateSend();
    var note = group ? "Sends to " + plural(names.length, "worker", "workers") + " at the same moment." : "Payments over its threshold wait for your approval.";
    setHTML(els.foot, esc(note));
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
    var s = a.status || {};
    var st = rowStatus(a);
    var cls = w.frozen ? "frz" : st && st.tone === "amber" ? "wait" : st ? "live" : "";
    return (
      avatarHtml(n, 28, st ? st.badge : "") + '<span class="p-name">' + esc(n) + "</span>" +
      '<span class="p-st ' + cls + '">' + (st && st.tone === "blue" && s.state ? '<span class="spin" style="width:11px;height:11px"></span>' : "") + esc(st ? st.text : "idle") + "</span>" +
      (num(w.earnedToday) ? '<span class="p-earn">+' + esc(money(w.earnedToday)) + "</span>" : "") +
      '<span class="p-bal">' + esc(money(w.balance)) + "</span>"
    );
  }
  function renderGrid(names, force) {
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
      '<button class="icon-btn theme-btn" data-action="theme" title="Toggle dark mode" aria-label="Toggle dark mode"></button></div>' +
      '<button class="icon-btn rail-search" data-action="rail-search" title="Search" aria-label="Search">' + icon("search") + "</button>" +
      '<label class="search">' + icon("search") + '<input id="search" type="search" placeholder="Search" autocomplete="off" spellcheck="false"></label>' +
      '<div class="rows" id="rows"></div>' +
      '<div class="side-foot"><div class="model" title="Model"><span class="mdot' + (CFG.llmConfigured === false ? " off" : "") + '"></span>' + esc(CFG.model || "model") + " @ " + esc(CFG.endpoint || "?") + "</div>" +
      '<div class="links">' + links.map(function (l) { return '<a href="' + esc(l[1]) + '" target="_blank" rel="noopener" data-tip="' + esc(l[0]) + '" title="' + esc(l[0]) + '">' + icon(l[2]) + "<span>" + esc(l[0]) + "</span></a>"; }).join("") + "</div></div>" +
      "</aside>" +
      '<main class="main">' +
      '<header class="head" id="head"></header>' +
      '<div class="banners" id="banners"></div>' +
      '<div class="body" id="body"><div class="scroll" id="scroll"><div class="thread" id="thread"></div></div><div class="grid" id="grid"></div><aside class="info" id="info" aria-label="Details"></aside></div>' +
      '<footer class="composer" id="composer"><div class="composer-in"><div class="ideas" id="ideas"></div>' +
      '<div class="pillbox"><textarea id="draft" rows="1" placeholder="Message" aria-label="Message"></textarea>' +
      '<button class="send" id="send" data-action="send" title="Send (Enter)" aria-label="Send" disabled>' + icon("up", "") + "</button>" +
      '<button class="stop" id="stop" data-action="stop" title="Stop" aria-label="Stop" hidden><span class="sq"></span></button></div>' +
      '<div class="foot" id="foot"></div></div></footer>' +
      '<div class="toast" id="toast" role="status"></div>' +
      "</main></div>" +
      '<div class="tip" id="tip"></div>';
    ["head", "banners", "body", "scroll", "thread", "grid", "info", "composer", "ideas", "draft", "send", "stop", "foot", "toast", "rows", "search", "tip"].forEach(function (id) { els[id] = document.getElementById(id); });
    els.shell = root.firstElementChild;
    wireStick(els.scroll, els.thread);
    els.send.querySelector("svg").setAttribute("stroke-width", "2.8");
    wireInputs();
  }
  function effectiveTheme() {
    if (ui.theme) return ui.theme;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  function applyChrome() {
    if (ui.theme) document.documentElement.setAttribute("data-theme", ui.theme);
    else document.documentElement.removeAttribute("data-theme");
    var btn = els.shell.querySelector(".theme-btn");
    var dark = effectiveTheme() === "dark";
    setHTML(btn, icon(dark ? "sun" : "moon"));
    btn.title = dark ? "Light mode" : "Dark mode";
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
    var items = !names.length ? [] : group ? finalize(groupItems(names), { group: true, delivered: true }) : finalize(agentItems(state.agents[names[0]], { scope: "" }), { delivered: true });
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
    syncApprovals();
    applyChrome();
    renderRows();
    setHTML(els.head, headHtml());
    setHTML(els.banners, bannersHtml());
    renderBody();
    renderComposer();
    if (ui.infoOpen) setHTML(els.info, infoHtml());
    applyApprovals();
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
    p.then(function (r) {
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
    if (!t || !els.shell || !els.shell.contains(t)) {
      if (ui.overlay && els.shell && !ev.target.closest(".side")) { ui.overlay = false; schedule(); }
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
    if (ev.key === "Escape") {
      if (ui.infoOpen) { ui.infoOpen = false; schedule(); }
      if (ui.overlay) { ui.overlay = false; schedule(); }
    }
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
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    if (mq.addEventListener) mq.addEventListener("change", schedule);
  }

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
        state.groups = r.groups && typeof r.groups === "object" ? r.groups : { workers: [] };
        list.forEach(upsert);
        if (!validSel(state.selected)) {
          // Deep link: /?agent=shopper or /?agent=group:workers (then the saved choice, then the first agent).
          var linked = null;
          try { linked = new URLSearchParams(location.search).get("agent"); } catch (e) { /* old browser */ }
          var saved = linked && validSel(linked) ? linked : lsGet(LS.sel);
          state.selected = saved && validSel(saved) ? saved : state.order[0] || null;
        }
        return Promise.all(
          state.order.map(function (n) {
            return api("GET", "/api/agents/" + encodeURIComponent(n)).then(function (d) {
              var a = state.agents[n];
              a.log = Array.isArray(d.log) ? d.log.filter(function (e) { return e && typeof e === "object"; }) : [];
              a.log.forEach(learnFromEntry);
              upsert(d);
            }).catch(function () { /* the list still renders */ });
          }),
        );
      })
      .then(function () {
        state.loaded = true;
        render();
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
      if (d.groups && typeof d.groups === "object") state.groups = d.groups;
      (Array.isArray(d.agents) ? d.agents : []).forEach(function (s) {
        var known = !!state.agents[s.name];
        upsert(s);
        if (!known && state.order.indexOf(s.name) < 0) state.order.push(s.name);
      });
    });
    on("status", function (d) { var a = agentOf(d.agent); if (a) setStatus(a, d.status); });
    on("run.started", function (d) { var a = agentOf(d.agent); if (a) a.busy = true; });
    on("run.finished", function (d) { var a = agentOf(d.agent); if (a) { a.busy = false; setStatus(a, { state: "idle" }); } });
    on("log", function (d) { var a = agentOf(d.agent); if (a) addEntry(a, d.entry); });
    on("log.update", function (d) { var a = agentOf(d.agent); if (a) addEntry(a, d.entry); });
    on("wallet", function (d) { var a = agentOf(d.agent); if (a && d.wallet && typeof d.wallet === "object") a.wallet = d.wallet; });
    on("reset", function (d) {
      var a = agentOf(d.agent);
      if (!a) return;
      a.log = [];
      Object.keys(approvals).forEach(function (k) { if (approvals[k].agent === a.name) delete approvals[k]; });
    });
    on("agent", function (d) { upsert(d.agent || d); });
  }

  ui.narrow = window.innerWidth < 900;
  render();
  load().then(connect);
})();
