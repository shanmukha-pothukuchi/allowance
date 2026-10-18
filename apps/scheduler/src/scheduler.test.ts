import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWalletStub, type WalletStub } from "@allowance/mcp/test-stubs";
import { createSchedulerApp } from "./app.js";
import { httpChat, type ChatClient, type DeliverResult } from "./chat.js";
import { Scheduler } from "./engine.js";
import { httpMarket, type Portfolio } from "./market.js";
import { ScheduleStore } from "./store.js";
import { ensureSchedulerToken, readSchedulerToken } from "./token.js";
import { httpWallet, type AgentIdentity, type WalletAuth } from "./wallet.js";
import type { FireBody, Schedule } from "./types.js";

// ---- fakes ---------------------------------------------------------------------------------

class FakeChat implements ChatClient {
  deliveries: Array<{ agent: string; body: FireBody }> = [];
  attempts = 0;
  busy = new Set<string>();
  hostedNames: Set<string> | null = new Set(["researcher", "shopper", "investor"]);
  down = false;
  async deliver(agent: string, body: FireBody): Promise<DeliverResult> {
    this.attempts++;
    if (this.down) return { ok: false, reason: "unreachable", message: "the chat server is not reachable" };
    if (this.hostedNames && !this.hostedNames.has(agent)) return { ok: false, reason: "not_hosted", message: `the chat server does not host ${agent}` };
    if (this.busy.has(agent)) return { ok: false, reason: "busy", message: "the agent is busy" };
    this.deliveries.push({ agent, body });
    return { ok: true, runId: `run_${this.deliveries.length}` };
  }
  async hosted() {
    return this.down ? null : this.hostedNames;
  }
}

interface BrokerageStub {
  url: string;
  prices: Map<string, number>;
  clockDate: string;
  portfolios: Map<string, Portfolio>;
  quoteRequests: string[];
  portfolioRequests: Array<{ address: string; ownerKey?: string }>;
  down: boolean;
  close(): Promise<void>;
}

const OWNER_KEY = "ok_test_owner_key";

async function startBrokerageStub(): Promise<BrokerageStub> {
  const stub: BrokerageStub = {
    url: "",
    prices: new Map([
      ["COF", 205],
      ["JPM", 300],
    ]),
    clockDate: "2025-11-03",
    portfolios: new Map(),
    quoteRequests: [],
    portfolioRequests: [],
    down: false,
    close: async () => {},
  };
  const app = express();
  app.get("/brokerage", (_req, res) => res.json({ mode: "replay", clockDate: stub.clockDate, tickers: [] }));
  app.get("/brokerage/quotes", (req, res) => {
    stub.quoteRequests.push(String(req.query.tickers));
    if (stub.down) return void res.status(503).json({ error: "prices_unavailable" });
    const tickers = String(req.query.tickers ?? "").split(",").filter(Boolean);
    res.json({ clockDate: stub.clockDate, quotes: tickers.filter((t) => stub.prices.has(t)).map((t) => ({ ticker: t, name: t, price: stub.prices.get(t), changePct1d: 0.1, changePctFromStart: 1 })) });
  });
  app.get("/brokerage/portfolio", (req, res) => {
    stub.portfolioRequests.push({ address: String(req.query.address), ownerKey: req.header("x-owner-key") ?? undefined });
    if (req.header("x-owner-key") !== OWNER_KEY) return void res.status(401).json({ error: "unauthorized" });
    const p = [...stub.portfolios.entries()].find(([addr]) => addr === req.query.address)?.[1];
    res.json(p ?? { clockDate: stub.clockDate, cash: null, positions: [], totals: { invested: 0, value: 0, unrealizedPnl: 0, realizedPnl: 0 } });
  });
  const server: Server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () => new Promise((r) => server.close(() => r()));
  return stub;
}

const T0 = Date.parse("2026-10-18T15:00:00.000Z");
const MIN = 60_000;
const researcher: AgentIdentity = { id: "agt_r", name: "researcher", address: "0x1111111111111111111111111111111111111111" };
const investor: AgentIdentity = { id: "agt_i", name: "investor", address: "0x3333333333333333333333333333333333333333" };

