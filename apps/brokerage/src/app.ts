/**
 * Brokerage (paper) — docs/ARCHITECTURE.md §20.1. A simulated brokerage: agents buy fractional shares
 * with their USDC over x402 and sell them back for USDC, at real daily closes from Quantcomm, replayed
 * at accelerated speed. No real securities, no real broker. Not investment advice.
 *
 * - `GET /brokerage` (free): mode, replay dates, the tickers, the endpoints.
 * - `GET /brokerage/quotes?tickers=COF,JPM` (free): prices at the clock's date.
 * - `POST /brokerage/orders/buy?ticker=COF&amount=100.00` (x402, price = amount): fractional shares at
 *   the clock's price. The order is in the query, so the wallet's re-fetch of the 402 (same URL, no
 *   body) sees the same price. A JSON body may repeat it; if it disagrees, 400.
 * - `POST /brokerage/orders/sell { ticker, shares | "all" }` (free; it pays out): proceeds in USDC from
 *   the brokerage wallet to the agent (mock: an EIP-3009 authorization settled by the facilitator).
 * - `GET /brokerage/portfolio`: the caller's positions and P/L.
 * - Owner (`X-Owner-Key`): `GET /brokerage/portfolio?address=0x…`, `GET /brokerage/portfolios`,
 *   `POST /brokerage/clock/advance { days }`.
 *
 * **Who.** A buy belongs to the wallet that paid (the verified x402 authorization's `from`). Sells and
 * portfolio reads carry `X-Allowance-Attestation`: a short text signed by the agent's key through its
 * wallet (`POST /v1/attest`), checked here with viem, single use, 2 minutes, for this audience only
 * (apps/wallet-service/src/attest.ts). One agent can never sell another agent's shares, and a sell
 * always pays the shares' owner.
 *
 * **Never charged for a failure.** Every buy check (ticker, amount, a price at the clock's date,
 * Quantcomm up) answers before the paywall. After payment the handler only fills the order;
 * `@x402/express` settles only when the handler answers < 400, and the position is booked once the
 * payment settled.
 */
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type HTTPRequestContext, type RouteConfig, type RoutesConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { BASE_SEPOLIA_NETWORK, explorerTxUrl, formatUsd, newId, nowIso, toBaseUnits, toDollars, type AppConfig } from "@allowance/shared";
import { createSettlement, type Settlement } from "@allowance/wallet";
import { ATTESTATION_HEADER, NonceCache, normalizeAudience, verifyAttestation } from "../../wallet-service/src/attest.js";
import { Book, cents, floorCents, formatShares, MICRO, parseShares, pctChange, priceUnitsOf, round2, sharesFor, valueOf, type Order } from "./book.js";
import { clockSettingsFromEnv, ReplayClock, type ClockSettings } from "./clock.js";
import { createPriceSource, indexOnOrBefore, isQuantcommError, QuantcommError, type FetchLike, type PriceSource } from "./prices.js";
import { ensureFloat, FloatError, loadBrokerageAccount, type BrokerageAccount } from "./wallet.js";

export type BrokerageConfig = Pick<AppConfig, "dataDir" | "brokerageUrl" | "quantcommUrl" | "x402FacilitatorUrl" | "facilitatorUrl" | "chainMode" | "baseSepoliaRpcUrl" | "ownerApiKey">;

export interface BrokerageDeps {
  /** fetch for Quantcomm (tests point it at a stub). The facilitator uses global fetch. */
  fetch?: FetchLike;
  /** The brokerage wallet; defaults to DATA_DIR/brokerage-key.json. */
  account?: BrokerageAccount;
  /** Pays sell proceeds and reads the float; defaults to @allowance/wallet's settlement for the mode. */
  settlement?: Settlement;
  /** Clock settings; default from BROKERAGE_PRICES / BROKERAGE_REPLAY_FROM / BROKERAGE_DAY_SECONDS. */
  clock?: Partial<ClockSettings>;
  /** ms clock (attestation freshness, the replay's day timer). */
  now?: () => number;
  quiet?: boolean;
  /** How often to retry a facilitator that isn't up yet (default 2 s). */
  facilitatorRetryMs?: number;
  /** Quantcomm cache lifetimes (defaults 60 s list, 10 min histories). */
  listTtlMs?: number;
  historyTtlMs?: number;
}

