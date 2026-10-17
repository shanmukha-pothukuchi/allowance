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

  it("has exactly the six §13.1 entries", () => {
    expect(catalog.map((s) => [s.id, s.name, s.kind, s.baseUrl, s.maxPrice])).toEqual([
      ["directory", "Service Directory", "directory", DIRECTORY, "0.00"],
      ["acme-weather", "Acme Weather", "x402", `${MERCHANT}/api/weather`, "0.05"],
      ["acme-news", "Acme News", "x402", `${MERCHANT}/api/news`, "0.10"],
      ["acme-stocks", "Acme Stocks", "x402", `${MERCHANT}/api/stock`, "0.15"],
      ["acme-pizza", "Acme Pizza", "x402", `${MERCHANT}/pizza`, "18.50"],
      ["acme-bounties", "Acme Bounties", "agent-work", MERCHANT, "0.00"],
    ]);
  });

  it("icons, colors and every field are filled in", () => {
    expect(Object.fromEntries(catalog.map((s) => [s.id, [s.icon, s.color]]))).toEqual({
      directory: ["🧭", "#6E7BF2"],
      "acme-weather": ["🌤️", "#3AA0E0"],
      "acme-news": ["📰", "#5B6B7F"],
      "acme-stocks": ["📈", "#2F9E5B"],
      "acme-pizza": ["🍕", "#E5523A"],
      "acme-bounties": ["💼", "#9B5BFA"],
    });
    for (const s of catalog) {
      for (const k of ["name", "provider", "summary", "description", "pricing", "docs"] as const) expect(s[k].length, `${s.id}.${k}`).toBeGreaterThan(3);
      expect(s.summary.length).toBeLessThanOrEqual(200);
      expect(s.permissions.length).toBeGreaterThan(0);
      expect(["data", "shopping", "work", "tools"]).toContain(s.category);
      expect(s.source).toBe("directory");
      expect(toBaseUnits(s.maxPrice)).toBeGreaterThanOrEqual(0n);
    }
  });

  it("docs say how to call each service, with the real URL and price", () => {
    const byId = Object.fromEntries(catalog.map((s) => [s.id, s])) as Record<string, ServiceManifest>;
    for (const id of ["acme-weather", "acme-news", "acme-stocks", "acme-pizza"]) {
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

  it("search matches name, summary, description, provider and category; all terms must match", () => {
    expect(searchCatalog(catalog, { q: "pizza" }).map((s) => s.id)).toEqual(["acme-pizza"]);
    expect(searchCatalog(catalog, { q: "FOOD" }).map((s) => s.id)).toEqual(["acme-pizza"]);
    expect(searchCatalog(catalog, { q: "acme apis" }).length).toBe(5);
    expect(searchCatalog(catalog, { q: "weather city" }).map((s) => s.id)).toEqual(["acme-weather"]);
    expect(searchCatalog(catalog, { q: "weather spaceship" })).toEqual([]);
    expect(searchCatalog(catalog, { category: "data" }).map((s) => s.id)).toEqual(["acme-weather", "acme-news", "acme-stocks"]);
    expect(searchCatalog(catalog, { q: "work" }).map((s) => s.id)).toContain("acme-bounties");
    expect(searchCatalog(catalog, {}).length).toBe(6);
  });
});

describe("directory HTTP", () => {
  it("GET /health", async () => {
    expect((await get("/health")).body).toEqual({ ok: true, services: 6 });
  });

  it("GET /services lists all six without docs; trailing slashes in MERCHANT_URL are trimmed", async () => {
    const { status, body } = await get("/services");
    expect(status).toBe(200);
    expect(body.services).toHaveLength(6);
    for (const s of body.services) expect(s).not.toHaveProperty("docs");
    expect(body.services.find((s: ServiceManifest) => s.id === "acme-pizza").baseUrl).toBe(`${MERCHANT}/pizza`);
  });

  it("GET /services?q=&category= filters", async () => {
    expect((await get("/services?q=stock")).body.services.map((s: ServiceManifest) => s.id)).toEqual(["acme-stocks"]);
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
    for (const s of ["🍕", "Acme Pizza", "$18.50 per order", "🌤️", "Acme Bounties", "#E5523A"]) expect(page.text).toContain(s);
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