let brokerage: BrokerageStub;
beforeAll(async () => {
  brokerage = await startBrokerageStub();
});
afterAll(async () => {
  await brokerage.close();
});
beforeEach(() => {
  brokerage.prices.set("COF", 205);
  brokerage.down = false;
  brokerage.portfolios.clear();
  brokerage.quoteRequests.length = 0;
  brokerage.portfolioRequests.length = 0;
});

function setup(extra: Partial<ConstructorParameters<typeof Scheduler>[0]> = {}, file?: string) {
  const clock = { t: T0 };
  const chat = new FakeChat();
  const logs: string[] = [];
  const scheduler = new Scheduler({
    store: new ScheduleStore(file),
    chat,
    market: httpMarket({ brokerageUrl: brokerage.url, ownerApiKey: OWNER_KEY }),
    now: () => clock.t,
    log: (m) => logs.push(m),
    ...extra,
  });
  const advance = async (ms: number) => {
    clock.t += ms;
    await scheduler.tick();
  };
  return { clock, chat, scheduler, logs, advance };
}

const expectError = async (p: Promise<unknown> | (() => unknown), status: number, re: RegExp) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    expect((err as { status: number }).status).toBe(status);
    expect((err as Error).message).toMatch(re);
    return err as { code: string };
  }
  throw new Error("expected an error");
};

// ---- limits --------------------------------------------------------------------------------

describe("limits (§20.3)", () => {
  it("allows 10 active schedules per agent, every ≥ 1 minute, price checks ≥ 10 s, short messages, future times", async () => {
    const { scheduler } = setup();
    for (let i = 0; i < 10; i++) await scheduler.create(researcher, { inMinutes: 5 + i, message: `note ${i}` });
    const err = await expectError(scheduler.create(researcher, { inMinutes: 30, message: "one too many" }), 400, /already has 10 active schedules, the most allowed/);
    expect(err.code).toBe("limit_active");
    // another agent has its own 10; the owner's rules are counted separately
    await scheduler.create(investor, { inMinutes: 5, message: "mine" });
    const rule = await scheduler.createRule(researcher, { type: "stop_loss", value: 8, ticker: "COF" });
    expect(rule.schedule.source).toBe("owner");
    // cancelling frees a slot
    scheduler.cancel(scheduler.list({ agentName: "researcher" }).find((s) => s.source === "agent")!.id, "agent", "researcher");
    await scheduler.create(researcher, { inMinutes: 30, message: "fits now" });

    const { scheduler: s2 } = setup();
    expect((await expectError(s2.create(researcher, { everyMinutes: 0.5, message: "x" }), 400, /at least 1 minute apart/)).code).toBe("limit_every");
    expect((await expectError(s2.create(researcher, { condition: { ticker: "COF", op: ">=", price: 210 }, checkEverySeconds: 5, message: "x" }), 400, /at most every 10 seconds/)).code).toBe("limit_check");
    await expectError(s2.create(researcher, { inMinutes: 1, message: "x".repeat(501) }), 400, /at most 500 characters/);
    await expectError(s2.create(researcher, { inMinutes: 1, message: "  " }), 400, /message/);
    await expectError(s2.create(researcher, { at: new Date(T0 - MIN).toISOString(), message: "x" }), 400, /already passed/);
    await expectError(s2.create(researcher, { message: "when?" }), 400, /Say when it should fire/);
    await expectError(s2.create(researcher, { condition: { ticker: "nope!", op: ">=", price: 1 }, message: "x" }), 400, /ticker/);
    await expectError(s2.create(researcher, { condition: { ticker: "ZZZZ", op: ">=", price: 1 }, message: "x" }), 400, /no ticker ZZZZ/);
    expect(s2.list()).toHaveLength(0);
  });

  it("stops firing an agent after 30 firings in a day, and starts again the next day", async () => {
    const { scheduler, chat, advance, clock } = setup({ limits: { maxActivePerAgent: 10 } });
    clock.t = Date.parse("2026-10-18T08:00:00Z");
    await scheduler.create(researcher, { everyMinutes: 1, message: "ping" });
    for (let i = 0; i < 35; i++) await advance(MIN);
    expect(chat.deliveries).toHaveLength(30);
    expect(scheduler.firingsToday("researcher")).toBe(30);
    expect(scheduler.list()[0].lastError).toMatch(/daily limit reached: researcher was woken 30 times today/);
    // an at-reminder that comes due over the limit waits for the next day instead of being lost
    const late = await scheduler.create(researcher, { inMinutes: 1, message: "tomorrow" });
    await advance(MIN);
    expect(scheduler.get(late.id)!.active).toBe(true);
    clock.t = Date.parse("2026-10-19T08:00:00Z"); // next local day (same clock zone for both)
    await scheduler.tick(); // the "ping" goes first; the agent is busy with it during this tick
    await advance(1_000);
    expect(chat.deliveries.map((d) => d.body.text)).toContain("tomorrow");
    expect(scheduler.get(late.id)!.endedReason).toBe("fired");
  });
});

