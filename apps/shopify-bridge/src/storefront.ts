/**
 * Shopify Storefront API without a token ("tokenless": products, search, cart; query cost ≤ 1000).
 * Password-protected stores answer `{"errors":[{"message":"Online Store channel is locked."}]}`
 * (HTTP 400), which we surface as a `locked` ShopifyError so callers can fall back.
 */
import { ShopifyError } from "./errors.js";
import { graphqlErrorMessage, requestJson, type FetchLike } from "./http.js";

export interface StorefrontClient {
  readonly domain: string;
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

const LOCKED_RE = /online store channel is locked/i;

export function createStorefrontClient(opts: { domain: string; apiVersion: string; fetch?: FetchLike }): StorefrontClient {
  const doFetch = opts.fetch ?? fetch;
  return {
    domain: opts.domain,
    async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      const r = await requestJson(doFetch, `https://${opts.domain}/api/${opts.apiVersion}/graphql.json`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables: variables ?? {} }),
      });
      const msg = graphqlErrorMessage(r.json);
      if (LOCKED_RE.test(msg ?? "") || LOCKED_RE.test(r.json === undefined ? r.text.slice(0, 2000) : "")) {
        throw new ShopifyError("locked", `${opts.domain} is password-protected (Online Store channel is locked)`, r.status);
      }
      if (r.status === 404) throw new ShopifyError("not_found", `No Shopify store at ${opts.domain}`, 404);
      if (r.status === 402) throw new ShopifyError("http", `${opts.domain} is unavailable (Shopify answered 402: the shop is frozen or closed)`, 402);
      if (r.status === 301 || r.status === 302 || r.status === 303 || r.status === 307 || r.status === 308) {
        throw new ShopifyError("http", `${opts.domain} redirected the Storefront API (HTTP ${r.status})`, r.status);
      }
      if (r.status < 200 || r.status >= 300) {
        throw new ShopifyError("http", `Storefront API at ${opts.domain} answered HTTP ${r.status}${msg ? `: ${msg}` : ""}`, r.status);
      }
      if (msg) throw new ShopifyError("graphql", `Storefront API at ${opts.domain}: ${msg}`, r.status);
      const data = (r.json as { data?: T } | undefined)?.data;
      if (data === undefined || data === null) throw new ShopifyError("graphql", `Storefront API at ${opts.domain} returned no data`, r.status);
      return data;
    },
  };
}
