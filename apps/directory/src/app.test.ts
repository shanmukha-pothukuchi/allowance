import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { toBaseUnits } from "@allowance/shared";
import type { ServiceManifest } from "@allowance/shared";
import { catalogPage, createDirectoryApp } from "./app.js";
import { buildCatalog, searchCatalog } from "./catalog.js";

const MERCHANT = "http://localhost:4021";
const DIRECTORY = "http://localhost:4060";

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createDirectoryApp({ merchantUrl: `${MERCHANT}/`, directoryUrl: DIRECTORY });
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type") ?? "", text, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : undefined };
}

describe("buildCatalog", () => {
  const catalog = buildCatalog({ merchantUrl: MERCHANT, directoryUrl: DIRECTORY });

  it("has exactly the six §13.1 entries, Quantcomm (§17.2), the Computer (§19.5) and the paper brokerage (§20.1)", () => {
    expect(catalog.map((s) => [s.id, s.name, s.kind, s.baseUrl, s.maxPrice])).toEqual([
      ["directory", "Service Directory", "directory", DIRECTORY, "0.00"],
      ["acme-weather", "Acme Weather", "x402", `${MERCHANT}/api/weather`, "0.05"],
      ["acme-news", "Acme News", "x402", `${MERCHANT}/api/news`, "0.10"],
      ["acme-stocks", "Acme Stocks", "x402", `${MERCHANT}/api/stock`, "0.15"],
      ["acme-pizza", "Acme Pizza", "x402", `${MERCHANT}/pizza`, "18.50"],
      ["acme-bounties", "Acme Bounties", "agent-work", MERCHANT, "0.00"],
      ["quantcomm", "Quantcomm Flood Research", "x402", "http://localhost:4080/quantcomm", "0.10"],
      ["computer-use", "Computer", "x402", "http://localhost:4090/computer", "0.10"],
      ["brokerage", "Brokerage (paper)", "x402", "http://localhost:4110/brokerage", "1000.00"],
    ]);
    const custom = buildCatalog({ merchantUrl: MERCHANT, directoryUrl: DIRECTORY, quantcommBridgeUrl: "http://127.0.0.1:4480/", computerUseUrl: "http://127.0.0.1:4490/", brokerageUrl: "http://127.0.0.1:4510/" });
    expect(custom.find((s) => s.id === "quantcomm")!.baseUrl).toBe("http://127.0.0.1:4480/quantcomm");
    expect(custom.find((s) => s.id === "computer-use")!.baseUrl).toBe("http://127.0.0.1:4490/computer");
    expect(custom.find((s) => s.id === "brokerage")!.baseUrl).toBe("http://127.0.0.1:4510/brokerage");
  });

  it("icons, colors and every field are filled in", () => {
    expect(Object.fromEntries(catalog.map((s) => [s.id, [s.icon, s.color]]))).toEqual({
      directory: ["🧭", "#6E7BF2"],
      "acme-weather": ["🌤️", "#3AA0E0"],
      "acme-news": ["📰", "#5B6B7F"],
      "acme-stocks": ["📈", "#2F9E5B"],
      "acme-pizza": ["🍕", "#E5523A"],
      "acme-bounties": ["💼", "#9B5BFA"],
      quantcomm: ["🌊", "#1D4ED8"],
      "computer-use": ["🖥️", "#64748B"],
      brokerage: ["💹", "#0E9F6E"],
    });
    for (const s of catalog) {
      for (const k of ["name", "provider", "summary", "description", "pricing", "docs"] as const) expect(s[k].length, `${s.id}.${k}`).toBeGreaterThan(3);
      expect(s.summary.length).toBeLessThanOrEqual(200);
      expect(s.permissions.length).toBeGreaterThan(0);
      expect(["data", "shopping", "work", "tools", "finance"]).toContain(s.category);
      expect(s.source).toBe("directory");
      expect(toBaseUnits(s.maxPrice)).toBeGreaterThanOrEqual(0n);
    }
  });

  it("docs say how to call each service, with the real URL and price", () => {
    const byId = Object.fromEntries(catalog.map((s) => [s.id, s])) as Record<string, ServiceManifest>;
    for (const id of ["acme-weather", "acme-news", "acme-stocks", "acme-pizza", "quantcomm", "computer-use"]) {
      expect(byId[id].docs).toContain("fetch_url");
      expect(byId[id].docs).toContain(byId[id].baseUrl);
      expect(byId[id].docs).toContain(`$${byId[id].maxPrice}`);
    }
    expect(byId["acme-weather"].docs).toContain("?city=");
    expect(byId["acme-stocks"].docs).toContain("?symbol=");
    expect(byId["acme-pizza"].docs).toContain("POST");
    expect(byId["acme-pizza"].docs).toMatch(/simulated/i);
    expect(byId["acme-pizza"].description).toMatch(/simulated/i);
    expect(byId["acme-pizza"].permissions).toEqual(["Pay up to $18.50 per order to Acme Pizza", "Place orders on your behalf"]);
    for (const tool of ["find_work", "claim_bounty", "submit_bounty"]) expect(byId["acme-bounties"].docs).toContain(tool);
    for (const tool of ["search_services", "get_service", "request_service"]) expect(byId.directory.docs).toContain(tool);
  });

  it("Quantcomm: the §17.2 entry, docs with every endpoint and price, and Quantcomm's caveats", () => {
    const q = catalog.find((s) => s.id === "quantcomm")!;
    expect(q).toMatchObject({
      name: "Quantcomm Flood Research",
      provider: "Quantcomm",
      icon: "🌊",
      color: "#1D4ED8",
      category: "data",
      kind: "x402",
      pricing: "$0.05 per flood check · $0.10 per analyst view",
      maxPrice: "0.10",
      summary: "Live flood alerts and which banks (Capital One included) sit under them, satellite flood maps, and AI analyst views on bank and insurer stocks.",
      permissions: ["Pay up to $0.10 per request", "Read Quantcomm's flood and bank research"],
      source: "directory",
    });
    for (const s of [`${q.baseUrl}/alerts`, `${q.baseUrl}/companies/COF/flood`, `${q.baseUrl}/companies/<TICKER>/view`, `fetch_url { "url": "${q.baseUrl}" }`, "$0.05", "$0.10"]) expect(q.docs).toContain(s);
    expect(q.docs).toContain("pass through Quantcomm's caveats (sandbox branches, SYNTHETIC customers, stale data)");
    expect(q.docs).toMatch(/research, not advice/);
    for (const code of ["quantcomm_unavailable", "ticker_not_covered", "no_analyst_view", "quantcomm_changed"]) expect(q.docs).toContain(code);
  });

  it("Computer: the §19.5 entry; docs explain the queue, the lease, the actions and the text snapshot, and the safety rule", () => {
    const c = catalog.find((s) => s.id === "computer-use")!;
    expect(c).toMatchObject({
      name: "Computer",
      provider: "Allowance",
      category: "tools",
      kind: "x402",
      baseUrl: "http://localhost:4090/computer",
      pricing: "$0.02 per minute · $0.005 per action",
      maxPrice: "0.10",
      source: "directory",
    });
    for (const s of [
      `fetch_url { "url": "${c.baseUrl}/sessions", "method": "POST"`,
      `${c.baseUrl}/sessions/<id>/time?token=<token>&minutes=1`,
      `${c.baseUrl}/sessions/<id>/snapshot?token=<token>`,
      `${c.baseUrl}/sessions/<id>/actions/<kind>?token=<token>`,
      `${c.baseUrl}/sessions/<id>/end?token=<token>`,
      "queued",
      "lease.secondsLeft",
      "[n] in front of each link, button and field",
      "$0.02 per minute",
      "$0.005 navigate, click, type, select",
      "$0.002 text snapshot",
    ]) {
      expect(c.docs).toContain(s);
    }
    expect(c.docs).toContain("Never type card numbers or passwords into the computer; pay with your wallet tools instead.");
  });

  it("the paper brokerage (§20.1): finance, capped at $1000.00 per buy, honest about paper trading, docs name the tools", () => {
    const b = catalog.find((s) => s.id === "brokerage")!;
    expect(b).toMatchObject({ name: "Brokerage (paper)", provider: "Allowance", category: "finance", kind: "x402", maxPrice: "1000.00", source: "directory" });
    expect(b.summary).toMatch(/Paper trading/);
    expect(b.summary).toMatch(/Not investment advice/);
    expect(b.description).toMatch(/no real securities/);
    expect(b.permissions[0]).toContain("$1000.00");
    for (const s of ["get_quotes", "buy_stock", "sell_stock", "portfolio", "cash_out", `${b.baseUrl}/orders/buy?ticker=COF&amount=100.00`, "label", "disclaimer", "prices_unavailable"]) expect(b.docs).toContain(s);
  });

  it("search matches name, summary, description, provider and category; all terms must match", () => {
    expect(searchCatalog(catalog, { q: "pizza" }).map((s) => s.id)).toEqual(["acme-pizza"]);
    expect(searchCatalog(catalog, { q: "FOOD" }).map((s) => s.id)).toEqual(["acme-pizza"]);
    expect(searchCatalog(catalog, { q: "acme apis" }).length).toBe(5);
    expect(searchCatalog(catalog, { q: "weather city" }).map((s) => s.id)).toEqual(["acme-weather"]);
    expect(searchCatalog(catalog, { q: "weather spaceship" })).toEqual([]);
    expect(searchCatalog(catalog, { category: "data" }).map((s) => s.id)).toEqual(["acme-weather", "acme-news", "acme-stocks", "quantcomm"]);
    expect(searchCatalog(catalog, { q: "flood" }).map((s) => s.id)).toEqual(["quantcomm"]);
    expect(searchCatalog(catalog, { q: "capital one" }).map((s) => s.id)).toEqual(["quantcomm"]);
    expect(searchCatalog(catalog, { q: "work" }).map((s) => s.id)).toContain("acme-bounties");
    expect(searchCatalog(catalog, { q: "browser" }).map((s) => s.id)).toEqual(["computer-use"]);
    expect(searchCatalog(catalog, { category: "finance" }).map((s) => s.id)).toEqual(["brokerage"]);
    expect(searchCatalog(catalog, { q: "paper trading" }).map((s) => s.id)).toEqual(["brokerage"]);
    expect(searchCatalog(catalog, {}).length).toBe(9);
  });
});

