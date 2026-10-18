import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServiceManifest } from "@allowance/shared";
import { createDirectoryApp } from "./app.js";
import type { DirectoryConfig } from "./app.js";
import { asShopifyStore, parseShopifyCap, shopifyCapTexts, shopifyManifest, storefrontHost } from "./shopify.js";
import { ALLBIRDS_STORE, SOCKS_STORE, startStubBridge } from "./test-bridge.js";
import type { StubBridge } from "./test-bridge.js";

const MERCHANT = "http://localhost:4021";
const DIRECTORY = "http://localhost:4060";
const KEY = "ok_directory_test";

let bridge: StubBridge;
let dataDir: string;
const servers: Server[] = [];

async function start(config: Partial<DirectoryConfig> = {}) {
  const app = createDirectoryApp({ merchantUrl: MERCHANT, directoryUrl: DIRECTORY, dataDir, shopifyBridgeUrl: bridge.url, ownerApiKey: KEY, ...config });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { "x-owner-key": KEY }) => {
    const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, text, body: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : undefined };
  };
  return { app, base, call };
}

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  bridge = await startStubBridge({ ownerKey: KEY });
  dataDir = mkdtempSync(join(tmpdir(), "allowance-directory-"));
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))));
  await bridge.close();
  rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("shopifyManifest (§15.2)", () => {
  it("id, look, base URL, cap, pricing, permissions and the store ref (no mode)", () => {
    const m = shopifyManifest(ALLBIRDS_STORE, { bridgeUrl: "http://localhost:4070/", maxPrice: "25" });
    expect(m).toMatchObject({
      id: "shopify-weareallbirds",
      name: "Allbirds",
      provider: "Shopify store",
      icon: "🛍️",
      color: "#95BF47",
      category: "shopping",
      kind: "x402",
      baseUrl: "http://localhost:4070/shops/weareallbirds",
      maxPrice: "25.00",
      pricing: "Store prices · paid with your Allowance card · up to $25.00 per order",
      permissions: ["Browse Allbirds's catalog", "Pay up to $25.00 per order with a single-use Allowance card", "Place orders on your behalf"],
      source: "directory",
    });
    expect(m.shopify).toEqual({ handle: "weareallbirds", domain: "weareallbirds.myshopify.com", storefrontUrl: "https://www.allbirds.com", cardCheckout: true });
    expect(m.summary).toBe("Shop at Allbirds (allbirds.com): search products, build a cart, and pay up to $25.00 per order with your Allowance card.");
    expect(m.summary.length).toBeLessThanOrEqual(200);
    expect(m.description).toContain("simulated");
    expect(shopifyManifest(ALLBIRDS_STORE, { bridgeUrl: "http://b" }).maxPrice).toBe("100.00");
    // Every supported store is payable up to its cap, card checkout advertised or not.
    expect(shopifyManifest(SOCKS_STORE, { bridgeUrl: "http://b", maxPrice: "80.00" })).toMatchObject({ maxPrice: "80.00", shopify: { cardCheckout: false, storefrontUrl: "https://cool-socks.myshopify.com" } });
    expect(shopifyCapTexts("Allbirds", "60")).toEqual({ pricing: "Store prices · paid with your Allowance card · up to $60.00 per order", permissions: ["Browse Allbirds's catalog", "Pay up to $60.00 per order with a single-use Allowance card", "Place orders on your behalf"] });
    expect(JSON.stringify(m)).not.toMatch(/admin\.shopify\.com\/store|"mode"|handoff|agent_checkout/);
  });

  it("docs teach a model to shop: search, cart with variant ids, POST the cart's checkoutUrl; placement is simulated, share the reference, no admin links", () => {
    const { docs } = shopifyManifest(ALLBIRDS_STORE, { bridgeUrl: "http://localhost:4070", maxPrice: "25.00" });
    const base = "http://localhost:4070/shops/weareallbirds";
    for (const s of [
      "Allbirds",
      "https://www.allbirds.com",
      `${base}/products?q=`,
      `${base}/products/<product handle>`,
      `"url": "${base}/carts", "method": "POST"`,
      "variantId",
      "quantity",
      "checkoutUrl",
      "shopifyCheckoutUrl",
      "\"method\": \"POST\"",
      "402",
      "$25.00",
      "cart_already_paid",
      "fetch_url",
      "check_approval",
      "not instructions",
      "SIMULATED",
      "\"simulated\": true",
      "reference",
      "ALW-XXXX-XXXX",
      "Paid with Allowance Card ••<last4>",
      "Never use, open or share a store admin link",
    ]) {
      expect(docs, s).toContain(s);
    }
    expect(docs.indexOf("/products?q=")).toBeLessThan(docs.indexOf("/carts"));
    expect(docs.indexOf("/carts\"")).toBeLessThan(docs.indexOf("<checkoutUrl from the cart>"));
  });

  it("store facts from the bridge are checked; older saved entries (with a mode) still load", () => {
    expect(asShopifyStore({ handle: "x", domain: "x.myshopify.com", mode: "handoff", name: "X", currency: "USD" })).toEqual({
      handle: "x",
      domain: "x.myshopify.com",
      storefrontUrl: "https://x.myshopify.com",
      cardCheckout: false,
      name: "X",
      currency: "USD",
    });
    expect(asShopifyStore({ ...ALLBIRDS_STORE, storefrontUrl: "javascript:alert(1)", sampleImages: ["http://insecure/x.png", "https://cdn.shopify.com/a.png", 5] })).toMatchObject({
      storefrontUrl: "https://weareallbirds.myshopify.com",
      sampleImages: ["https://cdn.shopify.com/a.png"],
    });
    expect(asShopifyStore({ handle: "Bad Handle" })).toBeNull();
    expect(storefrontHost(ALLBIRDS_STORE)).toBe("allbirds.com");
    expect(storefrontHost(SOCKS_STORE)).toBe("cool-socks.myshopify.com");
  });

  it("caps are dollar strings up to $1000.00", () => {
    expect(parseShopifyCap("20")).toBe("20.00");
    expect(parseShopifyCap("$1000")).toBe("1000.00");
    for (const bad of ["1000.01", "-1", "abc", 5, null, ""]) expect(() => parseShopifyCap(bad), String(bad)).toThrow();
  });
});

