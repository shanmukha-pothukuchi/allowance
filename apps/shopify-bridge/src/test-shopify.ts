/**
 * Test double for Shopify (Admin token endpoint + Admin GraphQL + tokenless Storefront GraphQL +
 * `/.well-known/ucp`), on port 0. Not a test file. `stub.fetch` rewrites `https://<host>/<path>` to
 * the stub and passes the original host in `x-stub-host`, so the bridge builds real Shopify URLs.
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
  currency: string;
  storefront: "open" | "locked";
  /** Has an Admin API app installed (token endpoint + Admin GraphQL). */
  admin: boolean;
  /** Answers UCP `tools/call` at /api/ucp/mcp (needs an agent profile in meta). */
  ucp?: boolean;
  products: StubProduct[];
}

export interface StubOrder {
  id: string;
  name: string;
  legacyResourceId: string;
  domain: string;
  order: Record<string, any>;
  options: Record<string, any>;
  note: string;
  cancelled?: { staffNote?: string };
}

export interface StubShopify {
  url: string;
  fetch: typeof fetch;
  shops: Map<string, StubShop>;
  /** Custom storefront host → myshopify domain named by its /.well-known/ucp. */
  ucpHosts: Map<string, string>;
  clientId: string;
  clientSecret: string;
  tokenTtlSeconds: number;
  tokensIssued: number;
  validTokens: Set<string>;
  orders: StubOrder[];
  orderUpdates: { id: string; note: string }[];
  orderCancels: { orderId: string; staffNote?: string }[];
  cartCreates: { domain: string; input: Record<string, any> }[];
  /** Admin GraphQL operation names, in order. */
  adminOps: string[];
  storefrontOps: string[];
  failOrderCreate?: "userErrors" | "http500";
  close(): Promise<void>;
}

const vGid = (id: number) => `gid://shopify/ProductVariant/${id}`;
const pGid = (id: number) => `gid://shopify/Product/${id}`;

export const DEV_STORE: StubShop = {
  domain: "dev-store.myshopify.com",
  name: "Dev Store",
  currency: "USD",
  storefront: "locked",
  admin: true,
  products: [
    {
      id: 101,
      handle: "terps-hoodie",
      title: "UMD Terps Hoodie",
      description: "A warm hoodie. ".repeat(40),
      image: "https://cdn.shopify.com/hoodie.png",
      variants: [
        { id: 1011, title: "Small", price: "49.00", available: true },
        { id: 1012, title: "Medium", price: "49.00", available: true },
        { id: 1013, title: "Large", price: "52.00", available: false },
      ],
    },
    { id: 102, handle: "testudo-sticker", title: "UMD Testudo Sticker", description: "Sticker.", variants: [{ id: 1021, title: "Default Title", price: "0.01", available: true }] },
    { id: 103, handle: "coffee-mug", title: "Maryland Terrapins Coffee Mug", description: "Mug.", variants: [{ id: 1031, title: "Default Title", price: "14.99", available: true }] },
    { id: 104, handle: "bobblehead", title: "Limited Edition Testudo Bobblehead", description: "Sold out.", variants: [{ id: 1041, title: "Default Title", price: "19.00", available: false }] },
  ],
};

export const OPEN_STORE: StubShop = {
  domain: "open-store.myshopify.com",
  name: "Open Store",
  currency: "USD",
  storefront: "open",
  admin: false,
  products: [
    {
      id: 201,
      handle: "wool-socks",
      title: "Wool Socks",
      description: "<p>Cozy <b>socks</b>.</p>",
      image: "https://cdn.shopify.com/socks.png",
      variants: [
        { id: 2011, title: "S", price: "12.5", available: true },
        { id: 2012, title: "L", price: "13.5", available: true },
      ],
    },
    { id: 202, handle: "cap", title: "Ball Cap", description: "Cap.", variants: [{ id: 2021, title: "Default Title", price: "20.00", available: true }] },
  ],
};

