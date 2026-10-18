/**
 * Shopify Admin GraphQL client for the owner's own store (docs/ARCHITECTURE.md §15).
 *
 * Auth: client credentials grant (`POST https://{shop}/admin/oauth/access_token`, a Dev Dashboard app
 * installed on the store). Tokens live 24 h; we cache one until ~5 min before it expires, share one
 * in-flight grant between concurrent callers, and on a 401 drop it, fetch a fresh one and retry once.
 * The client secret and tokens are never logged.
 */
import { ShopifyError } from "./errors.js";
import { graphqlErrorCodes, graphqlErrorMessage, requestJson, sleep, type FetchLike } from "./http.js";

export interface AdminClientOptions {
  /** "x.myshopify.com" */
  shop: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
  fetch?: FetchLike;
  /** ms clock (tests move it forward to expire tokens). */
  now?: () => number;
}

export interface AdminClient {
  readonly shop: string;
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
  /** A valid access token (cached). Exposed for tests; never log it. */
  token(): Promise<string>;
  /** Forget the cached token. */
  invalidate(): void;
}

/** Refresh this long before Shopify's expiry. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export function createAdminClient(opts: AdminClientOptions): AdminClient {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  let cached: { token: string; refreshAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function grant(): Promise<string> {
    const r = await requestJson(doFetch, `https://${opts.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: opts.clientId, client_secret: opts.clientSecret, grant_type: "client_credentials" }),
    });
    const body = r.json as { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } | undefined;
    if (r.status === 404) throw new ShopifyError("not_found", `${opts.shop} was not found`, 404);
    if (r.status < 200 || r.status >= 300 || !body || typeof body.access_token !== "string" || !body.access_token) {
      const why = typeof body?.error_description === "string" ? body.error_description : typeof body?.error === "string" ? body.error : `HTTP ${r.status}`;
      throw new ShopifyError("auth", `Shopify refused the Admin API client credentials for ${opts.shop} (${why})`, r.status);
    }
    const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 86_399;
    // Never cache a token for less than a minute, even if Shopify says it is about to expire.
    const lifetimeMs = Math.max(expiresIn * 1000 - TOKEN_REFRESH_MARGIN_MS, 60_000);
    cached = { token: body.access_token, refreshAt: now() + lifetimeMs };
    return body.access_token;
  }

  async function token(): Promise<string> {
    if (cached && now() < cached.refreshAt) return cached.token;
    if (!inflight) {
      inflight = grant().finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  }

  async function graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const url = `https://${opts.shop}/admin/api/${opts.apiVersion}/graphql.json`;
    let refreshed = false;
    let throttled = false;
    for (;;) {
      const tok = await token();
      const r = await requestJson(doFetch, url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-shopify-access-token": tok },
        body: JSON.stringify({ query, variables: variables ?? {} }),
      });
      if (r.status === 401 || (r.status === 403 && /access token|api key/i.test(r.text))) {
        if (cached?.token === tok) cached = undefined;
        if (!refreshed) {
          refreshed = true;
          continue;
        }
        throw new ShopifyError("auth", `Shopify Admin API rejected a fresh token for ${opts.shop} (HTTP ${r.status})`, r.status);
      }
      if (r.status === 404) throw new ShopifyError("not_found", `${opts.shop} Admin API not found (check SHOPIFY_API_VERSION)`, 404);
      if (r.status === 429 && !throttled) {
        throttled = true;
        await sleep(1000);
        continue;
      }
      if (r.status < 200 || r.status >= 300) {
        throw new ShopifyError("http", `Shopify Admin API answered HTTP ${r.status}${graphqlErrorMessage(r.json) ? `: ${graphqlErrorMessage(r.json)}` : ""}`, r.status);
      }
      const msg = graphqlErrorMessage(r.json);
      if (msg) {
        if (graphqlErrorCodes(r.json).includes("THROTTLED") && !throttled) {
          throttled = true;
          await sleep(1000);
          continue;
        }
        throw new ShopifyError("graphql", `Shopify Admin API: ${msg}`, r.status);
      }
      const data = (r.json as { data?: T } | undefined)?.data;
      if (data === undefined || data === null) throw new ShopifyError("graphql", "Shopify Admin API returned no data", r.status);
      return data;
    }
  }

  return {
    shop: opts.shop,
    graphql,
    token,
    invalidate: () => {
      cached = undefined;
    },
  };
}
