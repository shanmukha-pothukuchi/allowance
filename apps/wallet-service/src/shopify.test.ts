/**
 * Shopify stores as services (docs/ARCHITECTURE.md §15.3): the wallet against the real directory app
 * and a stub Shopify bridge, all on port 0.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startStubFacilitator } from "@allowance/wallet/testing";
import type { StubFacilitator } from "@allowance/wallet/testing";
import { USDC_BASE_SEPOLIA, toBaseUnits } from "@allowance/shared";
import type { AppConfig, Policy, ShopifyStore, WalletEvent, X402PaymentRequired } from "@allowance/shared";
import { createApp } from "./app.js";
import type { WalletApp } from "./app.js";
import { createDirectoryApp } from "../../directory/src/app.js";
import { buildCatalog } from "../../directory/src/catalog.js";
import { ALLBIRDS_STORE, EURO_STORE, PRIVATE_STORE, SOCKS_STORE, startStubBridge } from "../../directory/src/test-bridge.js";
import type { StubBridge } from "../../directory/src/test-bridge.js";

const KEY = "ok_shopify_wallet_test";
const MERCHANT = "http://localhost:4021";
const PAY_TO = "0x7777777777777777777777777777777777777777";
const GEAR: ShopifyStore = {
  handle: "agent-gear",
  domain: "agent-gear.myshopify.com",
  storefrontUrl: "https://www.agentgear.example",
  cardCheckout: true,
  name: "Agent Gear",
  currency: "USD",
  productCount: 3,
};
const CLOSED = { addresses: [], origins: [] };

let facilitator: StubFacilitator;
let bridge: StubBridge;
let wallet: WalletApp;
let baseConfig: AppConfig;
const servers: Server[] = [];
const dirs: string[] = [];
let base: string;
let directoryBase: string;

const OWNER = { "x-owner-key": KEY };

async function listen(app: { listen: (port: number, host: string, cb: () => void) => Server }): Promise<string> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function call(method: string, path: string, opts: { body?: unknown; token?: string; owner?: boolean; at?: string } = {}) {
  const res = await fetch(`${opts.at ?? base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.owner === false ? {} : OWNER),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}
/** Agent call: bearer token, no owner key. */
const agentCall = (method: string, path: string, token: string, body?: unknown) => call(method, path, { token, body, owner: false });

