/**
 * The scheduler engine: validates and stores schedules, and on each tick fires the ones that are
 * due or whose price / portfolio condition holds, by posting a message to the agent's chat.
 *
 * Firing never spends anything: the woken agent acts through its tools and the wallet's policy.
 * Bounded autonomy (§20.3): 10 active schedules per agent, every ≥ 1 minute, price checks at most
 * every 10 s, 30 firings per agent per day, and the owner's pause switch stops everything.
 */
import { localDayKey, newId } from "@allowance/shared";
import type { ChatClient } from "./chat.js";
import { describeCondition, fmtEvery, fmtTime, money, opSymbol, pct, price, ruleLabel, ruleMessage, summarize } from "./format.js";
import { MarketError, type AgentRef, type MarketData, type Portfolio, type Quote, type QuotesResult } from "./market.js";
import type { ScheduleStore } from "./store.js";
import {
  DEFAULT_LIMITS,
  isMoveCondition,
  isPortfolioCondition,
  type Condition,
  type Limits,
  type Op,
  type OwnerRule,
  type RuleType,
  type Schedule,
  type ScheduleKind,
  type ScheduleSource,
} from "./types.js";

export class SchedulerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SchedulerError";
  }
}

export interface SchedulerOptions {
  store: ScheduleStore;
  chat: ChatClient;
  market: MarketData;
  /** Clock in ms (tests pass a fake one). */
  now?: () => number;
  log?: (msg: string) => void;
  limits?: Partial<Limits>;
  /** Retry delay while the agent is busy with another run. */
  busyRetryMs?: number;
  /** Retry delay when the chat server is down or refuses. */
  errorRetryMs?: number;
  /** A firing that can't be delivered for this long is given up. */
  maxPendingMs?: number;
  /** Default price-check interval (≥ limits.minCheckSeconds). */
  defaultCheckSeconds?: number;
  /** Owner rules re-fire at most this often while their condition holds. */
  ruleEveryMinutes?: number;
  /** Called after state changes are saved. */
  onChange?: () => void;
}

/** What an agent (or the owner, through createRule) sends to create a schedule. Validated here. */
export interface ScheduleInput {
  kind?: unknown;
  at?: unknown;
  inMinutes?: unknown;
  everyMinutes?: unknown;
  condition?: unknown;
  checkEverySeconds?: unknown;
  message?: unknown;
  expiresAt?: unknown;
  expiresInMinutes?: unknown;
}

export interface RuleInput {
  type?: unknown;
  value?: unknown;
  ticker?: unknown;
  everyMinutes?: unknown;
}

/** A schedule as the API returns it: the stored record plus a one-line summary. */
export type ScheduleView = Schedule & { summary: string; firesOnce: boolean };

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;
const KINDS = new Set<ScheduleKind>(["at", "every", "price"]);
const RULES = new Set<RuleType>(["take_profit", "stop_loss", "cash_out_profits"]);
const MAX_AHEAD_MS = 366 * 24 * 3600_000;
const MAX_EVERY_MINUTES = 30 * 24 * 60;

const iso = (ms: number) => new Date(ms).toISOString();
const bad = (message: string, code = "invalid_request") => new SchedulerError(400, code, message);

function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  return Number.isFinite(n) ? n : NaN;
}

/** Message text: control characters removed, trimmed. */
function cleanText(v: unknown): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim() : "";
}

function parseTicker(v: unknown): string {
  const t = typeof v === "string" ? v.trim().toUpperCase() : "";
  if (!TICKER_RE.test(t)) throw bad("A ticker is 1–10 letters, like COF.");
  return t;
}

function parseOp(v: unknown): Op {
  if (v === ">=" || v === "above" || v === ">") return ">=";
  if (v === "<=" || v === "below" || v === "<") return "<=";
  throw bad('op must be ">=" or "<=".');
}

