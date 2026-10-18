import { describe, expect, it } from "vitest";
import { collapseFeed, MAX_FEED, applyEvent, initialState, isMoneyEvent, reducer, refreshesSummary, serviceKey, type DashboardState } from "./state";
import type { AgentPublic, Approval, Receipt, SummaryResponse, WalletEvent } from "./types";

const policy: AgentPublic["policy"] = { maxPerTx: "2.00", dailyCap: "10.00", allowlist: null, approvalThreshold: "2.00", frozen: false, freezeOnViolation: true };
const agent = (id: string, name: string): AgentPublic => ({
  id,
  name,
  address: "0x1111111111111111111111111111111111111111",
  policy: { ...policy },
  services: [],
  createdAt: "2026-10-17T00:00:00Z",
  balance: "20.00",
  spentToday: "0.00",
  earnedToday: "0.00",
  frozen: false,
});
const summary: SummaryResponse = {
  totalBalance: "40.00",
  spentToday: "0.00",
  earnedToday: "0.00",
  agents: [agent("agt_a", "naive-worker"), agent("agt_b", "shopper")],
  pendingApprovals: [],
  chainMode: "mock",
  telegramConnected: false,
};
const receipt = (id: string, extra: Partial<Receipt> = {}): Receipt => ({
  id,
  kind: "spend",
  status: "signed",
  agentId: "agt_b",
  agentName: "shopper",
  description: "Pizza order",
  amount: "18.50",
  amountBaseUnits: "18500000",
  counterparty: { address: "0x2222222222222222222222222222222222222222", name: "Pizza" },
  network: "eip155:84532",
  createdAt: "2026-10-17T12:00:00Z",
  ...extra,
});
const approval: Approval = {
  id: "apr_1",
  agentId: "agt_b",
  agentName: "shopper",
  paymentId: "pay_1",
  amount: "18.50",
  description: "Pizza order",
  counterparty: { address: "0x2222222222222222222222222222222222222222", name: "Pizza" },
  status: "pending",
  createdAt: "2026-10-17T12:00:00Z",
};
let n = 0;
const ev = (type: WalletEvent["type"], extra: Partial<WalletEvent> = {}): WalletEvent => ({
  id: `evt_${++n}`,
  type,
  at: new Date(Date.parse("2026-10-17T12:00:00Z") + n * 1000).toISOString(),
  message: "",
  ...extra,
});

function loaded(): DashboardState {
  return reducer(initialState, { type: "loaded", summary, events: [], receipts: [], approvals: [] });
}

describe("reducer: loaded", () => {
  it("takes agents and totals from the summary, keeps only pending approvals", () => {
    const s = reducer(initialState, {
      type: "loaded",
      summary,
      events: [ev("payment.signed"), ev("payment.settled")],
      receipts: [receipt("rcp_1")],
      approvals: [approval, { ...approval, id: "apr_old", status: "approved" }],
    });
    expect(s.loaded).toBe(true);
    expect(s.agents.map((a) => a.name)).toEqual(["naive-worker", "shopper"]);
    expect(s.totals.totalBalance).toBe("40.00");
    expect(s.approvals.map((a) => a.id)).toEqual(["apr_1"]);
    expect(s.events[0].type).toBe("payment.settled"); // newest first
  });
});

