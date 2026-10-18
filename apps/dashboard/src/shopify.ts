/**
 * Shopify stores as services (§15), from the shopper's side: any public store, no store admin.
 * Pure helpers: is it a store, its storefront and cap, the owner sentences, the store link check
 * (used by "Add service", §18), the sample images, and the request body. No React, no fetch. Unit-tested in
 * shopify.test.ts.
 */
import { isShopifyGrant, money, toCents } from "./format";
import { MAX_TOPUP, parseAmount, type AmountCheck } from "./sheets";
import type { AddShopifyStoreRequest, DirectoryService, ShopifyStore, ShopifyStoreRef } from "./types";

export const SHOPIFY_GREEN = "#95BF47";
export const SHOPIFY_PREFIX = "shopify-";
/** The directory's default per-order cap (§15.2). */
export const DEFAULT_CAP = "100.00";
export const CAP_CHIPS = ["50.00", "100.00", "250.00", "500.00"] as const;

type ServiceLike = { id?: string; shopify?: Partial<ShopifyStoreRef> | null; pricing?: string; maxPrice?: string } | undefined | null;

/** A Shopify store: it carries `shopify`, or its id is `shopify-<handle>`. */
export const isShopify = (s: ServiceLike): boolean => isShopifyGrant(s);

/** `weareallbirds` → `shopify-weareallbirds` (the directory id, §15.2). */
export const serviceIdFor = (handle: string) => `${SHOPIFY_PREFIX}${handle}`;

/** Shopify itself (admin.shopify.com, shopify.com): never a store, never linked. */
export const isShopifyItself = (host: string) => /(^|\.)shopify\.com$/i.test(host);

/** A storefront URL as its origin (`https://www.allbirds.com`), or "" when it isn't a plain web address of a store. */
export function storefrontOrigin(raw: string | undefined): string {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || isShopifyItself(u.hostname)) return "";
    return u.origin;
  } catch {
    return "";
  }
}

/** `https://www.allbirds.com` → `allbirds.com`: the store's name for its shoppers. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Handle, domain, storefront and card checkout of a store. From `shopify` when present, else
 * derived from the id (`shopify-<handle>` → `<handle>.myshopify.com`, which is also its storefront).
 */
export function shopifyRefOf(s: ServiceLike): ShopifyStoreRef | undefined {
  if (!s || !isShopify(s)) return undefined;
  const fromId = typeof s.id === "string" && s.id.startsWith(SHOPIFY_PREFIX) ? s.id.slice(SHOPIFY_PREFIX.length) : "";
  const handle = s.shopify?.handle || fromId;
  const domain = s.shopify?.domain || (handle ? `${handle}.myshopify.com` : "");
  const storefrontUrl = storefrontOrigin(s.shopify?.storefrontUrl) || (domain && !isShopifyItself(domain) ? `https://${domain}` : "");
  return { handle, domain, storefrontUrl, cardCheckout: s.shopify?.cardCheckout === true };
}

/** What the owner calls the store's address: `allbirds.com` (its storefront), else its myshopify domain. */
export function storefrontHost(ref: Pick<ShopifyStoreRef, "storefrontUrl" | "domain"> | undefined): string {
  if (!ref) return "";
  return hostOf(storefrontOrigin(ref.storefrontUrl)) || ref.domain;
}

/** A store's pricing line without its cap (shown on its own): "Store prices · paid with your Allowance card". */
export function pricingWithoutCap(pricing: string | undefined): string {
  return (pricing ?? "").replace(/\s*·\s*up to \$[\d,]+(?:\.\d+)? per order\s*$/i, "").trim();
}

/** The per-order cap line on cards and sheets. */
export function capLabel(maxPrice: string | undefined): string {
  return toCents(maxPrice) > 0 ? `Up to ${money(maxPrice)} per order` : "No cap set";
}

/**
 * How paying works, in one calm, honest line. The USDC payment is real; the single-use card that
 * would pay the store through Shopify's agent checkout is simulated in this project (§15).
 */
export const HOW_IT_PAYS =
  "Your agent pays in USDC from its wallet. Allowance then pays the store with a single-use Allowance Card (simulated in this demo: no real order reaches the store).";

