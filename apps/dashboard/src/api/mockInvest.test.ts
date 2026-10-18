import { afterEach, describe, expect, it, vi } from "vitest";
import { ordersByTx, rulesFor, withAgentNames } from "../invest";
import { activityLine, lineText } from "../lines";
import { createMockAdapter, mockInvestMode, type MockAdapter } from "./mockAdapter";
import { HttpError } from "./adapter";

let m: MockAdapter | undefined;
afterEach(() => {
  m?.stop();
  m = undefined;
  vi.useRealTimers();
});
const make = (opts: Parameters<typeof createMockAdapter>[0] = {}) => (m = createMockAdapter({ latencyMs: 0, bank: "on", invest: true, ...opts }));

describe("mock investing (§20)", () => {
  it("is off unless asked, so the wallet mock stays as it was", async () => {
    const plain = (m = createMockAdapter({ latencyMs: 0 }));
    expect((await plain.getPortfolios()).portfolios).toEqual([]);
    expect((await plain.getScheduler()).schedules).toEqual([]);
    expect((await plain.getSummary()).agents.find((a) => a.name === "researcher")!.policy.maxPerTx).toBe("1.00");
    expect(mockInvestMode("?mock=1")).toEqual({ invest: true, paused: false });
    expect(mockInvestMode("?mock=1&invest=0&paused=1")).toEqual({ invest: false, paused: true });
  });

  it("seeds a few replay days: positions, trades in the feed, a rule and two schedules", async () => {
    const a = make();
    const s = await a.getSummary();
    const p = withAgentNames(await a.getPortfolios(), s.agents);
    expect(p.brokerage).toMatchObject({ mode: "replay", replayFrom: "2024-11-01" });
    expect(p.portfolios.map((x) => x.agentName).sort()).toEqual(["claude-desktop", "researcher"]);
    const r = p.portfolios.find((x) => x.agentName === "researcher")!;
    expect(r.positions.map((x) => x.ticker)).toEqual(["COF", "JPM"]);
    expect(r.totals.realizedPnl).toBe("6.20");

    const orders = ordersByTx(p);
    const lines = (await a.getRecentEvents(40)).filter((e) => !e.type.startsWith("bank.")).map((e) => lineText(activityLine(e, { orders, checkingLast4: "1234" })));
    expect(lines).toEqual([
      "researcher bought 0.36 COF",
      "researcher cashed out $25.00 to Checking ••1234",
      "researcher sold COF · +$6.20 realized",
      "claude-desktop bought 0.07 NVDA",
      "researcher bought 0.21 JPM",
      "researcher bought 0.47 COF",
    ]);

    const sch = await a.getScheduler();
    expect(sch.paused).toBe(false);
    expect(sch.schedules.filter((x) => x.active).map((x) => [x.agentName, x.source, x.kind])).toEqual([
      ["researcher", "agent", "at"],
      ["researcher", "owner", "price"],
      ["claude-desktop", "agent", "every"],
    ]);
    expect(rulesFor(sch.schedules, "researcher")).toEqual({ stopLossPct: "5" });
    expect(sch.firings.map((f) => f.label)).toEqual(["check COF"]);
  });

  it("starts paused with &paused=1, and the switch flips it", async () => {
    const a = make({ paused: true });
    expect((await a.getScheduler()).paused).toBe(true);
    expect(await a.setPaused(false)).toBe(false);
    expect((await a.getScheduler()).paused).toBe(false);
  });

  it("rules replace, turn off, and cancel like the scheduler", async () => {
    const a = make();
    const agent = (await a.getSummary()).agents.find((x) => x.name === "researcher")!;
    await a.setRules(agent, { takeProfitPct: "10", stopLossPct: "8" });
    let sch = await a.getScheduler();
    expect(rulesFor(sch.schedules, "researcher")).toEqual({ takeProfitPct: "10", stopLossPct: "8" });
    expect(sch.schedules.find((x) => x.rule === "stop_loss" && !x.active)?.endedReason).toBe("replaced");
    await a.setRules(agent, {});
    sch = await a.getScheduler();
    expect(rulesFor(sch.schedules, "researcher")).toEqual({});
    const reminder = sch.schedules.find((x) => x.active && x.kind === "at")!;
    await a.cancelSchedule(reminder.id);
    sch = await a.getScheduler();
    expect(sch.schedules.find((x) => x.id === reminder.id)).toMatchObject({ active: false, endedReason: "cancelled" });
    await expect(a.cancelSchedule(reminder.id)).rejects.toMatchObject({ status: 409 });
  });

  it("cash out: all, an amount, never more than there is, and it moves checking up", async () => {
    const a = make({ bankDelayMs: 5 });
    const s = await a.getSummary();
    const agent = s.agents.find((x) => x.name === "researcher")!;
    const before = Number(s.bank && "checkingBalance" in s.bank ? s.bank.checkingBalance : 0);
    const r = await a.cashout(agent.id, "10.00");
    // The bank mirrors it through its queue (§20.2), a moment later.
    expect(r).toMatchObject({ kind: "cashout", status: "settled", amount: "10.00", description: "Cash out to owner" });
    await expect(a.cashout(agent.id, "9999.00")).rejects.toBeInstanceOf(HttpError);
    const all = await a.cashout(agent.id, "all");
    expect(Number(all.amount)).toBeCloseTo(Number(agent.balance) - 10, 2);
    await new Promise((res) => setTimeout(res, 40));
    const after = await a.getSummary();
    expect(after.agents.find((x) => x.id === agent.id)!.balance).toBe("0.00");
    expect(Number(after.bank && "checkingBalance" in after.bank ? after.bank.checkingBalance : 0)).toBeCloseTo(before + Number(agent.balance), 2);
  });

  it("the replay clock moves prices, and the stop loss wakes researcher, which sells", async () => {
    vi.useFakeTimers();
    const a = make({ marketDayMs: 1000, minIntervalMs: 600_000, maxIntervalMs: 600_000 });
    const run = async <T,>(p: Promise<T>) => {
      await vi.advanceTimersByTimeAsync(1);
      return p;
    };
    const events: string[] = [];
    a.subscribe((e) => events.push(e.type));
    const before = (await run(a.getPortfolios())).brokerage.clockDate;
    await vi.advanceTimersByTimeAsync(14_000);
    await vi.advanceTimersByTimeAsync(4000);
    const sch = await run(a.getScheduler());
    expect((await run(a.getPortfolios())).brokerage.clockDate > before).toBe(true);
    expect(sch.firings[0]).toMatchObject({ agentName: "researcher", source: "owner", rule: "stop_loss", label: "stop loss" });
    expect(events.filter((t) => t === "earning.received").length).toBeGreaterThanOrEqual(2);
    const p = withAgentNames(await run(a.getPortfolios()), (await run(a.getSummary())).agents);
    expect(p.portfolios.find((x) => x.agentName === "researcher")!.positions).toEqual([]);
  });
});
