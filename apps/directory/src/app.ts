/**
 * Service directory (docs/ARCHITECTURE.md §13.1, §15.2). Reading is unauthenticated: it lists public
 * facts. Agents never call it directly; the wallet-service proxies it. The owner (X-Owner-Key) can add
 * Shopify stores, which are registered with the Shopify bridge and listed with the catalog.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig, ServiceManifest } from "@allowance/shared";
import { buildCatalog, searchCatalog, withoutDocs } from "./catalog.js";
import { DirectoryExtras } from "./extra.js";
import { asShopifyStore, parseShopifyCap, shopifyManifest, shopifyServiceId, storefrontHost, SHOPIFY_DEFAULT_MAX_PRICE } from "./shopify.js";

/** merchantUrl/directoryUrl/quantcommBridgeUrl/computerUseUrl build the catalog. dataDir persists added stores (memory only without it). */
export type DirectoryConfig = Pick<AppConfig, "merchantUrl" | "directoryUrl"> &
  Partial<Pick<AppConfig, "dataDir" | "shopifyBridgeUrl" | "quantcommBridgeUrl" | "computerUseUrl" | "ownerApiKey">>;

export interface DirectoryDeps {
  /** fetch used to call the Shopify bridge (tests). */
  fetch?: typeof fetch;
  /** Bridge registration timeout. Default 20 s (the bridge reads the store from Shopify). */
  bridgeTimeoutMs?: number;
}

export interface DirectoryApp extends express.Express {
  locals: express.Express["locals"] & { services: ServiceManifest[]; extras: DirectoryExtras };
}

