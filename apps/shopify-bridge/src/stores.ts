/**
 * Store links and the store registry (`DATA_DIR/shopify-stores.json`).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShopifyStore } from "@allowance/shared";
import type { CatalogSource } from "./catalog.js";
import { MYSHOPIFY_HOST_RE } from "./ucp.js";

/** Same rule as the directory: `shopify-<handle>` must stay a valid service id. */
export const STORE_HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,54}$/;

export type StoreInput =
  /** Already a myshopify domain. */
  | { kind: "myshopify"; domain: string; handle: string }
  /** Some other storefront host: resolve through its `/.well-known/ucp`. */
  | { kind: "custom"; host: string };

/**
 * `https://x.myshopify.com`, `x.myshopify.com`, `https://x.myshopify.com/products/y`,
 * `https://admin.shopify.com/store/x/...`, or any https storefront host. Null when it is not a
 * usable link (bad syntax, non-http(s), IP literals, localhost, single-label hosts).
 */
export function parseStoreInput(raw: unknown): StoreInput | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 500 || /\s/.test(s)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || !host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":")) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  const m = MYSHOPIFY_HOST_RE.exec(host);
  if (m) return STORE_HANDLE_RE.test(m[1]) ? { kind: "myshopify", domain: host, handle: m[1] } : null;
  if (host === "admin.shopify.com") {
    const seg = url.pathname.split("/").filter(Boolean);
    if (seg[0] === "store" && seg[1] && STORE_HANDLE_RE.test(seg[1].toLowerCase())) {
      const handle = seg[1].toLowerCase();
      return { kind: "myshopify", domain: `${handle}.myshopify.com`, handle };
    }
    return null;
  }
  if (host.endsWith(".shopify.com") || host === "shopify.com") return null;
  return { kind: "custom", host };
}

/** `SHOPIFY_ADMIN_SHOP` may be "x", "x.myshopify.com" or a URL. */
export function normalizeAdminShop(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  if (STORE_HANDLE_RE.test(s)) return `${s}.myshopify.com`;
  const p = parseStoreInput(s);
  return p?.kind === "myshopify" ? p.domain : undefined;
}

export function handleOf(domain: string): string {
  return domain.split(".")[0];
}

/** Registry record: the public store plus which catalog it is read from. */
export interface StoreRecord extends ShopifyStore {
  source: CatalogSource;
}

export function publicStore(r: StoreRecord): ShopifyStore {
  const out: ShopifyStore = { handle: r.handle, domain: r.domain, mode: r.mode, name: r.name, currency: r.currency };
  if (r.productCount !== undefined) out.productCount = r.productCount;
  if (r.addedAt) out.addedAt = r.addedAt;
  return out;
}

export class StoreRegistry {
  private stores = new Map<string, StoreRecord>();
  private file?: string;

  constructor(dataDir?: string) {
    if (!dataDir) return;
    this.file = join(dataDir, "shopify-stores.json");
    if (!existsSync(this.file)) return;
    try {
      const j = JSON.parse(readFileSync(this.file, "utf8")) as { stores?: StoreRecord[] };
      for (const s of j.stores ?? []) {
        if (s && typeof s.handle === "string" && STORE_HANDLE_RE.test(s.handle) && typeof s.domain === "string") {
          this.stores.set(s.handle, { ...s, source: s.source ?? "storefront" });
        }
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