async function createAgent(name: string, policy: Partial<Policy>) {
  const r = await call("POST", "/v1/agents", { body: { name, policy: { allowlist: CLOSED, ...policy }, initialBalance: "100.00" } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { agent: { id: string; name: string }; token: string };
}

function checkout(handle: string, amount: string, cart = "cart_1"): { paymentRequired: X402PaymentRequired; url: string; method: "POST" } {
  const url = `${bridge.url}/shops/${handle}/carts/${cart}/checkout`;
  return {
    url,
    method: "POST",
    paymentRequired: {
      x402Version: 2,
      resource: { url, description: "Store order" },
      accepts: [{ scheme: "exact", network: "eip155:84532", asset: USDC_BASE_SEPOLIA, amount: toBaseUnits(amount).toString(), payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }],
    },
  };
}

async function events(): Promise<WalletEvent[]> {
  return (await call("GET", "/v1/events/recent?limit=500")).body.events;
}

beforeAll(async () => {
  for (const level of ["log", "warn"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  facilitator = await startStubFacilitator();
  bridge = await startStubBridge({ ownerKey: KEY, stores: [ALLBIRDS_STORE, SOCKS_STORE, EURO_STORE, PRIVATE_STORE, GEAR], aliases: { "agentgear.example": "agent-gear", "www.agentgear.example": "agent-gear" } });
  directoryBase = await listen(createDirectoryApp({ merchantUrl: MERCHANT, directoryUrl: "http://127.0.0.1:0", dataDir: tmp("allowance-shopify-dir-"), shopifyBridgeUrl: bridge.url, ownerApiKey: KEY }));
  baseConfig = {
    chainMode: "mock",
    repoRoot: process.cwd(),
    dataDir: tmp("allowance-shopify-wallet-"),
    facilitatorPort: 0,
    facilitatorUrl: facilitator.url,
    walletServicePort: 0,
    walletServiceUrl: "",
    merchantPort: 4021,
    merchantUrl: MERCHANT,
    dashboardPort: 4040,
    directoryPort: 0,
    directoryUrl: directoryBase,
    baseSepoliaRpcUrl: "http://127.0.0.1:1",
    x402FacilitatorUrl: facilitator.url,
    network: "eip155:84532",
    usdcAddress: USDC_BASE_SEPOLIA,
    agentChatPort: 0,
    agentChatHost: "127.0.0.1",
    agentChatUrl: "",
    llm: { baseUrl: "http://127.0.0.1:1", model: "test" },
    shopifyBridgePort: 0,
    shopifyBridgeUrl: bridge.url,
    shopify: { apiVersion: "2026-10" },
    // No Nessie key: the bank stays off and nothing here talks to Capital One.
    nessie: { baseUrl: "https://api.nessieisreal.com", openingBalance: "5000.00" },
    quantcommBridgePort: 0,
    quantcommBridgeUrl: "http://127.0.0.1:1",
    quantcommUrl: "http://127.0.0.1:1",
    computerUsePort: 4090,
    computerUseUrl: "http://127.0.0.1:1",
    brokeragePort: 0,
    brokerageUrl: "http://127.0.0.1:1",
    schedulerPort: 0,
    schedulerUrl: "http://127.0.0.1:1",
    ownerApiKey: KEY,
  };
  wallet = createApp(baseConfig, { verifyChallenge: async () => ({ ok: true }) });
  base = await listen(wallet.app);
});

afterAll(async () => {
  wallet.close();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))));
  await bridge.close();
  await facilitator.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("owner: preview and add a Shopify store (§15.3)", () => {
  it("preview is bridge discovery: the store, its service id, whether it is listed; errors pass through", async () => {
    const p = await call("GET", `/v1/directory/shopify/preview?url=${encodeURIComponent("https://www.allbirds.com/products/mens-tree-runners")}`);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({
      name: "Allbirds",
      currency: "USD",
      productCount: 692,
      domain: "weareallbirds.myshopify.com",
      storefrontUrl: "https://www.allbirds.com",
      cardCheckout: true,
      sampleImages: ALLBIRDS_STORE.sampleImages,
      serviceId: "shopify-weareallbirds",
      existing: null,
    });
    expect(p.body).not.toHaveProperty("mode");
    expect(p.body.store).toMatchObject({ handle: "weareallbirds", storefrontUrl: "https://www.allbirds.com" });
    expect(bridge.registered.size).toBe(0); // no side effects

    expect((await call("GET", "/v1/directory/shopify/preview?url=allbirds.com", { owner: false })).status).toBe(401);
    expect(await call("GET", "/v1/directory/shopify/preview")).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(await call("GET", "/v1/directory/shopify/preview?url=%20nope%20at%20all")).toMatchObject({ status: 400, body: { error: "invalid_store_url" } });
    expect(await call("GET", "/v1/directory/shopify/preview?url=ghost.myshopify.com")).toMatchObject({ status: 404, body: { error: "store_not_found" } });
    expect(await call("GET", "/v1/directory/shopify/preview?url=euro-shop.myshopify.com")).toMatchObject({ status: 422, body: { error: "store_unsupported", details: { reason: "currency" } } });
    expect(await call("GET", "/v1/directory/shopify/preview?url=crypto-app-test.myshopify.com")).toMatchObject({
      status: 422,
      body: { error: "store_unsupported", message: "This store's catalog isn't public yet (it's password-protected), so agents can't browse it.", details: { reason: "private_catalog" } },
    });
    expect(await call("GET", `/v1/directory/shopify/preview?url=${encodeURIComponent("https://admin.shopify.com/store/weareallbirds")}`)).toMatchObject({ status: 400, body: { error: "invalid_store_url" } });
    const offline = createApp({ ...baseConfig, dataDir: tmp("allowance-shopify-nobridge-"), shopifyBridgeUrl: "http://127.0.0.1:1" });
    try {
      const at = await listen(offline.app);
      expect(await call("GET", "/v1/directory/shopify/preview?url=allbirds.com", { at })).toMatchObject({ status: 503, body: { error: "shopify_bridge_unavailable" } });
    } finally {
      offline.close();
    }
  });

  it("add: the directory registers it with the bridge, agents in connectTo are connected, and no cache hides it", async () => {
    const buyer = await createAgent("shop-buyer", { maxPerTx: "50.00", dailyCap: "200.00", approvalThreshold: "40.00" });
    const other = await createAgent("shop-other", { maxPerTx: "50.00", dailyCap: "200.00", approvalThreshold: "40.00" });
    // Fill the wallet's 30 s listing cache before the store exists.
    const catalogSize = buildCatalog({ merchantUrl: MERCHANT, directoryUrl: directoryBase }).length;
    expect((await agentCall("GET", "/v1/directory", buyer.token)).body.services).toHaveLength(catalogSize);

    const before = bridge.calls.length;
    expect(await call("POST", "/v1/directory/shopify", { body: { url: "allbirds.com", connectTo: ["agt_nobody"] } })).toMatchObject({ status: 404 });
    expect(bridge.calls.length).toBe(before); // a bad agent id adds nothing
    expect((await call("POST", "/v1/directory/shopify", { body: { url: "allbirds.com", maxPrice: "nope" } })).status).toBe(400);
    expect((await call("POST", "/v1/directory/shopify", { body: { url: "allbirds.com", connectTo: "x" } })).status).toBe(400);
    expect((await call("POST", "/v1/directory/shopify", { body: { url: "allbirds.com" }, token: buyer.token, owner: false })).status).toBe(401);

    const add = await call("POST", "/v1/directory/shopify", { body: { url: "https://allbirds.com", maxPrice: "30", connectTo: [buyer.agent.id] } });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body).toMatchObject({
      created: true,
      connectedAgents: [buyer.agent.id],
      service: {
        id: "shopify-weareallbirds",
        name: "Allbirds",
        provider: "Shopify store",
        icon: "🛍️",
        kind: "x402",
        maxPrice: "30.00",
        pricing: "Store prices · paid with your Allowance card · up to $30.00 per order",
        baseUrl: `${bridge.url}/shops/weareallbirds`,
        shopify: { handle: "weareallbirds", storefrontUrl: "https://www.allbirds.com", cardCheckout: true },
      },
    });
    expect(bridge.registered.has("weareallbirds")).toBe(true);
    expect(bridge.calls.find((c) => c.method === "POST" && c.path === "/stores")?.ownerKey).toBe(KEY);

    // Visible at once (the listing cache was cleared), marked connected for the buyer only.
    const listing = (await agentCall("GET", "/v1/directory", buyer.token)).body.services;
    expect(listing.find((s: { id: string }) => s.id === "shopify-weareallbirds")).toMatchObject({ connected: true, shopify: { domain: "weareallbirds.myshopify.com", storefrontUrl: "https://www.allbirds.com" } });
    expect((await agentCall("GET", "/v1/directory?q=allbirds", other.token)).body.services).toEqual([expect.objectContaining({ id: "shopify-weareallbirds", connected: false })]);
    const docs = await agentCall("GET", "/v1/directory/shopify-weareallbirds", buyer.token);
    expect(docs.body.docs).toContain("/carts");
    expect(docs.body.connected).toBe(true);
    const connected = (await agentCall("GET", "/v1/services", buyer.token)).body.connected;
    expect(connected).toEqual([
      expect.objectContaining({
        id: "shopify-weareallbirds",
        connectedBy: "owner",
        maxPrice: "30.00",
        pricing: "Store prices · paid with your Allowance card · up to $30.00 per order",
        shopify: { handle: "weareallbirds", domain: "weareallbirds.myshopify.com", storefrontUrl: "https://www.allbirds.com", cardCheckout: true },
      }),
    ]);
    // The agent reads its own cap in the docs and summary.
    expect(docs.body.summary).toContain("up to $30.00 per order");
    expect(docs.body.docs).toContain("up to $30.00 per order");
    expect((await events()).find((e) => e.type === "service.connected" && e.agentId === buyer.agent.id)?.message).toBe("Allbirds connected to shop-buyer.");

    // Payments to the store follow the normal rules: connected prefix, store cap, no freeze for the cap.
    expect((await agentCall("POST", "/v1/pay", buyer.token, checkout("weareallbirds", "12.00"))).status).toBe(200);
    const over = await agentCall("POST", "/v1/pay", buyer.token, checkout("weareallbirds", "31.00", "cart_2"));
    expect(over.body).toMatchObject({ status: "blocked", reason: "service_cap", frozen: false });
    // Not connected: a soft block naming the store (the directory lists it right away).
    const soft = await agentCall("POST", "/v1/pay", other.token, checkout("weareallbirds", "12.00", "cart_3"));
    expect(soft.body).toMatchObject({ status: "blocked", reason: "service_not_connected", frozen: false, serviceId: "shopify-weareallbirds" });

    // Adding it again is fine: the existing entry, and connectTo still connects.
    const again = await call("POST", "/v1/directory/shopify", { body: { url: "allbirds.com", connectTo: [other.agent.id] } });
    expect(again).toMatchObject({ status: 200, body: { created: false, service: { id: "shopify-weareallbirds", maxPrice: "30.00" } } });
    expect(again.body.connectedAgents.sort()).toEqual([buyer.agent.id, other.agent.id].sort());

    // The preview now says it is listed, and who has it.
    const p = await call("GET", "/v1/directory/shopify/preview?url=allbirds.com");
    expect(p.body.existing).toMatchObject({ id: "shopify-weareallbirds" });
    expect(p.body.existing).not.toHaveProperty("docs");
    expect(p.body.existing.connectedAgents.sort()).toEqual([buyer.agent.id, other.agent.id].sort());
    const owner = (await call("GET", "/v1/directory/shopify-weareallbirds")).body;
    expect(owner.connectedAgents).toHaveLength(2);
  });
});

describe("agent: request a Shopify store by link (§15.3)", () => {
  it("a store not in the directory → the owner is asked to add it; approval adds and connects it", async () => {
    const c = await createAgent("shop-c", { maxPerTx: "25.00", dailyCap: "100.00", approvalThreshold: "30.00" });
    const reason = "The owner wants agent stickers.";
    const req = await agentCall("POST", "/v1/services/requests", c.token, { shopifyStoreUrl: "https://www.agentgear.example/products/sticker", reason });
    expect(req.status, JSON.stringify(req.body)).toBe(202);
    expect(req.body).toMatchObject({
      status: "needs_approval",
      service: {
        id: "shopify-agent-gear",
        name: "Agent Gear",
        provider: "Shopify store",
        source: "agent",
        kind: "x402",
        category: "shopping",
        maxPrice: "25.00", // the agent's max per payment
        baseUrl: `${bridge.url}/shops/agent-gear`,
        pricing: "Store prices · paid with your Allowance card · up to $25.00 per order",
        permissions: ["Browse Agent Gear's catalog", "Pay up to $25.00 per order with a single-use Allowance card", "Place orders on your behalf"],
        shopify: { handle: "agent-gear", domain: "agent-gear.myshopify.com", storefrontUrl: "https://www.agentgear.example", cardCheckout: true },
      },
    });
    expect(req.body.message).toBe(`Waiting for your owner to approve adding the Shopify store Agent Gear (agentgear.example). Approval id ${req.body.approvalId}.`);
    expect(req.body.service).not.toHaveProperty("docs");
    const approvalId: string = req.body.approvalId;
    // Same store by another spelling while pending: the same approval.
    expect((await agentCall("POST", "/v1/services/requests", c.token, { shopifyStoreUrl: "agent-gear.myshopify.com", reason })).body.approvalId).toBe(approvalId);

    const pending = (await call("GET", "/v1/approvals?status=pending")).body.approvals.find((a: { id: string }) => a.id === approvalId);
    expect(pending).toMatchObject({ kind: "service", amount: "25.00", reason, description: "Add the Shopify store Agent Gear (agentgear.example)", service: { source: "agent", shopify: { storefrontUrl: "https://www.agentgear.example" } } });
    const requested = (await events()).find((e) => e.type === "service.requested" && e.approval?.id === approvalId);
    expect(requested?.message).toBe("shop-c wants to add the Shopify store Agent Gear (agentgear.example).");
    expect(requested?.data).toMatchObject({ custom: false, newStore: true, shopify: { domain: "agent-gear.myshopify.com", storefrontUrl: "https://www.agentgear.example" }, service: { id: "shopify-agent-gear" } });
    expect(JSON.stringify(requested)).not.toMatch(/admin\.shopify|"mode"/);
    // Nothing is added before the owner says yes.
    expect(bridge.registered.has("agent-gear")).toBe(false);
    expect((await agentCall("GET", "/v1/directory/shopify-agent-gear", c.token)).status).toBe(404);

    // The bridge fails during approval: an error for the owner, and the approval stays pending.
    bridge.failWith = 500;
    try {
      const failed = await call("POST", `/v1/approvals/${approvalId}/approve`, { body: { by: "dashboard" } });
      expect(failed).toMatchObject({ status: 502, body: { error: "shopify_bridge_error" } });
    } finally {
      bridge.failWith = undefined;
    }
    expect(wallet.store.approvalById(approvalId)?.status).toBe("pending");

    const waiting = agentCall("GET", `/v1/approvals/${approvalId}/wait?timeoutMs=10000`, c.token);
    await new Promise((r) => setTimeout(r, 30));
    const ok = await call("POST", `/v1/approvals/${approvalId}/approve`, { body: { by: "telegram" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const done = await waiting;
    expect(done.body).toMatchObject({ kind: "service", status: "approved", service: { id: "shopify-agent-gear", connectedBy: "approval", source: "directory", maxPrice: "25.00", shopify: { cardCheckout: true } } });

    // Now in the directory (registered with the bridge by the directory, owner key), with docs.
    expect(bridge.registered.has("agent-gear")).toBe(true);
    const listed = await agentCall("GET", "/v1/directory/shopify-agent-gear", c.token);
    expect(listed.body).toMatchObject({ id: "shopify-agent-gear", maxPrice: "25.00", connected: true, source: "directory" });
    expect(listed.body.docs).toContain("checkoutUrl");
    expect((await events()).find((e) => e.type === "service.connected" && e.agentId === c.agent.id)?.data).toMatchObject({ connectedBy: "approval", approvalId });
    // Asking again: already connected.
    expect(await agentCall("POST", "/v1/services/requests", c.token, { shopifyStoreUrl: "agent-gear.myshopify.com" })).toMatchObject({ status: 200, body: { status: "connected", service: { id: "shopify-agent-gear" } } });
    // And the agent can pay an order up to the cap.
    expect((await agentCall("POST", "/v1/pay", c.token, checkout("agent-gear", "24.00"))).status).toBe(200);

    // Another agent asking for the same store now gets a normal request with the directory's cap.
    const d = await createAgent("shop-d", { maxPerTx: "5.00", dailyCap: "20.00", approvalThreshold: "5.00" });
    const normal = await agentCall("POST", "/v1/services/requests", d.token, { shopifyStoreUrl: "agent-gear.myshopify.com", maxPrice: "1.00" });
    expect(normal.status).toBe(202);
    expect(normal.body.service).toMatchObject({ id: "shopify-agent-gear", source: "directory", maxPrice: "25.00" });
    expect(normal.body.message).toBe(`Waiting for your owner to approve connecting Agent Gear. Approval id ${normal.body.approvalId}.`);
    const card = wallet.store.approvalById(normal.body.approvalId)!;
    expect(card.description).toBe("Connect Agent Gear (agentgear.example)");
    expect((await events()).find((e) => e.type === "service.requested" && e.approval?.id === card.id)).toMatchObject({ message: "shop-d wants to connect Agent Gear.", data: { newStore: false, custom: false } });
    // Asking for it by id works the same.
    expect((await agentCall("POST", "/v1/services/requests", d.token, { serviceId: "shopify-agent-gear" })).body.approvalId).toBe(card.id);
  });

  it("stores without agent card checkout are payable up to their cap too; caps and inputs are validated before the bridge is called", async () => {
    const e = await createAgent("shop-e", { maxPerTx: "10.00", dailyCap: "50.00", approvalThreshold: "10.00" });
    const before = bridge.calls.length;
    for (const body of [
      { shopifyStoreUrl: "agent-gear.myshopify.com", serviceId: "acme-pizza" },
      { shopifyStoreUrl: 42 },
      { shopifyStoreUrl: "" },
      { shopifyStoreUrl: "agent-gear.myshopify.com", maxPrice: "abc" },
      { shopifyStoreUrl: "agent-gear.myshopify.com", maxPrice: "10.01" },
      { shopifyStoreUrl: "agent-gear.myshopify.com", maxPrice: 5 },
    ]) {
      const r = await agentCall("POST", "/v1/services/requests", e.token, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toBe("invalid_request");
    }
    expect(bridge.calls.length).toBe(before);
    expect(await agentCall("POST", "/v1/services/requests", e.token, { shopifyStoreUrl: "ghost.myshopify.com" })).toMatchObject({ status: 404, body: { error: "store_not_found" } });
    expect(await agentCall("POST", "/v1/services/requests", e.token, { shopifyStoreUrl: "euro-shop.myshopify.com" })).toMatchObject({ status: 422, body: { error: "store_unsupported" } });
    expect(await agentCall("POST", "/v1/services/requests", e.token, { shopifyStoreUrl: "what is this" })).toMatchObject({ status: 400, body: { error: "invalid_store_url" } });

    const socks = await agentCall("POST", "/v1/services/requests", e.token, { shopifyStoreUrl: "https://cool-socks.myshopify.com", maxPrice: "4.00", reason: "Socks for the owner" });
    expect(socks.status).toBe(202);
    expect(socks.body.service).toMatchObject({
      id: "shopify-cool-socks",
      source: "agent",
      maxPrice: "4.00",
      pricing: "Store prices · paid with your Allowance card · up to $4.00 per order",
      shopify: { cardCheckout: false, storefrontUrl: "https://cool-socks.myshopify.com" },
    });
    expect(wallet.store.approvalById(socks.body.approvalId)).toMatchObject({ amount: "4.00", description: "Add the Shopify store Cool Socks (cool-socks.myshopify.com)" });
    // A password-protected store: the plain reason, passed through.
    expect(await agentCall("POST", "/v1/services/requests", e.token, { shopifyStoreUrl: "crypto-app-test.myshopify.com" })).toMatchObject({
      status: 422,
      body: { error: "store_unsupported", details: { reason: "private_catalog" } },
    });

    const offline = createApp({ ...baseConfig, dataDir: tmp("allowance-shopify-nobridge2-"), shopifyBridgeUrl: "http://127.0.0.1:1" }, { store: wallet.store, settlement: wallet.settlement });
    try {
      const at = await listen(offline.app);
      const r = await call("POST", "/v1/services/requests", { at, token: e.token, owner: false, body: { shopifyStoreUrl: "cool-socks.myshopify.com" } });
      expect(r).toMatchObject({ status: 503, body: { error: "shopify_bridge_unavailable" } });
    } finally {
      offline.close();
    }
  });

  it("a denied store request adds nothing", async () => {
    const f = await createAgent("shop-f", { maxPerTx: "10.00", dailyCap: "50.00", approvalThreshold: "10.00" });
    bridge.known.set("deny-me", { handle: "deny-me", domain: "deny-me.myshopify.com", storefrontUrl: "https://deny-me.myshopify.com", cardCheckout: true, name: "Deny Me", currency: "USD" });
    const req = await agentCall("POST", "/v1/services/requests", f.token, { shopifyStoreUrl: "deny-me.myshopify.com" });
    expect((await call("POST", `/v1/approvals/${req.body.approvalId}/deny`, { body: { by: "dashboard" } })).status).toBe(200);
    expect((await agentCall("GET", `/v1/approvals/${req.body.approvalId}/wait?timeoutMs=0`, f.token)).body).toMatchObject({ status: "denied", service: { id: "shopify-deny-me", source: "agent" } });
    expect(bridge.registered.has("deny-me")).toBe(false);
    expect((await call("GET", "/v1/directory/shopify-deny-me")).status).toBe(404);
    expect((await agentCall("GET", "/v1/services", f.token)).body.connected).toEqual([]);
  });
});
