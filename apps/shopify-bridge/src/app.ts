/**
 * Shopify bridge (docs/ARCHITECTURE.md §15.1): turns Shopify stores into Allowance services.
 *
 * - `agent_checkout` (the owner's store, Admin API credentials): agents pay the cart total over x402
 *   to the bridge wallet; once the payment verifies, the bridge creates a real, paid Shopify order and
 *   only then lets the payment settle.
 * - `handoff` (any other store): browse and build a cart; the checkout link is Shopify's own.
 *
 * Settlement guarantee. `@x402/express` (2.28) verifies before the handler, buffers the handler's
 * response, and settles only if the final status is < 400; on ≥ 400 it cancels the verified payment
 * without settling (the exact scheme's default "authorization" flow). So the checkout handler answers
 * 502 `order_failed` when `orderCreate` fails and the payment is never taken. If settlement itself
 * fails after the order was created, the `onSettleFailure` hook cancels the Shopify order and reopens
 * the cart; `onAfterSettle` writes the tx hash into the order note.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type HTTPRequestContext, type RouteConfig, type RoutesConfig } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { BASE_SEPOLIA_NETWORK, ensureOwnerKey, explorerTxUrl, newId, toBaseUnits, toDollars, type AppConfig, type ShopifyStore } from "@allowance/shared";
import { createAdminClient, type AdminClient } from "./admin.js";
import { createStorefrontClient } from "./storefront.js";
import { createUcpClient, myshopifyDomainFromUcp } from "./ucp.js";
import {
  adminCatalog,
  cartPermalink,
  storefrontCatalog,
  storefrontCheckoutUrl,
  ucpCatalog,
  type Catalog,
  type ShopInfo,
  type VariantDetail,
} from "./catalog.js";
import { adminOrderUrl, cancelOrder, createPaidOrder, updateOrderNote, type ShippingAddressInput } from "./orders.js";
import { CartBook, CART_TTL_MS, MAX_LINES, MAX_QUANTITY, type Cart, type CartLine, type PlacedOrder } from "./carts.js";
import { HttpError, isShopifyError, ShopifyError } from "./errors.js";
import { handleOf, normalizeAdminShop, parseStoreInput, publicStore, STORE_HANDLE_RE, StoreRegistry, type StoreRecord } from "./stores.js";
import { loadBridgeAccount } from "./wallet.js";
import type { FetchLike } from "./http.js";

export type BridgeConfig = Pick<AppConfig, "dataDir" | "shopify" | "shopifyBridgeUrl" | "x402FacilitatorUrl" | "chainMode" | "facilitatorUrl"> &
  Partial<Pick<AppConfig, "ownerApiKey">>;

export interface BridgeDeps {
  /** fetch for Shopify, UCP and `/.well-known/ucp` (tests point it at a stub). The facilitator uses global fetch. */
  fetch?: FetchLike;
  /** The payTo wallet; defaults to DATA_DIR/shopify-bridge-key.json. */
  account?: { address: `0x${string}` };
  /** ms clock (carts, token expiry). */
  now?: () => number;
  quiet?: boolean;
  /** Public HTTPS UCP agent profile for the UCP catalog fallback. Default env UCP_AGENT_PROFILE_URL; null disables. */
  ucpAgentProfileUrl?: string | null;
  /** Mark created orders as Shopify test orders (the USDC is testnet or mock). Default true; env SHOPIFY_TEST_ORDERS=false turns it off. */
  testOrders?: boolean;
}

export interface BridgeApp extends Express {
  locals: Express["locals"] & {
    registry: StoreRegistry;
    carts: CartBook;
    payTo: `0x${string}`;
    adminShop?: string;
    admin?: AdminClient;
    /** Startup re-validation of the admin store (tests await it). */
    ready: Promise<void>;
  };
}

const CHECKOUT_PATH_RE = /^\/shops\/([^/]+)\/carts\/([^/]+)\/checkout\/?$/i;
const VARIANT_GID_RE = /^gid:\/\/shopify\/ProductVariant\/(\d{1,20})$/;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