const LOG = "[directory]";
const DEFAULT_BRIDGE_URL = "http://localhost:4070";

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function createDirectoryApp(config: DirectoryConfig, deps: DirectoryDeps = {}): DirectoryApp {
  const catalog = buildCatalog({ merchantUrl: config.merchantUrl, directoryUrl: config.directoryUrl, quantcommBridgeUrl: config.quantcommBridgeUrl, computerUseUrl: config.computerUseUrl });
  const builtIn = new Set(catalog.map((s) => s.id));
  const bridgeUrl = (config.shopifyBridgeUrl || DEFAULT_BRIDGE_URL).replace(/\/+$/, "");
  const doFetch = deps.fetch ?? fetch;
  const extras = new DirectoryExtras(config.dataDir);
  const app = express() as DirectoryApp;
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  /** The catalog, then the stores the owner added (oldest first). Rebuilt on each change. */
  const all = (): ServiceManifest[] => [
    ...catalog,
    ...extras.list().flatMap((e) => {
      try {
        return [shopifyManifest(e.store, { bridgeUrl, maxPrice: e.maxPrice })];
      } catch {
        return [];
      }
    }),
  ];
  let services = all();
  const refresh = () => {
    services = all();
    app.locals.services = services;
  };
  app.locals.services = services;
  app.locals.extras = extras;

  /** Same rule as the wallet: with a key configured it must match; keyless dev setups still refuse agent tokens. */
  const ownerAuth = (req: Request, _res: Response, next: NextFunction) => {
    if (config.ownerApiKey && req.header("x-owner-key") !== config.ownerApiKey) throw new HttpError(401, "unauthorized", "X-Owner-Key required");
    if (!config.ownerApiKey && /^Bearer\s/i.test(req.header("authorization") ?? "")) throw new HttpError(401, "unauthorized", "Agent tokens cannot change the directory");
    next();
  };

  app.get("/health", (_req, res) => {
    res.json({ ok: true, services: services.length });
  });

  app.get("/services", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : undefined;
    const category = typeof req.query.category === "string" ? req.query.category.slice(0, 40) : undefined;
    res.json({ services: searchCatalog(services, { q, category }).map(withoutDocs) });
  });

  app.get("/services/:id", (req, res) => {
    const id = String(req.params.id);
    const s = services.find((x) => x.id === id);
    if (!s) {
      res.status(404).json({ error: "service_not_found", message: `No service "${id.slice(0, 80)}" in the directory` });
      return;
    }
    res.json(s);
  });

  /** Register a store with the bridge (owner key), then list it as `shopify-<handle>`. */
  app.post("/services/shopify", ownerAuth, async (req, res) => {
    const body = (req.body ?? {}) as { url?: unknown; maxPrice?: unknown };
    if (typeof body.url !== "string" || !body.url.trim() || body.url.length > 500) {
      throw new HttpError(400, "invalid_request", "Body must be { url, maxPrice? } with the store's link, e.g. https://www.allbirds.com or a product page");
    }
    let maxPrice = SHOPIFY_DEFAULT_MAX_PRICE;
    if (body.maxPrice !== undefined && body.maxPrice !== null) {
      try {
        maxPrice = parseShopifyCap(body.maxPrice);
      } catch (err) {
        throw new HttpError(400, "invalid_request", (err as Error).message);
      }
    }
    const store = await registerWithBridge(body.url.trim());
    if (store.currency && store.currency.toUpperCase() !== "USD") {
      throw new HttpError(422, "store_unsupported", `${store.name} doesn't sell to US shoppers in US dollars (it prices in ${store.currency}), so agents can't pay it in USDC.`, { reason: "currency" });
    }
    const id = shopifyServiceId(store.handle);
    const existing = services.find((s) => s.id === id);
    if (existing) {
      throw new HttpError(409, "service_exists", `${existing.name} is already in the directory as ${id}`, { service: existing });
    }
    extras.add({ store, maxPrice, addedAt: new Date().toISOString() });
    refresh();
    const service = services.find((s) => s.id === id)!;
    console.log(`${LOG} added Shopify store ${store.name} (${storefrontHost(store)}) as ${id}, up to $${maxPrice} per order`);
    res.status(201).json({ service });
  });

  app.delete("/services/:id", ownerAuth, (req, res) => {
    const id = String(req.params.id);
    if (builtIn.has(id)) throw new HttpError(409, "service_built_in", `${id} is part of the built-in catalog and cannot be removed`);
    if (!extras.remove(id)) throw new HttpError(404, "service_not_found", `No added service "${id.slice(0, 80)}" in the directory`);
    refresh();
    console.log(`${LOG} removed ${id}`);
    res.json({ ok: true });
  });

  app.get("/", (_req, res) => {
    res.type("html").send(catalogPage(services));
  });

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", message: `No route ${req.method} ${req.path}` });
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra ?? {}) });
      return;
    }
    const e = err as { status?: number; type?: string; message?: string };
    if (e?.type === "entity.parse.failed" || e?.status === 400) {
      res.status(400).json({ error: "invalid_json", message: "Request body must be valid JSON" });
      return;
    }
    console.error(`${LOG} error: ${e?.message ?? String(err)}`);
    res.status(500).json({ error: "internal", message: "Internal error" });
  });

  /** Bridge `POST /stores` (§15.1). 201 and 409 store_exists both carry the store. */
  async function registerWithBridge(url: string) {
    let r: globalThis.Response;
    try {
      r = await doFetch(`${bridgeUrl}/stores`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...(config.ownerApiKey ? { "x-owner-key": config.ownerApiKey } : {}) },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(deps.bridgeTimeoutMs ?? 20_000),
      });
    } catch (err) {
      console.warn(`${LOG} Shopify bridge not reachable at ${bridgeUrl}: ${(err as Error).message}`);
      throw new HttpError(503, "shopify_bridge_unavailable", "The Shopify bridge is not reachable right now; start it and try again.");
    }
    type BridgeBody = { store?: unknown; error?: string; message?: string; reason?: unknown } | null;
    let json: BridgeBody = null;
    try {
      json = (await r.json()) as BridgeBody;
    } catch {
      json = null;
    }
    if (r.status === 201 || r.status === 200 || r.status === 409) {
      const store = asShopifyStore(json?.store);
      if (store) return store;
      throw new HttpError(502, "shopify_bridge_error", "The Shopify bridge sent a store this directory could not read");
    }
    if (r.status === 400 || r.status === 404 || r.status === 422) {
      const fallback = { 400: "invalid_store_url", 404: "store_not_found", 422: "store_unsupported" }[r.status];
      const reason = typeof json?.reason === "string" && /^[a-z_]{1,40}$/.test(json.reason) ? { reason: json.reason } : undefined;
      throw new HttpError(r.status, typeof json?.error === "string" ? json.error.slice(0, 60) : fallback, typeof json?.message === "string" ? json.message.slice(0, 300) : `The Shopify bridge answered ${r.status}`, reason);
    }
    if (r.status === 401 || r.status === 403) {
      throw new HttpError(502, "shopify_bridge_error", "The Shopify bridge refused the owner key; check OWNER_API_KEY matches");
    }
    // 502 with a code: the bridge reached Shopify and Shopify failed (shopify_unavailable / shopify_error).
    if (r.status === 502 && typeof json?.error === "string" && /^[a-z_]{1,60}$/.test(json.error)) {
      throw new HttpError(502, json.error, typeof json.message === "string" ? json.message.slice(0, 300) : "Shopify did not answer");
    }
    throw new HttpError(r.status === 503 ? 503 : 502, r.status === 503 ? "shopify_bridge_unavailable" : "shopify_bridge_error", `The Shopify bridge answered ${r.status}${json?.message ? `: ${String(json.message).slice(0, 200)}` : ""}`);
  }

  return app;
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only #rgb / #rrggbb colors reach the style attribute. */
function safeColor(c: string): string {
  return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(c) ? c : "#8A8F98";
}

