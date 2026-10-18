/**
 * The mock's paper brokerage and scheduler (§20), for `?mock=1`: a replay clock over made-up daily
 * closes (seeded, so screenshots agree), positions per wallet with average cost, realized P/L and
 * filled orders, schedules and owner rules with the scheduler's semantics, and the autonomy switch.
 * It answers in the services' own shapes (apps/brokerage `GET /brokerage/portfolios`, apps/scheduler
 * owner `GET /schedules?all=1`), so the dashboard reads the mock through the same normalizers as HTTP.
 * Money stays in the mock wallet (mockAdapter.ts): this module says what a trade or a firing is, and
 * the wallet side emits the receipts and events.
 */
import { fromCents, toCents } from "../format";
import type { AgentRules } from "../invest";
import { HttpError } from "./adapter";

export const MOCK_REPLAY_FROM = "2024-11-01";

/** The tickers the mock quotes, at levels like their real ones (the closes themselves are made up). */
export const MOCK_TICKERS: { ticker: string; name: string; start: number; drift: number; vol: number }[] = [
  { ticker: "COF", name: "Capital One Financial", start: 212.4, drift: 0.0006, vol: 0.016 },
  { ticker: "JPM", name: "JPMorgan Chase", start: 238.1, drift: 0.0002, vol: 0.006 },
  { ticker: "NVDA", name: "NVIDIA", start: 135.4, drift: 0.0012, vol: 0.028 },
  { ticker: "AAPL", name: "Apple", start: 222.9, drift: 0.0004, vol: 0.013 },
  { ticker: "SPY", name: "SPDR S&P 500 ETF", start: 571.0, drift: 0.0004, vol: 0.008 },
];
/**
 * COF's first replay days are fixed so the story reads the same every time: up 6.2% by day 3 (the
 * agent's price watch fires and it sells), bought back on day 5, then a slide that trips the owner's
 * 5% stop loss on the whole portfolio about a minute after the page opens.
 */