// ---- time-based firing -----------------------------------------------------------------------

describe("at and every (fake clock)", () => {
  it("fires an 'at' reminder once when due, with the scheduler body", async () => {
    const { scheduler, chat, advance } = setup();
    const s = await scheduler.create(researcher, { inMinutes: 1, message: "Check the weather in Oslo." });
    expect(s).toMatchObject({ kind: "at", source: "agent", label: "Reminder you set", fired: 0, active: true, at: new Date(T0 + MIN).toISOString() });
    expect(scheduler.view(s).summary).toBe("Reminder at 15:01 UTC · fires once");
    await advance(30_000);
    expect(chat.deliveries).toHaveLength(0);
    await advance(30_000);
    expect(chat.deliveries).toEqual([
      {
        agent: "researcher",
        body: { text: "Check the weather in Oslo.", source: "scheduler", scheduleId: s.id, setBy: "agent", label: "Reminder you set", context: "Reminder for 15:01 UTC, set at 15:00 UTC." },
      },
    ]);
    const after = scheduler.get(s.id)!;
    expect(after).toMatchObject({ active: false, endedReason: "fired", fired: 1, lastRunId: "run_1", lastFiredAt: new Date(T0 + MIN).toISOString() });
    await advance(10 * MIN);
    expect(chat.deliveries).toHaveLength(1);
  });

  it("fires 'every' on its period and skips runs it missed instead of bursting", async () => {
    const { scheduler, chat, advance } = setup();
    const s = await scheduler.create(researcher, { everyMinutes: 5, message: "Check your balance." });
    await advance(4 * MIN);
    expect(chat.deliveries).toHaveLength(0);
    await advance(MIN);
    await advance(5 * MIN);
    expect(chat.deliveries).toHaveLength(2);
    expect(chat.deliveries[1].body.context).toBe("Repeats every 5 minutes · run 2 · next 15:15 UTC.");
    await advance(17 * MIN); // 15:27: one catch-up run, not three
    expect(chat.deliveries).toHaveLength(3);
    expect(scheduler.get(s.id)!.nextRunAt).toBe(new Date(T0 + 32 * MIN).toISOString());
    expect(scheduler.get(s.id)!.active).toBe(true);
  });

  it("an 'every' with a start time and an expiry stops at the expiry", async () => {
    const { scheduler, chat, advance } = setup();
    const s = await scheduler.create(researcher, { everyMinutes: 1, at: new Date(T0 + 2 * MIN).toISOString(), expiresInMinutes: 4, message: "x" });
    for (let i = 0; i < 6; i++) await advance(MIN);
    expect(chat.deliveries).toHaveLength(2); // 15:02 and 15:03; expired at 15:04
    expect(scheduler.get(s.id)).toMatchObject({ active: false, endedReason: "expired" });
  });
});

// ---- price conditions ------------------------------------------------------------------------