export const LOCKED_STORE: StubShop = {
  domain: "locked-store.myshopify.com",
  name: "Locked Store",
  currency: "USD",
  storefront: "locked",
  admin: false,
  ucp: true,
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
  storefront: "open",
  admin: false,
  products: [{ id: 301, handle: "baguette", title: "Baguette", description: "Bread.", variants: [{ id: 3011, title: "Default Title", price: "2.00", available: true }] }],
};

export async function startStubShopify(opts: { shops?: StubShop[] } = {}): Promise<StubShopify> {
  const stub: StubShopify = {
    url: "",
    fetch: fetch,
    shops: new Map((opts.shops ?? [DEV_STORE, OPEN_STORE, LOCKED_STORE, EURO_STORE]).map((s) => [s.domain, structuredClone(s)])),
    ucpHosts: new Map([["shop.example.com", OPEN_STORE.domain]]),
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    tokenTtlSeconds: 86_399,
    tokensIssued: 0,
    validTokens: new Set(),
    orders: [],
    orderUpdates: [],
    orderCancels: [],
    cartCreates: [],
    adminOps: [],
    storefrontOps: [],
    close: async () => {},
  };

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  const hostOf = (req: Request) => String(req.header("x-stub-host") ?? "").toLowerCase();
  const notFound = (res: Response) => res.status(404).json({ errors: [{ message: "Not Found", extensions: { code: "NOT_FOUND" } }] });
  const opName = (q: unknown) => /(?:query|mutation)\s+(\w+)/.exec(String(q ?? ""))?.[1] ?? "anonymous";
  const allVariants = (shop: StubShop) => shop.products.flatMap((p) => p.variants.map((v) => ({ p, v })));
  const terms = (query: unknown) =>
    String(query ?? "")
      .replace(/status:active/g, "")
      .replace(/handle:\S+/g, "")
      .trim()
      .toLowerCase();
  const handleFilter = (query: unknown) => /handle:(\S+)/.exec(String(query ?? ""))?.[1];
  const search = (shop: StubShop, query: unknown, first: number) => {
    const t = terms(query);
    const h = handleFilter(query);
    return shop.products.filter((p) => (!h || p.handle === h) && (!t || p.title.toLowerCase().includes(t))).slice(0, first);
  };

  // ---- /.well-known/ucp --------------------------------------------------------------------------
  app.get("/.well-known/ucp", (req, res) => {
    const target = stub.ucpHosts.get(hostOf(req)) ?? (stub.shops.has(hostOf(req)) ? hostOf(req) : undefined);
    if (!target) return void notFound(res);
    res.json({ ucp: { version: "2026-08-25", services: { "dev.ucp.shopping": [{ version: "2026-08-25", transport: "mcp", endpoint: `https://${target}/api/ucp/mcp` }] }, payment_handlers: {} } });
  });

  // ---- Admin: client credentials grant --------------------------------------------------------------
  app.post("/admin/oauth/access_token", (req, res) => {
    const shop = stub.shops.get(hostOf(req));
    if (!shop) return void notFound(res);
    const b = req.body as Record<string, string>;
    if (!shop.admin || b.grant_type !== "client_credentials" || b.client_id !== stub.clientId || b.client_secret !== stub.clientSecret) {
      return void res.status(400).type("html").send("<html><body>Oauth error invalid_request</body></html>");
    }
    const token = `shpat_test_${++stub.tokensIssued}`;
    stub.validTokens.add(token);
    res.json({ access_token: token, scope: "read_products,write_orders", expires_in: stub.tokenTtlSeconds });
  });

  // ---- Admin GraphQL ----------------------------------------------------------------------------------
  app.post("/admin/api/:version/graphql.json", (req, res) => {
    const shop = stub.shops.get(hostOf(req));
    if (!shop || !shop.admin) return void notFound(res);
    const token = req.header("x-shopify-access-token");
    if (!token || !stub.validTokens.has(token)) {
      return void res.status(401).json({ errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" });
    }
    const { query, variables = {} } = req.body as { query: string; variables?: Record<string, any> };
    const op = opName(query);
    stub.adminOps.push(op);
    const adminProduct = (p: StubProduct, nVariants: number) => {
      const prices = p.variants.map((v) => Number(v.price));
      const money = (n: number) => ({ amount: n.toFixed(2), currencyCode: shop.currency });
      return {
        id: pGid(p.id),
        handle: p.handle,
        title: p.title,
        description: p.description,
        onlineStoreUrl: null,
        status: "ACTIVE",
        featuredMedia: p.image ? { preview: { image: { url: p.image } } } : null,
        priceRangeV2: { minVariantPrice: money(Math.min(...prices)), maxVariantPrice: money(Math.max(...prices)) },
        variants: { nodes: p.variants.slice(0, nVariants).map((v) => ({ id: vGid(v.id), title: v.title, price: v.price, availableForSale: v.available })) },
      };
    };
    switch (op) {
      case "BridgeShop":
        return void res.json({ data: { shop: { name: shop.name, currencyCode: shop.currency, myshopifyDomain: shop.domain }, productsCount: { count: shop.products.length } } });
      case "BridgeProducts":
      case "BridgeProduct":
        return void res.json({ data: { products: { nodes: search(shop, variables.query, variables.first ?? 1).map((p) => adminProduct(p, variables.variants)) } } });
      case "BridgeVariants": {
        const all = allVariants(shop);
        const nodes = (variables.ids as string[]).map((id) => {
          const hit = all.find(({ v }) => vGid(v.id) === id);
          if (!hit) return null;
          return {
            id,
            title: hit.v.title,
            price: hit.v.price,
            availableForSale: hit.v.available,
            product: { title: hit.p.title, handle: hit.p.handle, status: "ACTIVE", featuredMedia: hit.p.image ? { preview: { image: { url: hit.p.image } } } : null },
          };
        });
        return void res.json({ data: { nodes } });
      }
      case "BridgeOrderCreate": {
        if (stub.failOrderCreate === "http500") return void res.status(500).json({ errors: [{ message: "Internal error" }] });
        if (stub.failOrderCreate === "userErrors") {
          return void res.json({ data: { orderCreate: { order: null, userErrors: [{ field: ["order", "lineItems", "0"], message: "Variant is out of stock" }] } } });
        }
        const n = stub.orders.length + 1;
        const order: StubOrder = {
          id: `gid://shopify/Order/${9000 + n}`,
          name: `#${1000 + n}`,
          legacyResourceId: String(9000 + n),
          domain: shop.domain,
          order: variables.order,
          options: variables.options,
          note: variables.order?.note ?? "",
        };
        stub.orders.push(order);
        return void res.json({ data: { orderCreate: { order: { id: order.id, name: order.name, legacyResourceId: order.legacyResourceId }, userErrors: [] } } });
      }
      case "BridgeOrderUpdate": {
        const o = stub.orders.find((x) => x.id === variables.input?.id);
        if (!o) return void res.json({ data: { orderUpdate: { order: null, userErrors: [{ field: ["id"], message: "Order does not exist" }] } } });
        o.note = variables.input.note;
        stub.orderUpdates.push({ id: o.id, note: variables.input.note });
        return void res.json({ data: { orderUpdate: { order: { id: o.id }, userErrors: [] } } });
      }
      case "BridgeOrderCancel": {
        const o = stub.orders.find((x) => x.id === variables.orderId);
        if (o) o.cancelled = { staffNote: variables.staffNote };
        stub.orderCancels.push({ orderId: variables.orderId, staffNote: variables.staffNote });
        return void res.json({ data: { orderCancel: { orderCancelUserErrors: [] } } });
      }
      default:
        return void res.json({ errors: [{ message: `stub: unknown operation ${op}` }] });
    }
  });

  // ---- Storefront GraphQL (tokenless) ----------------------------------------------------------------
  app.post("/api/:version/graphql.json", (req, res) => {
    const shop = stub.shops.get(hostOf(req));
    if (!shop) return void notFound(res);
    const { query, variables = {} } = req.body as { query: string; variables?: Record<string, any> };
    const op = opName(query);
    stub.storefrontOps.push(`${shop.domain}:${op}`);
    if (shop.storefront === "locked") {
      return void res.status(400).json({ errors: [{ message: "Online Store channel is locked.", extensions: { code: "BAD_REQUEST" } }] });
    }
    const money = (amount: string | number) => ({ amount: String(amount), currencyCode: shop.currency });
    const sfProduct = (p: StubProduct, nVariants: number) => {
      const prices = p.variants.map((v) => Number(v.price));
      return {
        id: pGid(p.id),
        handle: p.handle,
        title: p.title,
        description: p.description.replace(/<[^>]+>/g, ""),
        onlineStoreUrl: `https://${shop.domain}/products/${p.handle}`,
        availableForSale: p.variants.some((v) => v.available),
        featuredImage: p.image ? { url: p.image } : null,
        priceRange: { minVariantPrice: money(Math.min(...prices).toFixed(1)), maxVariantPrice: money(Math.max(...prices).toFixed(1)) },
        variants: { nodes: p.variants.slice(0, nVariants).map((v) => ({ id: vGid(v.id), title: v.title, availableForSale: v.available, price: money(v.price) })) },
      };
    };
    switch (op) {
      case "BridgeShop":
        return void res.json({ data: { shop: { name: shop.name, paymentSettings: { currencyCode: shop.currency } }, products: { nodes: shop.products.map((p) => ({ id: pGid(p.id) })), pageInfo: { hasNextPage: false } } } });
      case "BridgeProducts":
        return void res.json({ data: { products: { nodes: search(shop, variables.query, variables.first).map((p) => sfProduct(p, variables.variants)) } } });
      case "BridgeProduct": {
        const p = shop.products.find((x) => x.handle === variables.handle);
        return void res.json({ data: { product: p ? sfProduct(p, variables.variants) : null } });
      }
      case "BridgeVariants": {
        const all = allVariants(shop);
        const nodes = (variables.ids as string[]).map((id) => {
          const hit = all.find(({ v }) => vGid(v.id) === id);
          return hit
            ? { id, title: hit.v.title, availableForSale: hit.v.available, price: money(hit.v.price), image: null, product: { title: hit.p.title, handle: hit.p.handle, featuredImage: hit.p.image ? { url: hit.p.image } : null } }
            : null;
        });
        return void res.json({ data: { nodes } });
      }
      case "BridgeCartCreate": {
        stub.cartCreates.push({ domain: shop.domain, input: variables.input });
        const id = `c1-${stub.cartCreates.length}`;
        return void res.json({ data: { cartCreate: { cart: { id: `gid://shopify/Cart/${id}`, checkoutUrl: `https://${shop.domain}/cart/c/${id}?key=k${id}` }, userErrors: [] } } });
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
    const minor = (price: string) => Math.round(Number(price) * 100);
    const ucpProduct = (p: StubProduct) => {
      const prices = p.variants.map((v) => minor(v.price));
      return {
        id: pGid(p.id),
        handle: p.handle,
        title: p.title,
        description: { plain: p.description },
        url: `https://${shop.domain}/products/${p.handle}`,
        price_range: { min: { amount: Math.min(...prices), currency: shop.currency }, max: { amount: Math.max(...prices), currency: shop.currency } },
        media: p.image ? [{ type: "image", url: p.image }] : [],
        variants: p.variants.map((v) => ({ id: vGid(v.id), title: v.title, price: { amount: minor(v.price), currency: shop.currency }, availability: { available: v.available } })),
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

  app.use((_req, res) => notFound(res));

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
