/**
 * Service directory (docs/ARCHITECTURE.md §13.1). Read-only, unauthenticated: it lists public facts.
 * Agents never call it directly; the wallet-service proxies it.
 */
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig, ServiceManifest } from "@allowance/shared";
import { buildCatalog, searchCatalog, withoutDocs } from "./catalog.js";

export type DirectoryConfig = Pick<AppConfig, "merchantUrl" | "directoryUrl">;

export interface DirectoryApp extends express.Express {
  locals: express.Express["locals"] & { services: ServiceManifest[] };
}

export function createDirectoryApp(config: DirectoryConfig): DirectoryApp {
  const services = buildCatalog({ merchantUrl: config.merchantUrl, directoryUrl: config.directoryUrl });
  const app = express() as DirectoryApp;
  app.locals.services = services;
  app.disable("x-powered-by");

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

  app.get("/", (_req, res) => {
    res.type("html").send(catalogPage(services));
  });

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", message: `No route ${req.method} ${req.path}` });
  });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`[directory] error: ${err.message}`);
    res.status(500).json({ error: "internal", message: "Internal error" });
  });

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
<footer>JSON: <code>GET /services?q=</code> · <code>GET /services/:id</code> · <code>GET /health</code></footer>
</body>
</html>`;
}