describe("price conditions against a stub brokerage", () => {
  it("fires once when COF crosses $210, with the price and replay date as context", async () => {
    const { scheduler, chat, advance } = setup();
    const s = await scheduler.create(researcher, { condition: { ticker: "cof", op: ">=", price: 210 }, message: "COF hit your target. Tell your owner." });
    expect(s).toMatchObject({ kind: "price", label: "Price watch you set", checkEverySeconds: 10, condition: { ticker: "COF", op: ">=", price: 210 } });
    expect(scheduler.view(s).summary).toBe("Watching COF ≥ $210 · fires once");
    await scheduler.tick();
    expect(chat.deliveries).toHaveLength(0);
    expect(scheduler.get(s.id)!.lastObserved).toBe("COF $205.00 · 2025-11-03");
    brokerage.prices.set("COF", 212.4);
    await advance(5_000); // not yet: checks run at most every 10 s
    expect(chat.deliveries).toHaveLength(0);
    await advance(5_000);
    expect(chat.deliveries).toHaveLength(1);
    expect(chat.deliveries[0].body).toMatchObject({ text: "COF hit your target. Tell your owner.", label: "Price watch you set", setBy: "agent", context: "COF is $212.40 (≥ $210) · paper trading, replay date 2025-11-03." });
    expect(scheduler.get(s.id)).toMatchObject({ active: false, endedReason: "fired" });
    await advance(10_000);
    expect(chat.deliveries).toHaveLength(1);
  });

  it("batches tickers into one quotes request at most every 10 s", async () => {
    const { scheduler, advance } = setup();
    await scheduler.create(researcher, { condition: { ticker: "COF", op: ">=", price: 999 }, message: "a" });
    await scheduler.create(investor, { condition: { ticker: "JPM", op: "<=", price: 1 }, message: "b" });
    brokerage.quoteRequests.length = 0;
    await scheduler.tick();
    for (let i = 0; i < 5; i++) await advance(2_000);
    expect(brokerage.quoteRequests).toEqual(["COF,JPM", "COF,JPM"]);
  });

  it("repeats with every_minutes as a cooldown while the condition holds", async () => {
    const { scheduler, chat, advance } = setup();
    brokerage.prices.set("COF", 200);
    const s = await scheduler.create(researcher, { condition: { ticker: "COF", op: "<=", price: 201 }, everyMinutes: 5, message: "COF is cheap." });
    expect(scheduler.view(s).summary).toBe("Watching COF ≤ $201 · at most every 5 minutes");
    await scheduler.tick();
    expect(chat.deliveries).toHaveLength(1);
    for (let i = 0; i < 29; i++) await advance(10_000); // 4m50s
    expect(chat.deliveries).toHaveLength(1);
    await advance(10_000);
    expect(chat.deliveries).toHaveLength(2);
    expect(scheduler.get(s.id)!.active).toBe(true);
  });

  it("a move watch records the base price and fires on a 5% move", async () => {
    const { scheduler, chat, advance } = setup();
    brokerage.prices.set("COF", 200);
    const s = await scheduler.create(researcher, { condition: { ticker: "COF", movePct: -5 }, message: "COF dropped." });
    expect(s.condition).toEqual({ ticker: "COF", movePct: -5, basePrice: 200, baseDate: "2025-11-03" });
    brokerage.prices.set("COF", 191);
    await advance(10_000);
    expect(chat.deliveries).toHaveLength(0);
    brokerage.prices.set("COF", 189.5);
    await advance(10_000);
    expect(chat.deliveries[0].body.context).toBe("COF is $189.50, down 5.3% from $200.00 when the watch was set (watching for down 5%) · paper trading, replay date 2025-11-03.");
    // a move watch needs a base price, so it can't be set while prices are down
    brokerage.down = true;
    await expectError(scheduler.create(researcher, { condition: { ticker: "COF", movePct: 5 }, message: "x" }), 503, /Prices are unavailable/);
    // a threshold watch can (it is checked on every tick), and says why it can't check
    const t = await scheduler.create(researcher, { condition: { ticker: "COF", op: ">=", price: 1 }, message: "x" });
    await advance(10_000);
    expect(scheduler.get(t.id)!.lastError).toMatch(/prices unavailable/);
    expect(chat.deliveries).toHaveLength(1);
  });
});

// ---- owner rules -----------------------------------------------------------------------------

const portfolio = (positions: Array<{ ticker: string; avgCost: number; price: number; shares: number }>, realizedPnl = 0): Portfolio => {
  const rows = positions.map((p) => ({ ...p, value: p.shares * p.price, unrealizedPnl: p.shares * (p.price - p.avgCost), unrealizedPct: ((p.price - p.avgCost) / p.avgCost) * 100 }));
  const invested = rows.reduce((a, p) => a + p.shares * p.avgCost, 0);
  const value = rows.reduce((a, p) => a + p.value, 0);
  return { clockDate: "2025-11-03", positions: rows, totals: { invested, value, unrealizedPnl: value - invested, realizedPnl } };
};

