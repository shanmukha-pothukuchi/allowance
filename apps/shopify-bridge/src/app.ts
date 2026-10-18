/**
 * Shopify bridge (docs/ARCHITECTURE.md §15.1): any public Shopify store, from the shopper's side.
 *
 * - Discovery, catalog and prices come from the store's public Storefront API (no token, US prices
 *   via `@inContext(country: US)`), or its UCP endpoint when an agent profile is configured.
 * - Carts are real Shopify carts (`cartCreate`): Shopify's totals and Shopify's checkout link.
 * - Checkout is x402: the agent pays the cart total in USDC to the Allowance Card treasury. What would
 *   follow for real (a single-use Allowance Card paying the store through Shopify's agent card
 *   checkout) is not wired, so the confirmation is labelled simulated and carries an Allowance
 *   reference, not a Shopify order number. Nothing here uses or links to a store's admin.
 *
 * Settlement guarantee. `@x402/express` (2.28) verifies before the handler, buffers the handler's
 * response, and settles only if the final status is < 400; on ≥ 400 it cancels the verified payment
 * without settling. Checkout prechecks (cart missing or expired, already paid, in progress) answer
 * before the paywall, so nothing is ever charged for a cart that can't be checked out; if settlement
 * fails after the confirmation was issued, `onSettleFailure` withdraws it and reopens the cart.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type HTTPRequestContext, type RouteConfig, type RoutesConfig } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { BASE_SEPOLIA_NETWORK, ensureOwnerKey, explorerTxUrl, newId, toBaseUnits, toDollars, type AppConfig, type ShopifyStore } from "@allowance/shared";
import { createStorefrontClient } from "./storefront.js";
import { createUcpClient, fetchShopMeta, fetchUcpProfile, type ShopMeta, type UcpProfile } from "./ucp.js";
import { cartPermalink, createStorefrontCart, storefrontCatalog, ucpCatalog, type Catalog, type ShopInfo, type VariantDetail } from "./catalog.js";
import {
  CartBook,
  CART_TTL_MS,
  MAX_LINES,
  MAX_QUANTITY,
  newCardLast4,
  newReference,
  simulatedExplanation,
  type Cart,
  type CartLine,
  type OrderConfirmation,
} from "./carts.js";
import { HttpError, isShopifyError, ShopifyError } from "./errors.js";
import { handleOf, isPrivateHost, parseStoreInput, publicStore, STORE_HANDLE_RE, storefrontOrigin, StoreRegistry, type StoreRecord } from "./stores.js";
import { loadBridgeAccount } from "./wallet.js";
import type { FetchLike } from "./http.js";

export type BridgeConfig = Pick<AppConfig, "dataDir" | "shopify" | "shopifyBridgeUrl" | "x402FacilitatorUrl" | "chainMode" | "facilitatorUrl"> &
  Partial<Pick<AppConfig, "ownerApiKey">>;

export interface BridgeDeps {
  /** fetch for Shopify, UCP, `/.well-known/ucp` and `/meta.json` (tests point it at a stub). The facilitator uses global fetch. */
  fetch?: FetchLike;
  /** The treasury (payTo) wallet; defaults to DATA_DIR/shopify-bridge-key.json. */
  account?: { address: `0x${string}` };
  /** ms clock (carts). */
  now?: () => number;
  quiet?: boolean;
  /** Override `config.shopify.ucpAgentProfileUrl` (the UCP catalog fallback); null disables it. */
  ucpAgentProfileUrl?: string | null;
}

export interface BridgeApp extends Express {
  locals: Express["locals"] & {
    registry: StoreRegistry;
    carts: CartBook;
    payTo: `0x${string}`;
  };
}

export const PRIVATE_CATALOG = "This store's catalog isn't public yet (it's password-protected), so agents can't browse it.";

const CHECKOUT_PATH_RE = /^\/shops\/([^/]+)\/carts\/([^/]+)\/checkout\/?$/i;
const VARIANT_GID_RE = /^gid:\/\/shopify\/ProductVariant\/(\d{1,20})$/;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

