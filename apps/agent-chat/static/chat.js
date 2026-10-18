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
    megaphone: '<path d="m3 11 16-6v14L3 13z"/><path d="M11.6 16.4a3 3 0 1 1-5.6-2.1"/><path d="M19 9.5a2.5 2.5 0 0 1 0 5"/>',
    compose: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
    userPlus: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M19 8v6M16 11h6"/>',
    plusCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pencil: '<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 3.5a4 4 0 0 1 0 9M22 21a7 7 0 0 0-4.5-6.5"/>',
    cloud: '<path d="M7 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.4 1.6A3.8 3.8 0 0 1 17.5 18z"/>',
    news: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 8h10M7 12h10M7 16h6"/>',
    chart: '<path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/>',
    bag: '<path d="M5 8h14l-1 12H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    coins: '<circle cx="9" cy="9" r="6"/><path d="M15.5 9.5A6 6 0 1 1 9.5 15.5"/>',
  };
  function icon(name, extra) {
    return '<svg class="i' + (extra ? " " + extra : "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || P.wrench) + "</svg>";
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
  var SVC_ICON = { directory: "search", "acme-weather": "cloud", "acme-news": "news", "acme-stocks": "chart", "acme-pizza": "bag", "acme-bounties": "briefcase" };
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
  function linesHtml(lines, max) {
    var shown = lines.slice(0, max || 6);
    return (
      '<ul class="lines">' +
      shown.map(function (l) {
        var img = imgBox(l.image, 120, "sm", l.title);
        var name = '<span class="l-name">' + esc(l.title) + "</span>";
        return (
          "<li>" + (l.url ? '<a class="l-img" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true">' + img + "</a>" : img) +
          '<span class="l-t">' + (l.url ? '<a class="l-link" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">' + name + "</a>" : name) +
          '<span class="l-sub">' + esc((l.variant ? l.variant + " · " : "") + "Qty " + l.qty) + "</span></span>" +
          '<span class="l-amt">' + esc(l.total != null ? money(l.total) : "") + "</span></li>"
        );
      }).join("") +
      (lines.length > shown.length ? '<li class="l-more">+' + esc(plural(lines.length - shown.length, "more item", "more items")) + "</li>" : "") +
      "</ul>"
    );
  }
  function totalsHtml(rows, cls) {
    return '<dl class="totals' + (cls ? " " + cls : "") + '">' + rows.filter(function (r) { return r[1]; }).map(function (r) { return '<div class="' + (r[2] || "") + '"><dt>' + esc(r[0]) + "</dt><dd>" + (r[3] ? r[1] : esc(r[1])) + "</dd></div>"; }).join("") + "</dl>";
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
  function shopHead(info, title, sub, right, tileCls) {
    return '<div class="c-row">' + tileHtml(info, tileCls || "t48") + '<div class="c-who"><div class="c-title">' + esc(title) + '</div><div class="c-k">' + sub + "</div></div>" + (right || "") + "</div>";
  }
  function productTile(p) {
    var opts = p.variants.length > 1 ? plural(p.variants.length, "option", "options") : "";
    var inner =
      imgBox(p.image, 360, "", p.title) + (p.available ? "" : '<span class="p-flag">Sold out</span>') +
      '<span class="p-title">' + esc(p.title) + "</span>" +
      '<span class="p-price">' + esc(priceLabel(p.min, p.max)) + "</span>" +
      '<span class="p-opt">' + esc(opts) + "</span>";
    return p.url
      ? '<a class="prod" href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(p.title) + '">' + inner + "</a>"
      : '<div class="prod" title="' + esc(p.title) + '">' + inner + "</div>";
  }
  function productsCard(c) {
    var info = svcInfo("shopify-" + c.b.handle);
    var list = (Array.isArray(c.d.products) ? c.d.products : []).map(cleanProduct).filter(Boolean);
    var store = shopName(c.b.handle, c.d.store);
    var q = c.b.q;
    if (!list.length) {
      return '<div class="chip-card">' + icon("bag") + "<span>" + esc(q ? "Nothing matches “" + q + "” at " + store : "No products at " + store) + "</span></div>";
    }
    var n = list.length + (c.d.truncated ? "+" : "");
    var sub = q ? n + (list.length === 1 && !c.d.truncated ? " result" : " results") + " for “" + q + "”" : n + (list.length === 1 && !c.d.truncated ? " product" : " products");
    var shown = list.slice(0, 6);
    return (
      '<div class="card wide shop-prods"><div class="sp-head">' + tileHtml(info, "t32") +
      '<div class="c-who"><div class="c-name">' + esc(store) + '</div><div class="c-k">' + esc(sub) + (info.shopify ? " · " + siteHtml(info.shopify) : "") + "</div></div></div>" +
      '<div class="prods">' + shown.map(productTile).join("") +
      (list.length > shown.length ? '<div class="prod more"><span class="pimg">+' + (list.length - shown.length) + '</span><span class="p-title">more at ' + esc(store) + "</span></div>" : "") +
      "</div></div>"
    );
  }
  function productCard(c) {
    var p = cleanProduct(c.d.product);
    if (!p) return "";
    var store = shopName(c.b.handle, c.d.store);
    var named = p.variants.filter(function (v) { return v.title; });
    var mixed = named.some(function (v) { return v.price != null && p.min != null && Math.abs(v.price - p.min) > 0.005; });
    var chips = named.slice(0, 10).map(function (v) {
      return '<span class="vchip' + (v.available ? "" : " out") + '" title="' + esc(v.available ? v.title : v.title + " · sold out") + '">' + esc(v.title + (mixed && v.price != null ? " · " + money(v.price) : "")) + "</span>";
    }).join("");
    var where = siteHost(p.url) || (svcInfo("shopify-" + c.b.handle).shopify || {}).host || store;
    var img = imgBox(p.image, 240, "lg", p.title);
    return (
      '<div class="card shop-prod"><div class="card-pad"><div class="pd">' + (p.url ? '<a class="pd-img" href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true">' + img + "</a>" : img) +
      '<div class="pd-txt"><div class="c-k">' + esc(store) + '</div><div class="c-name">' + esc(p.title) + "</div>" +
      '<div class="pd-price">' + esc(priceLabel(p.min, p.max)) + (p.available ? "" : ' <span class="pd-out">Sold out</span>') + "</div>" +
      (p.description ? '<div class="pd-desc">' + esc(p.description) + "</div>" : "") + "</div></div>" +
      (chips ? '<div class="vchips">' + chips + (named.length > 10 ? '<span class="vchip more">+' + (named.length - 10) + "</span>" : "") + "</div>" : "") + "</div>" +
      (p.url ? '<div class="c-foot"><a class="plain" href="' + esc(p.url) + '" target="_blank" rel="noopener noreferrer">View on ' + esc(where) + icon("external") + "</a><span>" + esc(p.variants.length > 1 ? plural(p.variants.length, "option", "options") : "") + "</span></div>" : "") +
      "</div>"
    );
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
    // Shopify's own totals. Subtotal only when it says something the lines and total don't.
    var totals = totalsHtml([
      ["Subtotal", sub != null && (lines.length > 1 || (tot != null && Math.abs(sub - tot) > 0.005)) ? money(sub) : ""],
      ["Shipping", ship != null && ship > 0 ? money(ship) : ""],
      ["Taxes", tax != null && tax > 0 ? money(tax) : ""],
      ["Total", tot != null ? money(tot) : "", "tot"],
    ]);
    var notes = (Array.isArray(c.d.notes) ? c.d.notes : []).map(function (n) { return str(n).replace(/\s+/g, " ").trim().slice(0, 160); }).filter(Boolean).slice(0, 2);
    if (!notes.length) notes = ["Shipping and taxes are added at checkout"];
    var exp = ts(c.d.expiresAt);
    return (
      '<div class="card cart"><div class="card-pad">' + shopHead(info, "Cart", esc(store + " · " + plural(items, "item", "items")), "", "t32") +
      linesHtml(lines) + totals +
      notes.map(function (n) { return '<p class="cart-note">' + icon("info") + "<span>" + esc(n) + "</span></p>"; }).join("") + "</div>" +
      '<div class="c-foot"><span>' + esc(exp ? "Held until " + clock(exp) : "Held for 30 minutes") + "</span><span>" + esc(e.name === "check_approval" ? "" : "Pays in USDC") + "</span></div></div>"
    );
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
    var tx = txv ? (txu ? '<a href="' + esc(txu) + '" target="_blank" rel="noopener noreferrer">USDC tx ' + esc(txv) + icon("external") + "</a>" : '<span class="mono">USDC tx ' + esc(txv) + "</span>") : "<span>Paid in USDC</span>";
    var at = ts(d.paidAt) || ts(e.at) + (e.ms || 0);
    var badge = simulated
      ? '<button type="button" class="pill sim-pill" data-action="sim" data-key="' + esc(key) + '" aria-expanded="' + open + '" title="' + esc(why) + '">' + icon("info") + "Simulated order</button>"
      : '<span class="pill ok">' + icon("check") + "Paid</span>";
    return (
      '<div class="card shop-order' + (simulated ? " simulated" : "") + '"><div class="card-pad">' +
      shopHead(info, "Order placed", esc(store) + (ref ? " · " + siteHtml(ref) : ""), badge) +
      (simulated && open ? '<p class="sim-why">' + esc(why) + "</p>" : "") +
      (lines.length ? linesHtml(lines) : "") +
      totalsHtml([["Total", total, "tot"]]) +
      totalsHtml([["Paid with", icon("card") + "<span>" + esc(cardLabel(d)) + "</span>", "", true], ["Reference", reference ? '<span class="mono">' + esc(reference) + "</span>" : "", "", true]], "paid") +
      '</div><div class="c-foot">' + tx + "<span>" + esc(at ? clock(at) : "") + "</span></div></div>"
    );
  }
  /** Cards for one bridge response, or null when this entry isn't one (blocked payments etc. stay generic). */
  function shopCards(a, e, key) {
    var c = shopCall(e);
    if (!c) return null;
    var ok = c.h.status >= 200 && c.h.status < 300;
    var out = [];
    var html = "";
    if (c.b.op === "products" && ok) html = productsCard(c);
    else if (c.b.op === "product" && ok) html = productCard(c);
    else if (c.b.op === "carts" && ok && c.d.cartId) html = cartCard(c, e);
    else if (c.b.op === "checkout") {
      var o = confirmationOf(c.d);
      if (ok && isPlaced(o)) html = shopOrderCard(a, e, c, parseReceipt(c.h.tail));
      else if (str(c.d.error) === "cart_already_paid") {
        html = '<div class="chip-card ok">' + icon("check") + "<span>" + esc("Already paid" + (orderRef(o) ? " · order " + orderRef(o) : "")) + "</span></div>";
      }
    }
    if (html) out.push({ key: key("shop"), html: html });
    return out;
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
    if (/^Waiting for the owner to approve (?:connecting|adding)/.test(r) || /^Asked your owner to add/.test(r)) return "pending";
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
  /** request_service with a store link instead of a directory id (§15.4): what we know of the store. */
  function storeRequest(e) {
    var args = objArgs(e);
    var link = storeLink(args.shopify_store_url);
    var r = e && e.result != null ? str(e.result) : "";
    var idm = r.match(/service_id: "shopify-([a-z0-9][a-z0-9-]{0,62})"/);
    var said = storeInText(r);
    var nm = said ? null : r.match(/approve (?:connecting|adding) (.{1,80}?)\. Approval id/) || r.match(/^(?:Owner connected|Connected) (.{1,80}?)\.(?:\s|$)/) || r.match(/denied (?:connecting|adding) (.{1,80}?)\./) || r.match(/request to (?:connect|add) (.{1,80}?) expired/);
    return {
      is: !!str(args.shopify_store_url).trim() && !str(args.service_id).trim(),
      link: link,
      handle: idm ? idm[1] : said && said.handle ? said.handle : link.handle,
      named: said ? said.name : nm ? nm[1].trim() : "",
    };
  }
  /** The service a request_service call is about: its directory id, or the Shopify store it adds. */
  function requestedId(e) {
    var id = str(objArgs(e).service_id).trim();
    if (id) return id;
    var rq = storeRequest(e);
    return rq.is && rq.handle ? "shopify-" + rq.handle : "";
  }
  function serviceNameOfRequest(e) {
    var a = objArgs(e);
    if (a.custom && typeof a.custom === "object") return str(a.custom.name).slice(0, 60) || "a new service";
    var rq = storeRequest(e);
    if (rq.is) return rq.named || (rq.handle && (shops[rq.handle] || {}).name) || rq.link.host || "a Shopify store";
    return svcInfo(str(a.service_id)).name;
  }
  function waitingText(a, e) {
    var args = objArgs(e);
    if (!e) return "Waiting for your approval";
    if (e.name === "request_service") return "Waiting for you to " + (storeRequest(e).is ? "add " : "connect ") + serviceNameOfRequest(e);
    if (e.name === "fetch_url") {
      var svc = serviceForUrl(str(args.url));
      var due = checkoutTotal(a, str(args.url));
      return "Waiting for your OK to pay " + (due ? due + " to " : "") + (svc ? svc.name : hostOnly(args.url));
    }
    if (e.name === "transfer_usdc") return "Waiting for your OK to send " + money(args.amount);
    var ap = approvals[str(args.approval_id).trim()] || approvals[str(((a && a.status) || {}).approvalId)];
    if (ap && ap.subject) return ap.kind === "service" ? "Waiting for you to " + ap.subject.replace(/^Connect/, "connect").replace(/^Add/, "add") : "Waiting for your OK: " + ap.subject;
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
        var adding = storeRequest(e).is;
        s.icon = adding || handleOfId(args.service_id) ? "bag" : "plug";
        s.label = (adding ? "Asked you to add " : "Asked you to connect ") + nm;
        s.live = (adding ? "Asking you to add " : "Asking you to connect ") + nm;
        if (r) {
          var cs = connStatusFromText(r);
          // Resolved later (check_approval, or the owner decided while it was between waits)?
          if (cs === "pending" && a) cs = connStatus(a, e);
          s.detail = { connected: adding ? "Added" : "Connected", pending: "Waiting for you", declined: "You declined", expired: "Request expired" }[cs] || (e.isError ? first : "");
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
          var so = shopCall(e);
          if (so && so.b.op === "checkout" && so.h.status < 300 && isPlaced(confirmationOf(so.d))) {
            s.label = paidLabel(confirmationOf(so.d), rc2);
            s.icon = "card";
            s.detail = "You approved · " + shopName(so.b.handle, confirmationOf(so.d).store) + " · simulated order";
            break;
          }
          var said = /^Owner connected/.test(r) ? storeInText(r) : null;
          s.detail = said ? "You connected " + said.name : rc2 ? rc2.verb + " " + rc2.amount + " " + rc2.prep + " " + rc2.party : /^Owner connected (.+?)\./.test(r) ? "You connected " + r.match(/^Owner connected (.+?)\./)[1] : /denied/.test(r) ? "You declined" : /expired/.test(r) ? "Expired" : /^Waiting/.test(r) ? "Still waiting for you" : first;
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
    var sb = bridgeOf(url);
    if (sb && shopStep(s, sb, r, e)) return;
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
    var tile = tileHtml(sent ? { glyph: "send" } : svc || { glyph: "receipt" });
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
      '<div class="card earned"><div class="card-pad"><div class="c-row">' + tileHtml({ glyph: "coins", color: "#1E8E3E" }) +
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
    var id = requestedId(e);
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
  /** What a store-link request (§15.4) is about, before and after the wallet discovered the store. */
  function storeRequestInfo(a, e) {
    var rq = storeRequest(e);
    var capArg = num(objArgs(e).max_price);
    var host = rq.link.host;
    var info = rq.handle
      ? svcInfo("shopify-" + rq.handle)
      : { id: "", name: host || "A Shopify store", provider: "Shopify store", glyph: "bag", color: SHOP_GREEN, shopify: { handle: "", domain: host, site: host ? siteUrl("https://" + host) : "", host: host }, permissions: [], maxPrice: "" };
    var described = !!info.id && !!((svcFromAgents(info.id) || {}).permissions || (learned[info.id] || {}).permissions);
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
    if (!described) info.permissions = shopPerms(info.name, info.maxPrice);
    return info;
  }
  function connCard(a, e) {
    var args = objArgs(e);
    var custom = args.custom && typeof args.custom === "object" ? args.custom : null;
    var adding = !custom && storeRequest(e).is;
    var info = custom
      ? { name: str(custom.name).slice(0, 60) || "New service", provider: "Proposed by " + a.name + " · " + hostOnly(custom.base_url), glyph: "globe", color: "#7C8799", permissions: ["Pay up to " + money(custom.max_price) + " per request under " + hostPath(custom.base_url)] }
      : adding
        ? storeRequestInfo(a, e)
        : svcInfo(str(args.service_id));
    var shop = !custom && info.shopify;
    var st = connStatus(a, e);
    var badge = { connected: ["ok", "check", adding ? "Added" : "Connected"], pending: ["wait", "clock", "Pending"], declined: ["err", "x", "Declined"], expired: ["err", "clock", "Expired"], failed: ["err", "x", "Not sent"] }[st];
    var reason = str(args.reason).trim().slice(0, 240);
    var fail = st === "failed" && e.result != null ? firstLine(e.result).replace(/^ERROR:\s*/, "") : "";
    // A request that never reached the owner grants nothing: no "will be able to" list.
    var perms = fail ? [] : info.permissions || [];
    // Shopify: the tile and label already say Shopify, so the subtitle is the storefront's domain.
    var sub = shop
      ? shop.host && shop.host !== info.name.toLowerCase() ? siteHtml(shop) : ""
      : info.provider ? esc(custom ? info.provider : "by " + info.provider) : "";
    var capRow = shop && !fail && num(info.maxPrice) ? totalsHtml([["Per-order cap", "Up to " + money(info.maxPrice)]], "c-cap") : "";
    return (
      '<div class="card conn ' + st + (shop ? " shopc" : "") + '"><div class="card-pad">' +
      '<div class="c-label">' + icon(shop ? "bag" : "plug") + (adding ? "Asks to add a Shopify store" : "Connection request") + "</div>" +
      '<div class="c-row">' + tileHtml(info, "t48") + '<div class="c-who"><div class="c-name">' + (shop && info.name === shop.host ? domainHtml(info.name) : esc(info.name)) + "</div>" + (sub ? '<div class="c-k">' + sub + "</div>" : "") + "</div>" +
      '<span class="pill ' + badge[0] + '">' + icon(badge[1]) + badge[2] + "</span></div>" +
      capRow +
      (perms.length ? '<div class="c-asks">' + esc(a.name) + " will be able to</div>" + '<ul class="c-perms">' + perms.map(function (p) { return "<li>" + icon("check") + "<span>" + esc(p) + "</span></li>"; }).join("") + "</ul>" : "") +
      (reason ? '<div class="c-reason"><small>' + esc(a.name) + "'s reason, in its own words</small>" + esc(reason) + "</div>" : "") +
      (custom ? '<div class="c-flag">Not in the directory · proposed by the agent</div>' : "") +
      (adding && st === "pending" ? '<div class="c-note">Not in your services yet. Approving adds it and connects it to ' + esc(a.name) + ".</div>" : "") +
      (fail ? '<div class="c-fail">' + esc(fail.slice(0, 200)) + "</div>" : "") +
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
    // Shopify bridge responses get their own cards; a paid checkout's order card carries the receipt.
    var sc = shopCards(a, e, key);
    if (sc) return sc;
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
      var id = /^Waiting for the owner|^Asked your owner to add/.test(str(e.result)) ? approvalIdIn(e.result) : "";
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
    if (kind === "service") return src && src.name === "request_service" ? (storeRequest(src).is ? "Add " : "Connect ") + serviceNameOfRequest(src) : "Connect a service";
    if (src && src.name === "transfer_usdc") return "Send " + money(args.amount) + " to " + shortAddr(args.to);
    if (src && src.name === "fetch_url") {
      var w = str(src.result).match(/approve (\$[\d,.]+) to (.{1,60}?)\. Approval id/);
      var svc = serviceForUrl(str(args.url));
      var due = w ? w[1] : checkoutTotal(a, str(args.url));
      return "Pay " + (due ? due + " to " : "") + (svc ? svc.name : w ? w[2] : hostOnly(args.url));
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
        log.forEach(function (x) { if (x.kind === "tool" && x.result != null && str(x.result).indexOf(id) >= 0 && /connecting|connect|adding|add the Shopify store/.test(str(x.result))) kind = "service"; });
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
  function groupItems(def, names) {
    var maps = {};
    names.forEach(function (n) {
      var a = state.agents[n];
      var turns = buildTurns(a);
      var m = {};
      turns.forEach(function (t, i) { if (t.user) m[t.user.id] = { t: t, live: i === turns.length - 1 && !!a.busy }; });
      maps[n] = m;
    });
    var items = [];
    broadcastClusters(def).forEach(function (c) {
      items.push({ key: "gu:" + c.key, side: "me", kind: "bubble", at: c.t, text: c.text });
      var got = Object.keys(c.members).filter(function (n) { return state.agents[n]; });
      items.push({
        key: "gm:" + c.key,
        kind: "meta",
        html: '<div class="it me k-meta"><div class="meta bc">' + icon("megaphone") + "<span>Your message went to " + esc(plural(got.length, "agent", "agents")) + "</span>" + stackHtml(got, 14, 6) + "</div></div>",
      });
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
      var label = opts.group && first && it.side === "them" && it.who ? '<div class="who">' + avatarHtml(it.who, 24) + esc(it.who) + "</div>" : "";
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
    var fresh = ui.fresh[n] && ui.fresh[n] > Date.now();
    return (
      '<button class="row' + (state.selected === n ? " sel" : "") + (fresh ? " fresh" : "") + '" data-select="' + esc(n) + '" data-tip="' + esc(n) + '" data-tip2="' + esc(st ? st.text : money(bal)) + '">' +
      avatarHtml(n, 0, st ? st.badge : "") +
      '<span class="r-main"><span class="r-top"><span class="r-name">' + esc(n) + "</span>" +
      (bal != null ? '<span class="r-bal' + (ui.balUp[n] && ui.balUp[n] > Date.now() ? " up" : "") + '">' + esc(money(bal)) + "</span>" : "") +
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
    var g = groupSummary(names);
    var st = groupStatus(names);
    var cl = broadcastClusters(def);
    var last = cl[cl.length - 1];
    var lm = last ? { text: "You: " + plainPreview(last.text), at: last.t } : { text: names.length ? broadcastLabel(names.length) + ": " + names.join(", ") : "No members here. Tap to edit.", at: 0 };
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
      '<span class="r-main"><span class="r-top"><span class="r-name"><span class="r-bc" title="Broadcast">' + icon("megaphone") + "</span>" + esc(def.name) + "</span>" +
      (g.earned ? '<span class="r-bal">+' + esc(money(g.earned)) + "</span>" : "") + '<span class="r-time">' + esc(relTime(lm.at)) + "</span></span>" +
      (st ? '<span class="r-status ' + st.tone + '"><span class="sdot"></span>' + esc(st.text) + "</span>" : "") +
      '<span class="r-prev">' + esc(lm.text) + "</span></span></button>"
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
  function subtitleHtml(a) {
    var w = a.wallet || {};
    var s = a.status || {};
    var up = ui.balUp[a.name] && ui.balUp[a.name] > Date.now();
    var bal = w.balance != null ? '<span class="hb' + (up ? " up" : "") + '">' + esc(money(w.balance)) + "</span> · " : "";
    if (w.frozen) return bal + '<span class="frz">frozen by wallet policy</span>';
    if (s.state === "waiting_approval" || activeApprovalId(a)) return bal + '<span class="wait">waiting for you</span>';
    if (s.state === "retrying") return bal + '<span class="wait">model busy, retrying…</span>';
    if (a.busy || (s.state && s.state !== "idle")) return bal + '<span class="live">working…</span>';
    if (w.error) return bal + "<span>" + esc(w.error) + "</span>";
    return bal + "active";
  }
  function addMoneyBtn(name, cls) {
    if (!DASH) return "";
    return '<button class="' + (cls || "sub-act") + '" data-action="add-money" data-agent="' + esc(name) + '" title="Add money from your wallet">' + icon("plusCircle") + "Add money</button>";
  }
  function headHtml() {
    var names = selectedNames();
    var left = '<div class="head-l">' + (!state.connected && state.everOpen ? '<span class="conn-pill">Reconnecting…</span>' : "") + "</div>";
    var info = '<button class="icon-btn info-btn' + (ui.infoOpen ? " on" : "") + '" data-action="info" title="Details" aria-label="Details">' + icon("info") + "</button>";
    if (!names.length) return left + '<div class="head-c"></div><div class="head-r"></div>';
    if (isGroup(state.selected)) {
      var def = groupDef(state.selected);
      var g = groupSummary(names);
      var sub = '<span class="bc">' + icon("megaphone") + esc(broadcastLabel(names.length)) + "</span>" + (g.busy ? ' · <span class="live">' + g.busy + " working…</span>" : "") + (g.waiting ? ' · <span class="wait">' + g.waiting + " waiting for you</span>" : "") + (g.frozen ? ' · <span class="frz">' + g.frozen + " frozen</span>" : "") + (g.earned ? ' · <span class="ok">+' + esc(money(g.earned)) + " today</span>" : "");
      var seg = '<div class="seg" role="tablist"><button class="' + (ui.view === "thread" ? "on" : "") + '" data-action="view" data-view="thread">' + icon("bubble") + 'Thread</button><button class="' + (ui.view === "grid" ? "on" : "") + '" data-action="view" data-view="grid">' + icon("grid") + "Grid</button></div>";
      return (
        left + '<div class="head-c"><button class="head-who" data-action="info" title="Broadcast details">' + stackHtml(names, 26, 6) +
        '<span class="head-txt"><span class="head-name">' + esc(def.name) + '<span class="chev">' + icon("chev") + '</span></span><span class="head-sub">' + sub + "</span></span></button></div>" +
        '<div class="head-r">' + seg + info + "</div>"
      );
    }
    var a = state.agents[names[0]];
    return (
      left + '<div class="head-c"><button class="head-who" data-action="info" title="Details">' + avatarHtml(a.name, 34) +
      '<span class="head-txt"><span class="head-name">' + esc(a.name) + '<span class="chev">' + icon("chev") + "</span></span>" +
      '<span class="head-sub">' + subtitleHtml(a) + "</span></span></button></div>" + '<div class="head-r">' + addMoneyBtn(a.name) + info + "</div>"
    );
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
  function allWorkers(names) {
    return names.length > 0 && names.every(function (n) { return /^worker-\d+$/.test(n); });
  }
  function emptyHtml(names) {
    if (!names.length) {
      if (!state.loaded) return '<div class="empty"><h2>Loading…</h2></div>';
      return (
        '<div class="empty"><span class="empty-ic">' + icon("userPlus") + "</span><h2>No agents yet</h2>" +
        '<div class="hint">Create an agent in your wallet, give it some money, and it shows up here, ready to chat. It does nothing until you ask.</div>' +
        (DASH ? '<div class="empty-acts"><button class="btn-pill" data-action="new-agent">' + icon("plus") + "Create an agent</button></div>" : "") +
        '<div class="hint small">Or run <code>npm run setup</code> for the demo agents, then reload.</div></div>'
      );
    }
    if (isGroup(state.selected)) {
      var def = groupDef(state.selected);
      return (
        '<div class="empty">' + groupAvatarHtml(def, 72) + "<h2>" + esc(def.name) + '</h2><div class="role bc">' + icon("megaphone") + esc(broadcastLabel(names.length)) + "</div>" +
        '<div class="members-row">' + names.map(function (n) { return '<span class="mr">' + avatarHtml(n, 34) + "<span>" + esc(n) + "</span></span>"; }).join("") + "</div>" +
        '<div class="hint">Your message goes to each agent on its own, at the same moment. Each one replies separately, right here.' + (allWorkers(names) ? " Workers race each other for the same bounty slots, for real. Try Grid view for the race." : "") + "</div>" +
        '<div class="empty-acts"><button class="btn-ghost" data-action="group-edit" data-group="' + esc(def.id) + '">' + icon("pencil") + "Edit broadcast</button></div></div>"
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
      '<div class="empty">' + avatarHtml(a.name, 72) + "<h2>" + esc(a.name) + '</h2><div class="role">' + esc(custom ? str(a.role).slice(0, 160) : kindLabel(a.name)) + "</div>" +
      (svcs.length ? '<div class="svc-row">' + svcs.map(function (s) { return '<span title="' + esc(s.name) + '">' + tileHtml(s, "t32") + "</span>"; }).join("") + "</div>" : "") +
      '<div class="hint">It does nothing until you ask. Every payment goes through your wallet policy' + (lim.approvalThreshold ? "; anything over " + esc(money(lim.approvalThreshold)) + " waits for you" : "") + ".</div>" +
      (broke && DASH ? '<div class="empty-acts"><span class="hint">Its wallet is empty.</span>' + addMoneyBtn(a.name, "btn-pill") + "</div>" : "") +
      "</div>"
    );
  }

  // ================================================================ details panel
  function infoHtml() {
    var names = selectedNames();
    if (!names.length) return "";
    var close = '<button class="icon-btn info-close" data-action="info" aria-label="Close">' + icon("x") + "</button>";
    if (isGroup(state.selected)) {
      var def = groupDef(state.selected);
      var g = groupSummary(names);
      var total = names.reduce(function (s, n) { return s + (num((state.agents[n].wallet || {}).balance) || 0); }, 0);
      return (
        close + '<div class="info-hero">' + groupAvatarHtml(def, 72) + "<h2>" + esc(def.name) + '</h2><div class="role bc">' + icon("megaphone") + esc(broadcastLabel(names.length)) + "</div>" +
        '<button class="pill-btn" data-action="group-edit" data-group="' + esc(def.id) + '">' + icon("pencil") + "Edit</button></div>" +
        '<div class="info-sec"><div class="stats"><div class="stat"><div class="k">Their balances</div><div class="v">' + esc(money(total)) + '</div></div><div class="stat"><div class="k">Earned today</div><div class="v in">+' + esc(money(g.earned)) + "</div></div></div></div>" +
        '<div class="info-sec"><h3>' + esc(plural(names.length, "member", "members")) + "</h3>" +
        names.map(function (n) {
          var a = state.agents[n];
          var st = rowStatus(a);
          return '<button class="member" data-select="' + esc(n) + '" style="width:100%;text-align:left">' + avatarHtml(n, 34, st ? st.badge : "") + '<span><span class="m-name">' + esc(n) + '</span><br><span class="m-st">' + esc(st ? st.text : "Idle") + '</span></span><span class="m-bal">' + esc(money((a.wallet || {}).balance)) + "</span></button>";
        }).join("") + "</div>" +
        '<div class="info-text pad">' + icon("info") + "<span>Each agent gets your message on its own and replies separately. A broadcast can't spend: every payment still goes through that agent's own wallet policy.</span></div>" +
        '<div class="info-actions">' +
        '<button data-action="group-edit" data-group="' + esc(def.id) + '">' + icon("users") + "Edit name and members</button>" +
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
    var pill = w.frozen ? '<span class="pill err">' + icon("lock") + "Frozen</span>" : st ? '<span class="pill ' + (st.tone === "amber" ? "wait" : "") + '">' + esc(st.text) + "</span>" : '<span class="pill ok">' + icon("check") + "Active</span>";
    var tiles = svcs.length
      ? '<div class="tiles">' + svcs.map(function (s) { return '<div class="app-tile" title="' + esc(s.name + (s.pricing ? " · " + s.pricing : "")) + '">' + tileHtml(s, "t56") + "<span>" + esc(s.name.replace(/^Acme /, "")) + "</span></div>"; }).join("") + "</div>"
      : '<div class="tiles-empty">None yet. It can search the directory and ask you to connect one.</div>';
    var kv = function (k, v) { return '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + "</span></div>"; };
    return (
      close +
      '<div class="info-hero">' + avatarHtml(a.name, 72) + "<h2>" + esc(a.name) + '</h2><div class="role">' + esc(kindLabel(a.name)) + "</div>" + pill + "</div>" +
      '<div class="info-sec"><div class="stats"><div class="stat big"><div class="k">Balance</div><div class="bal-row"><div class="v">' + esc(money(w.balance)) + "</div>" + addMoneyBtn(a.name, "pill-btn") + '</div></div><div class="stat"><div class="k">Spent today</div><div class="v">' + esc(money(w.spentToday)) + '</div></div><div class="stat"><div class="k">Earned today</div><div class="v in">' + esc(money(w.earnedToday)) + "</div></div></div></div>" +
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
      c.push({ label: "API reliability bounty", text: "Find paid work on localhost:4021 and complete the API reliability check bounty." });
      if (!group) c.push({ label: "Release-notes bounty", text: "Find paid work on localhost:4021 and do the release-notes summary bounty." });
    } else if (group) {
      c.push({ label: "Introduce yourselves", text: "Introduce yourselves in one line each: what you do, and how much money is in your wallet." });
    } else if (names[0] === "researcher") {
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
    var target = group ? groupDef(state.selected).name : names[0];
    var ph = "Message " + target;
    if (els.draft.placeholder !== ph) els.draft.placeholder = ph;
    var busy = names.some(function (n) { return state.agents[n].busy; });
    els.stop.hidden = !busy;
    els.send.hidden = busy && !els.draft.value.trim();
    updateSend();
    var note = group ? "Goes to " + plural(names.length, "agent", "agents") + " at the same moment. Each one replies on its own." : "Payments over its threshold wait for your approval.";
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
    els.sheet.className = "sheet " + (s.kind === "owner" ? "owner" : "gsheet");
    els.sheet.innerHTML = s.kind === "owner" ? ownerSheetHtml(s) : groupSheetHtml(s);
    els.sheet.setAttribute("aria-label", s.kind === "owner" ? ownerTitle(s) : s.mode === "edit" ? "Edit broadcast" : "New broadcast");
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
    else updateGroupSheet(s);
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
      '<div class="sh-head"><span class="sh-title">' + (edit ? "Edit broadcast" : "New broadcast") + "<small>One message, sent to each agent on its own</small></span>" +
      '<button class="icon-btn" data-action="sheet-close" aria-label="Close">' + icon("x") + "</button></div>" +
      '<div class="sh-scroll">' +
      '<div class="gs-field"><label class="gs-label" for="gs-name">Name</label>' +
      '<input id="gs-name" class="gs-name" maxlength="40" placeholder="e.g. Research team" autocomplete="off" spellcheck="false" value="' + esc(s.name) + '"></div>' +
      '<div class="gs-sec-h"><span>Members</span><span class="gs-count"></span></div>' +
      '<div class="gs-chosen"></div>' +
      '<div class="gs-list" role="group" aria-label="Agents"></div>' +
      '<div class="gs-note">' + icon("info") + "<span>Each agent replies separately. A broadcast can't spend: every payment still goes through that agent's own wallet policy.</span></div>" +
      (edit
        ? s.builtIn
          ? '<div class="gs-builtin">' + icon("info") + "<span>This is your default list. You can rename it and change who is in it, but not delete it.</span></div>"
          : '<button class="gs-delete" data-action="gs-delete">' + icon("trash") + "Delete broadcast</button>"
        : "") +
      "</div>" +
      '<div class="sh-foot"><span class="gs-err" role="alert"></span><button class="btn-ghost" data-action="sheet-close">Cancel</button><button class="btn-pill" data-action="gs-save"></button></div>'
    );
  }
  function gsMemberHtml(s, n) {
    var a = state.agents[n];
    var on = !!s.members[n];
    var st = rowStatus(a);
    var w = a.wallet || {};
    return (
      '<button class="gs-m' + (on ? " on" : "") + '" data-action="gs-toggle" data-name="' + esc(n) + '" role="checkbox" aria-checked="' + on + '">' +
      avatarHtml(n, 34, st ? st.badge : "") +
      '<span class="gs-m-txt"><span class="gs-m-name">' + esc(n) + '</span><span class="gs-m-sub' + (st ? " " + st.tone : "") + '">' + esc(st ? st.text : kindLabel(n)) + "</span></span>" +
      '<span class="gs-m-bal">' + esc(w.balance != null ? money(w.balance) : "—") + "</span>" +
      '<span class="gs-check">' + icon("check") + "</span></button>"
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
  function ownerTitle(s) {
    return s.which === "add-money" ? "Add money to " + s.agent : "New agent";
  }
  function openOwnerSheet(which, agent) {
    if (which === "add-money" && !(typeof agent === "string" && AGENT_NAME_RE.test(agent))) return;
    var q = which === "add-money" ? "?sheet=add-money&agent=" + encodeURIComponent(agent) : "?sheet=new-agent";
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
    var why = s.which === "add-money"
      ? "Money comes from your wallet, so you add it on the dashboard. It didn't answer here."
      : "New agents get their key in your wallet, so you create them on the dashboard. It didn't answer here.";
    return (
      '<div class="os-head"><span class="os-logo">' + icon("shieldCheck") + "</span>" +
      '<span class="os-t"><b>' + esc(title) + "</b><span>Allowance wallet · only you can do this</span></span>" +
      '<button class="icon-btn" data-action="sheet-close" aria-label="Close">' + icon("x") + "</button></div>" +
      '<div class="os-body">' +
      (s.src
        ? '<div class="os-skel"><span></span><span></span><span></span><span></span></div>' +
          '<iframe class="os-frame" title="' + esc(title) + '" src="' + esc(s.src) + '" sandbox="allow-scripts allow-same-origin allow-forms" allow="clipboard-write" referrerpolicy="origin"></iframe>'
        : "") +
      '<div class="os-fallback"><span class="os-fb-ic">' + icon("layout") + "</span>" +
      '<div class="os-fb-t">Open the dashboard to do this</div><div class="os-fb-s">' + esc(why) + "</div>" +
      (s.open ? '<a class="btn-pill" href="' + esc(s.open) + '" target="_blank" rel="noopener">' + icon("external") + "Open the dashboard</a>" : '<div class="os-fb-s">No dashboard link is configured.</div>') +
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
      toast(amt != null && amt > 0 && AGENT_NAME_RE.test(who) ? "Added " + money(amt) + " to " + who + "." : "Money added.");
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
      '<div class="side-foot"><div class="foot-row"><div class="model" title="Model"><span class="mdot' + (CFG.llmConfigured === false ? " off" : "") + '"></span>' + esc(CFG.model || "model") + " @ " + esc(CFG.endpoint || "?") + "</div>" +
      '<button class="icon-btn theme-btn top-only" data-action="theme" title="Toggle dark mode" aria-label="Toggle dark mode"></button></div>' +
      '<div class="links">' + links.map(function (l) { return '<a href="' + esc(l[1]) + '" target="_blank" rel="noopener" data-tip="' + esc(l[0]) + '" title="' + esc(l[0]) + '">' + icon(l[2]) + "<span>" + esc(l[0]) + "</span></a>"; }).join("") + "</div>" +
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
      '<div class="foot" id="foot"></div></div></footer>' +
      '<div class="toast" id="toast" role="status"></div>' +
      "</main></div>" +
      '<div class="menu" id="menu" role="menu" hidden>' +
      '<button role="menuitem" data-action="new-agent"><span class="mi-ic">' + icon("userPlus") + '</span><span class="mi-t"><b>New agent</b><small>Its own wallet, with money you give it</small></span></button>' +
      '<button role="menuitem" data-action="new-group"><span class="mi-ic bc">' + icon("megaphone") + '</span><span class="mi-t"><b>New broadcast</b><small>Message several agents at once</small></span></button></div>' +
      '<div class="modal" id="modal" hidden><div class="scrim" data-action="sheet-close"></div><div class="sheet" id="sheet" role="dialog" aria-modal="true"></div></div>' +
      '<div class="tip" id="tip"></div>';
    ["head", "banners", "body", "scroll", "thread", "grid", "info", "composer", "ideas", "draft", "send", "stop", "foot", "toast", "rows", "search", "tip", "menu", "modal", "sheet"].forEach(function (id) { els[id] = document.getElementById(id); });
    els.app = root;
    els.shell = root.firstElementChild;
    wireStick(els.scroll, els.thread);
    els.send.querySelector("svg").setAttribute("stroke-width", "2.8");
    wireInputs();
  }
  function effectiveTheme() {
    // Light unless the owner picked dark.
    return ui.theme || "light";
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
    var items = !names.length ? [] : group ? finalize(groupItems(groupDef(state.selected), names), { group: true }) : finalize(agentItems(state.agents[names[0]], { scope: "" }), { delivered: true });
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
    if (ui.sheet && ui.sheet.kind === "group" && ui.sheet.mode === "edit" && !groupById(ui.sheet.id)) closeSheet(); // deleted elsewhere
    if (ui.sheet) updateSheet();
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
