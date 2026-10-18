/**
 * Client for the Shopify bridge's discovery endpoint (apps/shopify-bridge, docs/ARCHITECTURE.md §15.1).
 * Discovery is free and has no side effects. The bridge's own errors (400 invalid_store_url,
 * 404 store_not_found, 422 store_unsupported, 502 shopify_unavailable / shopify_error when Shopify
 * itself failed) come back as `ShopifyBridgeError`; anything else (down, timeout, other 5xx, a store
 * we cannot read) is `ShopifyBridgeUnavailableError`.
 */
import type { ShopifyStore } from "@allowance/shared";
// Relative import on purpose (same as the agents' seeds): one manifest builder for directory and wallet.
import { asShopifyStore } from "../../directory/src/shopify.js";

export class ShopifyBridgeError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ShopifyBridgeError";
  }
}

export class ShopifyBridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopifyBridgeUnavailableError";
  }
}

export interface ShopifyBridgeClient {
  /** Normalize a store link and read its name, currency and mode. Throws ShopifyBridgeError / ShopifyBridgeUnavailableError. */
  discover(url: string): Promise<ShopifyStore>;
}

export function httpShopifyBridgeClient(bridgeUrl: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): ShopifyBridgeClient {
  const base = bridgeUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return {
    async discover(url) {
      let res: Response;
      try {
        res = await doFetch(`${base}/stores/discover?url=${encodeURIComponent(url)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new ShopifyBridgeUnavailableError(`Shopify bridge not reachable at ${base}: ${(err as Error).message}`);
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const b = (body ?? {}) as { store?: unknown; error?: unknown; message?: unknown };
      if (res.ok) {
        // The contract says "→ ShopifyStore"; accept `{ store }` too.
        const store = asShopifyStore(b.store ?? body);
        if (!store) throw new ShopifyBridgeUnavailableError("Shopify bridge sent a store preview this wallet could not read");
        return store;
      }
      if (res.status === 400 || res.status === 404 || res.status === 422) {
        const fallback = { 400: "invalid_store_url", 404: "store_not_found", 422: "store_unsupported" }[res.status]!;
        const code = typeof b.error === "string" && /^[a-z_]{1,60}$/.test(b.error) ? b.error : fallback;
        const message = typeof b.message === "string" ? b.message.slice(0, 300) : `The Shopify bridge answered ${res.status}`;
        throw new ShopifyBridgeError(res.status, code, message);
      }
      // The bridge reached Shopify and Shopify failed (502 shopify_unavailable / shopify_error): say so.
      if (res.status === 502 && typeof b.error === "string" && /^[a-z_]{1,60}$/.test(b.error)) {
        throw new ShopifyBridgeError(502, b.error, typeof b.message === "string" ? b.message.slice(0, 300) : "Shopify did not answer");
      }
      throw new ShopifyBridgeUnavailableError(`Shopify bridge answered ${res.status}`);
    },
  };
}