export function createBridgeApp(config: BridgeConfig, deps: BridgeDeps = {}): BridgeApp {
  const log = deps.quiet ? () => {} : (msg: string) => console.log(`[shopify] ${msg}`);
  const warn = deps.quiet ? () => {} : (msg: string) => console.warn(`[shopify] ${msg}`);
  const doFetch: FetchLike = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const ownerKey = config.ownerApiKey || ensureOwnerKey(config.dataDir);
  const payTo = deps.account?.address ?? loadBridgeAccount(config.dataDir, log).address;
  const bridgeUrl = config.shopifyBridgeUrl.replace(/\/+$/, "");
  const apiVersion = config.shopify.apiVersion || "2026-10";
  const ucpProfile = deps.ucpAgentProfileUrl === null ? undefined : (deps.ucpAgentProfileUrl ?? (process.env.UCP_AGENT_PROFILE_URL || undefined));
  const testOrders = deps.testOrders ?? !/^(0|false|no)$/i.test(process.env.SHOPIFY_TEST_ORDERS ?? "");

  const adminShop = normalizeAdminShop(config.shopify.adminShop);
  const adminConfigured = Boolean(adminShop && config.shopify.clientId && config.shopify.clientSecret);
  const admin = adminConfigured
    ? createAdminClient({ shop: adminShop!, clientId: config.shopify.clientId!, clientSecret: config.shopify.clientSecret!, apiVersion, fetch: doFetch, now })
    : undefined;
  /** "ok" once the Admin API answered with these credentials, "failed" after it refused them. */
  let adminStatus: "unconfigured" | "unknown" | "ok" | "failed" = admin ? "unknown" : "unconfigured";
  if (config.shopify.adminShop && !adminShop) warn(`SHOPIFY_ADMIN_SHOP "${config.shopify.adminShop}" is not a myshopify.com shop; agent checkout is off`);

  const registry = new StoreRegistry(config.dataDir);
  const carts = new CartBook(now);
  const catalogs = new Map<string, Catalog>();

  const prettyName = (handle: string) => handle.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  const sf = (domain: string) => createStorefrontClient({ domain, apiVersion, fetch: doFetch });
  const ucp = (domain: string) => createUcpClient({ domain, profileUrl: ucpProfile!, fetch: doFetch });

  function catalogFor(rec: Pick<StoreRecord, "handle" | "domain" | "source">): Catalog {
    const key = `${rec.handle}:${rec.source}`;
    let c = catalogs.get(key);
    if (!c) {
      if (rec.source === "admin" && admin && rec.domain === adminShop) c = adminCatalog(admin, rec.domain);
      else if (rec.source === "ucp" && ucpProfile) c = ucpCatalog(ucp(rec.domain), prettyName(rec.handle));
      else c = storefrontCatalog(sf(rec.domain));
      catalogs.set(key, c);
    }
    return c;
  }

  // ---- discovery ------------------------------------------------------------------------------------

  async function resolveDomain(raw: unknown): Promise<{ domain: string; handle: string }> {
    const input = parseStoreInput(raw);
    if (!input) throw new HttpError(400, "invalid_store_url", "That is not a Shopify store link. Paste something like https://your-store.myshopify.com.");
    if (input.kind === "myshopify") return { domain: input.domain, handle: input.handle };
    const domain = await myshopifyDomainFromUcp(input.host, doFetch);
    if (!domain) {
      throw new HttpError(404, "store_not_found", `${input.host} does not look like a Shopify store (its /.well-known/ucp names no myshopify.com shop). Paste the store's x.myshopify.com address instead.`);
    }
    const handle = handleOf(domain);
    if (!STORE_HANDLE_RE.test(handle)) throw new HttpError(400, "invalid_store_url", `${domain} is not a store handle the bridge can use`);
    return { domain, handle };
  }

  function usdOnly(rec: StoreRecord): StoreRecord {
    if (rec.currency !== "USD") {
      throw new HttpError(422, "store_unsupported", `${rec.name} prices in ${rec.currency}; only USD stores are supported (1 USD = 1 USDC).`, { reason: "currency", currency: rec.currency });
    }
    return rec;
  }

  const recordFrom = (domain: string, handle: string, info: ShopInfo, mode: StoreRecord["mode"], source: StoreRecord["source"]): StoreRecord => ({
    handle,
    domain,
    mode,
    name: info.name?.trim() || prettyName(handle),
    currency: info.currency,
    ...(info.productCount !== undefined ? { productCount: info.productCount } : {}),
    source,
  });

  /** Read the store from Shopify: Admin API (owner's store) → tokenless Storefront → UCP (optional). */
  async function inspect(domain: string, handle: string): Promise<StoreRecord> {
    if (admin && domain === adminShop) {
      try {
        const info = await catalogFor({ handle, domain, source: "admin" }).shop();
        adminStatus = "ok";
        return usdOnly(recordFrom(domain, handle, info, "agent_checkout", "admin"));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        // Shopify down or unreachable: say so instead of registering the owner's store as browse-only.
        if (isShopifyError(err, "network") || (isShopifyError(err, "http") && (err.status ?? 0) >= 500)) {
          throw new HttpError(502, "shopify_unavailable", `Could not reach the Shopify Admin API for ${domain}: ${(err as Error).message}. Try again.`);
        }
        adminStatus = "failed";
        warn(`Admin API for ${domain} failed (${(err as Error).message}); agent checkout is off for it, trying the storefront`);
      }
    }
    try {
      const info = await catalogFor({ handle, domain, source: "storefront" }).shop();
      return usdOnly(recordFrom(domain, handle, info, "handoff", "storefront"));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (isShopifyError(err, "not_found")) throw new HttpError(404, "store_not_found", `No Shopify store at ${domain}.`);
      if (isShopifyError(err, "network")) throw new HttpError(502, "shopify_unavailable", `Could not reach ${domain}: ${(err as Error).message}`);
      if (!isShopifyError(err, "locked")) {
        throw new HttpError(422, "store_unsupported", `Could not read the catalog of ${domain} (${(err as Error).message}).`, { reason: "catalog_unreachable" });
      }
    }
    if (ucpProfile) {
      try {
        const info = await catalogFor({ handle, domain, source: "ucp" }).shop();
        return usdOnly(recordFrom(domain, handle, info, "handoff", "ucp"));
      } catch (err) {
        if (err instanceof HttpError) throw err;
        warn(`UCP catalog for ${domain} failed: ${(err as Error).message}`);
      }
    }
    const hint =
      domain === adminShop
        ? " Agent checkout needs working Admin API credentials (SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET)."
        : ucpProfile
          ? ""
          : " Remove the storefront password, or set UCP_AGENT_PROFILE_URL to read it through UCP.";
    throw new HttpError(422, "store_unsupported", `${domain} is password-protected (Online Store channel is locked), so the bridge cannot read its catalog.${hint}`, {
      reason: "catalog_unreachable",
    });
  }

  // ---- admin health and startup re-validation -------------------------------------------------------

  /** Registered stores keep their mode from registration; re-check the owner's store when we start. */
  async function revalidate(): Promise<void> {
    let changed = false;
    let checkedAdmin = false;
    for (const rec of registry.list()) {
      if (rec.domain === adminShop && admin) {
        checkedAdmin = true;
        try {
          const info = await catalogFor({ ...rec, source: "admin" }).shop();
          adminStatus = "ok";
          if (rec.mode !== "agent_checkout" || rec.source !== "admin") {
            registry.set({ ...rec, mode: "agent_checkout", source: "admin", name: info.name || rec.name });
            changed = true;
            log(`${rec.domain}: Admin API works, agent checkout is on`);
          }
        } catch (err) {
          adminStatus = "failed";
          warn(`${rec.domain}: Admin API check failed (${(err as Error).message}); checkouts will fail until it works`);
        }
      } else if (rec.mode === "agent_checkout") {
        registry.set({ ...rec, mode: "handoff", source: rec.source === "admin" ? "storefront" : rec.source });
        changed = true;
        warn(`${rec.domain}: no Admin API credentials for it any more; switched to browse-only (handoff)`);
      }
    }
    if (admin && !checkedAdmin) {
      // Not registered yet: still check the credentials once so /health and the log say whether they work.
      try {
        const info = await catalogFor({ handle: handleOf(adminShop!), domain: adminShop!, source: "admin" }).shop();
        adminStatus = "ok";
        log(`Admin API ok for ${adminShop} ("${info.name}", ${info.currency}, ${info.productCount ?? "?"} products)`);
      } catch (err) {
        adminStatus = "failed";
        warn(`Admin API check for ${adminShop} failed: ${(err as Error).message}`);
      }
    }
    if (changed) rebuildPaywall();
  }

  // ---- x402 paywall ---------------------------------------------------------------------------------

  const facilitatorClient = new HTTPFacilitatorClient({ url: config.x402FacilitatorUrl });

  function cartFromPath(path: string): Cart | undefined {
    const m = CHECKOUT_PATH_RE.exec(path);
    if (!m) return undefined;
    const cart = carts.get(decodeURIComponent(m[2]));
    return cart && cart.handle === decodeURIComponent(m[1]).toLowerCase() ? cart : undefined;
  }

  const priceForRequest = (ctx: HTTPRequestContext): string => {
    const cart = cartFromPath(ctx.path);
    if (!cart) throw new HttpError(404, "cart_not_found", "Cart not found or expired.");
    return `$${cart.total}`;
  };

  const routeFor = (description: string, serviceName: string): RouteConfig => ({
    accepts: { scheme: "exact", network: BASE_SEPOLIA_NETWORK, payTo, price: priceForRequest, maxTimeoutSeconds: 300 },
    description,
    serviceName,
    mimeType: "application/json",
    settlementFailedResponseBody: async () => ({
      contentType: "application/json",
      body: { error: "payment_not_settled", message: "The USDC payment did not settle, so the Shopify order was canceled. Nothing was charged; you can try the checkout again." },
    }),
  });

  const nonceOf = (payload: unknown): string | undefined => {
    const n = (payload as { payload?: { authorization?: { nonce?: unknown } } } | undefined)?.payload?.authorization?.nonce;
    return typeof n === "string" ? n : undefined;
  };

  /** The cart a settle hook is about: by request path (the express transport context), checked against the payment nonce. */
  const cartForSettlement = (ctx: { paymentPayload: unknown; transportContext?: unknown }): Cart | undefined => {
    const nonce = nonceOf(ctx.paymentPayload);
    const path = (ctx.transportContext as { request?: { path?: unknown } } | undefined)?.request?.path;
    const byPath = typeof path === "string" ? cartFromPath(path) : undefined;
    if (byPath) return nonce && byPath.paymentNonce?.toLowerCase() === nonce.toLowerCase() ? byPath : undefined;
    return carts.byPaymentNonce(nonce);
  };

  function newResourceServer(): x402ResourceServer {
    const rs = new x402ResourceServer(facilitatorClient).register(BASE_SEPOLIA_NETWORK, new ExactEvmScheme());
    rs.onAfterSettle(async (ctx) => {
      const cart = cartForSettlement(ctx);
      if (!cart?.order || !admin) return;
      const tx = ctx.result.transaction;
      cart.order.txHash = tx;
      cart.order.explorerUrl = explorerTxUrl(tx, config.chainMode, config.facilitatorUrl);
      log(`${cart.order.orderName} at ${cart.handle}: payment settled, tx ${tx}`);
      try {
        await updateOrderNote(admin, cart.order.orderId, orderNote(cart, tx));
      } catch (err) {
        warn(`could not write tx ${tx} into ${cart.order.orderName}'s note: ${(err as Error).message}`);
      }
    });
    rs.onSettleFailure(async (ctx) => {
      const cart = cartForSettlement(ctx);
      if (!cart?.order || !admin) return;
      const order = cart.order;
      cart.order = undefined;
      cart.status = "open";
      carts.unlinkNonce(cart);
      warn(`payment for ${order.orderName} at ${cart.handle} did not settle (${ctx.error.message}); canceling the order`);
      try {
        await cancelOrder(admin, order.orderId, "Allowance: the USDC payment did not settle, nothing was charged.");
      } catch (err) {
        warn(`could not cancel ${order.orderName}: ${(err as Error).message} (cancel it in the Shopify admin)`);
      }
    });
    return rs;
  }

  /** One route per agent_checkout store (so the 402 names the shop), then a catch-all so no checkout is ever unprotected. */
  function buildRoutes(): RoutesConfig {
    const routes: Record<string, RouteConfig> = {};
    for (const s of registry.list()) {
      if (s.mode === "agent_checkout") routes[`POST /shops/${s.handle}/carts/*/checkout`] = routeFor(`${s.name} order`, s.name);
    }
    routes["POST /shops/*/carts/*/checkout"] = routeFor("Shopify order", "Shopify");
    return routes;
  }

  let paywall: RequestHandler;
  function rebuildPaywall(): void {
    paywall = paymentMiddleware(buildRoutes(), newResourceServer(), undefined, undefined, true);
  }
  rebuildPaywall();

  function orderNote(cart: Cart, tx?: string): string {
    const parts = ["Paid by an Allowance agent with USDC"];
    parts.push(tx ? `tx ${tx}` : "tx pending");
    if (cart.payer) parts.push(`payer ${cart.payer}`);
    parts.push(config.chainMode === "mock" ? "mock ledger" : "Base Sepolia");
    if (tx) parts.push(explorerTxUrl(tx, config.chainMode, config.facilitatorUrl));
    const line = parts.join(" · ");
    return cart.note ? `${line}\nNote from the agent: ${cart.note}` : line;
  }

  // ---- helpers --------------------------------------------------------------------------------------

  async function shopify<T>(fn: () => Promise<T>, rec: StoreRecord): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (isShopifyError(err, "locked")) throw new HttpError(502, "shopify_error", `${rec.domain} is password-protected now; its catalog cannot be read.`);
      throw err;
    }
  }

  function cartView(cart: Cart, rec: StoreRecord) {
    return {
      cartId: cart.id,
      store: publicStore(rec),
      lines: cart.lines,
      subtotal: cart.subtotal,
      shipping: cart.shipping,
      total: cart.total,
      currency: cart.currency,
      expiresAt: new Date(cart.expiresAt).toISOString(),
      mode: cart.mode,
      checkoutUrl: cart.checkoutUrl,
    };
  }

  // ---- app --------------------------------------------------------------------------------------------

  const app = express() as BridgeApp;
  app.locals.registry = registry;
  app.locals.carts = carts;
  app.locals.payTo = payTo;
  app.locals.adminShop = adminShop;
  app.locals.admin = admin;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.path !== "/health") res.on("finish", () => log(`${req.method} ${req.originalUrl} -> ${res.statusCode}`));
    next();
  });
  app.use(express.json({ limit: "64kb" }));

  const ownerOnly: RequestHandler = (req, res, next) => {
    const given = req.header("x-owner-key");
    if (!given || !safeEqual(given, ownerKey)) {
      res.status(401).json({ error: "unauthorized", message: "X-Owner-Key required" });
      return;
    }
    next();
  };

  const storeOr404 = (handle: string): StoreRecord => {
    const rec = registry.get(String(handle).toLowerCase());
    if (!rec) throw new HttpError(404, "store_not_found", `No store "${handle}" is registered with the Shopify bridge.`);
    return rec;
  };

  app.get("/health", (_req, res) => {
    res.json({ ok: true, stores: registry.size, adminShop: adminShop ?? null, adminConfigured, adminStatus });
  });

  app.get("/stores/discover", async (req, res) => {
    const { domain, handle } = await resolveDomain(req.query.url);
    const rec = await inspect(domain, handle);
    res.json(publicStore(rec));
  });

  app.post("/stores", ownerOnly, async (req, res) => {
    const url = (req.body as { url?: unknown } | undefined)?.url;
    if (typeof url !== "string") throw new HttpError(400, "invalid_request", 'Body must be { "url": "<store link>" }');
    const { domain, handle } = await resolveDomain(url);
    const existing = registry.get(handle);
    if (existing) {
      res.status(409).json({ error: "store_exists", message: `${existing.name} is already registered.`, store: publicStore(existing) });
      return;
    }
    const rec = await inspect(domain, handle);
    const again = registry.get(handle); // a concurrent registration finished first
    if (again) {
      res.status(409).json({ error: "store_exists", message: `${again.name} is already registered.`, store: publicStore(again) });
      return;
    }
    const added: StoreRecord = { ...rec, addedAt: new Date(now()).toISOString() };
    registry.set(added);
    rebuildPaywall();
    log(`registered ${added.domain} (${added.name}, ${added.mode}, catalog via ${added.source})`);
    res.status(201).json({ store: publicStore(added) });
  });

  app.get("/stores", (_req, res) => {
    res.json({ stores: registry.list().map(publicStore) });
  });

  app.get("/stores/:handle", (req, res) => {
    res.json({ store: publicStore(storeOr404(String(req.params.handle))) });
  });

  // ---- catalog (free) ---------------------------------------------------------------------------------

  app.get("/shops/:handle/products", async (req, res) => {
    const rec = storeOr404(String(req.params.handle));
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : undefined;
    const rawLimit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : DEFAULT_LIMIT;
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT;
    const products = await shopify(() => catalogFor(rec).search(q, limit), rec);
    res.json({ store: { name: rec.name, currency: rec.currency, mode: rec.mode }, products });
  });

  app.get("/shops/:handle/products/:productHandle", async (req, res) => {
    const rec = storeOr404(String(req.params.handle));
    const productHandle = String(req.params.productHandle).toLowerCase();
    const product = await shopify(() => catalogFor(rec).product(productHandle), rec);
    if (!product) throw new HttpError(404, "product_not_found", `No product "${productHandle}" at ${rec.name}.`);
    res.json({ product });
  });

  // ---- carts (free) -----------------------------------------------------------------------------------

  app.post("/shops/:handle/carts", async (req, res) => {
    const rec = storeOr404(String(req.params.handle));
    const input = parseCartBody(req.body);
    const ids = input.lines.map((l) => l.variantId);
    const variants = await shopify(() => catalogFor(rec).variants(ids), rec);
    const missing = ids.filter((id) => !variants.has(id));
    if (missing.length) throw new HttpError(422, "variant_not_found", `${missing.length === 1 ? "This variant is" : "These variants are"} not in ${rec.name}: ${missing.join(", ")}`, { variantIds: missing });
    const unavailable = ids.filter((id) => !variants.get(id)!.available);
    if (unavailable.length) {
      const names = unavailable.map((id) => variantLabel(variants.get(id)!));
      throw new HttpError(422, "variant_unavailable", `Not available right now: ${names.join(", ")}`, { variantIds: unavailable });
    }
    const currencies = new Set(ids.map((id) => variants.get(id)!.currency));
    if ([...currencies].some((c) => c !== "USD")) throw new HttpError(422, "store_unsupported", `${rec.name} prices these items in ${[...currencies].join(", ")}; only USD is supported.`, { reason: "currency" });

    let subtotal = 0n;
    const lines: CartLine[] = input.lines.map((l) => {
      const v = variants.get(l.variantId)!;
      const lineTotal = toBaseUnits(v.price) * BigInt(l.quantity);
      subtotal += lineTotal;
      return {
        variantId: l.variantId,
        title: v.productTitle,
        variantTitle: v.title,
        quantity: l.quantity,
        unitPrice: v.price,
        lineTotal: toDollars(lineTotal),
        image: v.image,
      };
    });
    if (rec.mode === "agent_checkout" && subtotal <= 0n) throw new HttpError(422, "cart_total_zero", "This cart costs $0.00; there is nothing to pay.");

    const id = newId("cart");
    const t = now();
    let checkoutUrl: string;
    if (rec.mode === "agent_checkout") {
      checkoutUrl = `${bridgeUrl}/shops/${rec.handle}/carts/${id}/checkout`;
    } else {
      checkoutUrl = cartPermalink(rec.domain, input.lines);
      if (rec.source === "storefront") {
        try {
          checkoutUrl = await storefrontCheckoutUrl(sf(rec.domain), { lines: input.lines, email: input.email, note: input.note });
        } catch (err) {
          warn(`cartCreate at ${rec.domain} failed (${(err as Error).message}); using a cart permalink`);
        }
      }
    }
    const cart: Cart = {
      id,
      handle: rec.handle,
      mode: rec.mode,
      lines,
      subtotal: toDollars(subtotal),
      shipping: "0.00",
      total: toDollars(subtotal),
      currency: "USD",
      createdAt: t,
      expiresAt: t + CART_TTL_MS,
      checkoutUrl,
      email: input.email,
      note: input.note,
      shippingAddress: input.shippingAddress,
      status: "open",
    };
    carts.add(cart);
    res.status(201).json(cartView(cart, rec));
  });

  // ---- checkout (x402) --------------------------------------------------------------------------------

  /** Before the paywall: nothing is ever charged for a cart that cannot be checked out. */
  const checkoutPrecheck: RequestHandler = (req, res, next) => {
    const rec = storeOr404(String(req.params.handle));
    const cart = carts.get(String(req.params.cartId));
    if (!cart || cart.handle !== rec.handle) throw new HttpError(404, "cart_not_found", "Cart not found or expired (carts last 30 minutes). Create a new cart.");
    if (rec.mode !== "agent_checkout" || cart.mode !== "agent_checkout") {
      const handoffUrl = cart.mode === "handoff" ? cart.checkoutUrl : cartPermalink(rec.domain, cart.lines);
      throw new HttpError(409, "agent_checkout_unavailable", `Agents cannot pay at ${rec.name}. Give your owner the Shopify checkout link to finish paying.`, { handoffUrl });
    }
    if (cart.status === "placed" && cart.order) throw new HttpError(409, "cart_already_paid", `This cart was already paid: order ${cart.order.orderName}.`, { order: cart.order });
    if (cart.status === "ordering") throw new HttpError(409, "checkout_in_progress", "This cart is being checked out right now.");
    if (!admin) throw new HttpError(409, "agent_checkout_unavailable", "Agent checkout is not configured on this bridge.", { handoffUrl: cartPermalink(rec.domain, cart.lines) });
    next();
  };

  const checkoutHandler = async (req: Request, res: Response): Promise<void> => {
    const rec = storeOr404(String(req.params.handle));
    const cart = carts.get(String(req.params.cartId));
    if (!cart || cart.handle !== rec.handle) throw new HttpError(404, "cart_not_found", "Cart not found or expired. Create a new cart.");
    // Concurrent checkouts can pass the precheck together; only the first one gets past here. Any
    // response ≥ 400 makes the paywall drop the verified payment without settling it.
    if (cart.status === "placed" && cart.order) throw new HttpError(409, "cart_already_paid", `This cart was already paid: order ${cart.order.orderName}.`, { order: cart.order });
    if (cart.status === "ordering") throw new HttpError(409, "checkout_in_progress", "This cart is being checked out right now.");
    const payment = verifiedPayment(req);
    if (!payment || !admin) throw new HttpError(500, "payment_not_verified", "Checkout reached without a verified payment; nothing was charged.");

    // One signed authorization pays for one cart: a signature already placing or placed another order is refused (never settled twice).
    const other = carts.byPaymentNonce(payment.nonce);
    if (other && other.id !== cart.id) throw new HttpError(409, "payment_reused", "This payment authorization was already used for another cart. Pay this cart with a new payment.");

    cart.status = "ordering";
    cart.payer = payment.payer;
    carts.linkNonce(cart, payment.nonce);
    try {
      const created = await createPaidOrder(admin, {
        currency: cart.currency,
        total: cart.total,
        lines: cart.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPrice: l.unitPrice })),
        note: orderNote(cart),
        email: cart.email,
        shippingAddress: cart.shippingAddress,
        test: testOrders,
      });
      const order: PlacedOrder = {
        status: "placed",
        orderId: created.id,
        orderName: created.name,
        adminUrl: adminOrderUrl(rec.handle, created.id, created.legacyResourceId),
        store: publicStore(rec),
        total: cart.total,
        currency: cart.currency,
        items: cart.lines.map(({ title, variantTitle, quantity, unitPrice, lineTotal, image }) => ({ title, variantTitle, quantity, unitPrice, lineTotal, image })),
      };
      cart.order = order;
      cart.status = "placed";
      log(`created ${order.orderName} at ${rec.domain} for $${cart.total} (payer ${payment.payer}); settling the payment`);
      res.status(200).json(order);
    } catch (err) {
      cart.status = "open";
      carts.unlinkNonce(cart);
      const msg = (err as Error).message;
      warn(`orderCreate at ${rec.domain} failed (${msg}); the payment will not be settled`);
      res.status(502).json({ error: "order_failed", message: `Shopify did not accept the order (${msg}). Your payment was not taken.` });
    }
  };

  app.post("/shops/:handle/carts/:cartId/checkout", checkoutPrecheck, (req, res, next) => paywall(req, res, next), checkoutHandler);

  // ---- 404 / errors -------------------------------------------------------------------------------------

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", message: `${req.method} ${req.path}` });
  });
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra ?? {}) });
      return;
    }
    if (err instanceof ShopifyError) {
      res.status(502).json({ error: err.kind === "network" ? "shopify_unavailable" : "shopify_error", message: err.message });
      return;
    }
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) warn(`error: ${err.stack ?? err.message}`);
    res.status(status).json({
      error: status === 400 ? "invalid_request" : status === 413 ? "payload_too_large" : status < 500 ? "bad_request" : "internal_error",
      message: status < 500 ? "Malformed request body." : "Internal error.",
    });
  });

  app.locals.ready = revalidate().catch((err) => warn(`startup check failed: ${(err as Error).message}`));
  return app;
}