describe("applyEvent", () => {
  it("prepends events, dedupes by id, caps the feed at 200", () => {
    let s = loaded();
    const e = ev("payment.signed");
    s = applyEvent(s, e);
    s = applyEvent(s, e);
    expect(s.events).toHaveLength(1);
    for (let i = 0; i < MAX_FEED + 20; i++) s = applyEvent(s, ev("earning.received"));
    expect(s.events).toHaveLength(MAX_FEED);
    expect(s.events[0].id).toBe(`evt_${n}`);
  });

  it("freezes and unfreezes agents with the reason", () => {
    let s = loaded();
    s = applyEvent(s, ev("payment.blocked", { agentId: "agt_a", agentName: "naive-worker", reason: "not_allowlisted", receipt: receipt("rcp_b", { status: "blocked", kind: "transfer" }) }));
    s = applyEvent(s, ev("agent.frozen", { agentId: "agt_a", agentName: "naive-worker", reason: "Blocked: tried to send $20.00 to an unknown address. Agent frozen." }));
    const a = s.agents.find((x) => x.id === "agt_a")!;
    expect(a.frozen).toBe(true);
    expect(a.policy.frozen).toBe(true);
    expect(a.frozenReason).toMatch(/unknown address/);
    expect(s.agents.find((x) => x.id === "agt_b")!.frozen).toBe(false);
    expect(s.receipts[0].status).toBe("blocked");

    s = applyEvent(s, ev("agent.unfrozen", { agentId: "agt_a" }));
    expect(s.agents.find((x) => x.id === "agt_a")!.frozen).toBe(false);
    expect(s.agents.find((x) => x.id === "agt_a")!.frozenReason).toBeUndefined();
  });

  it("tracks approvals from needs_approval through approved/denied", () => {
    let s = loaded();
    s = applyEvent(s, ev("payment.needs_approval", { agentId: "agt_b", approval, receipt: receipt("rcp_p", { status: "pending_approval", approvalId: "apr_1" }) }));
    expect(s.approvals.map((a) => a.id)).toEqual(["apr_1"]);
    // duplicate needs_approval for same approval id is ignored
    s = applyEvent(s, ev("payment.needs_approval", { agentId: "agt_b", approval }));
    expect(s.approvals).toHaveLength(1);

    s = applyEvent(s, ev("approval.approved", { agentId: "agt_b", approval: { ...approval, status: "approved" }, receipt: receipt("rcp_p", { status: "signed", approvalId: "apr_1" }) }));
    expect(s.approvals).toHaveLength(0);
    expect(s.receipts.find((r) => r.id === "rcp_p")!.status).toBe("signed");
    expect(s.receipts).toHaveLength(1); // upsert, not duplicate
  });

  it("removes an approval on deny using the receipt link when approval is absent", () => {
    let s = loaded();
    s = applyEvent(s, ev("payment.needs_approval", { approval }));
    s = applyEvent(s, ev("approval.denied", { receipt: receipt("rcp_p", { status: "denied", approvalId: "apr_1" }) }));
    expect(s.approvals).toHaveLength(0);
  });

  it("upserts receipts: signed then settled keeps one row with the tx hash", () => {
    let s = loaded();
    s = applyEvent(s, ev("payment.signed", { receipt: receipt("rcp_1") }));
    s = applyEvent(s, ev("payment.settled", { receipt: receipt("rcp_1", { status: "settled", txHash: "0xabc" }) }));
    expect(s.receipts).toHaveLength(1);
    expect(s.receipts[0].status).toBe("settled");
    expect(s.receipts[0].txHash).toBe("0xabc");
  });

  it("collapses the signed row once the same payment settles", () => {
    let s = loaded();
    s = applyEvent(s, ev("payment.signed", { receipt: receipt("rcp_1") }));
    s = applyEvent(s, ev("payment.signed", { receipt: receipt("rcp_2") }));
    s = applyEvent(s, ev("payment.settled", { receipt: receipt("rcp_1", { status: "settled" }) }));
    expect(s.events.map((e) => `${e.type}:${e.receipt?.id}`)).toEqual(["payment.settled:rcp_1", "payment.signed:rcp_2"]);
  });

  it("bumps the agent balance optimistically on topup", () => {
    let s = loaded();
    s = applyEvent(s, ev("topup", { agentId: "agt_a", receipt: receipt("rcp_t", { kind: "topup", status: "settled", amount: "20.00", agentId: "agt_a" }) }));
    expect(s.agents.find((a) => a.id === "agt_a")!.balance).toBe("40.00");
  });

  it("adds agents from agent.created", () => {
    let s = loaded();
    s = applyEvent(s, ev("agent.created", { agentId: "agt_c", data: { agent: agent("agt_c", "worker-9") } }));
    expect(s.agents).toHaveLength(3);
  });
});

