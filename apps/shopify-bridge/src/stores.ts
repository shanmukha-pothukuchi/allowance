/**
 * Store links and the store registry (`DATA_DIR/shopify-stores.json`), docs/ARCHITECTURE.md §15.1.
 * Any public store link works: `x.myshopify.com`, a custom domain (`allbirds.com`), or a product or
 * collection page on either (the path is ignored). Store admin links are refused: Allowance is the
 * shopper's wallet and never uses a store's admin.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShopifyStore } from "@allowance/shared";
import type { CatalogSource } from "./catalog.js";
import { MYSHOPIFY_HOST_RE } from "./ucp.js";

/** Same rule as the directory: `shopify-<handle>` must stay a valid service id. */
export const STORE_HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,54}$/;

export const NOT_A_STORE_LINK = "That isn't a store link. Paste the shop's address, like allbirds.com, one of its product pages, or your-store.myshopify.com.";
export const ADMIN_LINK = "That's a store admin link; paste the shop's own address (like allbirds.com or a product page) instead.";
export const LOCAL_LINK = "That's a local or IP address, not a public store. Paste the shop's own address, like allbirds.com.";
export const SHOPIFY_SITE_LINK = "That's a page on shopify.com, not a store. Paste the shop's own address, like allbirds.com.";

export type StoreInput =
  /** Already a myshopify domain. */
  | { kind: "myshopify"; domain: string; handle: string }
  /** Some other storefront host: resolved through its `/.well-known/ucp` (or `/meta.json`). */
  | { kind: "custom"; host: string };

export type ParsedStoreInput = StoreInput | { kind: "invalid"; message: string };

/** True for hosts the bridge must never fetch: IP literals, localhost, single labels, private TLDs. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h || !h.includes(".")) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[") || h.includes(":")) return true;
  if (/^[\d.]+$/.test(h)) return true; // numeric-only hosts (short IPv4 forms like "127.1")
  return !/^[a-z0-9.-]+$/.test(h);
}

/**
 * Parse whatever the shopper pasted. Returns the store's myshopify domain when the link names it,
 * the storefront host otherwise, or a friendly reason the link can't be used.
 */
export function parseStoreInput(raw: unknown): ParsedStoreInput {
  const invalid = (message: string): ParsedStoreInput => ({ kind: "invalid", message });
  if (typeof raw !== "string") return invalid(NOT_A_STORE_LINK);
  const s = raw.trim();
  if (!s || s.length > 500 || /\s/.test(s)) return invalid(NOT_A_STORE_LINK);
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return invalid(NOT_A_STORE_LINK);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return invalid(NOT_A_STORE_LINK);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return invalid(NOT_A_STORE_LINK);
  if (host === "localhost" || host.endsWith(".localhost") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":")) return invalid(LOCAL_LINK);
  if (!host.includes(".")) return invalid(NOT_A_STORE_LINK);
  if (isPrivateHost(host)) return invalid(LOCAL_LINK);
  if (host === "admin.shopify.com") return invalid(ADMIN_LINK);
  const m = MYSHOPIFY_HOST_RE.exec(host);
  if (m) {
    if (/^\/admin(\/|$)/i.test(url.pathname)) return invalid(ADMIN_LINK);
    return STORE_HANDLE_RE.test(m[1]) ? { kind: "myshopify", domain: host, handle: m[1] } : invalid(NOT_A_STORE_LINK);
  }
  if (host === "shopify.com" || host.endsWith(".shopify.com") || host.endsWith(".shopifycdn.com") || host.endsWith(".shopifycloud.com")) return invalid(SHOPIFY_SITE_LINK);
  return { kind: "custom", host };
}

export function handleOf(domain: string): string {
  return domain.split(".")[0];
}

/** `https://www.allbirds.com/` → `https://www.allbirds.com`; anything unusable → the myshopify address. */
export function storefrontOrigin(raw: unknown, domain: string): string {
  if (typeof raw === "string") {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" && !isPrivateHost(u.hostname)) return u.origin;
    } catch {
      /* fall through */
    }
  }
  return `https://${domain}`;
}

/** Registry record: the public store plus which catalog it is read from. */
export interface StoreRecord extends ShopifyStore {
  source: CatalogSource;
}

export function publicStore(r: StoreRecord): ShopifyStore {
  const out: ShopifyStore = {
    handle: r.handle,
    domain: r.domain,
    storefrontUrl: r.storefrontUrl,
    cardCheckout: r.cardCheckout,
    name: r.name,
    currency: r.currency,
  };
  if (r.sampleImages?.length) out.sampleImages = [...r.sampleImages];
  if (r.productCount !== undefined) out.productCount = r.productCount;
  if (r.addedAt) out.addedAt = r.addedAt;
  return out;
}

/** A saved record, tolerating files written by earlier builds (which had a `mode` and admin sources). */
function fromSaved(raw: unknown): StoreRecord | null {
  const s = raw as Partial<StoreRecord> & { mode?: unknown; source?: unknown };
  if (!s || typeof s !== "object" || typeof s.handle !== "string" || !STORE_HANDLE_RE.test(s.handle) || typeof s.domain !== "string") return null;
  const domain = s.domain.toLowerCase();
  const rec: StoreRecord = {
    handle: s.handle,
    domain,
    storefrontUrl: storefrontOrigin(s.storefrontUrl, domain),
    cardCheckout: s.cardCheckout === true,
    name: typeof s.name === "string" && s.name.trim() ? s.name : s.handle,
    currency: typeof s.currency === "string" ? s.currency : "USD",
    source: s.source === "ucp" ? "ucp" : "storefront",
  };
  if (Array.isArray(s.sampleImages)) rec.sampleImages = s.sampleImages.filter((x): x is string => typeof x === "string" && /^https:\/\//.test(x)).slice(0, 4);
  if (typeof s.productCount === "number" && Number.isFinite(s.productCount)) rec.productCount = s.productCount;
  if (typeof s.addedAt === "string") rec.addedAt = s.addedAt;
  return rec;
}

export class StoreRegistry {
  private stores = new Map<string, StoreRecord>();
  private file?: string;

  constructor(dataDir?: string) {
    if (!dataDir) return;
    this.file = join(dataDir, "shopify-stores.json");
    if (!existsSync(this.file)) return;
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as { stores?: unknown[] };
      for (const s of j.stores ?? []) {
        const rec = fromSaved(s);
        if (rec) this.stores.set(rec.handle, rec);
      }
    } catch (err) {
      console.warn(`[shopify] could not read ${this.file} (${(err as Error).message}); starting with no stores`);
    }
  }

  list(): StoreRecord[] {
    return [...this.stores.values()];
  }

  get(handle: string): StoreRecord | undefined {
    return this.stores.get(handle);
  }

  get size(): number {
    return this.stores.size;
  }

  set(record: StoreRecord): void {
    this.stores.set(record.handle, record);
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    const dir = join(this.file, "..");
    mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ stores: this.list() }, null, 2) + "\n");
    renameSync(tmp, this.file);
  }
}