/** "juniper-goods" → "Juniper Goods". */
export function prettyHandle(handle: string): string {
  return handle
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** "248 products", or "" when the size is unknown. */
export function catalogLine(store: Pick<ShopifyStore, "productCount">): string {
  const n = store.productCount;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? `${n.toLocaleString("en-US")} product${n === 1 ? "" : "s"}` : "";
}

/**
 * Up to four product pictures for the preview. Third-party data: only web images (shown without a
 * referrer) and inline image data (the mock's SVGs) are kept.
 */
export function sampleImagesOf(store: Pick<ShopifyStore, "sampleImages"> | undefined): string[] {
  const list = Array.isArray(store?.sampleImages) ? store.sampleImages : [];
  return list
    .filter((u): u is string => typeof u === "string")
    .filter((u) => /^data:image\/(?:svg\+xml|png|jpeg|webp|gif)[;,]/i.test(u) || /^https?:\/\//i.test(u))
    .slice(0, 4);
}

// ---------------------------------------------------------------------------- the store link

export type LinkCheck =
  | { state: "idle" }
  | { state: "bad"; message: string }
  /** `url` is what we send (the origin: the bridge ignores the path); `key` dedupes previews. */
  | { state: "ok"; url: string; key: string; host: string; handle?: string };

const LINK_EXAMPLE = "Paste the shop's address, like allbirds.com, or a link to one of its products.";
export const ADMIN_LINK_MESSAGE = "That's a store admin link. Paste the shop's own address, like allbirds.com.";

/**
 * A quick client-side look at what the owner pasted. Accepts any store or product link:
 * `x.myshopify.com`, `allbirds.com`, `https://www.allbirds.com/products/…`. The bridge is the
 * authority; this only keeps obvious typos (and admin links) from round-tripping.
 */
export function checkStoreLink(raw: string): LinkCheck {
  const s = raw.trim();
  if (!s) return { state: "idle" };
  if (/\s/.test(s)) return { state: "bad", message: `A store link has no spaces. ${LINK_EXAMPLE}` };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return { state: "bad", message: `That doesn't look like a link. ${LINK_EXAMPLE}` };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { state: "bad", message: `Use a web address. ${LINK_EXAMPLE}` };
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "admin.shopify.com" || /\/admin(\/|$)/.test(u.pathname)) return { state: "bad", message: ADMIN_LINK_MESSAGE };
  const labels = host.split(".");
  const tld = labels[labels.length - 1];
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l)) || !/^[a-z]{2,}$/.test(tld)) {
    return { state: "bad", message: `That doesn't look like a store address. ${LINK_EXAMPLE}` };
  }
  if (host === "myshopify.com" || host === "www.myshopify.com" || isShopifyItself(host)) {
    return { state: "bad", message: `That's Shopify itself, not a store. ${LINK_EXAMPLE}` };
  }
  const shop = host.match(/^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/);
  return { state: "ok", url: `https://${host}`, key: host.replace(/^www\./, ""), host, ...(shop ? { handle: shop[1] } : {}) };
}

/** The directory entry for this store, if the owner already added it. */
export function existingStore<T extends Pick<DirectoryService, "id" | "shopify">>(directory: T[], store: Pick<ShopifyStoreRef, "handle" | "domain">): T | undefined {
  return directory.find((s) => s.id === serviceIdFor(store.handle) || (!!s.shopify && (s.shopify.handle === store.handle || s.shopify.domain === store.domain)));
}

// ---------------------------------------------------------------------------- errors

/** A failed preview or add (§15.1 / §15.3 codes) in owner words. The backend's own message wins when it has one. */
export function storeErrorMessage(err: { status?: number; code?: string; message?: string } | undefined): string {
  const code = err?.code;
  const status = err?.status;
  const message = (err?.message ?? "").trim();
  if (code === "invalid_store_url" || (!code && status === 400)) return /admin/i.test(message) ? ADMIN_LINK_MESSAGE : `That doesn't look like a store link. ${LINK_EXAMPLE}`;
  if (code === "store_not_found" || (!code && status === 404)) return "No Shopify store answers at that address. Check the spelling.";
  if (code === "store_unsupported" || status === 422) return message || "Agents can't shop at this store.";
  if (code === "service_exists" || code === "store_exists" || status === 409) return "This store is already in your services.";
  if (status === 502 || status === 503 || status === 504) return "The Shopify bridge isn't answering. Is npm run dev running?";
  return message || "Something went wrong. Try again.";
}

// ---------------------------------------------------------------------------- cap and body

/** The per-order cap the owner typed: $0.01 to $1,000 (MAX_TOPUP), like the directory (§15.2). */
export function checkCap(raw: string): AmountCheck {
  const r = parseAmount(raw, { min: "0.01", max: MAX_TOPUP });
  if (!r.ok && /^At most/.test(r.message)) return { ok: false, message: `At most ${money(MAX_TOPUP)} per order.` };
  return r;
}

/** `POST /v1/directory/shopify`: the cap when chosen, `connectTo` only when someone is picked. */
export function addStoreBody(input: { url: string; cap?: string; connectTo?: string[] }): AddShopifyStoreRequest {
  const body: AddShopifyStoreRequest = { url: input.url };
  if (input.cap) body.maxPrice = input.cap;
  const ids = [...new Set((input.connectTo ?? []).filter(Boolean))];
  if (ids.length) body.connectTo = ids;
  return body;
}

// ---------------------------------------------------------------------------- response shapes

/** The preview may come bare or as `{ store }`. */
export function unwrapStore(body: unknown): ShopifyStore {
  const b = (body ?? {}) as { store?: ShopifyStore };
  return b.store && typeof b.store === "object" ? b.store : (body as ShopifyStore);
}

/** The add response may come as `{ service, agents? }` or as the bare manifest. */
export function unwrapAdded(body: unknown): { service: DirectoryService; agents?: unknown[] } {
  const b = (body ?? {}) as { service?: DirectoryService; agents?: unknown[] };
  if (b.service && typeof b.service === "object") return { service: b.service, ...(Array.isArray(b.agents) ? { agents: b.agents } : {}) };
  return { service: body as DirectoryService };
}