export interface BrokerageApp extends Express {
  locals: Express["locals"] & {
    payTo: Address;
    clock: ReplayClock;
    book: Book;
    prices: PriceSource;
    /** Load Quantcomm's calendar (and so place the clock). Rejects while Quantcomm is down. */
    ready(): Promise<void>;
    /** Mock mode: top the float up to its minimum (startup). */
    fund(): Promise<void>;
    close(): void;
  };
}

export const SERVICE_NAME = "Brokerage (paper)";
export const PROVIDER = "Allowance";
export const DISCLAIMER = "Paper trading: a simulated brokerage, no real securities or broker. Prices are real daily closes from Quantcomm. Not investment advice.";
export const MIN_ORDER = "1.00";
export const MAX_ORDER = "1000.00";
export const MAX_QUOTES = 20;
/** The ticker whose trading days are the calendar (when Quantcomm lists it). */
export const CALENDAR_TICKER = "SPY";

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const CENT = 10_000n;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An API error the brokerage answers with: `{ error: code, message, ...extra }`. */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface Quote {
  ticker: string;
  name: string;
  group: string;
  /** Dollars per share at the clock's date (rounded to cents). */
  price: string;
  /** The close it comes from (the clock's date, or the last close before it). */
  priceDate: string;
  /** vs the previous trading day's close, percent. */
  changePct1d: number;
  /** vs the close at the replay start, percent. */
  changePctFromStart: number;
}

interface PricedQuote extends Quote {
  priceUnits: bigint;
}

export interface PositionView {
  ticker: string;
  name: string;
  shares: string;
  avgCost: string;
  price: string;
  priceDate: string;
  value: string;
  costBasis: string;
  unrealizedPnl: string;
  unrealizedPct: number;
  changePct1d: number;
}

export interface OrderView {
  orderId: string;
  side: "buy" | "sell";
  ticker: string;
  shares: string;
  price: string;
  /** Buy: paid. Sell: the proceeds. */
  amount: string;
  costBasis?: string;
  realizedPnl?: string;
  clockDate: string;
  at: string;
  status: Order["status"];
  txHash?: string;
}

export interface PortfolioBody {
  address: Address;
  mode: ClockSettings["mode"];
  clockDate: string;
  startDate: string;
  label: string;
  disclaimer: string;
  /** The agent's cash is its wallet balance (GET /v1/me); the brokerage holds none. */
  cash: null;
  positions: PositionView[];
  totals: { invested: string; value: string; unrealizedPnl: string; unrealizedPct: number; realizedPnl: string; totalPnl: string };
  orders: OrderView[];
}

