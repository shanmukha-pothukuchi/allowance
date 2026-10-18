/**
 * The mock's paper brokerage and scheduler (§20), for `?mock=1`: a replay clock over made-up daily
 * closes (seeded, so screenshots agree), positions per agent with average cost and realized P/L,
 * schedules and owner rules with the scheduler's limits, and the autonomy switch. Money stays in
 * the mock wallet (mockAdapter.ts): this module only says what a trade or a firing is, and the
 * wallet side emits the receipts and events.
 */
import { fromCents, toCents } from "../format";
import type { AgentPortfolio, AgentRules, Firing, Portfolios, RuleKind, Schedule, SchedulerState } from "../invest";
import { scheduleLabel } from "../invest";
import { HttpError } from "./adapter";

export const MOCK_REPLAY_FROM = "2024-11-01";

/** The tickers the mock quotes, at levels like their real ones (the closes themselves are made up). */
export const MOCK_TICKERS: { ticker: string; name: string; start: number; drift: number; vol: number }[] = [
  { ticker: "COF", name: "Capital One", start: 212.4, drift: 0.0006, vol: 0.016 },
  { ticker: "JPM", name: "JPMorgan Chase", start: 238.1, drift: 0.0005, vol: 0.012 },
  { ticker: "NVDA", name: "NVIDIA", start: 135.4, drift: 0.0012, vol: 0.028 },
  { ticker: "AAPL", name: "Apple", start: 222.9, drift: 0.0004, vol: 0.013 },
  { ticker: "SPY", name: "SPDR S&P 500 ETF", start: 571.0, drift: 0.0004, vol: 0.008 },
];
/** COF's first replay days are fixed so the story reads the same every time: up 6.2% by day 3, then a slide. */
const COF_PATH = [1, 1.012, 1.034, 1.062, 1.056, 1.048, 1.041, 1.036, 1.03, 1.024, 1.016, 1.006, 0.999, 0.991, 0.985, 0.988];

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

type Lot = { shares: number; cost: number };

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

export interface MarketOptions {
  seed?: number;
  /** Trading day the clock starts on (index into the replay). */
  startDay?: number;
  now?: () => number;
}

export interface MockMarket {
  readonly replayFrom: string;
  clockDate(): string;
  day(): number;
  /** One trading day forward. */
  advance(): void;
  price(ticker: string): number;
  buy(agentName: string, ticker: string, amount: string): BuyFill;
  sell(agentName: string, ticker: string, shares?: number | "all"): SellFill;
  portfolios(names?: Map<string, { id: string; address: string }>): Portfolios;
  portfolioOf(agentName: string): AgentPortfolio;
  realized(agentName: string): number;
  scheduler(): SchedulerState;
  addSchedule(s: Omit<Schedule, "id" | "createdAt" | "fired" | "active"> & Partial<Pick<Schedule, "fired" | "active" | "createdAt" | "lastFiredAt">>): Schedule;
  cancel(id: string): void;
  setRules(agentName: string, rules: AgentRules): void;
  setPaused(paused: boolean): boolean;
  paused(): boolean;
  /** The schedules that fire now (and their firings recorded). The caller makes the agent react. */
  due(now?: number): { schedule: Schedule; firing: Firing; ticker?: string }[];
  recordFiring(s: Schedule, at: string, label?: string): Firing;
}

const RULE_MESSAGE: Record<RuleKind, (v: string) => string> = {
  take_profit: (v) => `Owner rule (take profit at +${v}%): a position is up ${v}% or more. Sell it.`,
  stop_loss: (v) => `Owner rule (stop loss at −${v}%): a position is down ${v}% or more from its average cost. Sell it.`,
  cash_out: (v) => `Owner rule (cash out profits above $${v}): realized profits passed $${v}. Cash them out to the owner.`,
};

