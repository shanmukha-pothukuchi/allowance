import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockAdapter } from "./mockAdapter";
import type { Approval, WalletEvent } from "../types";

describe("mockAdapter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds the 8 demo agents with $20 each", async () => {
    const m = createMockAdapter({ seed: 1, latencyMs: 0 });
    const p = m.getSummary();
    await vi.advanceTimersByTimeAsync(1);
    const s = await p;
    expect(s.agents.map((a) => a.name)).toEqual(["claude-desktop", "researcher", "shopper", "naive-worker", "worker-1", "worker-2", "worker-3", "worker-4"]);
    expect(s.totalBalance).toBe("160.00");
    expect(s.chainMode).toBe("mock");
    expect(s.agents.find((a) => a.name === "researcher")!.policy.maxPerTx).toBe("1.00");
  });

  it("is deterministic for a given seed", () => {
    const a = createMockAdapter({ seed: 7 });
    const b = createMockAdapter({ seed: 7 });
    const ea: string[] = [];
    const eb: string[] = [];
    for (let i = 0; i < 30; i++) {
      ea.push(...a.tick().map((e) => e.type + ":" + e.agentName + ":" + (e.receipt?.amount ?? "")));
      eb.push(...b.tick().map((e) => e.type + ":" + e.agentName + ":" + (e.receipt?.amount ?? "")));
    }
    expect(ea).toEqual(eb);
    a.stop();
    b.stop();
  });

  it("plays the scripted opening: earnings, payments, one approval, one block + freeze", () => {
    const m = createMockAdapter({ seed: 3 });
    const types: string[] = [];
    for (let i = 0; i < 8; i++) types.push(...m.tick().map((e) => e.type));
    expect(types).toEqual([
      "earning.received",
      "payment.signed",
      "earning.received",
      "payment.signed",
      "payment.needs_approval",
      "earning.received",
      "payment.blocked",
      "agent.frozen",
      "payment.signed",
    ]);
    const blocked = m.tick; // keep reference; ensure a second block never happens in steady state
    const more: string[] = [];
    for (let i = 0; i < 60; i++) more.push(...blocked().map((e) => e.type));
    expect(more.filter((t) => t === "payment.blocked")).toHaveLength(0);
    m.stop();
  });

  it("emits on a 2-4 s cadence to subscribers and settles payments shortly after signing", async () => {
    const m = createMockAdapter({ seed: 5, latencyMs: 0 });
    const got: WalletEvent[] = [];
    const unsub = m.subscribe((e) => got.push(e));
    await vi.advanceTimersByTimeAsync(1999);
    expect(got).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2001); // t = 4 s: first step has fired
    expect(got.length).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(30_000);
    const types = got.map((e) => e.type);
    expect(types.length).toBeGreaterThanOrEqual(8);
    expect(types.length).toBeLessThanOrEqual(30);
    expect(types).toContain("payment.signed");
    expect(types).toContain("payment.settled");
    expect(types).toContain("earning.received");
    expect(types).toContain("payment.needs_approval");
    expect(types).toContain("payment.blocked");
    expect(types).toContain("agent.frozen");
    // the settled event carries a tx hash and the same receipt id as the signed one
    const signed = got.find((e) => e.type === "payment.signed")!;
    const settled = got.find((e) => e.type === "payment.settled" && e.receipt?.id === signed.receipt!.id)!;
    expect(settled.receipt!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    // every event has a friendly dollar message
    for (const e of got) expect(e.message).toMatch(/\$\d+\.\d{2}|frozen|unfrozen/);
    unsub();
    expect(m.listenerCount()).toBe(0);
    m.stop();
  });

  it("keeps an approval pending until the UI approves; approve signs then settles", async () => {
    const m = createMockAdapter({ seed: 3, latencyMs: 0, settleDelayMs: 100 });
    const got: WalletEvent[] = [];
    m.subscribe((e) => got.push(e));
    for (let i = 0; i < 5; i++) m.tick(); // reaches the pizza approval
    let pending = m.getPendingApprovals();
    await vi.advanceTimersByTimeAsync(1);
    let list = await pending;
    expect(list).toHaveLength(1);
    expect(list[0].amount).toBe("18.50");
    expect(list[0].agentName).toBe("shopper");

    for (let i = 0; i < 10; i++) m.tick();
    pending = m.getPendingApprovals();
    await vi.advanceTimersByTimeAsync(1);
    // the opening also asks to connect services; those are separate (kind "service") approvals
    const payments = (xs: Approval[]) => xs.filter((a) => a.kind !== "service");
    expect(payments(await pending)).toHaveLength(1); // still pending

    await vi.advanceTimersByTimeAsync(200); // flush settlements of earlier random payments
    const beforeP = m.getSummary();
    await vi.advanceTimersByTimeAsync(1);
    const before = (await beforeP).agents.find((a) => a.name === "shopper")!;

    const approved = m.approve(list[0].id);
    await vi.advanceTimersByTimeAsync(1);
    expect((await approved).status).toBe("approved");
    expect(got.at(-1)!.type).toBe("approval.approved");
    await vi.advanceTimersByTimeAsync(200);
    expect(got.at(-1)!.type).toBe("payment.settled");
    expect(got.at(-1)!.receipt!.amount).toBe("18.50");

    pending = m.getPendingApprovals();
    await vi.advanceTimersByTimeAsync(1);
    list = await pending;
    expect(payments(list)).toHaveLength(0);

    const summaryP = m.getSummary();
    await vi.advanceTimersByTimeAsync(1);
    const shopper = (await summaryP).agents.find((a) => a.name === "shopper")!;
    expect((Number(shopper.spentToday) - Number(before.spentToday)).toFixed(2)).toBe("18.50");
    expect((Number(before.balance) - Number(shopper.balance)).toFixed(2)).toBe("18.50");
    m.stop();
  });

  it("deny marks the receipt denied and emits approval.denied", async () => {
    const m = createMockAdapter({ seed: 3, latencyMs: 0 });
    const got: WalletEvent[] = [];
    m.subscribe((e) => got.push(e));
    for (let i = 0; i < 5; i++) m.tick();
    const id = got.find((e) => e.type === "payment.needs_approval")!.approval!.id;
    const p = m.deny(id);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).status).toBe("denied");
    expect(got.at(-1)!.type).toBe("approval.denied");
    expect(got.at(-1)!.receipt!.status).toBe("denied");
    m.stop();
  });

  it("freeze / unfreeze / topup emit agent events and change balances", async () => {
    const m = createMockAdapter({ seed: 9, latencyMs: 0 });
    const got: WalletEvent[] = [];
    m.subscribe((e) => got.push(e));
    const agentsP = m.getAgents();
    await vi.advanceTimersByTimeAsync(1);
    const researcher = (await agentsP).find((a) => a.name === "researcher")!;

    let p = m.freeze(researcher.id);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).frozen).toBe(true);
    expect(got.at(-1)!.type).toBe("agent.frozen");

    p = m.unfreeze(researcher.id);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).frozen).toBe(false);
    expect(got.at(-1)!.type).toBe("agent.unfrozen");

    const t = m.topup(researcher.id, "20.00");
    await vi.advanceTimersByTimeAsync(1);
    const r = await t;
    expect(r.kind).toBe("topup");
    expect(got.at(-1)!.type).toBe("topup");
    const s = m.getSummary();
    await vi.advanceTimersByTimeAsync(1);
    expect((await s).agents.find((a) => a.id === researcher.id)!.balance).toBe("40.00");
    m.stop();
  });

  it("a frozen agent does not pay in the random stream", () => {
    const m = createMockAdapter({ seed: 11 });
    for (let i = 0; i < 8; i++) m.tick(); // opening freezes naive-worker
    const events: WalletEvent[] = [];
    for (let i = 0; i < 80; i++) events.push(...m.tick());
    expect(events.filter((e) => e.agentName === "naive-worker" && e.type === "payment.signed")).toHaveLength(0);
    m.stop();
  });

  describe("services", () => {
    const flush = async <T>(p: Promise<T>) => {
      await vi.advanceTimersByTimeAsync(1);
      return p;
    };
    /** Attach the rejection handler before the fake timer fires, so nothing is unhandled. */
    const rejects = async (p: Promise<unknown>, re: RegExp) => {
      const check = expect(p).rejects.toThrow(re);
      await vi.advanceTimersByTimeAsync(1);
      await check;
    };

    it("serves the six directory services of §13.1, without docs in the list, with docs by id", async () => {
      const m = createMockAdapter({ seed: 1, latencyMs: 0 });
      const list = await flush(m.getDirectory());
      expect(list.map((s) => s.id)).toEqual(["directory", "acme-weather", "acme-news", "acme-stocks", "acme-pizza", "acme-bounties"]);
      expect(list.every((s) => s.docs === undefined)).toBe(true);
      expect(list.find((s) => s.id === "acme-pizza")!.maxPrice).toBe("18.50");
      expect(list.find((s) => s.id === "acme-bounties")!.kind).toBe("agent-work");
      expect((await flush(m.getDirectory("pizza"))).map((s) => s.id)).toEqual(["acme-pizza"]);
      const pizza = await flush(m.getService("acme-pizza"));
      expect(pizza.docs).toMatch(/POST .*\/pizza\/order/);
      await rejects(m.getService("nope"), /No service/);
      m.stop();
    });

    it("seeds the default connections of §13.2 and reports them as connectedAgents", async () => {
      const m = createMockAdapter({ seed: 1, latencyMs: 0 });
      const agents = await flush(m.getAgents());
      const ids = (name: string) => agents.find((a) => a.name === name)!.services.map((s) => s.id);
      expect(ids("researcher")).toEqual(["acme-weather", "acme-news", "acme-stocks"]);
      expect(ids("shopper")).toEqual([]);
      expect(ids("claude-desktop")).toEqual(["acme-bounties", "acme-weather"]);
      for (const n of ["naive-worker", "worker-1", "worker-2", "worker-3", "worker-4"]) expect(ids(n)).toEqual(["acme-bounties"]);
      expect(agents.every((a) => a.services.every((s) => s.connectedBy === "default"))).toBe(true);
      expect(agents.every((a) => a.policy.allowlist?.addresses.length === 0 && a.policy.allowlist.origins.length === 0)).toBe(true);
      const weather = (await flush(m.getDirectory())).find((s) => s.id === "acme-weather")!;
      expect(weather.connectedAgents!.map((id) => agents.find((a) => a.id === id)!.name).sort()).toEqual(["claude-desktop", "researcher"]);
      m.stop();
    });

    it("the opening asks: shopper wants to connect Acme Pizza, with its reason", () => {
      const m = createMockAdapter({ seed: 3 });
      const got: WalletEvent[] = [];
      for (let i = 0; i < 9; i++) got.push(...m.tick());
      const req = got.at(-1)!;
      expect(req.type).toBe("service.requested");
      expect(req.agentName).toBe("shopper");
      expect(req.approval).toMatchObject({ kind: "service", paymentId: "", amount: "18.50", status: "pending", service: { id: "acme-pizza", source: "directory" } });
      expect(req.approval!.reason).toMatch(/pizza/i);
      expect(req.message).toMatch(/^shopper wants to connect Acme Pizza/);
      // later in the opening: an agent-proposed custom service
      const later: WalletEvent[] = [];
      for (let i = 0; i < 3; i++) later.push(...m.tick());
      const custom = later.find((e) => e.type === "service.requested")!;
      expect(custom.approval!.service).toMatchObject({ id: "custom-hacker-news-digest", source: "agent", baseUrl: "https://hn-digest.example.com/api" });
      m.stop();
    });

    it("approving a service request connects it (approval.approved, then service.connected, by approval)", async () => {
      const m = createMockAdapter({ seed: 3, latencyMs: 0 });
      const got: WalletEvent[] = [];
      m.subscribe((e) => got.push(e));
      for (let i = 0; i < 9; i++) m.tick();
      const id = got.find((e) => e.type === "service.requested")!.approval!.id;
      const a = await flush(m.approve(id));
      expect(a.status).toBe("approved");
      expect(got.slice(-2).map((e) => e.type)).toEqual(["approval.approved", "service.connected"]);
      expect(got.at(-1)!.data).toMatchObject({ connectedBy: "approval", service: { id: "acme-pizza" } });
      expect(got.at(-1)!.message).toBe("Acme Pizza connected to shopper.");
      const shopper = (await flush(m.getAgents())).find((x) => x.name === "shopper")!;
      expect(shopper.services.map((s) => [s.id, s.connectedBy])).toEqual([["acme-pizza", "approval"]]);
      expect((await flush(m.getPendingApprovals())).some((x) => x.id === id)).toBe(false);
      await rejects(m.approve(id), /no longer pending/);
      m.stop();
    });

    it("denying a service request connects nothing and makes no receipt", async () => {
      const m = createMockAdapter({ seed: 3, latencyMs: 0 });
      const got: WalletEvent[] = [];
      m.subscribe((e) => got.push(e));
      for (let i = 0; i < 9; i++) m.tick();
      const before = (await flush(m.getReceipts())).length;
      const id = got.find((e) => e.type === "service.requested")!.approval!.id;
      expect((await flush(m.deny(id))).status).toBe("denied");
      expect(got.at(-1)!.type).toBe("approval.denied");
      expect((await flush(m.getAgents())).find((x) => x.name === "shopper")!.services).toEqual([]);
      expect((await flush(m.getReceipts())).length).toBe(before);
      m.stop();
    });

    it("the owner connects and disconnects directly (by you), with events", async () => {
      const m = createMockAdapter({ seed: 1, latencyMs: 0 });
      const got: WalletEvent[] = [];
      m.subscribe((e) => got.push(e));
      const shopper = (await flush(m.getAgents())).find((a) => a.name === "shopper")!;
      let agent = await flush(m.connectService(shopper.id, "acme-weather"));
      expect(agent.services.map((s) => [s.id, s.connectedBy])).toEqual([["acme-weather", "owner"]]);
      expect(got.at(-1)!.type).toBe("service.connected");
      agent = await flush(m.connectService(shopper.id, "acme-weather")); // idempotent, no second event
      expect(agent.services).toHaveLength(1);
      expect(got.filter((e) => e.type === "service.connected")).toHaveLength(1);
      agent = await flush(m.disconnectService(shopper.id, "acme-weather"));
      expect(agent.services).toEqual([]);
      expect(got.at(-1)).toMatchObject({ type: "service.disconnected", message: "Acme Weather disconnected from shopper.", data: { serviceId: "acme-weather" } });
      await rejects(m.connectService(shopper.id, "directory"), /always available/);
      await rejects(m.connectService(shopper.id, "acme-nope"), /No service/);
      m.stop();
    });

    it("getApproval finds scripted approvals by id on a fresh adapter (the embed), and null for unknown ids", async () => {
      const m = createMockAdapter({ seed: 42, latencyMs: 0 });
      const a = await flush(m.getApproval("apr_demo_connect"));
      expect(a).toMatchObject({ id: "apr_demo_connect", kind: "service", agentName: "shopper", status: "pending" });
      expect(await flush(m.getApproval("apr_demo_pizza"))).toMatchObject({ kind: "payment", amount: "18.50" });
      expect(await flush(m.getApproval("apr_unknown"))).toBeNull();
      m.stop();
    });

    it("random payments only go through services the agent has connected", () => {
      const m = createMockAdapter({ seed: 13 });
      const events: WalletEvent[] = [];
      for (let i = 0; i < 120; i++) events.push(...m.tick());
      const paid = events.filter((e) => e.type === "payment.signed");
      expect(paid.length).toBeGreaterThan(5);
      const allowed: Record<string, string[]> = { researcher: ["Acme Weather", "Acme News", "Acme Stocks"], "claude-desktop": ["Acme Weather"] };
      for (const e of paid) expect(allowed[e.agentName!] ?? []).toContain(e.receipt!.description);
      m.stop();
    });

    it("pairs the block and the freeze on one receiptId (§6)", () => {
      const m = createMockAdapter({ seed: 3 });
      const got: WalletEvent[] = [];
      for (let i = 0; i < 7; i++) got.push(...m.tick());
      const blocked = got.find((e) => e.type === "payment.blocked")!;
      const frozen = got.find((e) => e.type === "agent.frozen")!;
      expect(blocked.data).toMatchObject({ frozen: true, willFreeze: true, receiptId: blocked.receipt!.id });
      expect(frozen.data).toMatchObject({ cause: "policy_violation", receiptId: blocked.receipt!.id });
      m.stop();
    });
  });
});
