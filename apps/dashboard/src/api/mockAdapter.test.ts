import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "./adapter";
import { createMockAdapter, MOCK_BANK_LAST4, mockBankMode } from "./mockAdapter";
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

    it("serves the six directory services of §13.1 plus the owner's Shopify store, without docs in the list, with docs by id", async () => {
      const m = createMockAdapter({ seed: 1, latencyMs: 0 });
      const list = await flush(m.getDirectory());
      expect(list.map((s) => s.id)).toEqual(["directory", "acme-weather", "acme-news", "acme-stocks", "acme-pizza", "acme-bounties", "shopify-weareallbirds"]);
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
      // translator is the agent the scripted opening creates (connected to Acme News only).
      const allowed: Record<string, string[]> = { researcher: ["Acme Weather", "Acme News", "Acme Stocks"], "claude-desktop": ["Acme Weather"], translator: ["Acme News"] };
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
  describe("owner sheets (§14.2): create agents, add money", () => {
    const flush = async <T>(p: Promise<T>) => {
      await vi.advanceTimersByTimeAsync(1);
      return p;
    };
    const rejectsWith = async (p: Promise<unknown>, status: number, code: string) => {
      const check = expect(p).rejects.toMatchObject({ status, code });
      await vi.advanceTimersByTimeAsync(1);
      await check;
    };
    const policy = { maxPerTx: "5.00", dailyCap: "25.00", approvalThreshold: "5.00", allowlist: { addresses: [], origins: [] } };

    it("creates an agent: agent.created (with the agent), service.connected by owner, starting balance; token shown once", async () => {
      const m = createMockAdapter({ seed: 1, latencyMs: 0 });
      const got: WalletEvent[] = [];
      m.subscribe((e) => got.push(e));
      const res = await flush(m.createAgent({ name: "travel-planner", policy, initialBalance: "20.00", services: ["acme-weather", "directory"] }));
      expect(res.token).toMatch(/^aw_[0-9a-f]{48}$/);
      expect(res.tokenId).toMatch(/^tok_/);
      expect(res.agent).toMatchObject({ name: "travel-planner", balance: "20.00", frozen: false, policy: { maxPerTx: "5.00", dailyCap: "25.00", approvalThreshold: "5.00", allowlist: { addresses: [], origins: [] } } });
      expect(res.agent.services.map((s) => [s.id, s.connectedBy])).toEqual([["acme-weather", "owner"]]);
      expect(got.map((e) => e.type)).toEqual(["agent.created", "service.connected", "topup"]);
      expect((got[0].data as { agent: { name: string } }).agent.name).toBe("travel-planner");
      expect(got[2].receipt).toMatchObject({ kind: "topup", amount: "20.00", description: "Starting balance", status: "settled" });
      expect(JSON.stringify(got)).not.toContain(res.token); // the token never rides on an event
      const s = await flush(m.getSummary());
      expect(s.agents.at(-1)!.name).toBe("travel-planner");
      expect(s.totalBalance).toBe("180.00");
      m.stop();
    });

    it("no starting money: no topup event and a $0 balance", async () => {
      const m = createMockAdapter({ seed: 1, latencyMs: 0 });
      const got: WalletEvent[] = [];
      m.subscribe((e) => got.push(e));
      const res = await flush(m.createAgent({ name: "lurker", policy, services: [] }));
      expect(res.agent.balance).toBe("0.00");
      expect(got.map((e) => e.type)).toEqual(["agent.created"]);
      m.stop();
    });

    it("refuses a taken name (409 agent_exists), a bad name (400) and an unknown service (404) without creating anything", async () => {
      const m = createMockAdapter({ seed: 1, latencyMs: 0 });
      const got: WalletEvent[] = [];
      m.subscribe((e) => got.push(e));
      await rejectsWith(m.createAgent({ name: "researcher", policy }), 409, "agent_exists");
      await rejectsWith(m.createAgent({ name: "Travel Planner", policy }), 400, "invalid_request");
      await rejectsWith(m.createAgent({ name: "-x", policy }), 400, "invalid_request");
      await rejectsWith(m.createAgent({ name: "x", policy }), 400, "invalid_request");
      await rejectsWith(m.createAgent({ name: "ok-name", policy, services: ["acme-weather", "acme-nope"] }), 404, "service_not_found");
      expect(got).toEqual([]);
      expect((await flush(m.getAgents())).some((a) => a.name === "ok-name")).toBe(false);
      m.stop();
    });

    it("tops up $0.01 to $1000 and refuses the rest (400) or an unknown agent (404)", async () => {
      const m = createMockAdapter({ seed: 1, latencyMs: 0 });
      const shopper = (await flush(m.getAgents())).find((a) => a.name === "shopper")!;
      for (const bad of ["0", "0.00", "1000.01", "-5", "abc", "12.345"]) await rejectsWith(m.topup(shopper.id, bad), 400, "invalid_request");
      await rejectsWith(m.topup("agt_nope", "5.00"), 404, "agent_not_found");
      const r = await flush(m.topup(shopper.id, "1000"));
      expect(r).toMatchObject({ kind: "topup", amount: "1000.00", description: "Top-up" });
      expect((await flush(m.getAgents())).find((a) => a.id === shopper.id)!.balance).toBe("1020.00");
      m.stop();
    });

    it("in base-sepolia mode top-ups answer 501 and new agents get no minted balance", async () => {
      const m = createMockAdapter({ seed: 1, latencyMs: 0, chainMode: "base-sepolia" });
      expect((await flush(m.getSummary())).chainMode).toBe("base-sepolia");
      const shopper = (await flush(m.getAgents())).find((a) => a.name === "shopper")!;
      await rejectsWith(m.topup(shopper.id, "20.00"), 501, "not_supported");
      const res = await flush(m.createAgent({ name: "chain-agent", policy, initialBalance: "20.00" }));
      expect(res.agent.balance).toBe("0.00");
      m.stop();
    });

    it("the scripted opening ends with the owner creating translator, and skips it if the name is taken", async () => {
      const m = createMockAdapter({ seed: 3 });
      const got: WalletEvent[] = [];
      for (let i = 0; i < 13; i++) got.push(...m.tick());
      expect(got.slice(-3).map((e) => [e.type, e.agentName])).toEqual([
        ["agent.created", "translator"],
        ["service.connected", "translator"],
        ["topup", "translator"],
      ]);
      expect(got.at(-1)!.receipt!.amount).toBe("10.00");
      m.stop();

      const n = createMockAdapter({ seed: 3, latencyMs: 0 });
      await flush(n.createAgent({ name: "translator", policy }));
      const later: WalletEvent[] = [];
      for (let i = 0; i < 13; i++) later.push(...n.tick());
      expect(later.filter((e) => e.type === "agent.created")).toHaveLength(0);
      n.stop();
    });
  });
  describe("Shopify stores (§15)", () => {
    const flush = async <T>(p: Promise<T>) => {
      await vi.advanceTimersByTimeAsync(1);
      return p;
    };
    const rejectsWith = async (p: Promise<unknown>, status: number, code: string) => {
      const check = expect(p).rejects.toMatchObject({ status, code });
      await vi.advanceTimersByTimeAsync(1);
      await check;
    };
    const fresh = () => createMockAdapter({ seed: 1, latencyMs: 0, previewLatencyMs: 0 });

    it("lists a public store the owner added (Allbirds, $150 cap), connected to nobody, with no modes", async () => {
      const m = fresh();
      const store = (await flush(m.getDirectory())).find((s) => s.id === "shopify-weareallbirds")!;
      expect(store).toMatchObject({
        name: "Allbirds",
        provider: "Shopify store",
        color: "#95BF47",
        category: "shopping",
        kind: "x402",
        maxPrice: "150.00",
        pricing: "Store prices · paid with your Allowance card · up to $150.00 per order",
        baseUrl: "http://localhost:4070/shops/weareallbirds",
        shopify: { handle: "weareallbirds", domain: "weareallbirds.myshopify.com", storefrontUrl: "https://www.allbirds.com", cardCheckout: true },
        connectedAgents: [],
      });
      expect(store.shopify).not.toHaveProperty("mode");
      expect(store.permissions).toEqual(["Browse Allbirds's catalog", "Pay up to $150.00 per order with a single-use Allowance card", "Place orders on your behalf"]);
      const docs = (await flush(m.getService("shopify-weareallbirds"))).docs!;
      expect(docs).toMatch(/checkoutUrl/);
      expect(docs).toMatch(/simulated/);
      expect(docs).not.toMatch(/admin/i);
      m.stop();
    });

    it("previews any store or product link like the bridge, with inline pictures and the error codes", async () => {
      const m = fresh();
      const ab = await flush(m.previewShopifyStore("https://www.allbirds.com/products/mens-wool-runners"));
      expect(ab).toMatchObject({ handle: "weareallbirds", name: "Allbirds", storefrontUrl: "https://www.allbirds.com", cardCheckout: true, currency: "USD", productCount: 248 });
      expect(ab.sampleImages).toHaveLength(4);
      expect(ab.sampleImages!.every((u) => u.startsWith("data:image/svg+xml,"))).toBe(true);
      expect(await flush(m.previewShopifyStore("weareallbirds.myshopify.com"))).toMatchObject({ handle: "weareallbirds" });
      const other = await flush(m.previewShopifyStore("some-other-store.myshopify.com"));
      expect(other).toMatchObject({ handle: "some-other-store", domain: "some-other-store.myshopify.com", storefrontUrl: "https://some-other-store.myshopify.com", name: "Some Other Store", currency: "USD" });
      expect(typeof other.cardCheckout).toBe("boolean");
      expect(await flush(m.previewShopifyStore("some-other-store.myshopify.com"))).toEqual(other); // deterministic
      expect(await flush(m.previewShopifyStore("https://www.mugsandmore.com/collections/all"))).toMatchObject({ handle: "mugsandmore", storefrontUrl: "https://www.mugsandmore.com", name: "Mugsandmore" });
      await rejectsWith(m.previewShopifyStore("not a url"), 400, "invalid_store_url");
      await rejectsWith(m.previewShopifyStore("https://admin.shopify.com/store/juniper-goods"), 400, "invalid_store_url");
      await rejectsWith(m.previewShopifyStore("nope.myshopify.com"), 404, "store_not_found");
      await rejectsWith(m.previewShopifyStore("locked.myshopify.com"), 422, "store_unsupported");
      await rejectsWith(m.previewShopifyStore("euro-shop.myshopify.com"), 422, "store_unsupported");
      m.stop();
    });

    it("adds a store, connects the picked agents (by you), and refuses duplicates, bad caps and unknown agents", async () => {
      const m = fresh();
      const got: WalletEvent[] = [];
      m.subscribe((e) => got.push(e));
      const shopper = (await flush(m.getAgents())).find((a) => a.name === "shopper")!;
      await rejectsWith(m.addShopifyStore({ url: "https://www.allbirds.com" }), 409, "service_exists");
      await rejectsWith(m.addShopifyStore({ url: "https://gift-shop.myshopify.com", maxPrice: "1000.01" }), 400, "invalid_request");
      await rejectsWith(m.addShopifyStore({ url: "https://gift-shop.myshopify.com", connectTo: ["agt_nope"] }), 404, "agent_not_found");
      expect((await flush(m.getDirectory())).some((s) => s.id === "shopify-gift-shop")).toBe(false);
      expect(got).toEqual([]);

      const res = await flush(m.addShopifyStore({ url: "https://gift-shop.myshopify.com", maxPrice: "60.00", connectTo: [shopper.id] }));
      expect(res.service).toMatchObject({ id: "shopify-gift-shop", name: "Gift Shop", source: "directory", maxPrice: "60.00", pricing: "Store prices · paid with your Allowance card · up to $60.00 per order", shopify: { storefrontUrl: "https://gift-shop.myshopify.com" } });
      expect(res.service.permissions).toEqual(["Browse Gift Shop's catalog", "Pay up to $60.00 per order with a single-use Allowance card", "Place orders on your behalf"]);
      expect(res.agents!.map((a) => a.name)).toEqual(["shopper"]);
      expect(got.map((e) => [e.type, e.agentName, e.message])).toEqual([["service.connected", "shopper", "Gift Shop connected to shopper."]]);
      const after = (await flush(m.getAgents())).find((a) => a.id === shopper.id)!;
      expect(after.services.map((s) => [s.id, s.connectedBy, s.shopify?.domain])).toEqual([["shopify-gift-shop", "owner", "gift-shop.myshopify.com"]]);
      expect((await flush(m.getDirectory())).at(-1)!.id).toBe("shopify-gift-shop");
      m.stop();
    });

    it("the opening ends with shopper asking to add Juniper Goods (not in the directory, capped at its max per payment)", () => {
      const m = createMockAdapter({ seed: 3 });
      const got: WalletEvent[] = [];
      for (let i = 0; i < 14; i++) got.push(...m.tick());
      const req = got.at(-1)!;
      expect(req.type).toBe("service.requested");
      expect(req.message).toBe("shopper wants to add the Shopify store Juniper Goods (junipergoods.com).");
      expect(req.approval).toMatchObject({
        id: "apr_demo_shopify",
        kind: "service",
        agentName: "shopper",
        status: "pending",
        service: { id: "shopify-juniper-goods", source: "agent", category: "shopping", maxPrice: "20.00", shopify: { domain: "juniper-goods.myshopify.com", storefrontUrl: "https://junipergoods.com", cardCheckout: false } },
      });
      expect(req.approval!.reason).toMatch(/candle/);
      m.stop();
    });

    it("approving the proposed store adds it to the directory and connects that entry to shopper", async () => {
      const m = createMockAdapter({ seed: 3, latencyMs: 0 });
      const got: WalletEvent[] = [];
      m.subscribe((e) => got.push(e));
      expect(await flush(m.getApproval("apr_demo_shopify"))).toMatchObject({ status: "pending" }); // the embed fast-forwards
      expect((await flush(m.getDirectory())).some((s) => s.id === "shopify-juniper-goods")).toBe(false);
      await flush(m.approve("apr_demo_shopify"));
      expect(got.slice(-2).map((e) => e.type)).toEqual(["approval.approved", "service.connected"]);
      const listed = (await flush(m.getDirectory())).find((s) => s.id === "shopify-juniper-goods")!;
      expect(listed).toMatchObject({ source: "directory", maxPrice: "20.00", shopify: { storefrontUrl: "https://junipergoods.com" } });
      const shopper = (await flush(m.getAgents())).find((a) => a.name === "shopper")!;
      expect(shopper.services.find((s) => s.id === "shopify-juniper-goods")).toMatchObject({ connectedBy: "approval", source: "directory", shopify: { domain: "juniper-goods.myshopify.com" } });
      m.stop();
    });
  });

  describe("Capital One (§16, Nessie sandbox)", () => {
    const run = async <T,>(p: Promise<T>) => {
      await vi.advanceTimersByTimeAsync(1);
      return p;
    };
    /** The error a mock call rejects with (caught at once, so it's never an unhandled rejection). */
    const failure = (p: Promise<unknown>) => run(p.then(() => new Error("expected a rejection"), (e: unknown) => e));

    it("is off unless asked for: no bank in the summary, /v1/bank says not enabled", async () => {
      const m = createMockAdapter({ seed: 1, latencyMs: 0 });
      expect((await run(m.getSummary())).bank).toBeUndefined();
      expect(await run(m.getBank())).toMatchObject({ enabled: false, linked: false, accounts: [] });
      expect(await failure(m.getBankStatement())).toMatchObject({ status: 409, code: "bank_not_enabled" });
      m.stop();
    });

    it("the page asks for it by default; ?bank= picks the other states", () => {
      expect(mockBankMode("?mock=1")).toBe("on");
      expect(mockBankMode("?mock=1&bank=off")).toBe("off");
      expect(mockBankMode("?bank=0")).toBe("off");
      expect(mockBankMode("?bank=low")).toBe("low");
      expect(mockBankMode("?bank=down")).toBe("down");
      expect(mockBankMode("?bank=unlinked")).toBe("unlinked");
      expect(mockBankMode("?bank=bogus")).toBe("on");
    });

    it("links at startup: checking funded the eight $20 allowance accounts", async () => {
      const m = createMockAdapter({ seed: 1, latencyMs: 0, bank: "on" });
      expect((await run(m.getSummary())).bank).toEqual({ linked: true, checkingLast4: "1234", checkingBalance: "4840.00" });
      const b = await run(m.getBank());
      expect(b).toMatchObject({ enabled: true, linked: true, provider: "Capital One", sandbox: "Nessie", queue: { pending: 0, failed: 0 } });
      expect(b.checking).toMatchObject({ nickname: "Allowance owner checking", last4: "1234", balance: "4840.00" });
      expect(b.accounts).toHaveLength(8);
      const shopper = b.accounts.find((a) => a.agentName === "shopper")!;
      expect(shopper).toMatchObject({ last4: MOCK_BANK_LAST4.shopper, nickname: "Allowance · shopper", balance: "20.00" });
      const st = await run(m.getBankStatement(shopper.agentId));
      expect(st.entries).toEqual([expect.objectContaining({ kind: "transfer_in", amount: "20.00", description: "Allowance top-up · shopper", status: "executed" })]);
      const chk = await run(m.getBankStatement());
      expect(chk.entries).toHaveLength(8);
      expect(chk.entries.every((e) => e.kind === "transfer_out")).toBe(true);
      m.stop();
    });

    it("posts settled payments and earnings later (bank.posted); the second payment fails until retried", async () => {
      const m = createMockAdapter({ seed: 3, latencyMs: 0, bank: "on", bankDelayMs: 1000, bankExecuteMs: 5000 });
      const got: WalletEvent[] = [];
      m.subscribe((e) => got.push(e));
      for (let i = 0; i < 4; i++) m.tick(); // earn, pay weather, earn, pay news (researcher)
      await vi.advanceTimersByTimeAsync(900); // both payments settle
      const settled = got.filter((e) => e.type === "payment.settled");
      expect(settled.map((e) => e.receipt?.bank?.status)).toEqual(["queued", "queued"]);
      await vi.advanceTimersByTimeAsync(1100);
      const posted = got.filter((e) => e.type === "bank.posted");
      expect(posted.map((e) => e.receipt?.description).sort()).toEqual(["Acme Weather", "Bounty: API reliability check", "Bounty: API reliability check"]);
      const weather = posted.find((e) => e.receipt?.description === "Acme Weather")!;
      expect(weather.receipt?.bank).toMatchObject({ status: "posted", account: `••${MOCK_BANK_LAST4.researcher}` });
      expect(weather.data).toMatchObject({ receiptId: weather.receipt!.id, kind: "purchase", account: `••${MOCK_BANK_LAST4.researcher}` });
      expect(weather.message).toBe(`$0.05 at Acme Weather posted to researcher's Capital One account ••${MOCK_BANK_LAST4.researcher}.`);
      await vi.advanceTimersByTimeAsync(1000);
      const failed = got.find((e) => e.type === "bank.failed")!;
      expect(failed).toMatchObject({ reason: "bank_failed", agentName: "researcher" });
      expect(failed.receipt?.bank?.status).toBe("failed");
      expect(failed.data).toMatchObject({ receiptId: failed.receipt!.id, kind: "purchase" });

      const researcher = (await run(m.getSummary())).agents.find((a) => a.name === "researcher")!;
      let st = await run(m.getBankStatement(researcher.id));
      expect(st.entries[0]).toMatchObject({ kind: "purchase", merchant: "Acme Weather", amount: "0.05", description: "Acme Weather · paid in USDC", status: "pending" });
      expect(st.account.balance).toBe("19.95");
      expect((await run(m.getBank())).queue).toEqual({ pending: 0, failed: 1 });

      expect(await run(m.retryBank(failed.receipt!.id))).toEqual({ queued: 1 });
      expect((await run(m.getReceipts())).find((r) => r.id === failed.receipt!.id)?.bank?.status).toBe("queued");
      await vi.advanceTimersByTimeAsync(1000);
      expect(got.filter((e) => e.type === "bank.posted").some((e) => e.receipt?.id === failed.receipt!.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      st = await run(m.getBankStatement(researcher.id));
      expect(st.entries.map((e) => e.status)).toContain("executed");
      expect(st.account.balance).toBe("19.85");
      m.stop();
    });

    it("never posts a blocked payment", async () => {
      const m = createMockAdapter({ seed: 3, latencyMs: 0, bank: "on", bankDelayMs: 10 });
      for (let i = 0; i < 8; i++) m.tick();
      await vi.advanceTimersByTimeAsync(5000);
      const blocked = (await run(m.getReceipts())).find((r) => r.status === "blocked")!;
      expect(blocked.bank).toBeUndefined();
      m.stop();
    });

    it("an owner top-up moves dollars from checking first: posted at once, one topup event, no bank.posted", async () => {
      const m = createMockAdapter({ seed: 1, latencyMs: 0, bank: "on" });
      const got: WalletEvent[] = [];
      m.subscribe((e) => got.push(e));
      const shopper = (await run(m.getSummary())).agents.find((a) => a.name === "shopper")!;
      const r = await run(m.topup(shopper.id, "20.00"));
      expect(r.bank).toMatchObject({ status: "posted", account: `••${MOCK_BANK_LAST4.shopper}` });
      expect(r.bank?.ref).toBeTruthy();
      expect(got.map((e) => e.type)).toEqual(["topup"]);
      expect(got[0].message).toBe(`Moved $20.00 from Capital One Checking ••1234 to shopper's allowance account.`);
      expect((await run(m.getSummary())).bank?.checkingBalance).toBe("4820.00");
      const st = await run(m.getBankStatement(shopper.id));
      expect(st.entries[0]).toMatchObject({ kind: "transfer_in", amount: "20.00", receiptId: r.id });
      expect(st.account.balance).toBe("40.00");
      m.stop();
    });

    it("low checking: a top-up it can't cover answers 409 and credits nothing; a small one works", async () => {
      const m = createMockAdapter({ seed: 1, latencyMs: 0, bank: "low" });
      const s = await run(m.getSummary());
      expect(s.bank?.checkingBalance).toBe("12.40");
      const shopper = s.agents.find((a) => a.name === "shopper")!;
      const err = await failure(m.topup(shopper.id, "20.00"));
      expect(err).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ status: 409, code: "bank_insufficient_funds", message: "Your Capital One checking has $12.40, not enough to add $20.00." });
      expect((await run(m.getSummary())).agents.find((a) => a.name === "shopper")!.balance).toBe("20.00");
      await run(m.topup(shopper.id, "5.00"));
      expect((await run(m.getSummary())).bank?.checkingBalance).toBe("7.40");
      m.stop();
    });

    it("bank down: top-ups answer 502, balances are the last known with an error, postings wait", async () => {
      const m = createMockAdapter({ seed: 3, latencyMs: 0, bank: "down", bankDelayMs: 10 });
      const s = await run(m.getSummary());
      const shopper = s.agents.find((a) => a.name === "shopper")!;
      expect(await failure(m.topup(shopper.id, "5.00"))).toMatchObject({ status: 502, code: "bank_unavailable", message: "Capital One didn't confirm the transfer, so nothing was added." });
      for (let i = 0; i < 2; i++) m.tick();
      await vi.advanceTimersByTimeAsync(5000);
      const b = await run(m.getBank());
      expect(b.error).toMatch(/Couldn't reach Capital One/);
      expect(b.queue.pending).toBe(2);
      expect(await failure(m.getBankStatement(shopper.id))).toMatchObject({ status: 502, code: "bank_unavailable" });
      m.stop();
    });

    it("enabled but not linked until the owner links it", async () => {
      const m = createMockAdapter({ seed: 1, latencyMs: 0, bank: "unlinked" });
      expect((await run(m.getSummary())).bank).toEqual({ linked: false });
      expect(await run(m.getBank())).toMatchObject({ enabled: true, linked: false, accounts: [] });
      const linked = await run(m.linkBank());
      expect(linked).toMatchObject({ linked: true, checking: { last4: "1234", balance: "5000.00" } });
      expect(linked.accounts).toHaveLength(8);
      m.stop();
    });
  });

  describe("Add service (§18): one link, three kinds", () => {
    const flush = async <T>(p: Promise<T>) => {
      await vi.advanceTimersByTimeAsync(1);
      return p;
    };
    const fresh = () => createMockAdapter({ seed: 1, latencyMs: 0, previewLatencyMs: 0 });
    const code = async (p: Promise<unknown>) => {
      const out = p.then(
        () => "resolved",
        (e: HttpError) => `${e.status} ${e.code}`,
      );
      await vi.advanceTimersByTimeAsync(1);
      return out;
    };

    it("resolves directory services, x402 APIs and stores; 'nope' is unrecognized", async () => {
      const m = fresh();
      const weather = await flush(m.previewService("http://localhost:4021/api/weather?city=Paris"));
      expect(weather).toMatchObject({ kind: "directory", service: { id: "acme-weather" } });
      expect(weather.connectedAgents?.length).toBeGreaterThan(0);
      expect(await flush(m.previewService("https://www.allbirds.com/products/x"))).toMatchObject({ kind: "shopify", listed: true, service: { id: "shopify-weareallbirds" } });
      const api = await flush(m.previewService("https://data.example.com/api/flood"));
      expect(api).toMatchObject({ kind: "x402", price: "0.05", service: { id: "custom-data-example-com-api-flood", name: "data.example.com", maxPrice: "0.05", pricing: "$0.05 per request", baseUrl: "https://data.example.com/api/flood", source: "owner" } });
      const store = await flush(m.previewService("candles.myshopify.com"));
      expect(store).toMatchObject({ kind: "shopify", listed: false });
      expect(store.store?.handle).toBe("candles");
      expect(await code(m.previewService("nope.example.com"))).toBe("422 unrecognized_service_url");
      expect(await code(m.previewService("candles.myshopify.comhttps://x.example.com/api/a"))).toBe("400 invalid_store_url");
      m.stop();
    });

    it("adds: a store is listed and connected, an API is connected to the agents picked", async () => {
      const m = fresh();
      const agents = await flush(m.getAgents());
      const shopper = agents.find((a) => a.name === "shopper")!;
      const added = await flush(m.addService({ url: "candles.myshopify.com", maxPrice: "50", connectTo: [shopper.id] }));
      expect(added).toMatchObject({ kind: "shopify", service: { id: "shopify-candles", maxPrice: "50.00" }, connected: [shopper.id] });
      expect((await flush(m.getDirectory())).some((s) => s.id === "shopify-candles")).toBe(true);
      expect(await code(m.addService({ url: "https://data.example.com/api/flood" }))).toBe("400 invalid_request");
      const api = await flush(m.addService({ url: "https://data.example.com/api/flood", maxPrice: "0.10", connectTo: [shopper.id] }));
      expect(api).toMatchObject({ kind: "x402", service: { maxPrice: "0.10" }, connected: [shopper.id] });
      const after = (await flush(m.getAgents())).find((a) => a.id === shopper.id)!;
      expect(after.services.find((s) => s.id === api.service.id)?.connectedBy).toBe("owner");
      expect((await flush(m.getDirectory())).some((s) => s.id === api.service.id)).toBe(false);
      // re-adding raises the cap in place, for everyone who has it
      const raised = await flush(m.addService({ url: "https://data.example.com/api/flood", maxPrice: "0.25" }));
      expect(raised.connected).toEqual([shopper.id]);
      expect((await flush(m.getAgents())).find((a) => a.id === shopper.id)!.services.find((s) => s.id === api.service.id)?.maxPrice).toBe("0.25");
      m.stop();
    });
  });
});
