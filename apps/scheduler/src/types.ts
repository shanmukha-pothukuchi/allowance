/**
 * Scheduler data model (ARCHITECTURE §20.3). A schedule wakes one chat agent: at a time, every N
 * minutes, or when a paper-trading price or portfolio condition holds. Firing only sends the agent
 * a message; the agent then acts through its own tools and the wallet's policy.
 */

export type ScheduleKind = "at" | "every" | "price";
export type Op = ">=" | "<=";
export type ScheduleSource = "agent" | "owner";

/** COF at or above / at or below a price. */
export interface PriceCondition {
  ticker: string;
  op: Op;
  price: number;
}

/** COF moves movePct % from basePrice (the price when the schedule was set). 5 = up 5 %, -5 = down 5 %. */
export interface MoveCondition {
  ticker: string;
  movePct: number;
  basePrice?: number;
  baseDate?: string;
}

/**
 * The agent's paper portfolio (§20.1 GET /brokerage/portfolio). `unrealizedPct` is in percent,
 * `unrealizedPnl` in dollars. With `ticker` it looks at that position, else at the totals.
 */
export interface PortfolioCondition {
  portfolio: "unrealizedPct" | "unrealizedPnl";
  op: Op;
  value: number;
  ticker?: string;
}

export type Condition = PriceCondition | MoveCondition | PortfolioCondition;

export const isPortfolioCondition = (c: Condition): c is PortfolioCondition => "portfolio" in c;
export const isMoveCondition = (c: Condition): c is MoveCondition => "movePct" in c;
export const isPriceCondition = (c: Condition): c is PriceCondition => !isPortfolioCondition(c) && !isMoveCondition(c);

/** Owner rules (dashboard "Rules" per agent). Stored as owner-source price schedules with a fixed message. */
export type RuleType = "take_profit" | "stop_loss" | "cash_out_profits";
export interface OwnerRule {
  type: RuleType;
  /** take_profit / stop_loss: percent (10 = +10 % / −10 %). cash_out_profits: dollars. */
  value: number;
  ticker?: string;
}

/** A firing that is waiting to be delivered (the agent was busy or the chat server was down). */
export interface PendingFiring {
  context: string;
  triggeredAt: string;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
}

export interface Schedule {
  id: string;
  agentName: string;
  agentId?: string;
  /** Wallet address, for portfolio conditions. */
  agentAddress?: string;
  kind: ScheduleKind;
  /** "at": when it fires. "every": the first run. */
  at?: string;
  /** "every": the period. "price": repeat, at most once every N minutes, instead of firing once. */
  everyMinutes?: number;
  condition?: Condition;
  /** "price": how often the condition is checked (≥ 10 s). */
  checkEverySeconds?: number;
  /** What the agent is told when it fires. */
  message: string;
  source: ScheduleSource;
  rule?: OwnerRule;
  /** Short line for the chat thread: "Reminder you set", "Rule: stop loss on COF". */
  label: string;
  createdAt: string;
  /** Next firing ("at" / "every") or next condition check ("price"). */
  nextRunAt?: string;
  lastCheckedAt?: string;
  /** "COF $205.10 · 2025-11-01": what the last check saw. */
  lastObserved?: string;
  lastFiredAt?: string;
  lastRunId?: string;
  /** How many times it fired. */
  fired: number;
  expiresAt?: string;
  active: boolean;
  endedAt?: string;
  endedReason?: "fired" | "cancelled" | "expired" | "replaced" | "missed";
  cancelledBy?: ScheduleSource;
  /** The agent is not hosted by the chat server (e.g. Claude Desktop): nothing can wake it. */
  needsChat?: boolean;
  pending?: PendingFiring;
  lastError?: string;
}

export interface FiringCount {
  day: string;
  count: number;
}

export interface SchedulerState {
  version: 1;
  /** The owner's autonomy switch: while paused, nothing fires. */
  paused: boolean;
  pausedAt?: string;
  schedules: Schedule[];
  /** Firings per agent on the local calendar day. */
  firings: Record<string, FiringCount>;
}

export interface Limits {
  /** Active schedules per agent (agent-set and owner rules are counted separately). */
  maxActivePerAgent: number;
  minEveryMinutes: number;
  /** Price and portfolio conditions are checked at most this often. */
  minCheckSeconds: number;
  maxFiringsPerDay: number;
  maxMessageChars: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxActivePerAgent: 10,
  minEveryMinutes: 1,
  minCheckSeconds: 10,
  maxFiringsPerDay: 30,
  maxMessageChars: 500,
};

/** The body the scheduler POSTs to the chat server's /api/agents/:name/messages. */
export interface FireBody {
  /** The schedule's message. */
  text: string;
  source: "scheduler";
  scheduleId: string;
  /** Who set the schedule. */
  setBy: ScheduleSource;
  label: string;
  /** One line of context: "COF is $212.40 (≥ $210), replay date 2025-11-03." */
  context?: string;
}
