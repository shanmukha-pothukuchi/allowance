import { describe, expect, it } from "vitest";
import {
  cashoutLine,
  checkCashout,
  checkRules,
  firingLine,
  normPortfolios,
  normScheduler,
  ordersByTx,
  paperLine,
  ruleWatches,
  rulesFor,
  sameRules,
  scheduleNext,
  scheduleTitle,
  scheduleTrigger,
  shares,
  signedMoney,
  signedPct,
  sumPortfolios,
  tradeLine,
  tradeOf,
  tradingDay,
  whenText,
  withAgentNames,
} from "./invest";
import { activityLine, eventAmount, lineText, receiptColumn, receiptLine } from "./lines";
import type { Receipt, WalletEvent } from "./types";

const ADDR = "0xAbC0000000000000000000000000000000000001";

/** `GET /brokerage/portfolios` as apps/brokerage answers it. */
const BROKERAGE = {
  mode: "replay",
  clockDate: "2025-11-03",
  startDate: "2024-11-01",
  label: "Paper trading · replay of real closes from 2024-11-01",
  disclaimer: "Paper trading…",
  portfolios: [
    {
      address: ADDR.toLowerCase(),
      mode: "replay",
      clockDate: "2025-11-03",
      startDate: "2024-11-01",
      cash: null,
      positions: [{ ticker: "COF", name: "Capital One", shares: "0.4708", avgCost: "212.40", price: "225.57", priceDate: "2025-11-03", value: "106.20", costBasis: "100.00", unrealizedPnl: "6.20", unrealizedPct: 6.2, changePct1d: 0.4 }],
      totals: { invested: "100.00", value: "106.20", unrealizedPnl: "6.20", unrealizedPct: 6.2, realizedPnl: "-1.40", totalPnl: "4.80" },
      orders: [
        { orderId: "ord_1", side: "buy", ticker: "COF", shares: "0.4708", price: "212.40", amount: "100.00", clockDate: "2025-10-01", at: "2026-10-18T10:00:00Z", status: "filled", txHash: "0xAAA" },
        { orderId: "ord_2", side: "sell", ticker: "JPM", shares: "0.2", price: "231.10", amount: "46.22", costBasis: "47.62", realizedPnl: "-1.40", clockDate: "2025-10-20", at: "2026-10-18T10:05:00Z", status: "filled", txHash: "0xBBB" },
      ],
    },
    // A wallet with nothing in it (sold out, no P/L): left out.
    { address: "0x0000000000000000000000000000000000000002", positions: [], totals: { invested: "0.00", value: "0.00", unrealizedPnl: "0.00", realizedPnl: "0.00" } },
  ],
};

