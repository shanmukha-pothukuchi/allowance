/**
 * Any service by link (docs/ARCHITECTURE.md §18): the wallet against the real directory app (its
 * catalog built on the MCP merchant stub, whose paid routes answer real x402 402s) and the stub
 * Shopify bridge, all on port 0. No Nessie key: the bank stays off.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startStubFacilitator } from "@allowance/wallet/testing";
import type { StubFacilitator } from "@allowance/wallet/testing";
import { USDC_BASE_SEPOLIA } from "@allowance/shared";
import type { AppConfig, Policy, X402PaymentRequired } from "@allowance/shared";
import { createApp } from "./app.js";
import type { WalletApp } from "./app.js";
import { isPrivateIp, probeX402Link } from "./link-probe.js";
import { createDirectoryApp } from "../../directory/src/app.js";
import { ALLBIRDS_STORE, EURO_STORE, PRIVATE_STORE, SOCKS_STORE, startStubBridge } from "../../directory/src/test-bridge.js";
import type { StubBridge } from "../../directory/src/test-bridge.js";
import { startMerchantStub } from "../../mcp/src/test-stubs.js";
import type { MerchantStub } from "../../mcp/src/test-stubs.js";

const KEY = "ok_link_wallet_test";
const OWNER = { "x-owner-key": KEY };
const CLOSED = { addresses: [], origins: [] };

let facilitator: StubFacilitator;
let bridge: StubBridge;
let merchant: MerchantStub;
let wallet: WalletApp;
let base: string;
let M: string; // merchant stub origin
let HOST: string;
const servers: Server[] = [];
const dirs: string[] = [];

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

async function call(method: string, path: string, opts: { body?: unknown; token?: string; owner?: boolean } = {}) {
  const res = await fetch(`${base}${path}`, {
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
const agentCall = (method: string, path: string, token: string, body?: unknown) => call(method, path, { token, body, owner: false });
const preview = (url: string) => call("GET", `/v1/directory/preview?url=${encodeURIComponent(url)}`);

async function createAgent(name: string, policy: Partial<Policy> = {}) {
  const r = await call("POST", "/v1/agents", {
    body: { name, policy: { allowlist: CLOSED, maxPerTx: "20.00", dailyCap: "100.00", approvalThreshold: "15.00", ...policy }, initialBalance: "50.00" },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { agent: { id: string; name: string }; token: string };
}

/** The stub's checkout route: a real 402 for "Allbirds order", $4.00. Not in the directory. */
const CHECKOUT = () => `${M}/shops/weareallbirds/carts/cart_1/checkout`;

