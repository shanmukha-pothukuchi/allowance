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

/** merchantUrl/directoryUrl build the catalog. dataDir persists added stores (memory only without it). */
export type DirectoryConfig = Pick<AppConfig, "merchantUrl" | "directoryUrl"> & Partial<Pick<AppConfig, "dataDir" | "shopifyBridgeUrl" | "ownerApiKey">>;

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
  const catalog = buildCatalog({ merchantUrl: config.merchantUrl, directoryUrl: config.directoryUrl });
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

export function catalogPage(services: readonly ServiceManifest[]): string {
  const cards = services
    .map((s) => {
      const perms = s.permissions.map((p) => `<li>${escapeHtml(p)}</li>`).join("");
      return `<article class="card">
  <div class="tile" style="background:${safeColor(s.color)}">${escapeHtml(s.icon)}</div>
  <div class="body">
    <div class="head"><h2>${escapeHtml(s.name)}</h2><span class="price">${escapeHtml(s.pricing)}</span></div>
    <div class="meta">${escapeHtml(s.provider)} · ${escapeHtml(CATEGORY_LABEL[s.category] ?? s.category)} · <code>${escapeHtml(s.id)}</code></div>
    ${s.shopify ? `<div class="shop"><a href="${escapeHtml(s.shopify.storefrontUrl)}" rel="noopener noreferrer">${escapeHtml(storefrontHost(s.shopify))}</a> · Pays with a single-use Allowance card (simulated)</div>` : ""}
    <p>${escapeHtml(s.description)}</p>
    <ul class="perms">${perms}</ul>
    <div class="url"><code>${escapeHtml(s.baseUrl)}</code></div>
  </div>
</article>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Service Directory</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#1d2330; --muted:#677084; --line:#e3e6ec; --accent:#6E7BF2; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12151b; --card:#1a1f27; --text:#e7eaf0; --muted:#98a1b3; --line:#2a313c; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { max-width:960px; margin:0 auto; padding:32px 16px 8px; }
  header h1 { margin:0 0 4px; font-size:26px; }
  header p { margin:0; color:var(--muted); }
  main { max-width:960px; margin:0 auto; padding:16px; display:grid; gap:14px; grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr)); }
  .card { display:flex; gap:14px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; }
  .tile { flex:none; width:52px; height:52px; border-radius:12px; display:grid; place-items:center; font-size:28px; }
  .body { min-width:0; flex:1; }
  .head { display:flex; justify-content:space-between; gap:8px; align-items:baseline; flex-wrap:wrap; }
  h2 { margin:0; font-size:17px; }
  .price { font-weight:600; color:var(--accent); white-space:nowrap; }
  .meta { color:var(--muted); font-size:13px; margin:2px 0 6px; }
  p { margin:0 0 8px; }
  .perms { margin:0 0 8px; padding-left:18px; color:var(--muted); font-size:13px; }
  .url code, .meta code { font-size:12px; overflow-wrap:anywhere; }
  .shop a { color:inherit; }
  .shop { font-size:13px; color:#5E8E3E; margin:-2px 0 6px; }
  footer { max-width:960px; margin:0 auto; padding:8px 16px 32px; color:var(--muted); font-size:13px; }
</style>
</head>
<body>
<header>
  <h1>🧭 Service Directory</h1>
  <p>${services.length} services agents can connect. An agent asks, its owner approves, and only then can it pay.</p>
</header>
<main>
${cards}
</main>
<footer>JSON: <code>GET /services?q=</code> · <code>GET /services/:id</code> · <code>GET /health</code> · owner: <code>POST /services/shopify</code> · <code>DELETE /services/:id</code></footer>
</body>
</html>`;
}