/** Owner `GET /schedules?all=1` as apps/scheduler answers it. */
const SCHEDULER = {
  schedules: [
    { id: "sch_1", agentName: "researcher", kind: "price", everyMinutes: 10, condition: { portfolio: "unrealizedPct", op: "<=", value: -5 }, message: "Your owner's stop-loss rule…", source: "owner", rule: "stop_loss", ruleValue: 5, label: "Rule: stop loss", createdAt: "2026-10-18T09:00:00Z", fired: 0, active: true, summary: "Rule: stop loss at −5% (portfolio)", firesOnce: false },
    { id: "sch_2", agentName: "researcher", kind: "price", condition: { portfolio: "unrealizedPnl", op: ">=", value: 25 }, everyMinutes: 10, message: "Your owner's rule: cash out profits above $25…", source: "owner", rule: "cash_out_profits", ruleValue: 25, label: "Rule: cash out profits above $25", createdAt: "2026-10-18T09:00:00Z", fired: 0, active: true },
    { id: "sch_3", agentName: "researcher", kind: "price", condition: { portfolio: "unrealizedPct", op: "<=", value: -8, ticker: "COF" }, message: "…", source: "owner", rule: "stop_loss", ruleValue: 8, ruleTicker: "COF", label: "Rule: stop loss on COF", createdAt: "2026-10-18T09:00:00Z", fired: 1, lastFiredAt: "2026-10-18T10:00:00Z", active: true, everyMinutes: 10 },
    { id: "sch_4", agentName: "researcher", kind: "price", condition: { ticker: "COF", op: ">=", price: 210 }, message: "Check COF. It hit your target.", source: "agent", label: "Price watch you set", createdAt: "2026-10-18T08:00:00Z", fired: 1, lastFiredAt: "2026-10-18T09:30:00Z", active: false, endedReason: "fired" },
    { id: "sch_5", agentName: "claude-desktop", kind: "every", everyMinutes: 60, at: "2026-10-18T11:00:00Z", nextRunAt: "2026-10-18T11:00:00Z", message: "Review the portfolio.", source: "agent", label: "Reminder you set", createdAt: "2026-10-18T08:00:00Z", fired: 0, active: true, needsChat: true },
  ],
  paused: true,
  pausedAt: "2026-10-18T10:30:00Z",
  limits: { maxActivePerAgent: 10 },
  firingsToday: { researcher: 2 },
  firings: [
    { id: "f2", scheduleId: "sch_3", agentName: "researcher", source: "owner", label: "Rule: stop loss on COF", at: "2026-10-18T10:00:00Z", context: "Your COF position is down 8.4% · replay date 2025-11-03.", rule: "stop_loss" },
    { id: "f1", scheduleId: "sch_4", agentName: "researcher", source: "agent", label: "Price watch you set", at: "2026-10-18T09:30:00Z", context: "COF is $212.40 (≥ $210) · replay date 2025-11-03." },
  ],
};

describe("brokerage shapes", () => {
  const p = normPortfolios(BROKERAGE);
  it("reads the clock, the replay start and positions by wallet", () => {
    expect(p.brokerage).toEqual({ mode: "replay", clockDate: "2025-11-03", replayFrom: "2024-11-01" });
    expect(p.portfolios).toHaveLength(1);
    expect(p.portfolios[0]).toMatchObject({ agentName: "", address: ADDR.toLowerCase(), totals: { invested: "100.00", value: "106.20", unrealizedPnl: "6.20", realizedPnl: "-1.40" } });
    expect(p.portfolios[0].positions[0]).toMatchObject({ ticker: "COF", shares: 0.4708, avgCost: "212.40", price: "225.57", unrealizedPct: 6.2 });
  });
  it("names wallets after the agents that hold them", () => {
    const named = withAgentNames(p, [{ id: "agt_1", name: "researcher", address: ADDR }]);
    expect(named.portfolios[0]).toMatchObject({ agentName: "researcher", agentId: "agt_1" });
    expect(withAgentNames(p, []).portfolios[0].agentName).toBe("0xabc0…0001");
  });
  it("sums, and says the honest line", () => {
    expect(sumPortfolios(p.portfolios)).toMatchObject({ value: "106.20", unrealizedPnl: "6.20", unrealizedPct: 6.2, realizedPnl: "-1.40", positions: 1 });
    expect(paperLine(p.brokerage)).toBe("Paper trading · replay of real closes from Nov 1, 2024 · not investment advice");
    expect(paperLine({ mode: "live" })).toBe("Paper trading · latest real closes · not investment advice");
    expect(tradingDay("2025-11-03")).toBe("Nov 3, 2025");
  });
  it("formats figures with real minus signs", () => {
    expect(signedMoney("6.2")).toBe("+$6.20");
    expect(signedMoney("-1.4")).toBe("−$1.40");
    expect(signedMoney(0)).toBe("$0.00");
    expect(signedPct(-3.14)).toBe("−3.1%");
    expect(shares(0.4708)).toBe("0.47");
    expect(shares(0.0047)).toBe("0.0047");
  });
});

