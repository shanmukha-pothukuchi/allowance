/**
 * Paper investing, cash out and schedules (§20), the dashboard's pure part: the shapes the
 * brokerage and the scheduler answer with, read tolerantly; the figures, said once; and the
 * Linear lines for trades, cash-outs and firings. No React here; unit-tested in invest.test.ts.
 */
import { fromCents, money, toCents } from "./format";
import type { Line } from "./lines";
import type { Receipt } from "./types";

// ---------------------------------------------------------------------------- shapes

export interface Position {
  ticker: string;
  name?: string;
  shares: number;
  avgCost: string;
  price: string;
  value: string;
  unrealizedPnl: string;
  /** Percent, e.g. 6.2 for +6.2%. */
  unrealizedPct: number;
}

export interface PortfolioTotals {
  invested: string;
  value: string;
  unrealizedPnl: string;
  realizedPnl: string;
}

export interface AgentPortfolio {
  agentId?: string;
  agentName: string;
  address?: string;
  positions: Position[];
  totals: PortfolioTotals;
}

export interface BrokerageInfo {
  /** "replay" (real closes replayed fast) or "live" (latest close). */
  mode: string;
  /** The replay clock's trading day, YYYY-MM-DD. */
  clockDate: string;
  /** Where the replay started, YYYY-MM-DD. */
  replayFrom?: string;
  note?: string;
}

export interface Portfolios {
  brokerage: BrokerageInfo;
  portfolios: AgentPortfolio[];
}

export type ScheduleKind = "at" | "every" | "price";
export type PriceCondition = { ticker: string; op: ">=" | "<="; price: number };
export type MoveCondition = { ticker: string; movePct: number };
export type PortfolioCondition = { portfolio: string; op: ">=" | "<="; value: number };
export type ScheduleCondition = PriceCondition | MoveCondition | PortfolioCondition;
export type RuleKind = "take_profit" | "stop_loss" | "cash_out";

export interface Schedule {
  id: string;
  agentName: string;
  kind: ScheduleKind;
  at?: string;
  everyMinutes?: number;
  condition?: ScheduleCondition;
  message: string;
  source: "agent" | "owner";
  createdAt: string;
  nextRunAt?: string;
  lastFiredAt?: string;
  fired: number;
  expiresAt?: string;
  active: boolean;
  /** An owner rule (§20.3): which one, and its number (a percent, or dollars for cash out). */
  rule?: RuleKind;
  ruleValue?: string;
  /** Its agent has no chat server to wake (Claude Desktop): listed, but it can't fire. */
  needsChat?: boolean;
}

/** One time a schedule woke its agent. */
export interface Firing {
  id: string;
  scheduleId?: string;
  agentName: string;
  source: "agent" | "owner";
  at: string;
  /** What it was about, in a few words: "stop loss on COF", "check COF". */
  label: string;
  rule?: RuleKind;
}

export interface SchedulerState {
  paused: boolean;
  schedules: Schedule[];
  firings: Firing[];
}

/** The three owner rules for one agent (§20.3). Empty: off. Percent as typed ("5"), dollars as "25.00". */
export interface AgentRules {
  takeProfitPct?: string;
  stopLossPct?: string;
  cashOutAbove?: string;
}