describe("reducer: misc actions", () => {
  it("summary replaces totals, agents and pending approvals", () => {
    let s = loaded();
    s = reducer(s, { type: "summary", summary: { ...summary, totalBalance: "41.00", pendingApprovals: [approval] } });
    expect(s.totals.totalBalance).toBe("41.00");
    expect(s.approvals).toHaveLength(1);
  });
  it("agent action upserts a single agent", () => {
    let s = loaded();
    s = reducer(s, { type: "agent", agent: { ...agent("agt_a", "naive-worker"), frozen: true, frozenReason: "by you" } });
    expect(s.agents.find((a) => a.id === "agt_a")!.frozen).toBe(true);
  });
  it("busy flags and details toggle", () => {
    let s = loaded();
    s = reducer(s, { type: "busyApproval", id: "apr_1", busy: true });
    expect(s.busyApprovals).toEqual(["apr_1"]);
    s = reducer(s, { type: "busyApproval", id: "apr_1", busy: false });
    expect(s.busyApprovals).toEqual([]);
    expect(reducer(s, { type: "toggleDetails" }).showDetails).toBe(true);
    expect(reducer(s, { type: "connection", status: "demo", offlineFallback: true }).offlineFallback).toBe(true);
  });
  it("knows which events move money", () => {
    expect(isMoneyEvent("payment.settled")).toBe(true);
    expect(isMoneyEvent("earning.received")).toBe(true);
    expect(isMoneyEvent("agent.frozen")).toBe(false);
    expect(isMoneyEvent("payment.needs_approval")).toBe(false);
  });
});