describe("directory HTTP", () => {
  it("GET /health", async () => {
    expect((await get("/health")).body).toEqual({ ok: true, services: 9 });
  });

  it("GET /services lists all nine without docs; trailing slashes in MERCHANT_URL are trimmed", async () => {
    const { status, body } = await get("/services");
    expect(status).toBe(200);
    expect(body.services).toHaveLength(9);
    for (const s of body.services) expect(s).not.toHaveProperty("docs");
    expect(body.services.find((s: ServiceManifest) => s.id === "acme-pizza").baseUrl).toBe(`${MERCHANT}/pizza`);
  });

  it("GET /services?q=&category= filters", async () => {
    expect((await get("/services?q=stock")).body.services.map((s: ServiceManifest) => s.id)).toEqual(["acme-stocks", "quantcomm", "brokerage"]);
    expect((await get("/services?q=quantcomm")).body.services.map((s: ServiceManifest) => s.id)).toEqual(["quantcomm"]);
    expect((await get("/services?category=shopping")).body.services.map((s: ServiceManifest) => s.id)).toEqual(["acme-pizza"]);
    expect((await get("/services?q=nothing-like-this")).body.services).toEqual([]);
  });

  it("GET /services/:id returns docs; unknown is 404 service_not_found", async () => {
    const pizza = await get("/services/acme-pizza");
    expect(pizza.status).toBe(200);
    expect(pizza.body).toMatchObject({ id: "acme-pizza", maxPrice: "18.50" });
    expect(pizza.body.docs).toContain("/pizza/order");
    const missing = await get("/services/acme-spaceship");
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: "service_not_found" });
    expect((await get("/nope")).status).toBe(404);
  });

  it("GET / is an HTML catalog with icon tiles", async () => {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.type).toContain("text/html");
    expect(page.text).toContain("<title>Service Directory</title>");
    for (const s of ["🍕", "Acme Pizza", "$18.50 per order", "🌤️", "Acme Bounties", "#E5523A", "🌊", "Quantcomm Flood Research", "#1D4ED8", "💹", "Brokerage (paper)", "Allowance · Finance"]) expect(page.text).toContain(s);
  });

  it("the page escapes everything", () => {
    const evil: ServiceManifest = {
      ...buildCatalog({ merchantUrl: MERCHANT, directoryUrl: DIRECTORY })[1],
      name: "<script>alert(1)</script>",
      description: `"><img src=x onerror=alert(1)>`,
      permissions: ["<b>all</b>"],
      color: "red;background:url(javascript:alert(1))",
    };
    const html = catalogPage([evil]);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>all");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;script&gt;");
  });
});
