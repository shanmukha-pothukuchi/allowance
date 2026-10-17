import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockAdapter } from "./mockAdapter";
import type { WalletEvent } from "../types";

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
    expect(await pending).toHaveLength(1); // still pending

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
    expect(list).toHaveLength(0);

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
});
