/**
 * Quantcomm client (read-only). Every answer is cached for 60 s (§17.1), so an agent's unpaid probe,
 * the wallet's re-fetch of the 402 and the paid retry all read the same data, and Quantcomm sees at
 * most about one request a minute per URL. Concurrent callers share one in-flight request. Failures
 * are not cached.
 */
import { changed, QuantcommError, UPSTREAM_FAILED } from "./errors.js";
import { getJson, type FetchLike } from "./http.js";
import { readAdvice, readMarkets, readResearch, type Advice, type Markets, type Research, type ResearchOption } from "./shapes.js";

export const CACHE_TTL_MS = 60_000;

/**
 * The panel the options probe asks for. Quantcomm returns a company's full option list with any
 * panel request, but builds `alert_exposure` slowly (about 1 s, serialized across requests), so the
 * probe asks for one cheap panel most companies offer and falls back to the full research on 404.
 */
export const PROBE_PANEL = "storm_history";

export interface QuantcommClient {
  readonly baseUrl: string;
  markets(): Promise<Markets>;
  advice(): Promise<Advice>;
  /** One company's research (all panels, or only `panels`). Null when Quantcomm answers 404: unknown ticker, or a panel it doesn't offer for it. */
  research(ticker: string, panels?: readonly string[]): Promise<Research | null>;
  /** The research panels a company offers, or null when Quantcomm doesn't know the company. */
  options(ticker: string): Promise<ResearchOption[] | null>;
  clear(): void;
}

type Got = { status: 200; json: unknown } | { status: 404 };

export function createQuantcommClient(opts: { baseUrl: string; fetch?: FetchLike; now?: () => number; ttlMs?: number; timeoutMs?: number }): QuantcommClient {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? CACHE_TTL_MS;
  const cache = new Map<string, { at: number; value: Promise<Got> }>();

  async function load(path: string): Promise<Got> {
    const r = await getJson(doFetch, `${base}${path}`, opts.timeoutMs);
    if (r.status === 200) {
      if (r.json === undefined) throw changed(`GET ${path} did not return JSON`);
      return { status: 200, json: r.json };
    }
    if (r.status === 404) return { status: 404 };
    const detail = upstreamMessage(r.json);
    if (r.status >= 500) throw new QuantcommError("unavailable", UPSTREAM_FAILED, `GET ${path} answered HTTP ${r.status}${detail ? `: ${detail}` : ""}`);
    throw changed(`GET ${path} answered HTTP ${r.status}${detail ? ` (${detail})` : ""}`);
  }

  function get(path: string): Promise<Got> {
    const hit = cache.get(path);
    if (hit && now() - hit.at < ttl) return hit.value;
    const entry = { at: now(), value: load(path) };
    cache.set(path, entry);
    entry.value.catch(() => {
      if (cache.get(path) === entry) cache.delete(path);
    });
    return entry.value;
  }

  async function markets(): Promise<Markets> {
    const got = await get("/api/markets");
    if (got.status === 404) throw changed("GET /api/markets answered 404");
    return readMarkets(got.json);
  }

  async function advice(): Promise<Advice> {
    const got = await get("/api/advice");
    if (got.status === 404) throw changed("GET /api/advice answered 404");
    return readAdvice(got.json);
  }

  async function research(ticker: string, panels?: readonly string[]): Promise<Research | null> {
    const query = panels?.length ? `?panels=${panels.map(encodeURIComponent).join(",")}` : "";
    const got = await get(`/api/research/${encodeURIComponent(ticker)}${query}`);
    if (got.status === 404) return null;
    return readResearch(got.json, ticker, panels);
  }

  async function options(ticker: string): Promise<ResearchOption[] | null> {
    const probe = await research(ticker, [PROBE_PANEL]);
    if (probe) return probe.options;
    const full = await research(ticker);
    return full ? full.options : null;
  }

  return { baseUrl: base, markets, advice, research, options, clear: () => cache.clear() };
}

/** Quantcomm's own `error` text, trimmed (it explains 5xx answers, e.g. a missing pipeline output). */
function upstreamMessage(json: unknown): string | undefined {
  const e = (json as { error?: unknown } | undefined)?.error;
  return typeof e === "string" && e.trim() ? e.trim().slice(0, 200) : undefined;
}
