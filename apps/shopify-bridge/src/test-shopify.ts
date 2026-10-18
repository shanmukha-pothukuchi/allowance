/**
 * Test double for public Shopify stores (tokenless Storefront GraphQL incl. `cartCreate`,
 * `/.well-known/ucp`, `/meta.json`, and the UCP MCP catalog), on port 0. Not a test file.
 * `stub.fetch` rewrites `https://<host>/<path>` to the stub and passes the original host in
 * `x-stub-host`, so the bridge builds real Shopify URLs.
 */
import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubVariant {
  id: number;
  title: string;
  price: string;
  available: boolean;
}

export interface StubProduct {
  id: number;
  handle: string;
  title: string;
  description: string;
  image?: string;
  variants: StubVariant[];
}

export interface StubShop {
  domain: string;
  name: string;
  /** Presentment currency for US shoppers. */
  currency: string;
  /** Country `@inContext(country: US)` resolves to ("US" unless the store doesn't sell to the US). */
  country?: string;
  storefront: "open" | "locked";
  /** primaryDomain.url (default `https://<domain>`). */
  primaryDomain?: string;
  /** `/.well-known/ucp` lists the dev.shopify.card payment handler. */
  cardCheckout: boolean;
  /** Answers UCP `tools/call` at /api/ucp/mcp (needs an agent profile in meta). */
  ucp?: boolean;
  /** `/meta.json` published_products_count. */
  publishedProducts?: number;
  /** Automatic discount Shopify applies in carts (percent off every line). */
  cartDiscountPercent?: number;
  products: StubProduct[];
}

export interface StubShopify {
  url: string;
  fetch: typeof fetch;
  shops: Map<string, StubShop>;
  /** Custom storefront host → myshopify domain named by its /.well-known/ucp. */
  ucpHosts: Map<string, string>;
  /** Custom storefront host → myshopify domain named only by its /meta.json (no UCP profile). */
  metaHosts: Map<string, string>;
  /** Host → host it 301-redirects to (e.g. apex → www). */
  redirects: Map<string, string>;
  cartCreates: { domain: string; input: Record<string, any>; query: string }[];
  /** Storefront operations as "<domain>:<op>", in order. */
  storefrontOps: string[];
  /** Every Storefront GraphQL document received. */
  storefrontQueries: string[];
  /** Variant GID → most Shopify will put in a cart (it reduces the line and warns). */
  stock: Map<string, number>;
  failCartCreate?: "userErrors";
  close(): Promise<void>;
}

const vGid = (id: number) => `gid://shopify/ProductVariant/${id}`;
const pGid = (id: number) => `gid://shopify/Product/${id}`;

export const OPEN_STORE: StubShop = {
  domain: "open-store.myshopify.com",
  name: "Open Store",
  currency: "USD",
  storefront: "open",
  primaryDomain: "https://www.openstore.example",
  cardCheckout: true,
  publishedProducts: 3,
  products: [
    {
      id: 201,
      handle: "wool-socks",
      title: "Wool Socks",
      description: "<p>Cozy <b>socks</b>. </p>" + "Warm. ".repeat(80),
      image: "https://cdn.shopify.com/socks.png",
      variants: [
        { id: 2011, title: "S", price: "12.5", available: true },
        { id: 2012, title: "L", price: "13.5", available: true },
      ],
    },
    { id: 202, handle: "cap", title: "Ball Cap", description: "Cap.", image: "https://cdn.shopify.com/cap.png", variants: [{ id: 2021, title: "Default Title", price: "20.00", available: true }] },
    { id: 203, handle: "mug", title: "Coffee Mug", description: "Mug.", variants: [{ id: 2031, title: "Default Title", price: "14.99", available: true }] },
    { id: 204, handle: "bobblehead", title: "Limited Bobblehead", description: "Sold out.", variants: [{ id: 2041, title: "Default Title", price: "19.00", available: false }] },
    { id: 205, handle: "sticker", title: "Sticker", description: "Free sticker.", variants: [{ id: 2051, title: "Default Title", price: "0.00", available: true }] },
  ],
};

/** No card handler in its UCP profile, a cart discount, and no custom domain. */
export const PLAIN_STORE: StubShop = {
  domain: "plain-store.myshopify.com",
  name: "Plain Store",
  currency: "USD",
  storefront: "open",
  cardCheckout: false,
  cartDiscountPercent: 10,
  products: [{ id: 501, handle: "tee", title: "Plain Tee", description: "A tee.", image: "https://cdn.shopify.com/tee.png", variants: [{ id: 5011, title: "M", price: "20.00", available: true }] }],
};

