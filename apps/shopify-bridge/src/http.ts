/** Tiny fetch helpers for talking to Shopify (plain fetch, injectable for tests). */
import { ShopifyError } from "./errors.js";

export type FetchLike = typeof fetch;

export interface JsonResponse {
  status: number;
  /** Parsed JSON body, or undefined when the body was not JSON (HTML error pages). */
  json: unknown;
  text: string;
  /** `Location` of a redirect (fetches use `redirect: "manual"`). */
  location?: string;
}

export const SHOPIFY_TIMEOUT_MS = 15_000;

export async function requestJson(
  doFetch: FetchLike,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<JsonResponse> {
  let res: Response;
  try {
    res = await doFetch(url, {
      method: init.method ?? "GET",
      headers: { accept: "application/json", ...(init.headers ?? {}) },
      body: init.body,
      redirect: "manual",
      signal: AbortSignal.timeout(init.timeoutMs ?? SHOPIFY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ShopifyError("network", `could not reach ${new URL(url).host}: ${(err as Error).message}`);
  }
  const text = await res.text().catch(() => "");
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  const location = res.headers.get("location") ?? undefined;
  return { status: res.status, json, text, ...(location ? { location } : {}) };
}

/**
 * GET a public JSON document, following up to `maxHops` redirects to other https URLs on public hosts
 * (custom storefront domains often redirect `allbirds.com` → `www.allbirds.com`). Null on any failure.
 */
export async function getPublicJson(
  doFetch: FetchLike,
  url: string,
  opts: { timeoutMs?: number; maxHops?: number; isPrivateHost: (host: string) => boolean },
): Promise<{ url: string; json: unknown } | null> {
  let current = url;
  for (let hop = 0; hop <= (opts.maxHops ?? 3); hop++) {
    let r: JsonResponse;
    try {
      r = await requestJson(doFetch, current, { timeoutMs: opts.timeoutMs ?? 8000 });
    } catch {
      return null;
    }
    if (r.status >= 300 && r.status < 400 && r.location) {
      let next: URL;
      try {
        next = new URL(r.location, current);
      } catch {
        return null;
      }
      if (next.protocol !== "https:" || opts.isPrivateHost(next.hostname)) return null;
      current = next.href;
      continue;
    }
    if (r.status !== 200 || !r.json || typeof r.json !== "object") return null;
    return { url: current, json: r.json };
  }
  return null;
}

/** GraphQL `errors` → one readable line (Shopify sends an array of {message} or, rarely, a string). */
export function graphqlErrorMessage(json: unknown): string | undefined {
  const errors = (json as { errors?: unknown } | undefined)?.errors;
  if (!errors) return undefined;
  if (typeof errors === "string") return errors;
  if (Array.isArray(errors)) {
    const msgs = errors.map((e) => (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? (e as { message: string }).message : String(e)));
    return msgs.join("; ") || "GraphQL error";
  }
  if (typeof errors === "object") return JSON.stringify(errors).slice(0, 300);
  return String(errors);
}