describe("owner rules", () => {
  it("take profit, stop loss and cash out profits fire with fixed messages from the agent's portfolio", async () => {
    const { scheduler, chat, advance } = setup();
    const tp = (await scheduler.createRule(investor, { type: "take_profit", value: 10, ticker: "COF" })).schedule;
    const sl = (await scheduler.createRule(investor, { type: "stop_loss", value: 8, ticker: "JPM" })).schedule;
    const co = (await scheduler.createRule(investor, { type: "cash_out_profits", value: 50 })).schedule;
    expect(tp).toMatchObject({ source: "owner", kind: "price", label: "Rule: take profit on COF", everyMinutes: 10, rule: { type: "take_profit", value: 10, ticker: "COF" }, condition: { portfolio: "unrealizedPct", op: ">=", value: 10, ticker: "COF" } });
    expect(sl.condition).toEqual({ portfolio: "unrealizedPct", op: "<=", value: -8, ticker: "JPM" });
    expect(co.condition).toEqual({ portfolio: "unrealizedPnl", op: ">=", value: 50 });
    expect(scheduler.view(sl).summary).toBe("Rule: stop loss on JPM at −8%");
    expect(scheduler.view(co).summary).toBe("Rule: cash out profits above $50");
    expect(tp.message).toBe("Your owner's take-profit rule: when your COF position is up 10% or more, take the profit. It has reached that now. Sell your whole COF position with sell_stock, then tell your owner briefly what you sold and the realized profit.");

    // nothing invested: nothing fires
    await scheduler.tick();
    expect(chat.deliveries).toHaveLength(0);
    expect(brokerage.portfolioRequests[0]).toEqual({ address: investor.address, ownerKey: OWNER_KEY });
    expect(brokerage.portfolioRequests).toHaveLength(1); // one portfolio read per agent per check

    // COF +12%, JPM −9%, profit $24 → take profit and stop loss
    brokerage.portfolios.set(investor.address, portfolio([{ ticker: "COF", avgCost: 200, price: 224, shares: 1 }, { ticker: "JPM", avgCost: 300, price: 273, shares: 0.1 }]));
    await advance(10_000);
    // one delivery per agent per tick (it's busy after that); the second goes on the next tick
    await advance(1_000);
    expect(chat.deliveries.map((d) => d.body.label).sort()).toEqual(["Rule: stop loss on JPM", "Rule: take profit on COF"]);
    const tpFire = chat.deliveries.find((d) => d.body.scheduleId === tp.id)!.body;
    expect(tpFire).toMatchObject({ setBy: "owner", text: tp.message, context: "Your COF position is up 12.0% (≥ +10%), worth $224.00 · paper trading, replay date 2025-11-03." });
    expect(chat.deliveries.find((d) => d.body.scheduleId === sl.id)!.body.context).toBe("Your JPM position is down 9.0% (≤ −8%), worth $27.30 · paper trading, replay date 2025-11-03.");
    // rules stay active and don't re-fire before their cooldown
    expect(scheduler.get(tp.id)!.active).toBe(true);
    await advance(60_000);
    expect(chat.deliveries).toHaveLength(2);

    // profit above $50 → cash out
    brokerage.portfolios.set(investor.address, portfolio([{ ticker: "COF", avgCost: 200, price: 205, shares: 12 }]));
    await advance(10_000);
    const cash = chat.deliveries.find((d) => d.body.scheduleId === co.id)!.body;
    expect(cash.text).toMatch(/cash out profits above \$50.*cash_out/);
    expect(cash.context).toBe("Your unrealized profit is $60 (≥ $50) on $2,400.00 invested · paper trading, replay date 2025-11-03.");
  });

  it("a new rule of the same type and ticker replaces the old one; the agent can't remove owner rules", async () => {
    const { scheduler } = setup();
    const first = (await scheduler.createRule(investor, { type: "stop_loss", value: 8, ticker: "COF" })).schedule;
    const { schedule: second, replaced } = await scheduler.createRule(investor, { type: "stop_loss", value: 5, ticker: "COF" });
    expect(replaced?.id).toBe(first.id);
    expect(scheduler.get(first.id)).toMatchObject({ active: false, endedReason: "replaced" });
    expect(scheduler.list({ agentName: "investor" }).map((s) => s.id)).toEqual([second.id]);
    await expectError(() => scheduler.cancel(second.id, "agent", "investor"), 403, /your owner's rule \(stop loss on COF\); only your owner can remove it/);
    expect(scheduler.cancel(second.id, "owner")).toMatchObject({ active: false, endedReason: "cancelled", cancelledBy: "owner" });
    await expectError(scheduler.createRule(investor, { type: "stop_loss", value: 120 }), 400, /below 100/);
    await expectError(scheduler.createRule(investor, { type: "cash_out_profits", value: 50, ticker: "COF" }), 400, /whole portfolio/);
    await expectError(scheduler.createRule(investor, { type: "buy_the_dip", value: 5 }), 400, /type must be/);
  });
});

// ---- pause / resume, busy agents, delivery -----------------------------------------------------

describe("autonomy switch, busy agents, delivery", () => {
  it("while paused nothing fires; a reminder that came due fires after resume", async () => {
    const { scheduler, chat, advance } = setup();
    const at = await scheduler.create(researcher, { inMinutes: 1, message: "due during the pause" });
    await scheduler.create(researcher, { everyMinutes: 1, message: "repeating" });
    await scheduler.create(researcher, { condition: { ticker: "COF", op: ">=", price: 1 }, message: "always true" });
    scheduler.pause();
    expect(scheduler.paused).toBe(true);
    for (let i = 0; i < 5; i++) await advance(MIN);
    expect(chat.deliveries).toHaveLength(0);
    expect(brokerage.quoteRequests.filter((q) => q === "COF")).toHaveLength(1); // only the creation check
    scheduler.resume();
    for (let i = 0; i < 3; i++) await advance(1_000);
    // the one-off reminder that came due goes out; the repeating one skipped the runs it missed
    expect(chat.deliveries.map((d) => d.body.text).sort()).toEqual(["always true", "due during the pause"]);
    await advance(MIN);
    expect(chat.deliveries.map((d) => d.body.text)).toContain("repeating");
    expect(chat.deliveries.find((d) => d.body.scheduleId === at.id)!.body.context).toMatch(/^Reminder for 15:01 UTC, set at 15:00 UTC\. It is late: it's 15:05 UTC now\.$/);
  });

  it("retries while the agent is busy and delivers once it is idle (counted once)", async () => {
    const { scheduler, chat, advance } = setup({ busyRetryMs: 3000 });
    chat.busy.add("researcher");
    const s = await scheduler.create(researcher, { inMinutes: 1, message: "when you're free" });
    await advance(MIN);
    expect(scheduler.get(s.id)!.pending).toMatchObject({ attempts: 1, lastError: "the agent is busy" });
    await advance(1_000); // before the retry delay: no attempt
    expect(chat.attempts).toBe(1);
    await advance(2_000);
    expect(chat.attempts).toBe(2);
    chat.busy.delete("researcher");
    await advance(3_000);
    expect(chat.deliveries).toHaveLength(1);
    expect(scheduler.get(s.id)).toMatchObject({ active: false, endedReason: "fired", fired: 1 });
    expect(scheduler.firingsToday("researcher")).toBe(1);
  });

  it("gives up on a firing it can't deliver for 30 minutes; agents the chat doesn't host are marked needsChat", async () => {
    const { scheduler, chat, advance } = setup({ errorRetryMs: 60_000 });
    chat.down = true;
    const s = await scheduler.create(researcher, { inMinutes: 1, message: "x" });
    for (let i = 0; i < 32; i++) await advance(MIN);
    expect(scheduler.get(s.id)).toMatchObject({ active: false, endedReason: "missed" });
    expect(scheduler.get(s.id)!.lastError).toMatch(/gave up after 30 minutes: the chat server is not reachable/);

    chat.down = false;
    const desk = await scheduler.create({ id: "agt_d", name: "claude-desktop", address: "0x2" }, { inMinutes: 1, message: "never woken" });
    expect(desk.needsChat).toBe(true);
    expect(scheduler.view(desk).summary).toBe("Reminder at 15:33 UTC · fires once · needs the chat");
    const attempts = chat.attempts;
    await advance(2 * MIN);
    expect(chat.attempts).toBe(attempts); // not even tried: the chat doesn't host it
    expect(chat.deliveries).toHaveLength(0);
    expect(scheduler.get(desk.id)!.active).toBe(true);
    // once the chat hosts it, it fires
    chat.hostedNames!.add("claude-desktop");
    await advance(1_000);
    expect(chat.deliveries.map((d) => d.agent)).toEqual(["claude-desktop"]);
  });

  it("persists schedules, the pause switch and firing counts in schedules.json (0600)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allowance-sched-"));
    const file = join(dir, "schedules.json");
    const a = setup({}, file);
    const s = await a.scheduler.create(researcher, { everyMinutes: 1, message: "persist me" });
    await a.advance(MIN);
    a.scheduler.pause();
    const b = setup({}, file);
    expect(b.scheduler.paused).toBe(true);
    expect(b.scheduler.get(s.id)).toMatchObject({ message: "persist me", fired: 1, active: true });
    expect(b.scheduler.firingsToday("researcher")).toBe(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
  });
});

