// Page helpers evaluated by server.py through Chromium's DevTools protocol (Runtime.evaluate).
// They define window.__cu; server.py then calls window.__cu.snapshot() or window.__cu.locate(n).
//
// snapshot(): the visible text of the viewport, with "[n]" in front of each interactive element
// (links, buttons, inputs, selects…), plus a numbered element list with labels and screen
// positions. The numbered elements are kept in window.__cuEls so "click element 12" refers to
// exactly what the agent saw; a navigation clears them (the agent then takes a new snapshot).
window.__cu = {
  INTERACTIVE:
    'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="link"],' +
    '[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="option"],[role="switch"],' +
    '[role="combobox"],[role="searchbox"],[role="textbox"],[contenteditable="true"],[contenteditable=""],[onclick]',
  SKIP: new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED", "HEAD"]),

  clean(s, max) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return max && s.length > max ? s.slice(0, max - 1) + "…" : s;
  },

  // Where the page's viewport sits on the screen (the window has no decorations; the toolbar is on top).
  offset() {
    return { x: window.screenX + Math.round((window.outerWidth - window.innerWidth) / 2), y: window.screenY + (window.outerHeight - window.innerHeight) };
  },

  visibleRect(el) {
    const r = el.getBoundingClientRect();
    const left = Math.max(r.left, 0), right = Math.min(r.right, window.innerWidth);
    const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, window.innerHeight);
    if (right - left < 2 || bottom - top < 2) return null;
    return { left, right, top, bottom };
  },

  isShown(el) {
    if (typeof el.checkVisibility === "function") return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) !== 0;
  },

  role(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === "A") return "link";
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "select";
    if (tag === "TEXTAREA" || el.isContentEditable) return "textbox";
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return t;
      if (["submit", "button", "reset", "image"].includes(t)) return "button";
      if (t === "range") return "slider";
      if (t === "file") return "file";
      return "textbox";
    }
    return "button";
  },

  label(el) {
    const c = (s) => this.clean(s, 80);
    const aria = el.getAttribute("aria-label");
    if (aria && c(aria)) return c(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || "").join(" ");
      if (c(t)) return c(t);
    }
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if (tag === "INPUT" && ["submit", "button", "reset"].includes((el.type || "").toLowerCase()) && el.value) return c(el.value);
      if (el.labels && el.labels.length) {
        const t = Array.from(el.labels).map((l) => l.innerText).join(" ");
        if (c(t)) return c(t);
      }
      const t = el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || el.getAttribute("id");
      if (c(t)) return c(t);
      return "";
    }
    const text = c(el.innerText);
    if (text) return text;
    const img = el.querySelector("img[alt]");
    if (img && c(img.alt)) return c(img.alt);
    return c(el.getAttribute("title") || el.getAttribute("name") || "");
  },

  describe(el, n, off) {
    const v = this.visibleRect(el);
    const r = el.getBoundingClientRect();
    const out = {
      n,
      role: this.role(el),
      label: this.label(el),
      x: Math.round(off.x + (v.left + v.right) / 2),
      y: Math.round(off.y + (v.top + v.bottom) / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
    const tag = el.tagName;
    if (tag === "A" && el.href) out.href = this.clean(el.href, 160);
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t !== "text") out.type = t;
      if (t === "checkbox" || t === "radio") out.checked = !!el.checked;
      else if (t === "password") { if (el.value) out.value = "(hidden)"; }
      else if (el.value && !["submit", "button", "reset"].includes(t)) out.value = this.clean(el.value, 80);
    }
    if (tag === "TEXTAREA" && el.value) out.value = this.clean(el.value, 80);
    if (tag === "SELECT") {
      const opt = el.selectedOptions && el.selectedOptions[0];
      if (opt) out.value = this.clean(opt.textContent, 60);
      out.options = Array.from(el.options).slice(0, 12).map((o) => this.clean(o.textContent, 40));
    }
    if (el.disabled) out.disabled = true;
    return out;
  },

  snapshot(maxText, maxElements) {
    maxText = maxText || 5000;
    maxElements = maxElements || 120;
    const off = this.offset();
    const els = [];
    const elements = [];
    const parts = [];
    let textLen = 0;
    let truncated = false;
    const push = (s) => {
      if (truncated) return;
      if (textLen + s.length > maxText) {
        parts.push(s.slice(0, Math.max(0, maxText - textLen)) + "…");
        truncated = true;
        return;
      }
      parts.push(s);
      textLen += s.length;
    };
    const newline = () => {
      if (parts.length && parts[parts.length - 1] !== "\n") parts.push("\n");
    };
    const range = document.createRange();
    const blockish = new Set(["block", "flex", "grid", "list-item", "table", "table-row", "table-caption", "flow-root"]);
    let frames = 0;
    let visited = 0;

    const walk = (node) => {
      if (truncated || visited > 20000) return;
      visited++;
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent;
        if (!t || !t.trim()) return;
        range.selectNodeContents(node);
        const rects = range.getClientRects();
        let seen = false;
        for (const r of rects) {
          if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth) { seen = true; break; }
        }
        if (seen) push(this.clean(t) + " ");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node;
      if (this.SKIP.has(el.tagName.toUpperCase())) {
        if (el.tagName === "IFRAME" && this.visibleRect(el)) frames++;
        return;
      }
      if (!this.isShown(el)) return;
      if (el.matches(this.INTERACTIVE) && els.length < maxElements) {
        const v = this.visibleRect(el);
        if (v) {
          els.push(el);
          const d = this.describe(el, els.length, off);
          elements.push(d);
          push(`[${d.n}] ${d.label || "(" + d.role + ")"} `);
          return;
        }
      }
      const display = getComputedStyle(el).display;
      const block = blockish.has(display) || el.tagName === "BR";
      if (block) newline();
      for (const child of el.childNodes) walk(child);
      if (block) newline();
    };
    if (document.body) walk(document.body);
    window.__cuEls = els;

    const text = parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").replace(/ {2,}/g, " ").trim();
    const se = document.scrollingElement || document.documentElement;
    const maxY = Math.max(0, se.scrollHeight - window.innerHeight);
    const out = {
      url: location.href,
      title: this.clean(document.title, 120),
      text,
      elements,
      scroll: { y: Math.round(window.scrollY), maxY: Math.round(maxY), more: maxY === 0 ? "none" : window.scrollY <= 1 ? "below" : window.scrollY >= maxY - 1 ? "above" : "above and below" },
    };
    if (truncated) out.truncated = true;
    if (els.length >= maxElements) out.moreElements = true;
    if (frames) out.note = `${frames} embedded frame${frames === 1 ? "" : "s"} on screen; their content is not listed (use a screenshot or x,y clicks).`;
    return out;
  },

  // The screen point to click for element n of the last snapshot (scrolled into view if needed).
  locate(n) {
    const els = window.__cuEls;
    if (!els) return { error: "stale_snapshot" };
    const el = els[n - 1];
    if (!el) return { error: "element_not_found", count: els.length };
    if (!el.isConnected) return { error: "stale_snapshot" };
    let v = this.visibleRect(el);
    const r = el.getBoundingClientRect();
    const fully = r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
    if (!fully || !v) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      v = this.visibleRect(el);
    }
    if (!v) return { error: "element_not_visible" };
    const off = this.offset();
    return {
      x: Math.round(off.x + (v.left + v.right) / 2),
      y: Math.round(off.y + (v.top + v.bottom) / 2),
      tag: el.tagName.toLowerCase(),
      role: this.role(el),
      label: this.label(el),
    };
  },

  // <select>: choose an option by value or visible text.
  select(n, wanted) {
    const els = window.__cuEls;
    if (!els) return { error: "stale_snapshot" };
    const el = els[n - 1];
    if (!el) return { error: "element_not_found", count: els.length };
    if (!el.isConnected) return { error: "stale_snapshot" };
    if (el.tagName !== "SELECT") return { error: "not_a_select", role: this.role(el) };
    const w = String(wanted).trim().toLowerCase();
    const opt = Array.from(el.options).find((o) => o.value.toLowerCase() === w) || Array.from(el.options).find((o) => this.clean(o.textContent).toLowerCase() === w) || Array.from(el.options).find((o) => this.clean(o.textContent).toLowerCase().includes(w));
    if (!opt) return { error: "option_not_found", options: Array.from(el.options).slice(0, 20).map((o) => this.clean(o.textContent, 40)) };
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected: this.clean(opt.textContent, 60) };
  },
};

// One tab only: links and window.open that would open a new tab load in the current one, so the
// agent, the snapshot and the stream always look at the same page.
if (!window.__cuOneTab) {
  window.__cuOneTab = true;
  window.open = function (u) {
    if (u) location.href = new URL(String(u), location.href).href;
    return null;
  };
  document.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[target]") : null;
    if (a && a.target && a.target !== "_self") a.target = "_self";
  }, true);
  document.addEventListener("submit", (e) => {
    if (e.target && e.target.target && e.target.target !== "_self") e.target.target = "_self";
  }, true);
}