const CATEGORY_LABEL: Record<string, string> = { data: "Data", shopping: "Shopping", work: "Work", tools: "Tools" };

/**
 * The row's one-line summary. The price sits on the right of the row, so a price the summary
 * repeats (", $0.05 per call", " for $18.50") is dropped here; the JSON keeps the full summary.
 */
function rowSummary(s: ServiceManifest): string {
  if (s.shopify) return `Search products and build a real cart at ${storefrontHost(s.shopify)}, paid with a single-use Allowance card (simulated).`;
  return s.summary.replace(/,?\s*(?:for\s+)?\$\d[\d,]*(?:\.\d+)?(?:\s+per\s+[a-z]+)?(?=\s*[.;]|$)/gi, "").trim();
}

/** The price column: "Free" with "(you earn …)" as a muted second line; " · " parts one per line. */
function rowPrice(s: ServiceManifest): string {
  let text = s.pricing;
  // Shopify: "Store prices · paid with your Allowance card · up to $500.00 per order" -> the cap.
  const cap = s.shopify ? /up to (\$[\d,]+(?:\.\d+)?) per order/i.exec(text) : null;
  if (cap) text = `Up to ${cap[1]} per order`;
  const paren = /^(.+?)\s*\((.+)\)$/.exec(text);
  const main = (paren ? paren[1] : text).split(" · ").map((part) => `<span>${escapeHtml(part)}</span>`).join("");
  return paren ? `${main}<small>${escapeHtml(paren[2])}</small>` : main;
}

const CHEVRON = `<svg class="chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function catalogPage(services: readonly ServiceManifest[]): string {
  const rows = services
    .map((s) => {
      const store = s.shopify
        ? `<dt>Storefront</dt><dd><a href="${escapeHtml(s.shopify.storefrontUrl)}" rel="noopener noreferrer">${escapeHtml(storefrontHost(s.shopify))}</a></dd>`
        : "";
      return `<details class="svc">
  <summary>
    <span class="tile" style="background:${safeColor(s.color)}" aria-hidden="true">${escapeHtml(s.icon)}</span>
    <span class="main">
      <span class="top"><span class="name">${escapeHtml(s.name)}</span><span class="meta">${escapeHtml(s.provider)} · ${escapeHtml(CATEGORY_LABEL[s.category] ?? s.category)}</span></span>
      <span class="sum">${escapeHtml(rowSummary(s))}</span>
    </span>
    <span class="price">${rowPrice(s)}</span>
    ${CHEVRON}
  </summary>
  <div class="more">
    <p>${escapeHtml(s.description)}</p>
    <dl>
      <dt>Permissions</dt><dd>${s.permissions.map(escapeHtml).join(" · ")}</dd>
      ${store}
      <dt>Base URL</dt><dd><code>${escapeHtml(s.baseUrl)}</code></dd>
      <dt>ID</dt><dd><code>${escapeHtml(s.id)}</code></dd>
    </dl>
  </div>
