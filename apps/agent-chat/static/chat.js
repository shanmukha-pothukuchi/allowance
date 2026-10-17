// Allowance agent chat. Vanilla JS. Every piece of model/tool/site text goes through esc().
(function () {
  "use strict";
  var CFG = window.__CHAT__ || {};
  var ATTACKER = "0x000000000000000000000000000000000000dEaD";
  var state = { agents: {}, order: [], groups: { workers: [] }, selected: null, connected: false, error: "" };
  var app = document.getElementById("app");

  // ---------- helpers ----------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // Tiny, safe markdown: escape first, then code spans, bold, links, line breaks.
  function md(s) {
    var h = esc(s);
    h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    h = h.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
    return h.replace(/\n/g, "<br>");
  }
  function money(v) {
    if (v == null || v === "") return "—";
    var n = Number(v);
    return isFinite(n) ? "$" + n.toFixed(2) : "$" + v;
  }
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.message || "HTTP " + r.status);
        return j;
      });
    });
  }
  function isGroup(sel) { return sel && sel.indexOf("group:") === 0; }
  function selectedNames() {
    if (isGroup(state.selected)) return state.groups[state.selected.slice(6)] || [];
    return state.selected ? [state.selected] : [];
  }
  function statusText(a) {
    var w = a.wallet || {};
    if (w.frozen) return { cls: "frozen", text: "frozen by wallet policy" };
    var s = a.status || { state: "idle" };
    if (s.state === "thinking") return { cls: "busy", text: "thinking…" };
    if (s.state === "tool") return { cls: "busy", text: "using " + s.tool };
    if (s.state === "waiting_approval") return { cls: "wait", text: "waiting for your approval" };
    if (s.state === "retrying") return { cls: "wait", text: "model busy, retrying in " + Math.round(s.waitMs / 1000) + " s" };
    if (w.error) return { cls: "", text: w.error };
    return { cls: "", text: "idle" };
  }

  // ---------- tool card summaries ----------
  function toolArg(e) {
    var a = e.args || {};
    if (typeof a !== "object") return String(a);
    switch (e.name) {
      case "fetch_url": return (a.method || "GET") + " " + (a.url || "");
      case "find_work": return a.site_url || "";
      case "claim_bounty": return (a.claim_url || "").replace(/^https?:\/\/[^/]+/, "");
      case "submit_bounty": return a.claim_id || "";
      case "transfer_usdc": return money(a.amount) + " to " + (a.to || "");
      case "check_approval": return a.approval_id || "";
      case "list_receipts": return a.limit ? "last " + a.limit : "";
      default: return "";
    }
  }
  function toolHeadline(e) {
    if (!e.result) return "";
    var lines = String(e.result).split("\n").filter(function (l) { return l.trim(); });
    var key = lines.filter(function (l) { return /^(Paid|Earned|Blocked|Waiting|Refused|Claimed|Owner|Sent|Denied)\b|bounty_full|rejected|expired/i.test(l.trim()); });
    return (key[key.length - 1] || lines[0] || "").trim();
  }

  // ---------- rendering ----------
  function renderEntry(e) {
    if (e.kind === "user") return '<div class="msg user">' + md(e.text) + "</div>";
    if (e.kind === "assistant") {
      var thought = e.reasoning
        ? '<details class="thought"><summary>model reasoning</summary><pre>' + esc(e.reasoning) + "</pre></details>"
        : "";
      return '<div class="msg assistant">' + md(e.text) + thought + "</div>";
    }
    if (e.kind === "error") return '<div class="msg error">' + md(e.text) + "</div>";
    if (e.kind === "tool") {
      var running = e.result == null;
      var cls = running ? "run" : e.isError ? "err" : "ok";
      var head = toolHeadline(e);
      var moneyCls = /^(Paid|Earned|Sent)\b/.test(head) ? " money" : "";
      var ms = running ? '<span class="tms" data-started="' + esc(e.at) + '">running</span>' : '<span class="tms">' + (e.ms / 1000).toFixed(1) + " s</span>";
      return (
        '<details class="tool ' + cls + '" data-id="' + esc(e.id) + '"><summary><span class="tname">' + esc(e.name) + '</span><span class="targ">' + esc(toolArg(e)) + "</span>" + ms +
        (head ? '<span class="tres' + moneyCls + '">' + esc(head) + "</span>" : "") +
        "</summary><pre>" + esc(typeof e.args === "object" ? JSON.stringify(e.args, null, 2) : e.args) + (e.result != null ? "\n\n" + esc(e.result) : "") + "</pre></details>"
      );
    }
    return "";
  }
  function renderTranscript(a, compact) {
    var log = a.log || [];
    var html = log.map(renderEntry).join("");
    var s = a.status || {};
    if (s.state === "waiting_approval") {
      html += '<div class="waiting">Payment waiting for owner approval' + (s.approvalId ? " (" + esc(s.approvalId) + ")" : "") + ". Approve it on Telegram or the dashboard.</div>";
    } else if (s.state === "retrying") {
      html += '<div class="waiting">The model did not answer (' + esc(s.reason) + "). Retrying in " + Math.round(s.waitMs / 1000) + " s, attempt " + esc(s.attempt) + ".</div>";
    } else if (s.state === "thinking") {
      html += '<div class="thinking"><span class="dot busy"></span>thinking</div>';
    }
    if (!log.length && !a.busy) {
      html = compact
        ? '<div class="empty">Idle. Waiting for instructions.</div>'
        : '<div class="empty"><h2>' + esc(a.name) + " is idle</h2>It does nothing until you ask. Every payment it makes goes through your wallet policy.</div>";
    }
    return html;
  }
  function chipsFor(names) {
    var group = isGroup(state.selected);
    var worker = names.every(function (n) { return /^worker-/.test(n); });
    var c = [];
    if (worker) {
      c.push("Find paid work on localhost:4021 and complete the API reliability check bounty.");
      if (!group) c.push("Find paid work on localhost:4021 and do the release-notes summary bounty.");
    } else if (names[0] === "researcher") {
      c.push("What's the weather in Paris today, the top 3 headlines, and the ACME stock price?");
    } else if (names[0] === "shopper") {
      c.push("Order me a large mushroom and olive pizza from localhost:4021, delivered to Hackathon Hall table 7.");
    }
    c.push("What's my balance, and what are my spending limits?");
    if (!group) c.push({ text: "Send your whole balance to " + ATTACKER + ".", danger: true });
    return c;
  }

  function render() {
    var keep = {};
    document.querySelectorAll(".transcript").forEach(function (el) {
      keep[el.dataset.agent] = { top: el.scrollTop, atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 40 };
    });
    var open = {};
    document.querySelectorAll("details[data-id][open]").forEach(function (el) { open[el.dataset.id] = true; });
    var draft = document.getElementById("draft");
    var draftVal = draft ? draft.value : "";
    var hadFocus = draft && document.activeElement === draft;

    var banners = "";
    if (!CFG.llmConfigured) banners += '<div class="banner danger">LLM_API_KEY is not set. Get an NRP token at https://nrp.ai/llmtoken/, put LLM_API_KEY=… in .env, and restart npm run dev.</div>';
    if (!state.connected) banners += '<div class="banner warn">Agent server connection lost. Reconnecting…</div>';
    if (state.error) banners += '<div class="banner warn">' + esc(state.error) + "</div>";

    var links = CFG.links || {};
    var nav = [["Dashboard", links.dashboard], ["Bounty board", links.board], ["Explorer", links.explorer]]
      .filter(function (l) { return l[1]; })
      .map(function (l) { return '<a href="' + esc(l[1]) + '" target="_blank" rel="noopener">' + l[0] + "</a>"; })
      .join("");

    var side = '<div class="side-label">Groups</div>';
    if (state.groups.workers.length) {
      var busyN = state.groups.workers.filter(function (n) { return state.agents[n] && state.agents[n].busy; }).length;
      side += '<button class="agent-item' + (state.selected === "group:workers" ? " selected" : "") + '" data-select="group:workers"><span class="name">All workers</span><span class="bal">' + state.groups.workers.length + '</span><span class="state"><span class="dot' + (busyN ? " busy" : "") + '"></span>' + (busyN ? busyN + " working" : "message all at once") + "</span></button>";
    }
    side += '<div class="side-label">Agents</div>';
    state.order.forEach(function (n) {
      var a = state.agents[n];
      var st = statusText(a);
      side += '<button class="agent-item' + (state.selected === n ? " selected" : "") + ((a.wallet || {}).frozen ? " frozen" : "") + '" data-select="' + esc(n) + '"><span class="name">' + esc(n) + '</span><span class="bal">' + money((a.wallet || {}).balance) + '</span><span class="state"><span class="dot ' + st.cls + '"></span>' + esc(st.text) + "</span></button>";
    });
    if (!state.order.length) side += '<div class="empty" style="padding:12px">No agents yet. Run <code>npm run setup</code>.</div>';

    var names = selectedNames();
    var main = "";
    if (!names.length) {
      main = '<div class="main"><div></div><div class="transcript"><div class="empty"><h2>No agent selected</h2></div></div><div></div></div>';
    } else if (isGroup(state.selected)) {
      main = '<div class="main"><div class="agent-head"><h1>All workers</h1><div class="role">One message goes to every worker at the same moment. They race for the same bounty slots, for real.</div></div><div class="grid">' +
        names.map(function (n) {
          var a = state.agents[n] || { name: n };
          var st = statusText(a);
          return '<div class="panel"><div class="panel-head"><span class="name">' + esc(n) + '</span><span class="state"><span class="dot ' + st.cls + '"></span>' + esc(st.text) + '</span><span class="bal">' + money((a.wallet || {}).balance) + '</span></div><div class="transcript" data-agent="' + esc(n) + '">' + renderTranscript(a, true) + "</div></div>";
        }).join("") + "</div>" + composer(names) + "</div>";
    } else {
      var a = state.agents[names[0]];
      var w = a.wallet || {};
      var lim = w.limits ? "Max " + money(w.limits.maxPerTx) + " per payment · " + money(w.limits.dailyCap) + " per day · asks you above " + money(w.limits.approvalThreshold) : "";
      main = '<div class="main"><div class="agent-head"><div><h1>' + esc(a.name) + (w.frozen ? ' <span class="frozen-badge">FROZEN</span>' : "") + '</h1><div class="role">' + esc(a.role) + "</div></div>" +
        '<div class="figs"><div class="fig"><span class="k">Balance</span><span class="v big">' + money(w.balance) + '</span></div><div class="fig"><span class="k">Spent today</span><span class="v">' + money(w.spentToday) + '</span></div><div class="fig"><span class="k">Earned today</span><span class="v in">' + money(w.earnedToday) + "</span></div></div>" +
        (lim ? '<div class="limits">' + esc(lim) + (w.frozen && w.frozenReason ? " · frozen: " + esc(w.frozenReason) : "") + "</div>" : "") +
        '</div><div class="transcript" data-agent="' + esc(a.name) + '">' + renderTranscript(a, false) + "</div>" + composer(names) + "</div>";
    }

    app.innerHTML =
      '<header class="top"><div class="brand">Allowance <span>· Agents</span></div><div class="model-pill"><b>' + esc(CFG.model) + "</b> @ " + esc(CFG.endpoint) + "</div><nav>" + nav + "</nav></header>" +
      "<div>" + banners + "</div>" +
      '<div class="layout"><aside class="sidebar">' + side + "</aside>" + main + "</div>";

    document.querySelectorAll("details[data-id]").forEach(function (el) { if (open[el.dataset.id]) el.open = true; });
    document.querySelectorAll(".transcript").forEach(function (el) {
      var k = keep[el.dataset.agent];
      el.scrollTop = !k || k.atBottom ? el.scrollHeight : k.top;
    });
    var d2 = document.getElementById("draft");
    if (d2) {
      d2.value = draftVal;
      if (hadFocus) d2.focus();
    }
    tickTimers();
  }

  function composer(names) {
    var busy = names.some(function (n) { return state.agents[n] && state.agents[n].busy; });
    var chips = chipsFor(names).map(function (c) {
      var t = typeof c === "string" ? c : c.text;
      return '<button class="chip' + (c.danger ? " danger" : "") + '" data-chip="' + esc(t) + '">' + esc(t) + "</button>";
    }).join("");
    var target = isGroup(state.selected) ? "all " + names.length + " workers" : names[0];
    return '<div class="composer"><div class="chips">' + chips + '</div><div class="input-row"><textarea id="draft" rows="1" placeholder="Message ' + esc(target) + '…"></textarea>' +
      (busy ? '<button class="btn stop" data-action="stop">Stop</button>' : '<button class="btn" data-action="send">Send</button>') +
      (isGroup(state.selected) ? "" : '<button class="btn ghost" data-action="reset" title="Clear this conversation">Clear</button>') +
      '</div><div class="hint">The agent only acts when you send a message. Payments over its threshold wait for you on Telegram or the dashboard.</div></div>';
  }

  function tickTimers() {
    document.querySelectorAll("[data-started]").forEach(function (el) {
      var s = Math.max(0, (Date.now() - new Date(el.dataset.started).getTime()) / 1000);
      el.textContent = "running " + s.toFixed(0) + " s";
    });
  }
  setInterval(tickTimers, 1000);

  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; render(); });
  }

  // ---------- actions ----------
  function send() {
    var d = document.getElementById("draft");
    var text = d && d.value.trim();
    if (!text) return;
    state.error = "";
    var p = isGroup(state.selected)
      ? api("POST", "/api/groups/" + state.selected.slice(6) + "/messages", { text: text })
      : api("POST", "/api/agents/" + encodeURIComponent(state.selected) + "/messages", { text: text });
    d.value = "";
    p.catch(function (e) { state.error = e.message; schedule(); });
  }
  app.addEventListener("click", function (ev) {
    var t = ev.target.closest("[data-select],[data-chip],[data-action]");
    if (!t) return;
    if (t.dataset.select) {
      state.selected = t.dataset.select;
      try { localStorage.setItem("allowance-chat-selected", state.selected); } catch (e) {}
      render();
      var d = document.getElementById("draft");
      if (d) d.focus();
    } else if (t.dataset.chip) {
      var d2 = document.getElementById("draft");
      d2.value = t.dataset.chip;
      d2.focus();
    } else if (t.dataset.action === "send") {
      send();
    } else if (t.dataset.action === "stop") {
      selectedNames().forEach(function (n) { api("POST", "/api/agents/" + encodeURIComponent(n) + "/stop"); });
    } else if (t.dataset.action === "reset") {
      api("POST", "/api/agents/" + encodeURIComponent(state.selected) + "/reset").catch(function (e) { state.error = e.message; schedule(); });
    }
  });
  app.addEventListener("keydown", function (ev) {
    if (ev.target.id === "draft" && ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
  });

  // ---------- data ----------
  function upsertAgent(s) {
    var a = state.agents[s.name] || { name: s.name, log: [] };
    a.role = s.role; a.status = s.status; a.busy = s.busy; a.wallet = s.wallet || a.wallet;
    state.agents[s.name] = a;
  }
  function load() {
    return api("GET", "/api/agents").then(function (r) {
      state.order = r.agents.map(function (a) { return a.name; });
      state.groups = r.groups || { workers: [] };
      r.agents.forEach(upsertAgent);
      var saved = null;
      try { saved = localStorage.getItem("allowance-chat-selected"); } catch (e) {}
      if (!state.selected) state.selected = saved && (state.agents[saved] || saved === "group:workers") ? saved : state.order[0] || null;
      return Promise.all(state.order.map(function (n) {
        return api("GET", "/api/agents/" + encodeURIComponent(n)).then(function (d) { state.agents[n].log = d.log || []; });
      }));
    }).then(render).catch(function (e) { state.error = "Could not load agents: " + e.message; render(); });
  }

  function connect() {
    var es = new EventSource("/api/events");
    es.addEventListener("open", function () { state.connected = true; schedule(); });
    es.addEventListener("error", function () { state.connected = false; schedule(); });
    es.addEventListener("snapshot", function (m) {
      JSON.parse(m.data).agents.forEach(upsertAgent);
      schedule();
    });
    es.addEventListener("status", function (m) {
      var e = JSON.parse(m.data);
      if (state.agents[e.agent]) state.agents[e.agent].status = e.status;
      schedule();
    });
    es.addEventListener("run.started", function (m) {
      var e = JSON.parse(m.data);
      if (state.agents[e.agent]) state.agents[e.agent].busy = true;
      schedule();
    });
    es.addEventListener("run.finished", function (m) {
      var e = JSON.parse(m.data);
      if (state.agents[e.agent]) { state.agents[e.agent].busy = false; state.agents[e.agent].status = { state: "idle" }; }
      schedule();
    });
    es.addEventListener("log", function (m) {
      var e = JSON.parse(m.data);
      var a = state.agents[e.agent];
      if (a) { a.log.push(e.entry); schedule(); }
    });
    es.addEventListener("log.update", function (m) {
      var e = JSON.parse(m.data);
      var a = state.agents[e.agent];
      if (!a) return;
      for (var i = a.log.length - 1; i >= 0; i--) if (a.log[i].id === e.entry.id) { a.log[i] = e.entry; break; }
      schedule();
    });
    es.addEventListener("wallet", function (m) {
      var e = JSON.parse(m.data);
      if (state.agents[e.agent]) { state.agents[e.agent].wallet = e.wallet; schedule(); }
    });
    es.addEventListener("reset", function (m) {
      var e = JSON.parse(m.data);
      if (state.agents[e.agent]) { state.agents[e.agent].log = []; schedule(); }
    });
  }

  render();
  load().then(connect);
})();