/** Parses one of the three condition shapes of §20.3. */
export function parseCondition(raw: unknown): Condition {
  if (!raw || typeof raw !== "object") throw bad("A price schedule needs a condition: { ticker, op, price }, { ticker, movePct } or { portfolio, op, value }.");
  const c = raw as Record<string, unknown>;
  if (c.portfolio !== undefined) {
    if (c.portfolio !== "unrealizedPct" && c.portfolio !== "unrealizedPnl") throw bad('portfolio must be "unrealizedPct" or "unrealizedPnl".');
    const value = toNumber(c.value);
    if (value === undefined || Number.isNaN(value)) throw bad("A portfolio condition needs a numeric value.");
    return { portfolio: c.portfolio, op: parseOp(c.op), value, ...(c.ticker !== undefined ? { ticker: parseTicker(c.ticker) } : {}) };
  }
  const ticker = parseTicker(c.ticker);
  if (c.movePct !== undefined) {
    const movePct = toNumber(c.movePct);
    if (movePct === undefined || Number.isNaN(movePct) || movePct === 0 || Math.abs(movePct) > 100) throw bad("movePct must be a percent between −100 and 100, not 0 (5 = up 5%, −5 = down 5%).");
    return { ticker, movePct };
  }
  const p = toNumber(c.price);
  if (p === undefined || Number.isNaN(p) || p <= 0) throw bad("A price condition needs a price above $0.");
  return { ticker, op: parseOp(c.op), price: p };
}

const tickerOf = (c: Condition): string | undefined => c.ticker;