</details>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Service Directory</title>
<style>
  /* Tokens from apps/agent-chat/static/chat.css: dark by default, light when the system asks. */
  :root {
    color-scheme: dark;
    --bg: #101114; --hover: rgba(255, 255, 255, 0.045);
    --text: #ececee; --text-2: #a4a6ad; --text-3: #7e8189;
    --line: #22242a; --line-2: #2e3036; --fill: #1a1b1f; --fill-2: #222328;
    --accent: #6e79e0; --card: #15161a; --card-line: #24262c;
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
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 var(--font); -webkit-font-smoothing: antialiased; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  code { font-family: var(--mono); font-size: 12px; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 32px 16px 40px; }
  header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 2px; }
  h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  .count { color: var(--text-3); font-size: 13px; font-variant-numeric: tabular-nums; }
  .lede { margin: 0 0 16px; color: var(--text-3); font-size: 13px; }
  .list { background: var(--card); border: 1px solid var(--card-line); border-radius: 10px; overflow: hidden; }
  .svc + .svc { border-top: 1px solid var(--line); }
  .svc > summary { list-style: none; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto 14px; gap: 12px; align-items: center; padding: 10px 14px; cursor: pointer; }
  .svc > summary::-webkit-details-marker { display: none; }
  .svc > summary:hover { background: var(--hover); }
  .tile { width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center; font-size: 15px; line-height: 1; }
  .main { min-width: 0; }
  .top { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; row-gap: 0; }
  .name { font-weight: 500; }
  .meta { color: var(--text-3); font-size: 12.5px; }
  .sum { display: block; color: var(--text-2); font-size: 13px; line-height: 1.4; }
  .price { color: var(--text-2); font-size: 13px; text-align: right; font-variant-numeric: tabular-nums; max-width: 240px; line-height: 1.4; }
  .price span { display: block; }
  .price small { display: block; color: var(--text-3); font-size: 12px; }
  .chev { color: var(--text-3); transition: transform .15s ease; }
  .svc[open] .chev { transform: rotate(90deg); }
  .more { padding: 0 14px 14px 54px; color: var(--text-2); font-size: 13px; }
  .more p { margin: 0 0 10px; }
  .more dl { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 4px 12px; margin: 0; }
  .more dt { color: var(--text-3); }
  .more dd { margin: 0; overflow-wrap: anywhere; }
  footer { margin-top: 14px; color: var(--text-3); font-size: 12px; line-height: 1.7; }
  footer code { font-size: 11.5px; color: var(--text-2); }
  @media (max-width: 560px) {
    .wrap { padding-top: 20px; }
    /* Price beside the name, the summary full width under both. */
    .svc > summary { grid-template-columns: 28px minmax(0, 1fr) auto; grid-template-areas: "tile top price" "tile sum sum"; align-items: start; gap: 0 10px; padding: 10px 12px; }
    .main { display: contents; }
    .tile { grid-area: tile; } .top { grid-area: top; } .sum { grid-area: sum; margin-top: 2px; } .price { grid-area: price; }
    .chev { display: none; }
    .price { max-width: 150px; font-size: 12.5px; padding-top: 1px; }
    .more { padding: 0 12px 12px 50px; }
    .more dl { grid-template-columns: 1fr; gap: 0; }
    .more dd + dt { margin-top: 6px; }
  }
</style>
</head>
<body>
<div class="wrap">
<header><h1>Service Directory</h1><span class="count">${services.length} services</span></header>
<p class="lede">An agent asks, its owner approves, and only then can it pay.</p>
<main class="list">
${rows}
</main>
<footer>JSON: <code>GET /services?q=</code> · <code>GET /services/:id</code> · <code>GET /health</code> · owner: <code>POST /services/shopify</code> · <code>DELETE /services/:id</code></footer>
</div>
</body>
</html>`;
}
