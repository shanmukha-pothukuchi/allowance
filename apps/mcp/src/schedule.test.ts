import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
// The real scheduler service (apps/scheduler), in process, behind its HTTP API.
import { createSchedulerApp } from "../../scheduler/src/app.js";
import { Scheduler } from "../../scheduler/src/engine.js";
import { ScheduleStore } from "../../scheduler/src/store.js";
import type { ChatClient } from "../../scheduler/src/chat.js";
import type { MarketData } from "../../scheduler/src/market.js";
import { httpWallet } from "../../scheduler/src/wallet.js";
import { registerScheduleTools } from "./schedule.js";
import { startWalletStub, type WalletStub } from "./test-stubs.js";

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("\n");

const T0 = Date.parse("2026-10-18T15:00:00.000Z");
const clock = { t: T0 };
const chat: ChatClient = { deliver: async () => ({ ok: true, runId: "run_1" }), hosted: async () => new Set(["researcher"]) };
const market: MarketData = {
  quotes: async (tickers) => ({ clockDate: "2025-11-03", mode: "replay", quotes: tickers.filter((t) => t === "COF").map((t) => ({ ticker: t, price: 200 })) }),
  portfolio: async () => ({ positions: [], totals: { invested: 0, value: 0, unrealizedPnl: 0, realizedPnl: 0 } }),
};

let wallet: WalletStub;
let server: Server;
let schedulerUrl: string;
let scheduler: Scheduler;
let researcherToken: string;

beforeAll(async () => {
  wallet = await startWalletStub();
  researcherToken = wallet.addToken("researcher");
  scheduler = new Scheduler({ store: new ScheduleStore(), chat, market, now: () => clock.t, log: () => {} });
  const app = createSchedulerApp({ scheduler, wallet: httpWallet({ walletServiceUrl: wallet.url }), ownerApiKey: "ok_test", quiet: true });
  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  schedulerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(() => r(null)));
  await wallet.close();
});
beforeEach(() => {
  clock.t = T0;
  for (const s of scheduler.list()) scheduler.cancel(s.id, "owner");
  scheduler.resume();
});