// ---------------------------------------------------------------------------- tolerant reading

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
export const num = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[$,%+\s]/g, "").replace(/^−/, "-");
  if (!s || !/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
/** Any dollar figure → "12.34" (negative keeps its sign). */
const dollars = (v: unknown): string => {
  const n = num(v);
  if (n === null) return "0.00";
  const c = Math.round(n * 100);
  return c < 0 ? `-${fromCents(-c)}` : fromCents(c);
};
const ymd = (v: unknown): string => {
  const s = str(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function normPosition(raw: unknown): Position | null {
  const p = obj(raw);
  if (!p) return null;
  const ticker = str(p.ticker ?? p.symbol).trim().toUpperCase();
  if (!ticker) return null;
  const shares = num(p.shares ?? p.qty ?? p.quantity) ?? 0;
  const price = num(p.price ?? p.lastPrice) ?? 0;
  const avg = num(p.avgCost ?? p.averageCost ?? p.costPerShare) ?? 0;
  const value = num(p.value ?? p.marketValue) ?? shares * price;
  const cost = num(p.costBasis) ?? shares * avg;
  const pnl = num(p.unrealizedPnl ?? p.pnl) ?? value - cost;
  const pct = num(p.unrealizedPct ?? p.pnlPct) ?? (cost > 0 ? (pnl / cost) * 100 : 0);
  return {
    ticker,
    ...(str(p.name) ? { name: str(p.name) } : {}),
    shares,
    avgCost: dollars(avg),
    price: dollars(price),
    value: dollars(value),
    unrealizedPnl: dollars(pnl),
    unrealizedPct: Math.round(pct * 100) / 100,
  };
}

function totalsOf(raw: unknown, positions: Position[]): PortfolioTotals {
  const t = obj(raw) ?? {};
  const sum = (f: (p: Position) => string) => positions.reduce((s, p) => s + toSignedCents(f(p)), 0);
  const invested = num(t.invested ?? t.costBasis) ?? positions.reduce((s, p) => s + p.shares * Number(p.avgCost), 0);
  return {
    invested: dollars(invested),
    value: t.value !== undefined ? dollars(t.value) : centsToDollars(sum((p) => p.value)),
    unrealizedPnl: t.unrealizedPnl !== undefined ? dollars(t.unrealizedPnl) : centsToDollars(sum((p) => p.unrealizedPnl)),
    realizedPnl: dollars(t.realizedPnl ?? t.realized ?? 0),
  };
}

/** One agent's portfolio, from `GET /brokerage/portfolio` or one entry of the owner's list. */
export function normPortfolio(raw: unknown, fallbackName = ""): AgentPortfolio | null {
  const p = obj(raw);
  if (!p) return null;
  const agent = obj(p.agent);
  const agentName = str(p.agentName ?? p.name ?? agent?.name).trim() || fallbackName;
  if (!agentName) return null;
  const positions = arr(p.positions)
    .map(normPosition)
    .filter((x): x is Position => !!x && x.shares > 0);
  const agentId = str(p.agentId ?? agent?.id);
  const address = str(p.address ?? p.wallet ?? agent?.address);
  return {
    ...(agentId ? { agentId } : {}),
    agentName,
    ...(address ? { address } : {}),
    positions,
    totals: totalsOf(p.totals, positions),
  };
}

/**
 * The owner's view of the brokerage: `{ clockDate, mode, portfolios: [...] }`, or a bare array, or
 * a map of agent name → portfolio. Agents without positions or realized P/L are dropped.
 */
export function normPortfolios(raw: unknown, info?: unknown): Portfolios {
  const o = obj(raw);
  const i = obj(info) ?? o ?? {};
  const list: AgentPortfolio[] = [];
  const src = Array.isArray(raw) ? raw : o && Array.isArray(o.portfolios) ? o.portfolios : o && Array.isArray(o.agents) ? o.agents : null;
  if (src) for (const p of src) {
    const n = normPortfolio(p);
    if (n) list.push(n);
  }
  else if (o && obj(o.portfolios)) for (const [name, p] of Object.entries(o.portfolios as Obj)) {
    const n = normPortfolio(p, name);
    if (n) list.push(n);
  }
  const clockDate = ymd(i.clockDate ?? o?.clockDate);
  return {
    brokerage: {
      mode: str(i.mode ?? o?.mode) || "replay",
      clockDate,
      ...(ymd(i.replayFrom ?? i.from ?? i.startDate ?? o?.replayFrom) ? { replayFrom: ymd(i.replayFrom ?? i.from ?? i.startDate ?? o?.replayFrom) } : {}),
      ...(str(i.note) ? { note: str(i.note) } : {}),
    },
    portfolios: list.filter((p) => p.positions.length > 0 || toSignedCents(p.totals.realizedPnl) !== 0),
  };
}

const RULES: RuleKind[] = ["take_profit", "stop_loss", "cash_out"];
function ruleOf(s: Obj, message: string): RuleKind | undefined {
  const r = str(s.rule ?? s.ruleKind ?? obj(s.rule)?.kind).toLowerCase().replace(/[\s-]+/g, "_");
  if ((RULES as string[]).includes(r)) return r as RuleKind;
  if (/^cash_?out/.test(r)) return "cash_out";
  if (str(s.source) !== "owner") return undefined;
  if (/take[\s-]?profit/i.test(message)) return "take_profit";
  if (/stop[\s-]?loss/i.test(message)) return "stop_loss";
  if (/cash(?:\s|-)?out/i.test(message)) return "cash_out";
  return undefined;
}

function conditionOf(raw: unknown): ScheduleCondition | undefined {
  const c = obj(raw);
  if (!c) return undefined;
  const op = (c.op === "<=" || c.op === "below" ? "<=" : ">=") as ">=" | "<=";
  if (str(c.portfolio)) {
    const value = num(c.value);
    return value === null ? undefined : { portfolio: str(c.portfolio), op, value };
  }
  const ticker = str(c.ticker).trim().toUpperCase();
  if (!ticker) return undefined;
  const move = num(c.movePct ?? c.move_pct);
  if (move !== null) return { ticker, movePct: move };
  const above = num(c.above);
  const below = num(c.below);
  if (above !== null) return { ticker, op: ">=", price: above };
  if (below !== null) return { ticker, op: "<=", price: below };
  const price = num(c.price);
  return price === null ? undefined : { ticker, op, price };
}

export function normSchedule(raw: unknown): Schedule | null {
  const s = obj(raw);
  if (!s) return null;
  const id = str(s.id).trim();
  const agentName = str(s.agentName ?? s.agent).trim();
  if (!id || !agentName) return null;
  const message = str(s.message ?? s.text).trim();
  const kindRaw = str(s.kind);
  const condition = conditionOf(s.condition ?? s.when);
  const kind: ScheduleKind = kindRaw === "at" || kindRaw === "every" || kindRaw === "price" ? kindRaw : condition ? "price" : num(s.everyMinutes) ? "every" : "at";
  const rule = ruleOf(s, message);
  const ruleValue = str(s.ruleValue ?? s.threshold ?? obj(s.rule)?.value);
  const every = num(s.everyMinutes ?? s.every_minutes);
  return {
    id,
    agentName,
    kind,
    ...(str(s.at) ? { at: str(s.at) } : {}),
    ...(every !== null ? { everyMinutes: every } : {}),
    ...(condition ? { condition } : {}),
    message,
    source: s.source === "owner" ? "owner" : "agent",
    createdAt: str(s.createdAt) || new Date(0).toISOString(),
    ...(str(s.nextRunAt) ? { nextRunAt: str(s.nextRunAt) } : {}),
    ...(str(s.lastFiredAt) ? { lastFiredAt: str(s.lastFiredAt) } : {}),
    fired: num(s.fired ?? s.firedCount) ?? 0,
    ...(str(s.expiresAt) ? { expiresAt: str(s.expiresAt) } : {}),
    active: s.active !== false,
    ...(rule ? { rule } : {}),
    ...(ruleValue ? { ruleValue } : {}),
    ...(s.needsChat === true || s.reachable === false ? { needsChat: true } : {}),
  };
}

function normFiring(raw: unknown, byId: Map<string, Schedule>): Firing | null {
  const f = obj(raw);
  if (!f) return null;
  const sched = byId.get(str(f.scheduleId));
  const agentName = str(f.agentName ?? sched?.agentName).trim();
  const at = str(f.at ?? f.firedAt);
  if (!agentName || !at) return null;
  const source = f.source === "owner" || sched?.source === "owner" ? "owner" : "agent";
  const rule = sched?.rule ?? ruleOf(f, str(f.label ?? f.message));
  return {
    id: str(f.id) || `${str(f.scheduleId)}:${at}`,
    ...(str(f.scheduleId) ? { scheduleId: str(f.scheduleId) } : {}),
    agentName,
    source,
    at,
    label: str(f.label).trim() || (sched ? scheduleLabel(sched) : firstLine(str(f.message ?? f.text))),
    ...(rule ? { rule } : {}),
  };
}

/**
 * `GET /schedules` (owner): `{ paused, schedules, firings? }` or a bare array. Without a firings
 * log, each schedule's last firing stands in for it.
 */
export function normScheduler(raw: unknown, status?: unknown): SchedulerState {
  const o = obj(raw);
  const st = obj(status) ?? o ?? {};
  const schedules = (Array.isArray(raw) ? raw : arr(o?.schedules)).map(normSchedule).filter((x): x is Schedule => !!x);
  const byId = new Map(schedules.map((s) => [s.id, s]));
  let firings = arr(o?.firings ?? o?.history).map((f) => normFiring(f, byId)).filter((x): x is Firing => !!x);
  if (!o || !Array.isArray(o.firings ?? o.history)) {
    firings = schedules
      .filter((s) => s.lastFiredAt)
      .map((s) => ({ id: `${s.id}:${s.lastFiredAt}`, scheduleId: s.id, agentName: s.agentName, source: s.source, at: s.lastFiredAt!, label: scheduleLabel(s), ...(s.rule ? { rule: s.rule } : {}) }));
  }
  firings.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { paused: st.paused === true || st.state === "paused", schedules, firings };
}

// ---------------------------------------------------------------------------- figures

const toSignedCents = (amount: string | number | undefined | null): number => {
  const n = num(amount ?? "");
  return n === null ? 0 : Math.round(n * 100);
};
const centsToDollars = (c: number): string => (c < 0 ? `-${fromCents(-c)}` : fromCents(c));

/** "+$6.20", "−$3.10", "$0.00". The minus is a real minus sign, like the feed's amounts. */
export function signedMoney(amount: string | number): string {
  const c = toSignedCents(amount);
  if (c === 0) return "$0.00";
  return `${c > 0 ? "+" : "−"}${money(fromCents(Math.abs(c)))}`;
}

/** "+6.2%", "−3.1%", "0.0%". */
export function signedPct(pct: number): string {
  const r = Math.round(pct * 10) / 10;
  if (r === 0) return "0.0%";
  return `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}%`;
}

/** The tone of a P/L figure: green up, red down, quiet at zero (rule 7: colour only for money signs). */
export function pnlTone(amount: string | number): "in" | "neg" | "flat" {
  const c = toSignedCents(amount);
  return c > 0 ? "in" : c < 0 ? "neg" : "flat";
}

/** Fractional shares: "0.47", "12.50", "0.0047" (tiny lots keep enough digits to be non-zero). */
export function shares(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  if (n >= 0.01) return n.toFixed(2);
  return n.toPrecision(2);
}

/** "2025-11-03" → "Nov 3, 2025". */
export function tradingDay(date: string | undefined): string {
  const d = ymd(date);
  if (!d) return "";
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** The honesty line (§20): "Paper trading · replay of real closes from Nov 1, 2024 · not investment advice". */
export function paperLine(b: Pick<BrokerageInfo, "mode" | "replayFrom"> | undefined): string {
  const from = tradingDay(b?.replayFrom);
  const middle = b?.mode === "live" ? "latest real closes" : from ? `replay of real closes from ${from}` : "replay of real closes";
  return `Paper trading · ${middle} · not investment advice`;
}

export interface PortfolioSum {
  value: string;
  invested: string;
  unrealizedPnl: string;
  unrealizedPct: number;
  realizedPnl: string;
  positions: number;
}

/** Totals across agents (or for one). */
export function sumPortfolios(list: AgentPortfolio[]): PortfolioSum {
  let value = 0;
  let invested = 0;
  let pnl = 0;
  let realized = 0;
  let positions = 0;
  for (const p of list) {
    value += toSignedCents(p.totals.value);
    invested += toSignedCents(p.totals.invested);
    pnl += toSignedCents(p.totals.unrealizedPnl);
    realized += toSignedCents(p.totals.realizedPnl);
    positions += p.positions.length;
  }
  return {
    value: centsToDollars(value),
    invested: centsToDollars(invested),
    unrealizedPnl: centsToDollars(pnl),
    unrealizedPct: invested > 0 ? Math.round((pnl / invested) * 1000) / 10 : 0,
    realizedPnl: centsToDollars(realized),
    positions,
  };
}

// ---------------------------------------------------------------------------- schedules in words

const opSign = (op: ">=" | "<=") => (op === ">=" ? "≥" : "≤");

/** The trigger, said once: "COF ≥ $210.00", "COF moves 5%", "Portfolio up 10%", "Every 30 min", "Once". */
export function scheduleTrigger(s: Pick<Schedule, "kind" | "condition" | "everyMinutes" | "at">, now = Date.now()): string {
  const c = s.condition;
  if (c && "ticker" in c && "price" in c) return `${c.ticker} ${opSign(c.op)} ${money(c.price)}`;
  if (c && "ticker" in c && "movePct" in c) return `${c.ticker} moves ${Math.abs(c.movePct)}%`;
  if (c && "portfolio" in c) {
    const v = c.value;
    const what = /realized/i.test(c.portfolio) && !/unrealized/i.test(c.portfolio) ? "Realized P/L" : "Portfolio";
    if (what === "Realized P/L") return `${what} ${opSign(c.op)} ${money(v)}`;
    return `${what} ${v >= 0 ? "up" : "down"} ${Math.abs(v)}%`;
  }
  if (s.kind === "every" && s.everyMinutes) return `Every ${everyText(s.everyMinutes)}`;
  if (s.kind === "at" && s.at) return whenText(s.at, now);
  return "Once";
}

/** 1 → "minute", 30 → "30 min", 60 → "hour", 90 → "90 min", 1440 → "day". */
export function everyText(minutes: number): string {
  if (minutes === 1) return "minute";
  if (minutes === 60) return "hour";
  if (minutes === 1440) return "day";
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} min`;
}

/** "in 12m", "in 3h", "Tomorrow 9:00 AM", "Oct 21, 9:00 AM"; past: "due now". */
export function whenText(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.round((t - now) / 1000);
  if (s <= 30) return "due now";
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`;
  if (s < 6 * 3600) return `in ${Math.round(s / 3600)}h`;
  const d = new Date(t);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const day = (x: number) => new Date(new Date(x).toDateString()).getTime();
  const diff = Math.round((day(t) - day(now)) / 86_400_000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

/** What happens next, without repeating the trigger: "next in 12m", "fires once", "repeats". */
export function scheduleNext(s: Pick<Schedule, "kind" | "nextRunAt" | "everyMinutes" | "active" | "needsChat" | "condition">, now = Date.now()): string {
  if (!s.active) return "";
  if (s.needsChat) return "Needs the chat";
  if (s.kind === "price" || s.condition) return s.everyMinutes ? "repeats" : "fires once";
  if (s.kind === "every") return s.nextRunAt ? `next ${whenText(s.nextRunAt, now)}` : "";
  return "";
}

const RULE_LABEL: Record<RuleKind, string> = { take_profit: "Take profit", stop_loss: "Stop loss", cash_out: "Cash out profits" };

/** A rule's name and threshold: "Stop loss at −5%", "Take profit at +10%", "Cash out profits above $25". */
export function ruleTitle(rule: RuleKind, value?: string): string {
  const v = num(value ?? "");
  if (v === null) return RULE_LABEL[rule];
  if (rule === "cash_out") return `${RULE_LABEL[rule]} above ${money(v).replace(/\.00$/, "")}`;
  return `${RULE_LABEL[rule]} at ${rule === "stop_loss" ? "−" : "+"}${Math.abs(v)}%`;
}

/** A rule's threshold, from its own field or its condition. */
function ruleNumber(s: Pick<Schedule, "rule" | "ruleValue" | "condition">): string | undefined {
  if (s.ruleValue && num(s.ruleValue) !== null) return String(Math.abs(num(s.ruleValue)!));
  const c = s.condition;
  if (c && "portfolio" in c) return String(Math.abs(c.value));
  if (c && "movePct" in c) return String(Math.abs(c.movePct));
  return undefined;
}

/** The row's title: an owner rule by name, else the agent's own words. */
export function scheduleTitle(s: Pick<Schedule, "rule" | "ruleValue" | "condition" | "message">): string {
  if (s.rule) return ruleTitle(s.rule, ruleNumber(s));
  return firstLine(s.message) || "Reminder";
}

/** A few words for a firing line: "stop loss on COF", "check COF". */
export function scheduleLabel(s: Pick<Schedule, "rule" | "condition" | "message">): string {
  if (s.rule) {
    const c = s.condition;
    const on = c && "ticker" in c ? ` on ${c.ticker}` : "";
    return `${RULE_LABEL[s.rule].toLowerCase()}${on}`;
  }
  return firstLine(s.message).replace(/[.!]$/, "") || "a reminder";
}

/** The owner's rules for one agent, read back from its active owner schedules. */
export function rulesFor(schedules: Schedule[], agentName: string): AgentRules {
  const out: AgentRules = {};
  for (const s of schedules) {
    if (s.agentName !== agentName || s.source !== "owner" || !s.active || !s.rule) continue;
    const v = ruleNumber(s);
    if (v === undefined) continue;
    if (s.rule === "take_profit") out.takeProfitPct = v;
    else if (s.rule === "stop_loss") out.stopLossPct = v;
    else out.cashOutAbove = fromCents(toCents(v));
  }
  return out;
}

export type RulesCheck = { ok: true; rules: AgentRules } | { ok: false; errors: Partial<Record<keyof AgentRules, string>> };

/** Validate the rule inputs (raw text). Empty is "off". Percent 0.1–100 (stop loss under 100), dollars 0.01–10,000. */
export function checkRules(raw: AgentRules): RulesCheck {
  const errors: Partial<Record<keyof AgentRules, string>> = {};
  const rules: AgentRules = {};
  const pct = (k: "takeProfitPct" | "stopLossPct", max: number) => {
    const s = (raw[k] ?? "").trim().replace(/%$/, "").replace(/^[+−-]/, "").trim();
    if (!s) return;
    const n = num(s);
    if (n === null || !/^\d+(\.\d)?$/.test(s)) errors[k] = "A percent like 5 or 7.5.";
    else if (n <= 0 || n > max) errors[k] = `Between 0.1 and ${max}.`;
    else rules[k] = String(n);
  };
  pct("takeProfitPct", 1000);
  pct("stopLossPct", 99);
  const c = (raw.cashOutAbove ?? "").trim().replace(/^\$/, "").replace(/,/g, "");
  if (c) {
    if (!/^\d+(\.\d{1,2})?$/.test(c)) errors.cashOutAbove = "A dollar amount like 25.";
    else if (toCents(c) < 1 || toCents(c) > 1_000_000) errors.cashOutAbove = "Between $0.01 and $10,000.";
    else rules.cashOutAbove = fromCents(toCents(c));
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, rules };
}

export const sameRules = (a: AgentRules, b: AgentRules) =>
  (a.takeProfitPct ?? "") === (b.takeProfitPct ?? "") && (a.stopLossPct ?? "") === (b.stopLossPct ?? "") && toCents(a.cashOutAbove ?? "0") === toCents(b.cashOutAbove ?? "0");

/** Active first (soonest next run first), then the rest newest first. */
export function sortSchedules(list: Schedule[]): Schedule[] {
  const next = (s: Schedule) => (s.nextRunAt ? Date.parse(s.nextRunAt) : Number.MAX_SAFE_INTEGER);
  return [...list].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.active) return next(a) - next(b) || a.agentName.localeCompare(b.agentName);
    return Date.parse(b.lastFiredAt ?? b.createdAt) - Date.parse(a.lastFiredAt ?? a.createdAt);
  });
}

// ---------------------------------------------------------------------------- lines

function firstLine(s: string): string {
  return (s ?? "").split("\n")[0].trim();
}

/** "**Rule** woke **researcher**: stop loss on COF", "**Reminder** woke **researcher**: check COF". */
export function firingLine(f: Pick<Firing, "source" | "agentName" | "label" | "rule">): Line {
  return { actor: f.source === "owner" || f.rule ? "Rule" : "Reminder", verb: "woke", object: f.agentName, tail: f.label ? `: ${f.label}` : "" };
}

const TICKER = "([A-Z][A-Z.]{0,5})";
const BUY_RE = new RegExp(`^(?:Buy|Bought)\\s+(?:(\\d*\\.?\\d+)\\s+(?:shares?\\s+(?:of\\s+)?)?)?(?:\\$[\\d,.]+\\s+(?:of|in)\\s+)?${TICKER}\\b`);
const SELL_RE = new RegExp(`^(?:Sell|Sold)\\s+(?:(\\d*\\.?\\d+|all)\\s+(?:shares?\\s+(?:of\\s+)?)?)?${TICKER}\\b`, "i");
const REALIZED_RE = /([+−-]?\$[\d,]+(?:\.\d+)?)\s+realized|realized(?: P\/L| pnl)?:?\s*([+−-]?\$[\d,]+(?:\.\d+)?)/i;

/** The brokerage is the payee (§20.1: "Allowance Brokerage (paper)", port 4110). */
export function isBrokerage(r: Pick<Receipt, "counterparty"> | undefined): boolean {
  const c = r?.counterparty;
  if (!c) return false;
  return /brokerage/i.test(c.name ?? "") || /:4110(?:\/|$)|\/brokerage(?:\/|$)/.test(c.origin ?? "");
}

export interface Trade {
  side: "buy" | "sell";
  ticker: string;
  shares?: string;
  /** "+$6.20" / "−$1.40", as the sell said it. */
  realized?: string;
}

/** A buy (a spend to the brokerage) or a sell (an earning "Sold 0.47 COF"), from a receipt. */
export function tradeOf(r: Pick<Receipt, "kind" | "description" | "counterparty"> | undefined): Trade | null {
  if (!r) return null;
  const d = (r.description ?? "").trim();
  if (r.kind === "earn" || r.kind === "transfer") {
    const m = d.match(SELL_RE);
    if (!m || (r.kind === "transfer" && !isBrokerage(r))) return null;
    const rz = d.match(REALIZED_RE);
    const realized = rz ? (rz[1] ?? rz[2]).replace(/^-/, "−") : undefined;
    return { side: "sell", ticker: m[2].toUpperCase(), ...(m[1] && m[1] !== "all" ? { shares: m[1] } : {}), ...(realized ? { realized: /^[+−]/.test(realized) ? realized : `+${realized}` } : {}) };
  }
  if (r.kind !== "spend") return null;
  const m = d.match(BUY_RE);
  if (m) return { side: "buy", ticker: m[2], ...(m[1] ? { shares: shares(Number(m[1])) } : {}) };
  if (!isBrokerage(r)) return null;
  const t = d.match(/\b([A-Z]{1,5})\b/);
  return t ? { side: "buy", ticker: t[1] } : null;
}

/** "researcher bought 0.47 COF", "researcher sold COF · +$6.20 realized". The amount sits in its column. */
export function tradeLine(agent: string, t: Trade, opts: { pending?: boolean } = {}): Line {
  if (t.side === "sell") return { actor: agent, verb: "sold", object: t.ticker, tail: t.realized ? ` · ${t.realized} realized` : "" };
  const what = t.shares ? `${t.shares} ${t.ticker}` : t.ticker;
  return opts.pending ? { actor: agent, verb: "is buying", object: what } : { actor: agent, verb: "bought", object: what };
}

/** "researcher cashed out $25.00 to Checking ••7688": the amount is the object, so it isn't repeated in the column. */
export function cashoutLine(agent: string, amount: string | undefined, checkingLast4?: string): Line {
  const to = checkingLast4 ? `Checking ••${checkingLast4.slice(-4)}` : "you";
  return { actor: agent, verb: "cashed out", object: amount ? money(amount) : "its balance", tail: ` to ${to}` };
}

// ---------------------------------------------------------------------------- cash out

export type CashoutChoice = "all" | string;

/** What a cash-out sends: "all" or a dollar string (validated against the balance). */
export function checkCashout(choice: CashoutChoice, custom: string, balance: string): { ok: true; amount: "all" | string } | { ok: false; message: string } {
  if (choice === "all") return toCents(balance) > 0 ? { ok: true, amount: "all" } : { ok: false, message: "Nothing to cash out." };
  const s = (choice === "custom" ? custom : choice).trim().replace(/^\$/, "").replace(/,/g, "");
  if (!s) return { ok: false, message: "Enter an amount." };
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(s)) return { ok: false, message: "Enter an amount like 20 or 12.50." };
  const c = toCents(s);
  if (c < 1) return { ok: false, message: "At least $0.01." };
  if (c > toCents(balance)) return { ok: false, message: `${money(balance)} is all there is.` };
  return { ok: true, amount: fromCents(c) };
}