describe("trades in the feed", () => {
  const orders = ordersByTx(normPortfolios(BROKERAGE));
  const rcpt = (over: Partial<Receipt>): Receipt =>
    ({ id: "rcp_1", agentId: "agt_1", agentName: "researcher", kind: "spend", status: "settled", description: "Brokerage (paper)", amount: "100.00", amountBaseUnits: "100000000", network: "eip155:84532", counterparty: { address: ADDR, origin: "http://localhost:4110", name: "Brokerage (paper)" }, createdAt: "2026-10-18T10:00:00Z", ...over }) as Receipt;
  it("a buy: its order (by tx hash) names the shares", () => {
    const r = rcpt({ txHash: "0xaaa" as Receipt["txHash"] });
    expect(lineText(activityLine({ type: "payment.settled", agentName: "researcher", receipt: r }, { orders }))).toBe("researcher bought 0.47 COF");
    expect(eventAmount({ type: "payment.settled", receipt: r })).toEqual({ text: "−$100.00", tone: "out" });
    // Without the order: still a buy, just not which stock.
    expect(lineText(activityLine({ type: "payment.settled", agentName: "researcher", receipt: r }))).toBe("researcher bought paper shares");
    expect(lineText(activityLine({ type: "payment.signed", agentName: "researcher", receipt: rcpt({ description: "Buy 0.47 COF" }) }))).toBe("researcher is buying 0.47 COF");
  });
  it("a sell: the earning, with the realized P/L", () => {
    const r = rcpt({ kind: "earn", description: "Sold 0.2 JPM", amount: "46.22", txHash: "0xBBB" as Receipt["txHash"] });
    expect(tradeOf(r, orders)).toEqual({ side: "sell", ticker: "JPM", shares: "0.20", realized: "−$1.40" });
    expect(lineText(activityLine({ type: "earning.received", agentName: "researcher", receipt: r }, { orders }))).toBe("researcher sold JPM · −$1.40 realized");
    expect(lineText(receiptLine(rcpt({ kind: "earn", description: "Sold 0.47 COF · +$6.20 realized" })))).toBe("researcher sold COF · +$6.20 realized");
    expect(eventAmount({ type: "earning.received", receipt: r })).toEqual({ text: "+$46.22", tone: "in" });
  });
  it("other payments and bounties stay as they were", () => {
    expect(tradeOf(rcpt({ description: "Acme Weather", counterparty: { address: ADDR, origin: "http://localhost:4021", name: "Acme Weather" } }))).toBeNull();
    expect(tradeOf(rcpt({ kind: "earn", description: "Bounty: API check", counterparty: { address: ADDR, name: "Acme Corp" } }))).toBeNull();
    expect(tradeLine("r", { side: "buy", ticker: "COF" })).toEqual({ actor: "r", verb: "bought", object: "COF" });
  });
  it("a cash-out says its amount once, in the sentence", () => {
    const r = rcpt({ kind: "cashout", description: "Cash out to owner", amount: "25.00", counterparty: { address: ADDR, name: "Owner vault" } });
    const e = { type: "cashout", agentName: "researcher", receipt: r } as Pick<WalletEvent, "type" | "agentName" | "receipt">;
    expect(lineText(activityLine(e, { checkingLast4: "7688" }))).toBe("researcher cashed out $25.00 to Checking ••7688");
    expect(lineText(activityLine(e))).toBe("researcher cashed out $25.00 to you");
    expect(eventAmount(e)).toBeNull();
    expect(receiptColumn(r)).toBeNull();
    expect(lineText(cashoutLine("researcher", "25", "1234"))).toBe("researcher cashed out $25.00 to Checking ••1234");
  });
});

