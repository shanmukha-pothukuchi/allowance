/**
 * Prices and portfolios from the paper brokerage (§20.1). The scheduler only reads.
 *
 * `MarketData` is the adapter the engine uses. `httpMarket` is the HTTP implementation:
 * - quotes: `GET {BROKERAGE_URL}/brokerage/quotes?tickers=COF,JPM` (free, public).
 * - portfolio: see `PortfolioReader`. The brokerage identifies agents by a signed proof for its
 *   own agent-facing portfolio route, which the scheduler can't produce (it holds no agent keys or
 *   tokens). The default reader assumes an owner-side read of one agent's portfolio by wallet
 *   address with the owner key, the same access the dashboard's Portfolio view needs:
 *   `GET {BROKERAGE_URL}/brokerage/portfolio?address=0x…` + `X-Owner-Key`. Swap the reader if the
 *   brokerage settles on another owner route.
 */

export type FetchLike = typeof fetch;

export interface Quote {
  ticker: string;
  name?: string;
  price: number;
  changePct1d?: number;
  changePctFromStart?: number;
}

export interface QuotesResult {
  clockDate?: string;
  /** "replay" | "live" when known (from GET /brokerage). */
  mode?: string;
  quotes: Quote[];
}

export interface Position {
  ticker: string;
  shares: number;
  avgCost: number;
  price: number;
  value: number;
  unrealizedPnl: number;
  /** Percent. */
  unrealizedPct: number;
}

export interface Portfolio {
  clockDate?: string;
  positions: Position[];
  totals: { invested: number; value: number; unrealizedPnl: number; realizedPnl: number; unrealizedPct?: number };
}

export interface AgentRef {
  name: string;
  id?: string;
  address?: string;
}

export class MarketError extends Error {
  constructor(
    readonly code: "prices_unavailable" | "portfolio_unavailable" | "unknown_ticker",
    message: string,
  ) {
    super(message);
    this.name = "MarketError";
  }
}

export interface MarketData {
  /** Throws MarketError("prices_unavailable") when the brokerage can't answer. Unknown tickers are simply absent. */
  quotes(tickers: string[]): Promise<QuotesResult>;
  /** Throws MarketError("portfolio_unavailable") when it can't be read. */
  portfolio(agent: AgentRef): Promise<Portfolio>;
}

/** Reads one agent's portfolio. Replace to match the brokerage's owner route. */
export type PortfolioReader = (agent: AgentRef, ctx: { brokerageUrl: string; ownerApiKey?: string; fetch: FetchLike }) => Promise<Portfolio>;

export const ownerPortfolioReader: PortfolioReader = async (agent, { brokerageUrl, ownerApiKey, fetch: doFetch }) => {
  if (!agent.address) throw new MarketError("portfolio_unavailable", `No wallet address known for ${agent.name}`);
  let res: Response;
  try {
    res = await doFetch(`${brokerageUrl}/brokerage/portfolio?address=${encodeURIComponent(agent.address)}`, {
      headers: { accept: "application/json", ...(ownerApiKey ? { "x-owner-key": ownerApiKey } : {}) },
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    throw new MarketError("portfolio_unavailable", "The brokerage is not reachable");
  }
  if (!res.ok) throw new MarketError("portfolio_unavailable", `The brokerage answered ${res.status} for ${agent.name}'s portfolio`);
  return parsePortfolio(await res.json().catch(() => null));
};

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** Accepts numbers or decimal strings ("12.34"), per §2. */
export function parsePortfolio(j: unknown): Portfolio {
  if (!j || typeof j !== "object") throw new MarketError("portfolio_unavailable", "The brokerage sent an unreadable portfolio");
  const o = j as Record<string, unknown>;
  const positions = (Array.isArray(o.positions) ? o.positions : []).filter((p): p is Record<string, unknown> => !!p && typeof p === "object").map((p) => ({
    ticker: String(p.ticker ?? "").toUpperCase(),
    shares: num(p.shares),
    avgCost: num(p.avgCost),
    price: num(p.price),
    value: num(p.value),
    unrealizedPnl: num(p.unrealizedPnl),
    unrealizedPct: num(p.unrealizedPct),
  }));
  const t = (o.totals && typeof o.totals === "object" ? o.totals : {}) as Record<string, unknown>;
  return {
    ...(typeof o.clockDate === "string" ? { clockDate: o.clockDate } : {}),
    positions,
    totals: {
      invested: num(t.invested),
      value: num(t.value),
      unrealizedPnl: num(t.unrealizedPnl),
      realizedPnl: num(t.realizedPnl),
      ...(t.unrealizedPct !== undefined ? { unrealizedPct: num(t.unrealizedPct) } : {}),
    },
  };
}

export interface HttpMarketOptions {
  brokerageUrl: string;
  ownerApiKey?: string;
  fetch?: FetchLike;
  portfolioReader?: PortfolioReader;
}

export function httpMarket(opts: HttpMarketOptions): MarketData {
  const base = opts.brokerageUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const reader = opts.portfolioReader ?? ownerPortfolioReader;
  let mode: { value?: string; at: number } = { at: 0 };

  async function brokerageMode(): Promise<string | undefined> {
    if (Date.now() - mode.at < 60_000) return mode.value;
    mode = { value: mode.value, at: Date.now() };
    try {
      const r = await doFetch(`${base}/brokerage`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const j = (await r.json()) as { mode?: unknown };
        if (typeof j.mode === "string") mode.value = j.mode;
      }
    } catch {
      /* keep the last known mode */
    }
    return mode.value;
  }

  return {
    async quotes(tickers) {
      const list = [...new Set(tickers.map((t) => t.toUpperCase()))];
      let res: Response;
      try {
        res = await doFetch(`${base}/brokerage/quotes?tickers=${encodeURIComponent(list.join(","))}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(4000) });
      } catch {
        throw new MarketError("prices_unavailable", "The brokerage is not reachable");
      }
      if (!res.ok) throw new MarketError("prices_unavailable", `The brokerage answered ${res.status} for quotes`);
      const j = (await res.json().catch(() => null)) as { clockDate?: unknown; mode?: unknown; quotes?: unknown } | null;
      const quotes = (Array.isArray(j?.quotes) ? j.quotes : [])
        .filter((q): q is Record<string, unknown> => !!q && typeof q === "object")
        .map((q) => ({
          ticker: String(q.ticker ?? "").toUpperCase(),
          ...(typeof q.name === "string" ? { name: q.name } : {}),
          price: num(q.price),
          ...(q.changePct1d !== undefined ? { changePct1d: num(q.changePct1d) } : {}),
          ...(q.changePctFromStart !== undefined ? { changePctFromStart: num(q.changePctFromStart) } : {}),
        }))
        .filter((q) => q.ticker && q.price > 0);
      const m = typeof j?.mode === "string" ? j.mode : await brokerageMode();
      return { ...(typeof j?.clockDate === "string" ? { clockDate: j.clockDate } : {}), ...(m ? { mode: m } : {}), quotes };
    },
    portfolio: (agent) => reader(agent, { brokerageUrl: base, ownerApiKey: opts.ownerApiKey, fetch: doFetch }),
  };
}