export class Scheduler {
  readonly limits: Limits;
  private readonly store: ScheduleStore;
  private readonly chat: ChatClient;
  private readonly market: MarketData;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly opts: SchedulerOptions;
  private ticking = false;
  private lastMarketAt = -Infinity;
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.store = opts.store;
    this.chat = opts.chat;
    this.market = opts.market;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[scheduler] ${m}`));
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  }

  private get state() {
    return this.store.state;
  }

  get paused(): boolean {
    return this.state.paused;
  }

  get pausedAt(): string | undefined {
    return this.state.pausedAt;
  }

  // ------------------------------------------------------------------ reading

  view(s: Schedule): ScheduleView {
    return { ...s, summary: summarize(s, this.now()), firesOnce: s.kind === "at" || (s.kind === "price" && !s.everyMinutes) };
  }

  get(id: string): Schedule | undefined {
    return this.state.schedules.find((s) => s.id === id);
  }

  /** Newest first. Ended schedules only when asked for. */
  list(filter: { agentName?: string; includeEnded?: boolean } = {}): Schedule[] {
    return this.state.schedules
      .filter((s) => (filter.agentName ? s.agentName === filter.agentName : true) && (filter.includeEnded || s.active))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  firingsToday(agentName: string): number {
    const f = this.state.firings[agentName];
    return f && f.day === localDayKey(new Date(this.now())) ? f.count : 0;
  }

  /** Firings today for every agent that fired today. */
  allFiringsToday(): Record<string, number> {
    const today = localDayKey(new Date(this.now()));
    return Object.fromEntries(Object.entries(this.state.firings).filter(([, f]) => f.day === today).map(([n, f]) => [n, f.count]));
  }

  // ------------------------------------------------------------------ creating

  /** Create a schedule. `agent` comes from the verified token (agent API) or the owner's lookup. */
  async create(agent: AgentRef, input: ScheduleInput, source: ScheduleSource = "agent", extra: { rule?: OwnerRule; replacing?: string } = {}): Promise<Schedule> {
    const now = this.now();
    const L = this.limits;
    const message = cleanText(input.message);
    if (!message) throw bad("Say what the reminder should tell the agent (message).");
    if (message.length > L.maxMessageChars) throw bad(`The message is too long: at most ${L.maxMessageChars} characters.`);

    const inMinutes = toNumber(input.inMinutes);
    const everyMinutes = toNumber(input.everyMinutes);
    const checkEverySeconds = toNumber(input.checkEverySeconds);
    if (Number.isNaN(inMinutes) || Number.isNaN(everyMinutes) || Number.isNaN(checkEverySeconds)) throw bad("inMinutes, everyMinutes and checkEverySeconds must be numbers.");

    let kind: ScheduleKind;
    if (input.kind !== undefined) {
      if (typeof input.kind !== "string" || !KINDS.has(input.kind as ScheduleKind)) throw bad('kind must be "at", "every" or "price".');
      kind = input.kind as ScheduleKind;
    } else if (input.condition !== undefined) kind = "price";
    else if (everyMinutes !== undefined) kind = "every";
    else if (input.at !== undefined || inMinutes !== undefined) kind = "at";
    else throw bad("Say when it should fire: at a time (at or inMinutes), every N minutes (everyMinutes), or when a price condition holds (condition).");

    let atMs: number | undefined;
    if (inMinutes !== undefined) {
      if (inMinutes <= 0) throw bad("inMinutes must be more than 0.");
      atMs = now + Math.round(inMinutes * 60_000);
    } else if (input.at !== undefined) {
      atMs = typeof input.at === "string" ? Date.parse(input.at) : NaN;
      if (Number.isNaN(atMs)) throw bad("at must be an ISO 8601 time, like 2026-10-18T18:05:00Z.");
    }
    if (atMs !== undefined) {
      if (atMs < now) throw bad(`That time has already passed (it is ${fmtTime(now, now)} now).`);
      if (atMs - now > MAX_AHEAD_MS) throw bad("Schedules can be set at most a year ahead.");
    }

    if (everyMinutes !== undefined) {
      if (everyMinutes < L.minEveryMinutes) throw bad(`Repeating schedules must be at least ${L.minEveryMinutes} minute${L.minEveryMinutes === 1 ? "" : "s"} apart.`, "limit_every");
      if (everyMinutes > MAX_EVERY_MINUTES) throw bad("Repeating schedules can be at most 30 days apart.");
    }

    let condition: Condition | undefined;
    let checkSeconds: number | undefined;
    if (kind === "at" && atMs === undefined) throw bad("A one-off reminder needs at or inMinutes.");
    if (kind === "every" && everyMinutes === undefined) throw bad("A repeating reminder needs everyMinutes.");
    if (kind !== "price" && input.condition !== undefined) throw bad("Only price schedules take a condition.");
    if (kind === "price") {
      condition = parseCondition(input.condition);
      checkSeconds = checkEverySeconds ?? Math.max(this.opts.defaultCheckSeconds ?? L.minCheckSeconds, L.minCheckSeconds);
      if (checkSeconds < L.minCheckSeconds) throw bad(`Prices can be checked at most every ${L.minCheckSeconds} seconds.`, "limit_check");
      if (isPortfolioCondition(condition) && !agent.address) throw bad("A portfolio condition needs the agent's wallet address.");
      condition = await this.checkTicker(condition);
    }

    let expiresMs: number | undefined;
    const expiresIn = toNumber(input.expiresInMinutes);
    if (Number.isNaN(expiresIn)) throw bad("expiresInMinutes must be a number.");
    if (expiresIn !== undefined) expiresMs = now + Math.round(expiresIn * 60_000);
    else if (input.expiresAt !== undefined) {
      expiresMs = typeof input.expiresAt === "string" ? Date.parse(input.expiresAt) : NaN;
      if (Number.isNaN(expiresMs)) throw bad("expiresAt must be an ISO 8601 time.");
    }
    if (expiresMs !== undefined && expiresMs <= now) throw bad("expiresAt must be in the future.");

    const active = this.state.schedules.filter((s) => s.active && s.agentName === agent.name && s.source === source && s.id !== extra.replacing).length;
    if (active >= L.maxActivePerAgent) {
      throw bad(
        source === "agent"
          ? `${agent.name} already has ${L.maxActivePerAgent} active schedules, the most allowed. Cancel one first.`
          : `${agent.name} already has ${L.maxActivePerAgent} active owner rules, the most allowed. Remove one first.`,
        "limit_active",
      );
    }

    const firstEvery = kind === "every" ? (atMs ?? now + everyMinutes! * 60_000) : undefined;
    const s: Schedule = {
      id: newId("sch"),
      agentName: agent.name,
      ...(agent.id ? { agentId: agent.id } : {}),
      ...(agent.address ? { agentAddress: agent.address } : {}),
      kind,
      ...(kind === "at" ? { at: iso(atMs!) } : {}),
      ...(kind === "every" ? { at: iso(firstEvery!) } : {}),
      ...(everyMinutes !== undefined ? { everyMinutes } : {}),
      ...(condition ? { condition } : {}),
      ...(checkSeconds !== undefined ? { checkEverySeconds: checkSeconds } : {}),
      message,
      source,
      ...(extra.rule ? { rule: extra.rule } : {}),
      label: extra.rule ? ruleLabel(extra.rule) : kind === "price" ? "Price watch you set" : "Reminder you set",
      createdAt: iso(now),
      nextRunAt: kind === "at" ? iso(atMs!) : kind === "every" ? iso(firstEvery!) : iso(now),
      fired: 0,
      ...(expiresMs !== undefined ? { expiresAt: iso(expiresMs) } : {}),
      active: true,
    };
    const hosted = await this.chat.hosted();
    if (hosted && !hosted.has(agent.name)) s.needsChat = true;
    this.state.schedules.push(s);
    this.persist();
    this.log(`${source === "owner" ? "owner" : agent.name} set ${s.id} for ${agent.name}: ${summarize(s, now)}${s.needsChat ? " (not hosted by the chat: it can't be woken)" : ""}`);
    return s;
  }

  /** Validates the ticker against live quotes when the brokerage answers; a move watch needs its base price. */
  private async checkTicker(c: Condition): Promise<Condition> {
    const ticker = tickerOf(c);
    if (!ticker) return c;
    let q: QuotesResult;
    try {
      q = await this.market.quotes([ticker]);
    } catch (err) {
      if (isMoveCondition(c)) throw new SchedulerError(503, "prices_unavailable", `Prices are unavailable right now (${(err as Error).message}), so a move watch can't be set. Try again shortly.`);
      return c; // can't verify now; it is checked on every tick anyway
    }
    const quote = q.quotes.find((x) => x.ticker === ticker);
    if (!quote) throw bad(`The brokerage has no ticker ${ticker}. Its quotes list the tickers it trades.`, "unknown_ticker");
    if (isMoveCondition(c)) return { ...c, basePrice: quote.price, ...(q.clockDate ? { baseDate: q.clockDate } : {}) };
    return c;
  }

  /**
   * An owner rule (take profit %, stop loss %, cash out profits above $X), stored as an owner-source
   * price schedule with a fixed message. A new rule of the same type (and ticker) replaces the old one.
   */
  async createRule(agent: AgentRef, input: RuleInput): Promise<{ schedule: Schedule; replaced?: Schedule }> {
    const type = input.type as RuleType;
    if (typeof input.type !== "string" || !RULES.has(type)) throw bad('type must be "take_profit", "stop_loss" or "cash_out_profits".');
    const value = toNumber(input.value);
    if (value === undefined || Number.isNaN(value) || value <= 0) throw bad(type === "cash_out_profits" ? "Give the profit amount in dollars, more than $0." : "Give the percent, more than 0 (10 = 10%).");
    if (type === "stop_loss" && value >= 100) throw bad("A stop loss is a percent below 100.");
    if (type === "take_profit" && value > 1000) throw bad("A take-profit percent can be at most 1000.");
    if (type === "cash_out_profits" && input.ticker !== undefined) throw bad("Cash out profits applies to the whole portfolio; leave out the ticker.");
    const ticker = input.ticker === undefined || input.ticker === "" ? undefined : parseTicker(input.ticker);
    const everyMinutes = toNumber(input.everyMinutes) ?? this.opts.ruleEveryMinutes ?? 10;
    const rule: OwnerRule = { type, value, ...(ticker ? { ticker } : {}) };
    const condition: Condition =
      type === "cash_out_profits"
        ? { portfolio: "unrealizedPnl", op: ">=", value }
        : { portfolio: "unrealizedPct", op: type === "take_profit" ? ">=" : "<=", value: type === "take_profit" ? value : -value, ...(ticker ? { ticker } : {}) };
    const old = this.state.schedules.find((s) => s.active && s.source === "owner" && s.agentName === agent.name && s.rule?.type === type && s.rule.ticker === rule.ticker);
    const schedule = await this.create(agent, { kind: "price", condition, everyMinutes, message: ruleMessage(rule) }, "owner", { rule, replacing: old?.id });
    if (old) {
      this.end(old, "replaced", "owner");
      this.persist();
    }
    return { schedule, ...(old ? { replaced: old } : {}) };
  }

  // ------------------------------------------------------------------ changing

  /** Cancel. An agent (agentName set) can cancel only its own schedules, never the owner's rules. */
  cancel(id: string, by: ScheduleSource, agentName?: string): Schedule {
    const s = this.get(id);
    if (!s || (agentName !== undefined && s.agentName !== agentName)) throw new SchedulerError(404, "schedule_not_found", `There is no schedule ${id}${agentName ? ` for ${agentName}` : ""}.`);
    if (by === "agent" && s.source === "owner") throw new SchedulerError(403, "owner_rule", `${id} is your owner's rule (${s.rule ? ruleLabel(s.rule).replace(/^Rule: /, "") : s.label}); only your owner can remove it.`);
    if (!s.active) throw new SchedulerError(409, "schedule_ended", `${id} already ended (${s.endedReason ?? "ended"}).`);
    this.end(s, "cancelled", by);
    this.persist();
    this.log(`${by === "owner" ? "owner" : s.agentName} cancelled ${s.id}`);
    return s;
  }

  pause(): void {
    if (!this.state.paused) {
      this.state.paused = true;
      this.state.pausedAt = iso(this.now());
      this.persist();
      this.log("paused by the owner: nothing fires until resume");
    }
  }

  resume(): void {
    if (this.state.paused) {
      this.state.paused = false;
      delete this.state.pausedAt;
      this.persist();
      this.log("resumed by the owner");
    }
  }

  private end(s: Schedule, reason: NonNullable<Schedule["endedReason"]>, by?: ScheduleSource): void {
    if (!s.active) return;
    s.active = false;
    s.endedAt = iso(this.now());
    s.endedReason = reason;
    if (reason === "cancelled" && by) s.cancelledBy = by;
    delete s.pending;
    delete s.nextRunAt;
  }

  private persist(): void {
    this.store.save();
    try {
      this.opts.onChange?.();
    } catch {
      /* listeners must not break the scheduler */
    }
  }

  // ------------------------------------------------------------------ running

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err: Error) => this.log(`tick failed: ${err.message}`)), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass: expire, fire what's due, check conditions, deliver pending firings. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    let dirty = false;
    try {
      const now = this.now();
      for (const s of this.state.schedules) {
        if (s.active && s.expiresAt && Date.parse(s.expiresAt) <= now) {
          this.end(s, "expired");
          this.log(`${s.id} expired`);
          dirty = true;
        }
      }
      const live = this.state.schedules.filter((s) => s.active);
      if (live.length === 0) return;

      if (this.state.paused) {
        // The autonomy switch: nothing fires. Repeating reminders skip the runs they miss; one-off
        // reminders and pending firings wait and go out after resume.
        for (const s of live) {
          if (s.kind === "every" && s.nextRunAt && Date.parse(s.nextRunAt) <= now) {
            s.nextRunAt = this.nextEvery(s, now);
            dirty = true;
          }
        }
        return;
      }

      const hosted = live.some((s) => !s.pending) ? await this.chat.hosted() : null;
      /** False for agents the chat server doesn't host (Claude Desktop): nothing can wake them. */
      const canWake = (s: Schedule): boolean => {
        if (!hosted) return true;
        const ok = hosted.has(s.agentName);
        if (Boolean(s.needsChat) === ok) {
          s.needsChat = !ok;
          dirty = true;
        }
        return ok;
      };

      // time-based
      for (const s of live) {
        if (s.kind === "price" || !s.nextRunAt || Date.parse(s.nextRunAt) > now) continue;
        if (s.kind === "every") {
          // A run that comes due while the last one still waits for a busy agent is skipped.
          const next = this.nextEvery(s, now);
          dirty = true;
          if (!s.pending && canWake(s)) this.trigger(s, `Repeats every ${fmtEvery(s.everyMinutes ?? 1)} · run ${s.fired + 1} · next ${fmtTime(next, now)}.`, now);
          s.nextRunAt = next;
        } else if (!s.pending && canWake(s)) {
          const late = now - Date.parse(s.nextRunAt) > 120_000 ? ` It is late: it's ${fmtTime(now, now)} now.` : "";
          if (this.trigger(s, `Reminder for ${fmtTime(s.nextRunAt, now)}, set at ${fmtTime(s.createdAt, now)}.${late}`, now)) dirty = true;
        }
      }

      // price and portfolio conditions (all fetched together, at most every minCheckSeconds)
      const duePrice = live.filter((s) => s.kind === "price" && !s.pending && (!s.nextRunAt || Date.parse(s.nextRunAt) <= now));
      if (duePrice.length && now - this.lastMarketAt >= this.limits.minCheckSeconds * 1000) {
        this.lastMarketAt = now;
        dirty = true;
        const wake: Schedule[] = [];
        for (const s of duePrice) {
          if (canWake(s)) wake.push(s);
          else s.nextRunAt = iso(now + this.checkMs(s));
        }
        if (wake.length) await this.checkConditions(wake, now);
      }

      // deliver (one per agent per tick: after a delivery the agent is busy)
      const due = this.state.schedules
        .filter((s) => s.active && s.pending && Date.parse(s.pending.nextAttemptAt) <= now)
        .sort((a, b) => a.pending!.triggeredAt.localeCompare(b.pending!.triggeredAt));
      const delivered = new Set<string>();
      for (const s of due) {
        if (!s.active || !s.pending || delivered.has(s.agentName)) continue;
        dirty = true;
        if (await this.deliver(s)) delivered.add(s.agentName);
      }
    } finally {
      this.ticking = false;
      if (dirty) this.persist();
    }
  }

  private checkMs(s: Schedule): number {
    return Math.max(s.checkEverySeconds ?? this.limits.minCheckSeconds, this.limits.minCheckSeconds) * 1000;
  }

  private nextEvery(s: Schedule, now: number): string {
    const period = (s.everyMinutes ?? 1) * 60_000;
    let next = Date.parse(s.nextRunAt ?? iso(now)) + period;
    if (next <= now) next = now + period; // skip the runs that were missed
    return iso(next);
  }

  private pendingCount(agentName: string): number {
    return this.state.schedules.filter((s) => s.active && s.pending && s.agentName === agentName).length;
  }

  /** Queue a firing, unless the agent used up today's firings. */
  private trigger(s: Schedule, context: string, now: number): boolean {
    const max = this.limits.maxFiringsPerDay;
    if (this.firingsToday(s.agentName) + this.pendingCount(s.agentName) >= max) {
      const msg = `daily limit reached: ${s.agentName} was woken ${max} times today`;
      if (s.lastError !== msg) this.log(`${s.id} not fired: ${msg}`);
      s.lastError = msg;
      return false;
    }
    s.pending = { context, triggeredAt: iso(now), attempts: 0, nextAttemptAt: iso(now) };
    delete s.lastError;
    return true;
  }

  private async deliver(s: Schedule): Promise<boolean> {
    const p = s.pending!;
    p.attempts++;
    const res = await this.chat.deliver(s.agentName, { text: s.message, source: "scheduler", scheduleId: s.id, setBy: s.source, label: s.label, context: p.context });
    const t = this.now();
    if (res.ok) {
      delete s.pending;
      delete s.lastError;
      s.fired++;
      s.lastFiredAt = iso(t);
      if (res.runId) s.lastRunId = res.runId;
      s.needsChat = false;
      const day = localDayKey(new Date(t));
      const f = this.state.firings[s.agentName];
      this.state.firings[s.agentName] = f && f.day === day ? { day, count: f.count + 1 } : { day, count: 1 };
      this.log(`fired ${s.id} → ${s.agentName} (${s.label})${p.attempts > 1 ? ` after ${p.attempts} tries` : ""}`);
      if (s.kind === "at" || (s.kind === "price" && !s.everyMinutes)) this.end(s, "fired");
      else if (s.kind === "price") s.nextRunAt = iso(t + s.everyMinutes! * 60_000);
      return true;
    }
    if (res.reason === "not_hosted") {
      delete s.pending;
      s.needsChat = true;
      s.lastError = res.message;
      return false;
    }
    const maxPending = this.opts.maxPendingMs ?? 30 * 60_000;
    if (t - Date.parse(p.triggeredAt) >= maxPending) {
      delete s.pending;
      s.lastError = `gave up after ${Math.round(maxPending / 60_000)} minutes: ${res.message}`;
      this.log(`${s.id}: ${s.lastError}`);
      if (s.kind === "at" || (s.kind === "price" && !s.everyMinutes)) this.end(s, "missed");
      return false;
    }
    p.lastError = res.message;
    p.nextAttemptAt = iso(t + (res.reason === "busy" ? (this.opts.busyRetryMs ?? 3000) : (this.opts.errorRetryMs ?? 20_000)));
    return false;
  }

  private async checkConditions(list: Schedule[], now: number): Promise<void> {
    const tickers = [...new Set(list.filter((s) => !isPortfolioCondition(s.condition!)).map((s) => tickerOf(s.condition!)!))];
    let quotes: QuotesResult | undefined;
    let quoteError = "";
    if (tickers.length) {
      try {
        quotes = await this.market.quotes(tickers);
      } catch (err) {
        quoteError = err instanceof MarketError ? err.message : `prices failed: ${(err as Error).message}`;
      }
    }
    const portfolios = new Map<string, Portfolio | Error>();
    for (const s of list) {
      if (!s.active || s.pending) continue; // cancelled while we waited
      const c = s.condition!;
      s.lastCheckedAt = iso(now);
      s.nextRunAt = iso(now + this.checkMs(s));
      let result: { met: boolean; observed: string; context: string };
      if (isPortfolioCondition(c)) {
        let p = portfolios.get(s.agentName);
        if (!p) {
          try {
            p = await this.market.portfolio({ name: s.agentName, id: s.agentId, address: s.agentAddress });
          } catch (err) {
            p = err as Error;
          }
          portfolios.set(s.agentName, p);
        }
        if (p instanceof Error) {
          s.lastError = `portfolio unavailable: ${p.message}`;
          continue;
        }
        result = evalPortfolio(c, p);
      } else {
        const q = quotes?.quotes.find((x) => x.ticker === c.ticker);
        if (!quotes || !q) {
          s.lastError = quotes ? `no quote for ${c.ticker}` : `prices unavailable: ${quoteError}`;
          continue;
        }
        result = evalPrice(c, q, quotes);
      }
      s.lastObserved = result.observed;
      if (s.lastError && !s.lastError.startsWith("daily limit")) delete s.lastError;
      if (result.met) this.trigger(s, result.context, now);
    }
  }
}