describe("scheduler shapes", () => {
  const s = normScheduler(SCHEDULER);
  const byId = (id: string) => s.schedules.find((x) => x.id === id)!;
  it("reads schedules, the switch and the firings log", () => {
    expect(s.paused).toBe(true);
    expect(s.schedules).toHaveLength(5);
    expect(byId("sch_2")).toMatchObject({ rule: "cash_out", ruleValue: "25", source: "owner", active: true });
    expect(byId("sch_3")).toMatchObject({ rule: "stop_loss", ruleTicker: "COF" });
    expect(byId("sch_4")).toMatchObject({ active: false, endedReason: "fired", label: "Price watch you set" });
    expect(byId("sch_5").needsChat).toBe(true);
    expect(s.firings.map((f) => f.label)).toEqual(["stop loss on COF", "check COF"]);
  });
  it("says each schedule once: title, what it watches, what's next", () => {
    expect(scheduleTitle(byId("sch_1"))).toBe("Stop loss at −5%");
    expect(scheduleTitle(byId("sch_2"))).toBe("Cash out profits above $25");
    expect(scheduleTitle(byId("sch_3"))).toBe("Stop loss on COF at −8%");
    expect(ruleWatches(byId("sch_1"))).toBe("Whole portfolio");
    expect(ruleWatches(byId("sch_3"))).toBe("COF position");
    expect(ruleWatches(byId("sch_2"))).toBe("Unrealized profit");
    expect(scheduleTrigger(byId("sch_4"))).toBe("COF ≥ $210.00");
    expect(scheduleTrigger(byId("sch_2"))).toBe("Unrealized profit ≥ $25.00");
    expect(scheduleTrigger(byId("sch_5"))).toBe("Every hour");
    expect(scheduleNext(byId("sch_1"))).toBe("at most every 10 min");
    expect(scheduleNext({ ...byId("sch_4"), active: true })).toBe("fires once");
    expect(scheduleNext(byId("sch_5"))).toBe("Needs the chat");
    expect(whenText("2026-10-18T10:12:00Z", Date.parse("2026-10-18T10:00:00Z"))).toBe("in 12m");
  });
  it("firing lines: Rule or Reminder woke the agent", () => {
    expect(lineText(firingLine(s.firings[0]))).toBe("Rule woke researcher: stop loss on COF");
    expect(lineText(firingLine(s.firings[1]))).toBe("Reminder woke researcher: check COF");
  });
  it("the form's rules are the portfolio-wide owner rules", () => {
    expect(rulesFor(s.schedules, "researcher")).toEqual({ stopLossPct: "5", cashOutAbove: "25.00" });
    expect(rulesFor(s.schedules, "claude-desktop")).toEqual({});
  });
  it("a bare array, or nothing, still reads", () => {
    expect(normScheduler([SCHEDULER.schedules[0]]).schedules).toHaveLength(1);
    expect(normScheduler(undefined)).toEqual({ paused: false, schedules: [], firings: [] });
  });
});

describe("owner inputs", () => {
  it("rules: empty is off, numbers in range", () => {
    expect(checkRules({ takeProfitPct: "10", stopLossPct: "−5%", cashOutAbove: "$25" })).toEqual({ ok: true, rules: { takeProfitPct: "10", stopLossPct: "5", cashOutAbove: "25.00" } });
    expect(checkRules({ takeProfitPct: "", stopLossPct: "", cashOutAbove: "" })).toEqual({ ok: true, rules: {} });
    const bad = checkRules({ stopLossPct: "120", cashOutAbove: "abc" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["cashOutAbove", "stopLossPct"]);
    expect(sameRules({ cashOutAbove: "25" }, { cashOutAbove: "25.00" })).toBe(true);
  });
  it("cash out: all, a chip, or a custom amount within the balance", () => {
    expect(checkCashout("all", "", "51.20")).toEqual({ ok: true, amount: "all" });
    expect(checkCashout("all", "", "0.00").ok).toBe(false);
    expect(checkCashout("20.00", "", "51.20")).toEqual({ ok: true, amount: "20.00" });
    expect(checkCashout("custom", "12.5", "51.20")).toEqual({ ok: true, amount: "12.50" });
    expect(checkCashout("custom", "80", "51.20")).toEqual({ ok: false, message: "$51.20 is all there is." });
  });
});