beforeAll(async () => {
  for (const level of ["log", "warn"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  facilitator = await startStubFacilitator();
  merchant = await startMerchantStub();
  M = merchant.url;
  HOST = new URL(M).host;
  bridge = await startStubBridge({ ownerKey: KEY, stores: [ALLBIRDS_STORE, SOCKS_STORE, EURO_STORE, PRIVATE_STORE] });
  const directoryBase = await listen(
    createDirectoryApp({ merchantUrl: M, directoryUrl: "http://127.0.0.1:0", dataDir: tmp("allowance-link-dir-"), shopifyBridgeUrl: bridge.url, ownerApiKey: KEY }),
  );
  const config: AppConfig = {
    chainMode: "mock",
    repoRoot: process.cwd(),
    dataDir: tmp("allowance-link-wallet-"),
    facilitatorPort: 0,
    facilitatorUrl: facilitator.url,
    walletServicePort: 0,
    walletServiceUrl: "",
    merchantPort: 0,
    merchantUrl: M,
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
  wallet = createApp(config, { verifyChallenge: async () => ({ ok: true }) });
  base = await listen(wallet.app);
});

afterAll(async () => {
  wallet.close();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(() => r(null)))));
  await bridge.close();
  await merchant.close();
  await facilitator.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("owner: GET /v1/directory/preview (§18)", () => {
  it("a directory service's URL (under its baseUrl) is that service, with who has it", async () => {
    const a = await createAgent("pv-dir");
    await call("POST", `/v1/agents/${a.agent.id}/services`, { body: { serviceId: "acme-weather" } });
    const p = await preview(`${M}/api/weather?city=Paris`);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({ kind: "directory", service: { id: "acme-weather", name: "Acme Weather", baseUrl: `${M}/api/weather` } });
    expect(p.body.connectedAgents).toContain(a.agent.id);
    expect(p.body.service).not.toHaveProperty("docs");
  });

  it("a Shopify link is a store (bridge discovery), with the manifest it would get", async () => {
    const p = await preview("https://www.allbirds.com/products/mens-tree-runners");
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toMatchObject({
      kind: "shopify",
      listed: false,
      connectedAgents: [],
      store: { handle: "weareallbirds", name: "Allbirds", storefrontUrl: "https://www.allbirds.com", productCount: 692 },
      service: { id: "shopify-weareallbirds", name: "Allbirds", provider: "Shopify store", baseUrl: `${bridge.url}/shops/weareallbirds`, maxPrice: "100.00" },
    });
    expect(bridge.registered.size).toBe(0); // no side effects
  });

  it("an API that answers 402 with USDC on Base Sepolia is an x402 API, named by its challenge", async () => {
    const p = await preview(`${CHECKOUT()}?via=link`);
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body).toEqual({
      kind: "x402",
      price: "4.00",
      connectedAgents: [],
      service: expect.objectContaining({
        id: "custom-allbirds-order",
        name: "Allbirds order",
        provider: HOST,
        kind: "x402",
        summary: "Allbirds order",
        baseUrl: CHECKOUT(),
        maxPrice: "4.00",
        pricing: "$4.00 per request",
        permissions: [`Pay up to $4.00 per payment to Allbirds order (${HOST})`],
        source: "owner",
      }),
    });
  });

  it("errors: not payable (422 unrecognized_service_url), private targets, store refusals, bad input", async () => {
    const free = await preview(`${M}/free`);
    expect(free).toMatchObject({
      status: 422,
      body: {
        error: "unrecognized_service_url",
        message: "That link isn't something Allowance can pay: it's not in the directory, not a Shopify store, and it doesn't ask for payment over x402.",
        details: { reason: `${HOST} answered 200, not 402 Payment Required` },
      },
    });
    // Never probes a private address that isn't one of the configured services.
    expect(await preview("http://10.1.2.3/api/thing")).toMatchObject({ status: 422, body: { error: "unrecognized_service_url", details: { reason: "10.1.2.3 is a private address" } } });
    expect(await preview("http://localhost:1/x")).toMatchObject({ status: 422, body: { details: { reason: "localhost:1 is a private address" } } });
    expect(await preview("https://crypto-app-test.myshopify.com")).toMatchObject({ status: 422, body: { error: "store_unsupported", details: { reason: "private_catalog" } } });
    expect(await preview("https://admin.shopify.com/store/weareallbirds")).toMatchObject({ status: 400, body: { error: "invalid_store_url" } });
    expect(await call("GET", "/v1/directory/preview")).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(await preview("ftp://example.com/x")).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect((await call("GET", `/v1/directory/preview?url=${encodeURIComponent(CHECKOUT())}`, { owner: false })).status).toBe(401);
  });
});

describe("owner: POST /v1/directory/add (§18)", () => {
  it("x402: connected per agent as a custom service (owner), payable under its prefix, not listed", async () => {
    const a = await createAgent("add-x402");
    const b = await createAgent("add-x402-b");
    expect(await call("POST", "/v1/directory/add", { body: { url: CHECKOUT(), maxPrice: "1.00", connectTo: [a.agent.id] } })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect((await call("POST", "/v1/directory/add", { body: { url: CHECKOUT(), connectTo: ["agt_nobody"] } })).status).toBe(404);
    const r = await call("POST", "/v1/directory/add", { body: { url: CHECKOUT(), maxPrice: "6.00", connectTo: [a.agent.id] } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ kind: "x402", connected: [a.agent.id], service: { name: "Allbirds order", maxPrice: "6.00", pricing: "$4.00 per request · up to $6.00", source: "owner" } });

    const mine = (await agentCall("GET", "/v1/services", a.token)).body.connected;
    const svc = mine.find((s: { baseUrl: string }) => s.baseUrl === CHECKOUT());
    expect(svc).toMatchObject({ id: "custom-allbirds-order", source: "owner", connectedBy: "owner", maxPrice: "6.00", provider: HOST });
    const docs = await agentCall("GET", `/v1/directory/${svc.id}`, a.token);
    expect(docs.status).toBe(200);
    expect(docs.body).toMatchObject({ connected: true, source: "owner" });
    expect(docs.body.docs).toContain(`fetch_url: GET ${CHECKOUT()}`);
    expect((await agentCall("GET", "/v1/directory?q=allbirds", a.token)).body.services).toEqual([]);

    // The connection is what lets it pay: allowed for a, soft... unknown (and frozen) for b.
    const pr: X402PaymentRequired = {
      x402Version: 2,
      resource: { url: CHECKOUT(), description: "Allbirds order" },
      accepts: [{ scheme: "exact", network: "eip155:84532", asset: USDC_BASE_SEPOLIA, amount: "4000000", payTo: "0x2222222222222222222222222222222222222222", maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2" } }],
    };
    expect((await agentCall("POST", "/v1/pay", a.token, { url: CHECKOUT(), method: "POST", paymentRequired: pr })).status).toBe(200);
    const blocked = await agentCall("POST", "/v1/pay", b.token, { url: CHECKOUT(), method: "POST", paymentRequired: pr });
    expect(blocked.status).toBe(403);

    // Adding it again raises the cap in place; preview now lists a.
    expect((await call("POST", "/v1/directory/add", { body: { url: CHECKOUT(), maxPrice: "8.00", connectTo: [a.agent.id] } })).body.service.maxPrice).toBe("8.00");
    expect((await agentCall("GET", "/v1/services", a.token)).body.connected.filter((s: { baseUrl: string }) => s.baseUrl === CHECKOUT())).toEqual([expect.objectContaining({ maxPrice: "8.00" })]);
    expect((await preview(CHECKOUT())).body.connectedAgents).toEqual([a.agent.id]);
  });

  it("directory: connects it; shopify: adds the store to the directory, then connects it", async () => {
    const a = await createAgent("add-dir");
    const d = await call("POST", "/v1/directory/add", { body: { url: `${M}/api/news`, connectTo: [a.agent.id] } });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body).toMatchObject({ kind: "directory", service: { id: "acme-news" }, connected: [a.agent.id] });

    const s = await call("POST", "/v1/directory/add", { body: { url: "cool-socks.myshopify.com", maxPrice: "25", connectTo: [a.agent.id] } });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body).toMatchObject({ kind: "shopify", service: { id: "shopify-cool-socks", maxPrice: "25.00" }, connected: [a.agent.id] });
    expect(bridge.registered.has("cool-socks")).toBe(true);
    const ids = (await agentCall("GET", "/v1/services", a.token)).body.connected.map((x: { id: string }) => x.id);
    expect(ids).toEqual(expect.arrayContaining(["acme-news", "shopify-cool-socks"]));
    // Now listed: a later preview of the store says so.
    expect((await preview("cool-socks.myshopify.com")).body).toMatchObject({ kind: "shopify", listed: true, connectedAgents: [a.agent.id] });
    expect((await call("POST", "/v1/directory/add", { body: { url: `${M}/free`, connectTo: [a.agent.id] } })).status).toBe(422);
  });
});

describe("agent: POST /v1/services/requests { url } (§18)", () => {
  it("a directory link becomes a normal request; a connected one is already connected", async () => {
    const a = await createAgent("req-dir");
    await call("POST", `/v1/agents/${a.agent.id}/services`, { body: { serviceId: "acme-weather" } });
    const conn = await agentCall("POST", "/v1/services/requests", a.token, { url: `${M}/api/weather?city=Oslo`, reason: "weather" });
    expect(conn).toMatchObject({ status: 200, body: { status: "connected", service: { id: "acme-weather" } } });

    const r = await agentCall("POST", "/v1/services/requests", a.token, { url: `${M}/api/stock?symbol=ACME`, reason: "stocks" });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ status: "needs_approval", service: { id: "acme-stocks", source: "directory" } });
    expect(r.body.message).toBe(`Waiting for your owner to approve connecting Acme Stocks (${HOST}). Approval id ${r.body.approvalId}.`);
    const again = await agentCall("POST", "/v1/services/requests", a.token, { serviceId: "acme-stocks" });
    expect(again.body.approvalId).toBe(r.body.approvalId);
  });

  it("a Shopify link uses the store path (a new store is proposed for adding)", async () => {
    const a = await createAgent("req-shop");
    const r = await agentCall("POST", "/v1/services/requests", a.token, { url: "https://www.allbirds.com/products/x", maxPrice: "12.00", reason: "socks" });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ service: { id: "shopify-weareallbirds", source: "agent", maxPrice: "12.00", shopify: { handle: "weareallbirds" } } });
    expect(r.body.message).toContain("adding the Shopify store Allbirds (allbirds.com)");
    // The alias still works and lands on the same approval.
    const alias = await agentCall("POST", "/v1/services/requests", a.token, { shopifyStoreUrl: "allbirds.com", maxPrice: "12.00" });
    expect(alias.body.approvalId).toBe(r.body.approvalId);
    expect(await agentCall("POST", "/v1/services/requests", a.token, { url: "euro-shop.myshopify.com" })).toMatchObject({ status: 422, body: { error: "store_unsupported" } });
  });

  it("an x402 link becomes a custom proposal at the challenge price; approval connects it with docs", async () => {
    const a = await createAgent("req-x402");
    const r = await agentCall("POST", "/v1/services/requests", a.token, { url: CHECKOUT(), reason: "buy socks" });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({
      status: "needs_approval",
      service: { id: "custom-allbirds-order", name: "Allbirds order", provider: HOST, source: "agent", maxPrice: "4.00", baseUrl: CHECKOUT() },
    });
    expect(r.body.message).toBe(`Waiting for your owner to approve connecting Allbirds order (${HOST}). Approval id ${r.body.approvalId}.`);
    const approval = (await call("GET", "/v1/approvals")).body.approvals.find((x: { id: string }) => x.id === r.body.approvalId);
    expect(approval).toMatchObject({ kind: "service", amount: "4.00", reason: "buy socks", description: "Connect Allbirds order (proposed by req-x402)" });

    const same = await agentCall("POST", "/v1/services/requests", a.token, { url: `${CHECKOUT()}?again=1` });
    expect(same.body.approvalId).toBe(r.body.approvalId);

    expect((await call("POST", `/v1/approvals/${r.body.approvalId}/approve`, { body: { by: "dashboard" } })).status).toBe(200);
    const wait = await agentCall("GET", `/v1/approvals/${r.body.approvalId}/wait?timeoutMs=0`, a.token);
    expect(wait.body).toMatchObject({ status: "approved", kind: "service", service: { id: "custom-allbirds-order", connectedBy: "approval" } });
    const docs = await agentCall("GET", "/v1/directory/custom-allbirds-order", a.token);
    expect(docs.body.docs).toContain("charges over x402");
    expect(await agentCall("POST", "/v1/services/requests", a.token, { url: CHECKOUT() })).toMatchObject({ status: 200, body: { status: "connected", service: { id: "custom-allbirds-order" } } });
  });

  it("errors: over maxPerTx, unrecognized, more than one target", async () => {
    const a = await createAgent("req-err");
    const over = await agentCall("POST", "/v1/services/requests", a.token, { url: `${M}/api/expensive` });
    expect(over.status).toBe(400);
    expect(over.body.message).toBe(`Gold Plated API (${HOST}) asks $50.00 per request, over this agent's $20.00 per-payment limit. Ask your owner to raise the limit or to add it from the dashboard.`);
    expect(await agentCall("POST", "/v1/services/requests", a.token, { url: `${M}/free` })).toMatchObject({ status: 422, body: { error: "unrecognized_service_url" } });
    expect(await agentCall("POST", "/v1/services/requests", a.token, { url: CHECKOUT(), serviceId: "acme-news" })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(await agentCall("POST", "/v1/services/requests", a.token, { url: 42 })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    // Agents can't use the owner endpoints.
    expect((await call("GET", `/v1/directory/preview?url=${encodeURIComponent(CHECKOUT())}`, { token: a.token, owner: false })).status).toBe(401);
  });
});