export function createMockMarket(opts: MarketOptions = {}): MockMarket {
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
  let day = opts.startDay ?? 0;
  let paused = false;
  let seq = 0;
  const lots = new Map<string, Map<string, Lot>>();
  const realized = new Map<string, number>();
  const schedules: Schedule[] = [];
  const firings: Firing[] = [];
  const iso = () => new Date(now()).toISOString();

  const price = (ticker: string) => {
    const s = closes.get(ticker.toUpperCase());
    if (!s) throw new HttpError(`No quotes for ${ticker}. The brokerage trades ${MOCK_TICKERS.map((t) => t.ticker).join(", ")}.`, 404, "unknown_ticker");
    return s[Math.min(day, s.length - 1)];
  };
  const book = (agent: string) => {
    let b = lots.get(agent);
    if (!b) lots.set(agent, (b = new Map()));
    return b;
  };

  function portfolioOf(agentName: string): AgentPortfolio {
    const positions = [...book(agentName).entries()]
      .filter(([, l]) => l.shares > 1e-9)
      .map(([ticker, l]) => {
        const p = price(ticker);
        const value = l.shares * p;
        const pnl = value - l.cost;
        return {
          ticker,
          name: MOCK_TICKERS.find((t) => t.ticker === ticker)?.name,
          shares: Math.round(l.shares * 1e6) / 1e6,
          avgCost: fromCents(Math.round((l.cost / l.shares) * 100)),
          price: fromCents(Math.round(p * 100)),
          value: fromCents(Math.round(value * 100)),
          unrealizedPnl: signed(pnl),
          unrealizedPct: Math.round((pnl / l.cost) * 10000) / 100,
        };
      })
      .sort((a, b) => Number(b.value) - Number(a.value));
    const invested = positions.reduce((s, p) => s + p.shares * Number(p.avgCost), 0);
    const value = positions.reduce((s, p) => s + Number(p.value), 0);
    return {
      agentName,
      positions,
      totals: { invested: fromCents(Math.round(invested * 100)), value: fromCents(Math.round(value * 100)), unrealizedPnl: signed(value - invested), realizedPnl: signed(realized.get(agentName) ?? 0) },
    };
  }

  function ruleValueOf(s: Schedule): number {
    return Number(s.ruleValue ?? 0);
  }

  function recordFiring(s: Schedule, at: string, label?: string): Firing {
    s.fired += 1;
    s.lastFiredAt = at;
    const f: Firing = { id: `fire_${(++seq).toString(36)}`, scheduleId: s.id, agentName: s.agentName, source: s.source, at, label: label ?? scheduleLabel(s), ...(s.rule ? { rule: s.rule } : {}) };
    firings.unshift(f);
    if (firings.length > 50) firings.length = 50;
    return f;
  }

  const market: MockMarket = {
    replayFrom: MOCK_REPLAY_FROM,
    clockDate: () => days[Math.min(day, days.length - 1)],
    day: () => day,
    advance: () => {
      if (day < days.length - 1) day++;
    },
    price,
    buy(agentName, ticker, amount) {
      const t = ticker.toUpperCase();
      const p = price(t);
      const cents = toCents(amount);
      if (cents < 100) throw new HttpError("The smallest order is $1.00.", 400, "invalid_request");
      const sh = cents / 100 / p;
      const l = book(agentName).get(t) ?? { shares: 0, cost: 0 };
      book(agentName).set(t, { shares: l.shares + sh, cost: l.cost + cents / 100 });
      return { ticker: t, shares: sh, price: p, amount: fromCents(cents), clockDate: market.clockDate() };
    },
    sell(agentName, ticker, shares = "all") {
      const t = ticker.toUpperCase();
      const l = book(agentName).get(t);
      if (!l || l.shares <= 1e-9) throw new HttpError(`${agentName} holds no ${t}.`, 404, "no_position");
      const sh = shares === "all" ? l.shares : Math.min(shares, l.shares);
      const p = price(t);
      const basis = (l.cost / l.shares) * sh;
      const proceeds = Math.round(sh * p * 100) / 100;
      const pnl = proceeds - basis;
      l.shares -= sh;
      l.cost -= basis;
      if (l.shares <= 1e-9) book(agentName).delete(t);
      realized.set(agentName, (realized.get(agentName) ?? 0) + pnl);
      return { ticker: t, shares: sh, price: p, proceeds: fromCents(Math.round(proceeds * 100)), costBasis: fromCents(Math.round(basis * 100)), realizedPnl: signed(pnl), clockDate: market.clockDate() };
    },
    portfolios(names) {
      const agents = new Set([...lots.keys(), ...realized.keys()]);
      return {
        brokerage: { mode: "replay", clockDate: market.clockDate(), replayFrom: MOCK_REPLAY_FROM },
        portfolios: [...agents]
          .map((n) => {
            const p = portfolioOf(n);
            const who = names?.get(n);
            return who ? { ...p, agentId: who.id, address: who.address } : p;
          })
          .filter((p) => p.positions.length > 0 || Math.abs(Number(p.totals.realizedPnl)) >= 0.005),
      };
    },
    portfolioOf,
    realized: (n) => realized.get(n) ?? 0,
    scheduler: () => ({ paused, schedules: schedules.map((s) => ({ ...s, ...(s.condition ? { condition: { ...s.condition } } : {}) })), firings: firings.map((f) => ({ ...f })) }),
    addSchedule(s) {
      const active = schedules.filter((x) => x.agentName === s.agentName && x.active).length;
      if (active >= 10) throw new HttpError(`${s.agentName} already has 10 active schedules, the most an agent can have.`, 400, "too_many_schedules");
      if (s.kind === "every" && (s.everyMinutes ?? 0) < 1) throw new HttpError("A repeating schedule runs at most once a minute.", 400, "invalid_request");
      const full: Schedule = { fired: 0, active: true, createdAt: iso(), ...s, id: `sch_${(++seq).toString(36).padStart(4, "0")}` };
      schedules.push(full);
      return full;
    },
    cancel(id) {
      const s = schedules.find((x) => x.id === id);
      if (!s) throw new HttpError("No such schedule.", 404, "schedule_not_found");
      s.active = false;
      s.nextRunAt = undefined;
    },
    setRules(agentName, rules) {
      const want: [RuleKind, string | undefined][] = [
        ["take_profit", rules.takeProfitPct],
        ["stop_loss", rules.stopLossPct],
        ["cash_out", rules.cashOutAbove ? String(Number(rules.cashOutAbove)) : undefined],
      ];
      for (const [rule, value] of want) {
        const cur = schedules.find((x) => x.agentName === agentName && x.source === "owner" && x.rule === rule && x.active);
        if (cur && (!value || Number(cur.ruleValue) !== Number(value))) cur.active = false;
        if (!value || (cur && Number(cur.ruleValue) === Number(value))) continue;
        market.addSchedule({
          agentName,
          kind: "price",
          condition: rule === "cash_out" ? { portfolio: "realizedPnl", op: ">=", value: Number(value) } : { portfolio: "unrealizedPct", op: rule === "stop_loss" ? "<=" : ">=", value: rule === "stop_loss" ? -Number(value) : Number(value) },
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
      const out: { schedule: Schedule; firing: Firing; ticker?: string }[] = [];
      const stamp = new Date(at).toISOString();
      for (const s of schedules) {
        if (!s.active || s.needsChat) continue;
        let fire = false;
        let ticker: string | undefined;
        let label: string | undefined;
        const c = s.condition;
        if (s.rule) {
          const p = portfolioOf(s.agentName);
          const v = ruleValueOf(s);
          if (s.rule === "cash_out") fire = (realized.get(s.agentName) ?? 0) >= v;
          else {
            const hit = p.positions.find((x) => (s.rule === "stop_loss" ? x.unrealizedPct <= -v : x.unrealizedPct >= v));
            if (hit) {
              fire = true;
              ticker = hit.ticker;
              label = `${s.rule === "stop_loss" ? "stop loss" : "take profit"} on ${hit.ticker}`;
            }
          }
        } else if (c && "ticker" in c && "price" in c) {
          const p = price(c.ticker);
          fire = c.op === ">=" ? p >= c.price : p <= c.price;
          ticker = c.ticker;
        } else if (s.kind === "every" && s.nextRunAt) fire = Date.parse(s.nextRunAt) <= at;
        else if (s.kind === "at" && s.at) fire = Date.parse(s.at) <= at;
        if (!fire) continue;
        const firing = recordFiring(s, stamp, label);
        if (s.kind === "every" && s.everyMinutes) s.nextRunAt = new Date(at + s.everyMinutes * 60_000).toISOString();
        else s.active = false;
        out.push({ schedule: s, firing, ...(ticker ? { ticker } : {}) });
      }
      return out;
    },
    recordFiring,
  };
  return market;
}

function signed(dollars: number): string {
  const c = Math.round(dollars * 100);
  return c < 0 ? `-${fromCents(-c)}` : fromCents(c);
}
