/**
 * Public store facts outside the Storefront API (docs/ARCHITECTURE.md §15.1).
 *
 * - `/.well-known/ucp` (Universal Commerce Protocol profile): its `dev.ucp.shopping` service endpoint
 *   names the store's `*.myshopify.com` host (how a custom domain like allbirds.com resolves), and its
 *   `payment_handlers` say whether the store takes card payments from agents (`dev.shopify.card`).
 * - `/meta.json` (every Online Store answers it): `myshopify_domain` and `published_products_count`.
 *   Used when a storefront has no UCP profile, and for the catalog size.
 * - Optional catalog fallback for stores whose Storefront API is not public: JSON-RPC `tools/call`
 *   `search_catalog` / `lookup_catalog` at `https://{shop}/api/ucp/mcp`. Shopify requires a public
 *   HTTPS agent profile (`meta["ucp-agent"].profile`, `config.shopify.ucpAgentProfileUrl`); without
 *   one this path is skipped.
 */
import { ShopifyError } from "./errors.js";
import { getPublicJson, requestJson, type FetchLike } from "./http.js";

export const MYSHOPIFY_HOST_RE = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/;
/** The UCP payment handler for card payments (what an Allowance Card would pay through). */
export const CARD_HANDLER = "dev.shopify.card";

export interface UcpProfile {
  /** The `*.myshopify.com` host of the store's UCP shopping endpoint, if any. */
  myshopifyDomain: string | null;
  /** `payment_handlers` lists `dev.shopify.card`. */
  cardCheckout: boolean;
}

export interface ShopMeta {
  myshopifyDomain: string | null;
  /** The storefront's own URL, e.g. "https://www.allbirds.com". */
  url?: string;
  productCount?: number;
}

type IsPrivate = (host: string) => boolean;

/** `https://{host}/.well-known/ucp`, parsed. Null when the host has no readable profile. */
export async function fetchUcpProfile(host: string, doFetch: FetchLike, isPrivateHost: IsPrivate): Promise<UcpProfile | null> {
  const r = await getPublicJson(doFetch, `https://${host}/.well-known/ucp`, { isPrivateHost });
  const ucp = (r?.json as { ucp?: { services?: Record<string, unknown>; payment_handlers?: unknown } } | undefined)?.ucp;
  if (!ucp || typeof ucp !== "object") return null;
  const shopping = ucp.services?.["dev.ucp.shopping"];
  const entries = Array.isArray(shopping) ? shopping : shopping ? [shopping] : [];
  let myshopifyDomain: string | null = null;
  for (const e of entries) {
    const endpoint = (e as { endpoint?: unknown } | null)?.endpoint;
    if (typeof endpoint !== "string") continue;
    try {
      const u = new URL(endpoint);
      const h = u.hostname.toLowerCase();
      if (u.protocol === "https:" && MYSHOPIFY_HOST_RE.test(h)) {
        myshopifyDomain = h;
        break;
      }
    } catch {
      /* ignore */
    }
  }
  const handlers = ucp.payment_handlers;
  const cardCheckout = Boolean(handlers && typeof handlers === "object" && !Array.isArray(handlers) && CARD_HANDLER in handlers);
  return { myshopifyDomain, cardCheckout };
}

/** `https://{host}/meta.json`, parsed. Null when the host is not a readable Shopify storefront. */
export async function fetchShopMeta(host: string, doFetch: FetchLike, isPrivateHost: IsPrivate): Promise<ShopMeta | null> {
  const r = await getPublicJson(doFetch, `https://${host}/meta.json`, { isPrivateHost });
  const j = r?.json as { myshopify_domain?: unknown; url?: unknown; published_products_count?: unknown } | undefined;
  if (!j) return null;
  const d = typeof j.myshopify_domain === "string" ? j.myshopify_domain.toLowerCase() : "";
  const out: ShopMeta = { myshopifyDomain: MYSHOPIFY_HOST_RE.test(d) ? d : null };
  if (typeof j.url === "string") out.url = j.url;
  if (typeof j.published_products_count === "number" && Number.isFinite(j.published_products_count) && j.published_products_count >= 0) {
    out.productCount = Math.floor(j.published_products_count);
  }
  return out.myshopifyDomain || out.productCount !== undefined ? out : null;
}

export interface UcpClient {
  readonly domain: string;
  callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
}

let rpcId = 0;

export function createUcpClient(opts: { domain: string; profileUrl: string; fetch?: FetchLike }): UcpClient {
  const doFetch = opts.fetch ?? fetch;
  return {
    domain: opts.domain,
    async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const r = await requestJson(doFetch, `https://${opts.domain}/api/ucp/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++rpcId,
          method: "tools/call",
          params: { name, arguments: { meta: { "ucp-agent": { profile: opts.profileUrl } }, ...args } },
        }),
      });
      if (r.status === 404) throw new ShopifyError("not_found", `No UCP endpoint at ${opts.domain}`, 404);
      const body = (r.json ?? parseSse(r.text)) as { result?: unknown; error?: { message?: unknown; data?: { content?: unknown } } } | undefined;
      if (!body) throw new ShopifyError("http", `UCP at ${opts.domain} answered HTTP ${r.status} without JSON`, r.status);
      if (body.error) {
        const detail = typeof body.error.data?.content === "string" ? `: ${body.error.data.content}` : "";
        throw new ShopifyError("graphql", `UCP ${name} at ${opts.domain} failed (${String(body.error.message ?? "error")}${detail})`, r.status);
      }
      const result = body.result as { structuredContent?: unknown; content?: { type?: string; text?: string }[]; isError?: boolean } | undefined;
      if (!result) throw new ShopifyError("graphql", `UCP ${name} at ${opts.domain} returned no result`, r.status);
      if (result.isError) {
        const text = result.content?.find((c) => c.type === "text")?.text ?? "tool error";
        throw new ShopifyError("graphql", `UCP ${name} at ${opts.domain}: ${text.slice(0, 300)}`, r.status);
      }
      if (result.structuredContent !== undefined) return result.structuredContent as T;
      const text = result.content?.find((c) => c.type === "text")?.text;
      if (text) {
        try {
          return JSON.parse(text) as T;
        } catch {
          /* fall through */
        }
      }
      throw new ShopifyError("graphql", `UCP ${name} at ${opts.domain} returned an unreadable result`, r.status);
    },
  };
}

/** Streamable HTTP MCP servers may answer with one SSE `data:` frame. */
function parseSse(text: string): unknown {
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice(5).trim());
  } catch {
    return undefined;
  }
}