describe("link probe", () => {
  it("private address checks", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) expect(isPrivateIp(ip), ip).toBe(false);
  });

  it("checks every redirect hop, ignores other networks, times out", async () => {
    const opts = { network: "eip155:84532", asset: USDC_BASE_SEPOLIA, allowOrigins: [], resolve: async () => ["93.184.216.34"] };
    const redirect = (async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/x" } })) as unknown as typeof fetch;
    expect(await probeX402Link("https://api.example.com/x", { ...opts, fetch: redirect })).toEqual({ ok: false, reason: "127.0.0.1:9 is a private address" });
    const rebinding = { ...opts, resolve: async () => ["10.0.0.7"] };
    expect(await probeX402Link("https://evil.example.com/x", rebinding)).toEqual({ ok: false, reason: "evil.example.com resolves to a private address" });
    const otherChain = (async () =>
      new Response(JSON.stringify({ x402Version: 2, resource: { url: "x" }, accepts: [{ scheme: "exact", network: "eip155:8453", asset: USDC_BASE_SEPOLIA, amount: "1", payTo: "0x1", maxTimeoutSeconds: 60, extra: {} }] }), { status: 402 })) as unknown as typeof fetch;
    expect(await probeX402Link("https://api.example.com/x", { ...opts, fetch: otherChain })).toEqual({ ok: false, reason: "api.example.com asks for payment, but not in USDC on eip155:84532" });
    const hang = ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    expect(await probeX402Link("https://api.example.com/x", { ...opts, fetch: hang, timeoutMs: 50 })).toEqual({ ok: false, reason: "api.example.com did not answer in time" });
  });
});