/** A fresh dev store: storefront password on, no payment handlers (like crypto-app-test). */
export const LOCKED_STORE: StubShop = {
  domain: "locked-store.myshopify.com",
  name: "Locked Store",
  currency: "USD",
  storefront: "locked",
  cardCheckout: false,
  ucp: true,
  publishedProducts: 0,
  products: [
    {
      id: 401,
      handle: "enamel-pin",
      title: "Enamel Pin",
      description: "A pin.",
      image: "https://cdn.shopify.com/pin.png",
      variants: [
        { id: 4011, title: "Gold", price: "5.00", available: true },
        { id: 4012, title: "Silver", price: "4.50", available: false },
      ],
    },
  ],
};

export const EURO_STORE: StubShop = {
  domain: "euro-store.myshopify.com",
  name: "Euro Store",
  currency: "EUR",
  country: "FR",
  storefront: "open",
  cardCheckout: true,
  products: [{ id: 301, handle: "baguette", title: "Baguette", description: "Bread.", variants: [{ id: 3011, title: "Default Title", price: "2.00", available: true }] }],
};

export async function startStubShopify(opts: { shops?: StubShop[] } = {}): Promise<StubShopify> {
  const stub: StubShopify = {
    url: "",
    fetch: fetch,
    shops: new Map((opts.shops ?? [OPEN_STORE, PLAIN_STORE, LOCKED_STORE, EURO_STORE]).map((s) => [s.domain, structuredClone(s)])),
    ucpHosts: new Map([
      ["www.openstore.example", OPEN_STORE.domain],
      ["openstore.example", OPEN_STORE.domain],
    ]),
    metaHosts: new Map([["shop.plain.example", PLAIN_STORE.domain]]),
    redirects: new Map([["openstore.example", "www.openstore.example"]]),
    cartCreates: [],
    storefrontOps: [],
    storefrontQueries: [],
    stock: new Map(),
    close: async () => {},
  };

  const app = express();
  app.use(express.json());

  const hostOf = (req: Request) => String(req.header("x-stub-host") ?? "").toLowerCase();
  const notFound = (res: Response) => res.status(404).json({ errors: [{ message: "Not Found", extensions: { code: "NOT_FOUND" } }] });
  const opName = (q: unknown) => /(?:query|mutation)\s+(\w+)/.exec(String(q ?? ""))?.[1] ?? "anonymous";
  const allVariants = (shop: StubShop) => shop.products.flatMap((p) => p.variants.map((v) => ({ p, v })));
  const storefrontOf = (shop: StubShop) => shop.primaryDomain ?? `https://${shop.domain}`;
  const cents = (s: string | number) => Math.round(Number(s) * 100);
  const dollars = (c: number) => (c / 100).toFixed(2);
  const redirectTo = (req: Request, res: Response): boolean => {
    const to = stub.redirects.get(hostOf(req));
    if (!to) return false;
    res.redirect(301, `https://${to}${req.originalUrl}`);
    return true;
  };

  // ---- /.well-known/ucp and /meta.json -------------------------------------------------------------
  app.get("/.well-known/ucp", (req, res) => {
    if (redirectTo(req, res)) return;
    const host = hostOf(req);
    const target = stub.ucpHosts.get(host) ?? (stub.shops.has(host) ? host : undefined);
    const shop = target ? stub.shops.get(target) : undefined;
    if (!target || !shop) return void res.status(404).type("html").send("<html>404</html>");
    res.json({
      ucp: {
        version: "2026-08-25",
        services: { "dev.ucp.shopping": [{ version: "2026-08-25", transport: "mcp", endpoint: `https://${target}/api/ucp/mcp` }] },
        payment_handlers: shop.cardCheckout ? { "com.google.pay": [{ id: "gpay" }], "dev.shopify.card": [{ id: "shopify.card" }], "dev.shopify.shop_pay": [{ id: "shop_pay" }] } : {},
      },
    });
  });

  app.get("/meta.json", (req, res) => {
    if (redirectTo(req, res)) return;
    const host = hostOf(req);
    const target = stub.metaHosts.get(host) ?? stub.ucpHosts.get(host) ?? (stub.shops.has(host) ? host : undefined);
    const shop = target ? stub.shops.get(target) : undefined;
    if (!shop) return void res.status(404).json({ errors: "Not Found" });
    res.json({
      name: shop.name,
      currency: shop.currency,
      url: storefrontOf(shop),
      myshopify_domain: shop.domain,
      ...(shop.publishedProducts !== undefined ? { published_products_count: shop.publishedProducts } : {}),
    });
  });

  // ---- Storefront GraphQL (tokenless) ----------------------------------------------------------------
  app.post("/api/:version/graphql.json", (req, res) => {
    const shop = stub.shops.get(hostOf(req));
    if (!shop) return void notFound(res);
    const { query, variables = {} } = req.body as { query: string; variables?: Record<string, any> };
    const op = opName(query);
    stub.storefrontOps.push(`${shop.domain}:${op}`);
    stub.storefrontQueries.push(query);
    if (shop.storefront === "locked") {
      return void res.status(400).json({ errors: [{ message: "Online Store channel is locked.", extensions: { code: "BAD_REQUEST" } }] });
    }
    const money = (amount: string | number) => ({ amount: String(amount), currencyCode: shop.currency });
    const image = (url: string | undefined) => (url ? { url: url.replace(/\.png$/, "_640x.png") } : null);
    const onlineUrl = (p: StubProduct) => `${storefrontOf(shop)}/products/${p.handle}`;
    const sfProduct = (p: StubProduct, nVariants: number) => {
      const prices = p.variants.map((v) => Number(v.price));
      return {
        id: pGid(p.id),
        handle: p.handle,
        title: p.title,
        description: p.description.replace(/<[^>]+>/g, ""),
        onlineStoreUrl: onlineUrl(p),
        availableForSale: p.variants.some((v) => v.available),
        featuredImage: image(p.image),
        priceRange: { minVariantPrice: money(Math.min(...prices).toFixed(1)), maxVariantPrice: money(Math.max(...prices).toFixed(1)) },
        variants: { nodes: p.variants.slice(0, nVariants).map((v) => ({ id: vGid(v.id), title: v.title, availableForSale: v.available, price: money(v.price) })) },
      };
    };
    const search = (q: unknown, first: number) => {
      const t = String(q ?? "").trim().toLowerCase();
      return shop.products.filter((p) => !t || p.title.toLowerCase().includes(t)).slice(0, first);
    };
    switch (op) {
      case "BridgeShop":
        return void res.json({
          data: {
            shop: { name: shop.name, primaryDomain: { url: storefrontOf(shop) }, paymentSettings: { currencyCode: shop.currency } },
            localization: { country: { isoCode: shop.country ?? "US", currency: { isoCode: shop.currency } } },
            products: { nodes: shop.products.map((p) => ({ featuredImage: p.image ? { url: p.image.replace(/\.png$/, "_480x.png") } : null })), pageInfo: { hasNextPage: false } },
          },
        });
      case "BridgeProducts":
        return void res.json({ data: { products: { nodes: search(variables.query, variables.first).map((p) => sfProduct(p, variables.variants)) } } });
      case "BridgeProduct": {
        const p = shop.products.find((x) => x.handle === variables.handle);
        return void res.json({ data: { product: p ? sfProduct(p, variables.variants) : null } });
      }
      case "BridgeVariants": {
        const all = allVariants(shop);
        const nodes = (variables.ids as string[]).map((id) => {
          const hit = all.find(({ v }) => vGid(v.id) === id);
          return hit
            ? { id, title: hit.v.title, availableForSale: hit.v.available, price: money(hit.v.price), image: null, product: { title: hit.p.title, handle: hit.p.handle, onlineStoreUrl: onlineUrl(hit.p), featuredImage: image(hit.p.image) } }
            : null;
        });
        return void res.json({ data: { nodes } });
      }
      case "BridgeCartCreate": {
        const input = variables.input as { lines: { merchandiseId: string; quantity: number }[] };
        stub.cartCreates.push({ domain: shop.domain, input: variables.input, query });
        if (stub.failCartCreate === "userErrors") {
          return void res.json({ data: { cartCreate: { cart: null, userErrors: [{ field: ["input", "lines", "0"], message: "The merchandise is not available for purchase.", code: "INVALID" }], warnings: [] } } });
        }
        const all = allVariants(shop);
        const warnings: { code: string; message: string }[] = [];
        const off = shop.cartDiscountPercent ?? 0;
        let subtotal = 0;
        let total = 0;
        const nodes = input.lines.flatMap((l) => {
          const hit = all.find(({ v }) => vGid(v.id) === l.merchandiseId);
          if (!hit) return [];
          const limit = stub.stock.get(l.merchandiseId);
          const quantity = limit !== undefined ? Math.min(limit, l.quantity) : l.quantity;
          if (quantity < l.quantity) warnings.push({ code: "MERCHANDISE_NOT_ENOUGH_STOCK", message: `Only ${quantity} of ${hit.p.title} could be added to the cart.` });
          if (quantity === 0) return [];
          const unit = cents(hit.v.price);
          const line = Math.round((unit * quantity * (100 - off)) / 100);
          subtotal += unit * quantity;
          total += line;
          return [
            {
              quantity,
              cost: { amountPerQuantity: money(dollars(unit)), totalAmount: money(dollars(line)) },
              merchandise: { id: l.merchandiseId, title: hit.v.title, image: null, product: { title: hit.p.title, handle: hit.p.handle, onlineStoreUrl: onlineUrl(hit.p), featuredImage: image(hit.p.image) } },
            },
          ];
        });
        const n = stub.cartCreates.length;
        const host = new URL(storefrontOf(shop)).host;
        return void res.json({
          data: {
            cartCreate: {
              cart: {
                id: `gid://shopify/Cart/c${n}?key=k${n}`,
                checkoutUrl: `https://${host}/cart/c/c${n}?key=k${n}`,
                cost: { subtotalAmount: money(dollars(subtotal)), totalAmount: money(dollars(total)) },
                lines: { nodes },
              },
              userErrors: [],
              warnings,
            },
          },
        });
      }
      default:
        return void res.json({ errors: [{ message: `stub: unknown operation ${op}` }] });
    }
  });

  // ---- UCP MCP (JSON-RPC tools/call) -----------------------------------------------------------------
  app.post("/api/ucp/mcp", (req, res) => {
    const shop = stub.shops.get(hostOf(req));
    if (!shop || !shop.ucp) return void notFound(res);
    const { id, params } = req.body as { id: number; params: { name: string; arguments: Record<string, any> } };
    stub.storefrontOps.push(`${shop.domain}:ucp:${params?.name}`);
    if (!params?.arguments?.meta?.["ucp-agent"]?.profile) {
      return void res.json({ jsonrpc: "2.0", id, error: { code: -32001, message: "UCP discovery failed", data: { code: "version_unsupported", content: "Unable to fetch agent profile: Missing ucp version" } } });
    }
    const ucpProduct = (p: StubProduct) => {
      const prices = p.variants.map((v) => cents(v.price));
      return {
        id: pGid(p.id),
        handle: p.handle,
        title: p.title,
        description: { plain: p.description },
        url: `https://${shop.domain}/products/${p.handle}`,
        price_range: { min: { amount: Math.min(...prices), currency: shop.currency }, max: { amount: Math.max(...prices), currency: shop.currency } },
        media: p.image ? [{ type: "image", url: p.image }] : [],
        variants: p.variants.map((v) => ({ id: vGid(v.id), title: v.title, price: { amount: cents(v.price), currency: shop.currency }, availability: { available: v.available } })),
      };
    };
    let out: { products: unknown[] };
    if (params.name === "search_catalog") {
      const q = String(params.arguments.catalog?.query ?? "").toLowerCase();
      out = { products: shop.products.filter((p) => !q || p.title.toLowerCase().includes(q) || p.handle.replace(/-/g, " ").includes(q)).map(ucpProduct) };
    } else if (params.name === "lookup_catalog") {
      const ids = new Set(params.arguments.catalog?.ids as string[]);
      out = { products: shop.products.filter((p) => p.variants.some((v) => ids.has(vGid(v.id)))).map(ucpProduct) };
    } else {
      return void res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${params.name}` } });
    }
    res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out } });
  });

  app.use((_req, res) => void res.status(404).type("html").send("<html>Not found</html>"));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    headers.set("x-stub-host", u.host);
    return fetch(`${stub.url}${u.pathname}${u.search}`, { ...init, headers });
  }) as typeof fetch;
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}
