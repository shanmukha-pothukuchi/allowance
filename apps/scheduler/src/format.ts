import { isMoveCondition, isPortfolioCondition, type Condition, type OwnerRule, type Schedule } from "./types.js";

/** "$210" for whole numbers, else "$212.40". */
export function money(n: number): string {
  const abs = Math.abs(n);
  const s = Number.isInteger(abs) ? abs.toLocaleString("en-US") : abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "−" : ""}$${s}`;
}

/** Always two decimals: "$212.40". */
export function price(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "+12.4%", "−8.3%"; whole numbers stay whole ("+10%"). */
export function pct(n: number, digits = 1): string {
  const abs = Math.abs(n);
  const s = Number.isInteger(abs) ? String(abs) : abs.toFixed(digits);
  return `${n < 0 ? "−" : "+"}${s}%`;
}

export const opSymbol = (op: string) => (op === "<=" ? "≤" : "≥");

/** "18:05 UTC", or "Oct 19, 18:05 UTC" on another day. */
export function fmtTime(iso: string | number, now: number): string {
  const d = new Date(iso);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
  if (d.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)) return hm;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${hm}`;
}

/** "in 1 minute", "in 2 hours", "in 3 days". */
export function fmtIn(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "in under a minute";
  if (min < 90) return `in ${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.round(min / 60);
  if (h < 36) return `in ${h} hours`;
  return `in ${Math.round(h / 24)} days`;
}

export function fmtEvery(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? "day" : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? "hour" : `${minutes / 60} hours`;
  return minutes === 1 ? "minute" : `${minutes} minutes`;
}

/** "COF ≥ $210", "COF up 5% from $201.30", "COF position ≤ −8%", "unrealized profit ≥ $50". */
export function describeCondition(c: Condition): string {
  if (isPortfolioCondition(c)) {
    const subject = c.ticker ? `${c.ticker} position` : "portfolio";
    if (c.portfolio === "unrealizedPct") return `${subject} ${opSymbol(c.op)} ${pct(c.value)}`;
    return `${c.ticker ? `${c.ticker} unrealized P/L` : "unrealized profit"} ${opSymbol(c.op)} ${money(c.value)}`;
  }
  if (isMoveCondition(c)) {
    const dir = c.movePct < 0 ? "down" : "up";
    return `${c.ticker} ${dir} ${Math.abs(c.movePct)}%${c.basePrice ? ` from ${price(c.basePrice)}` : ""}`;
  }
  return `${c.ticker} ${opSymbol(c.op)} ${money(c.price)}`;
}

export function ruleLabel(r: OwnerRule): string {
  if (r.type === "cash_out_profits") return `Rule: cash out profits above ${money(r.value)}`;
  return `Rule: ${r.type === "take_profit" ? "take profit" : "stop loss"}${r.ticker ? ` on ${r.ticker}` : ""}`;
}

/** "Rule: stop loss on COF at −8%". */
export function ruleSummary(r: OwnerRule): string {
  if (r.type === "cash_out_profits") return ruleLabel(r);
  const at = pct(r.type === "take_profit" ? r.value : -r.value);
  return r.ticker ? `${ruleLabel(r)} at ${at}` : `${ruleLabel(r)} at ${at} (portfolio)`;
}

/** The fixed message the agent receives when an owner rule fires. */
export function ruleMessage(r: OwnerRule): string {
  if (r.type === "cash_out_profits") {
    return (
      `Your owner's rule: cash out profits above ${money(r.value)}. Your unrealized profit is above that now. ` +
      `Sell the positions that are up with sell_stock to realize the profit, then send the realized profit to your owner with cash_out, and tell them briefly what you did.`
    );
  }
  const subject = r.ticker ? `your ${r.ticker} position` : "your portfolio";
  const sell = r.ticker ? `Sell your whole ${r.ticker} position with sell_stock` : "Sell your positions with sell_stock";
  if (r.type === "take_profit") {
    return `Your owner's take-profit rule: when ${subject} is up ${r.value}% or more, take the profit. It has reached that now. ${sell}, then tell your owner briefly what you sold and the realized profit.`;
  }
  return `Your owner's stop-loss rule: when ${subject} is down ${r.value}% or more, sell to limit the loss. It has reached that now. ${sell}, then tell your owner briefly what you sold and the realized loss.`;
}

/** One short line for lists and the dashboard: "Watching COF ≥ $210 · fires once". */
/** The owner rule a schedule carries, if any. */
export function ruleOf(s: Pick<Schedule, "rule" | "ruleValue" | "ruleTicker">): OwnerRule | undefined {
  return s.rule && s.ruleValue !== undefined ? { type: s.rule, value: s.ruleValue, ...(s.ruleTicker ? { ticker: s.ruleTicker } : {}) } : undefined;
}

export function summarize(s: Schedule, now: number): string {
  let base: string;
  const rule = ruleOf(s);
  if (rule) base = ruleSummary(rule);
  else if (s.kind === "at") base = `Reminder at ${fmtTime(s.at ?? s.nextRunAt ?? s.createdAt, now)} · fires once`;
  else if (s.kind === "every") base = `Every ${fmtEvery(s.everyMinutes ?? 1)}${s.active && s.nextRunAt ? ` · next ${fmtTime(s.nextRunAt, now)}` : ""}`;
  else base = `Watching ${s.condition ? describeCondition(s.condition) : "?"} · ${s.everyMinutes ? `at most every ${fmtEvery(s.everyMinutes)}` : "fires once"}`;
  if (!s.active) return `${base} · ${s.endedReason ?? "ended"}`;
  return s.needsChat ? `${base} · needs the chat` : base;
}
