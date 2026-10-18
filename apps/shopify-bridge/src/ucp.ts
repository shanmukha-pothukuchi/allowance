/**
 * UCP (Universal Commerce Protocol) helpers.
 *
 * - `/.well-known/ucp` on a storefront names its `*.myshopify.com` MCP endpoint, which is how a custom
 *   storefront domain is resolved to a Shopify shop.
 * - Optional catalog fallback for password-protected stores: JSON-RPC `tools/call` `search_catalog` /
 *   `lookup_catalog` at `https://{shop}/api/ucp/mcp`. Shopify requires a public HTTPS agent profile
 *   (`meta["ucp-agent"].profile`, env UCP_AGENT_PROFILE_URL); without one this path is skipped.
 */
import { ShopifyError } from "./errors.js";
import { requestJson, type FetchLike } from "./http.js";

export const MYSHOPIFY_HOST_RE = /^([a-z0-9][a-z0-9-]*)\.myshopify\.com$/;

/** Fetch `https://{host}/.well-known/ucp` and return the `*.myshopify.com` domain it names, if any. */
export async function myshopifyDomainFromUcp(host: string, doFetch: FetchLike): Promise<string | null> {
  let r;
  try {
    r = await requestJson(doFetch, `https://${host}/.well-known/ucp`, { timeoutMs: 8000 });
  } catch {
    return null;
  }
  if (r.status !== 200 || !r.json || typeof r.json !== "object") return null;
  const services = (r.json as { ucp?: { services?: Record<string, unknown> } }).ucp?.services;
  const shopping = services?.["dev.ucp.shopping"];
  const entries = Array.isArray(shopping) ? shopping : shopping ? [shopping] : [];
  for (const e of entries) {
    const endpoint = (e as { endpoint?: unknown } | null)?.endpoint;
    if (typeof endpoint !== "string") continue;
    try {
      const u = new URL(endpoint);
      const h = u.hostname.toLowerCase();
      if (u.protocol === "https:" && MYSHOPIFY_HOST_RE.test(h)) return h;
    } catch {
      /* ignore */
    }
  }
  return null;
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