// ---- request parsing ------------------------------------------------------------------------------

interface CartInput {
  lines: { variantId: string; quantity: number }[];
  email?: string;
  note?: string;
  shippingAddress?: ShippingAddressInput;
}

const bad = (message: string) => new HttpError(400, "invalid_request", message);

export function normalizeVariantId(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) return `gid://shopify/ProductVariant/${raw}`;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (/^\d{1,20}$/.test(s)) return `gid://shopify/ProductVariant/${s}`;
  return VARIANT_GID_RE.test(s) ? s : null;
}

export function parseCartBody(body: unknown): CartInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad('Body must be { "lines": [{ "variantId": "...", "quantity": 1 }] }');
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.lines) || b.lines.length === 0) throw bad("A cart needs at least one line: { variantId, quantity }.");
  if (b.lines.length > MAX_LINES) throw bad(`At most ${MAX_LINES} lines per cart.`);
  const merged = new Map<string, number>();
  for (const line of b.lines) {
    const l = line as { variantId?: unknown; quantity?: unknown } | null;
    const id = normalizeVariantId(l?.variantId);
    if (!id) throw bad("Each line needs a variantId like gid://shopify/ProductVariant/123 (copy it from the product's variants).");
    const q = l?.quantity === undefined ? 1 : l.quantity;
    if (typeof q !== "number" || !Number.isInteger(q) || q < 1 || q > MAX_QUANTITY) throw bad(`quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
    merged.set(id, (merged.get(id) ?? 0) + q);
  }
  for (const [id, q] of merged) if (q > MAX_QUANTITY) throw bad(`At most ${MAX_QUANTITY} of one variant per cart (${id}).`);
  const out: CartInput = { lines: [...merged].map(([variantId, quantity]) => ({ variantId, quantity })) };
  if (b.email !== undefined && b.email !== null && b.email !== "") {
    if (typeof b.email !== "string" || b.email.length > 254 || !EMAIL_RE.test(b.email.trim())) throw bad("email must be an email address.");
    out.email = b.email.trim();
  }
  if (b.note !== undefined && b.note !== null && b.note !== "") {
    if (typeof b.note !== "string") throw bad("note must be a string.");
    out.note = b.note.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").trim().slice(0, 500);
  }
  if (b.shippingAddress !== undefined && b.shippingAddress !== null) {
    const a = b.shippingAddress as Record<string, unknown>;
    if (typeof a !== "object" || Array.isArray(a)) throw bad("shippingAddress must be { name, address1, city, province, zip, country }.");
    const addr: ShippingAddressInput = {};
    for (const k of ["name", "address1", "city", "province", "zip", "country"] as const) {
      const v = a[k];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v !== "string" || v.length > 200) throw bad(`shippingAddress.${k} must be a string up to 200 characters.`);
      addr[k] = v.trim();
    }
    if (Object.keys(addr).length) out.shippingAddress = addr;
  }
  return out;
}

/** The payment the paywall verified (same header it read): payer and EIP-3009 nonce. */
function verifiedPayment(req: Request): { payer: string; nonce: string } | null {
  const header = req.header("payment-signature") || req.header("x-payment");
  if (!header) return null;
  try {
    const p = decodePaymentSignatureHeader(header) as { payload?: { authorization?: { from?: unknown; nonce?: unknown } } };
    const from = p.payload?.authorization?.from;
    const nonce = p.payload?.authorization?.nonce;
    return typeof from === "string" && typeof nonce === "string" ? { payer: from, nonce } : null;
  } catch {
    return null;
  }
}

function variantLabel(v: VariantDetail): string {
  return v.title && v.title !== "Default Title" ? `${v.productTitle} (${v.title})` : v.productTitle;
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export type { ShopifyStore };
