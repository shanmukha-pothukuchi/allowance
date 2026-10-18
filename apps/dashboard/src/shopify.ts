/**
 * Shopify stores as services (§15). Pure helpers: is it a store, its domain and mode, the owner
 * sentences, the "Add a Shopify store" link check, the cap, and the request body. No React, no
 * fetch. Unit-tested in shopify.test.ts.
 */
import { isShopifyGrant, money, toCents } from "./format";
import { MAX_TOPUP, parseAmount, type AmountCheck } from "./sheets";
import type { AddShopifyStoreRequest, DirectoryService, ShopifyMode, ShopifyStore, ShopifyStoreRef } from "./types";

export const SHOPIFY_GREEN = "#95BF47";
export const SHOPIFY_PREFIX = "shopify-";
/** The directory's default per-order cap (§15.2). */
export const DEFAULT_CAP = "100.00";
export const CAP_CHIPS = ["50.00", "100.00", "250.00", "500.00"] as const;

type ServiceLike = { id?: string; shopify?: Partial<ShopifyStoreRef> | null; pricing?: string; maxPrice?: string } | undefined | null;

/** A Shopify store: it carries `shopify`, or its id is `shopify-<handle>`. */
export const isShopify = (s: ServiceLike): boolean => isShopifyGrant(s);

/** `crypto-app-test` → `shopify-crypto-app-test` (the directory id, §15.2). */
export const serviceIdFor = (handle: string) => `${SHOPIFY_PREFIX}${handle}`;

/**
 * Handle, domain and mode of a store. From `shopify` when present, else derived: the id gives the
 * handle (and `<handle>.myshopify.com`), the pricing line gives the mode ("Browse only …" is handoff).
 */
export function shopifyRefOf(s: ServiceLike): ShopifyStoreRef | undefined {
  if (!s || !isShopify(s)) return undefined;
  const fromId = typeof s.id === "string" && s.id.startsWith(SHOPIFY_PREFIX) ? s.id.slice(SHOPIFY_PREFIX.length) : "";
  const handle = s.shopify?.handle || fromId;
  const domain = s.shopify?.domain || (handle ? `${handle}.myshopify.com` : "");
  const declared = s.shopify?.mode;
  const mode: ShopifyMode =
    declared === "agent_checkout" || declared === "handoff"
      ? declared
      : /^browse only/i.test(s.pricing ?? "")
        ? "handoff"
        : toCents(s.maxPrice) > 0 || /per order/i.test(s.pricing ?? "")
          ? "agent_checkout"
          : "handoff";
  return { handle, domain, mode };
}

export function modeLabel(mode: ShopifyMode): string {
  return mode === "agent_checkout" ? "Agent checkout" : "Browse only";
}

/** One line for the owner: what an agent can do at this store. Same words as the chat. */
export function modeExplain(mode: ShopifyMode, cap?: string): string {
  if (mode === "handoff") return "Your agent browses and builds a cart. You finish paying at Shopify's checkout.";
  return toCents(cap) > 0
    ? `Your agent pays in USDC, up to ${money(cap)} per order, and a real order lands in your Shopify admin.`
    : "Your agent pays in USDC, and a real order lands in your Shopify admin.";
}

/** The price-cap line on cards and sheets. */
export function capLabel(mode: ShopifyMode, maxPrice: string | undefined): string {
  if (mode === "handoff") return "No agent payments";
  return toCents(maxPrice) > 0 ? `Up to ${money(maxPrice)} per order` : "No cap set";
}

/** "juniper-goods" → "Juniper Goods". */
export function prettyHandle(handle: string): string {
  return handle
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** "14 products · USD", or just "USD" when the size is unknown. */
export function catalogLine(store: Pick<ShopifyStore, "productCount" | "currency">): string {
  const n = store.productCount;
  const size = typeof n === "number" && Number.isFinite(n) && n >= 0 ? `${n} product${n === 1 ? "" : "s"}` : "";
  return [size, store.currency].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------- the store link

export type LinkCheck =
  | { state: "idle" }
  | { state: "bad"; message: string }
  /** `url` is what we send (the origin: the bridge normalizes the rest); `key` dedupes previews. */
  | { state: "ok"; url: string; key: string; host: string; handle?: string };

const LINK_EXAMPLE = "Paste something like crypto-app-test.myshopify.com.";

/**
 * A quick client-side look at what the owner pasted. Accepts `x.myshopify.com`,
 * `https://x.myshopify.com/anything`, or a storefront domain. The bridge is the authority; this only
 * keeps obvious typos from round-tripping.
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
  const labels = host.split(".");
  const tld = labels[labels.length - 1];
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(l)) || !/^[a-z]{2,}$/.test(tld)) {
    return { state: "bad", message: `That doesn't look like a store address. ${LINK_EXAMPLE}` };
  }
  const shop = host.match(/^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/);
  if (host === "myshopify.com" || host === "www.myshopify.com" || host === "admin.shopify.com" || host === "shopify.com" || host === "www.shopify.com") {
    return { state: "bad", message: `That's Shopify itself, not a store. ${LINK_EXAMPLE}` };
  }
  const origin = `https://${host}`;
  return { state: "ok", url: origin, key: host, host, ...(shop ? { handle: shop[1] } : {}) };
}

/** The directory entry for this store, if the owner already added it. */
export function existingStore<T extends Pick<DirectoryService, "id" | "shopify">>(directory: T[], store: Pick<ShopifyStoreRef, "handle" | "domain">): T | undefined {
  return directory.find((s) => s.id === serviceIdFor(store.handle) || (!!s.shopify && (s.shopify.handle === store.handle || s.shopify.domain === store.domain)));
}

// ---------------------------------------------------------------------------- errors

/** A failed preview or add (§15.1 / §15.3 codes) in owner words. */
export function storeErrorMessage(err: { status?: number; code?: string; message?: string } | undefined): string {
  const code = err?.code;
  const status = err?.status;
  const message = (err?.message ?? "").trim();
  if (code === "invalid_store_url" || (!code && status === 400)) return `That doesn't look like a store link. ${LINK_EXAMPLE}`;
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

/** `POST /v1/directory/shopify`: the cap only for agent checkout, `connectTo` only when someone is picked. */
export function addStoreBody(input: { url: string; mode: ShopifyMode; cap?: string; connectTo?: string[] }): AddShopifyStoreRequest {
  const body: AddShopifyStoreRequest = { url: input.url };
  if (input.mode === "agent_checkout" && input.cap) body.maxPrice = input.cap;
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
