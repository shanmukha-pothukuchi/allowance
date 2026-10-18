/**
 * Real daily closes from Quantcomm (docs/ARCHITECTURE.md §20.1), read with GET only through the
 * Quantcomm bridge's client (`getJson`: GET, JSON, timeout, never `/api/advice/run`).
 *
 * - `GET {QUANTCOMM_URL}/api/markets` → `{ success, data: { as_of, tickers: [{ ticker, name, group, … }] } }`
 * - `GET {QUANTCOMM_URL}/api/markets/{TICKER}` → `{ success, data: { ticker, name, group, as_of, dates[], closes[] } }`,
 *   404 for a ticker Quantcomm doesn't know.
 *
 * Only these fields are read, and they are checked: anything else answers `quantcomm_changed`.
 * The list is cached 60 s and each history 10 minutes (daily closes change once a day). Concurrent
 * callers share one request; failures are not cached.
 */
import { getJson, type FetchLike } from "../../quantcomm-bridge/src/http.js";
import { QuantcommError } from "../../quantcomm-bridge/src/errors.js";

export { isQuantcommError, QuantcommError } from "../../quantcomm-bridge/src/errors.js";
export type { FetchLike } from "../../quantcomm-bridge/src/http.js";

export const LIST_TTL_MS = 60_000;
export const HISTORY_TTL_MS = 10 * 60_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

export interface TickerInfo {
  ticker: string;
  name: string;
  group: string;
}

export interface Listing {
  asOf: string;
  tickers: TickerInfo[];
}

/** One ticker's daily closes, oldest first, with the same length. */
export interface History extends TickerInfo {
  asOf: string;
  dates: string[];
  closes: number[];
}

export interface PriceSource {
  readonly baseUrl: string;
  list(): Promise<Listing>;
  /** Null when Quantcomm doesn't know the ticker (404). */
  history(ticker: string): Promise<History | null>;
  clear(): void;
}

const CHANGED = "Quantcomm's market data changed shape, so the brokerage can't read prices safely; nothing was charged.";
const changed = (where: string) => new QuantcommError("changed", CHANGED, where);
const UNAVAILABLE = "Prices aren't available right now: Quantcomm isn't answering. Nothing was charged.";

type Got = { status: 200; json: unknown } | { status: 404 };

export function createPriceSource(opts: { baseUrl: string; fetch?: FetchLike; now?: () => number; listTtlMs?: number; historyTtlMs?: number; timeoutMs?: number }): PriceSource {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; ttl: number; value: Promise<Got> }>();

  async function load(path: string): Promise<Got> {
    let r: Awaited<ReturnType<typeof getJson>>;
    try {
      r = await getJson(doFetch, `${base}${path}`, opts.timeoutMs);
    } catch (err) {
      if (err instanceof QuantcommError) throw new QuantcommError("unavailable", UNAVAILABLE, err.where ?? err.message);
      throw err;
    }
    if (r.status === 200) {
      if (r.json === undefined) throw changed(`GET ${path} did not return JSON`);
      return { status: 200, json: r.json };
    }
    if (r.status === 404) return { status: 404 };
    if (r.status >= 500) throw new QuantcommError("unavailable", UNAVAILABLE, `GET ${path} answered HTTP ${r.status}`);
    throw changed(`GET ${path} answered HTTP ${r.status}`);
  }

  function get(path: string, ttl: number): Promise<Got> {
    const hit = cache.get(path);
    if (hit && now() - hit.at < hit.ttl) return hit.value;
    const entry = { at: now(), ttl, value: load(path) };
    cache.set(path, entry);
    entry.value.catch(() => {
      if (cache.get(path) === entry) cache.delete(path);
    });
    return entry.value;
  }

  return {
    baseUrl: base,
    async list() {
      const got = await get("/api/markets", opts.listTtlMs ?? LIST_TTL_MS);
      if (got.status === 404) throw changed("GET /api/markets answered 404");
      return readListing(got.json);
    },
    async history(ticker) {
      if (!TICKER_RE.test(ticker)) return null;
      const got = await get(`/api/markets/${encodeURIComponent(ticker)}`, opts.historyTtlMs ?? HISTORY_TTL_MS);
      if (got.status === 404) return null;
      return readHistory(got.json, ticker);
    },
    clear: () => cache.clear(),
  };
}

function dataOf(json: unknown, where: string): Record<string, unknown> {
  const j = json as { success?: unknown; data?: unknown } | null;
  if (!j || typeof j !== "object") throw changed(`${where}: not an object`);
  if (j.success !== true) throw changed(`${where}: success is not true`);
  if (!j.data || typeof j.data !== "object" || Array.isArray(j.data)) throw changed(`${where}: data is not an object`);
  return j.data as Record<string, unknown>;
}

const str = (v: unknown, where: string): string => {
  if (typeof v !== "string" || !v.trim()) throw changed(`${where} is not a string`);
  return v;
};

export function readListing(json: unknown): Listing {
  const d = dataOf(json, "markets");
  const asOf = str(d.as_of, "markets: data.as_of");
  if (!Array.isArray(d.tickers)) throw changed("markets: data.tickers is not an array");
  const tickers: TickerInfo[] = [];
  d.tickers.forEach((t: unknown, i: number) => {
    const row = t as Record<string, unknown> | null;
    if (!row || typeof row !== "object") throw changed(`markets: data.tickers[${i}] is not an object`);
    const ticker = str(row.ticker, `markets: data.tickers[${i}].ticker`);
    if (!TICKER_RE.test(ticker)) return; // a symbol the brokerage can't put in a path; skip it
    tickers.push({ ticker, name: str(row.name, `markets: data.tickers[${i}].name`), group: typeof row.group === "string" ? row.group : "" });
  });
  if (!tickers.length) throw changed("markets: data.tickers is empty");
  return { asOf, tickers };
}

export function readHistory(json: unknown, ticker: string): History {
  const where = `markets/${ticker}`;
  const d = dataOf(json, where);
  const got = str(d.ticker, `${where}: data.ticker`);
  if (got !== ticker) throw changed(`${where}: data.ticker is ${got}`);
  if (!Array.isArray(d.dates)) throw changed(`${where}: data.dates is not an array`);
  if (!Array.isArray(d.closes)) throw changed(`${where}: data.closes is not an array`);
  if (d.dates.length !== d.closes.length) throw changed(`${where}: data.dates and data.closes differ in length`);
  const dates: string[] = [];
  const closes: number[] = [];
  for (let i = 0; i < d.dates.length; i++) {
    const date = d.dates[i];
    if (typeof date !== "string" || !DATE_RE.test(date)) throw changed(`${where}: data.dates[${i}] is not a YYYY-MM-DD date`);
    const close = d.closes[i];
    // A missing close (a halt, a gap) is skipped rather than priced at zero.
    if (close === null) continue;
    if (typeof close !== "number" || !Number.isFinite(close)) throw changed(`${where}: data.closes[${i}] is not a number`);
    if (close <= 0) continue;
    if (dates.length && date <= dates[dates.length - 1]) throw changed(`${where}: data.dates are not in order at ${i}`);
    dates.push(date);
    closes.push(close);
  }
  if (!dates.length) throw changed(`${where}: no closes`);
  return {
    ticker,
    name: str(d.name, `${where}: data.name`),
    group: typeof d.group === "string" ? d.group : "",
    asOf: typeof d.as_of === "string" ? d.as_of : dates[dates.length - 1],
    dates,
    closes,
  };
}

/** Index of the last close on or before `date`, or -1 when the history starts after it. */
export function indexOnOrBefore(dates: readonly string[], date: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= date) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
