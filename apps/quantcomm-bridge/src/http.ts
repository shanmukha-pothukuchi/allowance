/**
 * The only way the bridge talks to Quantcomm: plain `GET`, JSON, with a timeout (injectable fetch for
 * tests). Quantcomm is read-only from here, so there is no method parameter at all, and the one
 * endpoint that does work upstream (`POST /api/advice/run`, an LLM run) is refused outright.
 */
import { QuantcommError, UNAVAILABLE } from "./errors.js";

export type FetchLike = typeof fetch;

export interface JsonResponse {
  status: number;
  /** Parsed JSON body, or undefined when the body was not JSON. */
  json: unknown;
}

export const QUANTCOMM_TIMEOUT_MS = 15_000;

const FORBIDDEN_PATH_RE = /\/api\/advice\/run\b/i;

export async function getJson(doFetch: FetchLike, url: string, timeoutMs = QUANTCOMM_TIMEOUT_MS): Promise<JsonResponse> {
  if (FORBIDDEN_PATH_RE.test(new URL(url).pathname)) throw new Error("the bridge never calls /api/advice/run");
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new QuantcommError("unavailable", UNAVAILABLE, `could not reach ${new URL(url).host}: ${(err as Error).message}`);
  }
  const text = await res.text().catch(() => "");
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}