const COF_PATH = [1, 1.012, 1.034, 1.062, 1.056, 1.048, 1.041, 1.036, 1.03, 1.022, 1.012, 1.0, 0.988, 0.972, 0.958, 0.947, 0.941, 0.944, 0.951];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Weekdays from `from`, as YYYY-MM-DD (holidays ignored: it's a mock). */
export function tradingDays(from: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** The scheduler's own schedule shape (apps/scheduler/src/types.ts), the parts the dashboard reads. */
export interface RawSchedule {
  id: string;
  agentName: string;
  kind: "at" | "every" | "price";
  at?: string;
  everyMinutes?: number;
  condition?: { ticker: string; op: ">=" | "<="; price: number } | { portfolio: "unrealizedPct" | "unrealizedPnl"; op: ">=" | "<="; value: number; ticker?: string };
  message: string;
  source: "agent" | "owner";
  rule?: "take_profit" | "stop_loss" | "cash_out_profits";
  ruleValue?: number;
  label: string;
  createdAt: string;
  nextRunAt?: string;
  lastObserved?: string;
  lastFiredAt?: string;
  fired: number;
  active: boolean;
  endedAt?: string;
  endedReason?: "fired" | "cancelled" | "expired" | "replaced" | "missed";
  needsChat?: boolean;
}
export interface RawFiring {
  id: string;
  scheduleId: string;
  agentName: string;
  source: "agent" | "owner";
  label: string;
  at: string;
  context: string;
  rule?: RawSchedule["rule"];
}

type Lot = { shares: number; cost: number };
type RawOrder = { orderId: string; side: "buy" | "sell"; ticker: string; shares: string; price: string; amount: string; costBasis?: string; realizedPnl?: string; clockDate: string; at: string; status: "filled"; txHash: string };

export interface BuyFill {
  ticker: string;
  shares: number;
  price: number;
  amount: string;
  clockDate: string;
}
export interface SellFill {
  ticker: string;
  shares: number;
  price: number;
  proceeds: string;
  costBasis: string;
  realizedPnl: string;
  clockDate: string;
}
export interface Due {
  schedule: RawSchedule;
  firing: RawFiring;
}
type NewSchedule = Omit<RawSchedule, "id" | "createdAt" | "fired" | "active" | "label"> & Partial<Pick<RawSchedule, "label">>;

export interface MockMarket {
  readonly replayFrom: string;
  clockDate(): string;
  advance(): void;
  price(ticker: string): number;
  buy(agentName: string, ticker: string, amount: string): BuyFill;
  sell(agentName: string, ticker: string, shares?: number | "all"): SellFill;
  /** Book the filled order once its payment settled (the brokerage does the same), by tx hash. */
  recordOrder(agentName: string, fill: BuyFill | SellFill, txHash: string): void;
  /** Its open positions and how each is doing (percent). */
  positions(agentName: string): { ticker: string; pct: number }[];
  /** `GET /brokerage/portfolios`, by wallet address. */
  portfoliosRaw(addressOf: (agentName: string) => string | undefined): unknown;
  /** `GET /schedules?all=1` (owner). */
  schedulerRaw(): unknown;
  addSchedule(s: NewSchedule): RawSchedule;
  cancel(id: string): void;
  setRules(agentName: string, rules: AgentRules): void;
  setPaused(paused: boolean): boolean;
  paused(): boolean;
  /** What fires now (firings recorded). The caller makes the agent react. */
  due(now?: number): Due[];
  recordFiring(s: RawSchedule, at: string, context: string): RawFiring;
  end(s: RawSchedule, reason: NonNullable<RawSchedule["endedReason"]>): void;
}

const usd = (n: number) => `$${Math.abs(n).toFixed(2)}`;
const signedCents = (dollars: number): string => {
  const c = Math.round(dollars * 100);
  return c < 0 ? `-${fromCents(-c)}` : fromCents(c);
};
const fmtShares = (n: number) => String(Math.round(n * 1e6) / 1e6);

type RuleType = NonNullable<RawSchedule["rule"]>;
const RULE_MESSAGE: Record<RuleType, (v: number) => string> = {
  take_profit: (v) => `Your owner's take-profit rule: when your portfolio is up ${v}% or more, take the profit. It has reached that now. Sell your positions with sell_stock, then tell your owner briefly what you sold and the realized profit.`,
  stop_loss: (v) => `Your owner's stop-loss rule: when your portfolio is down ${v}% or more, sell to limit the loss. It has reached that now. Sell your positions with sell_stock, then tell your owner briefly what you sold and the realized loss.`,
  cash_out_profits: (v) => `Your owner's rule: cash out profits above $${v}. Your unrealized profit is above that now. Sell the positions that are up with sell_stock to realize the profit, then send the realized profit to your owner with cash_out.`,
};
const RULE_LABEL: Record<RuleType, (v: number) => string> = {
  take_profit: () => "Rule: take profit",
  stop_loss: () => "Rule: stop loss",
  cash_out_profits: (v) => `Rule: cash out profits above $${v}`,
};

export function createMockMarket(opts: { seed?: number; now?: () => number } = {}): MockMarket {
  const now = opts.now ?? (() => Date.now());
  const rand = rng(opts.seed ?? 7);
  const days = tradingDays(MOCK_REPLAY_FROM, 260);
  // Daily closes, seeded: a random walk per ticker (Box–Muller normals), COF's opening days fixed.
  const closes = new Map<string, number[]>();
  for (const t of MOCK_TICKERS) {
    const series: number[] = [t.start];
    for (let i = 1; i < days.length; i++) {
      const u = Math.max(1e-9, rand());
      const v = rand();
      const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      const fixed = t.ticker === "COF" && i < COF_PATH.length;
      series.push(fixed ? t.start * COF_PATH[i] : series[i - 1] * (1 + t.drift + t.vol * z));
    }
    closes.set(t.ticker, series.map((p) => Math.round(p * 100) / 100));
  }
  let day = 0;
  let paused = false;
  let seq = 0;
  const lots = new Map<string, Map<string, Lot>>();
  const realized = new Map<string, number>();
  const orders = new Map<string, RawOrder[]>();
  const schedules: RawSchedule[] = [];
  const log: RawFiring[] = [];
  const iso = (t = now()) => new Date(t).toISOString();
  const nextId = (p: string) => `${p}_${(++seq).toString(36).padStart(4, "0")}`;

  const price = (ticker: string) => {
    const s = closes.get(ticker.toUpperCase());
    if (!s) throw new HttpError(`Quantcomm has no prices for ${ticker}.`, 404, "ticker_not_found");
    return s[Math.min(day, s.length - 1)];
  };
  const book = (agent: string) => {
    let b = lots.get(agent);
    if (!b) lots.set(agent, (b = new Map()));
    return b;
  };
  const clockDate = () => days[Math.min(day, days.length - 1)];

  function totals(agent: string) {
    let invested = 0;
    let value = 0;
    for (const [t, l] of book(agent)) {
      invested += l.cost;
      value += l.shares * price(t);
    }
    return { invested, value, pnl: value - invested, pct: invested > 0 ? ((value - invested) / invested) * 100 : 0 };
  }

  function recordFiring(s: RawSchedule, at: string, context: string): RawFiring {
    s.fired += 1;
    s.lastFiredAt = at;
    const f: RawFiring = { id: nextId("fire"), scheduleId: s.id, agentName: s.agentName, source: s.source, label: s.label, at, context, ...(s.rule ? { rule: s.rule } : {}) };
    log.push(f);
    if (log.length > 100) log.shift();
    return f;
  }
  function end(s: RawSchedule, reason: NonNullable<RawSchedule["endedReason"]>) {
    s.active = false;
    s.endedReason = reason;
    s.endedAt = iso();
    s.nextRunAt = undefined;
  }
  function addSchedule(s: NewSchedule): RawSchedule {
    const active = schedules.filter((x) => x.agentName === s.agentName && x.active && x.source === s.source).length;
    if (active >= 10) throw new HttpError(`${s.agentName} already has 10 active schedules, the most an agent can have.`, 400, "limit_active");
    if (s.kind === "every" && (s.everyMinutes ?? 0) < 1) throw new HttpError("A repeating schedule runs at most once a minute.", 400, "limit_every");
    const label = s.label ?? (s.rule ? RULE_LABEL[s.rule](s.ruleValue ?? 0) : s.kind === "price" ? "Price watch you set" : "Reminder you set");
    const full: RawSchedule = { ...s, label, id: nextId("sch"), createdAt: iso(), fired: 0, active: true };
    schedules.push(full);
    return full;
  }

  return {
    replayFrom: MOCK_REPLAY_FROM,
    clockDate,
    advance: () => {
      if (day < days.length - 1) day++;
    },
    price,
    buy(agentName, ticker, amount) {
      const t = ticker.toUpperCase();
      const p = price(t);
      const cents = toCents(amount);
      if (cents < 100) throw new HttpError("amount must be dollars and cents between $1.00 and $1,000.00, like 100.00", 400, "invalid_amount");
      const sh = Math.floor((cents / 100 / p) * 1e6) / 1e6;
      const l = book(agentName).get(t) ?? { shares: 0, cost: 0 };
      book(agentName).set(t, { shares: l.shares + sh, cost: l.cost + cents / 100 });
      return { ticker: t, shares: sh, price: p, amount: fromCents(cents), clockDate: clockDate() };
    },
    sell(agentName, ticker, shares = "all") {
      const t = ticker.toUpperCase();
      const l = book(agentName).get(t);
      if (!l || l.shares <= 1e-9) throw new HttpError(`You hold no ${t}.`, 404, "no_position");
      const sh = shares === "all" ? l.shares : Math.min(shares, l.shares);
      const p = price(t);
      const basis = (l.cost / l.shares) * sh;
      const proceeds = Math.floor(sh * p * 100) / 100;
      const pnl = proceeds - basis;
      l.shares -= sh;
      l.cost -= basis;
      if (l.shares <= 1e-9) book(agentName).delete(t);
      realized.set(agentName, (realized.get(agentName) ?? 0) + pnl);
      return { ticker: t, shares: sh, price: p, proceeds: fromCents(Math.round(proceeds * 100)), costBasis: fromCents(Math.round(basis * 100)), realizedPnl: signedCents(pnl), clockDate: clockDate() };
    },
    recordOrder(agentName, fill, txHash) {
      const list = orders.get(agentName) ?? [];
      const sell = "proceeds" in fill;
      list.unshift({
        orderId: nextId("ord"),
        side: sell ? "sell" : "buy",
        ticker: fill.ticker,
        shares: fmtShares(fill.shares),
        price: fill.price.toFixed(2),
        amount: sell ? fill.proceeds : fill.amount,
        ...(sell ? { costBasis: fill.costBasis, realizedPnl: fill.realizedPnl } : {}),
        clockDate: fill.clockDate,
        at: iso(),
        status: "filled",
        txHash,
      });
      orders.set(agentName, list.slice(0, 10));
    },
    positions: (agentName) => [...book(agentName).entries()].map(([t, l]) => ({ ticker: t, pct: ((l.shares * price(t) - l.cost) / l.cost) * 100 })),
    portfoliosRaw(addressOf) {
      const names = new Set([...lots.keys(), ...realized.keys()]);
      const portfolios = [...names].map((agentName) => {
        const positions = [...book(agentName).entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([ticker, l]) => {
            const p = price(ticker);
            const value = l.shares * p;
            return {
              ticker,
              name: MOCK_TICKERS.find((x) => x.ticker === ticker)?.name ?? ticker,
              shares: fmtShares(l.shares),
              avgCost: (l.cost / l.shares).toFixed(2),
              price: p.toFixed(2),
              priceDate: clockDate(),
              value: value.toFixed(2),
              costBasis: l.cost.toFixed(2),
              unrealizedPnl: signedCents(value - l.cost),
              unrealizedPct: Math.round(((value - l.cost) / l.cost) * 10000) / 100,
            };
          });
        const t = totals(agentName);
        const r = realized.get(agentName) ?? 0;
        return {
          address: addressOf(agentName) ?? "0x0000000000000000000000000000000000000000",
          mode: "replay",
          clockDate: clockDate(),
          startDate: MOCK_REPLAY_FROM,
          cash: null,
          positions,
          totals: { invested: t.invested.toFixed(2), value: t.value.toFixed(2), unrealizedPnl: signedCents(t.pnl), unrealizedPct: Math.round(t.pct * 100) / 100, realizedPnl: signedCents(r), totalPnl: signedCents(t.pnl + r) },
          orders: orders.get(agentName) ?? [],
        };
      });
      return { mode: "replay", clockDate: clockDate(), startDate: MOCK_REPLAY_FROM, label: `Paper trading · replay of real closes from ${MOCK_REPLAY_FROM}`, portfolios };
    },
    schedulerRaw: () => ({
      schedules: [...schedules].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((s) => ({ ...s, ...(s.condition ? { condition: { ...s.condition } } : {}) })),
      paused,
      firings: [...log].reverse().map((f) => ({ ...f })),
    }),
    addSchedule,
    cancel(id) {
      const s = schedules.find((x) => x.id === id);
      if (!s) throw new HttpError(`No schedule ${id}.`, 404, "schedule_not_found");
      if (!s.active) throw new HttpError(`${id} already ended (${s.endedReason ?? "ended"}).`, 409, "schedule_ended");
      end(s, "cancelled");
    },
    setRules(agentName, rules) {
      const want: [RuleType, string | undefined][] = [
        ["take_profit", rules.takeProfitPct],
        ["stop_loss", rules.stopLossPct],
        ["cash_out_profits", rules.cashOutAbove],
      ];
      for (const [rule, raw] of want) {
        const value = raw === undefined || raw === "" ? undefined : Number(raw);
        const cur = schedules.find((x) => x.agentName === agentName && x.source === "owner" && x.rule === rule && x.active);
        if (cur && value !== undefined && cur.ruleValue === value) continue;
        if (cur) end(cur, value === undefined ? "cancelled" : "replaced");
        if (value === undefined) continue;
        addSchedule({
          agentName,
          kind: "price",
          everyMinutes: 10,
          condition: rule === "cash_out_profits" ? { portfolio: "unrealizedPnl", op: ">=", value } : { portfolio: "unrealizedPct", op: rule === "stop_loss" ? "<=" : ">=", value: rule === "stop_loss" ? -value : value },
          message: RULE_MESSAGE[rule](value),
          source: "owner",
          rule,
          ruleValue: value,
        });
      }
    },
    setPaused: (p) => (paused = p),
    paused: () => paused,
    due(at = now()) {
      if (paused) return [];
      const out: Due[] = [];
      const stamp = iso(at);
      const replay = `paper trading, replay date ${clockDate()}`;
      for (const s of schedules) {
        if (!s.active || s.needsChat) continue;
        // A repeating price watch or rule waits out its period after it fired.
        if (s.kind === "price" && s.nextRunAt && Date.parse(s.nextRunAt) > at) continue;
        let context = "";
        const c = s.condition;
        if (c && "portfolio" in c) {
          const t = totals(s.agentName);
          if (t.invested <= 0) continue;
          const pnl = c.portfolio === "unrealizedPnl";
          const v = pnl ? t.pnl : t.pct;
          s.lastObserved = pnl ? `unrealized ${t.pnl < 0 ? "−" : "+"}${usd(t.pnl)} · ${clockDate()}` : `portfolio ${t.pct < 0 ? "−" : "+"}${Math.abs(t.pct).toFixed(1)}% · ${clockDate()}`;
          if (!(c.op === ">=" ? v >= c.value : v <= c.value)) continue;
          context = pnl
            ? `Your unrealized profit is ${usd(t.pnl)} (≥ ${usd(c.value)}) · ${replay}.`
            : `Your portfolio is ${t.pct < 0 ? "down" : "up"} ${Math.abs(t.pct).toFixed(1)}% (${c.op === "<=" ? "≤" : "≥"} ${c.value > 0 ? "+" : "−"}${Math.abs(c.value)}%) · ${replay}.`;
        } else if (c && "price" in c) {
          const p = price(c.ticker);
          s.lastObserved = `${c.ticker} $${p.toFixed(2)} · ${clockDate()}`;
          if (!(c.op === ">=" ? p >= c.price : p <= c.price)) continue;
          context = `${c.ticker} is $${p.toFixed(2)} (${c.op === ">=" ? "≥" : "≤"} $${c.price}) · ${replay}.`;
        } else {
          const when = s.kind === "at" ? s.at : s.nextRunAt;
          if (!when || Date.parse(when) > at) continue;
          context = `${replay}.`;
        }
        const firing = recordFiring(s, stamp, context);
        if (s.everyMinutes) s.nextRunAt = iso(at + s.everyMinutes * 60_000);
        else end(s, "fired");
        out.push({ schedule: s, firing });
      }
      return out;
    },
    recordFiring,
    end,
  };
}