async function connect(token: string, url = schedulerUrl) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerScheduleTools(server, { agentToken: token, schedulerUrl: url, now: () => clock.t, log: () => {} });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return {
    client,
    call: async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const ID = "sch_[0-9a-f]{16}";

describe("schedule_task", () => {
  it("confirms plainly for each kind, with the schedule id", async () => {
    const mcp = await connect(researcherToken);
    try {
      const at = await mcp.call("schedule_task", { in_minutes: 1, message: "Check the weather in Oslo." });
      expect(at.isError).toBeFalsy();
      expect(textOf(at)).toMatch(new RegExp(`^Reminder set: I'll wake you at 15:01 UTC \\(in 1 minute\\) with "Check the weather in Oslo\\." \\(fires once\\)\\. Your owner can see and cancel it\\. Schedule id: ${ID}\\.$`));
      expect(at.structuredContent).toMatchObject({ needsChat: false, paused: false, schedule: { kind: "at", agentName: "researcher", source: "agent" } });

      const every = await mcp.call("schedule_task", { every_minutes: 30, message: "Check your balance." });
      expect(textOf(every)).toMatch(new RegExp(`^Reminder set: I'll wake you every 30 minutes with "Check your balance\\.", first at 15:30 UTC, until it is cancelled\\. Your owner can see and cancel it\\. Schedule id: ${ID}\\.$`));

      const above = await mcp.call("schedule_task", { when: { ticker: "COF", above: 210 }, message: "COF hit $210. Tell your owner." });
      expect(textOf(above)).toMatch(new RegExp(`^Reminder set: I'll check COF's paper-trading price every 10 seconds until it is at or above \\$210 \\(fires once\\)\\. Your owner can see and cancel it\\. Schedule id: ${ID}\\.$`));
      expect(above.structuredContent!.schedule).toMatchObject({ kind: "price", condition: { ticker: "COF", op: ">=", price: 210 }, summary: "Watching COF ≥ $210 · fires once" });

      const repeat = await mcp.call("schedule_task", { when: { ticker: "cof", below: 190.5 }, every_minutes: 5, message: "COF is cheap." });
      expect(textOf(repeat)).toMatch(/^Reminder set: I'll check COF's paper-trading price every 10 seconds and wake you whenever it is at or below \$190\.50, at most once every 5 minutes, until it is cancelled\. Your owner can see/);

      const move = await mcp.call("schedule_task", { when: { ticker: "COF", move_pct: -5 }, message: "COF fell." });
      expect(textOf(move)).toMatch(/until it is down 5% from \$200\.00 \(fires once\)\./);
    } finally {
      await mcp.close();
    }
  });

  it("explains bad input and the scheduler's limits plainly", async () => {
    const mcp = await connect(researcherToken);
    try {
      const none = await mcp.call("schedule_task", { message: "x" });
      expect(none.isError).toBe(true);
      expect(textOf(none)).toBe("Say when: in_minutes (or at) for a one-off reminder, every_minutes to repeat, or when for a price watch.");
      expect(textOf(await mcp.call("schedule_task", { when: { ticker: "COF", above: 1, below: 2 }, message: "x" }))).toMatch(/exactly one of above, below or move_pct/);
      expect(textOf(await mcp.call("schedule_task", { when: { ticker: "COF", above: 1 }, in_minutes: 5, message: "x" }))).toBe("A price watch starts now: leave out in_minutes and at.");
      const tooOften = await mcp.call("schedule_task", { every_minutes: 0.5, message: "x" });
      expect(tooOften.isError).toBe(true);
      expect(textOf(tooOften)).toBe("Repeating schedules must be at least 1 minute apart.");
      expect(textOf(await mcp.call("schedule_task", { when: { ticker: "ZZZZ", above: 1 }, message: "x" }))).toMatch(/no ticker ZZZZ/);
      for (let i = 0; i < 10; i++) expect((await mcp.call("schedule_task", { in_minutes: 10 + i, message: `n${i}` })).isError).toBeFalsy();
      expect(textOf(await mcp.call("schedule_task", { in_minutes: 60, message: "eleventh" }))).toBe("researcher already has 10 active schedules, the most allowed. Cancel one first.");
    } finally {
      await mcp.close();
    }
  });

  it("tells a Claude Desktop agent its schedule only fires for chat-hosted agents, and says when the owner paused", async () => {
    const desk = await connect(wallet.token); // the stub's default token is "claude-desktop", which the chat doesn't host
    try {
      const r = await desk.call("schedule_task", { in_minutes: 5, message: "x" });
      expect(textOf(r)).toMatch(/Schedule id: sch_[0-9a-f]+\. Note: you aren't running in the Allowance chat \(for example, you're in Claude Desktop\), so nothing can wake you: the schedule is saved and your owner sees it, but schedules only fire for agents hosted by the Allowance chat\.$/);
      expect(textOf(await desk.call("list_schedules"))).toMatch(/needs the chat[\s\S]*schedules only fire for agents hosted by the Allowance chat/);
      scheduler.pause();
      const mcp = await connect(researcherToken);
      expect(textOf(await mcp.call("schedule_task", { in_minutes: 5, message: "x" }))).toMatch(/ Your owner has paused all schedules right now, so it won't fire until they resume\.$/);
      expect(textOf(await mcp.call("list_schedules"))).toMatch(/Your owner has paused all schedules: nothing fires until they resume\./);
      await mcp.close();
    } finally {
      await desk.close();
    }
  });

  it("says plainly when the scheduler isn't running", async () => {
    const mcp = await connect(researcherToken, "http://127.0.0.1:1");
    try {
      const r = await mcp.call("schedule_task", { in_minutes: 1, message: "x" });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe("The scheduler isn't running at http://127.0.0.1:1, so reminders can't be set or read right now. Start it with `npm run dev`.");
    } finally {
      await mcp.close();
    }
  });
});

describe("list_schedules and cancel_schedule", () => {
  it("lists own schedules and the owner's rules; cancels only its own", async () => {
    const mcp = await connect(researcherToken);
    const other = await connect(wallet.addToken("shopper"));
    try {
      expect(textOf(await mcp.call("list_schedules"))).toBe("You have no active schedules. schedule_task sets a reminder or a price watch.");
      const set = await mcp.call("schedule_task", { in_minutes: 3, message: "Check the weather." });
      const id = (set.structuredContent!.schedule as { id: string }).id;
      const rule = await scheduler.createRule({ name: "researcher", id: "agt_researcher", address: wallet.address }, { type: "stop_loss", value: 8, ticker: "COF" });
      const list = textOf(await mcp.call("list_schedules"));
      expect(list.split("\n")).toEqual([
        "Your schedules (2 active). Your owner can see and cancel all of them:",
        `- ${id} · Reminder at 15:03 UTC · fires once (in 3 minutes) · "Check the weather."`,
        `- ${rule.schedule.id} · Your owner's rule: stop loss on COF at −8% · only your owner can remove it`,
        "Woken 0 of 30 times today.",
      ]);
      // another agent can't see or cancel it
      expect(textOf(await other.call("list_schedules"))).toMatch(/^You have no active schedules/);
      expect(textOf(await other.call("cancel_schedule", { id }))).toBe(`There is no schedule ${id} of yours. list_schedules shows them.`);
      // the owner's rule can't be removed by the agent
      const ruleCancel = await mcp.call("cancel_schedule", { id: rule.schedule.id });
      expect(ruleCancel.isError).toBe(true);
      expect(textOf(ruleCancel)).toBe(`${rule.schedule.id} is your owner's rule (stop loss on COF); only your owner can remove it.`);
      const ok = await mcp.call("cancel_schedule", { id });
      expect(ok.isError).toBeFalsy();
      expect(textOf(ok)).toBe(`Cancelled ${id} (Reminder at 15:03 UTC · fires once). It won't fire.`);
      expect(textOf(await mcp.call("cancel_schedule", { id }))).toBe(`${id} already ended (cancelled).`);
      expect(textOf(await mcp.call("cancel_schedule", { id: "oops" }))).toMatch(/isn't a schedule id/);
    } finally {
      await mcp.close();
      await other.close();
    }
  });
});
