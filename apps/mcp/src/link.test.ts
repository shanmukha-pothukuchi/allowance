/**
 * request_service by link (ARCHITECTURE §18): directory links, Shopify links (unchanged store texts),
 * x402 APIs (the merchant stub's paid routes answer real 402s) and links Allowance can't pay.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { startMerchantStub, startWalletStub, type MerchantStub, type WalletStub } from "./test-stubs.js";

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");

let wallet: WalletStub;
let merchant: MerchantStub;
let HOST: string;
const closers: (() => Promise<void>)[] = [];

async function connect(token: string, approvalWaitMs = 100, logs?: string[]) {
  const server = createServer({ walletServiceUrl: wallet.url, agentToken: token, approvalWaitMs, log: (m) => logs?.push(m) });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, call: async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult };
}

beforeAll(async () => {
  wallet = await startWalletStub({ approveUpTo: 5, blockAbove: 10, autoApproveAfterMs: null });
  merchant = await startMerchantStub();
  wallet.merchantUrl = merchant.url;
  HOST = new URL(merchant.url).host;
});
afterAll(async () => {
  for (const c of closers) await c();
  await wallet.close();
  await merchant.close();
});
beforeEach(() => {
  wallet.autoApproveAfterMs = null;
});

const checkout = () => `${merchant.url}/shops/weareallbirds/carts/cart_1/checkout`;

describe("request_service { url } (§18)", () => {
  it("the schema and descriptions point agents at url for anything outside the directory", async () => {
    const { client } = await connect(wallet.addToken("link-schema", []));
    const tools = (await client.listTools()).tools;
    const req = tools.find((t) => t.name === "request_service")!;
    const props = req.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.url.description).toMatch(/^The link to anything not in the directory: a Shopify store .* or any API that charges over x402/);
    expect(props.shopify_store_url).toBeDefined();
    expect(req.inputSchema.required).toEqual(["reason"]);
    expect(req.description).toMatch(/Pass a service_id from the directory, or the link to anything else as url: a Shopify store or any API that charges over x402/);
    expect(tools.find((t) => t.name === "search_services")!.description).toMatch(/pass it as request_service \{ url \} \(any Shopify store, or any API that charges over x402\)/);
  });

  it("an x402 API: pending names it and its host and keeps the service_id sentence; approval connects it", async () => {
    const logs: string[] = [];
    const token = wallet.addToken("link-x402", []);
    const c = await connect(token, 100, logs);
    const r = await c.call("request_service", { url: checkout(), reason: "Pay for the socks." });
    expect(r.isError).toBeFalsy();
    const approvalId = r.structuredContent?.approvalId as string;
    expect(textOf(r)).toBe(
      `Asked your owner to connect Allbirds order (${HOST}). Approval id ${approvalId} — call check_approval to resume. Once approved, call get_service { service_id: "custom-allbirds-order" } for how to use it. Tell the user their phone/dashboard has a request to connect Allbirds order.`,
    );
    expect(r.structuredContent).toMatchObject({ status: "pending", kind: "service", service: { id: "custom-allbirds-order", provider: HOST, maxPrice: "4.00", source: "agent" } });
    expect(wallet.serviceRequests.at(-1)).toEqual({ url: checkout(), reason: "Pay for the socks." });
    expect(logs).toContain(`service request needs approval ${approvalId}; waiting 100 ms`);

    expect(textOf(await c.call("check_approval", { approval_id: approvalId }))).toBe(
      `Waiting for the owner to approve connecting Allbirds order (${HOST}). Approval id ${approvalId} — call check_approval to resume. Once approved, call get_service { service_id: "custom-allbirds-order" } for how to use it. Tell the user their phone/dashboard has a request to connect Allbirds order.`,
    );
    wallet.approve(approvalId);
    const done = await c.call("check_approval", { approval_id: approvalId });
    expect(textOf(done)).toBe(`Owner connected Allbirds order (${HOST}). Call get_service { service_id: "custom-allbirds-order" } for how to use it.`);
    expect(done.structuredContent).toMatchObject({ status: "connected", kind: "service" });

    const again = await c.call("request_service", { url: `${checkout()}?x=1`, reason: "again" });
    expect(textOf(again)).toBe(`Allbirds order (${HOST}) is already connected. Call get_service { service_id: "custom-allbirds-order" } for how to use it.`);
  });

  it("approved while waiting says Connected …; denied names the host too", async () => {
    wallet.autoApproveAfterMs = 20;
    const c = await connect(wallet.addToken("link-auto", []), 500);
    const r = await c.call("request_service", { url: `${merchant.url}/api/stock?symbol=ACME`, reason: "quotes" });
    expect(textOf(r)).toBe(`Connected Acme Stocks (${HOST}). Call get_service { service_id: "acme-stocks" } for how to use it.`);
    expect(wallet.serviceRequests.at(-1)).toEqual({ url: `${merchant.url}/api/stock?symbol=ACME`, reason: "quotes" });

    wallet.autoApproveAfterMs = null;
    const d = await connect(wallet.addToken("link-deny", []), 50);
    const p = await d.call("request_service", { url: checkout(), reason: "x" });
    const approvalId = p.structuredContent?.approvalId as string;
    wallet.deny(approvalId);
    expect(textOf(await d.call("check_approval", { approval_id: approvalId }))).toBe(
      `The owner denied connecting Allbirds order (${HOST}). It is not connected; do not use it, and do not ask again unless the user wants you to.`,
    );
  });

  it("a directory link that is already connected", async () => {
    const c = await connect(wallet.addToken("link-dir", ["acme-weather"]));
    const r = await c.call("request_service", { url: `${merchant.url}/api/weather?city=Oslo`, reason: "weather" });
    expect(textOf(r)).toBe(`Acme Weather (${HOST}) is already connected. Call get_service { service_id: "acme-weather" } for how to use it.`);
    expect(r.structuredContent).toMatchObject({ status: "connected", service: { id: "acme-weather" } });
  });

  it("a Shopify link keeps the store texts", async () => {
    const c = await connect(wallet.addToken("link-shop", []));
    const r = await c.call("request_service", { url: "https://www.allbirds.com/products/anytime-ankle-sock", max_price: "15.00", reason: "socks" });
    const approvalId = r.structuredContent?.approvalId as string;
    expect(textOf(r)).toBe(
      `Asked your owner to add the Shopify store Allbirds (allbirds.com). Approval id ${approvalId} — call check_approval to resume. Once approved, call get_service { service_id: "shopify-weareallbirds" } for how to shop there. Tell the user their phone/dashboard has a request to add this store.`,
    );
    expect(wallet.serviceRequests.at(-1)).toEqual({ url: "https://www.allbirds.com/products/anytime-ankle-sock", maxPrice: "15.00", reason: "socks" });
    const locked = await c.call("request_service", { url: "crypto-app-test.myshopify.com", reason: "x" });
    expect(textOf(locked)).toBe(
      "crypto-app-test.myshopify.com is a Shopify store, but agents can't shop there: This store's catalog isn't public yet (it's password-protected), so agents can't browse it.",
    );
  });

  it("unrecognized links and prices over the limit are explained", async () => {
    const c = await connect(wallet.addToken("link-err", []));
    const bad = await c.call("request_service", { url: `${merchant.url}/free`, reason: "x" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toBe(
      `Allowance can't use ${merchant.url}/free: That link isn't something Allowance can pay: it's not in the directory, not a Shopify store, and it doesn't ask for payment over x402. Check the link with the user, or look for the service with search_services.`,
    );
    expect(bad.structuredContent).toMatchObject({ status: "unrecognized", error: "unrecognized_service_url", url: `${merchant.url}/free` });
    const over = await c.call("request_service", { url: `${merchant.url}/api/expensive`, reason: "x" });
    expect(over.isError).toBe(true);
    expect(textOf(over)).toBe(
      `The wallet did not accept this request: Gold Plated API (${HOST}) asks $50.00 per request, over this agent's $20.00 per-payment limit. Ask your owner to raise the limit or to add it from the dashboard.`,
    );
    const none = await c.call("request_service", { reason: "x" });
    expect(textOf(none)).toMatch(/^Give service_id \(from search_services\), url \(the link to a Shopify store or any API that charges over x402\)/);
  });
});
