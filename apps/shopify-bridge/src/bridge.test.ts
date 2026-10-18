import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { createBridgeApp, normalizeVariantId, parseCartBody, PRIVATE_CATALOG, type BridgeApp } from "./app.js";
import { ADMIN_LINK, LOCAL_LINK, NOT_A_STORE_LINK, parseStoreInput, SHOPIFY_SITE_LINK, StoreRegistry } from "./stores.js";
import { startStubShopify, type StubShopify } from "./test-shopify.js";

const OWNER = "ok_test_owner_key";
const vGid = (n: number) => `gid://shopify/ProductVariant/${n}`;
const REF_RE = /^ALW-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`);
    });
  });
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("store links", () => {
  it("any store link: myshopify, custom domains, product and collection pages (path ignored)", () => {
    expect(parseStoreInput("https://weareallbirds.myshopify.com")).toEqual({ kind: "myshopify", domain: "weareallbirds.myshopify.com", handle: "weareallbirds" });
    expect(parseStoreInput("weareallbirds.myshopify.com")).toEqual({ kind: "myshopify", domain: "weareallbirds.myshopify.com", handle: "weareallbirds" });
    expect(parseStoreInput("  HTTPS://WeAreAllbirds.MyShopify.com/products/tree-runner?variant=1  ")).toMatchObject({ kind: "myshopify", handle: "weareallbirds" });
    expect(parseStoreInput("allbirds.com")).toEqual({ kind: "custom", host: "allbirds.com" });
    expect(parseStoreInput("https://www.allbirds.com/products/mens-tree-runners")).toEqual({ kind: "custom", host: "www.allbirds.com" });
    expect(parseStoreInput("https://www.allbirds.com/collections/mens")).toEqual({ kind: "custom", host: "www.allbirds.com" });
  });

  it("refuses admin links, local or IP addresses, shopify.com pages and non-links, with a plain reason", () => {
    for (const admin of ["https://admin.shopify.com/store/crypto-app-test", "https://admin.shopify.com/store/x/orders/1", "https://crypto-app-test.myshopify.com/admin", "crypto-app-test.myshopify.com/admin/products/1"]) {
      expect(parseStoreInput(admin), admin).toEqual({ kind: "invalid", message: ADMIN_LINK });
    }
    expect(ADMIN_LINK).toBe("That's a store admin link; paste the shop's own address (like allbirds.com or a product page) instead.");
    for (const local of ["http://127.0.0.1:4070", "localhost:4070", "https://[::1]/", "http://10.0.0.5/shop", "https://printer.local", "https://127.1"]) {
      expect(parseStoreInput(local), local).toEqual({ kind: "invalid", message: LOCAL_LINK });
    }
    for (const site of ["https://shopify.com", "https://www.shopify.com/pricing", "https://help.shopify.com/en"]) {
      expect(parseStoreInput(site), site).toEqual({ kind: "invalid", message: SHOPIFY_SITE_LINK });
    }
    for (const bad of ["", "not a url", "ftp://x.myshopify.com", "https://intranet", 42, null]) {
      expect(parseStoreInput(bad), String(bad)).toEqual({ kind: "invalid", message: NOT_A_STORE_LINK });
    }
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
  const treasury = privateKeyToAccount(generatePrivateKey());
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
  /** Facilitator proxy: pass-through, fail /settle, or hold /settle for a while. */
  let failSettle = false;
  let settleDelayMs = 0;

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
  const discover = (url: string) => get(`/stores/discover?url=${encodeURIComponent(url)}`);
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
      if (settleDelayMs) await sleep(settleDelayMs);
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
      shopify: { apiVersion: "2026-10" },
    };
    app = createBridgeApp(config, { fetch: shop.fetch, account: treasury, now: () => clock, quiet: true, ucpAgentProfileUrl: null });
    bridgeServer.on("request", app);
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
    settleDelayMs = 0;
    shop.failCartCreate = undefined;
    shop.stock.clear();
  });

  it("GET /health", async () => {
    expect(await get("/health")).toEqual({ status: 200, body: { ok: true, stores: 0 } });
  });

  describe("discover", () => {
    const OPEN: ShopifyStore = {
      handle: "open-store",
      domain: "open-store.myshopify.com",
      storefrontUrl: "https://www.openstore.example",
      cardCheckout: true,
      name: "Open Store",
      currency: "USD",
      sampleImages: ["https://cdn.shopify.com/socks_480x.png", "https://cdn.shopify.com/cap_480x.png"],
      productCount: 3,
    };

    it("every link form finds the same store: myshopify, product page, custom domain (via /.well-known/ucp, following apex → www)", async () => {
      const forms = [
        "open-store.myshopify.com",
        "https://open-store.myshopify.com/products/wool-socks?variant=1",
        "https://www.openstore.example/products/wool-socks",
        "https://openstore.example/collections/all",
        "www.openstore.example",
      ];
      for (const url of forms) {
        const r = await discover(url);
        expect(r.status, url).toBe(200);
        expect(r.body, url).toEqual(OPEN);
      }
    });

    it("a custom domain without a UCP profile resolves through /meta.json; no card handler → cardCheckout false", async () => {
      const r = await discover("https://shop.plain.example/products/tee");
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        handle: "plain-store",
        domain: "plain-store.myshopify.com",
        storefrontUrl: "https://plain-store.myshopify.com",
        cardCheckout: false,
        name: "Plain Store",
        currency: "USD",
        sampleImages: ["https://cdn.shopify.com/tee_480x.png"],
        productCount: 1,
      });
    });

    it("every Storefront query asks for US prices (@inContext(country: US))", () => {
      expect(shop.storefrontQueries.length).toBeGreaterThan(0);
      for (const q of shop.storefrontQueries) expect(q).toContain("@inContext(country: US)");
    });

    it("a password-protected store → 422 private_catalog with a plain explanation", async () => {
      const r = await discover("locked-store.myshopify.com");
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ error: "store_unsupported", reason: "private_catalog", message: PRIVATE_CATALOG });
      expect(PRIVATE_CATALOG).toBe("This store's catalog isn't public yet (it's password-protected), so agents can't browse it.");
    });

    it("a store that doesn't sell to the US in USD → 422 currency", async () => {
      const r = await discover("euro-store.myshopify.com");
      expect(r.status).toBe(422);
      expect(r.body).toMatchObject({ error: "store_unsupported", reason: "currency", currency: "EUR" });
      expect(r.body.message).toBe("Euro Store doesn't sell to US shoppers in US dollars (it prices in EUR), so agents can't pay it in USDC.");
    });

    it("bad links → 400 with the reason, unknown stores → 404", async () => {
      const admin = await discover("https://admin.shopify.com/store/open-store");
      expect(admin).toEqual({ status: 400, body: { error: "invalid_store_url", message: ADMIN_LINK } });
      for (const url of ["", "not a url", "ftp://open-store.myshopify.com", "http://127.0.0.1:4070", "localhost"]) {
        const r = await discover(url);
        expect(r.status, url).toBe(400);
        expect(r.body.error).toBe("invalid_store_url");
      }
      expect((await get("/stores/discover")).body.error).toBe("invalid_store_url");
      const missing = await discover("https://nope-store.myshopify.com");
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: "store_not_found", message: "There's no Shopify store at nope-store.myshopify.com." });
      const notShopify = await discover("https://blog.example.org/post/1");
      expect(notShopify.status).toBe(404);
      expect(notShopify.body.error).toBe("store_not_found");
      expect(notShopify.body.message).toMatch(/^blog\.example\.org doesn't look like a Shopify store/);
    });

    it("has no side effects", async () => {
      expect((await get("/stores")).body).toEqual({ stores: [] });
      expect(existsSync(join(dataDir, "shopify-stores.json"))).toBe(false);
      expect(shop.cartCreates).toHaveLength(0);
    });
  });

  describe("registry", () => {
    it("POST /stores requires the owner key", async () => {
      expect((await post("/stores", { url: "open-store.myshopify.com" })).status).toBe(401);
      const wrong = await post("/stores", { url: "open-store.myshopify.com" }, { "x-owner-key": "ok_wrong" });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error).toBe("unauthorized");
      expect((await get("/stores")).body.stores).toEqual([]);
    });

    it("adds stores from any link, refuses duplicates with the existing store, persists them", async () => {
      expect((await post("/stores", {}, { "x-owner-key": OWNER })).status).toBe(400);
      const r = await post("/stores", { url: "https://www.openstore.example/products/cap" }, { "x-owner-key": OWNER });
      expect(r.status).toBe(201);
      expect(r.body.store).toMatchObject({ handle: "open-store", storefrontUrl: "https://www.openstore.example", cardCheckout: true, name: "Open Store", currency: "USD" });
      expect(r.body.store).not.toHaveProperty("mode");
      expect(typeof r.body.store.addedAt).toBe("string");
      const again = await post("/stores", { url: "open-store.myshopify.com" }, { "x-owner-key": OWNER });
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("store_exists");
      expect(again.body.store).toEqual(r.body.store);
      const plain = await post("/stores", { url: "plain-store.myshopify.com" }, { "x-owner-key": OWNER });
      expect(plain.status).toBe(201);
      expect((await post("/stores", { url: "euro-store.myshopify.com" }, { "x-owner-key": OWNER })).status).toBe(422);
      expect((await post("/stores", { url: "locked-store.myshopify.com" }, { "x-owner-key": OWNER })).body).toMatchObject({ reason: "private_catalog" });

      const list = await get("/stores");
      expect(list.body.stores.map((s: ShopifyStore) => s.handle)).toEqual(["open-store", "plain-store"]);
      expect((await get("/stores/open-store")).body.store).toEqual(r.body.store);
      expect((await get("/stores/nope")).status).toBe(404);
      const saved = JSON.parse(readFileSync(join(dataDir, "shopify-stores.json"), "utf8"));
      expect(saved.stores.map((s: { handle: string; source: string }) => `${s.handle}:${s.source}`)).toEqual(["open-store:storefront", "plain-store:storefront"]);
      expect((await get("/health")).body.stores).toBe(2);
    });
  });

  describe("products", () => {
    it("catalog: store facts, product pages on the storefront domain, search, limit, ≤ 300-char descriptions", async () => {
      const r = await get("/shops/open-store/products");
      expect(r.status).toBe(200);
      expect(r.body.store).toEqual({ name: "Open Store", storefrontUrl: "https://www.openstore.example", currency: "USD" });
      expect(r.body.products).toHaveLength(5);
      const socks = r.body.products[0];
      expect(socks).toMatchObject({
        id: "gid://shopify/Product/201",
        handle: "wool-socks",
        title: "Wool Socks",
        image: "https://cdn.shopify.com/socks_640x.png",
        url: "https://www.openstore.example/products/wool-socks",
        priceMin: "12.50",
        priceMax: "13.50",
        currency: "USD",
        available: true,
        variants: [
          { id: vGid(2011), title: "S", price: "12.50", available: true },
          { id: vGid(2012), title: "L", price: "13.50", available: true },
        ],
      });
      expect(socks.description.startsWith("Cozy socks.")).toBe(true);
      expect(socks.description.length).toBeLessThanOrEqual(300);
      expect(r.body.products.find((p: { handle: string }) => p.handle === "bobblehead").available).toBe(false);
      expect((await get("/shops/open-store/products?q=mug&limit=5")).body.products.map((p: { title: string }) => p.title)).toEqual(["Coffee Mug"]);
      expect((await get("/shops/open-store/products?limit=2")).body.products).toHaveLength(2);
    });

    it("one product by handle; 404s", async () => {
      const r = await get("/shops/open-store/products/cap");
      expect(r.status).toBe(200);
      expect(r.body.product).toMatchObject({ title: "Ball Cap", url: "https://www.openstore.example/products/cap" });
      expect((await get("/shops/open-store/products/nope")).body.error).toBe("product_not_found");
      expect((await get("/shops/unknown/products")).status).toBe(404);
    });
  });

  describe("carts", () => {
    it("a real Shopify cart (cartCreate, buyer country US): Shopify's totals and checkout link, the bridge's x402 checkout", async () => {
      const t0 = clock;
      const cart = await newCart("open-store", [{ variantId: vGid(2011), quantity: 2 }, { variantId: "2031", quantity: 1 }, { variantId: vGid(2011), quantity: 1 }], {
        email: "shopper@example.com",
        note: "gift",
      });
      expect(cart.cartId).toMatch(/^cart_[0-9a-f]{16}$/);
      expect(cart.store).toEqual({ handle: "open-store", name: "Open Store", domain: "open-store.myshopify.com", storefrontUrl: "https://www.openstore.example", currency: "USD", cardCheckout: true });
      expect(cart.lines).toEqual([
        { variantId: vGid(2011), title: "Wool Socks", variantTitle: "S", quantity: 3, unitPrice: "12.50", lineTotal: "37.50", image: "https://cdn.shopify.com/socks_640x.png", url: "https://www.openstore.example/products/wool-socks" },
        { variantId: vGid(2031), title: "Coffee Mug", variantTitle: "Default Title", quantity: 1, unitPrice: "14.99", lineTotal: "14.99", image: null, url: "https://www.openstore.example/products/mug" },
      ]);
      expect(cart).toMatchObject({ subtotal: "52.49", total: "52.49", currency: "USD", notes: ["Shipping and taxes are added at checkout"] });
      expect(cart.checkoutUrl).toBe(`${bridgeUrl}/shops/open-store/carts/${cart.cartId}/checkout`);
      expect(cart.shopifyCheckoutUrl).toMatch(/^https:\/\/www\.openstore\.example\/cart\/c\/c\d+\?key=/);
      expect(Date.parse(cart.expiresAt) - t0).toBe(30 * 60_000);
      const created = shop.cartCreates.at(-1)!;
      expect(created.input).toEqual({
        lines: [
          { merchandiseId: vGid(2011), quantity: 3 },
          { merchandiseId: vGid(2031), quantity: 1 },
        ],
        buyerIdentity: { countryCode: "US", email: "shopper@example.com" },
        note: "gift",
      });
      expect(created.query).toContain("@inContext(country: US)");
    });

    it("totals are Shopify's (a store discount lowers the line totals and the total)", async () => {
      const cart = await newCart("plain-store", [{ variantId: vGid(5011), quantity: 2 }]);
      expect(cart).toMatchObject({ subtotal: "40.00", total: "36.00" });
      expect(cart.lines[0]).toMatchObject({ unitPrice: "20.00", lineTotal: "36.00", url: "https://plain-store.myshopify.com/products/tee" });
    });

    it("limits, bad or sold-out variants, Shopify refusing or shrinking the cart, $0 carts", async () => {
      expect((await post("/shops/open-store/carts", { lines: [] })).status).toBe(400);
      expect((await post("/shops/open-store/carts", { lines: [{ variantId: vGid(2011), quantity: 21 }] })).status).toBe(400);
      expect((await post("/shops/open-store/carts", { lines: [{ variantId: "socks", quantity: 1 }] })).status).toBe(400);
      expect((await post("/shops/open-store/carts")).status).toBe(400);
      const before = shop.cartCreates.length;
      const unknown = await post("/shops/open-store/carts", { lines: [{ variantId: vGid(999999), quantity: 1 }] });
      expect(unknown.status).toBe(422);
      expect(unknown.body).toMatchObject({ error: "variant_not_found", variantIds: [vGid(999999)] });
      const soldOut = await post("/shops/open-store/carts", { lines: [{ variantId: vGid(2011), quantity: 1 }, { variantId: vGid(2041), quantity: 1 }] });
      expect(soldOut.status).toBe(422);
      expect(soldOut.body).toMatchObject({ error: "variant_unavailable", variantIds: [vGid(2041)] });
      expect(soldOut.body.message).toContain("Limited Bobblehead");
      expect(shop.cartCreates.length).toBe(before); // never sent to Shopify

      shop.failCartCreate = "userErrors";
      const refused = await post("/shops/open-store/carts", { lines: [{ variantId: vGid(2021), quantity: 1 }] });
      expect(refused.status).toBe(422);
      expect(refused.body).toEqual({ error: "cart_rejected", message: "Shopify refused the cart: The merchandise is not available for purchase." });
      shop.failCartCreate = undefined;

      shop.stock.set(vGid(2021), 2);
      const short = await post("/shops/open-store/carts", { lines: [{ variantId: vGid(2021), quantity: 5 }] });
      expect(short.status).toBe(422);
      expect(short.body).toMatchObject({ error: "variant_unavailable", variantIds: [vGid(2021)] });
      expect(short.body.message).toContain("Only 2 of Ball Cap");

      expect((await post("/shops/open-store/carts", { lines: [{ variantId: vGid(2051), quantity: 1 }] })).body.error).toBe("cart_total_zero");
      expect((await post("/shops/unknown/carts", { lines: [{ variantId: "1", quantity: 1 }] })).status).toBe(404);
    });
  });

  describe("checkout", () => {
    it("unpaid → 402 for the cart total to the Allowance Card treasury, naming the store; repeatable without side effects", async () => {
      const cart = await newCart("open-store", [{ variantId: vGid(2031), quantity: 2 }]);
      for (let i = 0; i < 2; i++) {
        const r = await fetch(cart.checkoutUrl, { method: "POST", headers: { accept: "application/json" } });
        expect(r.status).toBe(402);
        const pr = decodePaymentRequiredHeader(r.headers.get("payment-required")!) as any;
        expect(pr.accepts).toHaveLength(1);
        expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:84532", amount: "29980000", maxTimeoutSeconds: 300 });
        expect(getAddress(pr.accepts[0].payTo)).toBe(treasury.address);
        expect(pr.resource).toMatchObject({ description: "Open Store order", serviceName: "Open Store", url: cart.checkoutUrl });
      }
    });

    it("paid with @x402/fetch → a simulated Allowance Card confirmation; the ledger moves to the treasury; paid once", async () => {
      const cart = await newCart("open-store", [{ variantId: vGid(2012), quantity: 1 }, { variantId: vGid(2031), quantity: 2 }]);
      expect(cart.total).toBe("43.48");
      const buyerBefore = await balance(buyer.address);
      const treasuryBefore = await balance(treasury.address);

      const r = await pay(cart.checkoutUrl);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toEqual({
        status: "placed",
        simulated: true,
        reference: expect.stringMatching(REF_RE),
        store: { name: "Open Store", storefrontUrl: "https://www.openstore.example" },
        items: [
          { variantId: vGid(2012), title: "Wool Socks", variantTitle: "L", quantity: 1, unitPrice: "13.50", lineTotal: "13.50", image: "https://cdn.shopify.com/socks_640x.png", url: "https://www.openstore.example/products/wool-socks" },
          { variantId: vGid(2031), title: "Coffee Mug", variantTitle: "Default Title", quantity: 2, unitPrice: "14.99", lineTotal: "29.98", image: null, url: "https://www.openstore.example/products/mug" },
        ],
        total: "43.48",
        currency: "USD",
        card: { brand: "Allowance Card", last4: expect.stringMatching(/^\d{4}$/) },
        paidAt: new Date(clock).toISOString(),
        explanation:
          "For a real order, Allowance would issue a single-use card for $43.48 and pay Open Store through Shopify's agent card checkout; card issuing isn't wired yet, so Open Store did not receive this order.",
      });
      expect(JSON.stringify(r.body)).not.toMatch(/admin/i);
      const settle = decodePaymentResponseHeader(r.headers.get("payment-response")!) as any;
      expect(settle.success).toBe(true);
      expect(settle.transaction).toMatch(/^0x[0-9a-f]{64}$/);
      expect(buyerBefore - (await balance(buyer.address))).toBe(toBaseUnits("43.48"));
      expect((await balance(treasury.address)) - treasuryBefore).toBe(toBaseUnits("43.48"));

      // A cart is paid once: the second call answers 409 with the same confirmation (and the tx), before any 402.
      const again = await pay(cart.checkoutUrl);
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("cart_already_paid");
      expect(again.body.message).toContain(r.body.reference);
      expect(again.body.confirmation).toEqual({ ...r.body, txHash: settle.transaction, explorerUrl: `${facUrl}/tx/${settle.transaction}` });
      const unpaidAgain = await post(new URL(cart.checkoutUrl).pathname);
      expect(unpaidAgain.status).toBe(409);
      expect(unpaidAgain.headers.get("payment-required")).toBeNull();
      expect(buyerBefore - (await balance(buyer.address))).toBe(toBaseUnits("43.48"));
    });

    it("a store without agent card checkout says so in the explanation", async () => {
      const cart = await newCart("plain-store", [{ variantId: vGid(5011), quantity: 1 }]);
      const r = await pay(cart.checkoutUrl);
      expect(r.status).toBe(200);
      expect(r.body.total).toBe("18.00");
      expect(r.body.explanation).toBe(
        "For a real order, Allowance would issue a single-use card for $18.00 and pay Plain Store at Shopify checkout (this store doesn't advertise card checkout for agents yet); card issuing isn't wired, so Plain Store did not receive this order.",
      );
    });

    it("settlement fails → nothing charged, the confirmation is withdrawn, the cart reopens with the same card", async () => {
      const cart = await newCart("open-store", [{ variantId: vGid(2021), quantity: 1 }]);
      const buyerBefore = await balance(buyer.address);
      failSettle = true;
      const r = await pay(cart.checkoutUrl);
      expect(r.status).toBe(402);
      expect(r.body.error).toBe("payment_not_settled");
      expect(await balance(buyer.address)).toBe(buyerBefore);
      expect(app.locals.carts.get(cart.cartId)).toMatchObject({ status: "open", confirmation: undefined });
      const last4 = app.locals.carts.get(cart.cartId)!.cardLast4;

      failSettle = false;
      const retry = await pay(cart.checkoutUrl);
      expect(retry.status).toBe(200);
      expect(retry.body.card.last4).toBe(last4);
      expect(buyerBefore - (await balance(buyer.address))).toBe(toBaseUnits("20.00"));
    });

    it("while a payment is settling, another checkout answers 409 before the paywall (never charged)", async () => {
      const cart = await newCart("open-store", [{ variantId: vGid(2011), quantity: 1 }]);
      const buyerBefore = await balance(buyer.address);
      settleDelayMs = 300;
      const paying = pay(cart.checkoutUrl);
      let status = "";
      for (let i = 0; i < 50 && status !== "settling"; i++) {
        await sleep(10);
        status = app.locals.carts.get(cart.cartId)?.status ?? "";
      }
      expect(status).toBe("settling");
      const busy = await post(new URL(cart.checkoutUrl).pathname);
      expect(busy.status).toBe(409);
      expect(busy.body.error).toBe("checkout_in_progress");
      expect(busy.headers.get("payment-required")).toBeNull();
      expect((await paying).status).toBe(200);
      expect(buyerBefore - (await balance(buyer.address))).toBe(toBaseUnits("12.50"));
    });

    it("two concurrent checkouts of one cart → one confirmation, one charge", async () => {
      const cart = await newCart("open-store", [{ variantId: vGid(2031), quantity: 1 }]);
      const buyerBefore = await balance(buyer.address);
      const results = await Promise.all([pay(cart.checkoutUrl), pay(cart.checkoutUrl)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(buyerBefore - (await balance(buyer.address))).toBe(toBaseUnits("14.99"));
    });

    it("one signed payment presented at two carts with the same total → one charge", async () => {
      const a = await newCart("open-store", [{ variantId: vGid(2031), quantity: 1 }]);
      const b = await newCart("open-store", [{ variantId: vGid(2031), quantity: 1 }]);
      const pr = decodePaymentRequiredHeader((await fetch(a.checkoutUrl, { method: "POST" })).headers.get("payment-required")!);
      const client = new x402Client().register("eip155:84532", new ExactEvmScheme(buyer));
      client.setSpendControls({ maxAmountPerPayment: "$1000" });
      const header = encodePaymentSignatureHeader(await client.createPaymentPayload(pr as never));
      const buyerBefore = await balance(buyer.address);
      const results = await Promise.all([a, b].map((c) => fetch(c.checkoutUrl, { method: "POST", headers: { "PAYMENT-SIGNATURE": header } })));
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409 || s === 402)).toHaveLength(1);
      expect(buyerBefore - (await balance(buyer.address))).toBe(toBaseUnits("14.99"));
    });

    it("unknown, other-store and expired carts → 404 before the paywall, never charged", async () => {
      const buyerBefore = await balance(buyer.address);
      const unknown = await pay(`${bridgeUrl}/shops/open-store/carts/cart_0000000000000000/checkout`);
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get("payment-required")).toBeNull();
      const cart = await newCart("open-store", [{ variantId: vGid(2031), quantity: 1 }]);
      expect((await pay(`${bridgeUrl}/shops/plain-store/carts/${cart.cartId}/checkout`)).status).toBe(404);
      clock += 31 * 60_000;
      const r = await pay(cart.checkoutUrl);
      expect(r.status).toBe(404);
      expect(r.body.error).toBe("cart_not_found");
      expect(await balance(buyer.address)).toBe(buyerBefore);
    });
  });

  describe("UCP fallback", () => {
    it("reads a password-protected store through UCP when an agent profile is configured; carts use catalog prices and a cart link", async () => {
      const dir = mkdtempSync(join(tmpdir(), "allowance-shopify-ucp-"));
      const ucpApp = createBridgeApp(
        { ...config, dataDir: dir, shopify: { apiVersion: "2026-10", ucpAgentProfileUrl: "https://agent.example.com/.well-known/ucp" } },
        { fetch: shop.fetch, account: treasury, quiet: true },
      );
      const s = createServer(ucpApp);
      const url = await listen(s);
      const d = await fetch(`${url}/stores/discover?url=locked-store.myshopify.com`);
      expect(d.status).toBe(200);
      expect(await d.json()).toEqual({
        handle: "locked-store",
        domain: "locked-store.myshopify.com",
        storefrontUrl: "https://locked-store.myshopify.com",
        cardCheckout: false,
        name: "Locked Store",
        currency: "USD",
        sampleImages: ["https://cdn.shopify.com/pin.png"],
        productCount: 0,
      });
      const reg = await fetch(`${url}/stores`, { method: "POST", headers: { "content-type": "application/json", "x-owner-key": OWNER }, body: JSON.stringify({ url: "locked-store.myshopify.com" }) });
      expect(reg.status).toBe(201);
      const products = (await (await fetch(`${url}/shops/locked-store/products?q=pin`)).json()) as any;
      expect(products.products[0]).toMatchObject({
        handle: "enamel-pin",
        url: "https://locked-store.myshopify.com/products/enamel-pin",
        priceMin: "4.50",
        priceMax: "5.00",
        variants: [
          { id: vGid(4011), title: "Gold", price: "5.00", available: true },
          { id: vGid(4012), title: "Silver", price: "4.50", available: false },
        ],
      });
      const cart = await fetch(`${url}/shops/locked-store/carts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lines: [{ variantId: vGid(4011), quantity: 2 }] }) });
      expect(cart.status).toBe(201);
      expect(await cart.json()).toMatchObject({ total: "10.00", shopifyCheckoutUrl: "https://locked-store.myshopify.com/cart/4011:2" });
      await close(s);
    });
  });

  describe("restart", () => {
    it("a restarted bridge loads its stores; files from the earlier admin build load without their mode", async () => {
      const again = createBridgeApp(config, { fetch: shop.fetch, account: treasury, now: () => clock, quiet: true, ucpAgentProfileUrl: null });
      expect(again.locals.registry.list().map((s) => s.handle)).toEqual(["open-store", "plain-store"]);

      const legacyDir = mkdtempSync(join(tmpdir(), "allowance-shopify-legacy-"));
      writeFileSync(
        join(legacyDir, "shopify-stores.json"),
        JSON.stringify({ stores: [{ handle: "crypto-app-test", domain: "crypto-app-test.myshopify.com", mode: "agent_checkout", name: "Crypto App Test", currency: "USD", source: "admin" }] }),
      );
      const legacy = new StoreRegistry(legacyDir).get("crypto-app-test")!;
      expect(legacy).toEqual({
        handle: "crypto-app-test",
        domain: "crypto-app-test.myshopify.com",
        storefrontUrl: "https://crypto-app-test.myshopify.com",
        cardCheckout: false,
        name: "Crypto App Test",
        currency: "USD",
        source: "storefront",
      });
    });

    it("without an owner key or treasury the bridge creates both and serves discovery", async () => {
      const dir = mkdtempSync(join(tmpdir(), "allowance-shopify-fresh-"));
      const fresh = createBridgeApp({ ...config, dataDir: dir, ownerApiKey: undefined }, { fetch: shop.fetch, quiet: true, ucpAgentProfileUrl: null });
      const s = createServer(fresh);
      const url = await listen(s);
      expect(existsSync(join(dir, "shopify-bridge-key.json"))).toBe(true);
      expect(existsSync(join(dir, "owner-key.json"))).toBe(true);
      expect(((await (await fetch(`${url}/stores/discover?url=open-store.myshopify.com`)).json()) as ShopifyStore).name).toBe("Open Store");
      await close(s);
    });
  });
});
