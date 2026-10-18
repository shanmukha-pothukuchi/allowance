/**
 * Test double for Quantcomm's market endpoints, on port 0. Not a test file. It answers like the real
 * app (verified against quantcomm on 2026-10-18): `GET /api/markets` lists the tickers and
 * `GET /api/markets/{TICKER}` returns `{ success, data: { ticker, name, group, as_of, dates[], closes[], … } }`,
 * 404 `{ success: false, data: null, error: "Unknown ticker: X" }` otherwise. Symbols are case-sensitive.
 *
 * The closes are synthetic and easy to reason about, on a calendar of `DAYS` weekdays from 2025-01-01:
 * - SPY: 500 + day (the calendar ticker)
 * - COF: 100 + day (so +1% a day at the start)
 * - JPM: 200 − day / 2
 * - LATE: listed, but its closes start on day 100
 */
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

export const DAYS = 300;

export function weekdays(from: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export const CALENDAR = weekdays("2025-01-01", DAYS);

export interface StubHistory {
  name: string;
  group: string;
  dates: string[];
  closes: (number | null)[];
}

export interface StubQuantcomm {
  url: string;
  requests: { method: string; path: string }[];
  histories: Record<string, StubHistory>;
  /** "down": drop every connection. A number: answer every request with that status. */
  fail?: "down" | number;
  /** Replace a body (shape-change tests). */
  override?: { path: string; body: unknown };
  reset(): void;
  close(): Promise<void>;
}

function fresh(): Record<string, StubHistory> {
  const at = (f: (i: number) => number) => CALENDAR.map((_d, i) => f(i));
  return {
    SPY: { name: "SPDR S&P 500 ETF", group: "ETFs", dates: [...CALENDAR], closes: at((i) => 500 + i) },
    COF: { name: "Capital One Financial Corp.", group: "Large banks", dates: [...CALENDAR], closes: at((i) => 100 + i) },
    JPM: { name: "JPMorgan Chase & Co.", group: "Large banks", dates: [...CALENDAR], closes: at((i) => 200 - i / 2) },
    LATE: { name: "Late Listing Inc.", group: "Regional", dates: CALENDAR.slice(100), closes: CALENDAR.slice(100).map((_d, i) => 50 + i) },
  };
}

export async function startStubQuantcomm(): Promise<StubQuantcomm> {
  const app = express();
  const stub = { requests: [], histories: fresh() } as unknown as StubQuantcomm;

  app.use((req, res, next) => {
    stub.requests.push({ method: req.method, path: req.originalUrl });
    if (stub.fail === "down") return void req.socket.destroy();
    if (typeof stub.fail === "number") return void res.status(stub.fail).json({ success: false, data: null, error: "pipeline output missing" });
    if (req.method !== "GET") return void res.status(405).json({ success: false, data: null, error: "Method Not Allowed" });
    if (stub.override && stub.override.path === req.path) return void res.json(stub.override.body);
    next();
  });
  app.get("/api/markets", (_req, res) => {
    const asOf = CALENDAR[CALENDAR.length - 1];
    res.json({
      success: true,
      error: null,
      data: {
        as_of: asOf,
        focus: "COF",
        universe: ["COF", "JPM"],
        tickers: Object.entries(stub.histories).map(([ticker, h]) => ({ ticker, name: h.name, group: h.group, last: h.closes[h.closes.length - 1], chg_pct: 0.5, r1y_pct: 3.2, has_signal: ticker === "COF" })),
      },
    });
  });
  app.get("/api/markets/:ticker", (req, res) => {
    const ticker = String(req.params.ticker);
    const h = stub.histories[ticker];
    if (!h) return void res.status(404).json({ success: false, data: null, error: `Unknown ticker: ${ticker}` });
    res.json({
      success: true,
      error: null,
      data: {
        ticker,
        name: h.name,
        group: h.group,
        focus: ticker === "COF",
        as_of: h.dates[h.dates.length - 1],
        summary: { last: h.closes[h.closes.length - 1], chg_pct: 0.5, r1y_pct: 3.2, last_date: h.dates[h.dates.length - 1] },
        dates: h.dates,
        closes: h.closes,
        benchmark: { ticker: "KRE", closes: h.closes.map(() => 60) },
        events: [],
        research_options: [],
      },
    });
  });
  app.use((_req, res) => void res.status(404).json({ success: false, data: null, error: "Not Found" }));

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.reset = () => {
    stub.histories = fresh();
    stub.fail = undefined;
    stub.override = undefined;
  };
  stub.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return stub;
}