const dateNote = (clockDate: string | undefined, mode: string | undefined) =>
  clockDate ? ` · paper trading, ${mode === "live" ? "latest close" : "replay date"} ${clockDate}` : " · paper trading";

const compare = (op: Op, a: number, b: number) => (op === ">=" ? a >= b : a <= b);

/** Price or move condition against one quote. */
export function evalPrice(c: Exclude<Condition, { portfolio: unknown }>, q: Quote, r: QuotesResult): { met: boolean; observed: string; context: string } {
  const observed = `${q.ticker} ${price(q.price)}${r.clockDate ? ` · ${r.clockDate}` : ""}`;
  if (isMoveCondition(c)) {
    const base = c.basePrice ?? q.price;
    const move = ((q.price - base) / base) * 100;
    const met = c.movePct > 0 ? move >= c.movePct : move <= c.movePct;
    return { met, observed, context: `${q.ticker} is ${price(q.price)}, ${move >= 0 ? "up" : "down"} ${Math.abs(move).toFixed(1)}% from ${price(base)} when the watch was set (watching for ${c.movePct > 0 ? "up" : "down"} ${Math.abs(c.movePct)}%)${dateNote(r.clockDate, r.mode)}.` };
  }
  const met = compare(c.op, q.price, c.price);
  return { met, observed, context: `${q.ticker} is ${price(q.price)} (${opSymbol(c.op)} ${money(c.price)})${dateNote(r.clockDate, r.mode)}.` };
}