export function createBrokerageApp(config: BrokerageConfig, deps: BrokerageDeps = {}): BrokerageApp {
  const log = deps.quiet ? () => {} : (msg: string) => console.log(`[brokerage] ${msg}`);
  const warn = deps.quiet ? () => {} : (msg: string) => console.warn(`[brokerage] ${msg}`);
  const now = deps.now ?? Date.now;
  const account = deps.account ?? loadBrokerageAccount(config.dataDir, log);
  const payTo = getAddress(account.address);
  const settlement = deps.settlement ?? createSettlement(config);
  const brokerageUrl = config.brokerageUrl.replace(/\/+$/, "");
  const prices = createPriceSource({ baseUrl: config.quantcommUrl, fetch: deps.fetch, now, listTtlMs: deps.listTtlMs, historyTtlMs: deps.historyTtlMs });
  const book = new Book(config.dataDir, log);
  const settings: ClockSettings = { ...clockSettingsFromEnv(process.env, warn), ...(deps.clock ?? {}) };
  const clock = new ReplayClock(settings, {
    restored: book.state.clock,
    now,
    onChange: (snap) => {
      book.state.clock = snap;
      book.save();
    },
  });
  const nonces = new NonceCache();

  // ---- prices and the clock ---------------------------------------------------------------------

  /** Quantcomm's calendar: the reference ticker's dates (cached with its history, so cheap per request). */
  async function ensureCalendar(): Promise<void> {
    const list = await prices.list();
    const ref = list.tickers.find((t) => t.ticker === CALENDAR_TICKER)?.ticker ?? list.tickers[0].ticker;
    const h = await prices.history(ref);
    if (!h) throw new QuantcommError("changed", "Quantcomm's market data changed shape, so the brokerage can't read prices safely; nothing was charged.", `markets/${ref}: listed but answered 404`);
    if (!clock.ready || clock.lastDate() !== h.dates[h.dates.length - 1]) {
      const first = !clock.ready;
      clock.setCalendar(h.dates);
      if (first) {
        const v = clock.view();
        log(v.mode === "live" ? `prices: latest real close ${v.clockDate}` : `prices: replay of real closes from ${v.startDate}, now at ${v.clockDate}, one trading day every ${v.daySeconds} s (last close ${v.lastDate})`);
      }
    }
  }

  function label(): string {
    const v = clock.view();
    return v.mode === "live" ? `Paper trading · latest real close (${v.clockDate})` : `Paper trading · replay of real closes from ${v.startDate}`;
  }
  const honest = () => ({ label: label(), disclaimer: DISCLAIMER });

  function tickerParam(raw: unknown): string {
    const t = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    if (!TICKER_RE.test(t)) throw new HttpError(400, "invalid_ticker", "ticker must be a stock symbol like COF. GET /brokerage lists them.");
    return t;
  }

  async function quote(ticker: string): Promise<PricedQuote> {
    await ensureCalendar();
    const list = await prices.list();
    const info = list.tickers.find((t) => t.ticker === ticker);
    if (!info) throw new HttpError(404, "ticker_not_found", `Quantcomm has no prices for ${ticker}. GET /brokerage lists the ${list.tickers.length} tickers.`, { ticker });
    const h = await prices.history(ticker);
    if (!h) throw new HttpError(404, "ticker_not_found", `Quantcomm has no prices for ${ticker}.`, { ticker });
    const date = clock.date()!;
    const i = indexOnOrBefore(h.dates, date);
    if (i < 0) throw new HttpError(404, "no_price", `${ticker} has no close on or before ${date}.`, { ticker, clockDate: date });
    const priceUnits = priceUnitsOf(h.closes[i]);
    const prevUnits = i > 0 ? priceUnitsOf(h.closes[i - 1]) : priceUnits;
    const s = indexOnOrBefore(h.dates, clock.startDate()!);
    const startUnits = priceUnitsOf(h.closes[s >= 0 ? s : 0]);
    return {
      ticker,
      name: info.name,
      group: info.group,
      price: cents(priceUnits),
      priceDate: h.dates[i],
      changePct1d: round2(pctChange(priceUnits, prevUnits)),
      changePctFromStart: round2(pctChange(priceUnits, startUnits)),
      priceUnits,
    };
  }

  const publicQuote = ({ priceUnits: _p, ...q }: PricedQuote): Quote => q;

  // ---- identity -----------------------------------------------------------------------------------

  /** The audiences this brokerage answers to: its URL, plus loopback aliases of it and of the request's own host. */
  function audiences(req: Request): string[] {
    const out = new Set<string>();
    const add = (u: string) => {
      const a = normalizeAudience(u);
      if (a) out.add(a);
    };
    add(`${brokerageUrl}/brokerage`);
    const aliases = (u: URL) => {
      if (!LOOPBACK.has(u.hostname)) return;
      for (const h of LOOPBACK) add(`${u.protocol}//${h}${u.port ? `:${u.port}` : ""}/brokerage`);
    };
    try {
      aliases(new URL(brokerageUrl));
    } catch {
      /* a bad BROKERAGE_URL only loses the aliases */
    }
    const host = req.headers.host;
    if (host) {
      try {
        aliases(new URL(`${req.protocol}://${host}`));
      } catch {
        /* ignore */
      }
    }
    return [...out];
  }

  const isOwner = (req: Request) => Boolean(config.ownerApiKey) && req.header("x-owner-key") === config.ownerApiKey;

  /** The agent making this call, from its attestation. */
  async function caller(req: Request): Promise<Address> {
    const r = await verifyAttestation(req.header(ATTESTATION_HEADER), { audiences: audiences(req), nonces, now: now() });
    if (!r.ok) {
      throw new HttpError(401, "attestation_required", `Prove which wallet you are with an X-Allowance-Attestation header (your wallet makes one: POST /v1/attest). This one didn't work: ${r.reason}.`);
    }
    return r.address;
  }

  const requireOwner: RequestHandler = (req, _res, next) => {
    if (!isOwner(req)) throw new HttpError(401, "unauthorized", "X-Owner-Key required");
    next();
  };

  // ---- views --------------------------------------------------------------------------------------

  function orderView(o: Order): OrderView {
    return {
      orderId: o.id,
      side: o.side,
      ticker: o.ticker,
      shares: formatShares(BigInt(o.sharesMicro)),
      price: cents(BigInt(o.priceUnits)),
      amount: toDollars(BigInt(o.amountUnits)),
      ...(o.side === "sell" ? { costBasis: cents(BigInt(o.costUnits ?? "0")), realizedPnl: cents(BigInt(o.realizedUnits ?? "0")) } : {}),
      clockDate: o.clockDate,
      at: o.at,
      status: o.status,
      ...(o.txHash ? { txHash: o.txHash } : {}),
    };
  }

  async function portfolio(address: Address): Promise<PortfolioBody> {
    await ensureCalendar();
    const acct = book.account(address);
    const positions: PositionView[] = [];
    let invested = 0n;
    let value = 0n;
    for (const p of Object.values(acct?.positions ?? {}).sort((a, b) => a.ticker.localeCompare(b.ticker))) {
      const q = await quote(p.ticker);
      const shares = BigInt(p.sharesMicro);
      const cost = BigInt(p.costUnits);
      const v = valueOf(shares, q.priceUnits);
      positions.push({
        ticker: p.ticker,
        name: q.name,
        shares: formatShares(shares),
        avgCost: cents(shares > 0n ? (cost * MICRO) / shares : 0n),
        price: q.price,
        priceDate: q.priceDate,
        value: cents(v),
        costBasis: cents(cost),
        unrealizedPnl: cents(v - cost),
        unrealizedPct: round2(pctChange(v, cost)),
        changePct1d: q.changePct1d,
      });
      invested += cost;
      value += v;
    }
    const realized = BigInt(acct?.realizedUnits ?? "0");
    return {
      address: getAddress(address),
      mode: settings.mode,
      clockDate: clock.date()!,
      startDate: clock.startDate()!,
      ...honest(),
      cash: null,
      positions,
      totals: {
        invested: cents(invested),
        value: cents(value),
        unrealizedPnl: cents(value - invested),
        unrealizedPct: round2(pctChange(value, invested)),
        realizedPnl: cents(realized),
        totalPnl: cents(value - invested + realized),
      },
      orders: book.ordersOf(address, 10).map(orderView),
    };
  }

  // ---- buy: order checks, then the x402 paywall ---------------------------------------------------------

  interface BuyOrder {
    ticker: string;
    amountUnits: bigint;
  }

  function amountParam(raw: unknown): bigint {
    const bad = () => new HttpError(400, "invalid_amount", `amount must be dollars and cents between $${MIN_ORDER} and $${MAX_ORDER}, like 100.00`);
    if (typeof raw !== "string" && typeof raw !== "number") throw bad();
    const s = String(raw).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw bad();
    const units = toBaseUnits(s);
    if (units < toBaseUnits(MIN_ORDER) || units > toBaseUnits(MAX_ORDER)) throw bad();
    return units;
  }

  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);

  /** The order from the query; a JSON body may repeat it but not contradict it. */
  function buyOrder(req: Request): BuyOrder {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as { ticker?: unknown; amount?: unknown };
    const q = req.query as Record<string, unknown>;
    if (q.ticker === undefined && q.amount === undefined && (body.ticker !== undefined || body.amount !== undefined)) {
      throw new HttpError(400, "order_in_query", "Put the order in the URL: POST /brokerage/orders/buy?ticker=COF&amount=100.00 (the wallet checks the price at that exact URL).");
    }
    const ticker = tickerParam(one(q.ticker));
    const amountUnits = amountParam(one(q.amount));
    if (body.ticker !== undefined && tickerParam(body.ticker) !== ticker) throw new HttpError(400, "order_mismatch", "The body's ticker differs from the URL's.");
    if (body.amount !== undefined && amountParam(body.amount) !== amountUnits) throw new HttpError(400, "order_mismatch", "The body's amount differs from the URL's.");
    return { ticker, amountUnits };
  }

  const buyPrecheck: RequestHandler = async (req, res, next) => {
    const order = buyOrder(req);
    const q = await quote(order.ticker);
    res.locals.order = order;
    res.locals.quote = q;
    next();
  };

  /** The paywall's price: the order amount (already checked by the precheck). */
  const buyPrice = (ctx: HTTPRequestContext): string => {
    const raw = ctx.adapter.getQueryParam?.("amount");
    return `$${toDollars(amountParam(one(raw)))}`;
  };

  const facilitatorClient = new HTTPFacilitatorClient({ url: config.x402FacilitatorUrl });
  /** Verified buys waiting for their settlement, by payer:nonce. Booked in onAfterSettle. */
  const pendingBuys = new Map<string, { order: Order; at: number }>();
  const settledNonces = new Set<string>();

  const routes: RoutesConfig = {
    "POST /brokerage/orders/buy": {
      accepts: { scheme: "exact", network: BASE_SEPOLIA_NETWORK, payTo, price: buyPrice, maxTimeoutSeconds: 300 },
      description: SERVICE_NAME,
      serviceName: SERVICE_NAME,
      mimeType: "application/json",
      settlementFailedResponseBody: async () => ({
        contentType: "application/json",
        body: { error: "payment_not_settled", message: "The USDC payment did not settle, so nothing was bought and nothing was charged. You can try again." },
      }),
    } satisfies RouteConfig,
  };

  const nonceKey = (payload: unknown): string | undefined => {
    const a = (payload as { payload?: { authorization?: { from?: unknown; nonce?: unknown } } } | undefined)?.payload?.authorization;
    return typeof a?.from === "string" && typeof a.nonce === "string" ? `${a.from.toLowerCase()}:${a.nonce.toLowerCase()}` : undefined;
  };

  function newResourceServer(): x402ResourceServer {
    const rs = new x402ResourceServer(facilitatorClient).register(BASE_SEPOLIA_NETWORK, new ExactEvmScheme());
    rs.onAfterSettle(async (ctx) => {
      const key = nonceKey(ctx.paymentPayload);
      const pending = key ? pendingBuys.get(key) : undefined;
      if (!key || !pending) return;
      pendingBuys.delete(key);
      settledNonces.add(key);
      const o = pending.order;
      o.txHash = ctx.result.transaction as Hex;
      book.addShares(o.address, o.ticker, BigInt(o.sharesMicro), BigInt(o.amountUnits), o.at);
      const acct = book.accountOrNew(o.address);
      acct.boughtUnits = (BigInt(acct.boughtUnits) + BigInt(o.amountUnits)).toString();
      book.record(o);
      book.save();
      log(`${o.address} bought ${formatShares(BigInt(o.sharesMicro))} ${o.ticker} at $${cents(BigInt(o.priceUnits))} for ${formatUsd(BigInt(o.amountUnits))} (replay date ${o.clockDate}; tx ${o.txHash})`);
    });
    rs.onSettleFailure(async (ctx) => {
      const key = nonceKey(ctx.paymentPayload);
      if (key && pendingBuys.delete(key)) warn(`a buy's payment did not settle (${ctx.error.message}); nothing was booked`);
    });
    return rs;
  }

  // syncFacilitatorOnStart: the first sync starts now and the middleware retries lazily, but its retry
  // awaits the failed startup sync, so the first paid request after a late facilitator start would fail
  // once. Instead, watch the facilitator and rebuild the paywall when it answers (as the bridges do).
  let paywall: RequestHandler = paymentMiddleware(routes, newResourceServer(), undefined, undefined, true);
  let closed = false;
  const retryMs = deps.facilitatorRetryMs ?? 2000;
  void (async () => {
    for (let attempt = 0; attempt < 300 && !closed; attempt++) {
      try {
        await facilitatorClient.getSupported();
        if (attempt > 0) {
          paywall = paymentMiddleware(routes, newResourceServer(), undefined, undefined, true);
          log(`facilitator ${config.x402FacilitatorUrl} is up; paywall synced`);
        }
        return;
      } catch {
        if (attempt === 0) warn(`facilitator ${config.x402FacilitatorUrl} isn't answering yet; buys wait for it`);
      }
      await new Promise((r) => setTimeout(r, retryMs).unref());
    }
  })();

  function verifiedPayment(req: Request): { payer: Address; key: string } | null {
    const header = req.header("payment-signature") || req.header("x-payment");
    if (!header) return null;
    try {
      const p = decodePaymentSignatureHeader(header) as unknown;
      const key = nonceKey(p);
      const from = (p as { payload?: { authorization?: { from?: unknown } } }).payload?.authorization?.from;
      return key && typeof from === "string" && isAddress(from) ? { payer: getAddress(from), key } : null;
    } catch {
      return null;
    }
  }

  const buyHandler = (req: Request, res: Response): void => {
    // Defense in depth: a buy is only ever filled behind a verified payment.
    const payment = verifiedPayment(req);
    if (!payment) throw new HttpError(500, "payment_not_verified", "This order is paid, and no verified payment reached it; nothing was charged.");
    for (const [k, v] of pendingBuys) if (now() - v.at > 15 * 60_000) pendingBuys.delete(k);
    if (pendingBuys.has(payment.key) || settledNonces.has(payment.key)) {
      throw new HttpError(409, "payment_reused", "This payment authorization was already used for an order. Pay this order with a new payment.");
    }
    const { ticker, amountUnits } = res.locals.order as BuyOrder;
    const q = res.locals.quote as PricedQuote;
    const shares = sharesFor(amountUnits, q.priceUnits);
    if (shares <= 0n) throw new HttpError(400, "invalid_amount", `${formatUsd(amountUnits)} doesn't buy a millionth of a ${ticker} share.`);
    const at = nowIso();
    const order: Order = {
      id: newId("ord"),
      side: "buy",
      address: payment.payer,
      ticker,
      sharesMicro: shares.toString(),
      priceUnits: q.priceUnits.toString(),
      amountUnits: amountUnits.toString(),
      clockDate: clock.date()!,
      at,
      status: "filled",
    };
    pendingBuys.set(payment.key, { order, at: now() });
    const held = book.account(payment.payer)?.positions[ticker];
    const heldShares = BigInt(held?.sharesMicro ?? "0") + shares;
    const heldCost = BigInt(held?.costUnits ?? "0") + amountUnits;
    // Sent once the payment settled (the paywall holds the response until then).
    res.status(200).json({
      orderId: order.id,
      side: "buy",
      ticker,
      name: q.name,
      shares: formatShares(shares),
      price: q.price,
      amount: toDollars(amountUnits),
      clockDate: order.clockDate,
      status: "filled",
      position: { ticker, shares: formatShares(heldShares), avgCost: cents((heldCost * MICRO) / heldShares), costBasis: cents(heldCost) },
      ...honest(),
    });
  };

  // ---- sell -------------------------------------------------------------------------------------------

  async function sell(req: Request) {
    const address = await caller(req);
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as { ticker?: unknown; shares?: unknown };
    const ticker = tickerParam(body.ticker);
    if (body.shares === undefined || body.shares === null || body.shares === "") {
      throw new HttpError(400, "invalid_shares", "shares is required: a number like 1.5, or \"all\".");
    }
    const q = await quote(ticker);
    // From here to the reservation there is no await, so two sells can't both spend the same shares.
    const position = book.account(address)?.positions[ticker];
    if (!position) throw new HttpError(404, "no_position", `You hold no ${ticker}.`, { ticker });
    const held = BigInt(position.sharesMicro);
    let want: bigint;
    if (typeof body.shares === "string" && body.shares.trim().toLowerCase() === "all") want = held;
    else {
      try {
        want = parseShares(body.shares);
      } catch (err) {
        throw new HttpError(400, "invalid_shares", (err as Error).message);
      }
    }
    if (want > held) throw new HttpError(400, "insufficient_shares", `You hold ${formatShares(held)} ${ticker}, not ${formatShares(want)}.`, { ticker, held: formatShares(held) });
    const cost = want === held ? BigInt(position.costUnits) : (BigInt(position.costUnits) * want) / held;
    const proceeds = floorCents(valueOf(want, q.priceUnits));
    if (proceeds < CENT) throw new HttpError(400, "order_too_small", `${formatShares(want)} ${ticker} is worth less than $0.01 at $${q.price}.`);
    const at = nowIso();
    const clockDate = clock.date()!;
    book.removeShares(address, ticker, want, cost, at);
    book.save();
    const restore = () => {
      book.addShares(address, ticker, want, cost, at);
      book.save();
    };

    try {
      await ensureFloat(config, settlement, payTo, proceeds, log);
    } catch (err) {
      restore();
      warn(`sell of ${formatShares(want)} ${ticker} refused: ${(err as Error).message}`);
      throw new HttpError(503, "brokerage_underfunded", "The brokerage can't pay this sell right now, so nothing was sold. Try again shortly.");
    }
    const memo = `Sold ${formatShares(want)} ${ticker}`;
    let payout: { txHash: Hex; explorerUrl: string };
    try {
      payout = await settlement.transfer(account, address, proceeds, memo);
    } catch (err) {
      restore();
      warn(`payout for ${memo} to ${address} failed: ${(err as Error).message}`);
      throw new HttpError(502, "payout_failed", "The payout didn't go through, so nothing was sold. Try again.");
    }

    const realized = proceeds - cost;
    const order: Order = {
      id: newId("ord"),
      side: "sell",
      address,
      ticker,
      sharesMicro: want.toString(),
      priceUnits: q.priceUnits.toString(),
      amountUnits: proceeds.toString(),
      costUnits: cost.toString(),
      realizedUnits: realized.toString(),
      clockDate,
      at,
      status: "filled",
      txHash: payout.txHash,
    };
    const acct = book.accountOrNew(address);
    acct.realizedUnits = (BigInt(acct.realizedUnits) + realized).toString();
    acct.soldUnits = (BigInt(acct.soldUnits) + proceeds).toString();
    book.record(order);
    book.save();
    log(`${address} sold ${formatShares(want)} ${ticker} at $${q.price} for ${formatUsd(proceeds)} (${realized >= 0n ? "+" : ""}${cents(realized)} realized; replay date ${clockDate}; tx ${payout.txHash})`);
    const left = book.account(address)?.positions[ticker];
    return {
      orderId: order.id,
      side: "sell" as const,
      ticker,
      name: q.name,
      shares: formatShares(want),
      price: q.price,
      proceeds: toDollars(proceeds),
      costBasis: cents(cost),
      realizedPnl: cents(realized),
      realizedPct: round2(pctChange(proceeds, cost)),
      payoutTx: payout.txHash,
      explorerUrl: explorerTxUrl(payout.txHash, config.chainMode, config.facilitatorUrl),
      from: payTo,
      clockDate,
      position: left ? { ticker, shares: formatShares(BigInt(left.sharesMicro)), costBasis: cents(BigInt(left.costUnits)) } : null,
      ...honest(),
    };
  }

  // ---- app --------------------------------------------------------------------------------------------

  const app = express() as BrokerageApp;
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.use((req, res, next) => {
    if (req.path !== "/health") res.on("finish", () => log(`${req.method} ${req.originalUrl} -> ${res.statusCode}`));
    next();
  });

  app.get("/health", async (_req, res) => {
    try {
      await ensureCalendar();
      res.json({ ok: true, upstream: "up", mode: settings.mode, clockDate: clock.date(), payTo });
    } catch {
      res.json({ ok: true, upstream: "down", mode: settings.mode, clockDate: clock.date(), payTo });
    }
  });

  app.get("/brokerage", async (_req, res) => {
    await ensureCalendar();
    const list = await prices.list();
    const b = `${brokerageUrl}/brokerage`;
    res.json({
      name: SERVICE_NAME,
      provider: PROVIDER,
      ...clock.view(),
      ...honest(),
      fees: "none",
      minOrder: MIN_ORDER,
      maxOrder: MAX_ORDER,
      tickers: list.tickers,
      endpoints: [
        { method: "GET", url: `${b}/quotes?tickers=COF,JPM`, price: "free", returns: `Prices at the clock's date (up to ${MAX_QUOTES} tickers).` },
        { method: "POST", url: `${b}/orders/buy?ticker=COF&amount=100.00`, price: "the amount (x402)", returns: "Fractional shares at the clock's price." },
        { method: "POST", url: `${b}/orders/sell`, body: { ticker: "COF", shares: "all" }, price: "free (pays you)", returns: "Proceeds in USDC to your wallet. Needs X-Allowance-Attestation." },
        { method: "GET", url: `${b}/portfolio`, price: "free", returns: "Your positions and P/L. Needs X-Allowance-Attestation." },
      ],
      identity: "Buys belong to the wallet that paid. Sells and portfolio reads need X-Allowance-Attestation, a short text your wallet signs for you (POST /v1/attest); agents get it through the sell_stock and portfolio tools.",
      ...(clock.view().caughtUp ? { note: "The replay reached the latest close; prices stay there until Quantcomm has a new one." } : {}),
    });
  });

  app.get("/brokerage/quotes", async (req, res) => {
    const raw = one(req.query.tickers);
    const wanted = [...new Set((typeof raw === "string" ? raw : "").split(",").map((t) => t.trim().toUpperCase()).filter(Boolean))];
    if (!wanted.length || wanted.length > MAX_QUOTES || wanted.some((t) => !TICKER_RE.test(t))) {
      throw new HttpError(400, "invalid_tickers", `tickers must be 1 to ${MAX_QUOTES} symbols separated by commas, like ?tickers=COF,JPM`);
    }
    await ensureCalendar();
    const list = await prices.list();
    const known = new Set(list.tickers.map((t) => t.ticker));
    const unknown = wanted.filter((t) => !known.has(t));
    if (unknown.length === wanted.length) throw new HttpError(404, "ticker_not_found", `Quantcomm has no prices for ${unknown.join(", ")}. GET /brokerage lists the ${list.tickers.length} tickers.`, { unknown });
    const quotes: Quote[] = [];
    for (const t of wanted.filter((x) => known.has(x))) quotes.push(publicQuote(await quote(t)));
    res.json({ mode: settings.mode, clockDate: clock.date(), startDate: clock.startDate(), ...honest(), quotes, ...(unknown.length ? { unknown } : {}) });
  });

  const paid: RequestHandler = (req, res, next) => paywall(req, res, next);
  app.post("/brokerage/orders/buy", buyPrecheck, paid, buyHandler);

  app.post("/brokerage/orders/sell", async (req, res) => {
    res.json(await sell(req));
  });

  app.get("/brokerage/portfolio", async (req, res) => {
    const raw = one(req.query.address);
    if (raw !== undefined) {
      // Owner (dashboard, scheduler): any agent's portfolio by wallet address.
      if (!isOwner(req)) throw new HttpError(401, "unauthorized", "Reading a portfolio by address needs X-Owner-Key. Agents read their own with X-Allowance-Attestation.");
      if (typeof raw !== "string" || !isAddress(raw)) throw new HttpError(400, "invalid_address", "address must be a 0x wallet address");
      res.json(await portfolio(getAddress(raw)));
      return;
    }
    res.json(await portfolio(await caller(req)));
  });

  app.get("/brokerage/portfolios", requireOwner, async (_req, res) => {
    await ensureCalendar();
    const portfolios: PortfolioBody[] = [];
    for (const address of Object.keys(book.state.accounts)) portfolios.push(await portfolio(address as Address));
    res.json({ mode: settings.mode, clockDate: clock.date(), startDate: clock.startDate(), ...honest(), portfolios });
  });

  app.post("/brokerage/clock/advance", requireOwner, async (req, res) => {
    await ensureCalendar();
    const raw = (req.body as { days?: unknown } | undefined)?.days ?? 1;
    const days = Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 400) throw new HttpError(400, "invalid_days", "days must be a whole number from 1 to 400");
    if (settings.mode !== "replay") throw new HttpError(409, "not_replaying", "The brokerage uses the latest close (BROKERAGE_PRICES=live); there is no replay to advance.");
    const moved = clock.advance(days);
    log(`clock advanced ${moved} trading day(s) by the owner, now ${clock.date()}`);
    res.json({ moved, ...clock.view(), ...honest() });
  });

  // ---- 404 / errors -------------------------------------------------------------------------------------

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", message: `${req.method} ${req.path}` });
  });
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message, ...(err.extra ?? {}) });
      return;
    }
    if (err instanceof QuantcommError) {
      if (err.kind === "changed") {
        warn(`Quantcomm's market data changed: ${err.where}`);
        res.status(502).json({ error: "quantcomm_changed", message: err.message, details: { where: err.where } });
      } else {
        warn(`prices unavailable: ${err.where ?? err.message}`);
        res.status(503).json({ error: "prices_unavailable", message: err.message });
      }
      return;
    }
    if (err.type === "entity.parse.failed") {
      res.status(400).json({ error: "invalid_json", message: "Request body must be valid JSON" });
      return;
    }
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) warn(`error: ${err.stack ?? err.message}`);
    res.status(status).json({ error: status < 500 ? "bad_request" : "internal_error", message: status < 500 ? "Bad request." : "Internal error." });
  });

  // ---- timers -----------------------------------------------------------------------------------------

  const timers: NodeJS.Timeout[] = [];
  if (settings.mode === "replay" && settings.daySeconds > 0) {
    const t = setInterval(() => {
      if (clock.tick()) log(`replay date ${clock.date()}`);
    }, settings.daySeconds * 1000);
    t.unref();
    timers.push(t);
  }

  app.locals.payTo = payTo;
  app.locals.clock = clock;
  app.locals.book = book;
  app.locals.prices = prices;
  app.locals.ready = ensureCalendar;
  app.locals.fund = async () => {
    if (config.chainMode !== "mock") return;
    try {
      await ensureFloat(config, settlement, payTo, 0n, log);
    } catch (err) {
      if (err instanceof FloatError) warn(`could not fund the paper-trading float yet (${err.message}); sells will try again`);
      else throw err;
    }
  };
  app.locals.close = () => {
    closed = true;
    for (const t of timers) clearInterval(t);
  };
  return app;
}

export { isQuantcommError };