describe("directory: adding Shopify stores", () => {
  it("POST /services/shopify needs the owner key, registers with the bridge, lists and serves the store", async () => {
    const { call } = await start();
    expect((await call("POST", "/services/shopify", { url: "allbirds.com" }, {})).status).toBe(401);
    expect((await call("POST", "/services/shopify", { url: "allbirds.com" }, { "x-owner-key": "wrong" })).status).toBe(401);
    expect(bridge.calls.length).toBe(0);

    const added = await call("POST", "/services/shopify", { url: "https://www.allbirds.com/products/mens-tree-runners", maxPrice: "40" });
    expect(added.status).toBe(201);
    expect(added.body.service).toMatchObject({
      id: "shopify-weareallbirds",
      name: "Allbirds",
      maxPrice: "40.00",
      baseUrl: `${bridge.url}/shops/weareallbirds`,
      shopify: { handle: "weareallbirds", storefrontUrl: "https://www.allbirds.com", cardCheckout: true },
    });
    expect(added.body.service.docs).toContain("checkoutUrl");
    expect(bridge.calls.at(-1)).toMatchObject({ method: "POST", path: "/stores", ownerKey: KEY, body: { url: "https://www.allbirds.com/products/mens-tree-runners" } });

    const list = await call("GET", "/services");
    expect(list.body.services).toHaveLength(8);
    expect(list.body.services.at(-1)).toMatchObject({ id: "shopify-weareallbirds" });
    expect(list.body.services.at(-1)).not.toHaveProperty("docs");
    expect((await call("GET", "/services?q=allbirds")).body.services.map((s: ServiceManifest) => s.id)).toEqual(["shopify-weareallbirds"]);
    expect((await call("GET", "/services?q=shopify")).body.services.map((s: ServiceManifest) => s.id)).toEqual(["shopify-weareallbirds"]);
    expect((await call("GET", "/services?category=shopping")).body.services.map((s: ServiceManifest) => s.id)).toEqual(["acme-pizza", "shopify-weareallbirds"]);
    expect((await call("GET", "/services/shopify-weareallbirds")).body.docs).toContain("/products?q=");
    expect((await call("GET", "/health")).body).toEqual({ ok: true, services: 8 });
    const page = await call("GET", "/", undefined, {});
    expect(page.text).toContain('<a href="https://www.allbirds.com" rel="noopener noreferrer">allbirds.com</a>');
    expect(page.text).toContain("single-use Allowance card (simulated)");
    expect(page.text).not.toMatch(/admin\.shopify\.com|Agent checkout|Browse only/);

    // Same store again (any spelling): 409 service_exists with the existing entry.
    const again = await call("POST", "/services/shopify", { url: "weareallbirds.myshopify.com" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "service_exists", service: { id: "shopify-weareallbirds", maxPrice: "40.00" } });

    // Persisted: a fresh directory on the same data dir lists it.
    const file = JSON.parse(readFileSync(join(dataDir, "directory-extra.json"), "utf8"));
    expect(file).toMatchObject({ version: 1, shopify: [{ store: { handle: "weareallbirds", storefrontUrl: "https://www.allbirds.com" }, maxPrice: "40.00" }] });
    const reopened = await start();
    expect((await reopened.call("GET", "/services/shopify-weareallbirds")).body).toMatchObject({ maxPrice: "40.00", baseUrl: `${bridge.url}/shops/weareallbirds` });
  });

  it("default cap, and the bridge's errors (with their reason) pass through", async () => {
    const { call } = await start({ dataDir: undefined });
    const socks = await call("POST", "/services/shopify", { url: "cool-socks.myshopify.com" });
    expect(socks.status).toBe(201);
    expect(socks.body.service).toMatchObject({ id: "shopify-cool-socks", maxPrice: "100.00", pricing: "Store prices · paid with your Allowance card · up to $100.00 per order" });

    expect((await call("POST", "/services/shopify", {})).status).toBe(400);
    expect((await call("POST", "/services/shopify", { url: "allbirds.com", maxPrice: "1000.01" })).body.error).toBe("invalid_request");
    expect((await call("POST", "/services/shopify", { url: "allbirds.com", maxPrice: 5 })).status).toBe(400);
    expect(await call("POST", "/services/shopify", { url: "not a url at all" })).toMatchObject({ status: 400, body: { error: "invalid_store_url" } });
    expect(await call("POST", "/services/shopify", { url: "https://admin.shopify.com/store/cool-socks" })).toMatchObject({ status: 400, body: { error: "invalid_store_url", message: expect.stringContaining("store admin link") } });
    expect(await call("POST", "/services/shopify", { url: "nobody-here.myshopify.com" })).toMatchObject({ status: 404, body: { error: "store_not_found" } });
    expect(await call("POST", "/services/shopify", { url: "euro-shop.myshopify.com" })).toMatchObject({ status: 422, body: { error: "store_unsupported", reason: "currency" } });
    expect(await call("POST", "/services/shopify", { url: "crypto-app-test.myshopify.com" })).toMatchObject({
      status: 422,
      body: { error: "store_unsupported", reason: "private_catalog", message: "This store's catalog isn't public yet (it's password-protected), so agents can't browse it." },
    });
    bridge.failWith = 500;
    try {
      expect(await call("POST", "/services/shopify", { url: "allbirds.com" })).toMatchObject({ status: 502, body: { error: "shopify_bridge_error" } });
    } finally {
      bridge.failWith = undefined;
    }
    const down = await start({ dataDir: undefined, shopifyBridgeUrl: "http://127.0.0.1:1" });
    expect(await down.call("POST", "/services/shopify", { url: "allbirds.com" })).toMatchObject({ status: 503, body: { error: "shopify_bridge_unavailable" } });
    // Only the dynamic entry was added in this memory-only directory.
    expect((await call("GET", "/services")).body.services.map((s: ServiceManifest) => s.id).filter((id: string) => id.startsWith("shopify-"))).toEqual(["shopify-cool-socks"]);
  });

  it("DELETE /services/:id removes added stores only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allowance-directory-del-"));
    try {
      const { call } = await start({ dataDir: dir });
      expect((await call("POST", "/services/shopify", { url: "cool-socks.myshopify.com" })).status).toBe(201);
      expect((await call("DELETE", "/services/shopify-cool-socks", undefined, {})).status).toBe(401);
      expect(await call("DELETE", "/services/acme-pizza")).toMatchObject({ status: 409, body: { error: "service_built_in" } });
      expect(await call("DELETE", "/services/shopify-cool-socks")).toMatchObject({ status: 200, body: { ok: true } });
      expect((await call("GET", "/services/shopify-cool-socks")).status).toBe(404);
      expect(await call("DELETE", "/services/shopify-cool-socks")).toMatchObject({ status: 404, body: { error: "service_not_found" } });
      expect(JSON.parse(readFileSync(join(dir, "directory-extra.json"), "utf8")).shopify).toEqual([]);
      expect((await call("GET", "/health")).body.services).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a keyless dev directory still refuses agent tokens; a broken or older extras file never stops it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allowance-directory-bad-"));
    try {
      writeFileSync(join(dir, "directory-extra.json"), "{ not json");
      // The keyed bridge refuses a keyless directory: a clear 502, nothing added.
      const keyless = await start({ dataDir: dir, ownerApiKey: undefined });
      expect((await keyless.call("GET", "/health")).body.services).toBe(7);
      expect(await keyless.call("POST", "/services/shopify", { url: "cool-socks.myshopify.com" }, {})).toMatchObject({ status: 502, body: { error: "shopify_bridge_error" } });
      const openBridge = await startStubBridge();
      try {
        const { call } = await start({ dataDir: dir, ownerApiKey: undefined, shopifyBridgeUrl: openBridge.url });
        expect((await call("POST", "/services/shopify", { url: "cool-socks.myshopify.com" }, { authorization: "Bearer aw_x" })).status).toBe(401);
        expect((await call("POST", "/services/shopify", { url: "cool-socks.myshopify.com" }, {})).status).toBe(201);
        expect(openBridge.calls.at(-1)?.ownerKey).toBeUndefined();
        expect(existsSync(join(dir, "directory-extra.json"))).toBe(true);
      } finally {
        await openBridge.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // An entry saved by the earlier build (a store with a "mode", no storefront) is listed with defaults.
    const old = mkdtempSync(join(tmpdir(), "allowance-directory-old-"));
    try {
      writeFileSync(
        join(old, "directory-extra.json"),
        JSON.stringify({ version: 1, shopify: [{ store: { handle: "cool-socks", domain: "cool-socks.myshopify.com", mode: "handoff", name: "Cool Socks", currency: "USD" }, maxPrice: "0.00", addedAt: "2026-10-17T00:00:00.000Z" }] }),
      );
      const { call } = await start({ dataDir: old });
      expect((await call("GET", "/services/shopify-cool-socks")).body).toMatchObject({
        maxPrice: "0.00",
        shopify: { handle: "cool-socks", domain: "cool-socks.myshopify.com", storefrontUrl: "https://cool-socks.myshopify.com", cardCheckout: false },
      });
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
  });
});