/** Portfolio condition. No position (or nothing invested) never meets a condition. */
export function evalPortfolio(c: Extract<Condition, { portfolio: unknown }>, p: Portfolio): { met: boolean; observed: string; context: string } {
  const when = dateNote(p.clockDate, undefined);
  if (c.ticker) {
    const pos = p.positions.find((x) => x.ticker === c.ticker && x.shares > 0);
    if (!pos) return { met: false, observed: `no ${c.ticker} position`, context: "" };
    if (c.portfolio === "unrealizedPct") {
      return { met: compare(c.op, pos.unrealizedPct, c.value), observed: `${c.ticker} ${pct(pos.unrealizedPct)}`, context: `Your ${c.ticker} position is ${pos.unrealizedPct >= 0 ? "up" : "down"} ${Math.abs(pos.unrealizedPct).toFixed(1)}% (${opSymbol(c.op)} ${pct(c.value)}), worth ${price(pos.value)}${when}.` };
    }
    return { met: compare(c.op, pos.unrealizedPnl, c.value), observed: `${c.ticker} ${money(pos.unrealizedPnl)}`, context: `Your ${c.ticker} position's unrealized P/L is ${money(pos.unrealizedPnl)} (${opSymbol(c.op)} ${money(c.value)})${when}.` };
  }
  if (p.totals.invested <= 0 && p.positions.length === 0) return { met: false, observed: "nothing invested", context: "" };
  if (c.portfolio === "unrealizedPct") {
    const v = p.totals.unrealizedPct ?? (p.totals.invested > 0 ? (p.totals.unrealizedPnl / p.totals.invested) * 100 : 0);
    return { met: compare(c.op, v, c.value), observed: `portfolio ${pct(v)}`, context: `Your portfolio is ${v >= 0 ? "up" : "down"} ${Math.abs(v).toFixed(1)}% (${opSymbol(c.op)} ${pct(c.value)}) on ${price(p.totals.invested)} invested${when}.` };
  }
  const v = p.totals.unrealizedPnl;
  return { met: compare(c.op, v, c.value), observed: `unrealized ${money(v)}`, context: `Your unrealized profit is ${money(v)} (${opSymbol(c.op)} ${money(c.value)}) on ${price(p.totals.invested)} invested${when}.` };
}

export { describeCondition };