describe("collapseFeed (one line per payment)", () => {
  const ev = (id: string, type: WalletEvent["type"], extra: Partial<WalletEvent> = {}): WalletEvent => ({ id, type, at: "2026-10-17T12:00:00.000Z", message: id, ...extra });
  it("drops a signed row once its settlement is in the snapshot, and an Approve? row once decided", () => {
    const r = { id: "rcp_1" } as WalletEvent["receipt"];
    const out = collapseFeed([
      ev("e4", "approval.approved", { approval: { id: "apr_1" } as WalletEvent["approval"] }),
      ev("e3", "payment.settled", { receipt: r }),
      ev("e2", "payment.signed", { receipt: r }),
      ev("e1", "payment.needs_approval", { approval: { id: "apr_1" } as WalletEvent["approval"] }),
      ev("e0", "payment.needs_approval", { approval: { id: "apr_2" } as WalletEvent["approval"] }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["e4", "e3", "e0"]);
  });
});


describe("services: reducer", () => {
  const grant = {
    id: "acme-pizza",
    name: "Acme Pizza",
    provider: "Acme Corp",
    icon: "🍕",
    color: "#F08A24",
    kind: "x402" as const,
    summary: "Order a pizza.",
    baseUrl: "http://localhost:4021/pizza",
    pricing: "$18.50 per order",
    maxPrice: "18.50",
    permissions: ["Pay Acme Pizza up to $18.50 per order"],
    source: "directory" as const,
  };
  const svcApproval: Approval = {
    id: "apr_s",
    kind: "service",
    agentId: "agt_b",
    agentName: "shopper",
    paymentId: "",
    amount: "18.50",
    description: "Connect Acme Pizza",
    counterparty: { address: "0x2222222222222222222222222222222222222222", name: "Acme Pizza" },
    service: grant,
    reason: "You asked me to order pizza.",
    status: "pending",
    createdAt: "2026-10-17T12:00:00Z",
  };

  it("service.requested adds a service approval (like payment.needs_approval), once", () => {
    let s = loaded();
    s = applyEvent(s, ev("service.requested", { agentId: "agt_b", agentName: "shopper", approval: svcApproval }));
    s = applyEvent(s, ev("service.requested", { agentId: "agt_b", agentName: "shopper", approval: svcApproval }));
    expect(s.approvals.map((a) => [a.id, a.kind, a.service?.id])).toEqual([["apr_s", "service", "acme-pizza"]]);
  });

  it("marks a service.requested approval as a service approval even if the server omits kind", () => {
    const { kind: _k, ...noKind } = svcApproval;
    void _k;
    const s = applyEvent(loaded(), ev("service.requested", { approval: noKind as Approval }));
    expect(s.approvals[0].kind).toBe("service");
  });

  it("approval.approved / denied clear service approvals too", () => {
    let s = applyEvent(loaded(), ev("service.requested", { approval: svcApproval }));
    s = applyEvent(s, ev("approval.denied", { approval: { ...svcApproval, status: "denied" } }));
    expect(s.approvals).toHaveLength(0);
  });

  it("service.connected adds the connection to the agent, filling connectedBy from data", () => {
    let s = loaded();
    s = applyEvent(s, ev("service.connected", { agentId: "agt_b", agentName: "shopper", data: { service: grant, connectedBy: "approval" } }));
    const shopper = s.agents.find((a) => a.id === "agt_b")!;
    expect(shopper.services.map((x) => [x.id, x.connectedBy])).toEqual([["acme-pizza", "approval"]]);
    expect(shopper.services[0].connectedAt).toBeTruthy();
    // a repeat (e.g. after a reconnect) updates, never duplicates
    s = applyEvent(s, ev("service.connected", { agentId: "agt_b", data: { service: { ...grant, connectedBy: "owner" } } }));
    expect(s.agents.find((a) => a.id === "agt_b")!.services.map((x) => [x.id, x.connectedBy])).toEqual([["acme-pizza", "owner"]]);
    expect(s.agents.find((a) => a.id === "agt_a")!.services).toEqual([]);
  });

  it("service.disconnected removes it, by data.service or data.serviceId", () => {
    let s = applyEvent(loaded(), ev("service.connected", { agentId: "agt_b", data: { service: grant, connectedBy: "owner" } }));
    s = applyEvent(s, ev("service.disconnected", { agentId: "agt_b", data: { serviceId: "acme-pizza" } }));
    expect(s.agents.find((a) => a.id === "agt_b")!.services).toEqual([]);
    s = applyEvent(s, ev("service.connected", { agentId: "agt_b", data: { service: grant, connectedBy: "owner" } }));
    s = applyEvent(s, ev("service.disconnected", { agentId: "agt_b", data: { service: grant } }));
    expect(s.agents.find((a) => a.id === "agt_b")!.services).toEqual([]);
  });

  it("normalizes agents from a wallet-service that sends no services", () => {
    const { services: _s, ...old } = agent("agt_c", "worker-9");
    void _s;
    const s = reducer(initialState, { type: "loaded", summary: { ...summary, agents: [old as AgentPublic] }, events: [], receipts: [], approvals: [] });
    expect(s.agents[0].services).toEqual([]);
  });

  it("refetches the summary after connection changes but not on requests", () => {
    expect(refreshesSummary("service.connected")).toBe(true);
    expect(refreshesSummary("service.disconnected")).toBe(true);
    expect(refreshesSummary("service.requested")).toBe(false);
    expect(refreshesSummary("payment.settled")).toBe(true);
  });

  it("refetches the summary on agent.created (the wallet may send no data.agent)", () => {
    expect(refreshesSummary("agent.created")).toBe(true);
    expect(refreshesSummary("topup")).toBe(true);
  });

  it("keeps a directory it already has when a refetch fails", () => {
    let s = reducer(initialState, { type: "directoryLoading" });
    expect(s.directoryStatus).toBe("loading");
    s = reducer(s, { type: "directoryError", message: "down" });
    expect(s.directoryStatus).toBe("error");
    s = reducer(s, { type: "directory", services: [{ ...grant, category: "shopping", description: "" }] });
    expect(s.directoryStatus).toBe("ready");
    s = reducer(s, { type: "directoryError", message: "down again" });
    expect(s.directoryStatus).toBe("ready");
    expect(s.directory).toHaveLength(1);
    s = reducer(s, { type: "serviceDocs", id: "acme-pizza", docs: "POST /order" });
    expect(s.serviceDocs["acme-pizza"]).toBe("POST /order");
    s = reducer(s, { type: "busyService", key: serviceKey("agt_b", "acme-pizza"), busy: true });
    expect(s.busyServices).toEqual(["agt_b:acme-pizza"]);
  });

  it("shows a store the owner just added before the directory reloads (directoryUpsert)", () => {
    const store = { ...grant, id: "shopify-gift-shop", name: "Gift Shop", category: "shopping" as const, description: "", shopify: { handle: "gift-shop", domain: "gift-shop.myshopify.com", mode: "handoff" as const } };
    let s = reducer(initialState, { type: "directoryUpsert", service: store });
    expect(s.directory.map((x) => x.id)).toEqual(["shopify-gift-shop"]);
    expect(s.directoryStatus).toBe("ready");
    s = reducer(s, { type: "directoryUpsert", service: { ...store, name: "Gift Shop Co" } });
    expect(s.directory.map((x) => x.name)).toEqual(["Gift Shop Co"]);
  });
});

describe("collapseFeed: services and freezes", () => {
  const ev = (id: string, type: WalletEvent["type"], extra: Partial<WalletEvent> = {}): WalletEvent => ({ id, type, at: "2026-10-17T12:00:00.000Z", message: id, ...extra });
  const svc = { id: "acme-pizza", name: "Acme Pizza" } as Approval["service"];
  const req = { id: "apr_s", kind: "service", agentId: "agt_b", service: svc } as Approval;

  it("one line per service request: the connection replaces the request and its approval", () => {
    const out = collapseFeed([
      ev("e3", "service.connected", { agentId: "agt_b", data: { service: svc, connectedBy: "approval" } }),
      ev("e2", "approval.approved", { agentId: "agt_b", approval: { ...req, status: "approved" } }),
      ev("e1", "service.requested", { agentId: "agt_b", approval: req }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["e3"]);
  });

  it("keeps the approval row if the connection never arrived, and a denial replaces the request", () => {
    expect(collapseFeed([ev("e2", "approval.approved", { agentId: "agt_b", approval: { ...req, status: "approved" } }), ev("e1", "service.requested", { approval: req })]).map((e) => e.id)).toEqual(["e2"]);
    expect(collapseFeed([ev("e2", "approval.denied", { approval: { ...req, status: "denied" } }), ev("e1", "service.requested", { approval: req })]).map((e) => e.id)).toEqual(["e2"]);
  });

  it("a connection for another agent does not hide this agent's approval", () => {
    const out = collapseFeed([
      ev("e3", "service.connected", { agentId: "agt_OTHER", data: { service: svc } }),
      ev("e2", "approval.approved", { agentId: "agt_b", approval: { ...req, status: "approved" } }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["e3", "e2"]);
  });

  it("a payment approval is never folded into a service connection", () => {
    const pay = { id: "apr_p", kind: "payment", agentId: "agt_b" } as Approval;
    const out = collapseFeed([ev("e2", "service.connected", { agentId: "agt_b", data: { service: svc } }), ev("e1", "approval.approved", { agentId: "agt_b", approval: pay })]);
    expect(out.map((e) => e.id)).toEqual(["e2", "e1"]);
  });

  it("folds a policy freeze into its block row (§6 receiptId pair), but keeps an owner freeze", () => {
    const r = { id: "rcp_b" } as WalletEvent["receipt"];
    const out = collapseFeed([
      ev("e3", "agent.frozen", { data: { cause: "owner" } }),
      ev("e2", "agent.frozen", { data: { cause: "policy_violation", receiptId: "rcp_b" } }),
      ev("e1", "payment.blocked", { receipt: r, data: { frozen: true, willFreeze: true, receiptId: "rcp_b" } }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["e3", "e1"]);
  });

  it("applyEvent still freezes the agent even though the freeze row is folded", () => {
    let s = loaded();
    s = applyEvent(s, ev("e1", "payment.blocked", { agentId: "agt_a", receipt: receipt("rcp_b", { status: "blocked" }), data: { receiptId: "rcp_b" } }));
    s = applyEvent(s, ev("e2", "agent.frozen", { agentId: "agt_a", reason: "Blocked.", data: { cause: "policy_violation", receiptId: "rcp_b" } }));
    expect(s.agents.find((a) => a.id === "agt_a")!.frozen).toBe(true);
    expect(s.events.map((e) => e.id)).toEqual(["e1"]);
  });
});