// ---- HTTP: auth, isolation, owner API, token on fire --------------------------------------------

describe("HTTP API", () => {
  let wallet: WalletStub;
  let server: Server;
  let base: string;
  let ctx: ReturnType<typeof setup>;
  let tokA: string;
  let tokB: string;

  beforeAll(async () => {
    wallet = await startWalletStub();
    tokA = wallet.addToken("researcher");
    tokB = wallet.addToken("shopper");
    ctx = setup();
    const real = httpWallet({ walletServiceUrl: wallet.url });
    const owners = new Map([researcher, investor].map((a) => [a.name, a]));
    const walletAuth: WalletAuth = { me: (t) => real.me(t), agentByName: async (n) => owners.get(n) ?? null };
    const app = createSchedulerApp({ scheduler: ctx.scheduler, wallet: walletAuth, ownerApiKey: OWNER_KEY, quiet: true });
    server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(() => r(null)));
    await wallet.close();
  });

  const call = async (method: string, path: string, opts: { token?: string; owner?: string; body?: unknown } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.owner ? { "x-owner-key": opts.owner } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  it("verifies agent tokens with the wallet; an agent sees and cancels only its own schedules", async () => {
    expect((await call("GET", "/schedules")).status).toBe(401);
    expect((await call("GET", "/schedules", { token: "aw_" + "00".repeat(24) })).body.error).toBe("token_rejected");
    const made = await call("POST", "/schedules", { token: tokA, body: { inMinutes: 5, message: "A's reminder" } });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ needsChat: false, paused: false, firingsToday: 0, schedule: { agentName: "researcher", agentId: "agt_researcher", source: "agent", summary: "Reminder at 15:05 UTC · fires once" } });
    const id = made.body.schedule.id as string;
    expect(id).toMatch(/^sch_[0-9a-f]{16}$/);
    // B can't see or cancel it
    expect((await call("GET", "/schedules", { token: tokB })).body.schedules).toEqual([]);
    expect(await call("DELETE", `/schedules/${id}`, { token: tokB })).toMatchObject({ status: 404, body: { error: "schedule_not_found" } });
    expect((await call("GET", "/schedules", { token: tokA })).body.schedules.map((s: Schedule) => s.id)).toEqual([id]);
    // over a limit → 400 with a plain message
    expect(await call("POST", "/schedules", { token: tokA, body: { everyMinutes: 0, message: "x" } })).toMatchObject({ status: 400, body: { error: "limit_every", message: "Repeating schedules must be at least 1 minute apart." } });
    // A cancels its own
    expect((await call("DELETE", `/schedules/${id}`, { token: tokA })).body.schedule).toMatchObject({ active: false, endedReason: "cancelled", cancelledBy: "agent" });
    expect((await call("GET", "/schedules?all=1", { token: tokA })).body.schedules[0].summary).toBe("Reminder at 15:05 UTC · fires once · cancelled");
  });

  it("owner API: needs X-Owner-Key; lists all, creates rules, cancels any, pauses and resumes", async () => {
    await call("POST", "/schedules", { token: tokB, body: { inMinutes: 10, message: "B's" } });
    expect((await call("GET", "/owner/schedules")).status).toBe(401);
    expect((await call("GET", "/owner/schedules", { owner: "wrong" })).status).toBe(401);
    expect((await call("POST", "/pause", { token: tokA })).status).toBe(401); // an agent can't flip the switch
    const rule = await call("POST", "/owner/rules", { owner: OWNER_KEY, body: { agent: "researcher", type: "take_profit", value: 15, ticker: "COF" } });
    expect(rule.status).toBe(201);
    expect(rule.body.schedule).toMatchObject({ source: "owner", label: "Rule: take profit on COF", summary: "Rule: take profit on COF at +15%", agentAddress: researcher.address });
    expect((await call("POST", "/owner/rules", { owner: OWNER_KEY, body: { agent: "nobody", type: "take_profit", value: 15 } })).status).toBe(404);
    const all = await call("GET", "/owner/schedules", { owner: OWNER_KEY });
    expect(all.body.schedules.map((s: Schedule) => `${s.agentName}:${s.source}`).sort()).toEqual(["researcher:owner", "shopper:agent"]);
    expect(all.body).toMatchObject({ paused: false, limits: { maxActivePerAgent: 10, minEveryMinutes: 1, minCheckSeconds: 10, maxFiringsPerDay: 30 } });
    // the agent sees its owner's rule but can't remove it
    const mine = await call("GET", "/schedules", { token: tokA });
    expect(mine.body.schedules.map((s: Schedule) => s.source)).toEqual(["owner"]);
    expect(await call("DELETE", `/schedules/${rule.body.schedule.id}`, { token: tokA })).toMatchObject({ status: 403, body: { error: "owner_rule" } });
    // the owner can
    const shopperId = all.body.schedules.find((s: Schedule) => s.agentName === "shopper").id;
    expect((await call("DELETE", `/owner/schedules/${shopperId}`, { owner: OWNER_KEY })).body.schedule).toMatchObject({ endedReason: "cancelled", cancelledBy: "owner" });
    expect((await call("POST", "/pause", { owner: OWNER_KEY })).body).toMatchObject({ paused: true, pausedAt: expect.any(String) });
    expect((await call("GET", "/schedules", { token: tokA })).body.paused).toBe(true);
    expect((await call("POST", "/owner/resume", { owner: OWNER_KEY })).body.paused).toBe(false);
    expect((await call("GET", "/health")).body).toMatchObject({ ok: true, paused: false });
  });
});

