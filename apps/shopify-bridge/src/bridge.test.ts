import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import express from "express";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { getAddress } from "viem";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { loadConfig, toBaseUnits, type AppConfig, type ShopifyStore } from "@allowance/shared";
import { createFacilitatorApp } from "../../mock-facilitator/src/app.js";
import { createBridgeApp, normalizeVariantId, parseCartBody, type BridgeApp } from "./app.js";
import { createAdminClient } from "./admin.js";
import { parseStoreInput, normalizeAdminShop } from "./stores.js";
import { GATEWAY } from "./orders.js";
import { startStubShopify, type StubShopify } from "./test-shopify.js";

const OWNER = "ok_test_owner_key";
const vGid = (n: number) => `gid://shopify/ProductVariant/${n}`;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`);
    });
  });
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

describe("store links", () => {
  it("normalizes myshopify links, admin links and storefront hosts", () => {
    expect(parseStoreInput("https://crypto-app-test.myshopify.com")).toEqual({ kind: "myshopify", domain: "crypto-app-test.myshopify.com", handle: "crypto-app-test" });
    expect(parseStoreInput("crypto-app-test.myshopify.com")).toEqual({ kind: "myshopify", domain: "crypto-app-test.myshopify.com", handle: "crypto-app-test" });
    expect(parseStoreInput("  HTTPS://Crypto-App-Test.MyShopify.com/products/hoodie?variant=1  ")).toMatchObject({ handle: "crypto-app-test" });
    expect(parseStoreInput("https://admin.shopify.com/store/crypto-app-test/orders")).toMatchObject({ kind: "myshopify", handle: "crypto-app-test" });
    expect(parseStoreInput("https://shop.example.com/collections/all")).toEqual({ kind: "custom", host: "shop.example.com" });
    for (const bad of ["", "not a url", "ftp://x.myshopify.com", "http://127.0.0.1:4070", "localhost:4070", "https://intranet", "https://[::1]/", 42, null, "https://admin.shopify.com/", "https://shopify.com"]) {
      expect(parseStoreInput(bad), String(bad)).toBeNull();
    }
    expect(normalizeAdminShop("crypto-app-test")).toBe("crypto-app-test.myshopify.com");
    expect(normalizeAdminShop("https://crypto-app-test.myshopify.com/")).toBe("crypto-app-test.myshopify.com");
    expect(normalizeAdminShop("example.com")).toBeUndefined();
  });

  it("parses cart bodies: GIDs or numeric ids, merged duplicates, limits", () => {
    expect(normalizeVariantId("123")).toBe(vGid(123));
    expect(normalizeVariantId(123)).toBe(vGid(123));
    expect(normalizeVariantId(vGid(5))).toBe(vGid(5));
    expect(normalizeVariantId("gid://shopify/Product/5")).toBeNull();
    const c = parseCartBody({ lines: [{ variantId: "7", quantity: 2 }, { variantId: vGid(7), quantity: 3 }, { variantId: 8 }], email: " a@b.co ", note: "hi" });
    expect(c.lines).toEqual([{ variantId: vGid(7), quantity: 5 }, { variantId: vGid(8), quantity: 1 }]);
    expect(c.email).toBe("a@b.co");
    expect(() => parseCartBody({ lines: [] })).toThrow(/at least one/);
    expect(() => parseCartBody({ lines: [{ variantId: "1", quantity: 0 }] })).toThrow(/quantity/);
    expect(() => parseCartBody({ lines: [{ variantId: "1", quantity: 21 }] })).toThrow(/quantity/);
    expect(() => parseCartBody({ lines: [{ variantId: "1", quantity: 1.5 }] })).toThrow(/quantity/);
    expect(() => parseCartBody({ lines: [{ variantId: "1", quantity: 15 }, { variantId: "1", quantity: 6 }] })).toThrow(/At most 20/);
    expect(() => parseCartBody({ lines: Array.from({ length: 21 }, (_, i) => ({ variantId: String(i + 1), quantity: 1 })) })).toThrow(/At most 20 lines/);
    expect(() => parseCartBody({ lines: [{ variantId: "1" }], email: "nope" })).toThrow(/email/);
  });
});

describe("shopify bridge", () => {
  const buyer = privateKeyToAccount(generatePrivateKey());
  const bridgeAccount = privateKeyToAccount(generatePrivateKey());
  let clock = Date.now();

  let shop: StubShopify;
  let facServer: Server;
  let proxyServer: Server;
  let bridgeServer: Server;
  let facUrl: string;
  let bridgeUrl: string;
  let dataDir: string;
  let config: AppConfig;
  let app: BridgeApp;
  /** Facilitator proxy: pass-through, or fail /settle when set. */
  let failSettle = false;

  const mint = (to: string, amount: string) =>
    fetch(`${facUrl}/admin/mint`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to, amount }) });
  const balance = async (addr: string) => BigInt(((await (await fetch(`${facUrl}/balance/${addr}`)).json()) as { balanceBaseUnits: string }).balanceBaseUnits);
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const r = await fetch(`${bridgeUrl}${path}`, { headers });
    return { status: r.status, body: (await r.json()) as any };
  };
  const post = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${bridgeUrl}${path}`, {
      method: "POST",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any, headers: r.headers };
  };
  const payFetch = () => {
    const client = new x402Client().register("eip155:84532", new ExactEvmScheme(buyer));
    client.setSpendControls({ maxAmountPerPayment: "$1000" });
    return wrapFetchWithPayment(fetch, client);
  };
  const pay = async (url: string) => {
    const r = await payFetch()(url, { method: "POST" });
    return { status: r.status, body: (await r.json()) as any, headers: r.headers };
  };
  const newCart = async (handle: string, lines: { variantId: string; quantity: number }[], extra: Record<string, unknown> = {}) => {
    const r = await post(`/shops/${handle}/carts`, { lines, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };

  beforeAll(async () => {
    shop = await startStubShopify();

    const facDir = mkdtempSync(join(tmpdir(), "allowance-fac-"));
    const facApp = createFacilitatorApp({ ...loadConfig(), ownerApiKey: undefined, dataDir: facDir }, { quiet: true });
    facServer = createServer(facApp);
    facUrl = await listen(facServer);

    const proxy = express();
    proxy.use(express.json());
    proxy.get("/supported", async (_req, res) => res.json(await (await fetch(`${facUrl}/supported`)).json()));
    proxy.post("/verify", async (req, res) => {
      const r = await fetch(`${facUrl}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.body) });
      res.status(r.status).json(await r.json());
    });
    proxy.post("/settle", async (req, res) => {
      if (failSettle) return void res.json({ success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:84532" });
      const r = await fetch(`${facUrl}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.body) });
      res.status(r.status).json(await r.json());
    });
    proxyServer = createServer(proxy);
    const proxyUrl = await listen(proxyServer);

    bridgeServer = createServer();
    bridgeUrl = await listen(bridgeServer);
    dataDir = mkdtempSync(join(tmpdir(), "allowance-shopify-"));
    config = {
      ...loadConfig(),
      chainMode: "mock",
      dataDir,
      ownerApiKey: OWNER,
      facilitatorUrl: facUrl,
      x402FacilitatorUrl: proxyUrl,
      shopifyBridgeUrl: bridgeUrl,
      shopify: { adminShop: "dev-store", clientId: shop.clientId, clientSecret: shop.clientSecret, apiVersion: "2026-10" },
    };
    app = createBridgeApp(config, { fetch: shop.fetch, account: bridgeAccount, now: () => clock, quiet: true, ucpAgentProfileUrl: null });
    bridgeServer.on("request", app);
    await app.locals.ready;
    await mint(buyer.address, "500.00");
  });

  afterAll(async () => {
    await close(bridgeServer);
    await close(proxyServer);
    await close(facServer);
    await shop.close();
  });

  beforeEach(() => {
    failSettle = false;
    shop.failOrderCreate = undefined;
  });

  it("GET /health", async () => {
    const r = await get("/health");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, stores: 0, adminShop: "dev-store.myshopify.com", adminConfigured: true });
  });

  describe("discover", () => {
    it("the owner's store (Admin API) → agent_checkout, even though its storefront is locked", async () => {
      const r = await get(`/stores/discover?url=${encodeURIComponent("https://dev-store.myshopify.com")}`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ handle: "dev-store", domain: "dev-store.myshopify.com", mode: "agent_checkout", name: "Dev Store", currency: "USD", productCount: 4 });
    });

    it("other stores → handoff via the tokenless Storefront API, for every link form", async () => {
      const forms = ["open-store.myshopify.com", "https://open-store.myshopify.com/products/wool-socks?variant=1", "https://shop.example.com/collections/all", "https://admin.shopify.com/store/open-store"];
      for (const url of forms) {
        const r = await get(`/stores/discover?url=${encodeURIComponent(url)}`);
        expect(r.status, url).toBe(200);
        expect(r.body).toEqual({ handle: "open-store", domain: "open-store.myshopify.com", mode: "handoff", name: "Open Store", currency: "USD", productCount: 2 });
      }
    });

    it("bad links → 400, unknown stores → 404, non-USD or locked → 422", async () => {
      for (const url of ["", "not a url", "ftp://open-store.myshopify.com", "http://127.0.0.1:4070"]) {
        const r = await get(`/stores/discover?url=${encodeURIComponent(url)}`);
        expect(r.status, url).toBe(400);
        expect(r.body.error).toBe("invalid_store_url");
      }
      expect((await get("/stores/discover")).body.error).toBe("invalid_store_url");
      const missing = await get(`/stores/discover?url=${encodeURIComponent("https://nope-store.myshopify.com")}`);
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe("store_not_found");
      const custom = await get(`/stores/discover?url=${encodeURIComponent("https://blog.example.org")}`);
      expect(custom.status).toBe(404);
      expect(custom.body.error).toBe("store_not_found");
      const euro = await get(`/stores/discover?url=euro-store.myshopify.com`);
      expect(euro.status).toBe(422);
      expect(euro.body).toMatchObject({ error: "store_unsupported", currency: "EUR" });
      const locked = await get(`/stores/discover?url=locked-store.myshopify.com`);
      expect(locked.status).toBe(422);
      expect(locked.body.error).toBe("store_unsupported");
      expect(locked.body.message).toMatch(/password-protected/);
    });

    it("has no side effects", async () => {
      expect((await get("/stores")).body).toEqual({ stores: [] });
      expect(existsSync(join(dataDir, "shopify-stores.json"))).toBe(false);
    });
  });

  describe("registry", () => {
    it("POST /stores requires the owner key", async () => {
      expect((await post("/stores", { url: "dev-store.myshopify.com" })).status).toBe(401);
      const wrong = await post("/stores", { url: "dev-store.myshopify.com" }, { "x-owner-key": "ok_wrong" });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error).toBe("unauthorized");
      expect((await get("/stores")).body.stores).toEqual([]);
    });

    it("registers stores, refuses duplicates with the existing store, persists them", async () => {
      const bad = await post("/stores", {}, { "x-owner-key": OWNER });
      expect(bad.status).toBe(400);
      const r = await post("/stores", { url: "https://dev-store.myshopify.com" }, { "x-owner-key": OWNER });
      expect(r.status).toBe(201);
      expect(r.body.store).toMatchObject({ handle: "dev-store", mode: "agent_checkout", name: "Dev Store", currency: "USD" });
      expect(typeof r.body.store.addedAt).toBe("string");
      const again = await post("/stores", { url: "https://admin.shopify.com/store/dev-store" }, { "x-owner-key": OWNER });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("store_exists");
      expect(again.body.store).toEqual(r.body.store);
      const open = await post("/stores", { url: "https://shop.example.com" }, { "x-owner-key": OWNER });
      expect(open.status).toBe(201);
      expect(open.body.store).toMatchObject({ handle: "open-store", mode: "handoff" });
      const euro = await post("/stores", { url: "euro-store.myshopify.com" }, { "x-owner-key": OWNER });
      expect(euro.status).toBe(422);

      const list = await get("/stores");
      expect(list.body.stores.map((s: ShopifyStore) => s.handle)).toEqual(["dev-store", "open-store"]);
      expect((await get("/stores/dev-store")).body.store).toEqual(r.body.store);
      expect((await get("/stores/nope")).status).toBe(404);
      const saved = JSON.parse(readFileSync(join(dataDir, "shopify-stores.json"), "utf8"));
      expect(saved.stores.map((s: { handle: string; source: string }) => `${s.handle}:${s.source}`)).toEqual(["dev-store:admin", "open-store:storefront"]);
      expect((await get("/health")).body.stores).toBe(2);
    });
  });

  describe("products", () => {
    it("agent_checkout store: Admin catalog, search, limit, ≤ 300-char descriptions", async () => {
      const r = await get("/shops/dev-store/products");
      expect(r.status).toBe(200);
      expect(r.body.store).toEqual({ name: "Dev Store", currency: "USD", mode: "agent_checkout" });
      expect(r.body.products).toHaveLength(4);
      const hoodie = r.body.products[0];
      expect(hoodie).toMatchObject({
        id: "gid://shopify/Product/101",
        handle: "terps-hoodie",
        title: "UMD Terps Hoodie",
        image: "https://cdn.shopify.com/hoodie.png",
        url: "https://dev-store.myshopify.com/products/terps-hoodie",
        priceMin: "49.00",
        priceMax: "52.00",
        currency: "USD",
        available: true,
      });
      expect(hoodie.description.length).toBeLessThanOrEqual(300);
      expect(hoodie.variants).toEqual([
        { id: vGid(1011), title: "Small", price: "49.00", available: true },
        { id: vGid(1012), title: "Medium", price: "49.00", available: true },
        { id: vGid(1013), title: "Large", price: "52.00", available: false },
      ]);
      expect(r.body.products.find((p: { handle: string }) => p.handle === "bobblehead").available).toBe(false);
      const q = await get("/shops/dev-store/products?q=mug&limit=5");
      expect(q.body.products.map((p: { title: string }) => p.title)).toEqual(["Maryland Terrapins Coffee Mug"]);
      expect((await get("/shops/dev-store/products?limit=2")).body.products).toHaveLength(2);
      expect(shop.storefrontOps.filter((o) => o.startsWith("dev-store"))).toEqual([]); // the owner's store is read through the Admin API only
    });

    it("handoff store: Storefront catalog (prices normalized, HTML stripped)", async () => {
      const r = await get("/shops/open-store/products?q=socks");
      expect(r.status).toBe(200);
      expect(r.body.store).toEqual({ name: "Open Store", currency: "USD", mode: "handoff" });
      expect(r.body.products).toEqual([
        {
          id: "gid://shopify/Product/201",
          handle: "wool-socks",
          title: "Wool Socks",
          description: "Cozy socks.",
          image: "https://cdn.shopify.com/socks.png",
          url: "https://open-store.myshopify.com/products/wool-socks",
          priceMin: "12.50",
          priceMax: "13.50",
          currency: "USD",
          available: true,
          variants: [
            { id: vGid(2011), title: "S", price: "12.50", available: true },
            { id: vGid(2012), title: "L", price: "13.50", available: true },
          ],
        },
      ]);
    });

    it("one product by handle; 404s", async () => {
      const r = await get("/shops/dev-store/products/terps-hoodie");
      expect(r.status).toBe(200);
      expect(r.body.product.variants).toHaveLength(3);
      expect((await get("/shops/open-store/products/cap")).body.product.title).toBe("Ball Cap");
      expect((await get("/shops/dev-store/products/nope")).body.error).toBe("product_not_found");
      expect((await get("/shops/unknown/products")).status).toBe(404);
    });
  });

  describe("carts", () => {
    it("agent_checkout cart: prices re-read from Shopify, totals, bridge checkout link", async () => {
      const t0 = clock;
      const cart = await newCart("dev-store", [
        { variantId: vGid(1011), quantity: 2 },
        { variantId: "1021", quantity: 3 },
        { variantId: vGid(1011), quantity: 1 },
      ]);
      expect(cart.cartId).toMatch(/^cart_[0-9a-f]{16}$/);
      expect(cart.store).toMatchObject({ handle: "dev-store", name: "Dev Store", mode: "agent_checkout" });
      expect(cart.lines).toEqual([
        { variantId: vGid(1011), title: "UMD Terps Hoodie", variantTitle: "Small", quantity: 3, unitPrice: "49.00", lineTotal: "147.00", image: "https://cdn.shopify.com/hoodie.png" },
        { variantId: vGid(1021), title: "UMD Testudo Sticker", variantTitle: "Default Title", quantity: 3, unitPrice: "0.01", lineTotal: "0.03", image: null },
      ]);
      expect(cart).toMatchObject({ subtotal: "147.03", shipping: "0.00", total: "147.03", currency: "USD", mode: "agent_checkout" });
      expect(cart.checkoutUrl).toBe(`${bridgeUrl}/shops/dev-store/carts/${cart.cartId}/checkout`);
      expect(Date.parse(cart.expiresAt) - t0).toBe(30 * 60_000);
    });

    it("handoff cart: Shopify's own checkout link from cartCreate", async () => {
      const cart = await newCart("open-store", [{ variantId: vGid(2011), quantity: 2 }], { email: "owner@example.com", note: "gift" });
      expect(cart.total).toBe("25.00");
      expect(cart.mode).toBe("handoff");
      expect(cart.checkoutUrl).toMatch(/^https:\/\/open-store\.myshopify\.com\/cart\/c\//);
      const created = shop.cartCreates.at(-1)!;
      expect(created.input).toEqual({ lines: [{ merchandiseId: vGid(2011), quantity: 2 }], buyerIdentity: { email: "owner@example.com" }, note: "gift" });
    });

    it("limits and bad variants", async () => {
      expect((await post("/shops/dev-store/carts", { lines: [] })).status).toBe(400);
      expect((await post("/shops/dev-store/carts", { lines: [{ variantId: vGid(1011), quantity: 21 }] })).status).toBe(400);
      expect((await post("/shops/dev-store/carts", { lines: [{ variantId: "hoodie", quantity: 1 }] })).status).toBe(400);
      expect((await post("/shops/dev-store/carts")).status).toBe(400);
      const unknown = await post("/shops/dev-store/carts", { lines: [{ variantId: vGid(999999), quantity: 1 }] });
      expect(unknown.status).toBe(422);
      expect(unknown.body).toMatchObject({ error: "variant_not_found", variantIds: [vGid(999999)] });
      const soldOut = await post("/shops/dev-store/carts", { lines: [{ variantId: vGid(1011), quantity: 1 }, { variantId: vGid(1041), quantity: 1 }] });
      expect(soldOut.status).toBe(422);
      expect(soldOut.body).toMatchObject({ error: "variant_unavailable", variantIds: [vGid(1041)] });
      expect(soldOut.body.message).toContain("Limited Edition Testudo Bobblehead");
      expect((await post("/shops/unknown/carts", { lines: [{ variantId: "1", quantity: 1 }] })).status).toBe(404);
    });
  });

  describe("checkout", () => {
    it("unpaid → 402 for the cart total to the bridge wallet, naming the shop; repeatable without side effects", async () => {
      const cart = await newCart("dev-store", [{ variantId: vGid(1031), quantity: 2 }]);
      for (let i = 0; i < 2; i++) {
        const r = await fetch(cart.checkoutUrl, { method: "POST", headers: { accept: "application/json" } });
        expect(r.status).toBe(402);
        const pr = decodePaymentRequiredHeader(r.headers.get("payment-required")!) as any;
        expect(pr.accepts).toHaveLength(1);
        expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "29980000", maxTimeoutSeconds: 300 });
        expect(getAddress(pr.accepts[0].payTo)).toBe(bridgeAccount.address);
        expect(pr.resource).toMatchObject({ description: "Dev Store order", serviceName: "Dev Store", url: cart.checkoutUrl });
      }
      expect(shop.orders).toHaveLength(0);
    });

    it("paid with @x402/fetch → one real paid order, then the ledger moves and the note gets the tx", async () => {
      const ordersBefore = shop.orders.length;
      const cart = await newCart("dev-store", [{ variantId: vGid(1012), quantity: 1 }, { variantId: vGid(1031), quantity: 2 }], {
        email: "buyer@example.com",
        note: "Leave at the door",
        shippingAddress: { name: "Terry Pin", address1: "1 Campus Dr", city: "College Park", province: "MD", zip: "20742", country: "United States" },
      });
      expect(cart.total).toBe("78.98");
      const buyerBefore = await balance(buyer.address);
      const bridgeBefore = await balance(bridgeAccount.address);

      const r = await pay(cart.checkoutUrl);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({
        status: "placed",
        orderId: "gid://shopify/Order/9001",
        orderName: "#1001",
        adminUrl: "https://admin.shopify.com/store/dev-store/orders/9001",
        store: { handle: "dev-store", name: "Dev Store", mode: "agent_checkout" },
        total: "78.98",
        currency: "USD",
      });
      expect(r.body.items).toEqual([
        { title: "UMD Terps Hoodie", variantTitle: "Medium", quantity: 1, unitPrice: "49.00", lineTotal: "49.00", image: "https://cdn.shopify.com/hoodie.png" },
        { title: "Maryland Terrapins Coffee Mug", variantTitle: "Default Title", quantity: 2, unitPrice: "14.99", lineTotal: "29.98", image: null },
      ]);
      const settle = decodePaymentResponseHeader(r.headers.get("payment-response")!) as any;
      expect(settle.success).toBe(true);
      expect(settle.transaction).toMatch(/^0x[0-9a-f]{64}$/);

      // Exactly one order, shaped like an "accept USDC" payment app would create it.
      expect(shop.orders).toHaveLength(ordersBefore + 1);
      const o = shop.orders.at(-1)!;
      expect(o.order).toMatchObject({
        currency: "USD",
        financialStatus: "PAID",
        email: "buyer@example.com",
        tags: ["allowance", "x402"],
        test: true,
        lineItems: [
          { variantId: vGid(1012), quantity: 1, priceSet: { shopMoney: { amount: "49.00", currencyCode: "USD" } } },
          { variantId: vGid(1031), quantity: 2, priceSet: { shopMoney: { amount: "14.99", currencyCode: "USD" } } },
        ],
        transactions: [{ kind: "SALE", status: "SUCCESS", gateway: GATEWAY, amountSet: { shopMoney: { amount: "78.98", currencyCode: "USD" } } }],
        shippingAddress: { firstName: "Terry", lastName: "Pin", address1: "1 Campus Dr", city: "College Park", provinceCode: "MD", zip: "20742", countryCode: "US" },
      });
      expect(GATEWAY).toBe("Allowance USDC (x402)");
      expect(o.options).toMatchObject({ sendReceipt: false });
      expect(o.order.note).toMatch(/^Paid by an Allowance agent with USDC · tx pending/);
      expect(o.note).toContain(`Paid by an Allowance agent with USDC · tx ${settle.transaction}`);
      expect(o.note).toContain(`payer ${buyer.address}`);
      expect(o.note).toContain("Note from the agent: Leave at the door");
      expect(shop.orderUpdates.at(-1)).toEqual({ id: o.id, note: o.note });

      expect(buyerBefore - (await balance(buyer.address))).toBe(toBaseUnits("78.98"));
      expect((await balance(bridgeAccount.address)) - bridgeBefore).toBe(toBaseUnits("78.98"));

      // A cart can be paid once: the second call answers 409 with the same order, before any 402.
      const again = await pay(cart.checkoutUrl);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("cart_already_paid");
      expect(again.body.order).toMatchObject({ orderId: o.id, orderName: "#1001", txHash: settle.transaction });
      const unpaidAgain = await post(new URL(cart.checkoutUrl).pathname);
      expect(unpaidAgain.status).toBe(409);
      expect(shop.orders).toHaveLength(ordersBefore + 1);
      expect(buyerBefore - (await balance(buyer.address))).toBe(toBaseUnits("78.98"));
    });

    it("order creation fails → error status, payment not settled (ledger unchanged), cart can be retried", async () => {
      const cart = await newCart("dev-store", [{ variantId: vGid(1011), quantity: 1 }]);
      const buyerBefore = await balance(buyer.address);
      const bridgeBefore = await balance(bridgeAccount.address);
      const ordersBefore = shop.orders.length;

      for (const mode of ["userErrors", "http500"] as const) {
        shop.failOrderCreate = mode;
        const r = await pay(cart.checkoutUrl);
        expect(r.status, mode).toBe(502);
        expect(r.body.error).toBe("order_failed");
        expect(r.body.message).toMatch(/not taken/);
        expect(r.headers.get("payment-response")).toBeNull();
        expect(await balance(buyer.address)).toBe(buyerBefore);
        expect(await balance(bridgeAccount.address)).toBe(bridgeBefore);
        expect(shop.orders).toHaveLength(ordersBefore);
      }

      shop.failOrderCreate = undefined;
      const ok = await pay(cart.checkoutUrl);
      expect(ok.status).toBe(200);
      expect(shop.orders).toHaveLength(ordersBefore + 1);
      expect(buyerBefore - (await balance(buyer.address))).toBe(toBaseUnits("49.00"));
    });

    it("settlement fails after the order was created → the order is canceled and the cart reopens", async () => {
      const cart = await newCart("dev-store", [{ variantId: vGid(1021), quantity: 5 }]);
      const buyerBefore = await balance(buyer.address);
      const ordersBefore = shop.orders.length;
      failSettle = true;
      const r = await pay(cart.checkoutUrl);
      expect(r.status).toBe(402);
      expect(r.body.error).toBe("payment_not_settled");
      expect(shop.orders).toHaveLength(ordersBefore + 1);
      expect(shop.orderCancels.at(-1)!.orderId).toBe(shop.orders.at(-1)!.id);
      expect(shop.orders.at(-1)!.cancelled).toBeTruthy();
      expect(await balance(buyer.address)).toBe(buyerBefore);

      failSettle = false;
      const retry = await pay(cart.checkoutUrl);
      expect(retry.status).toBe(200);
      expect(retry.body.orderId).not.toBe(shop.orders.at(-2)!.id);
      expect(buyerBefore - (await balance(buyer.address))).toBe(toBaseUnits("0.05"));
    });

    it("two concurrent checkouts of one cart → one order, one charge", async () => {
      const cart = await newCart("dev-store", [{ variantId: vGid(1031), quantity: 1 }]);
      const buyerBefore = await balance(buyer.address);
      const ordersBefore = shop.orders.length;
      const results = await Promise.all([pay(cart.checkoutUrl), pay(cart.checkoutUrl)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(shop.orders).toHaveLength(ordersBefore + 1);
      expect(buyerBefore - (await balance(buyer.address))).toBe(toBaseUnits("14.99"));
    });

    it("one signed payment presented at two carts with the same total → one order, one charge", async () => {
      const a = await newCart("dev-store", [{ variantId: vGid(1031), quantity: 1 }]);
      const b = await newCart("dev-store", [{ variantId: vGid(1031), quantity: 1 }]);
      const pr = decodePaymentRequiredHeader((await fetch(a.checkoutUrl, { method: "POST" })).headers.get("payment-required")!);
      const client = new x402Client().register("eip155:84532", new ExactEvmScheme(buyer));
      client.setSpendControls({ maxAmountPerPayment: "$1000" });
      const header = encodePaymentSignatureHeader(await client.createPaymentPayload(pr as never));
      const buyerBefore = await balance(buyer.address);
      const ordersBefore = shop.orders.length;
      const results = await Promise.all([a, b].map((c) => fetch(c.checkoutUrl, { method: "POST", headers: { "PAYMENT-SIGNATURE": header } })));
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409 || s === 402)).toHaveLength(1);
      const live = shop.orders.slice(ordersBefore).filter((o) => !o.cancelled);
      expect(live).toHaveLength(1);
      expect(buyerBefore - (await balance(buyer.address))).toBe(toBaseUnits("14.99"));
    });

    it("handoff store → 409 agent_checkout_unavailable with Shopify's checkout link (no 402)", async () => {
      const cart = await newCart("open-store", [{ variantId: vGid(2021), quantity: 1 }]);
      const r = await post(`/shops/open-store/carts/${cart.cartId}/checkout`);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ error: "agent_checkout_unavailable", handoffUrl: cart.checkoutUrl });
      expect(r.headers.get("payment-required")).toBeNull();
    });

    it("unknown and expired carts → 404", async () => {
      expect((await post("/shops/dev-store/carts/cart_0000000000000000/checkout")).status).toBe(404);
      const cart = await newCart("dev-store", [{ variantId: vGid(1031), quantity: 1 }]);
      const other = await post(`/shops/open-store/carts/${cart.cartId}/checkout`);
      expect(other.status).toBe(404);
      clock += 31 * 60_000;
      const r = await post(new URL(cart.checkoutUrl).pathname);
      expect(r.status).toBe(404);
      expect(r.body.error).toBe("cart_not_found");
    });
  });

  describe("admin token", () => {
    it("is cached, refreshed before expiry, and refreshed once on 401", async () => {
      const issued = shop.tokensIssued;
      await get("/shops/dev-store/products");
      await get("/shops/dev-store/products?q=mug");
      expect(shop.tokensIssued).toBe(issued); // cached

      clock += 24 * 60 * 60_000 - 4 * 60_000; // inside the 5-minute refresh margin
      await get("/shops/dev-store/products");
      expect(shop.tokensIssued).toBe(issued + 1);

      shop.validTokens.clear(); // Shopify revoked it early
      const r = await get("/shops/dev-store/products");
      expect(r.status).toBe(200);
      expect(shop.tokensIssued).toBe(issued + 2);
    });

    it("sends the client credentials grant and never retries a refused fresh token forever", async () => {
      let tokenCalls = 0;
      const admin = createAdminClient({
        shop: "dev-store.myshopify.com",
        clientId: shop.clientId,
        clientSecret: shop.clientSecret,
        apiVersion: "2026-10",
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/admin/oauth/access_token")) {
            tokenCalls++;
            expect(JSON.parse(String(init?.body))).toEqual({ client_id: shop.clientId, client_secret: shop.clientSecret, grant_type: "client_credentials" });
            return new Response(JSON.stringify({ access_token: `t${tokenCalls}`, scope: "read_products,write_orders", expires_in: 86399 }), { status: 200 });
          }
          return new Response(JSON.stringify({ errors: "[API] Invalid API key or access token" }), { status: 401 });
        }) as typeof fetch,
      });
      await expect(admin.graphql("query BridgeShop { shop { name } }")).rejects.toMatchObject({ kind: "auth" });
      expect(tokenCalls).toBe(2);
    });

    it("bad credentials: discovery falls back and reports the store as unsupported", async () => {
      const dir = mkdtempSync(join(tmpdir(), "allowance-shopify-badcreds-"));
      const bad = createBridgeApp(
        { ...config, dataDir: dir, shopify: { ...config.shopify, clientSecret: "wrong" } },
        { fetch: shop.fetch, account: bridgeAccount, quiet: true, ucpAgentProfileUrl: null },
      );
      const s = createServer(bad);
      const url = await listen(s);
      const r = await fetch(`${url}/stores/discover?url=dev-store.myshopify.com`);
      expect(r.status).toBe(422);
      expect(((await r.json()) as any).message).toMatch(/Admin API credentials/);
      expect(((await (await fetch(`${url}/health`)).json()) as any).adminStatus).toBe("failed");
      await close(s);
    });
  });

  describe("UCP fallback", () => {
    it("reads a password-protected store through UCP when UCP_AGENT_PROFILE_URL is set; carts get a permalink", async () => {
      const dir = mkdtempSync(join(tmpdir(), "allowance-shopify-ucp-"));
      const ucpApp = createBridgeApp(
        { ...config, dataDir: dir, shopify: { apiVersion: "2026-10" } },
        { fetch: shop.fetch, account: bridgeAccount, quiet: true, ucpAgentProfileUrl: "https://agent.example.com/.well-known/ucp" },
      );
      const s = createServer(ucpApp);
      const url = await listen(s);
      const d = await fetch(`${url}/stores/discover?url=locked-store.myshopify.com`);
      expect(d.status).toBe(200);
      expect(await d.json()).toEqual({ handle: "locked-store", domain: "locked-store.myshopify.com", mode: "handoff", name: "Locked Store", currency: "USD" });
      const reg = await fetch(`${url}/stores`, { method: "POST", headers: { "content-type": "application/json", "x-owner-key": OWNER }, body: JSON.stringify({ url: "locked-store.myshopify.com" }) });
      expect(reg.status).toBe(201);
      const products = (await (await fetch(`${url}/shops/locked-store/products?q=pin`)).json()) as any;
      expect(products.products).toEqual([
        {
          id: "gid://shopify/Product/401",
          handle: "enamel-pin",
          title: "Enamel Pin",
          description: "A pin.",
          image: "https://cdn.shopify.com/pin.png",
          url: "https://locked-store.myshopify.com/products/enamel-pin",
          priceMin: "4.50",
          priceMax: "5.00",
          currency: "USD",
          available: true,
          variants: [
            { id: vGid(4011), title: "Gold", price: "5.00", available: true },
            { id: vGid(4012), title: "Silver", price: "4.50", available: false },
          ],
        },
      ]);
      expect(((await (await fetch(`${url}/shops/locked-store/products/enamel-pin`)).json()) as any).product.title).toBe("Enamel Pin");
      const cart = await fetch(`${url}/shops/locked-store/carts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lines: [{ variantId: vGid(4011), quantity: 2 }] }) });
      expect(cart.status).toBe(201);
      const c = (await cart.json()) as any;
      expect(c).toMatchObject({ total: "10.00", mode: "handoff", checkoutUrl: "https://locked-store.myshopify.com/cart/4011:2" });
      await close(s);
    });
  });

  describe("restart and no credentials", () => {
    it("a restarted bridge loads its stores and keeps agent checkout", async () => {
      const again = createBridgeApp(config, { fetch: shop.fetch, account: bridgeAccount, now: () => clock, quiet: true, ucpAgentProfileUrl: null });
      await again.locals.ready;
      expect(again.locals.registry.list().map((s) => `${s.handle}:${s.mode}`)).toEqual(["dev-store:agent_checkout", "open-store:handoff"]);
    });

    it("without Admin credentials the bridge serves health, discovery and handoff; the owner's store downgrades", async () => {
      const dir = mkdtempSync(join(tmpdir(), "allowance-shopify-nocreds-"));
      const none = createBridgeApp(
        { ...config, dataDir: dir, ownerApiKey: undefined, shopify: { apiVersion: "2026-10" } },
        { fetch: shop.fetch, quiet: true, ucpAgentProfileUrl: null },
      );
      await none.locals.ready;
      const s = createServer(none);
      const url = await listen(s);
      const health = (await (await fetch(`${url}/health`)).json()) as any;
      expect(health).toMatchObject({ ok: true, stores: 0, adminShop: null, adminConfigured: false });
      expect(existsSync(join(dir, "shopify-bridge-key.json"))).toBe(true);
      expect(existsSync(join(dir, "owner-key.json"))).toBe(true);
      const ownerKey = JSON.parse(readFileSync(join(dir, "owner-key.json"), "utf8")).ownerApiKey;
      const locked = await fetch(`${url}/stores/discover?url=dev-store.myshopify.com`);
      expect(locked.status).toBe(422);
      const open = (await (await fetch(`${url}/stores/discover?url=open-store.myshopify.com`)).json()) as any;
      expect(open.mode).toBe("handoff");
      const reg = await fetch(`${url}/stores`, { method: "POST", headers: { "content-type": "application/json", "x-owner-key": ownerKey }, body: JSON.stringify({ url: "open-store.myshopify.com" }) });
      expect(reg.status).toBe(201);
      await close(s);

      // A store registered with agent checkout, restarted without credentials → browse-only.
      const copy = mkdtempSync(join(tmpdir(), "allowance-shopify-restart-"));
      copyFileSync(join(dataDir, "shopify-stores.json"), join(copy, "shopify-stores.json"));
      const downgraded = createBridgeApp({ ...config, dataDir: copy, shopify: { apiVersion: "2026-10" } }, { fetch: shop.fetch, account: bridgeAccount, quiet: true, ucpAgentProfileUrl: null });
      await downgraded.locals.ready;
      expect(downgraded.locals.registry.get("dev-store")?.mode).toBe("handoff");
    });
  });
});