/** What a cart or product response says about its store. */
const storeRef = (r: StoreRecord) => ({ handle: r.handle, name: r.name, domain: r.domain, storefrontUrl: r.storefrontUrl, currency: r.currency, cardCheckout: r.cardCheckout });

export function createBridgeApp(config: BridgeConfig, deps: BridgeDeps = {}): BridgeApp {
  const log = deps.quiet ? () => {} : (msg: string) => console.log(`[shopify] ${msg}`);
  const warn = deps.quiet ? () => {} : (msg: string) => console.warn(`[shopify] ${msg}`);
  const doFetch: FetchLike = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const ownerKey = config.ownerApiKey || ensureOwnerKey(config.dataDir);
  const payTo = deps.account?.address ?? loadBridgeAccount(config.dataDir, log).address;
  const bridgeUrl = config.shopifyBridgeUrl.replace(/\/+$/, "");
  const apiVersion = config.shopify.apiVersion || "2026-10";
  const ucpProfile = deps.ucpAgentProfileUrl === null ? undefined : (deps.ucpAgentProfileUrl ?? config.shopify.ucpAgentProfileUrl ?? undefined);

  const registry = new StoreRegistry(config.dataDir);
  const carts = new CartBook(now);
  const catalogs = new Map<string, Catalog>();

  const prettyName = (handle: string) => handle.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  const sf = (domain: string) => createStorefrontClient({ domain, apiVersion, fetch: doFetch });
  const ucp = (domain: string) => createUcpClient({ domain, profileUrl: ucpProfile!, fetch: doFetch });
  const storefrontOf = (handle: string, domain: string) => () => registry.get(handle)?.storefrontUrl ?? `https://${domain}`;

  function catalogFor(rec: Pick<StoreRecord, "handle" | "domain" | "source" | "name">): Catalog {
    const key = `${rec.handle}:${rec.source}`;
    let c = catalogs.get(key);
    if (!c) {
      const storefront = storefrontOf(rec.handle, rec.domain);
      c = rec.source === "ucp" && ucpProfile ? ucpCatalog(ucp(rec.domain), rec.name || prettyName(rec.handle), storefront) : storefrontCatalog(sf(rec.domain), storefront);
      catalogs.set(key, c);
    }
    return c;
  }

  // ---- discovery ------------------------------------------------------------------------------------

  interface Located {
    domain: string;
    handle: string;
    /** Already read while resolving a custom domain. */
    profile?: UcpProfile | null;
    meta?: ShopMeta | null;
  }

  /** Any store link → its myshopify domain. Custom domains resolve through `/.well-known/ucp`, then `/meta.json`. */
  async function locate(raw: unknown): Promise<Located> {
    const input = parseStoreInput(raw);
    if (input.kind === "invalid") throw new HttpError(400, "invalid_store_url", input.message);
    if (input.kind === "myshopify") return { domain: input.domain, handle: input.handle };
    const profile = await fetchUcpProfile(input.host, doFetch, isPrivateHost);
    let domain = profile?.myshopifyDomain ?? null;
    let meta: ShopMeta | null | undefined;
    if (!domain) {
      meta = await fetchShopMeta(input.host, doFetch, isPrivateHost);
      domain = meta?.myshopifyDomain ?? null;
    }
    if (!domain) {
      throw new HttpError(404, "store_not_found", `${input.host} doesn't look like a Shopify store we can shop at (it doesn't publish a Shopify store profile). Check the link, or paste the store's your-store.myshopify.com address.`);
    }
    const handle = handleOf(domain);
    if (!STORE_HANDLE_RE.test(handle)) throw new HttpError(400, "invalid_store_url", `${domain} is not a store address the bridge can use.`);
    return { domain, handle, ...(profile?.myshopifyDomain === domain ? { profile } : {}), ...(meta ? { meta } : {}) };
  }

  function supported(rec: StoreRecord, country?: string): StoreRecord {
    if (rec.currency !== "USD" || (country && country !== "US")) {
      throw new HttpError(422, "store_unsupported", `${rec.name} doesn't sell to US shoppers in US dollars (it prices in ${rec.currency}), so agents can't pay it in USDC.`, {
        reason: "currency",
        currency: rec.currency,
        store: { name: rec.name, domain: rec.domain, storefrontUrl: rec.storefrontUrl },
      });
    }
    return rec;
  }

  /** Read the store: Storefront API (US context), its UCP profile (card checkout) and `/meta.json` (catalog size), in parallel. */
  async function inspect(loc: Located): Promise<StoreRecord> {
    const { domain, handle } = loc;
    const [shop, profile, meta] = await Promise.all([
      storefrontCatalog(sf(domain), () => `https://${domain}`)
        .shop()
        .then((info) => ({ ok: true as const, info }))
        .catch((err: unknown) => ({ ok: false as const, err })),
      loc.profile !== undefined ? Promise.resolve(loc.profile) : fetchUcpProfile(domain, doFetch, isPrivateHost),
      loc.meta !== undefined ? Promise.resolve(loc.meta) : fetchShopMeta(domain, doFetch, isPrivateHost),
    ]);
    const record = (info: ShopInfo, source: StoreRecord["source"]): StoreRecord => {
      const rec: StoreRecord = {
        handle,
        domain,
        storefrontUrl: storefrontOrigin(info.storefrontUrl ?? meta?.url, domain),
        cardCheckout: profile?.cardCheckout ?? false,
        name: info.name?.trim() || prettyName(handle),
        currency: info.currency,
        source,
      };
      if (info.sampleImages.length) rec.sampleImages = info.sampleImages;
      const count = meta?.productCount ?? info.productCount;
      if (count !== undefined) rec.productCount = count;
      return rec;
    };
    if (shop.ok) return supported(record(shop.info, "storefront"), shop.info.country);

    const err = shop.err;
    if (err instanceof HttpError) throw err;
    if (isShopifyError(err, "not_found")) throw new HttpError(404, "store_not_found", `There's no Shopify store at ${domain}.`);
    if (isShopifyError(err, "network")) throw new HttpError(502, "shopify_unavailable", `Couldn't reach ${domain} right now (${(err as Error).message}). Try again in a moment.`);
    if (!isShopifyError(err, "locked")) {
      throw new HttpError(422, "store_unsupported", `Couldn't read ${domain}'s catalog (${(err as Error).message}), so agents can't browse it.`, { reason: "catalog_unreachable" });
    }
    if (ucpProfile) {
      try {
        const info = await ucpCatalog(ucp(domain), prettyName(handle), () => `https://${domain}`).shop();
        return supported(record(info, "ucp"));
      } catch (e) {
        if (e instanceof HttpError) throw e;
        warn(`UCP catalog for ${domain} failed: ${(e as Error).message}`);
      }
    }
    throw new HttpError(422, "store_unsupported", PRIVATE_CATALOG, { reason: "private_catalog", store: { domain, storefrontUrl: storefrontOrigin(meta?.url, domain) } });
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
      body: { error: "payment_not_settled", message: "The USDC payment did not settle, so nothing was charged and no order was placed. You can try the checkout again." },
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
      if (!cart?.confirmation) return;
      const tx = ctx.result.transaction;
      cart.confirmation.txHash = tx;
      cart.confirmation.explorerUrl = explorerTxUrl(tx, config.chainMode, config.facilitatorUrl);
      cart.status = "placed";
      const store = registry.get(cart.handle)?.name ?? cart.handle;
      log(`Allowance Card treasury received $${cart.total} from ${cart.payer ?? "an agent"} for ${store} (tx ${tx}); simulated order ${cart.confirmation.reference}, card ••${cart.cardLast4}`);
    });
    rs.onSettleFailure(async (ctx) => {
      const cart = cartForSettlement(ctx);
      if (!cart || cart.status !== "settling") return;
      const ref = cart.confirmation?.reference;
      cart.confirmation = undefined;
      cart.status = "open";
      cart.payer = undefined;
      carts.unlinkNonce(cart);
      warn(`payment for cart ${cart.id} at ${cart.handle} did not settle (${ctx.error.message}); confirmation ${ref ?? "?"} withdrawn, the cart is open again`);
    });
    return rs;
  }

  /** One route per store (so the 402 names the shop), then a catch-all so no checkout is ever unprotected. */
  function buildRoutes(): RoutesConfig {
    const routes: Record<string, RouteConfig> = {};
    for (const s of registry.list()) routes[`POST /shops/${s.handle}/carts/*/checkout`] = routeFor(`${s.name} order`, s.name);
    routes["POST /shops/*/carts/*/checkout"] = routeFor("Shopify order", "Shopify store");
    return routes;
  }

  let paywall: RequestHandler;
  function rebuildPaywall(): void {
    paywall = paymentMiddleware(buildRoutes(), newResourceServer(), undefined, undefined, true);
  }
  rebuildPaywall();

  // ---- helpers --------------------------------------------------------------------------------------

  /** Shopify calls for a registered store: a store that went private since it was added says so plainly. */
  async function shopify<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (isShopifyError(err, "locked")) throw new HttpError(422, "store_unsupported", PRIVATE_CATALOG, { reason: "private_catalog" });
      if (isShopifyError(err, "rejected")) throw new HttpError(422, "cart_rejected", (err as Error).message);
      throw err;
    }
  }

  function cartView(cart: Cart, rec: StoreRecord) {
    return {
      cartId: cart.id,
      store: storeRef(rec),
      lines: cart.lines,
      subtotal: cart.subtotal,
      total: cart.total,
      currency: cart.currency,
      expiresAt: new Date(cart.expiresAt).toISOString(),
      checkoutUrl: cart.checkoutUrl,
      shopifyCheckoutUrl: cart.shopifyCheckoutUrl,
      notes: ["Shipping and taxes are added at checkout"],
    };
  }

  // ---- app --------------------------------------------------------------------------------------------

  const app = express() as BridgeApp;
  app.locals.registry = registry;
  app.locals.carts = carts;
  app.locals.payTo = payTo;
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
    if (!rec) throw new HttpError(404, "store_not_found", `No store "${handle}" has been added to Allowance.`);
    return rec;
  };

  app.get("/health", (_req, res) => {
    res.json({ ok: true, stores: registry.size });
  });

  app.get("/stores/discover", async (req, res) => {
    const rec = await inspect(await locate(req.query.url));
    res.json(publicStore(rec));
  });

  app.post("/stores", ownerOnly, async (req, res) => {
    const url = (req.body as { url?: unknown } | undefined)?.url;
    if (typeof url !== "string") throw new HttpError(400, "invalid_request", 'Body must be { "url": "<store link>" }');
    const loc = await locate(url);
    const existing = registry.get(loc.handle);
    if (existing) {
      res.status(409).json({ error: "store_exists", message: `${existing.name} is already added.`, store: publicStore(existing) });
      return;
    }
    const rec = await inspect(loc);
    const again = registry.get(loc.handle); // a concurrent registration finished first
    if (again) {
      res.status(409).json({ error: "store_exists", message: `${again.name} is already added.`, store: publicStore(again) });
      return;
    }
    const added: StoreRecord = { ...rec, addedAt: new Date(now()).toISOString() };
    registry.set(added);
    rebuildPaywall();
    log(`added ${added.name} (${added.storefrontUrl}, ${added.domain}; catalog via ${added.source}${added.cardCheckout ? "; takes agent card checkout" : ""})`);
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
    const products = await shopify(() => catalogFor(rec).search(q, limit));
    res.json({ store: { name: rec.name, storefrontUrl: rec.storefrontUrl, currency: rec.currency }, products });
  });

  app.get("/shops/:handle/products/:productHandle", async (req, res) => {
    const rec = storeOr404(String(req.params.handle));
    const productHandle = String(req.params.productHandle).toLowerCase();
    const product = await shopify(() => catalogFor(rec).product(productHandle));
    if (!product) throw new HttpError(404, "product_not_found", `No product "${productHandle}" at ${rec.name}.`);
    res.json({ product });
  });

  // ---- carts (free; a real Shopify cart) -------------------------------------------------------------

  app.post("/shops/:handle/carts", async (req, res) => {
    const rec = storeOr404(String(req.params.handle));
    const input = parseCartBody(req.body);
    const ids = input.lines.map((l) => l.variantId);
    // Read the variants first: unknown or sold-out items get a clear answer before Shopify sees the cart.
    const variants = await shopify(() => catalogFor(rec).variants(ids));
    const missing = ids.filter((id) => !variants.has(id));
    if (missing.length) throw new HttpError(422, "variant_not_found", `${missing.length === 1 ? "This variant is" : "These variants are"} not in ${rec.name}: ${missing.join(", ")}`, { variantIds: missing });
    const unavailable = ids.filter((id) => !variants.get(id)!.available);
    if (unavailable.length) {
      const names = unavailable.map((id) => variantLabel(variants.get(id)!));
      throw new HttpError(422, "variant_unavailable", `Not available right now: ${names.join(", ")}`, { variantIds: unavailable });
    }
    const currencies = new Set(ids.map((id) => variants.get(id)!.currency));
    if ([...currencies].some((c) => c !== "USD")) {
      throw new HttpError(422, "store_unsupported", `${rec.name} prices these items in ${[...currencies].join(", ")}; only US dollar prices can be paid in USDC.`, { reason: "currency" });
    }

    let lines: CartLine[];
    let subtotal: string;
    let total: string;
    let shopifyCheckoutUrl: string;
    let shopifyCartId: string | undefined;
    if (rec.source === "storefront") {
      const sc = await shopify(() => createStorefrontCart(sf(rec.domain), rec.storefrontUrl, input));
      if (sc.currency !== "USD") throw new HttpError(422, "store_unsupported", `${rec.name} priced this cart in ${sc.currency}; only US dollar prices can be paid in USDC.`, { reason: "currency" });
      // Shopify may drop or reduce lines (stock): never charge for a cart that isn't what was asked for.
      const short = input.lines.filter((l) => (sc.lines.find((x) => x.variantId === l.variantId)?.quantity ?? 0) < l.quantity);
      if (short.length) {
        const why = sc.warnings.length ? ` (Shopify: ${sc.warnings.join("; ")})` : "";
        const names = short.map((l) => variantLabel(variants.get(l.variantId)!));
        throw new HttpError(422, "variant_unavailable", `Not available in that quantity right now: ${names.join(", ")}${why}`, { variantIds: short.map((l) => l.variantId) });
      }
      lines = input.lines.map((l) => {
        const x = sc.lines.find((y) => y.variantId === l.variantId)!;
        return { variantId: x.variantId, title: x.title, variantTitle: x.variantTitle, quantity: x.quantity, unitPrice: x.unitPrice, lineTotal: x.lineTotal, image: x.image, url: x.url };
      });
      subtotal = sc.subtotal;
      total = sc.total;
      shopifyCheckoutUrl = sc.checkoutUrl;
      shopifyCartId = sc.id;
    } else {
      // UCP-only store (its Storefront API isn't public): catalog prices and a Shopify cart permalink.
      let sum = 0n;
      lines = input.lines.map((l) => {
        const v = variants.get(l.variantId)!;
        const lineTotal = toBaseUnits(v.price) * BigInt(l.quantity);
        sum += lineTotal;
        return { variantId: l.variantId, title: v.productTitle, variantTitle: v.title, quantity: l.quantity, unitPrice: v.price, lineTotal: toDollars(lineTotal), image: v.image, url: v.url };
      });
      subtotal = total = toDollars(sum);
      shopifyCheckoutUrl = cartPermalink(rec.storefrontUrl, input.lines);
    }
    if (toBaseUnits(total) <= 0n) throw new HttpError(422, "cart_total_zero", "This cart costs $0.00; there is nothing to pay.");

    const id = newId("cart");
    const t = now();
    const cart: Cart = {
      id,
      handle: rec.handle,
      lines,
      subtotal,
      total,
      currency: "USD",
      createdAt: t,
      expiresAt: t + CART_TTL_MS,
      checkoutUrl: `${bridgeUrl}/shops/${rec.handle}/carts/${id}/checkout`,
      shopifyCheckoutUrl,
      ...(shopifyCartId ? { shopifyCartId } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.note ? { note: input.note } : {}),
      cardLast4: newCardLast4(),
      status: "open",
    };
    carts.add(cart);
    res.status(201).json(cartView(cart, rec));
  });

  // ---- checkout (x402) --------------------------------------------------------------------------------

  const alreadyPaid = (cart: Cart) =>
    new HttpError(409, "cart_already_paid", `This cart was already paid (Allowance reference ${cart.confirmation!.reference}). Don't pay it again.`, { confirmation: cart.confirmation });
  const inProgress = () => new HttpError(409, "checkout_in_progress", "This cart is being paid right now. Wait a moment before checking it again.");

  /** Before the paywall: nothing is ever charged for a cart that cannot be checked out. */
  const checkoutPrecheck: RequestHandler = (req, _res, next) => {
    const rec = storeOr404(String(req.params.handle));
    const cart = carts.get(String(req.params.cartId));
    if (!cart || cart.handle !== rec.handle) throw new HttpError(404, "cart_not_found", "Cart not found or expired (carts last 30 minutes). Create a new cart.");
    if (cart.status === "placed" && cart.confirmation) throw alreadyPaid(cart);
    if (cart.status === "settling") throw inProgress();
    next();
  };

  const checkoutHandler = (req: Request, res: Response): void => {
    const rec = storeOr404(String(req.params.handle));
    const cart = carts.get(String(req.params.cartId));
    if (!cart || cart.handle !== rec.handle) throw new HttpError(404, "cart_not_found", "Cart not found or expired. Create a new cart.");
    // Concurrent checkouts can pass the precheck together; only the first one gets past here (no await
    // between these checks and the status change). Any response ≥ 400 makes the paywall drop the
    // verified payment without settling it.
    if (cart.status === "placed" && cart.confirmation) throw alreadyPaid(cart);
    if (cart.status === "settling") throw inProgress();
    const payment = verifiedPayment(req);
    if (!payment) throw new HttpError(500, "payment_not_verified", "Checkout reached without a verified payment; nothing was charged.");
    // One signed authorization pays for one cart: a signature already used for another cart is refused (never settled twice).
    const other = carts.byPaymentNonce(payment.nonce);
    if (other && other.id !== cart.id) throw new HttpError(409, "payment_reused", "This payment authorization was already used for another cart. Pay this cart with a new payment.");

    const confirmation: OrderConfirmation = {
      status: "placed",
      simulated: true,
      reference: newReference(),
      store: { name: rec.name, storefrontUrl: rec.storefrontUrl },
      items: cart.lines.map((l) => ({ ...l })),
      total: cart.total,
      currency: cart.currency,
      card: { brand: "Allowance Card", last4: cart.cardLast4 },
      paidAt: new Date(now()).toISOString(),
      explanation: simulatedExplanation(rec, cart.total),
    };
    cart.status = "settling";
    cart.payer = payment.payer;
    cart.confirmation = confirmation;
    carts.linkNonce(cart, payment.nonce);
    res.status(200).json(confirmation);
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

  return app;
}

// ---- request parsing ------------------------------------------------------------------------------

export interface ShippingAddressInput {
  name?: string;
  address1?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
}

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