describe("firing over HTTP with the scheduler token", () => {
  it("creates the token file once (0600), sends it as X-Scheduler-Token, and reports a wrong token as rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "allowance-stok-"));
    const token = ensureSchedulerToken(dir);
    expect(token).toMatch(/^st_[0-9a-f]{48}$/);
    expect(ensureSchedulerToken(dir)).toBe(token);
    expect(readSchedulerToken(dir)).toBe(token);
    expect(statSync(join(dir, "scheduler-token.json")).mode & 0o777).toBe(0o600);

    const seen: Array<{ token?: string; body: FireBody }> = [];
    let busy = false;
    const app = express();
    app.use(express.json());
    app.get("/api/agents", (_req, res) => res.json({ agents: [{ name: "researcher" }] }));
    app.post("/api/agents/:name/messages", (req, res) => {
      seen.push({ token: req.header("x-scheduler-token") ?? undefined, body: req.body });
      if (req.body.source === "scheduler" && req.header("x-scheduler-token") !== token) return void res.status(403).json({ error: "forbidden" });
      if (req.params.name !== "researcher") return void res.status(404).json({ error: "agent_not_found" });
      if (busy) return void res.status(409).json({ error: "agent_busy" });
      res.status(202).json({ agent: req.params.name, runId: "run_abc" });
    });
    const server: Server = await new Promise((r) => {
      const s = app.listen(0, "127.0.0.1", () => r(s));
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const body: FireBody = { text: "hi", source: "scheduler", scheduleId: "sch_1", setBy: "agent", label: "Reminder you set", context: "now" };
      const chat = httpChat({ agentChatUrl: url, token });
      expect(await chat.hosted()).toEqual(new Set(["researcher"]));
      expect(await chat.deliver("researcher", body)).toEqual({ ok: true, runId: "run_abc" });
      expect(seen[0]).toEqual({ token, body });
      busy = true;
      expect(await chat.deliver("researcher", body)).toMatchObject({ ok: false, reason: "busy" });
      busy = false;
      expect(await chat.deliver("claude-desktop", body)).toMatchObject({ ok: false, reason: "not_hosted" });
      expect(await httpChat({ agentChatUrl: url, token: "st_wrong" }).deliver("researcher", body)).toMatchObject({ ok: false, reason: "rejected" });
      expect(await httpChat({ agentChatUrl: "http://127.0.0.1:1", token }).deliver("researcher", body)).toMatchObject({ ok: false, reason: "unreachable" });
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});
