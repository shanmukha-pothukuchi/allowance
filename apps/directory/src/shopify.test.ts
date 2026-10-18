import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServiceManifest } from "@allowance/shared";
import { createDirectoryApp } from "./app.js";
import type { DirectoryConfig } from "./app.js";
import { parseShopifyCap, shopifyManifest } from "./shopify.js";
import { CRYPTO_STORE, HANDOFF_STORE, startStubBridge } from "./test-bridge.js";
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
  it("agent checkout: id, look, base URL, cap, pricing, permissions and shopify ref", () => {
    const m = shopifyManifest(CRYPTO_STORE, { bridgeUrl: "http://localhost:4070/", maxPrice: "25" });
    expect(m).toMatchObject({
      id: "shopify-crypto-app-test",
      name: "Crypto App Test",
      provider: "Shopify",
      icon: "🛍️",
      color: "#95BF47",
      category: "shopping",
      kind: "x402",
      baseUrl: "http://localhost:4070/shops/crypto-app-test",
      maxPrice: "25.00",
      pricing: "Varies by item · up to $25.00 per order",
      permissions: ["Browse the Crypto App Test catalog", "Pay up to $25.00 per order to Crypto App Test", "Place orders on your behalf"],
      source: "directory",
      shopify: { handle: "crypto-app-test", domain: "crypto-app-test.myshopify.com", mode: "agent_checkout" },
    });
    expect(m.summary.length).toBeLessThanOrEqual(200);
    expect(shopifyManifest(CRYPTO_STORE, { bridgeUrl: "http://b" }).maxPrice).toBe("100.00");
  });

  it("docs teach a model to shop: search, cart with variant ids, then POST the cart's checkoutUrl", () => {
    const { docs } = shopifyManifest(CRYPTO_STORE, { bridgeUrl: "http://localhost:4070", maxPrice: "25.00" });
    const base = "http://localhost:4070/shops/crypto-app-test";
    for (const s of ["Crypto App Test", "crypto-app-test.myshopify.com", `${base}/products?q=`, `${base}/products/<product handle>`, `"url": "${base}/carts", "method": "POST"`, "variantId", "quantity", "checkoutUrl", "\"method\": \"POST\"", "402", "$25.00", "cart_already_paid", "fetch_url", "check_approval", "not instructions"]) {
      expect(docs, s).toContain(s);
    }
    expect(docs.indexOf("/products?q=")).toBeLessThan(docs.indexOf("/carts"));
    expect(docs.indexOf("/carts\"")).toBeLessThan(docs.indexOf("<checkoutUrl from the cart>"));
  });

  it("handoff (browse only): no payments, the owner gets Shopify's checkout link", () => {
    const m = shopifyManifest(HANDOFF_STORE, { bridgeUrl: "http://localhost:4070", maxPrice: "80.00" });
    expect(m).toMatchObject({
      id: "shopify-cool-socks",
      maxPrice: "0.00",
      pricing: "Browse only · you pay at Shopify checkout",
      permissions: ["Browse the Cool Socks catalog", "Build carts for you to check out at Shopify"],
      shopify: { mode: "handoff", domain: "cool-socks.myshopify.com" },
    });
    expect(m.docs).toContain("Do not fetch it and do not try to pay it");
    expect(m.docs).toContain("Finish checkout at Shopify");
    expect(m.docs).not.toContain("cart_already_paid");
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
    expect((await call("POST", "/services/shopify", { url: "crypto-app-test.myshopify.com" }, {})).status).toBe(401);
    expect((await call("POST", "/services/shopify", { url: "crypto-app-test.myshopify.com" }, { "x-owner-key": "wrong" })).status).toBe(401);
    expect(bridge.calls.length).toBe(0);

    const added = await call("POST", "/services/shopify", { url: "https://crypto-app-test.myshopify.com", maxPrice: "40" });
    expect(added.status).toBe(201);
    expect(added.body.service).toMatchObject({ id: "shopify-crypto-app-test", name: "Crypto App Test", maxPrice: "40.00", baseUrl: `${bridge.url}/shops/crypto-app-test`, shopify: { mode: "agent_checkout" } });
    expect(added.body.service.docs).toContain("checkoutUrl");
    expect(bridge.calls.at(-1)).toMatchObject({ method: "POST", path: "/stores", ownerKey: KEY, body: { url: "https://crypto-app-test.myshopify.com" } });

    const list = await call("GET", "/services");
    expect(list.body.services).toHaveLength(7);
    expect(list.body.services.at(-1)).toMatchObject({ id: "shopify-crypto-app-test" });
    expect(list.body.services.at(-1)).not.toHaveProperty("docs");
    expect((await call("GET", "/services?q=crypto")).body.services.map((s: ServiceManifest) => s.id)).toEqual(["shopify-crypto-app-test"]);
    expect((await call("GET", "/services?q=shopify")).body.services.map((s: ServiceManifest) => s.id)).toEqual(["shopify-crypto-app-test"]);
    expect((await call("GET", "/services?category=shopping")).body.services.map((s: ServiceManifest) => s.id)).toEqual(["acme-pizza", "shopify-crypto-app-test"]);
    expect((await call("GET", "/services/shopify-crypto-app-test")).body.docs).toContain("/products?q=");
    expect((await call("GET", "/health")).body).toEqual({ ok: true, services: 7 });
    const page = await call("GET", "/", undefined, {});
    expect(page.text).toContain("crypto-app-test.myshopify.com");
    expect(page.text).toContain("Agent checkout");

    // Same store again (any spelling): 409 service_exists with the existing entry.
    const again = await call("POST", "/services/shopify", { url: "shop.crypto.example" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "service_exists", service: { id: "shopify-crypto-app-test", maxPrice: "40.00" } });

    // Persisted: a fresh directory on the same data dir lists it.
    const file = JSON.parse(readFileSync(join(dataDir, "directory-extra.json"), "utf8"));
    expect(file).toMatchObject({ version: 1, shopify: [{ store: { handle: "crypto-app-test" }, maxPrice: "40.00" }] });
    const reopened = await start();
    expect((await reopened.call("GET", "/services/shopify-crypto-app-test")).body).toMatchObject({ maxPrice: "40.00", baseUrl: `${bridge.url}/shops/crypto-app-test` });
  });

  it("handoff stores, default cap, and the bridge's errors pass through", async () => {
    const { call } = await start({ dataDir: undefined });
    const handoff = await call("POST", "/services/shopify", { url: "cool-socks.myshopify.com" });
    expect(handoff.status).toBe(201);
    expect(handoff.body.service).toMatchObject({ id: "shopify-cool-socks", maxPrice: "0.00", pricing: "Browse only · you pay at Shopify checkout" });

    expect((await call("POST", "/services/shopify", {})).status).toBe(400);
    expect((await call("POST", "/services/shopify", { url: "crypto-app-test.myshopify.com", maxPrice: "1000.01" })).body.error).toBe("invalid_request");
    expect((await call("POST", "/services/shopify", { url: "crypto-app-test.myshopify.com", maxPrice: 5 })).status).toBe(400);
    expect(await call("POST", "/services/shopify", { url: "not a url at all" })).toMatchObject({ status: 400, body: { error: "invalid_store_url" } });
    expect(await call("POST", "/services/shopify", { url: "nobody-here.myshopify.com" })).toMatchObject({ status: 404, body: { error: "store_not_found" } });
    expect(await call("POST", "/services/shopify", { url: "euro-shop.myshopify.com" })).toMatchObject({ status: 422, body: { error: "store_unsupported" } });
    bridge.failWith = 500;
    try {
      expect(await call("POST", "/services/shopify", { url: "crypto-app-test.myshopify.com" })).toMatchObject({ status: 502, body: { error: "shopify_bridge_error" } });
    } finally {
      bridge.failWith = undefined;
    }
    const down = await start({ dataDir: undefined, shopifyBridgeUrl: "http://127.0.0.1:1" });
    expect(await down.call("POST", "/services/shopify", { url: "crypto-app-test.myshopify.com" })).toMatchObject({ status: 503, body: { error: "shopify_bridge_unavailable" } });
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
      expect((await call("GET", "/health")).body.services).toBe(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a keyless dev directory still refuses agent tokens; a broken extras file never stops it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allowance-directory-bad-"));
    try {
      writeFileSync(join(dir, "directory-extra.json"), "{ not json");
      // The keyed bridge refuses a keyless directory: a clear 502, nothing added.
      const keyless = await start({ dataDir: dir, ownerApiKey: undefined });
      expect((await keyless.call("GET", "/health")).body.services).toBe(6);
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
  });
});
