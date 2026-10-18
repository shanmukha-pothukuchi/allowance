import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_BLOCKED_URLS, createServer } from "./server.js";
import { startMerchantStub, startWalletStub, type MerchantStub, type WalletStub } from "./test-stubs.js";

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");

let wallet: WalletStub;
let merchant: MerchantStub;
const closers: (() => Promise<void>)[] = [];

async function connect(token: string, approvalWaitMs = 300, logs?: string[]) {
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
});
afterAll(async () => {
  for (const c of closers) await c();
  await wallet.close();
  await merchant.close();
});
beforeEach(() => {
  wallet.autoApproveAfterMs = null;
});

describe("Shopify stores in the MCP tools (ARCHITECTURE §15.4)", () => {
  it("request_service takes shopify_store_url and max_price, with clear descriptions", async () => {
    const { client } = await connect(wallet.addToken("schema", []));
    const tool = (await client.listTools()).tools.find((t) => t.name === "request_service")!;
    const props = tool.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.shopify_store_url.description).toMatch(/Shopify store that isn't in the directory, pass its link/);
    expect(props.max_price.description).toMatch(/Defaults to your max per payment/);
    expect(tool.inputSchema.required).toEqual(["reason"]);
    expect(tool.description).toMatch(/shopify_store_url/);
  });

  it("a new store: the owner is asked to add it, then the agent can find it, read its docs and shop", async () => {
    const logs: string[] = [];
    const token = wallet.addToken("shopper-1", []);
    const c = await connect(token, 300, logs);

    const r = await c.call("request_service", { shopify_store_url: "https://crypto-app-test.myshopify.com", max_price: "15.00", reason: "The owner wants a sticker." });
    expect(r.isError).toBeFalsy();
    const approvalId = r.structuredContent?.approvalId as string;
    expect(textOf(r)).toBe(
      `Asked your owner to add the Shopify store Crypto App Test (crypto-app-test.myshopify.com). Approval id ${approvalId} — call check_approval to resume. Tell the user their phone/dashboard has a request to add this store.`,
    );
    expect(r.structuredContent).toMatchObject({
      status: "pending",
      kind: "service",
      approvalId,
      shopify: { domain: "crypto-app-test.myshopify.com", mode: "agent_checkout" },
      service: { id: "shopify-crypto-app-test", source: "agent", maxPrice: "15.00", provider: "Shopify" },
    });
    expect(wallet.serviceRequests.at(-1)).toEqual({ shopifyStoreUrl: "https://crypto-app-test.myshopify.com", maxPrice: "15.00", reason: "The owner wants a sticker." });
    expect(logs).toContain(`service request needs approval ${approvalId}; waiting 300 ms`);

    // Not in the directory until the owner approves.
    expect(textOf(await c.call("search_services", { query: "shopify" }))).toContain('No services match "shopify"');

    const still = await c.call("check_approval", { approval_id: approvalId });
    expect(textOf(still)).toBe(
      `Waiting for the owner to approve adding the Shopify store Crypto App Test (crypto-app-test.myshopify.com). Approval id ${approvalId} — call check_approval to resume. Tell the user their phone/dashboard has a request to add this store.`,
    );

    setTimeout(() => wallet.approve(approvalId), 50);
    const done = await c.call("check_approval", { approval_id: approvalId });
    expect(textOf(done)).toBe(
      'Owner connected the Shopify store Crypto App Test (crypto-app-test.myshopify.com). Call get_service { service_id: "shopify-crypto-app-test" } for how to shop there. ' +
        "Agent checkout: you pay orders in USDC from your wallet (up to $15.00 per order) and the store gets a real, paid order.",
    );
    expect(done.structuredContent).toMatchObject({ status: "connected", kind: "service", service: { id: "shopify-crypto-app-test", connectedBy: "approval", source: "directory" } });

    // search_services shows the store with its domain and mode; list_services too.
    const found = await c.call("search_services", { query: "shopify" });
    expect(textOf(found)).toContain(
      "- 🛍️ Crypto App Test (shopify-crypto-app-test): Shop at Crypto App Test (Shopify): search products, build a cart and pay in USDC, up to $15.00 per order. · Varies by item · up to $15.00 per order · Shopify store crypto-app-test.myshopify.com, agent checkout · [connected]",
    );
    expect(textOf(await c.call("list_services"))).toContain("Shopify store crypto-app-test.myshopify.com, agent checkout");

    // get_service returns the generated docs.
    const g = await c.call("get_service", { service_id: "shopify-crypto-app-test" });
    const gt = textOf(g);
    expect(gt).toContain("🛍️ Crypto App Test (shopify-crypto-app-test) by Shopify");
    expect(gt).toContain("Status: connected");
    expect(gt).toContain("Shopify store crypto-app-test.myshopify.com, agent checkout. Agent checkout: you pay orders in USDC");
    expect(gt).toContain(`fetch_url { "url": "${merchant.url}/shops/crypto-app-test/products?q=`);
    expect(gt).toContain("Docs:");
    expect(gt).not.toContain("written by an agent");

    // Shop per the docs: products (free) → cart (free) → POST the checkoutUrl (paid by the wallet).
    const products = await c.call("fetch_url", { url: `${merchant.url}/shops/crypto-app-test/products?q=sticker` });
    expect(textOf(products)).toContain("gid://shopify/ProductVariant/11");
    const cart = await c.call("fetch_url", { url: `${merchant.url}/shops/crypto-app-test/carts`, method: "POST", body: { lines: [{ variantId: "gid://shopify/ProductVariant/11", quantity: 1 }] } });
    expect(cart.isError).toBeFalsy();
    const checkoutUrl = /"checkoutUrl": "([^"]+)"/.exec(textOf(cart))![1];
    const order = await c.call("fetch_url", { url: checkoutUrl, method: "POST" });
    expect(order.isError).toBeFalsy();
    expect(textOf(order)).toContain('"orderName": "#1001"');
    expect(textOf(order)).toContain("Paid $4.00 to Crypto App Test order");

    // Asking again: already connected.
    const again = await c.call("request_service", { shopify_store_url: "crypto-app-test.myshopify.com", reason: "again" });
    expect(textOf(again)).toBe('Crypto App Test (Shopify store crypto-app-test.myshopify.com) is already connected. Call get_service { service_id: "shopify-crypto-app-test" } for how to shop there.');
  });

  it("a store already in the directory is a normal request (connect, not add)", async () => {
    wallet.addShopifyStore("cool-socks");
    const c = await connect(wallet.addToken("shopper-2", []), 2000);
    wallet.autoApproveAfterMs = 50;
    const r = await c.call("request_service", { shopify_store_url: "cool-socks.myshopify.com", reason: "Socks." });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe(
      'Connected the Shopify store Cool Socks (cool-socks.myshopify.com). Call get_service { service_id: "shopify-cool-socks" } for how to browse it and build a cart. ' +
        "Browse only: you can search and build a cart, but you cannot pay here. Give the user the cart's checkout link to finish at Shopify.",
    );
    expect(wallet.serviceRequests.at(-1)).toEqual({ shopifyStoreUrl: "cool-socks.myshopify.com", reason: "Socks." });
    const g = textOf(await c.call("get_service", { service_id: "shopify-cool-socks" }));
    expect(g).toContain("this store is browse-only, so nothing is paid through your wallet");
    expect(g).toContain("Shopify store cool-socks.myshopify.com, browse only");
    expect(g).toContain("Finish checkout at Shopify");

    // Pending on a listed store keeps the usual "Waiting … connecting" wording.
    wallet.autoApproveAfterMs = null;
    const other = await connect(wallet.addToken("shopper-3", []), 100);
    const p = await other.call("request_service", { service_id: "shopify-cool-socks", reason: "Socks too." });
    expect(textOf(p)).toMatch(/^Waiting for the owner to approve connecting the Shopify store Cool Socks \(cool-socks\.myshopify\.com\)\. Approval id apr_/);
  });

  it("denied, bad links, unknown stores, unsupported stores and caps over the limit are explained", async () => {
    const c = await connect(wallet.addToken("shopper-4", []), 100);
    const bad = await c.call("request_service", { shopify_store_url: "my favourite shop", reason: "x" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toBe(`"my favourite shop" doesn't look like a Shopify store link. Ask the user for the store's address, like https://example.myshopify.com or the shop's own website.`);
    const missing = await c.call("request_service", { shopify_store_url: "ghost.myshopify.com", reason: "x" });
    expect(textOf(missing)).toBe("There's no Shopify store at ghost.myshopify.com. Check the link with the user.");
    const euro = await c.call("request_service", { shopify_store_url: "euro-shop.myshopify.com", reason: "x" });
    expect(textOf(euro)).toBe("euro-shop.myshopify.com is a Shopify store, but it can't be added: Euro Shop prices in EUR; only USD stores are supported");
    const over = await c.call("request_service", { shopify_store_url: "crypto-app-test.myshopify.com", max_price: "99.00", reason: "x" });
    expect(over.isError).toBe(true);
    expect(textOf(over)).toBe("The wallet did not accept this request: maxPrice $99.00 is over this agent's $20.00 per-payment limit");
    const none = await c.call("request_service", { reason: "x" });
    expect(textOf(none)).toContain("shopify_store_url (a Shopify store link)");

    wallet.shopifyStores.set("deny-me", { handle: "deny-me", domain: "deny-me.myshopify.com", mode: "agent_checkout", name: "Deny Me", currency: "USD" });
    const r = await c.call("request_service", { shopify_store_url: "deny-me.myshopify.com", reason: "x" });
    const approvalId = r.structuredContent?.approvalId as string;
    wallet.deny(approvalId);
    const d = await c.call("check_approval", { approval_id: approvalId });
    expect(textOf(d)).toBe("The owner denied adding the Shopify store Deny Me (deny-me.myshopify.com). Do not shop there, and do not ask again unless the user wants you to.");
    expect(d.structuredContent).toMatchObject({ status: "denied", kind: "service" });
  });

  it("check_approval after a restart still names the store (the wallet returns the grant)", async () => {
    const token = wallet.addToken("shopper-5", []);
    wallet.shopifyStores.set("late-shop", { handle: "late-shop", domain: "late-shop.myshopify.com", mode: "handoff", name: "Late Shop", currency: "USD" });
    const first = await connect(token, 50);
    const approvalId = (await first.call("request_service", { shopify_store_url: "late-shop.myshopify.com", reason: "x" })).structuredContent?.approvalId as string;
    const fresh = await connect(token, 50); // a new MCP server: no memory of the request
    expect(textOf(await fresh.call("check_approval", { approval_id: approvalId }))).toMatch(/^Waiting for the owner to approve adding the Shopify store Late Shop \(late-shop\.myshopify\.com\)/);
  });

  it("fetch_url refuses the bridge's owner-only store registry", async () => {
    expect(DEFAULT_BLOCKED_URLS).toContain("http://localhost:4070/stores");
    const c = await connect(wallet.addToken("shopper-6", []));
    for (const url of ["http://localhost:4070/stores", "http://127.0.0.1:4070/stores/discover?url=x.myshopify.com"]) {
      const r = await c.call("fetch_url", { url, method: "POST", body: { url: "x.myshopify.com" } });
      expect(r.isError, url).toBe(true);
      expect(textOf(r)).toContain("Refused");
    }
  });
});
