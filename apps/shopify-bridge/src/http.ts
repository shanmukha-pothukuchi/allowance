/** Tiny fetch helpers for talking to Shopify (plain fetch, injectable for tests). */
import { ShopifyError } from "./errors.js";

export type FetchLike = typeof fetch;

export interface JsonResponse {
  status: number;
  /** Parsed JSON body, or undefined when the body was not JSON (HTML error pages). */
  json: unknown;
  text: string;
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
  return { status: res.status, json, text };
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

export function graphqlErrorCodes(json: unknown): string[] {
  const errors = (json as { errors?: unknown } | undefined)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((e) => {
    const code = (e as { extensions?: { code?: unknown } } | null)?.extensions?.code;
    return typeof code === "string" ? [code] : [];
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
